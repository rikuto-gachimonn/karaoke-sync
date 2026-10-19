import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { isPrivateIPv4 } from '../src/config/localHttps.js';
import type { ServerOptions } from 'vite';

export const deniedFiles = ['**/.git/**', '**/.env*', '**/.local-https/**', '**/*.pem', '**/*.key', '**/*.pfx', '**/*.p12', '**/root-ca.cer'];

export function localHttpsOptions(projectRoot = process.cwd()): ServerOptions {
  const config = JSON.parse(readFileSync(resolve(projectRoot, '.local-https/server.json'), 'utf8')) as Record<string, unknown>;
  if (!isPrivateIPv4(config.host) || config.port !== 5173) throw new Error('HTTPSはPCのRFC1918 IPv4・ポート5173に限定します');
  for (const field of ['cert', 'key', 'ca']) if (typeof config[field] !== 'string') throw new Error(`HTTPS設定の${field}が不正です`);
  const cert = readFileSync(config.cert as string);
  const key = readFileSync(config.key as string);
  const ca = new X509Certificate(readFileSync(config.ca as string));
  const leaf = new X509Certificate(cert);
  if (!ca.ca || !leaf.verify(ca.publicKey) || leaf.checkIP(config.host) !== config.host) throw new Error('CA署名またはLAN IPのSANが一致しません。再設定が必要です');
  if (Date.parse(leaf.validTo) <= Date.now() || Date.parse(leaf.validFrom) > Date.now()) throw new Error('証明書の有効期間外です');
  const keyPublic = createPublicKey(createPrivateKey(key)).export({ format: 'der', type: 'spki' });
  if (!keyPublic.equals(leaf.publicKey.export({ format: 'der', type: 'spki' }))) throw new Error('証明書と鍵が一致しません');
  return {
    host: config.host, port: 5173, strictPort: true,
    https: { cert, key },
    cors: false,
    fs: { strict: true, deny: deniedFiles },
  };
}
