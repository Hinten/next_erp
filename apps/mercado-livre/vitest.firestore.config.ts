import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Mercado Livre backend integration suite — runs ONLY under
// `firebase emulators:exec --config firebase.mercado-livre.json --only firestore`
// (.github/workflows/ci-mercado-livre.yml). The dedicated `*.firestore.test.ts`
// extension keeps these out of the offline unit run, which `vitest.config.ts`
// excludes by the same glob.
//
// The suffix is `.firestore.` and NOT `.emulator.`: in this repo `.emulator.`
// already means a Playwright browser spec (`*.emulator.e2e.spec.ts`, run by
// e2e-emulator.yml).
//
// ⚠️ Never set `passWithNoTests`, and never add `--changed`/`--related` to the
// `test:firestore` script — each of those forces it true, and a mis-globbed
// `include` would then exit 0 instead of failing.
export default defineConfig({
  test: {
    name: '@delfrance/mercado-livre-app:firestore',
    environment: 'node',
    // Anchored to the three source roots (same shape as vitest.config.ts) rather
    // than a bare `**/` — an unanchored include walks apps/mercado-livre/node_modules.
    include: ['{app,lib,functions}/**/*.firestore.test.ts'],
    setupFiles: ['./vitest.firestore.setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Emulator state is shared across files, so don't parallelize across them.
    // ⚠️ This serializes FILES, not emulator state — a collection-wide query
    // still sees another file's leftovers. Suites that query collection-wide
    // must purge in `beforeEach`; see the sweep tests.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
