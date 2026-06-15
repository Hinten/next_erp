import { defineConfig } from 'vitest/config';

// Offline unit suite (generator internals + full-output snapshot). The
// emulator behavior suite lives behind vitest.rules.config.ts / `test:rules`
// so plain `turbo run test` never needs a running emulator.
export default defineConfig({
  test: {
    name: '@delfrance/rules-gen',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
