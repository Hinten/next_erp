import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    name: '@delfrance/mercado-livre-app',
    environment: 'node',
    // `functions/` holds the deploy-artifact-only Cloud Functions codebase (not a
    // pnpm workspace package). The parent app's tasks (tsconfig `**/*.ts`, `eslint .`,
    // this vitest config) cover it, so include its tests here too.
    include: ['{app,lib,functions}/**/*.test.ts'],
    // `foo.firestore.test.ts` DOES match the include above (`*` is greedy over
    // non-slash chars), so without this the emulator suite would be collected
    // here, skip for lack of FIRESTORE_EMULATOR_HOST, and report green having
    // run nothing. It belongs to vitest.firestore.config.ts / `test:firestore`.
    // ⚠️ `exclude` REPLACES vitest's defaults rather than merging, so the
    // standard entries have to be re-listed.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '{app,lib,functions}/**/*.firestore.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
