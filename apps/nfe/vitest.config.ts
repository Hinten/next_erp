import { defineConfig } from 'vitest/config';
import path from 'node:path';

import { loadRepoRootEnv } from '@delfrance/config-vitest/env';

// Hoist `.env` + `.env.local` from the repo root so the orchestrator
// homologação test picks up NFE_CERT_* / NFE_TEST_IE / FIREBASE_*
// without callers having to wrap vitest in `dotenv -e ../../.env.local`.
// Shell env wins over file values.
const envFromFiles = loadRepoRootEnv({
  configFileUrl: import.meta.url,
  resolveRelativePaths: ['NFE_CERT_PATH', 'FIREBASE_SERVICE_ACCOUNT_PATH'],
});

export default defineConfig({
  test: {
    name: '@delfrance/nfe-app',
    environment: 'node',
    // `functions/` holds the deploy-artifact-only `nfe` Cloud Functions codebase
    // (a sub-build of this app, not a workspace package) — its tests live next to
    // the code, so include them here too.
    // `proxy.ts` (the CORS middleware) sits at the app root, outside both globs
    // above — name its test explicitly or it never runs.
    include: ['test/**/*.test.ts', 'functions/**/*.test.ts', 'proxy.test.ts'],
    env: { ...envFromFiles, ...process.env },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
