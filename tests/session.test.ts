import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedLease, SimulatedPlayer } from '../src/adapters/simulation';
import { sessionOptions } from '../src/config/settings';
import { DiagnosticLog } from '../src/diagnostics/log';
import { SustainedVolumeDetector } from '../src/domain/detector';
import { adjustPosition, startPosition, validateInput, type SyncInput } from '../src/domain/sync';
import { SessionController } from '../src/session/controller';
import type { AudioLease, Player } from '../src/session/ports';
import { initialState, sessionReducer } from '../src/session/state';

const input: SyncInput = { videoId: 'dQw4w9WgXcQ', service: 'DAM', savedPositionSec: 10, offsetSec: 0.05, threshold: 0.08, durationMs: 0 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

function setup(overrides: { acquire?: () => Promise<AudioLease>; player?: SimulatedPlayer; retainMic?: boolean } = {}) {
  const player = overrides.player ?? new SimulatedPlayer();
  const lease = new SimulatedLease();
  const play = vi.spyOn(player, 'play');
  const pause = vi.spyOn(player, 'pause');
  const dispose = vi.spyOn(player, 'dispose');
  const release = vi.spyOn(lease, 'release');
  const acquire = vi.fn(overrides.acquire ?? (async () => lease));
  const controller = new SessionController({ createPlayer: () => player, audio: { acquire }, createDetector: () => new SustainedVolumeDetector() }, new DiagnosticLog(() => Date.now()), {
    ...sessionOptions, acquireTimeoutMs: 60, prepareTimeoutMs: 50, armedTimeoutMs: 100,
    playingTimeoutMs: 40, cleanupTimeoutMs: 30, retainMic: overrides.retainMic ?? true,
  });
  const detect = () => lease.sample({ rms: 0.5, timeMs: 0 });
  const playing = () => player.emit({ type: 'playing', requestId: player.requestId });
  return { controller, player, lease, play, pause, dispose, release, acquire, detect, playing };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('session safety', () => {
  it('起動・準備・待機ではplayしない。cueとマイクの両方を待つ', async () => {
    const ready = deferred<void>();
    const s = setup();
    vi.spyOn(s.player, 'prepare').mockReturnValue(ready.promise);
    const preparation = s.controller.prepare(input);
    await flush();
    expect(s.controller.getSnapshot().phase).toBe('preparing');
    s.detect();
    expect(s.play).not.toHaveBeenCalled();
    ready.resolve(); await preparation;
    expect(s.controller.getSnapshot().phase).toBe('armed');
    expect(s.play).not.toHaveBeenCalled();
    await s.controller.stop();
  });

  it('検知は1回だけplayし、PLAYINGまで再生中としない', async () => {
    const s = setup(); await s.controller.prepare(input);
    s.detect(); s.detect();
    expect(s.play).toHaveBeenCalledTimes(1);
    expect(s.controller.getSnapshot().phase).toBe('starting');
    s.playing();
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'playing', mic: 'retained' });
    expect(s.release).not.toHaveBeenCalled();
    await s.controller.stop();
  });

  it('準備連打で取得・セッションを重複しない', async () => {
    const pending = deferred<AudioLease>();
    const s = setup({ acquire: () => pending.promise });
    const first = s.controller.prepare(input);
    await s.controller.prepare(input);
    expect(s.acquire).toHaveBeenCalledTimes(1);
    pending.resolve(s.lease); await first; await s.controller.stop();
  });

  it('停止後の遅着マイクを解放し、検知もplayもしない', async () => {
    const pending = deferred<AudioLease>(); const s = setup({ acquire: () => pending.promise });
    const preparing = s.controller.prepare(input);
    await s.controller.stop();
    expect(s.controller.getSnapshot().phase).toBe('stopping');
    await s.controller.prepare(input);
    expect(s.acquire).toHaveBeenCalledTimes(1);
    pending.resolve(s.lease); await preparing; await flush();
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'idle', mic: 'off' });
    s.detect(); expect(s.play).not.toHaveBeenCalled();
  });

  it('play直後pauseは遅着PLAYINGを抑止し、resumeはcueも再検知もしない', async () => {
    const s = setup(); const prepare = vi.spyOn(s.player, 'prepare');
    await s.controller.prepare(input); s.detect();
    const oldRequest = s.player.requestId;
    await s.controller.pause();
    s.player.emit({ type: 'playing', requestId: oldRequest }); await flush();
    expect(s.controller.getSnapshot().phase).toBe('paused');
    expect(s.pause.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(s.release).not.toHaveBeenCalled();
    s.controller.resume(); s.playing();
    expect(s.controller.getSnapshot().phase).toBe('playing');
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(s.play).toHaveBeenCalledTimes(2);
    s.detect(); expect(s.play).toHaveBeenCalledTimes(2);
    await s.controller.stop();
  });

  it('pause確認前のresumeを拒否する', async () => {
    const s = setup(); await s.controller.prepare(input); s.detect();
    const pending = deferred<void>(); s.pause.mockReturnValueOnce(pending.promise);
    const pausing = s.controller.pause(); s.controller.resume();
    expect(s.play).toHaveBeenCalledTimes(1);
    pending.resolve(); await pausing;
    s.controller.resume(); expect(s.play).toHaveBeenCalledTimes(2);
    await s.controller.stop();
  });

  it('自然終了でマイクを解放し、自動再待機しない', async () => {
    const s = setup(); await s.controller.prepare(input); s.detect(); s.playing();
    s.player.emit({ type: 'ended', requestId: s.player.requestId }); await flush();
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'ended', mic: 'off' });
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.dispose).toHaveBeenCalledTimes(1);
    s.detect(); expect(s.play).toHaveBeenCalledTimes(1);
  });

  it('許可拒否でplayerと資源を片付けエラーにする', async () => {
    const s = setup({ acquire: async () => { throw new Error('NotAllowedError'); } });
    await s.controller.prepare(input);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'error', mic: 'off' });
    expect(s.dispose).toHaveBeenCalledTimes(1);
    expect(s.play).not.toHaveBeenCalled();
  });

  it('動画準備失敗時も取得済みマイクを解放する', async () => {
    const s = setup(); vi.spyOn(s.player, 'prepare').mockRejectedValue(new Error('cue failure'));
    await s.controller.prepare(input);
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.controller.getSnapshot().phase).toBe('error');
  });

  it('検知待機期限で解放し自動再開しない', async () => {
    const s = setup(); await s.controller.prepare(input);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'idle', mic: 'off', message: '検知待機期限超過' });
    expect(s.release).toHaveBeenCalledTimes(1);
    s.detect(); expect(s.play).not.toHaveBeenCalled();
  });

  it('マイク取得期限超過の後でも遅着資源を解放する', async () => {
    const pending = deferred<AudioLease>(); const s = setup({ acquire: () => pending.promise });
    const preparing = s.controller.prepare(input);
    await vi.advanceTimersByTimeAsync(60); await preparing;
    expect(s.controller.getSnapshot().phase).toBe('stopping');
    pending.resolve(s.lease); await flush();
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'error', mic: 'off', message: 'マイク取得期限超過' });
  });

  it('PLAYING期限超過で停止と解放を行う', async () => {
    const s = setup(); await s.controller.prepare(input); s.detect();
    await vi.advanceTimersByTimeAsync(40);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'error', mic: 'off', message: '再生開始確認期限超過' });
    expect(s.release).toHaveBeenCalledTimes(1);
  });

  it('ブロックは再生成功とせず、自動再試行しない', async () => {
    const s = setup(); await s.controller.prepare(input); s.detect();
    s.player.emit({ type: 'blocked', requestId: s.player.requestId, message: 'gesture required' }); await flush();
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'error', mic: 'off' });
    expect(s.play).toHaveBeenCalledTimes(1);
  });

  it('解放失敗を隠さず、すべて停止で再試行できる', async () => {
    const s = setup(); await s.controller.prepare(input);
    s.release.mockRejectedValueOnce(new Error('release failure'));
    await s.controller.stop();
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'error', mic: 'releasing' });
    await s.controller.stop();
    expect(s.release).toHaveBeenCalledTimes(2);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'idle', mic: 'off' });
  });

  it('player解放失敗でもマイク解放を試す', async () => {
    const s = setup(); await s.controller.prepare(input);
    s.dispose.mockRejectedValueOnce(new Error('dispose failure'));
    await s.controller.stop();
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.controller.getSnapshot().phase).toBe('error');
    await s.controller.stop(); expect(s.controller.getSnapshot().phase).toBe('idle');
  });

  it('マイク解放方針を検知終了と独立に差替えられる', async () => {
    const s = setup({ retainMic: false }); await s.controller.prepare(input); s.detect(); s.playing(); await flush();
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'playing', mic: 'off' });
    expect(s.release).toHaveBeenCalledTimes(1);
    s.detect(); expect(s.play).toHaveBeenCalledTimes(1); await s.controller.stop();
  });

  it('すべて停止は冪等で、検知後の残存イベントも再生しない', async () => {
    const s = setup(); await s.controller.prepare(input); await s.controller.stop(); await s.controller.stop();
    expect(s.release).toHaveBeenCalledTimes(1); expect(s.dispose).toHaveBeenCalledTimes(1);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'idle', mic: 'off' });
  });

  it('旧セッションのENDEDは新セッションのマイクを解放しない', async () => {
    let oldListener: Parameters<Player['subscribe']>[0] | undefined;
    const old = new SimulatedPlayer();
    const subscribe = old.subscribe.bind(old);
    vi.spyOn(old, 'subscribe').mockImplementation(listener => { oldListener = listener; return subscribe(listener); });
    const second = new SimulatedPlayer(); const leases = [new SimulatedLease(), new SimulatedLease()];
    let index = 0;
    const controller = new SessionController({ createPlayer: () => index === 0 ? old : second, audio: { acquire: async () => leases[index++]! }, createDetector: () => new SustainedVolumeDetector() });
    await controller.prepare(input); await controller.stop(); await controller.prepare(input);
    oldListener?.({ type: 'ended', requestId: 1 }); await flush();
    expect(controller.getSnapshot().phase).toBe('armed'); expect(leases[1]!.released).toBe(false);
    await controller.stop();
  });

  it('不正入力ではマイクを取得しない', async () => {
    const s = setup(); await s.controller.prepare({ ...input, durationMs: -1 });
    expect(s.acquire).not.toHaveBeenCalled(); expect(s.controller.getSnapshot().phase).toBe('error');
  });

  it('マイク取得の同期例外でも取得中のまま残らない', async () => {
    const s = setup({ acquire: () => { throw new Error('同期的な入力API失敗'); } });
    await s.controller.prepare(input);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'error', mic: 'off' });
    expect(s.dispose).toHaveBeenCalledTimes(1);
  });

  it('停止後に動画準備が完了しても待機状態に戻らない', async () => {
    const ready = deferred<void>(); const s = setup();
    vi.spyOn(s.player, 'prepare').mockReturnValue(ready.promise);
    const preparing = s.controller.prepare(input); await flush();
    await s.controller.stop(); ready.resolve(); await preparing;
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'idle', mic: 'off' });
    s.detect(); expect(s.play).not.toHaveBeenCalled();
  });

  it('動画準備の期限超過でマイクを解放する', async () => {
    const s = setup(); vi.spyOn(s.player, 'prepare').mockReturnValue(new Promise(() => {}));
    const preparing = s.controller.prepare(input);
    await vi.advanceTimersByTimeAsync(50); await preparing;
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'error', mic: 'off', message: '動画準備期限超過' });
    expect(s.release).toHaveBeenCalledTimes(1);
  });

  it('自然終了イベントが重複しても解放は1回', async () => {
    const s = setup(); await s.controller.prepare(input); s.detect(); s.playing();
    const event = { type: 'ended' as const, requestId: s.player.requestId };
    s.player.emit(event); s.player.emit(event); await flush();
    expect(s.controller.getSnapshot().phase).toBe('ended');
    expect(s.release).toHaveBeenCalledTimes(1);
  });

  it('マイク解放が完了しない場合も期限で未完了を報告する', async () => {
    const s = setup(); await s.controller.prepare(input);
    const pending = deferred<void>(); s.release.mockReturnValueOnce(pending.promise);
    const stopping = s.controller.stop(); await vi.advanceTimersByTimeAsync(30); await stopping;
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'error', mic: 'releasing' });
    expect(s.controller.getSnapshot().message).toContain('解放未完了');
    pending.resolve(); await s.controller.stop();
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'idle', mic: 'off' });
  });

  it('購読直後に音が来ても待機期限で再生を中断しない', async () => {
    const s = setup();
    vi.spyOn(s.lease, 'subscribe').mockImplementation(listener => { listener({ rms: 0.5, timeMs: 0 }); return () => {}; });
    await s.controller.prepare(input); s.playing();
    await vi.advanceTimersByTimeAsync(100);
    expect(s.controller.getSnapshot().phase).toBe('playing');
    expect(s.play).toHaveBeenCalledTimes(1); await s.controller.stop();
  });
});

describe('domain and diagnostics', () => {
  it('50msの繰返し調整で誤差を蓄積せず、開始は0を下限とする', () => {
    let value = 0; for (let i = 0; i < 100; i++) value = adjustPosition(value, 1);
    expect(value).toBe(5); expect(startPosition({ ...input, savedPositionSec: 0, offsetSec: -0.05 })).toBe(0);
  });
  it.each([NaN, Infinity, -1])('不正開始位置 %s を拒否', value => {
    expect(() => validateInput({ ...input, savedPositionSec: value })).toThrow();
  });
  it('継続時間0msは1観測で成立し1回で終了', () => {
    const detector = new SustainedVolumeDetector(); const callback = vi.fn();
    detector.arm({ threshold: 0, durationMs: 0 }, callback);
    detector.sample({ rms: 0, timeMs: 0 }); expect(callback).toHaveBeenCalledTimes(1);
    detector.sample({ rms: 0.1, timeMs: 1 }); detector.sample({ rms: 0.2, timeMs: 2 });
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it('連続時間は境界で成立し、無音と観測欠落でリセット', () => {
    const detector = new SustainedVolumeDetector(); const callback = vi.fn();
    detector.arm({ threshold: 0.08, durationMs: 50 }, callback);
    for (const sample of [{ rms: 0.2, timeMs: 0 }, { rms: 0.2, timeMs: 49 }, { rms: 0.079, timeMs: 50 }, { rms: 0.2, timeMs: 60 }, { rms: 0.2, timeMs: 200 }, { rms: 0.2, timeMs: 249 }]) detector.sample(sample);
    expect(callback).not.toHaveBeenCalled(); detector.sample({ rms: 0.2, timeMs: 250 }); expect(callback).toHaveBeenCalledTimes(1);
  });
  it('旧世代の状態イベントを破棄する', () => {
    const newer = { ...initialState, generation: 2 };
    expect(sessionReducer(newer, { type: 'update', generation: 1, patch: { phase: 'playing' } })).toBe(newer);
  });
  it('診断ログは時刻・世代を持ち、上限で古い順に破棄する', () => {
    const log = new DiagnosticLog(() => 123, 2, 10_000);
    log.add(1, 'first'); log.add(2, 'second'); log.add(3, 'third');
    expect(log.snapshot().map(entry => entry.event)).toEqual(['second', 'third']);
    expect(log.snapshot()[1]).toMatchObject({ generation: 3, timeMs: 123 }); expect(log.dropped).toBe(1);
    const tiny = new DiagnosticLog(() => 0, 100, 1); tiny.add(1, 'large');
    expect(tiny.snapshot()).toEqual([]); expect(tiny.dropped).toBe(1);
  });
});
