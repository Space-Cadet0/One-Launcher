import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['tests/live/**', 'node_modules/**', 'dist/**', 'release/**'],
    testTimeout: 10000,
    hookTimeout: 10000,
    setupFiles: ['./tests/setup/offlineNetworkGuard.ts'],
  },
});
