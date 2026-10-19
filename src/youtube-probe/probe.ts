import { loadYouTubeApi, type YouTubeApi, type YouTubeHandle } from '../adapters/youtube/api';
import { ProbeMicrophone, micProbeDefaults, validateMicOptions, type MicProbeOptions } from './microphone';
import type { AudioInput } from '../session/ports';
import { compensationDefaults, effectiveCompensation, correctedPosition, type Compensation } from './compensation';

export type Condition = 'iframe' | 'immediate' | 'delayed' | 'seek-playing' | 'seek-paused' | 'mic-resume' | 'mic-compensation';
const isMicCondition = (condition: Condition) => condition === 'mic-resume' || condition === 'mic-compensation';
type ProbeHandle = YouTubeHandle & { seekTo(seconds: number, allowSeekAhead: boolean): void; getCurrentTime(): number; getDuration(): number };
export const seekObservation = { delayMs: 5000, pollMs: 50, timeoutMs: 15000, stableMs: 1000,
  nearZeroSec: 1, minimumDropSec: 1, minimumProgressSec: 0.2 } as const;
export interface ProbeEntry {
  sequence: number; timeMs: number; elapsedMs: number; wallTime: string; event: string;
  state?: number; observedVideoId?: string; errorCode?: number; detail?: string;
  currentTimeSec?: number;
  userActivation?: { isActive: boolean; hasBeenActive: boolean };
}
export interface ProbeRun {
  id: number; condition: Condition; videoId: string; delayMs: number; startedMs: number;
  entries: ProbeEntry[]; dropped: number;
  compensation?: { configured: Compensation; effective: Compensation };
  seek?: { requestedMs: number; beforeSec?: number; targetNearZeroAfterMs?: number; positionChangedAfterMs?: number; stableAfterMs?: number; outcome?: string };
  mic?: { options: MicProbeOptions; phase: 'preplay' | 'pausing' | 'acquiring' | 'armed' | 'waiting' | 'starting' | 'playing' | 'paused' | 'stopped' | 'error' | 'ended';
    rms?: number; armedMs?: number; detectedMs?: number; detectedAfterArmedMs?: number; playingAfterDetectedMs?: number;
    requestedPlayMs?: number; requestAfterDetectedMs?: number; playingAfterRequestMs?: number; playingPositionSec?: number;
    seekRequestedSec?: number; rawSeekSec?: number; videoDurationSec?: number; initialOutcome?: 'playing' | 'interrupted' };
}
const states: Record<number, string> = { [-1]: 'UNSTARTED', 0: 'ENDED', 1: 'PLAYING', 2: 'PAUSED', 3: 'BUFFERING', 5: 'CUED' };
const errorReasons: Record<number, string> = {
  2: '不正なパラメーター', 5: 'HTML5再生エラー', 100: '動画なし・非公開',
  101: '埋め込み禁止', 150: '埋め込み禁止', 153: 'Referer等の識別情報不足',
};
const MAX_ENTRIES = 3000;

/** 通常セッションから独立。PLAYING・ブロック・エラーを理由に破棄しない。 */
export class YouTubeProbe {
  run?: ProbeRun;
  ready = false;
  private handle?: ProbeHandle;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private cueTimer?: ReturnType<typeof setTimeout>;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private scheduled = false;
  private firstPlaying = false;
  private observationTimer?: ReturnType<typeof setTimeout>;
  private stableSince?: { timeMs: number; position: number };
  private changed = new Set<() => void>();
  private microphone: ProbeMicrophone;
  private micTimer?: ReturnType<typeof setTimeout>;
  private micWantsPlayback = false;
  private cleanupPending?: Promise<void>;

  constructor(
    private host: HTMLElement,
    private origin: string,
    private load: () => Promise<YouTubeApi> = loadYouTubeApi,
    private now: () => number = () => performance.now(),
    private activation: () => ProbeEntry['userActivation'] = () => {
      const value = navigator.userActivation;
      return value ? { isActive: value.isActive, hasBeenActive: value.hasBeenActive } : undefined;
    },
    audio?: AudioInput,
  ) { this.microphone = new ProbeMicrophone((event, detail) => this.record(event, { detail }), audio); }

  subscribe(listener: () => void) { this.changed.add(listener); return () => { this.changed.delete(listener); }; }
  private record(event: string, extra: Partial<ProbeEntry> = {}) {
    const run = this.run;
    if (!run) return;
    let state: number | undefined; let observedVideoId: string | undefined; let currentTimeSec: number | undefined;
    try { state = this.handle?.getPlayerState(); observedVideoId = this.handle?.getVideoData().video_id; } catch { /* ready前でも記録する */ }
    try { const value = this.handle?.getCurrentTime(); if (Number.isFinite(value)) currentTimeSec = value; } catch { /* 観測不能は欠測 */ }
    const timeMs = this.now();
    run.entries.push({ sequence: run.entries.length + run.dropped + 1, timeMs, elapsedMs: timeMs - run.startedMs,
      wallTime: new Date().toISOString(), event, state, observedVideoId, currentTimeSec, userActivation: this.activation(), ...extra });
    if (run.entries.length > MAX_ENTRIES) { run.entries.shift(); run.dropped++; }
    this.changed.forEach(listener => listener());
  }
  private cancelTimers() {
    if (this.run?.seek && !this.run.seek.outcome) this.run.seek.outcome = 'interrupted';
    clearTimeout(this.timer); clearTimeout(this.cueTimer); clearTimeout(this.readyTimer);
    clearTimeout(this.observationTimer); this.observationTimer = undefined;
    this.timer = undefined; this.cueTimer = undefined; this.readyTimer = undefined;
  }

  async start(condition: Condition, videoId: string, delayMs: number, micOptions: MicProbeOptions = micProbeDefaults,
    compensation: Compensation = compensationDefaults): Promise<void> {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error('11文字の動画IDを入力してください');
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 300_000) throw new Error('待機時間は0〜300秒です');
    if (isMicCondition(condition)) validateMicOptions(micOptions);
    const effective = condition === 'mic-compensation' ? effectiveCompensation(compensation) : undefined;
    if (this.cleanupPending) await this.cleanupPending;
    this.dispose();
    if (this.cleanupPending) await this.cleanupPending;
    const id = ++this.generation;
    this.ready = false; this.scheduled = false; this.firstPlaying = false; this.stableSince = undefined;
    this.run = { id, condition, videoId, delayMs: condition.startsWith('seek-') ? seekObservation.delayMs : delayMs, startedMs: this.now(), entries: [], dropped: 0 };
    if (isMicCondition(condition)) this.run.mic = { options: { ...micOptions }, phase: 'preplay' };
    if (effective) this.run.compensation = { configured: { ...compensation }, effective };
    this.record('trial.start');
    try {
      const api = await this.load();
      if (id !== this.generation) return;
      const target = this.host.ownerDocument.createElement('div'); this.host.appendChild(target);
      this.readyTimer = setTimeout(() => {
        if (id === this.generation) this.record('ready.timeout', { detail: '15秒以内にonReadyなし。自動再生ブロックとは未判定' });
        if (id === this.generation && isMicCondition(condition)) this.micFailure(new Error('YouTube準備期限超過'));
      }, 15_000);
      this.handle = new api.Player(target, {
        width: '100%', height: '270', playerVars: { autoplay: 0, playsinline: 1, origin: this.origin },
        events: {
          onReady: event => {
            if (id !== this.generation) return;
            this.handle = event.target as ProbeHandle; clearTimeout(this.readyTimer); this.record('onReady');
            this.cueTimer = setTimeout(() => {
              if (id === this.generation) this.record('cue.timeout', { detail: '15秒以内にCUEDなし。プレイヤーは保持' });
              if (id === this.generation && isMicCondition(condition)) this.micFailure(new Error('CUED確認期限超過'));
            }, 15_000);
            try { this.record('cue.request'); event.target.cueVideoById({ videoId, startSeconds: 0 }); }
            catch (error) { this.failure(error); }
          },
          onStateChange: event => {
            if (id !== this.generation) return;
            const receivedMs = this.now();
            const firstCue = event.data === 5 && !this.ready;
            if (event.data === 5) { this.ready = true; clearTimeout(this.cueTimer); }
            this.record(states[event.data] ?? 'UNKNOWN_STATE', { state: event.data, timeMs: receivedMs, elapsedMs: receivedMs - this.run!.startedMs });
            if (isMicCondition(condition)) { this.onMicState(event.data, id, receivedMs); return; }
            if (event.data !== 1) this.stableSince = undefined;
            if (event.data === 1 && !this.firstPlaying) {
              this.firstPlaying = true;
              if (condition === 'seek-playing') this.scheduleSeek(id);
              if (condition === 'seek-paused') {
                this.record('preplay.pause.request');
                try { this.handle?.pauseVideo(); } catch (error) { this.failure(error); }
              }
            }
            if (event.data === 2 && this.firstPlaying && condition === 'seek-paused' && !this.scheduled) this.scheduleSeek(id);
            if (firstCue && condition === 'delayed' && !this.scheduled) {
              this.scheduled = true;
              this.record('delay.scheduled', { detail: `${delayMs}ms after CUED` });
              this.timer = setTimeout(() => { if (id === this.generation) this.play('timer'); }, delayMs);
            }
          },
          onAutoplayBlocked: () => {
            if (id !== this.generation) return;
            this.cancelTimers();
            this.record('onAutoplayBlocked', { detail: 'ブラウザによるスクリプト再生拒否。詳細原因はAPIから不明。プレイヤーは保持' });
            if (isMicCondition(condition)) this.micFailure(new Error('自動再生ブロック'));
          },
          onError: event => {
            if (id !== this.generation) return;
            this.cancelTimers();
            this.record('onError', { errorCode: event.data, detail: errorReasons[event.data] ?? '未知のYouTubeエラー' });
            if (isMicCondition(condition)) this.micFailure(new Error(`YouTube ${event.data}`));
          },
        },
      }) as ProbeHandle;
    } catch (error) { if (id === this.generation) this.failure(error); }
  }

  private onMicState(state: number, id: number, receivedMs: number) {
    const mic = this.run?.mic;
    if (!mic || !this.handle) return;
    if (state === 1 && mic.phase === 'preplay') {
      if (this.handle.getPlayerState() !== 1) return;
      mic.phase = 'pausing'; this.record('preplay.pause.request');
      this.micTimer = setTimeout(() => this.micFailure(new Error('事前再生後のPAUSED確認期限超過')), 10_000);
      try { this.handle.pauseVideo(); } catch (error) { this.micFailure(error); }
    } else if (state === 2 && mic.phase === 'pausing') {
      if (this.handle.getPlayerState() !== 2) return;
      clearTimeout(this.micTimer); mic.phase = 'acquiring'; this.record('mic.pause.confirmed');
      void this.microphone.arm(mic.options, () => this.micDetected(id), error => {
        if (id === this.generation) this.micFailure(error);
      }, rms => {
        if (id === this.generation) { mic.rms = rms; this.changed.forEach(listener => listener()); }
      }, () => id === this.generation && this.handle?.getPlayerState() === 2 &&
        this.handle.getVideoData().video_id === this.run?.videoId, () => {
        mic.phase = 'armed'; mic.armedMs = this.now();
      });
    } else if (state === 1 && this.handle.getPlayerState() === 1) {
      if (!this.micWantsPlayback && ['acquiring', 'armed', 'waiting', 'paused'].includes(mic.phase)) {
        this.micFailure(new Error('検知前または一時停止後の想定外PLAYING')); return;
      }
      if (this.micWantsPlayback && mic.phase === 'starting') {
        clearTimeout(this.micTimer); mic.phase = 'playing';
        if (mic.playingAfterDetectedMs === undefined && mic.detectedMs !== undefined && !mic.initialOutcome) {
          const playingMs = receivedMs;
          mic.playingAfterDetectedMs = playingMs - mic.detectedMs;
          if (mic.requestedPlayMs !== undefined) mic.playingAfterRequestMs = playingMs - mic.requestedPlayMs;
          const position = this.handle.getCurrentTime();
          if (Number.isFinite(position)) mic.playingPositionSec = position;
          mic.initialOutcome = 'playing';
          this.record('mic.playing.latency', { detail: `${mic.playingAfterDetectedMs}ms; API観測のみ・実発音とは別` });
        } else this.record('mic.resumed');
      }
    } else if (state === 2 && mic.phase === 'playing') {
      mic.phase = 'paused'; this.micWantsPlayback = false; this.record('mic.paused');
    } else if (state === 0 && this.handle.getPlayerState() === 0) { mic.phase = 'ended'; this.record('mic.ended'); this.dispose(); }
  }

  private micDetected(id: number) {
    const mic = this.run?.mic;
    if (id !== this.generation || !mic || mic.phase !== 'armed' || !this.handle) return;
    if (this.handle.getPlayerState() !== 2 || this.handle.getVideoData().video_id !== this.run?.videoId) {
      this.micFailure(new Error('検知時に同じ動画の一時停止を確認できません')); return;
    }
    mic.detectedMs = this.now(); mic.detectedAfterArmedMs = mic.detectedMs - mic.armedMs!;
    mic.phase = 'waiting'; this.record('detector.detected');
    const waitMs = this.run?.compensation?.effective.waitMs ?? 0;
    this.record('compensation.wait.start', { detail: `${waitMs}ms` });
    const request = () => {
      if (id !== this.generation || mic.phase !== 'waiting') return;
      this.record('compensation.wait.end');
      this.requestMicPlayback(id);
    };
    if (waitMs > 0) this.timer = setTimeout(request, waitMs);
    else request(); // 0msでは余分なタイマーを挟まない。⑥の即時要求を維持。
  }

  private requestMicPlayback(id: number) {
    const mic = this.run?.mic;
    if (id !== this.generation || !mic || mic.phase !== 'waiting' || !this.handle) return;
    try {
      if (this.handle.getPlayerState() !== 2 || this.handle.getVideoData().video_id !== this.run?.videoId) {
        this.micFailure(new Error('補正待機後に同じ動画のPAUSED未確認')); return;
      }
      let seekSec = mic.options.startSec;
      if (this.run?.compensation) {
        const position = correctedPosition(seekSec, this.run.compensation.effective.offsetMs, this.handle.getDuration());
        seekSec = position.seekSec; mic.rawSeekSec = position.rawSec; mic.videoDurationSec = position.durationSec;
      }
      mic.seekRequestedSec = seekSec; mic.phase = 'starting';
      this.record('seek.request', { detail: `seekTo(${seekSec}, true)` });
      this.handle.seekTo(seekSec, true);
      if (id !== this.generation) return;
      this.micWantsPlayback = true;
      this.micTimer = setTimeout(() => this.micFailure(new Error('検知後のPLAYING確認期限超過')), 10_000);
      mic.requestedPlayMs = this.now(); mic.requestAfterDetectedMs = mic.requestedPlayMs - mic.detectedMs!;
      this.record('play.request', { detail: 'microphone' }); this.handle.playVideo();
    } catch (error) { this.micFailure(error); }
  }

  private micFailure(error: unknown) {
    if (!this.run?.mic) return;
    this.run.mic.phase = 'error'; this.record('mic.error', { detail: String(error) });
    try { this.dispose(); } catch (cleanupError) { this.record('player.dispose.error', { detail: String(cleanupError) }); }
  }

  resume() {
    const mic = this.run?.mic;
    if (!mic || mic.phase !== 'paused' || mic.detectedMs === undefined || !this.handle) return;
    if (this.handle.getPlayerState() !== 2) { this.micFailure(new Error('再開前のPAUSED未確認')); return; }
    mic.phase = 'starting'; this.micWantsPlayback = true;
    this.micTimer = setTimeout(() => this.micFailure(new Error('再開のPLAYING確認期限超過')), 10_000);
    this.record('play.request', { detail: 'resume-button' });
    try { this.handle.playVideo(); } catch (error) { this.micFailure(error); }
  }

  async retryMicCleanup() {
    await this.microphone.stop(true); this.cleanupPending = undefined; this.record('mic.cleanup.retried');
  }

  private scheduleSeek(id: number) {
    if (this.scheduled) return;
    this.scheduled = true;
    this.record('seek.delay.scheduled', { detail: '5000ms; seek-playing: PLAYING起点 / seek-paused: PAUSED起点' });
    this.timer = setTimeout(() => {
      if (id !== this.generation || !this.handle || !this.run) return;
      try {
        const requiredState = this.run.condition === 'seek-playing' ? 1 : 2;
        if (this.handle.getPlayerState() !== requiredState) {
          this.record('seek.cancelled', { detail: '要求時の状態が試験条件と異なるため未実行。新しい試行で再検証' }); return;
        }
        const beforeSec = this.handle.getCurrentTime();
        this.run.seek = { requestedMs: this.now(), beforeSec: Number.isFinite(beforeSec) ? beforeSec : undefined };
        this.record('seek.request', { detail: 'seekTo(0, true)' });
        this.handle.seekTo(0, true);
        this.record('seek.returned');
        if (this.run.condition === 'seek-paused' && !this.run.seek.outcome) this.play('timer');
        this.observeSeek(id);
      } catch (error) { this.failure(error); }
    }, seekObservation.delayMs);
  }

  private observeSeek(id: number) {
    if (id !== this.generation || !this.handle || !this.run?.seek || this.run.seek.outcome) return;
    const measurement = this.run.seek;
    try {
      const timeMs = this.now(); const position = this.handle.getCurrentTime(); const state = this.handle.getPlayerState();
      const elapsed = timeMs - measurement.requestedMs;
      this.record('seek.sample');
      if (measurement.targetNearZeroAfterMs === undefined && Number.isFinite(position) && position >= 0 && position <= seekObservation.nearZeroSec) {
        measurement.targetNearZeroAfterMs = elapsed; this.record('seek.target.observed');
      }
      if (measurement.positionChangedAfterMs === undefined && Number.isFinite(position) && position >= 0 &&
        position <= seekObservation.nearZeroSec && measurement.beforeSec !== undefined &&
        measurement.beforeSec - position >= seekObservation.minimumDropSec) {
        measurement.positionChangedAfterMs = elapsed; this.record('seek.position.changed');
      }
      // 元位置が既に0秒付近なら位置変化は判別不能。安定観測と位置変化は別指標。
      if (measurement.targetNearZeroAfterMs !== undefined && state === 1 && Number.isFinite(position)) {
        if (!this.stableSince || position < this.stableSince.position) this.stableSince = { timeMs, position };
        if (timeMs - this.stableSince.timeMs >= seekObservation.stableMs && position - this.stableSince.position >= seekObservation.minimumProgressSec) {
          measurement.stableAfterMs = elapsed; measurement.outcome = 'observed-stable';
          this.record('seek.stable', { detail: 'API状態・時刻進行による暫定観測。実発音・精密同期の証明ではない' }); return;
        }
      } else this.stableSince = undefined;
      if (elapsed >= seekObservation.timeoutMs) {
        measurement.outcome = 'observation-timeout';
        this.record('seek.observation.timeout', { detail: '位置変化または安定条件未確認。元位置が0秒付近なら変化の判別不能。ブロックとは未判定' }); return;
      }
      this.observationTimer = setTimeout(() => this.observeSeek(id), seekObservation.pollMs);
    } catch (error) { this.failure(error); }
  }

  /** 呼出元のクリックハンドラーから同期的にplayVideoまで到達する。await禁止。 */
  play(source: 'button' | 'timer') {
    if (this.run?.mic) { this.record('play.unavailable', { detail: '条件⑥は音検知または専用再開のみ' }); return; }
    if (!this.ready || !this.handle) { this.record('play.unavailable'); return; }
    this.record('play.request', { detail: source });
    try { this.handle.playVideo(); } catch (error) { this.failure(error); }
  }
  pause() {
    if (this.run?.mic) {
      const mic = this.run.mic;
      if (mic.detectedMs === undefined) { mic.phase = 'stopped'; this.dispose(); return; }
      if (!mic.initialOutcome) mic.initialOutcome = 'interrupted';
      this.micWantsPlayback = false; clearTimeout(this.micTimer); mic.phase = 'paused';
    }
    this.cancelTimers(); this.record('pause.request');
    this.scheduled = true; // 待機取消後の遅着PAUSEDでも比較試験を再予約しない。
    try { this.handle?.pauseVideo(); } catch (error) { this.failure(error); }
  }
  snapshot() { this.record('snapshot'); }
  note(text: string) { this.record('observer.note', { detail: text.slice(0, 2000) }); }
  private failure(error: unknown) {
    if (this.run?.mic) { this.micFailure(error); return; }
    this.cancelTimers(); this.record('exception', { detail: error instanceof Error ? error.message : String(error) });
  }
  dispose() {
    if (this.run?.mic) {
      if (this.run.mic.detectedMs !== undefined && !this.run.mic.initialOutcome) this.run.mic.initialOutcome = 'interrupted';
      clearTimeout(this.micTimer); this.micWantsPlayback = false;
      if (!['error', 'ended'].includes(this.run.mic.phase)) this.run.mic.phase = 'stopped';
      this.record('mic.stop');
      this.cleanupPending = this.microphone.stop();
      void this.cleanupPending.catch(() => {}); // 表示はmic.release.error。所有権は保持して明示再試行。
    }
    ++this.generation; this.cancelTimers(); this.ready = false;
    if (this.handle) {
      try { this.handle.destroy(); this.record('player.disposed'); }
      catch (error) { this.record('player.dispose.error', { detail: String(error) }); throw error; }
      this.handle = undefined;
    }
    this.host.replaceChildren();
  }
  export(environment: Record<string, unknown>) {
    return JSON.stringify({ schema: 'karaokesync-youtube-probe-v1', exportedAt: new Date().toISOString(),
      environment, clock: 'performance.now() ms; wallTime is ISO wall clock',
      limitations: 'PLAYINGは実発音の証明ではない。iframe内タップは親ページから直接観測できない。条件間でもブラウザの操作履歴は残る。',
      seekObservation, run: this.run }, null, 2);
  }
}
