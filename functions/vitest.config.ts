import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@delfrance/functions',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
