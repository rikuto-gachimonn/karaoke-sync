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
  it('500ms周期で実値を読み、一時停止中も推測で時刻を進めずシークへ追従する', () => {
    vi.useFakeTimers(); let position = 83.45;
    const read = vi.fn(() => position), publish = vi.fn();
    const stop = observePlaybackTime(read, publish, visibility());
    expect(publish).toHaveBeenLastCalledWith(83.45);
    position = 84.12; vi.advanceTimersByTime(499); expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); expect(publish).toHaveBeenLastCalledWith(84.12);
    vi.advanceTimersByTime(1000); expect(publish).toHaveBeenLastCalledWith(84.12);
    position = 20.05; vi.advanceTimersByTime(500); expect(publish).toHaveBeenLastCalledWith(20.05);
    stop(); const calls = read.mock.calls.length; vi.advanceTimersByTime(2000);
    expect(read).toHaveBeenCalledTimes(calls); expect(vi.getTimerCount()).toBe(0);
  });
  it('バックグラウンドでは読取りを止め、復帰時に直ちに再取得し購読も解除する', () => {
    vi.useFakeTimers(); const page = visibility(), read = vi.fn(() => 10), publish = vi.fn();
    const stop = observePlaybackTime(read, publish, page);
    page.hidden = true; page.change(); vi.advanceTimersByTime(5000); expect(read).toHaveBeenCalledTimes(1);
    page.hidden = false; page.change(); expect(read).toHaveBeenCalledTimes(2);
    stop(); page.change(); expect(read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('取得失敗・無効値は古い時刻を表示せず、次回の正常取得で回復する', () => {
    vi.useFakeTimers(); const publish = vi.fn();
    const read = vi.fn<() => number | undefined>().mockReturnValueOnce(1).mockImplementationOnce(() => { throw new Error('not ready'); })
      .mockReturnValueOnce(NaN).mockReturnValueOnce(-1).mockReturnValueOnce(undefined).mockReturnValue(12.35);
    const stop = observePlaybackTime(read, publish, visibility());
    for (let i = 0; i < 4; i++) { vi.advanceTimersByTime(500); expect(publish).toHaveBeenLastCalledWith(undefined); }
    vi.advanceTimersByTime(500); expect(publish).toHaveBeenLastCalledWith(12.35); stop();
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
    const publish = vi.fn(); const stop = observePlaybackTime(() => controller.displayPlaybackPosition(), publish, visibility());
    player.currentPosition = 83.45; vi.advanceTimersByTime(500); expect(publish).toHaveBeenLastCalledWith(83.45);
    await controller.pause(); expect(controller.getSnapshot().phase).toBe('paused');
    expect(controller.playbackPosition()).toBeUndefined(); // 今合ってる remains playing-only
    player.seek(20.05); vi.advanceTimersByTime(500); expect(publish).toHaveBeenLastCalledWith(20.05);
    await controller.stop(); vi.advanceTimersByTime(500); expect(publish).toHaveBeenLastCalledWith(undefined);
    stop();
  });
  it('動画直下に表示し、測定精度の注記と既存保存ボタンを維持する', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    const services = createApp('simulation');
    const html = renderToStaticMarkup(createElement(App, services));
    expect(html.indexOf('id="youtube-host"')).toBeLessThan(html.indexOf('aria-label="YouTube現在再生時刻"'));
    expect(html.indexOf('aria-label="YouTube現在再生時刻"')).toBeLessThan(html.indexOf('class="session-card"'));
    expect(html).toContain('測定精度・実際の発音時刻を保証しません');
    expect(html.match(/今合ってる（現在位置を保存）/g)).toHaveLength(1);
    expect(html).toContain('音検知設定を全曲に適用');
    const display = renderToStaticMarkup(createElement(PlaybackTime, { controller: services.controller, phase: 'idle' }));
    expect(display).toContain('--:--.--'); expect(display).toContain('aria-live="off"');
  });
});
