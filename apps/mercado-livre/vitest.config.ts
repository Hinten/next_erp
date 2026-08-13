import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    name: '@delfrance/mercado-livre-app',
    environment: 'node',
    // `functions/` holds the deploy-artifact-only Cloud Functions codebase (not a
    // pnpm workspace package). The parent app's tasks (tsconfig `**/*.ts`, `eslint .`,
    // this vitest config) cover it, so include its tests here too.
    // `proxy.ts` (the CORS middleware) sits at the app root, outside every
    // directory glob above — name its test explicitly or it never runs.
    include: ['{app,lib,functions}/**/*.test.ts', 'proxy.test.ts'],
    // `foo.firestore.test.ts` DOES match the include above (`*` is greedy over
    // non-slash chars), so without this the emulator suite would be collected
    // here, skip for lack of FIRESTORE_EMULATOR_HOST, and report green having
    // run nothing. It belongs to vitest.firestore.config.ts / `test:firestore`.
    // ⚠️ Deliberately UNANCHORED, unlike the include: `proxy.test.ts` shows the
    // app root is a real home for tests, and a root-level `*.firestore.test.ts`
    // would otherwise be collected by NEITHER config — excluded from neither
    // here nor matched by the firestore config's anchored include — and so
    // silently never run. The firestore config carries the mirror-image root
    // entry for the same reason.
    // ⚠️ `exclude` REPLACES vitest's defaults rather than merging, so the
    // standard entries have to be re-listed.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/*.firestore.test.ts',
      // Same trap, second suite: `*.tasks.test.ts` also matches the include and
      // would skip here for lack of an emulator. It belongs to
      // vitest.tasks.config.ts / `test:tasks`.
      '**/*.tasks.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
