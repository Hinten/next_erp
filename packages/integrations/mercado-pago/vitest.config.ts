import { defineConfig } from 'vitest/config';

// Scaffold smoke tests — node environment, no Firebase/cert/env needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
