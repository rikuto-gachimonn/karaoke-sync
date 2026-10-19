import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rootCertificates } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { isPrivateIPv4 } from '../src/config/localHttps.js';
import { deniedFiles, localHttpsOptions } from '../scripts/https-options.ts';
import { certificateProfile } from '../scripts/certificate-profile.ts';
import { analyzeLog } from '../scripts/analyze-log.ts';

describe('LAN HTTPS設定', () => {
  it.each(['192.168.3.3', '10.0.0.5', '172.16.0.3', '172.31.255.10'])('LAN IPv4 %s を許容', host => expect(isPrivateIPv4(host)).toBe(true));
  it.each(['0.0.0.0', '127.0.0.1', '8.8.8.8', '169.254.1.1', '172.32.0.1', '192.168.3.999', '192.168.03.3', 'example.com', undefined])('全待受/外部/不正 %s を拒否', host => expect(isPrivateIPv4(host)).toBe(false));
  it('設定未準備ならHTTPSを勝手にHTTPへフォールバックしない', () => {
    const folder = mkdtempSync(join(tmpdir(), 'karaokesync-config-'));
    try { expect(() => localHttpsOptions(folder)).toThrow(); } finally { rmSync(folder, { recursive: true }); }
  });
  it('全インターフェースや別ポートへの設定を拒否', () => {
    const folder = mkdtempSync(join(tmpdir(), 'karaokesync-config-'));
    try {
      mkdirSync(join(folder, '.local-https'));
      for (const config of [{ host: '0.0.0.0', port: 5173 }, { host: '192.168.3.3', port: 443 }]) {
        writeFileSync(join(folder, '.local-https/server.json'), JSON.stringify(config));
        expect(() => localHttpsOptions(folder)).toThrow('RFC1918');
      }
    } finally { rmSync(folder, { recursive: true }); }
  });
  it('秘密鍵・ローカル設定・環境変数ファイルを配信拒否対象に含む', () => {
    expect(deniedFiles).toEqual(expect.arrayContaining(['**/.local-https/**', '**/*.pem', '**/*.key', '**/.env*']));
  });
  it('iPhone用プロファイルは公開CAだけを含み、VPNやWi-Fi設定を含まない', () => {
    const cert = new X509Certificate(rootCertificates[0]!);
    const profile = certificateProfile(cert.raw);
    expect(profile).toContain(cert.raw.toString('base64'));
    expect(profile).toContain('com.apple.security.root');
    expect(profile).not.toContain('PRIVATE KEY'); expect(profile).not.toContain('com.apple.vpn');
    expect(profile).not.toContain('com.apple.wifi');
  });
});

describe('診断JSONの順序確認', () => {
  const names = ['mic.acquire', 'mic.acquired', 'player.prepared', 'detector.armed', 'detector.firstExceeded', 'detector.duration.satisfied', 'player.play.request', 'player.buffering', 'player.playing', 'session.stop.request', 'mic.resources.released'];
  const entries = names.map((event, index) => ({ event, timeMs: index * 10, sequence: index + 1, generation: 1, detail: '' }));
  it('通常の順序と内部play→PLAYING時間を表示し、実発音成功とはしない', () => {
    const result = analyzeLog({ entries, dropped: 0 });
    expect(result.sessions[0]?.issues).toEqual([]);
    expect(result.sessions[0]?.playToPlayingMs).toBe(20);
    expect(result.note).toContain('成功判定ではありません');
  });
  it('検知成立前の要求やログ欠落を報告', () => {
    const result = analyzeLog({ entries: entries.filter(e => e.event !== 'detector.duration.satisfied'), dropped: 1 });
    expect(result.incomplete).toBe(true); expect(result.sessions[0]?.issues[0]).toContain('player.play.request');
  });
  it('不正な形式のファイルを拒否', () => {
    expect(() => analyzeLog({})).toThrow();
    expect(() => analyzeLog({ entries: [{ event: 'bad' }] })).toThrow();
  });
});
