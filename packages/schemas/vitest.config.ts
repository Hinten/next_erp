import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@delfrance/schemas',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
