import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    name: '@delfrance/amazon-app',
    environment: 'node',
    // ⚠️ A date test must never be evaluated in the zone it asserts. A civil-day
    // derivation that goes through an EXPLICIT `timeZone` is indistinguishable,
    // on a machine (or an `apps/nfe` runtime) already set to
    // `America/Sao_Paulo`, from one that reads the process zone by accident.
    // Pinning the runner to UTC makes the ambient-zone binding disagree by three
    // hours instead of agreeing by luck.
    env: { TZ: 'UTC' },
    // `functions/` is the deploy-artifact-only Cloud Functions codebase `amazon`
    // (not a pnpm workspace package). The parent app's tasks (tsconfig
    // `**/*.ts`, `eslint .`, this vitest config) cover it, so its tests are
    // included here.
    // `proxy.ts` (the CORS middleware) sits at the app root, outside every
    // directory glob above — its test is named explicitly or it never runs.
    include: ['{app,lib,functions}/**/*.test.ts', 'proxy.test.ts'],
    // `foo.tasks.test.ts` DOES match the include above (`*` is greedy over
    // non-slash chars), so without this an emulator suite would be collected
    // here, skip for lack of its emulator host, and report green having run
    // nothing. It belongs to its own config and script.
    // ⚠️ Deliberately UNANCHORED, unlike the include: `proxy.test.ts` shows the
    // app root is a real home for tests, and a root-level `*.tasks.test.ts`
    // would otherwise be collected by NEITHER config and so silently never run.
    // ⚠️ `exclude` REPLACES vitest's defaults rather than merging, so the
    // standard entries have to be re-listed.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      // Same trap, and it is listed BEFORE any such suite exists: a
      // `*.firestore.test.ts` landing later would otherwise be collected here
      // and skip green.
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
