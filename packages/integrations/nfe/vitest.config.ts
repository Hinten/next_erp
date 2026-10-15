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
    // ⚠️ The two NF-e keys are pinned AFTER both spreads, on purpose: neither a
    // repo-root `.env.local` nor the shell can point a Vitest run in this package at
    // SEFAZ produção. A test that needs produção semantics stubs them inside the
    // test (`vi.stubEnv`, as `test/safety/safety.test.ts` does).
    // `test/safety/test-env-pin.test.ts` proves the pin holds.
    env: { ...envFromFiles, ...process.env, NFE_AMBIENTE: 'homologacao', NFE_ALLOW_PRODUCAO: '' },
  },
});
