import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@delfrance/cmun-table',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
