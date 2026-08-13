import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@delfrance/ai',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
