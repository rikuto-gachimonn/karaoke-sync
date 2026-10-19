import { BrowserAudioInput } from '../adapters/audio/microphone';
import { SustainedVolumeDetector } from '../domain/detector';
import { AudioAcquireError, type AudioInput, type AudioLease } from '../session/ports';
import { LeaseReleaser } from '../session/leaseReleaser';
import { settings } from '../config/settings';

export interface MicProbeOptions { startSec: number; threshold: number; durationMs: number; retainMic: boolean; waitTimeoutMs: number }
export const micProbeDefaults: MicProbeOptions = { startSec: 0, threshold: settings.defaultThreshold,
  durationMs: settings.defaultDurationMs, retainMic: true, waitTimeoutMs: 180_000 };
export function validateMicOptions(value: MicProbeOptions) {
  if (!Number.isFinite(value.startSec) || value.startSec < 0 || value.startSec > 86400) throw new Error('開始位置は0〜86400秒です');
  if (!Number.isFinite(value.threshold) || value.threshold < 0 || value.threshold > 1) throw new Error('しきい値は0〜1です');
  if (!Number.isFinite(value.durationMs) || value.durationMs < 0 || value.durationMs > settings.maxDurationMs) throw new Error('継続時間は0〜2000msです');
  if (!Number.isFinite(value.waitTimeoutMs) || value.waitTimeoutMs < 1000 || value.waitTimeoutMs > settings.armedTimeoutMs) throw new Error('検知待機期限は1〜300秒です');
}

/** 検証ページ専用のマイク所有者。停止はGUMの取消を仮定せず遅着leaseも回収する。 */
export class ProbeMicrophone {
  private epoch = 0;
  private abort?: AbortController;
  private off?: () => void;
  private offInterrupted?: () => void;
  private detector?: SustainedVolumeDetector;
  private timer?: ReturnType<typeof setTimeout>;
  private leases = new Set<AudioLease>();
  private releaser = new LeaseReleaser();
  private acquisitions = 0;
  constructor(private log: (event: string, detail?: string) => void, private audio?: AudioInput) {}

  async arm(options: MicProbeOptions, detected: () => void, failed: (error: unknown) => void,
    volume: (rms: number) => void, isPaused: () => boolean, armed: () => void) {
    const epoch = ++this.epoch;
    const valid = () => epoch === this.epoch;
    if (this.acquisitions >= settings.maxDetachedAcquisitions) { failed(new Error('未完了マイク要求が上限です。許可画面を確認しページを再読込してください')); return; }
    this.abort = new AbortController(); this.acquisitions++;
    this.log('mic.acquire');
    let acquired: AudioLease | undefined;
    try {
      const audio = this.audio ?? new BrowserAudioInput(undefined, (event, detail) => { if (valid()) this.log(event, detail); });
      const lease = await audio.acquire(this.abort.signal);
      acquired = lease;
      this.leases.add(lease);
      if (!valid()) { await this.release(lease, true); return; }
      this.log('mic.acquired');
      if (!isPaused()) throw new Error('マイク取得後に動画の一時停止を確認できません');
      this.detector = new SustainedVolumeDetector(sample => this.log('detector.firstExceeded', JSON.stringify(sample)));
      this.detector.arm(options, () => {
        if (!valid()) return;
        this.disarm();
        if (!options.retainMic) { this.offInterrupted?.(); this.offInterrupted = undefined; }
        detected(); // 呼出側でseek→playを同期実行。解放完了待ちで再生を遅らせない。
        if (!options.retainMic) void this.release(lease).catch(error => { this.log('mic.release.error', String(error)); failed(error); });
      });
      this.offInterrupted = lease.onInterrupted?.(message => { if (valid()) failed(new Error(message)); });
      armed(); this.log('detector.armed');
      this.timer = setTimeout(() => { if (valid()) failed(new Error('音検知の待機期限超過')); }, options.waitTimeoutMs);
      this.off = lease.subscribe(sample => {
        if (valid()) { volume(sample.rms); this.detector?.sample(sample); }
      });
    } catch (error) {
      if (error instanceof AudioAcquireError) { acquired = error.lease; this.leases.add(error.lease); }
      if (valid()) failed(error);
      else if (acquired) void this.release(acquired, true).catch(reason => this.log('mic.release.error', `late acquisition: ${String(reason)}`));
    } finally { this.acquisitions--; }
  }
  disarm() {
    clearTimeout(this.timer); this.timer = undefined;
    this.detector?.disarm(); this.detector = undefined;
    this.off?.(); this.off = undefined;
  }
  private async release(lease: AudioLease, late = false) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.releaser.release(lease), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('マイク解放確認期限超過')), settings.cleanupTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
    if (this.leases.delete(lease)) this.log(late ? 'mic.lateLease.released' : 'mic.released');
  }
  async stop(retry = false) {
    ++this.epoch; this.abort?.abort(); this.abort = undefined;
    this.disarm(); this.offInterrupted?.(); this.offInterrupted = undefined;
    const releasing = Promise.allSettled([...this.leases].map(lease => {
      if (retry) this.releaser.retryFailed(lease);
      return this.release(lease);
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const results = await Promise.race([releasing, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('マイク解放確認期限超過。すべて停止または解放再試行で確認してください')), settings.cleanupTimeoutMs);
      })]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    } catch (error) { this.log('mic.release.error', String(error)); throw error; }
    finally { clearTimeout(timer); }
  }
}
