import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FullConfig } from '@playwright/test';
import globalSetup from './global';

// #31: this shared globalSetup step stays best-effort on purpose. Playwright
// runs it once regardless of `--project` filtering, and only the
// `configuracoes` project touches the SU session — smoke/crud-*/emulator
// never do, and none of them should need SU credentials configured. The
// mandatory check lives in `configuracoes.spec.ts` (`requireSuAuthEnv()`)
// instead — see `_helpers/auth.test.ts`.
describe('_setup/global — SU login is best-effort', () => {
  let savedEmail: string | undefined;
  let savedPassword: string | undefined;

  beforeEach(() => {
    savedEmail = process.env.E2E_SU_EMAIL;
    savedPassword = process.env.E2E_SU_PASSWORD;
    delete process.env.E2E_SU_EMAIL;
    delete process.env.E2E_SU_PASSWORD;
  });

  afterEach(() => {
    if (savedEmail === undefined) delete process.env.E2E_SU_EMAIL;
    else process.env.E2E_SU_EMAIL = savedEmail;
    if (savedPassword === undefined) delete process.env.E2E_SU_PASSWORD;
    else process.env.E2E_SU_PASSWORD = savedPassword;
  });

  it('resolves without logging in when E2E_SU_EMAIL/E2E_SU_PASSWORD are missing', async () => {
    await expect(globalSetup({ projects: [] } as unknown as FullConfig)).resolves.toBeUndefined();
  });
});
