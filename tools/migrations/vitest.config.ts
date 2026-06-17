import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@delfrance/migrations',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
