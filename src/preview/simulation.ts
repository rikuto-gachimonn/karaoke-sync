import { SimulatedPlayer } from '../adapters/simulation';
/** Preview-only clock; normal synchronization simulation is unchanged. */
export class SimulatedPreviewPlayer extends SimulatedPlayer {
  private timer?: ReturnType<typeof setInterval>;
  async prepare(_videoId = '', startSec = 0) { this.currentPosition = startSec; }
  play(request: number) {
    super.play(request); clearInterval(this.timer); this.emit({ type: 'playing' });
    this.timer = setInterval(() => { this.currentPosition = Math.min(this.videoDuration, this.currentPosition + .05); if (this.currentPosition >= this.videoDuration) { clearInterval(this.timer); this.emit({ type: 'ended' }); } }, 50);
  }
  async pause() { clearInterval(this.timer); await super.pause(); }
  async dispose() { clearInterval(this.timer); await super.dispose(); }
}
