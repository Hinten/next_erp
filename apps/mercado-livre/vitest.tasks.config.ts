import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Mercado Livre Cloud Tasks ROUND-TRIP suite — runs ONLY under
// `firebase emulators:exec --config firebase.mercado-livre.tasks.json
//  --only firestore,functions,tasks` (.github/workflows/ci-mercado-livre.yml).
//
// Split from `test:firestore` on purpose: that suite needs Firestore alone and
// stays fast, while this one pays for the functions emulator loading all 15 ML
// functions plus the artifact build that has to precede it.
//
// The `.tasks.` suffix keeps these out of BOTH other suites — `vitest.config.ts`
// excludes it (it matches `*.test.ts`), and `vitest.firestore.config.ts` only
// collects `*.firestore.test.ts`.
export default defineConfig({
  test: {
    name: '@delfrance/mercado-livre-app:tasks',
    environment: 'node',
    include: ['{app,lib,functions}/**/*.tasks.test.ts', '*.tasks.test.ts'],
    // Same setup as the Firestore lane: the fail-loud emulator gate, the pinned
    // project/database, and the non-localhost fetch kill-switch. The last one
    // matters more here, not less — this lane boots the real ML functions, and
    // 8 of them declare the ML app secrets.
    setupFiles: ['./vitest.firestore.setup.ts'],
    // Generous: a task dispatch has a cold-start floor of ~1.5-2s on top of the
    // enqueue, and `getServiceAccount()` attempts a real token endpoint before
    // falling back to the emulated service account.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
