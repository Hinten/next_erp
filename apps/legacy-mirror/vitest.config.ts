import { defineConfig } from 'vitest/config';

// Unit suite only: the decision, the value rebinding and the handler against
// in-memory fakes. Offline by construction — no emulator (root CLAUDE.md rule 4
// names the only lanes allowed one), and never a real project.
export default defineConfig({
  test: {
    name: '@delfrance/legacy-mirror',
    environment: 'node',
    include: ['functions/src/**/*.test.ts'],
  },
});
