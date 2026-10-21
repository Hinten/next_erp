import { defineConfig } from 'vitest/config';

// Node environment, zero network: every test injects its own `fetch` and its own
// clock, so nothing here can reach Amazon (D11). `semRede.ts` makes that a
// property rather than a habit: it replaces the global `fetch` with one that
// throws, so a test that forgets to inject one fails instead of going out.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/_setup/semRede.ts'],
  },
});
