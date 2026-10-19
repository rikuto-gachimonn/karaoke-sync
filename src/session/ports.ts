import type { SyncInput } from '../domain/sync';

export type Unsubscribe = () => void;
export type PlayerEvent =
  | { type: 'playing' | 'paused' | 'ended' | 'buffering' | 'cued'; requestId?: number }
  | { type: 'blocked' | 'error'; message: string; requestId?: number };

// 一つのセッションが一つのplayerを所有する。実adapterはprepareでCUEDを確認する。
// pauseの完了は停止確認、disposeの完了は確実な破棄を意味する契約。
// requestIdは由来を証明できる模擬等のみ。YouTubeイベントへ現在番号を後付けしない。
// readPlaybackStateはイベントのラベルではなく、問い合わせ時の現在状態を返す。
export interface Player {
  prepare(videoId: string, startSec: number): Promise<void>;
  play(requestId: number): void;
  pause(): Promise<void>;
  dispose(): Promise<void>;
  readPlaybackState(): Promise<'playing' | 'paused' | 'ended' | 'other'>;
  seek?(positionSec: number): void;
  duration?(): number;
  position?(): number;
  subscribe(listener: (event: PlayerEvent) => void): Unsubscribe;
}

export interface VolumeSample { rms: number; timeMs: number }
export interface AudioLease {
  inputInfo?(): string;
  subscribe(listener: (sample: VolumeSample) => void): Unsubscribe;
  release(): Promise<void>;
  onInterrupted?(listener: (message: string) => void): Unsubscribe;
}
// acquireは停止・期限超過でも未完了のまま残り得る。取消可能とは仮定しない。
// signalはアプリ側の初期化・部分資源回収用。getUserMediaの実取消を意味しない。
export interface AudioInput { acquire(signal?: AbortSignal): Promise<AudioLease> }
// 部分資源の回収成功後だけ返す。新しいユーザー操作で再取得できる起動失敗。
export class AudioStartError extends Error {}
// 部分取得の後始末自体が失敗した場合、controllerへ資源所有権を引き渡す。
export class AudioAcquireError extends Error {
  constructor(message: string, readonly lease: AudioLease) { super(message); }
}
export interface Detector {
  arm(config: Pick<SyncInput, 'threshold' | 'durationMs'>, detected: () => void): void;
  sample(sample: VolumeSample): void;
  disarm(): void;
}
export interface SessionDependencies {
  allowPrepare?(): boolean;
  createPlayer(): Player;
  audio: AudioInput;
  createDetector(): Detector;
}
