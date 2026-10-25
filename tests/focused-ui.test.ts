import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../src/ui/App';
import { createApp } from '../src/app/createApp';
import { initialState, type Phase } from '../src/session/state';
import { openPanel } from '../src/ui/navigation';
import { defaultDetectionProfile, withDetectionProfile } from '../src/app/detectionModes';
import { saveSyncProfile } from '../src/app/preferences';
function render(phase: Phase = 'idle') {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  const app = createApp('simulation');
  vi.spyOn(app.controller, 'getSnapshot').mockReturnValue({ ...initialState, phase, canPrepare: phase === 'idle' });
  return renderToStaticMarkup(createElement(App, app));
}
afterEach(() => vi.unstubAllGlobals());
describe('カラオケ中の表示と停止導線', () => {
  it('音量メーターと動画の間に操作ボタンを置かない', () => {
    const html = render(); const meter = html.indexOf('aria-label="マイク音量メーター"'); const video = html.indexOf('class="player-card"');
    expect(html.indexOf('class="session-actions"')).toBeLessThan(meter);
    expect(html.slice(meter, video)).not.toContain('<button');
    expect(html.match(/id="youtube-host"/g)).toHaveLength(1);
  });
  it.each(['playing', 'paused', 'buffering', 'starting'] as const)('%sでは開始前入力をDOMに残して隠し、停止を時刻の右側に表示', phase => {
    const html = render(phase);
    expect(html).toMatch(/<button[^>]*class="primary prepare"[^>]*hidden/);
    for (const id of ['audio-settings', 'correction-panel', 'settings-panel', 'developer-settings']) expect(html.match(new RegExp(`<details[^>]*id="${id}"[^>]*>`))?.[0]).toContain('hidden');
    const row = html.slice(html.indexOf('class="playback-time-main"'), html.indexOf('class="tool-links"'));
    expect(row).toContain('すべてを停止'); expect(row.indexOf('YouTube現在再生時刻')).toBeLessThan(row.indexOf('すべてを停止'));
    expect(html).toContain('今合ってる（現在位置を保存）'); expect(html).toContain('開始位置を50ms戻す');
  });
  it.each(['idle', 'preparing', 'preplay', 'micReady', 'armed', 'waiting', 'starting', 'playing', 'paused', 'buffering', 'stopping', 'error', 'ended'] as const)('%sでも有効な停止ボタンが存在する', phase => {
    const html = render(phase);
    const stops = [...html.matchAll(/<button\b([^>]*)>すべてを停止<\/button>/g)];
    expect(stops.some(match => !/\bhidden=|\bdisabled=/.test(match[1]!))).toBe(true);
  });
  it('完全停止で開始前の欄を再表示し、診断・比較は閉じた詳細欄へ保持', () => {
    const html = render();
    for (const id of ['audio-settings', 'correction-panel', 'settings-panel']) expect(html.match(new RegExp(`<details[^>]*id="${id}"[^>]*>`))?.[0]).not.toContain('hidden');
    expect(html.match(/<details[^>]*id="audio-settings"[^>]*>/)?.[0]).toContain('open=');
    expect(html.match(/<details[^>]*id="advanced-settings"[^>]*>/)?.[0]).not.toContain('open=');
    expect(html.indexOf('id="advanced-settings"')).toBeLessThan(html.indexOf('id="diagnostics-panel"'));
    for (const item of ['診断JSONを保存', '検知後のマイク資源', '安定化待機', '検知待機期限', '同期補正方式']) expect(html).toContain(item);
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });
  it('詳細・診断へのリンクは閉じた親パネルも開く', () => {
    const parent = { tagName: 'DETAILS', open: false, parentElement: null };
    const panel = { tagName: 'DETAILS', open: false, parentElement: parent, scrollIntoView: vi.fn(), querySelector: () => null };
    openPanel('diagnostics-panel', { getElementById: () => panel } as unknown as Document);
    expect(parent.open).toBe(true); expect(panel.open).toBe(true); expect(panel.scrollIntoView).toHaveBeenCalledTimes(1);
  });
  it('起動時も保存済み歌声設定を優先し、再表示だけでは保存しない', () => {
    const data = new Map<string, string>(); const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { data.set(key, value); }) };
    const profile = defaultDetectionProfile('dQw4w9WgXcQ', 'DAM', 'vocal', 'simulation'); profile.input.threshold = .123; profile.input.durationMs = 700;
    saveSyncProfile(storage, withDetectionProfile(undefined, profile), 4); storage.setItem.mockClear(); vi.stubGlobal('localStorage', storage);
    const html = renderToStaticMarkup(createElement(App, createApp('simulation')));
    expect(html).toContain('value="0.123"'); expect(html).toContain('value="700"'); expect(storage.setItem).not.toHaveBeenCalled();
  });
});
