import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedLease, SimulatedPlayer } from '../src/adapters/simulation';
import { sessionOptions, settings } from '../src/config/settings';
import { DiagnosticLog } from '../src/diagnostics/log';
import { SustainedVolumeDetector } from '../src/domain/detector';
import type { SyncInput } from '../src/domain/sync';
import { SessionController } from '../src/session/controller';
import { LeaseReleaser } from '../src/session/leaseReleaser';
import type { AudioLease } from '../src/session/ports';

const input: SyncInput = { videoId: 'dQw4w9WgXcQ', service: 'DAM', savedPositionSec: 10, offsetSec: 0, threshold: 0.08, durationMs: 0 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }

function setup(acquire?: () => Promise<AudioLease>, retainMic = true) {
  const players: SimulatedPlayer[] = [];
  const lease = new SimulatedLease();
  const release = vi.spyOn(lease, 'release');
  const acquisition = vi.fn(acquire ?? (async () => lease));
  const controller = new SessionController({
    audio: { acquire: acquisition },
    createPlayer: () => { const player = new SimulatedPlayer(); players.push(player); return player; },
    createDetector: () => new SustainedVolumeDetector(),
  }, new DiagnosticLog(() => Date.now()), {
    ...sessionOptions, acquireTimeoutMs: 60, prepareTimeoutMs: 50, armedTimeoutMs: 100,
    playingTimeoutMs: 40, cleanupTimeoutMs: 30, retainMic,
  });
  return { controller, players, lease, release, acquisition, detect: () => lease.sample({ rms: 0.5, timeMs: 0 }) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('requestIdを持たない外部イベント', () => {
  it('正当なIDなしPLAYINGを現在状態で確認し、番号を後付けしない', async () => {
    const s = setup(); await s.controller.prepare(input); s.detect();
    const player = s.players[0]!;
    const read = vi.spyOn(player, 'readPlaybackState');
    const pause = vi.spyOn(player, 'pause');
    player.emit({ type: 'playing' });
    expect(s.controller.getSnapshot().phase).toBe('starting');
    await flush();
    expect(s.controller.getSnapshot().phase).toBe('playing');
    expect(read).toHaveBeenCalledTimes(1); expect(pause).not.toHaveBeenCalled();
    expect(s.controller.log.snapshot().find(entry => entry.event === 'player.playing')?.detail).toBe('request=unknown');
    await s.controller.stop();
  });

  it('pause後に来たIDなしPLAYINGを停止し、pause完了までresumeを許可しない', async () => {
    const s = setup(); await s.controller.prepare(input); s.detect();
    const player = s.players[0]!; await s.controller.pause();
    const stopping = deferred<void>(); const pause = vi.spyOn(player, 'pause').mockReturnValueOnce(stopping.promise);
    const play = vi.spyOn(player, 'play');
    player.emit({ type: 'playing' });
    s.controller.resume(); await flush();
    expect(s.controller.getSnapshot().phase).toBe('paused');
    expect(play).not.toHaveBeenCalled(); expect(pause).toHaveBeenCalledTimes(1);
    stopping.resolve(); await flush(); s.controller.resume();
    expect(play).toHaveBeenCalledTimes(1); await s.controller.stop();
  });

  it('resume直後の古いIDなしPLAYINGが現在状態と不一致なら安全にpauseへ戻る', async () => {
    const s = setup(); await s.controller.prepare(input); s.detect();
    const player = s.players[0]!; await s.controller.pause(); s.controller.resume();
    vi.spyOn(player, 'readPlaybackState').mockResolvedValue('paused');
    const pause = vi.spyOn(player, 'pause');
    // 遅着した通知と現在の実状態が違う状況を模擬。
    player.emit({ type: 'playing' }); await flush();
    expect(s.controller.getSnapshot().phase).toBe('paused'); expect(pause).toHaveBeenCalledTimes(1);
    expect(s.controller.getSnapshot().message).toContain('不一致');
    await s.controller.stop();
  });

  it('resume後に現在状態もplayingなら、要求帰属ではなく実状態として確認する', async () => {
    const s = setup(); await s.controller.prepare(input); s.detect();
    const player = s.players[0]!; await s.controller.pause(); s.controller.resume();
    player.emit({ type: 'playing' }); await flush();
    expect(s.controller.getSnapshot().phase).toBe('playing'); await s.controller.stop();
  });

  it('状態問合せ中のpause→resumeを跨いだ結果を新要求へ使わない', async () => {
    const s = setup(); await s.controller.prepare(input); s.detect();
    const player = s.players[0]!; const observation = deferred<'playing'>();
    vi.spyOn(player, 'readPlaybackState').mockReturnValueOnce(observation.promise);
    player.emit({ type: 'playing' }); await s.controller.pause(); s.controller.resume();
    observation.resolve('playing'); await flush();
    expect(s.controller.getSnapshot().phase).toBe('starting');
    player.emit({ type: 'playing' }); await flush(); expect(s.controller.getSnapshot().phase).toBe('playing');
    await s.controller.stop();
  });

  it('状態照会不能・期限超過は成功にせず停止側へ戻し、明示再開を案内する', async () => {
    const s = setup(); await s.controller.prepare(input); s.detect();
    const player = s.players[0]!;
    vi.spyOn(player, 'readPlaybackState').mockReturnValue(new Promise(() => {}));
    player.emit({ type: 'playing' }); await vi.advanceTimersByTimeAsync(30);
    expect(s.controller.getSnapshot().phase).toBe('paused');
    expect(s.controller.getSnapshot().message).toContain('未確認'); await s.controller.stop();
  });

  it('旧番号のPLAYINGが再開後に来てもstartingのまま誤成功にしない', async () => {
    const s = setup(); await s.controller.prepare(input); s.detect();
    const player = s.players[0]!; const old = player.requestId;
    await s.controller.pause(); s.controller.resume();
    player.emit({ type: 'playing', requestId: old }); await flush();
    expect(s.controller.getSnapshot().phase).toBe('paused'); await s.controller.stop();
  });

  it('古いIDなしENDEDで、現在playingの新要求を終了しない', async () => {
    const s = setup(); await s.controller.prepare(input); s.detect();
    const player = s.players[0]!; player.emit({ type: 'playing' }); await flush();
    await s.controller.pause(); s.controller.resume(); player.emit({ type: 'playing' }); await flush();
    vi.spyOn(player, 'readPlaybackState').mockResolvedValue('playing');
    player.emit({ type: 'ended' }); await flush();
    expect(s.controller.getSnapshot().phase).toBe('playing'); expect(s.release).not.toHaveBeenCalled();
    await s.controller.stop();
  });

  it('検知前のIDなしPLAYINGは止め、再生命令を発行しない', async () => {
    const s = setup(); await s.controller.prepare(input);
    const player = s.players[0]!; const play = vi.spyOn(player, 'play'); const pause = vi.spyOn(player, 'pause');
    player.emit({ type: 'playing' }); await flush();
    expect(pause).toHaveBeenCalledTimes(1); expect(play).not.toHaveBeenCalled();
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'error', mic: 'off' });
    s.detect(); expect(play).not.toHaveBeenCalled(); await s.controller.stop();
  });
});

describe('永久未完了取得からの明示復旧', () => {
  it('タイムアウト後に旧要求を隔離し、遅着成功が新セッションを変えない', async () => {
    const old = deferred<AudioLease>(); const fresh = new SimulatedLease();
    let calls = 0; const s = setup(() => ++calls === 1 ? old.promise : Promise.resolve(fresh));
    const preparing = s.controller.prepare(input); await vi.advanceTimersByTimeAsync(60); await preparing;
    expect(s.controller.getSnapshot().canRecoverAcquisition).toBe(true);
    await s.controller.recoverPendingAcquisition(); await s.controller.prepare(input);
    expect(s.controller.getSnapshot().phase).toBe('armed');
    const generation = s.controller.getSnapshot().generation;
    old.resolve(s.lease); await flush();
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'armed', generation, mic: 'running' });
    expect(fresh.released).toBe(false); await s.controller.stop();
  });

  it('停止後に永久に応答しない取得も隔離して再準備できる', async () => {
    let calls = 0; const fresh = new SimulatedLease();
    const s = setup(() => ++calls === 1 ? new Promise(() => {}) : Promise.resolve(fresh));
    void s.controller.prepare(input); await flush(); await s.controller.stop();
    await s.controller.recoverPendingAcquisition(); await s.controller.prepare(input);
    expect(s.controller.getSnapshot().phase).toBe('armed');
    expect(s.controller.getSnapshot().resourceWarning).toContain('未取消');
    await vi.advanceTimersByTimeAsync(60);
    expect(s.controller.getSnapshot().phase).toBe('armed'); await s.controller.stop();
  });

  it('旧要求が遅着拒否しても新しい状態をエラーにしない', async () => {
    const old = deferred<AudioLease>(); let calls = 0;
    const s = setup(() => ++calls === 1 ? old.promise : Promise.resolve(new SimulatedLease()));
    void s.controller.prepare(input); await flush(); await s.controller.stop();
    await s.controller.recoverPendingAcquisition(); await s.controller.prepare(input);
    old.reject(new Error('late rejection')); await flush();
    expect(s.controller.getSnapshot().phase).toBe('armed'); await s.controller.stop();
  });

  it('未完了取得を無制限に増やさず、上限時は再読込を案内する', async () => {
    const s = setup(() => new Promise(() => {}));
    for (let i = 0; i < settings.maxDetachedAcquisitions; i++) {
      void s.controller.prepare(input); await flush(); await s.controller.stop(); await s.controller.recoverPendingAcquisition();
      expect(s.controller.getSnapshot().phase).toBe('idle');
    }
    void s.controller.prepare(input); await flush(); await s.controller.stop(); await s.controller.recoverPendingAcquisition();
    expect(s.controller.getSnapshot().resourceWarning).toContain('再読み込み');
    await s.controller.prepare(input);
    expect(s.acquisition).toHaveBeenCalledTimes(settings.maxDetachedAcquisitions + 1);
  });

  it('旧遅着leaseの解放失敗を表示し、停止で明示再試行できる', async () => {
    const old = deferred<AudioLease>(); let calls = 0;
    const s = setup(() => ++calls === 1 ? old.promise : Promise.resolve(new SimulatedLease()));
    void s.controller.prepare(input); await flush(); await s.controller.stop(); await s.controller.recoverPendingAcquisition();
    await s.controller.prepare(input);
    s.release.mockRejectedValueOnce(new Error('late release failed'));
    old.resolve(s.lease); await flush();
    expect(s.controller.getSnapshot().phase).toBe('armed');
    expect(s.controller.getSnapshot().resourceWarning).toContain('旧取得の解放未完了');
    await s.controller.stop(); expect(s.release).toHaveBeenCalledTimes(2);
    expect(s.controller.getSnapshot().resourceWarning).toBe('');
  });
});

describe('AudioLease解放の共有と再試行', () => {
  it('重複PLAYINGとstopが重なっても同じreleaseは同時に1件だけ', async () => {
    const s = setup(undefined, false); await s.controller.prepare(input); s.detect();
    const pending = deferred<void>(); s.release.mockReturnValueOnce(pending.promise);
    const player = s.players[0]!;
    player.emit({ type: 'playing', requestId: player.requestId }); await flush();
    player.emit({ type: 'playing', requestId: player.requestId });
    const stopping = s.controller.stop(); await flush();
    expect(s.release).toHaveBeenCalledTimes(1);
    pending.resolve(); await stopping; await flush();
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'idle', mic: 'off' });
  });

  it('タイムアウト後もrelease本体未完了なら並行再試行せず、完了後に復旧', async () => {
    const s = setup(); await s.controller.prepare(input);
    const pending = deferred<void>(); s.release.mockReturnValueOnce(pending.promise);
    const stopping = s.controller.stop(); await vi.advanceTimersByTimeAsync(30); await stopping;
    const retry = s.controller.stop(); await vi.advanceTimersByTimeAsync(30); await retry;
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'error', mic: 'releasing' });
    pending.resolve(); await flush(); await s.controller.stop();
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'idle', mic: 'off' });
  });

  it('再生中解放の失敗を自動再試行せず表示し、ユーザー停止で再試行', async () => {
    const s = setup(undefined, false); await s.controller.prepare(input); s.detect();
    s.release.mockRejectedValueOnce(new Error('release failed'));
    const player = s.players[0]!; player.emit({ type: 'playing', requestId: player.requestId }); await flush();
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'playing', mic: 'releasing' });
    expect(s.controller.getSnapshot().resourceWarning).toContain('release failed');
    await s.controller.stop(); expect(s.release).toHaveBeenCalledTimes(2);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'idle', mic: 'off' });
  });

  it('解放ゲートは成功済みleaseを再解放せず、同期例外も明示再試行', async () => {
    const gate = new LeaseReleaser(); const lease = new SimulatedLease();
    const release = vi.spyOn(lease, 'release').mockImplementationOnce(() => { throw new Error('sync failure'); });
    await expect(gate.release(lease)).rejects.toThrow('sync failure');
    await expect(gate.release(lease)).rejects.toThrow('sync failure'); expect(release).toHaveBeenCalledTimes(1);
    gate.retryFailed(lease); await gate.release(lease); await gate.release(lease);
    expect(release).toHaveBeenCalledTimes(2);
  });
});
