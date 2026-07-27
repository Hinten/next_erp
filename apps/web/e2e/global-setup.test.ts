import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FullConfig } from '@playwright/test';
import globalSetup from './global-setup';

// #31: globalSetup used to degrade gracefully (write an empty storageState
// and return) when the Admin SDK env was missing. It must now throw instead —
// auth is a mandatory prerequisite of every e2e run, not an optional
// happy-path. These checks run before any network/browser call, so no
// Firebase credentials or Playwright browser are needed to exercise them.
describe('global-setup — auth env is mandatory', () => {
  const ENV_KEYS = [
    'FIREBASE_PROJECT_ID',
    'FIREBASE_SERVICE_ACCOUNT',
    'FIREBASE_SERVICE_ACCOUNT_PATH',
    'FIREBASE_AUTH_EMULATOR_HOST',
    'FIRESTORE_EMULATOR_HOST',
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('throws when FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT are both missing', async () => {
    await expect(globalSetup({} as FullConfig)).rejects.toThrow(
      /FIREBASE_PROJECT_ID.*FIREBASE_SERVICE_ACCOUNT/s,
    );
  });

  it('throws when only FIREBASE_SERVICE_ACCOUNT is missing (non-emulator mode)', async () => {
    process.env.FIREBASE_PROJECT_ID = 'demo-erp';
    await expect(globalSetup({} as FullConfig)).rejects.toThrow(/FIREBASE_SERVICE_ACCOUNT/);
  });
});
