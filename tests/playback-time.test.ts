import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { formatPlaybackTime, observePlaybackTime } from '../src/ui/playbackTime';
import { PlaybackTime } from '../src/ui/PlaybackTime';
import { App } from '../src/ui/App';
import { createApp } from '../src/app/createApp';
import { SessionController } from '../src/session/controller';
import { SimulatedPlayer, SimulatedLease } from '../src/adapters/simulation';
import { SustainedVolumeDetector } from '../src/domain/detector';
import type { PlaybackObservation } from '../src/session/ports';
import { defaultProfile } from '../src/library/model';

function visibility() {
  const events = new EventTarget();
  return { hidden: false, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    change() { events.dispatchEvent(new Event('visibilitychange')); } };
}
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('詳細な再生時刻表示', () => {
  it.each([[0, '00:00.00'], [83.45, '01:23.45'], [9.1, '00:09.10'], [59.999, '01:00.00'],
    [3599.999, '60:00.00'], [6000, '100:00.00'], [undefined, '--:--.--'], [NaN, '--:--.--'],
    [Infinity, '--:--.--'], [-1, '--:--.--']] as const)('%s秒を%sへ整形', (value, expected) => {
    expect(formatPlaybackTime(value)).toBe(expected);
  });
  it('再生中は50msごとに細かいAPI値をそのまま表示する', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => ({ position: 83.45 + performance.now() / 1000, playing: true, rate: 1 }));
    const publish = vi.fn(); const stop = observePlaybackTime(read, publish, visibility()); await flush();
    expect(publish).toHaveBeenLastCalledWith({ position: 83.45, interpolated: false });
    await vi.advanceTimersByTimeAsync(50); expect(publish).toHaveBeenLastCalledWith({ position: 83.5, interpolated: false });
    await vi.advanceTimersByTimeAsync(950); expect(read).toHaveBeenCalledTimes(21);
    stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it('API値が粗い場合は補間と明示し、250msを超えて推測で進めない', async () => {
    vi.useFakeTimers(); let position = 10;
    const publish = vi.fn(), stop = observePlaybackTime(async () => ({ position, playing: true, rate: 1 }), publish, visibility()); await flush();
    await vi.advanceTimersByTimeAsync(50); expect(publish).toHaveBeenLastCalledWith({ position: 10.05, interpolated: true });
    await vi.advanceTimersByTimeAsync(950); expect(publish).toHaveBeenLastCalledWith({ position: 10.25, interpolated: true });
    position = 11; await vi.advanceTimersByTimeAsync(50); expect(publish).toHaveBeenLastCalledWith({ position: 11, interpolated: false }); stop();
  });
  it('実際の一時停止・バッファリングでは補間せず、停止中のシークにも追従する', async () => {
    vi.useFakeTimers(); const value = { position: 20, playing: true, rate: 1 }; const publish = vi.fn();
    const stop = observePlaybackTime(async () => ({ ...value }), publish, visibility()); await flush();
    value.playing = false; await vi.advanceTimersByTimeAsync(1050);
    expect(publish).toHaveBeenLastCalledWith({ position: 20, interpolated: false });
    value.position = 2.35; await vi.advanceTimersByTimeAsync(250); expect(publish).toHaveBeenLastCalledWith({ position: 2.35, interpolated: false });
    value.position = 80; await vi.advanceTimersByTimeAsync(250); expect(publish).toHaveBeenLastCalledWith({ position: 80, interpolated: false }); stop();
  });
  it('再生中の前後シーク・速度変更・終端を反映する', async () => {
    vi.useFakeTimers(); const value = { position: 20, playing: true, rate: 1, duration: 90 }; const publish = vi.fn();
    const stop = observePlaybackTime(async () => ({ ...value }), publish, visibility()); await flush();
    value.position = 3; await vi.advanceTimersByTimeAsync(50); expect(publish).toHaveBeenLastCalledWith({ position: 3, interpolated: false });
    value.rate = .5; await vi.advanceTimersByTimeAsync(50); await vi.advanceTimersByTimeAsync(50); expect(publish).toHaveBeenLastCalledWith({ position: 3.025, interpolated: true });
    value.position = 89.99; value.rate = 2; await vi.advanceTimersByTimeAsync(50); await vi.advanceTimersByTimeAsync(50); expect(publish).toHaveBeenLastCalledWith({ position: 90, interpolated: true });
    value.playing = false; value.position = 90; await vi.advanceTimersByTimeAsync(500); expect(publish).toHaveBeenLastCalledWith({ position: 90, interpolated: false }); stop();
  });
  it('非表示では更新を止め、復帰時は古い補間を捨て実値を取得する', async () => {
    vi.useFakeTimers(); const page = visibility(), read = vi.fn(async () => ({ position: 10, playing: true, rate: 1 })), publish = vi.fn();
    const stop = observePlaybackTime(read, publish, page); await flush();
    page.hidden = true; page.change(); await vi.advanceTimersByTimeAsync(5000); expect(read).toHaveBeenCalledTimes(1);
    page.hidden = false; page.change(); await flush(); expect(publish).toHaveBeenLastCalledWith({ position: 10, interpolated: false });
    stop(); const calls = read.mock.calls.length; page.change(); await vi.advanceTimersByTimeAsync(1000); expect(read).toHaveBeenCalledTimes(calls); expect(vi.getTimerCount()).toBe(0);
  });
  it('取得失敗・不正値から回復し、古い位置を補間し続けない', async () => {
    vi.useFakeTimers(); const publish = vi.fn();
    const read = vi.fn<() => Promise<PlaybackObservation | undefined>>().mockResolvedValueOnce({ position: 1, playing: true, rate: 1 })
      .mockRejectedValueOnce(new Error('not ready')).mockResolvedValueOnce({ position: NaN, playing: true, rate: 1 })
      .mockResolvedValueOnce({ position: -1, playing: true, rate: 1 }).mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ position: 2, playing: true, rate: NaN }).mockResolvedValue({ position: 12.35, playing: false, rate: 1 });
    const stop = observePlaybackTime(read, publish, visibility()); await flush();
    await vi.advanceTimersByTimeAsync(50); expect(publish).toHaveBeenLastCalledWith({ position: undefined, interpolated: false });
    for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(250); expect(publish).toHaveBeenLastCalledWith({ position: undefined, interpolated: false }); }
    await vi.advanceTimersByTimeAsync(250); expect(publish).toHaveBeenLastCalledWith({ position: 12.35, interpolated: false }); stop();
  });
  it('遅いAPIの重複取得を防ぎ、非表示/破棄後の遅着値を表示しない', async () => {
    vi.useFakeTimers(); let resolve!: (value: PlaybackObservation) => void;
    const read = vi.fn(() => new Promise<PlaybackObservation>(yes => { resolve = yes; })), publish = vi.fn(); const page = visibility();
    const stop = observePlaybackTime(read, publish, page); await vi.advanceTimersByTimeAsync(1000); expect(read).toHaveBeenCalledTimes(1);
    page.hidden = true; page.change(); resolve({ position: 10, playing: true, rate: 1 }); await flush(); expect(publish).not.toHaveBeenCalled();
    page.hidden = false; page.change(); stop(); resolve({ position: 20, playing: true, rate: 1 }); await flush(); expect(publish).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('実controllerの事前再生・再生・一時停止シーク・停止に追従し保存用ガードは維持', async () => {
    vi.useFakeTimers(); const player = new SimulatedPlayer(); const lease = new SimulatedLease();
    const controller = new SessionController({ createPlayer: () => player, audio: { acquire: async () => lease }, createDetector: () => new SustainedVolumeDetector() });
    const input = { ...defaultProfile('M7lc1UVf-VE', 'DAM').input, durationMs: 0 };
    expect(controller.displayPlaybackPosition()).toBeUndefined();
    await controller.prepare(input); player.currentPosition = 12.35;
    expect(controller.getSnapshot().phase).toBe('preplay'); expect(controller.displayPlaybackPosition()).toBe(12.35);
    expect(controller.playbackPosition()).toBeUndefined();
    player.emit({ type: 'playing' }); await flush();
    lease.sample({ rms: .5, timeMs: 100 }); await flush();
    player.emit({ type: 'playing', requestId: player.requestId }); await flush();
    expect(controller.getSnapshot().phase).toBe('playing');
    const publish = vi.fn(); const stop = observePlaybackTime(() => controller.displayPlaybackObservation(), publish, visibility());
    await flush(); player.currentPosition = 83.45; await vi.advanceTimersByTimeAsync(50); expect(publish).toHaveBeenLastCalledWith({ position: 83.45, interpolated: false });
    await controller.pause(); expect(controller.getSnapshot().phase).toBe('paused');
    expect(controller.playbackPosition()).toBeUndefined(); // 今合ってる remains playing-only
    player.seek(20.05); await vi.advanceTimersByTimeAsync(250); expect(publish).toHaveBeenLastCalledWith({ position: 20.05, interpolated: false });
    await controller.stop(); await vi.advanceTimersByTimeAsync(250); expect(publish).toHaveBeenLastCalledWith({ position: undefined, interpolated: false });
    stop();
  });
  it('UI上のphaseより実プレイヤーの停止を優先し、速度取得だけを行う', async () => {
    const player = new SimulatedPlayer(); const lease = new SimulatedLease();
    const controller = new SessionController({ createPlayer: () => player, audio: { acquire: async () => lease }, createDetector: () => new SustainedVolumeDetector() });
    await controller.prepare(defaultProfile('M7lc1UVf-VE', 'DAM').input);
    Object.assign(player, { playbackRate: () => .5 }); player.currentPosition = 23.45; player.playbackState = 'paused';
    const play = vi.spyOn(player, 'play'), seek = vi.spyOn(player, 'seek'), pause = vi.spyOn(player, 'pause');
    expect(await controller.displayPlaybackObservation()).toEqual({ position: 23.45, playing: false, rate: .5, duration: 240 });
    expect(play).not.toHaveBeenCalled(); expect(seek).not.toHaveBeenCalled(); expect(pause).not.toHaveBeenCalled();
    await controller.stop(); expect(await controller.displayPlaybackObservation()).toBeUndefined();
  });
  it('停止後に遅着した実状態の読取りを表示用に転用しない', async () => {
    const player = new SimulatedPlayer();
    const controller = new SessionController({ createPlayer: () => player, audio: { acquire: async () => new SimulatedLease() }, createDetector: () => new SustainedVolumeDetector() });
    await controller.prepare(defaultProfile('M7lc1UVf-VE', 'DAM').input);
    let resolve!: (state: 'playing') => void;
    vi.spyOn(player, 'readPlaybackState').mockImplementationOnce(() => new Promise(yes => { resolve = yes; }));
    const pending = controller.displayPlaybackObservation(); await controller.stop(); resolve('playing');
    expect(await pending).toBeUndefined();
  });
  it('動画直下に表示し、測定精度の注記と既存保存ボタンを維持する', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    const services = createApp('simulation');
    const html = renderToStaticMarkup(createElement(App, services));
    expect(html.indexOf('id="youtube-host"')).toBeLessThan(html.indexOf('aria-label="YouTube現在再生時刻"'));
    expect(html.indexOf('class="session-card"')).toBeLessThan(html.indexOf('id="youtube-host"'));
    expect(html).toContain('測定精度・実際の発音時刻を保証しません');
    expect(html.match(/今合ってる（現在位置を保存）/g)).toHaveLength(1);
    expect(html).toContain('この音検知設定をすべての曲に適用');
    const display = renderToStaticMarkup(createElement(PlaybackTime, { controller: services.controller, phase: 'idle' }));
    expect(display).toContain('--:--.--'); expect(display).toContain('aria-live="off"');
  });
});
