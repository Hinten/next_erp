import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    name: '@delfrance/shopee-app',
    environment: 'node',
    // ⚠️ The cut-off tests must never be evaluated in the zone they assert.
    // `prazoDespachoShopee` derives a São Paulo civil day through an EXPLICIT
    // `timeZone`, and the mutation that matters is swapping that for the
    // process-bound `getPrazoDespacho` — which is invisible on a machine (or an
    // `apps/nfe` runtime) already set to `America/Sao_Paulo`. Pinning the runner
    // to UTC makes the ambient-zone binding disagree by three hours instead of
    // agreeing by luck.
    env: { TZ: 'UTC' },
    // `functions/` holds the deploy-artifact-only Cloud Functions codebase (not a
    // pnpm workspace package). The parent app's tasks (tsconfig `**/*.ts`, `eslint .`,
    // this vitest config) cover it, so include its tests here too.
    // `proxy.ts` (the CORS middleware) sits at the app root, outside every
    // directory glob above — name its test explicitly or it never runs.
    include: ['{app,lib,functions}/**/*.test.ts', 'proxy.test.ts'],
    // `foo.tasks.test.ts` DOES match the include above (`*` is greedy over
    // non-slash chars), so without this the emulator suite would be collected
    // here, skip for lack of CLOUD_TASKS_EMULATOR_HOST, and report green having
    // run nothing. It belongs to vitest.tasks.config.ts / `test:tasks`.
    // ⚠️ Deliberately UNANCHORED, unlike the include: `proxy.test.ts` shows the
    // app root is a real home for tests, and a root-level `*.tasks.test.ts`
    // would otherwise be collected by NEITHER config — excluded from neither
    // here nor matched by the tasks config's anchored include — and so silently
    // never run. The tasks config carries the mirror-image root entry for the
    // same reason.
    // ⚠️ `exclude` REPLACES vitest's defaults rather than merging, so the
    // standard entries have to be re-listed.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      // Same trap, and it is listed BEFORE any such suite exists: the Firestore
      // emulator lane is step 22's (#1530), and a `*.firestore.test.ts` landing
      // then would otherwise be collected here and skip green.
      '**/*.firestore.test.ts',
      '**/*.tasks.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
