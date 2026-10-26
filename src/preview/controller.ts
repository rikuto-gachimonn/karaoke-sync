import type { Player, PlayerEvent } from '../session/ports';
import type { PreviewTone } from './tone';
export interface PreviewState { busy: boolean; phase: 'idle' | 'preparing' | 'ready' | 'playing' | 'stopping' | 'error'; message: string; targetSec?: number; positionSec?: number; beeped: boolean }
interface Run { active: boolean; target: number; start: number; end: number; player?: Player; tone?: PreviewTone; off?: () => void; visibilityOff?: () => void; timers: Set<ReturnType<typeof setTimeout>>; last?: { position: number; time: number }; beeped: boolean; firstDeadline?: number; publishedAt?: number; cleaning?: Promise<void> }
export class PositionPreviewController {
  private state: PreviewState = { busy: false, phase: 'idle', message: '', beeped: false };
  private listeners = new Set<() => void>(); private run?: Run;
  constructor(private dependencies: { createPlayer(): Player; createTone(): PreviewTone; canStart(): boolean; hidden?(): boolean; onHidden?(callback: () => void): () => void }, private now = () => performance.now()) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<PreviewState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  private valid(run: Run) { return this.run === run && run.active; }
  private later(run: Run, ms: number, callback: () => void) { const timer = setTimeout(() => { run.timers.delete(timer); if (this.valid(run)) callback(); }, ms); run.timers.add(timer); return timer; }
  /** Called directly from a user gesture, before any asynchronous work can consume audio activation. */
  async start(videoId: string, target: number) {
    if (this.state.busy || !this.dependencies.canStart()) return;
    if (!/^[\w-]{11}$/.test(videoId) || !Number.isFinite(target) || target < 0) { this.update({ phase: 'error', message: '動画と歌い始め位置（0秒以上）を確認してください' }); return; }
    const run: Run = { active: true, target, start: Math.max(0, target - 2), end: target + 2, timers: new Set(), beeped: false };
    this.run = run; this.update({ busy: true, phase: 'preparing', targetSec: target, positionSec: undefined, beeped: false, message: '開始位置確認の動画と確認音を準備中（マイクは使用しません）' });
    try {
      if (this.dependencies.hidden?.()) throw new Error('画面を表示してから開始してください');
      run.tone = this.dependencies.createTone();
      const audio = run.tone.unlock(); void audio.catch(() => {}); // AudioContext/resume starts in the initiating button event.
      run.player = this.dependencies.createPlayer();
      run.off = run.player.subscribe(event => this.event(run, event));
      run.visibilityOff = this.dependencies.onHidden?.(() => { void this.finish(run, '画面が非表示になったためプレビューを停止しました'); });
      const timeout = this.later(run, 15000, () => { void this.finish(run, '動画または確認音の準備期限を超えました', true); });
      await Promise.all([audio, run.player.prepare(videoId, run.start)]);
      if (!this.valid(run)) return;
      clearTimeout(timeout); run.timers.delete(timeout);
      const duration = run.player.duration?.();
      if (!Number.isFinite(duration) || !duration || duration <= target) throw new Error('歌い始め位置が動画の範囲内か確認できません');
      run.end = Math.min(duration, target + 2);
      this.update({ phase: 'ready', message: 'プレビューの再生を要求します。再生されない場合は「プレビューを再生」または動画内の▶を押してください' });
      this.later(run, 15000, () => { if (this.state.phase === 'ready') void this.finish(run, '再生を確認できませんでした。ブラウザの再生制限を確認してください', true); });
      this.play();
    } catch (error) { if (this.valid(run)) await this.finish(run, String(error), true); }
  }
  /** Tone-only check shares the preview ownership lock and cleanup; never creates a player. */
  async testTone() {
    if (this.state.busy || !this.dependencies.canStart()) return;
    const run: Run = { active: true, target: 0, start: 0, end: 0, timers: new Set(), beeped: false };
    this.run = run;
    this.update({ busy: true, phase: 'preparing', message: '確認音を準備中', targetSec: undefined, positionSec: undefined, beeped: false });
    try {
      if (this.dependencies.hidden?.()) throw new Error('画面を表示してから開始してください');
      run.tone = this.dependencies.createTone();
      run.visibilityOff = this.dependencies.onHidden?.(() => { void this.finish(run, '確認音を停止しました'); });
      this.later(run, 5000, () => { void this.finish(run, '確認音の準備期限を超えました', true); });
      await run.tone.unlock();
      if (!this.valid(run)) return;
      run.tone.beep();
      this.update({ phase: 'playing', beeped: true, message: '確認音を試しています' });
      this.later(run, 200, () => { void this.finish(run, '確認音の試聴が終了しました'); });
    } catch (error) { if (this.valid(run)) await this.finish(run, String(error), true); }
  }
  play() {
    const run = this.run;
    if (!run || !this.valid(run) || this.state.phase !== 'ready') return;
    try {
      void run.tone!.unlock().catch(error => { if (this.valid(run)) void this.finish(run, String(error), true); });
      run.player!.seek?.(run.start); run.player!.play(0);
    } catch (error) { void this.finish(run, String(error), true); }
  }
  private event(run: Run, event: PlayerEvent) {
    if (!this.valid(run)) return;
    if (event.type === 'blocked' && this.state.phase === 'ready') { this.update({ message: 'ブラウザが自動再生を制限しました。「プレビューを再生」または動画内の▶を押してください。確認音はまだ鳴らしていません' }); return; }
    if (event.type === 'error' || event.type === 'blocked') { void this.finish(run, event.message, true); return; }
    if (event.type === 'playing' && this.state.phase === 'ready') {
      run.firstDeadline = this.now() + 1000;
      this.update({ phase: 'playing', message: '補正前の歌い始め位置を確認中' });
      this.later(run, 12000, () => { void this.finish(run, '時刻が進まないためプレビューを停止しました', true); });
      void this.sample(run); return;
    }
    if (this.state.phase === 'playing' && ['buffering', 'paused', 'cued'].includes(event.type)) { void this.finish(run, '再生中断・シーク・バッファリングのため確認を中止しました。もう一度確認してください', true); return; }
    if (event.type === 'ended') void this.finish(run, run.beeped ? 'プレビューが終了しました' : '指定位置を確認する前に動画が終了しました', !run.beeped);
  }
  private async sample(run: Run) {
    try {
      const state = await run.player!.readPlaybackState();
      if (!this.valid(run)) return;
      if (this.dependencies.hidden?.() || state !== 'playing') throw new Error('再生状態を確認できないため、確認音を鳴らさず停止しました');
      const position = run.player!.position?.(), time = this.now(), rate = run.player!.playbackRate?.() ?? 1;
      if (!Number.isFinite(position) || position! < 0 || !Number.isFinite(rate) || rate <= 0) throw new Error('動画の再生時刻を取得できません');
      if (!run.last) {
        if (position! < run.start - .1 && time < (run.firstDeadline ?? time)) {
          this.later(run, 50, () => { void this.sample(run); }); return;
        }
        if (position! < run.start - .1 || position! > run.start + .3) throw new Error('プレビュー開始位置を確認できません。シーク後にもう一度確認してください');
        if (position! >= run.target && !(run.target === 0 && position! <= .15)) throw new Error('指定位置より前の時刻を確認できません');
      } else {
        const elapsed = time - run.last.time, delta = position! - run.last.position;
        if (elapsed < 0 || elapsed > 300 || delta < -.03 || delta > Math.max(.30, elapsed / 1000 * rate + .15)) throw new Error('時刻の飛び・監視の中断を検出したため確認音を中止しました');
      }
      if (!run.beeped && position! >= run.target) {
        if (position! - run.target > .25) throw new Error('指定位置の通過を十分近くで確認できませんでした');
        run.tone!.beep(); run.beeped = true;
        run.publishedAt = time;
        this.update({ positionSec: position, beeped: true, message: '指定した歌い始め位置を通過しました（確認音を1回要求）。実際の音との一致精度は未保証です' });
      }
      run.last = { position: position!, time };
      // Monitor at 20Hz, but redraw the full app's reference clock at only 4Hz.
      if (run.publishedAt === undefined || time - run.publishedAt >= 250 || position! >= run.end) {
        run.publishedAt = time; this.update({ positionSec: position });
      }
      if (run.beeped && position! >= run.end) { await this.finish(run, '開始位置の確認が終了しました。通常の検知は開始していません'); return; }
      this.later(run, 50, () => { void this.sample(run); });
    } catch (error) { if (this.valid(run)) await this.finish(run, String(error), true); }
  }
  stop = async () => { if (this.run) await this.finish(this.run, '開始位置の確認を停止しました'); };
  private finish(run: Run, message: string, error = false): Promise<void> {
    if (this.run !== run) return Promise.resolve();
    if (run.cleaning) return run.cleaning;
    run.active = false; run.timers.forEach(clearTimeout); run.timers.clear(); run.off?.(); run.visibilityOff?.(); run.off = run.visibilityOff = undefined;
    this.update({ phase: 'stopping', busy: true, message: 'プレビューの動画・確認音を終了中' });
    const warning = setTimeout(() => { if (this.run === run) this.update({ phase: 'error', message: 'プレビューの資源解放が未完了です。完了するまで通常の検知は開始できません' }); }, 2500);
    run.cleaning = Promise.allSettled([
      Promise.resolve().then(async () => { if (run.tone) { await run.tone.close(); run.tone = undefined; } }),
      Promise.resolve().then(async () => { if (run.player) {
        // Attempt PAUSED before destroying the visible player; destruction remains the release proof.
        try { await run.player.pause(); } catch { /* Still destroy if PAUSED cannot be confirmed. */ }
        await run.player.dispose(); run.player = undefined;
      } }),
    ]).then(results => {
      if (this.run !== run) return;
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') this.update({ busy: true, phase: 'error', message: `終了処理に失敗しました。「すべて停止」で再試行してください: ${String(failed.reason)}` });
      else { this.run = undefined; this.update({ busy: false, phase: error ? 'error' : 'idle', message }); }
    }).finally(() => { clearTimeout(warning); run.cleaning = undefined; });
    return run.cleaning;
  }
}
