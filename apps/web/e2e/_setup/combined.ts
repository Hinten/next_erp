import type { FullConfig } from '@playwright/test';
import legacySetup from '../global-setup';
import suSetup from './global';

/**
 * Composes the two global setups present in the repo:
 *
 *  - `../global-setup.ts`: seeds the tenant, mints an ephemeral test user
 *    via the Admin SDK, and persists a Firebase session to
 *    `e2e/.auth/user.json`. Skips when the Admin SDK secrets
 *    (`FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT`) are missing.
 *  - `./global.ts`: logs the SU in via the UI and persists the Firebase
 *    session to `e2e/.auth/su.json`. Skips when `E2E_SU_EMAIL/PASSWORD`
 *    are missing.
 */
export default async function combined(config: FullConfig): Promise<void> {
  await legacySetup(config);
  await suSetup(config);
}
