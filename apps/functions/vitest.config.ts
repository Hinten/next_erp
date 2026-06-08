import { defineConfig } from 'vitest/config';

// Unit suite — pure logic (guards, sharp transform, orphan helpers). Runs
// offline in the headline pipeline; the emulator integration suite
// (*.storage.test.ts) is excluded here and owned by vitest.storage.config.ts.
export default defineConfig({
  test: {
    name: '@delfrance/functions',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.storage.test.ts', 'node_modules', 'dist'],
  },
});
