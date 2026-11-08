import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    pool: 'threads',
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['tests/live/**', 'node_modules/**', 'dist/**', 'release/**'],
    testTimeout: 20000,
    hookTimeout: 20000,
    teardownTimeout: 20000,
    setupFiles: ['./tests/setup/offlineNetworkGuard.ts'],
  },
});
