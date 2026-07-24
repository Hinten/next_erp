import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FullConfig } from '@playwright/test';
import globalSetup from './global';

// #31: the SU globalSetup used to skip silently (return with no storageState)
// when E2E_SU_EMAIL/E2E_SU_PASSWORD were missing, letting `configuracoes.spec.ts`
// self-skip downstream with no loud signal. It must now throw — this check
// runs before any browser/network call, so no real Firebase project is needed.
describe('_setup/global — SU auth env is mandatory', () => {
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

  it('throws when E2E_SU_EMAIL and E2E_SU_PASSWORD are both missing', async () => {
    await expect(globalSetup({} as FullConfig)).rejects.toThrow(/E2E_SU_EMAIL\/E2E_SU_PASSWORD/);
  });

  it('throws when only E2E_SU_PASSWORD is missing', async () => {
    process.env.E2E_SU_EMAIL = 'su@example.com';
    await expect(globalSetup({} as FullConfig)).rejects.toThrow(/E2E_SU_EMAIL\/E2E_SU_PASSWORD/);
  });
});
