import { defineConfig } from 'vitest/config';

import { loadRepoRootEnv } from '@delfrance/config-vitest/env';

// `.env.local` overrides `.env`; shell env wins over both (one-off
// `$env:NFE_CERT_BASE64 = '…'` still takes precedence).
const envFromFiles = loadRepoRootEnv({
  configFileUrl: import.meta.url,
  // Relative path values for these keys resolve against the repo root
  // (where `.env.local` lives), not vitest's CWD.
  resolveRelativePaths: ['NFE_CERT_PATH', 'FIREBASE_SERVICE_ACCOUNT_PATH'],
});

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    env: { ...envFromFiles, ...process.env },
  },
});
