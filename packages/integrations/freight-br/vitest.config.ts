import { defineConfig } from 'vitest/config';

// Platform-neutral, fetch-based package — no Firebase/cert env needed.
// Tests mock `fetch` directly. Node environment, tests under `test/`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
