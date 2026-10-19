import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { deniedFiles, localHttpsOptions } from './scripts/https-options.ts';

export default defineConfig(({ mode }) => ({
  base: '/karaoke-sync/',
  plugins: [react(), {
    name: 'preserve-legacy-html',
    apply: 'build',
    generateBundle() {
      // 旧HTMLはビルド対象として変換せず、元のバイト列のまま共存させる。
      this.emitFile({ type: 'asset', fileName: 'karaoke_sync_test.html',
        source: readFileSync(new URL('./karaoke_sync_test.html', import.meta.url)) });
    },
  }],
  build: { rollupOptions: { input: { app: 'index.html', youtubeProbe: 'youtube-probe.html' } } },
  server: mode === 'iphone' ? localHttpsOptions() : { fs: { strict: true, deny: deniedFiles } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', restoreMocks: true },
}));
