import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@delfrance/logger',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
