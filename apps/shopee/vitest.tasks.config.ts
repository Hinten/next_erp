import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Shopee Cloud Tasks ROUND-TRIP suite — runs ONLY under
// `firebase emulators:exec --config firebase.shopee.tasks.json
//  --only firestore,functions,tasks` (.github/workflows/ci-shopee.yml).
//
// Split from the offline suite on purpose: this one pays for the functions
// emulator loading the Shopee codebase plus the artifact build that has to
// precede it, while `pnpm test` stays fast and offline.
//
// The `.tasks.` suffix keeps these out of the offline suite — `vitest.config.ts`
// excludes it (it matches `*.test.ts`). There is no Firestore-only config here
// yet; that lane is step 22's (#1530).
export default defineConfig({
  test: {
    name: '@delfrance/shopee-app:tasks',
    environment: 'node',
    include: ['{app,lib,functions}/**/*.tasks.test.ts', '*.tasks.test.ts'],
    // The fail-loud emulator gates, the pinned project/database and the
    // non-localhost fetch kill-switch. All three matter more here, not less:
    // this lane boots the real Shopee functions, and every one of them declares
    // the partner credentials.
    setupFiles: ['./vitest.tasks.setup.ts'],
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
