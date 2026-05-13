import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@delfrance/data',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
