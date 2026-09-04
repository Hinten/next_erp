import { defineConfig } from 'vitest/config';

// Node environment, zero network: every test injects its own `fetch` and its own
// clock, so nothing here can reach Shopee (or anything else) even by accident.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
