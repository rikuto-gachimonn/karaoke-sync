import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromeLink } from '../src/ui/chromeLink';
import { ChromeOpen } from '../src/ui/ChromeOpen';
const url = 'https://rikuto-gachimonn.github.io/karaoke-sync/?mode=simulation#settings-panel';
const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1';
describe('Chrome起動リンク', () => {
  it('iPhoneではHTTPSを公式スキームに変換し、サブパス・クエリ・フラグメントを維持', () => {
    expect(chromeLink(url, safari)).toEqual({ url, alreadyChrome: false, launch: url.replace('https:', 'googlechromes:') });
    expect(chromeLink('http://localhost:5173/karaoke-sync/', safari).launch).toBe('googlechrome://localhost:5173/karaoke-sync/');
  });
  it.each(['iPhone CriOS/140.0 Mobile', 'Android Chrome/140.0', 'Windows Chrome/140.0', 'Linux Chromium/140.0'])('%sではChromeを二重起動しない', agent => {
    expect(chromeLink(url, agent)).toMatchObject({ alreadyChrome: true, launch: undefined });
  });
  it.each(['Android Firefox/140.0', 'Windows Edg/140.0 Chrome/140.0', 'Macintosh Safari/605.1', 'iPhone EdgiOS/140.0'])('%sをChromeと誤判定しない', agent => {
    expect(chromeLink(url, agent).alreadyChrome).toBe(false);
    if (!agent.includes('iPhone')) expect(chromeLink(url, agent).launch).toBeUndefined();
  });
  it.each(['javascript:alert(1)', 'data:text/html,test', 'ftp://example.com', 'https://user:pass@example.com'])('危険なURL %sを起動しない', href => {
    expect(() => chromeLink(href, safari)).toThrow();
  });
  it('データ移行・アプリ未導入の代替・Premiumの限界を説明し、アカウント入力を追加しない', () => {
    const html = renderToStaticMarkup(createElement(ChromeOpen));
    expect(html).toContain('Google Chromeで開く'); expect(html).toContain('自動共有されません');
    expect(html).toContain('JSONバックアップ'); expect(html).toContain('URLコピーや通常リンク');
    expect(html).toContain('広告なしになるとは保証できません');
    expect(html).not.toContain('type="password"'); expect(html).not.toContain('open=""');
  });
});
