import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.vitest.test.ts'],
    testTimeout: 30 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
    environment: 'node',
  },
});
