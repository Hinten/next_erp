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
// ⚠️ TWO suffixes, ONE config, ONE job — the Loja Integrada fold (#1530).
// `vitest.config.ts` EXCLUDES `**/*.tasks.test.ts` and `**/*.firestore.test.ts`
// and this config includes both, so a Firestore-only proof shares the round
// trip's emulators: no `firebase.shopee.json`, no second port, check name or
// gate-manifest row. `packages/config-eslint/rules/vitest-config-partition.test.js`
// reds a test file collected by zero configs, by two, or by the wrong one.
//
// ⚠️ The functions emulator loads this codebase's THREE Firestore triggers
// (`integracao/{id}`, `pedidos/{id}/nfev4/{id}`, `produtos/{id}/prodshopee/{id}`),
// so they fire on every suite's writes here. Sharing stays safe under three rules:
//   - a `*.firestore.test.ts` writes none of those paths, or it becomes a
//     trigger suite and must await the trigger's LAST write before it ends;
//   - conta ids `int-1`…`int-4` belong to the round trips, whose credential
//     ABSENCE is what keeps a dispatched function offline — mint your own;
//   - each file deletes what it wrote (`fileParallelism: false`).
export default defineConfig({
  test: {
    name: '@delfrance/shopee-app:tasks',
    environment: 'node',
    include: ['{app,lib,functions}/**/*.{tasks,firestore}.test.ts', '*.{tasks,firestore}.test.ts'],
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
