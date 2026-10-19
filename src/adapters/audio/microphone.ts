import { settings } from '../../config/settings';
import type { AudioInput, AudioLease, VolumeSample } from '../../session/ports';
import { AudioAcquireError } from '../../session/ports';

export interface AudioEnvironment {
  getUserMedia(): Promise<MediaStream>;
  createContext(): AudioContext;
  now(): number;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
}
export type AudioDiagnostic = (event: string, detail?: string) => void;
const browserEnvironment: AudioEnvironment = {
  getUserMedia: () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('マイクにはHTTPSまたはPCのlocalhostと対応ブラウザが必要です');
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  },
  createContext: () => new AudioContext(),
  now: () => performance.now(),
  requestFrame: callback => requestAnimationFrame(callback),
  cancelFrame: id => cancelAnimationFrame(id),
};

export function rms(samples: Float32Array): number {
  let sum = 0;
  for (const value of samples) sum += value * value;
  return Math.sqrt(sum / samples.length);
}

export class BrowserAudioInput implements AudioInput {
  constructor(private environment = browserEnvironment, private diagnostic: AudioDiagnostic = () => {}) {}

  async acquire(signal?: AbortSignal): Promise<AudioLease> {
    if (signal?.aborted) throw new DOMException('マイク準備は取消済みです', 'AbortError');
    const context = this.environment.createContext();
    // ユーザー操作に近い時点でresumeを要求。成功や以後の動画再生許可は仮定しない。
    let resumed: Promise<unknown>;
    try { resumed = context.resume().then(() => null, error => error as unknown); }
    catch (error) { resumed = Promise.resolve(error); }
    let stream: MediaStream | undefined;
    let expired = false;
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => { expired = true; rejectAbort(new DOMException('マイク準備を中止しました（ブラウザ要求は未取消）', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = Promise.resolve().then(() => {
      if (expired) throw new DOMException('マイク準備は取消済みです', 'AbortError');
      return this.environment.getUserMedia();
    }).then(value => {
      if (expired) { value.getTracks().forEach(track => track.stop()); this.diagnostic('mic.lateStream.stopped'); throw new Error('取得期限後のマイクを解放しました'); }
      stream = value;
      return value;
    });
    let lease: BrowserAudioLease | undefined;
    try {
      await Promise.race([request, aborted, new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('マイク権限待ちの期限超過。許可画面を確認してください')); }, settings.acquireTimeoutMs); })]);
      clearTimeout(timer);
      lease = new BrowserAudioLease(stream!, context, this.environment, this.diagnostic);
      const resumeError = await Promise.race([resumed, aborted, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('AudioContext起動期限超過')), settings.cleanupTimeoutMs); })]);
      if (resumeError) throw resumeError;
      if (context.state !== 'running') throw new Error(`AudioContextが稼働していません: ${context.state}`);
      lease.connect();
      const audioSettings = stream!.getAudioTracks()[0]?.getSettings();
      this.diagnostic('mic.context.running', JSON.stringify({ sampleRate: context.sampleRate, state: context.state, echoCancellation: audioSettings?.echoCancellation, noiseSuppression: audioSettings?.noiseSuppression, autoGainControl: audioSettings?.autoGainControl }));
      return lease;
    } catch (error) {
      expired = true;
      const partialLease: AudioLease = lease ?? {
        subscribe: () => { throw new Error('マイクは未初期化です'); },
        release: async () => { stream?.getTracks().forEach(track => track.stop()); if (context.state !== 'closed') await context.close(); },
      };
      try { await partialLease.release(); }
      catch (cleanupError) { throw new AudioAcquireError(`マイク初期化失敗: ${String(error)} / 資源解放失敗: ${String(cleanupError)}`, partialLease); }
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  }
}

class BrowserAudioLease implements AudioLease {
  private source?: MediaStreamAudioSourceNode;
  private analyser?: AnalyserNode;
  private data = new Float32Array(2_048);
  private listeners = new Set<(sample: VolumeSample) => void>();
  private frame?: number;
  private closed = false;
  private releasing?: Promise<void>;
  private interrupted?: (message: string) => void;

  constructor(private stream: MediaStream, private context: AudioContext, private environment: AudioEnvironment, private diagnostic: AudioDiagnostic) {}

  inputInfo(): string {
    try { return this.stream.getAudioTracks()[0]?.label?.trim() || '不明'; }
    catch { return '不明'; }
  }

  connect(): void {
    this.source = this.context.createMediaStreamSource(this.stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = this.data.length;
    this.source.connect(this.analyser); // destinationには接続せず、マイク音を出力しない。
    this.stream.getTracks().forEach(track => track.addEventListener('ended', this.onEnded));
    this.context.addEventListener('statechange', this.onContextState);
  }

  private onEnded = () => this.interrupted?.('マイク入力が終了しました');
  private onContextState = () => { if (!this.closed && this.context.state !== 'running') this.interrupted?.(`AudioContext中断: ${this.context.state}`); };
  onInterrupted(listener: (message: string) => void): () => void { this.interrupted = listener; return () => { this.interrupted = undefined; }; }

  subscribe(listener: (sample: VolumeSample) => void): () => void {
    if (this.closed) throw new Error('マイクは解放済みです');
    this.listeners.add(listener);
    if (this.frame === undefined) this.frame = this.environment.requestFrame(this.tick);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.frame !== undefined) { this.environment.cancelFrame(this.frame); this.frame = undefined; }
    };
  }

  private tick = () => {
    this.frame = undefined;
    if (this.closed || !this.listeners.size || !this.analyser) return;
    if (this.context.state !== 'running') { this.onContextState(); return; }
    try { this.analyser.getFloatTimeDomainData(this.data); }
    catch (error) { this.interrupted?.(`マイク分析エラー: ${String(error)}`); return; }
    const sample = { rms: Math.min(1, rms(this.data)), timeMs: this.environment.now() };
    this.listeners.forEach(listener => listener(sample));
    if (this.listeners.size && !this.closed) this.frame = this.environment.requestFrame(this.tick);
  };

  release(): Promise<void> {
    if (this.releasing) return this.releasing;
    this.closed = true;
    this.listeners.clear(); this.interrupted = undefined;
    if (this.frame !== undefined) this.environment.cancelFrame(this.frame);
    this.frame = undefined;
    this.releasing = (async () => {
      const errors: unknown[] = [];
      this.stream.getTracks().forEach(track => {
        try { track.removeEventListener('ended', this.onEnded); track.stop(); } catch (error) { errors.push(error); }
      });
      this.context.removeEventListener('statechange', this.onContextState);
      try { this.source?.disconnect(); this.source = undefined; } catch (error) { errors.push(error); }
      try { this.analyser?.disconnect(); this.analyser = undefined; } catch (error) { errors.push(error); }
      try { if (this.context.state !== 'closed') await this.context.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'マイク資源解放が未完了です');
      this.diagnostic('mic.resources.released');
    })();
    void this.releasing.catch(() => { this.releasing = undefined; });
    return this.releasing;
  }
}
