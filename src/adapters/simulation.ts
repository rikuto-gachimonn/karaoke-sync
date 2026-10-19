import { SustainedVolumeDetector } from '../domain/detector';
import type { AudioInput, AudioLease, Player, PlayerEvent, VolumeSample } from '../session/ports';

// 段階1専用。ネットワーク・マイク・localStorageには一切アクセスしない。
export class SimulatedPlayer implements Player {
  private listeners = new Set<(event: PlayerEvent) => void>();
  requestId = 0;
  disposed = false;
  playbackState: 'playing' | 'paused' | 'ended' | 'other' = 'other';
  videoDuration = 240;
  currentPosition = 0;
  seek(positionSec: number): void { this.currentPosition = positionSec; }
  duration(): number { return this.videoDuration; }
  position(): number { return this.currentPosition; }
  async prepare(): Promise<void> {}
  play(requestId: number): void { this.requestId = requestId; }
  async pause(): Promise<void> { this.playbackState = 'paused'; }
  async readPlaybackState() { return this.playbackState; }
  async dispose(): Promise<void> { this.disposed = true; this.listeners.clear(); }
  subscribe(listener: (event: PlayerEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(event: PlayerEvent): void {
    if (event.type === 'playing' || event.type === 'paused' || event.type === 'ended') this.playbackState = event.type;
    this.listeners.forEach(listener => listener(event));
  }
}

export class SimulatedLease implements AudioLease {
  private listeners = new Set<(sample: VolumeSample) => void>();
  released = false;
  subscribe(listener: (sample: VolumeSample) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  sample(sample: VolumeSample): void { this.listeners.forEach(listener => listener(sample)); }
  async release(): Promise<void> { this.released = true; this.listeners.clear(); }
}

export function createSimulation() {
  let player = new SimulatedPlayer();
  let lease = new SimulatedLease();
  let denyNext = false;
  const audio: AudioInput = {
    async acquire() {
      if (denyNext) { denyNext = false; throw new Error('模擬マイク許可拒否'); }
      lease = new SimulatedLease();
      return lease;
    },
  };
  return {
    dependencies: {
      audio,
      createPlayer: () => { player = new SimulatedPlayer(); return player; },
      createDetector: () => new SustainedVolumeDetector(),
    },
    sample: (sample: VolumeSample) => lease.sample(sample),
    tone: () => {
      const target = lease;
      const started = performance.now();
      // 人の連打速度に依存せず継続時間を試す。停止・最大設定時間後に必ず終了。
      const timer = setInterval(() => {
        if (target.released || performance.now() - started > 2_200) { clearInterval(timer); return; }
        target.sample({ rms: 0.5, timeMs: performance.now() });
      }, 20);
    },
    playerEvent: (type: 'playing' | 'ended' | 'blocked') => {
      if (type === 'blocked') player.emit({ type, message: '模擬ブラウザ拒否', requestId: player.requestId });
      else player.emit({ type, requestId: player.requestId });
    },
    denyNext: () => { denyNext = true; },
  };
}
