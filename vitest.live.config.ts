import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['tests/live/**/*.live.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
