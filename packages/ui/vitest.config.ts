import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@delfrance/ui',
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
