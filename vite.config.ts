import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { deniedFiles, localHttpsOptions } from './scripts/https-options.ts';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  build: { rollupOptions: { input: { app: 'index.html', youtubeProbe: 'youtube-probe.html' } } },
  server: mode === 'iphone' ? localHttpsOptions() : { fs: { strict: true, deny: deniedFiles } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node', restoreMocks: true },
}));
