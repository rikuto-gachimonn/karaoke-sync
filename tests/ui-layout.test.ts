import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../src/ui/App';
import { openPanel } from '../src/ui/navigation';
import { createApp } from '../src/app/createApp';
import { initialState, type SessionState } from '../src/session/state';

beforeEach(() => vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
function render(patch: Partial<SessionState> = {}, mode: 'real' | 'simulation' = 'simulation') {
  const services = createApp(mode);
  vi.spyOn(services.controller, 'getSnapshot').mockReturnValue({ ...initialState, ...patch });
  return renderToStaticMarkup(createElement(App, services));
}
function button(html: string, name: string) {
  const result = [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].find(match => match[2] === name && !/\bhidden=/.test(match[1]!));
  if (!result) throw new Error(`button missing: ${name}`);
  return result[1]!;
}

describe('スマートフォン向けメイン画面', () => {
  it('マイク起動の操作待ちは再試行と停止を表示し、再準備・補正を無効にする', () => {
    const html = render({ phase: 'micReady', canPrepare: false, mic: 'off' }, 'real');
    expect(html).toContain('音検知は未開始');
    expect(button(html, 'マイクを起動して検知開始')).not.toContain('disabled');
    expect(button(html, 'すべてを停止')).not.toContain('disabled');
    expect(button(html, '検知を開始')).toContain('disabled');
    expect(html.match(/id="youtube-host"/g)).toHaveLength(1);
    expect(html).toMatch(/<fieldset[^>]*disabled=""[^>]*class="correction-controls"/);
  });
  it('音声検知設定を最初に開き、操作・音量・動画・再生時刻の順に並べる', () => {
    const html = render();
    const markers = ['class="app-header"', 'id="current-song"', 'id="audio-settings"', 'class="service-picker"', 'class="session-card"', 'aria-label="マイク音量メーター"', 'id="youtube-host"', 'aria-label="YouTube現在再生時刻"', 'class="tool-links"', 'class="correction-card"'];
    const indexes = markers.map(marker => html.indexOf(marker));
    expect(indexes.every(index => index >= 0)).toBe(true);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
    expect(html.match(/id="youtube-host"/g)).toHaveLength(1);
    expect(html.match(/<details[^>]*id="audio-settings"[^>]*>/)?.[0]).toContain('open=');
  });
  it('設定・管理・診断を閉じて開始し、設定フォームはDOMに保持する', () => {
    const html = render();
    for (const id of ['settings-panel', 'song-picker', 'song-management', 'diagnostics-panel']) {
      expect(html).toContain(`id="${id}"`);
      expect(html.match(new RegExp(`<details[^>]*id="${id}"[^>]*>`))?.[0]).not.toMatch(/\bopen(?:=|\s|>)/);
    }
    expect(html).toContain('開始位置（秒）'); expect(html).toContain('JSONファイル'); expect(html).toContain('診断JSONを保存');
    expect(html).toContain('次の検知準備・初回検知時に適用');
    expect(html).toContain('aria-label="補正を50ms進める"');
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });
  it('未準備時は準備と停止だけを有効にする', () => {
    const html = render(); expect(button(html, '検知を開始')).not.toContain('disabled'); expect(button(html, 'すべてを停止')).not.toContain('disabled');
    expect(html).not.toContain('>一時停止</button>'); expect(html).not.toContain('>再生</button>');
  });
  it.each(['preplay', 'armed', 'stopping'] as const)('%sでは準備連打・補正操作・不正な再開を許可しない', phase => {
    const html = render({ phase, canPrepare: false }); expect(button(html, '検知を開始')).toContain('disabled'); expect(html).not.toContain('>再生</button>');
    expect(html).toMatch(/<fieldset[^>]*disabled=""[^>]*class="correction-controls"/);
    expect(button(html, 'すべてを停止')).not.toContain('disabled');
    if (phase === 'armed') expect(html).toContain('音検知待機中');
  });
  it('一時停止確認中は再開を無効にし、確認後は再開を有効にする', () => {
    expect(button(render({ phase: 'paused', canPrepare: false, message: '一時停止を確認中' }), '再生')).toContain('disabled');
    expect(button(render({ phase: 'paused', canPrepare: false, message: '一時停止中' }), '再生')).not.toContain('disabled');
  });
  it.each(['waiting', 'starting', 'buffering', 'playing'] as const)('%sで一時停止とすべて停止にアクセスできる', phase => {
    const html = render({ phase, canPrepare: false }); expect(button(html, '一時停止')).not.toContain('disabled'); expect(button(html, 'すべてを停止')).not.toContain('disabled');
    expect(html.match(/id="youtube-host"/g)).toHaveLength(1);
  });
  it('実接続では直接タップの案内を常設し、機種選択とプレイヤーを重複させない', () => {
    const html = render({}, 'real');
    expect(html).toContain('準備 → 事前手動再生待ち → YouTube内の▶をタップ');
    expect(html.match(/<label>カラオケ機種/g)).toHaveLength(1);
    expect(html.match(/id="youtube-host"/g)).toHaveLength(1);
    expect(button(html, '曲を変更')).toContain('aria-controls="song-picker"');
  });
});

describe('折りたたみ導線', () => {
  it('同じパネルを開いてスクロールし、検索欄へフォーカスする。DOMを置換しない', () => {
    const search = { focus: vi.fn() };
    const panel = { tagName: 'DETAILS', open: false, scrollIntoView: vi.fn(), querySelector: vi.fn(() => search) };
    const getElementById = vi.fn(() => panel); const page = { getElementById } as unknown as Document;
    openPanel('song-picker', page); expect(panel.open).toBe(true); expect(panel.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(search.focus).toHaveBeenCalledWith({ preventScroll: true }); expect(getElementById).toHaveBeenCalledExactlyOnceWith('song-picker');
    expect(panel.querySelector).toHaveBeenCalledExactlyOnceWith('input[type="search"]');
  });
  it('存在しないパネルやYouTubeホストには操作しない', () => {
    const querySelector = vi.fn(); const scrollIntoView = vi.fn();
    openPanel('missing', { getElementById: () => null } as unknown as Document);
    openPanel('youtube-host', { getElementById: () => ({ tagName: 'DIV', scrollIntoView, querySelector }) } as unknown as Document);
    expect(scrollIntoView).not.toHaveBeenCalled(); expect(querySelector).not.toHaveBeenCalled();
  });
});
