import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: 'forks',
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' }
  }
});
