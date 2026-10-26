export interface PreviewTone { unlock(): Promise<void>; beep(): void; close(): Promise<void> }
/** One short, quiet oscillator on the browser's current default output; no microphone/sink changes. */
export class BrowserPreviewTone implements PreviewTone {
  private context?: AudioContext;
  private oscillator?: OscillatorNode;
  private gain?: GainNode;
  private sounded = false;
  constructor(private volumePercent = 30, private volumeScale: 1 | 2 = 2) {}
  async unlock() {
    if (!this.context) {
      const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) throw new Error('このブラウザは確認音のWeb Audioに対応していません');
      this.context = new Constructor();
    }
    try { await this.context.resume(); }
    catch { throw new Error('確認音の起動が制限されました。画面を直接操作して再試行してください'); }
    if (this.context.state !== 'running') throw new Error('確認音を起動できません。画面を直接操作して再試行してください');
  }
  beep() {
    if (this.sounded) return;
    const context = this.context;
    if (!context || context.state !== 'running') throw new Error('確認音の音声処理が停止しています');
    this.sounded = true;
    const oscillator = context.createOscillator(), gain = context.createGain(), time = context.currentTime;
    this.oscillator = oscillator; this.gain = gain;
    const peak = (this.volumeScale === 1 ? .15 : .30) * (Number.isFinite(this.volumePercent) ? Math.min(100, Math.max(0, this.volumePercent)) : 30) / 100;
    oscillator.type = 'sine'; oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0, time); gain.gain.linearRampToValueAtTime(peak, time + .01);
    gain.gain.setValueAtTime(peak, time + .10); gain.gain.linearRampToValueAtTime(0, time + .15);
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); if (this.oscillator === oscillator) { this.oscillator = undefined; this.gain = undefined; } };
    oscillator.start(time); oscillator.stop(time + .16);
  }
  async close() {
    if (this.oscillator) { this.oscillator.onended = null; try { this.oscillator.stop(); } catch { /* Already ended or never started. Still close the context. */ } finally { this.oscillator.disconnect(); this.gain?.disconnect(); this.oscillator = undefined; this.gain = undefined; } }
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = undefined;
  }
}
