import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { X509Certificate } from 'node:crypto';
import { isPrivateIPv4 } from '../src/config/localHttps.js';
import { certificateProfile } from './certificate-profile.ts';

const config = JSON.parse(readFileSync('.local-https/server.json', 'utf8'));
if (!isPrivateIPv4(config.host)) throw new Error('LAN IPv4設定が不正です');
const certificate = new X509Certificate(readFileSync(config.publicCa));
if (!certificate.ca) throw new Error('CA公開証明書ではありません');
const profile = certificateProfile(certificate.raw);
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
  const pathname = new URL(request.url ?? '/', 'http://local.invalid').pathname;
  let content;
  if (pathname === '/root-ca.cer') {
    response.setHeader('Content-Type', 'application/x-x509-ca-cert');
    response.setHeader('Content-Disposition', 'attachment; filename="karaokesync-root-ca.cer"');
    content = certificate.raw;
  } else if (pathname === '/root-ca.mobileconfig') {
    response.setHeader('Content-Type', 'application/x-apple-aspen-config');
    response.setHeader('Content-Disposition', 'attachment; filename="karaokesync-root-ca.mobileconfig"');
    content = profile;
  } else if (pathname === '/') {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    content = `KaraokeSync: public CA certificate only\nSHA256: ${certificate.fingerprint256}\n/root-ca.mobileconfig (iPhone, manual installation)\n/root-ca.cer\nNo private key is served. Stop this server after transfer.\n`;
  } else { response.writeHead(404); response.end(); return; }
  response.end(request.method === 'HEAD' ? undefined : content);
});
server.listen(5174, config.host, () => console.log(`公開CAのみの受渡し: http://${config.host}:5174/root-ca.mobileconfig\nSHA256: ${certificate.fingerprint256}\n秘密鍵は配信しません。インストールはiPhoneの明示操作が必要です。受渡し後はCtrl+Cで停止。`));
process.on('SIGINT', () => server.close(() => process.exit(0)));
