import type { Player, PlayerEvent } from '../../session/ports';
import { youtubeErrorMessage } from '../../youtube/errors';
import { loadYouTubeApi, type YouTubeApi, type YouTubeHandle } from './api';

export class YouTubePlayer implements Player {
  private handle?: YouTubeHandle;
  private listeners = new Set<(event: PlayerEvent) => void>();
  private closed = false;
  private prepared = false;
  private ready = false;
  private videoId = '';
  private failReady?: (error: Error) => void;
  private cue?: { resolve(): void; reject(error: Error): void };

  constructor(
    private host: HTMLElement,
    private load: () => Promise<YouTubeApi> = loadYouTubeApi,
    private origin: string = window.location.origin,
  ) {}

  async prepare(videoId: string, startSec: number): Promise<void> {
    if (this.closed || this.handle) throw new Error('プレイヤーはセッションごとに新規作成してください');
    this.videoId = videoId;
    const api = await this.load();
    if (this.closed) throw new Error('動画準備は取消済みです');
    const target = this.host.ownerDocument.createElement('div');
    this.host.appendChild(target);
    await new Promise<void>((resolve, reject) => {
      this.failReady = reject;
      this.handle = new api.Player(target, {
        width: '100%', height: '270',
        playerVars: { autoplay: 0, playsinline: 1, origin: this.origin },
        events: {
          onReady: event => { if (!this.closed) { this.handle = event.target; this.ready = true; this.failReady = undefined; resolve(); } },
          onStateChange: event => this.onState(event.data),
          onError: event => this.fail(youtubeErrorMessage(event.data)),
          onAutoplayBlocked: () => this.emit({ type: 'blocked', message: 'ブラウザが再生を拒否しました。明示操作・待機条件を確認してください' }),
        },
      });
    });
    if (this.closed) throw new Error('動画準備は取消済みです');
    await new Promise<void>((resolve, reject) => {
      this.cue = { resolve, reject };
      try { this.handle!.cueVideoById({ videoId, startSeconds: startSec }); }
      catch (error) { this.cue = undefined; reject(error); }
    });
    if (this.closed) throw new Error('動画準備は取消済みです');
    this.prepared = true;
  }

  private emit(event: PlayerEvent): void { if (!this.closed) this.listeners.forEach(listener => listener(event)); }
  private fail(message: string): void {
    const error = new Error(message);
    this.failReady?.(error); this.failReady = undefined;
    this.cue?.reject(error); this.cue = undefined;
    this.emit({ type: 'error', message });
  }

  private onState(state: number): void {
    if (this.closed) return;
    if (state === 5 && this.handle?.getVideoData().video_id === this.videoId) {
      this.cue?.resolve(); this.cue = undefined;
      this.emit({ type: 'cued' });
    }
    const type = ({ 1: 'playing', 2: 'paused', 0: 'ended', 3: 'buffering' } as const)[state as 0 | 1 | 2 | 3];
    if (type) this.emit({ type }); // IFrameにないrequestIdは絶対に後付けしない。
  }

  play(_requestId: number): void {
    if (this.closed || !this.prepared || !this.handle) throw new Error('動画が準備できていません');
    this.handle.playVideo();
  }
  seek(positionSec: number): void {
    if (this.closed || !this.prepared || !this.handle) throw new Error('動画が準備できていません');
    (this.handle as YouTubeHandle & { seekTo(seconds: number, ahead: boolean): void }).seekTo(positionSec, true);
  }
  duration(): number {
    if (this.closed || !this.ready || !this.handle) throw new Error('動画が準備できていません');
    return (this.handle as YouTubeHandle & { getDuration(): number }).getDuration();
  }
  position(): number {
    if (this.closed || !this.ready || !this.handle) throw new Error('動画が準備できていません');
    return (this.handle as YouTubeHandle & { getCurrentTime(): number }).getCurrentTime();
  }

  async pause(): Promise<void> {
    if (this.closed || !this.ready || !this.handle) return;
    this.handle.pauseVideo();
    // PAUSEDイベントだけに依存せず、未再生/CUED/ENDEDでも停止を確認する。
    const started = performance.now();
    while (!this.closed && this.handle) {
      if ([2, 0, 5, -1].includes(this.handle.getPlayerState())) return;
      if (performance.now() - started > 2_500) throw new Error('YouTubeの停止を確認できません');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }

  async readPlaybackState(): Promise<'playing' | 'paused' | 'ended' | 'other'> {
    if (this.closed || !this.ready || !this.handle || this.handle.getVideoData().video_id !== this.videoId) return 'other';
    const state = this.handle.getPlayerState();
    return state === 1 ? 'playing' : state === 2 ? 'paused' : state === 0 ? 'ended' : 'other';
  }

  async dispose(): Promise<void> {
    if (this.closed && !this.handle) return;
    this.closed = true;
    this.failReady?.(new Error('プレイヤーを破棄しました')); this.failReady = undefined;
    this.cue?.reject(new Error('プレイヤーを破棄しました')); this.cue = undefined;
    this.listeners.clear();
    // destroyが失敗した場合はhandleを維持し、cleanupの明示再試行を可能にする。
    this.handle?.destroy();
    this.handle = undefined;
    this.host.replaceChildren();
  }

  subscribe(listener: (event: PlayerEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
