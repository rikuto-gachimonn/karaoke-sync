import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { SessionController } from '../src/session/controller';
import { SimulatedPlayer, SimulatedLease } from '../src/adapters/simulation';
import { SustainedVolumeDetector } from '../src/domain/detector';
import { DiagnosticLog } from '../src/diagnostics/log';
import { sessionOptions } from '../src/config/settings';
import type { SyncInput } from '../src/domain/sync';
import type { AudioLease } from '../src/session/ports';
import { loadSyncProfile, saveSyncProfile, preferencesKey } from '../src/app/preferences';

const input: SyncInput = { videoId: 'M7lc1UVf-VE', service: 'DAM', savedPositionSec: 10, offsetSec: 0,
  threshold: 0.08, durationMs: 0, playbackMode: 'preplay', compensation: { mode: 'baseline', waitMs: 0, offsetMs: 0 }, armedTimeoutMs: 1000 };
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
function setup(retainMic = true) {
  const player = new SimulatedPlayer(); const lease = new SimulatedLease();
  const acquire = vi.fn(async (_signal?: AbortSignal): Promise<AudioLease> => lease);
  const seek = vi.spyOn(player, 'seek'); const play = vi.spyOn(player, 'play'); const pause = vi.spyOn(player, 'pause');
  const release = vi.spyOn(lease, 'release'); const dispose = vi.spyOn(player, 'dispose');
  const controller = new SessionController({ createPlayer: () => player, audio: { acquire }, createDetector: () => new SustainedVolumeDetector() }, new DiagnosticLog(() => Date.now()), { ...sessionOptions, retainMic });
  const start = async (value = input) => { await controller.prepare(value); player.emit({ type: 'playing' }); await flush(); };
  return { controller, player, lease, acquire, seek, play, pause, release, dispose, start,
    detect: () => lease.sample({ rms: 0.5, timeMs: 100 }) };
}

describe('通常アプリの事前再生方式', () => {
  it('事前手動再生まではマイクを取得せず、自動一時停止確認後だけ検知を開始する', async () => {
    const s = setup(); await s.controller.prepare(input);
    expect(s.controller.getSnapshot().phase).toBe('preplay'); expect(s.acquire).not.toHaveBeenCalled();
    expect(s.play).not.toHaveBeenCalled(); s.player.emit({ type: 'playing' }); s.player.emit({ type: 'playing' }); await flush();
    expect(s.pause).toHaveBeenCalledTimes(1); expect(s.acquire).toHaveBeenCalledTimes(1);
    expect(s.controller.getSnapshot()).toMatchObject({ phase: 'armed', mic: 'running' }); expect(s.play).not.toHaveBeenCalled();
    const events = s.controller.log.snapshot().map(e => e.event);
    expect(events.indexOf('preplay.paused')).toBeLessThan(events.indexOf('mic.acquire')); await s.controller.stop();
  });
  it('偽のPLAYINGでは事前再生成功とせず、PAUSED未確認でもマイクを開始しない', async () => {
    const s = setup(); await s.controller.prepare(input);
    vi.spyOn(s.player, 'readPlaybackState').mockResolvedValueOnce('paused'); s.player.emit({ type: 'playing' }); await flush();
    expect(s.controller.getSnapshot().phase).toBe('preplay'); expect(s.acquire).not.toHaveBeenCalled();
    s.pause.mockImplementation(async () => {}); s.player.emit({ type: 'playing' }); await flush();
    expect(s.acquire).not.toHaveBeenCalled(); expect(s.controller.getSnapshot().phase).toBe('error');
  });
  it.each([
    ['baseline', 0, 10], ['wait', 100, 10], ['position', 0, 9.95], ['combined', 100, 9.95],
  ] as const)('%s方式で検知1回にseekとplayを1回のみ要求する', async (mode, waitMs, target) => {
    const s = setup(); await s.start({ ...input, compensation: { mode, waitMs: 100, offsetMs: -50 } });
    s.detect(); s.detect();
    if (waitMs) { await vi.advanceTimersByTimeAsync(99); expect(s.play).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1); }
    await flush(); expect(s.seek).toHaveBeenCalledExactlyOnceWith(target); expect(s.play).toHaveBeenCalledTimes(1);
    expect(s.controller.getSnapshot().phase).toBe('starting'); s.player.emit({ type: 'buffering' });
    expect(s.controller.getSnapshot().phase).toBe('buffering'); s.player.emit({ type: 'playing' }); await flush();
    expect(s.controller.getSnapshot().phase).toBe('playing'); await s.controller.stop();
  });
  it.each([[0, -500, 0], [239, 2000, 240], [240, 0, 240]])('開始%s秒＋%smsを%s秒へ制限する', async (savedPositionSec, offsetMs, target) => {
    const s = setup(); await s.start({ ...input, savedPositionSec, compensation: { mode: 'position', waitMs: 0, offsetMs } });
    s.detect(); await flush(); if(savedPositionSec*1000+offsetMs<0){expect(s.seek).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(-(savedPositionSec*1000+offsetMs));} expect(s.seek).toHaveBeenCalledWith(target); await s.controller.stop();
  });
  it.each(['stop', 'pause', 'error'])('補正待機中の%sは遅延要求を取り消す', async action => {
    const s = setup(); await s.start({ ...input, compensation: { mode: 'wait', waitMs: 100, offsetMs: 0 } }); s.detect();
    if (action === 'stop') await s.controller.stop();
    if (action === 'pause') await s.controller.pause();
    if (action === 'error') s.player.emit({ type: 'error', message: 'failed' });
    await vi.advanceTimersByTimeAsync(200); expect(s.play).not.toHaveBeenCalled(); expect(s.seek).not.toHaveBeenCalled(); await s.controller.stop();
  });
  it('検知後の再開は続きからで、再シーク・再検知・再取得しない', async () => {
    const s = setup(); await s.start(); s.detect(); await flush(); s.player.emit({ type: 'playing' }); await flush();
    await s.controller.pause(); s.controller.resume(); s.player.emit({ type: 'playing' }); await flush();
    expect(s.play).toHaveBeenCalledTimes(2); expect(s.seek).toHaveBeenCalledTimes(1); expect(s.acquire).toHaveBeenCalledTimes(1); await s.controller.stop();
  });
  it('開始要求直後の遅着PAUSEDは要求を取り消さず、PLAYINGを待つ', async () => {
    const s = setup(); await s.start(); s.detect(); await flush(); s.player.emit({ type: 'paused' }); await flush();
    expect(s.controller.getSnapshot().phase).toBe('starting'); s.player.emit({ type: 'playing' }); await flush();
    expect(s.controller.getSnapshot().phase).toBe('playing'); await s.controller.stop();
  });
  it('停止が事前再生の状態確認を跨いだらマイクを起動しない', async () => {
    const s = setup(); await s.controller.prepare(input);
    let resolve!: (value: 'playing') => void;
    vi.spyOn(s.player, 'readPlaybackState').mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
    s.player.emit({ type: 'playing' }); await s.controller.stop(); resolve('playing'); await flush();
    expect(s.acquire).not.toHaveBeenCalled(); expect(s.play).not.toHaveBeenCalled(); expect(s.dispose).toHaveBeenCalledTimes(1);
  });
  it('停止後に取得されたマイクも解放し検知を開始しない', async () => {
    const s = setup(); let resolve!: (value: AudioLease) => void;
    s.acquire.mockReturnValueOnce(new Promise(yes => { resolve = yes; })); await s.start();
    expect(s.controller.getSnapshot().phase).toBe('preparing'); await s.controller.stop(); resolve(s.lease); await flush();
    expect(s.release).toHaveBeenCalledTimes(1); expect(s.controller.getSnapshot().phase).toBe('idle'); expect(s.play).not.toHaveBeenCalled();
  });
  it.each([true, false])('マイク保持%sでも終了時は一度だけ解放する', async retain => {
    const s = setup(retain); await s.start(); s.detect(); await flush();
    expect(s.release).toHaveBeenCalledTimes(retain ? 0 : 1); s.player.emit({ type: 'playing' }); await flush();
    s.player.emit({ type: 'ended' }); await flush(); expect(s.release).toHaveBeenCalledTimes(1); expect(s.controller.getSnapshot().phase).toBe('ended');
  });
  it('ブロック時は再準備を案内しマイクとプレイヤーを解放する', async () => {
    const s = setup(); await s.start(); s.detect(); await flush(); s.player.emit({ type: 'blocked', message: 'autoplay' }); await flush();
    expect(s.controller.getSnapshot().message).toContain('事前再生方式'); expect(s.release).toHaveBeenCalledTimes(1); expect(s.dispose).toHaveBeenCalledTimes(1);
  });
  it('動画長不明時は再生成功にせず資源を解放する', async () => {
    const s = setup(); s.player.videoDuration = 0; await s.start(); s.detect(); await flush();
    expect(s.play).not.toHaveBeenCalled(); expect(s.controller.getSnapshot().phase).toBe('error'); expect(s.release).toHaveBeenCalledTimes(1);
  });
  it('入力変更を実行中のスナップショットへ混ぜない', async () => {
    const value = { ...input, compensation: { mode: 'combined' as const, waitMs: 100, offsetMs: 50 } };
    const s = setup(); await s.start(value); value.compensation.offsetMs = 1000; value.videoId = 'dQw4w9WgXcQ';
    s.detect(); await vi.advanceTimersByTimeAsync(100); expect(s.seek).toHaveBeenCalledWith(10.05); await s.controller.stop();
  });
  it('検知待機期限を維持し期限超過で終了する', async () => {
    const s = setup(); await s.start(); await vi.advanceTimersByTimeAsync(1000);
    expect(s.controller.getSnapshot().phase).toBe('idle'); expect(s.release).toHaveBeenCalledTimes(1); expect(s.play).not.toHaveBeenCalled();
  });
});

describe('新アプリ専用の同期設定保存', () => {
  function storage() {
    const data = new Map<string, string>([['old-karaokesync-data', 'unchanged']]);
    return { data, getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { data.set(key, value); }) };
  }
  it('動画・DAM/JOYSOUNDごとに補正と方式を独立保存し旧キーに触れない', () => {
    const s = storage(); saveSyncProfile(s, { input, retainMic: true });
    saveSyncProfile(s, { input: { ...input, service: 'JOYSOUND', compensation: { mode: 'combined', waitMs: 100, offsetMs: -50 } }, retainMic: false });
    expect(loadSyncProfile(s, input.videoId, 'DAM')).toEqual({ input, retainMic: true });
    expect(loadSyncProfile(s, input.videoId, 'JOYSOUND')).toMatchObject({ input: { compensation: { offsetMs: -50 } }, retainMic: false });
    expect(loadSyncProfile(s, 'dQw4w9WgXcQ', 'DAM')).toBeUndefined(); expect(s.data.get('old-karaokesync-data')).toBe('unchanged');
    expect(s.getItem.mock.calls.every(([key]) => key === preferencesKey)).toBe(true);
    expect(s.setItem.mock.calls.every(([key]) => key === preferencesKey)).toBe(true);
  });
  it('不正入力・破損保存・容量不足を成功扱いしない', () => {
    const s = storage(); expect(() => saveSyncProfile(s, { input: { ...input, durationMs: -1 }, retainMic: true })).toThrow(); expect(s.setItem).not.toHaveBeenCalled();
    s.data.set(preferencesKey, 'invalid-json'); expect(() => saveSyncProfile(s, { input, retainMic: true })).toThrow(); expect(s.setItem).not.toHaveBeenCalled();
    s.data.delete(preferencesKey); s.setItem.mockImplementationOnce(() => { throw new Error('quota'); });
    expect(() => saveSyncProfile(s, { input, retainMic: true })).toThrow('quota');
  });
});

describe('通常事前再生の追加競合とPC互換', () => {
  it('従来方式の基準は動画長未取得でも既存どおり再生要求する', async () => {
    const s = setup(); s.player.videoDuration = 0; await s.controller.prepare({ ...input, playbackMode: 'legacy' });
    expect(s.controller.getSnapshot().phase).toBe('armed'); s.detect(); expect(s.play).toHaveBeenCalledTimes(1);
    expect(s.seek).not.toHaveBeenCalled(); await s.controller.stop();
  });
  it('BUFFERING中の遅着PAUSEDでも初回PLAYING確認を待つ', async () => {
    const s = setup(); await s.start(); s.detect(); await flush(); s.player.emit({ type: 'buffering' }); s.player.emit({ type: 'paused' }); await flush();
    expect(s.controller.getSnapshot().phase).toBe('buffering'); s.player.emit({ type: 'playing' }); await flush();
    expect(s.controller.getSnapshot().phase).toBe('playing'); await s.controller.stop();
  });
  it('検知待機中の古いPLAYINGは実状態pausedなら再生せず待機を維持する', async () => {
    const s = setup(); await s.start(); vi.spyOn(s.player, 'readPlaybackState').mockResolvedValueOnce('paused');
    s.player.emit({ type: 'playing' }); await flush(); expect(s.controller.getSnapshot().phase).toBe('armed'); expect(s.play).not.toHaveBeenCalled(); await s.controller.stop();
  });
  it('補正待機中の本当の想定外再生は停止し遅延要求を実行しない', async () => {
    const s = setup(); await s.start({ ...input, compensation: { mode: 'wait', waitMs: 100, offsetMs: 0 } }); s.detect(); s.player.emit({ type: 'playing' });
    await flush(); await vi.advanceTimersByTimeAsync(100); expect(s.play).not.toHaveBeenCalled(); expect(s.release).toHaveBeenCalledTimes(1); expect(s.controller.getSnapshot().phase).toBe('error');
  });
  it('検知直後のpauseと停止を跨ぐ状態確認を新要求に転用しない', async () => {
    const s = setup(); await s.start(); let resolve!: (value: 'paused') => void;
    vi.spyOn(s.player, 'readPlaybackState').mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
    s.detect(); await s.controller.pause(); resolve('paused'); await flush();
    expect(s.seek).not.toHaveBeenCalled(); expect(s.play).not.toHaveBeenCalled(); await s.controller.stop();
  });
});
