import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@delfrance/storage',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
