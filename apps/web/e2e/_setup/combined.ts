import type { FullConfig } from '@playwright/test';
import legacySetup from '../global-setup';
import suSetup from './global';

/**
 * Composes the two global setups present in the repo:
 *
 *  - `../global-setup.ts` (this PR): seeds the tenant + test user via the
 *    Admin SDK and persists a Firebase session to `e2e/.auth/user.json`.
 *    Skips when `E2E_USER_EMAIL/PASSWORD` are missing.
 *  - `./global.ts` (main): logs the SU in via the UI and persists the
 *    Firebase session to `e2e/.auth/su.json`. Skips when
 *    `E2E_SU_EMAIL/PASSWORD` are missing.
 *
 * Each CI job sets only its own credentials; the other half no-ops. When
 * the SDK ships a single auth helper for both, collapse this back.
 */
export default async function combined(config: FullConfig): Promise<void> {
  await legacySetup(config);
  await suSetup(config);
}
