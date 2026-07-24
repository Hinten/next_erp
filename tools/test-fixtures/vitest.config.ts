import { defineConfig } from 'vitest/config';

// Offline unit suite for the read-only tooling helpers (currently the
// datetime wire-shape sampler). Runs under plain `turbo run test`; needs no
// Firestore / emulator.
export default defineConfig({
  test: {
    name: '@delfrance/test-fixtures',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
