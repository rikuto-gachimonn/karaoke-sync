import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { isPrivateIPv4 } from '../src/config/localHttps.js';

// 証明書は生成するが、-installも証明書ストア変更も決して行わない。
const host = process.argv[2];
if (!isPrivateIPv4(host)) throw new Error('例: pnpm https:setup 192.168.3.3（実際のPCのLAN IPv4を指定）');
const project = process.cwd();
const settingsDir = resolve(project, '.local-https');
const configPath = join(settingsDir, 'server.json');
if (existsSync(configPath)) throw new Error('既存HTTPS設定は上書きしません。IP変更時はSTAGE2B.mdの再設定手順を確認してください');
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error('WindowsのLOCALAPPDATAが必要です');
// OneDrive配下へCA秘密鍵を生成しない。
const tlsDir = join(localAppData, 'KaraokeSync', 'https');
const caDir = join(tlsDir, 'ca');
const cert = join(tlsDir, 'server.pem');
const key = join(tlsDir, 'server-key.pem');
if (existsSync(cert) || existsSync(key)) throw new Error('既存のサーバー証明書/鍵は上書きしません');
const executable = resolve(settingsDir, 'tools', 'mkcert.exe');
if (!existsSync(executable)) throw new Error('公式mkcert.exeを.local-https/toolsへ準備してください（STAGE2B.md参照）');
mkdirSync(caDir, { recursive: true });
const result = spawnSync(executable, ['-cert-file', cert, '-key-file', key, host, 'localhost', '127.0.0.1'], {
  env: { ...process.env, CAROOT: caDir }, windowsHide: true, encoding: 'utf8',
});
if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'mkcert生成失敗');
const ca = join(caDir, 'rootCA.pem');
const publicCa = join(tlsDir, 'root-ca.cer');
// iPhone用は公開CA証明書だけ。CA秘密鍵やサーバー秘密鍵は渡さない。
const publicDer = new X509Certificate(readFileSync(ca)).raw;
if (existsSync(publicCa)) {
  if (!readFileSync(publicCa).equals(publicDer)) throw new Error('既存の公開CAと生成元が違います。上書きせず確認してください');
} else writeFileSync(publicCa, publicDer, { flag: 'wx' });
mkdirSync(settingsDir, { recursive: true });
writeFileSync(configPath, JSON.stringify({ host, port: 5173, cert, key, ca, publicCa }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ url: `https://${host}:5173/`, configPath, publicCa, fingerprint256: new X509Certificate(readFileSync(ca)).fingerprint256,
  trusted: false, note: '生成のみ。PC/iPhoneの証明書信頼設定とファイアウォールは変更していません' }, null, 2));
