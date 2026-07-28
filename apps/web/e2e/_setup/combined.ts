import type { FullConfig } from '@playwright/test';
import legacySetup from '../global-setup';
import { sweepOrphanedE2EFixturesSafely } from '../_helpers/stale-sweep';
import suSetup from './global';

/**
 * Composes the global setups present in the repo:
 *
 *  - `../_helpers/stale-sweep.ts`: reclaims fixtures orphaned by runs that were
 *    cancelled before their `afterAll` could run (#712). Runs FIRST, so the
 *    collections the suite is about to read are already clean — and at the start
 *    of a run, because no end-of-run hook survives a cancellation. Self-skips
 *    when the Admin SDK env is missing or in emulator mode.
 *  - `../global-setup.ts`: seeds the tenant, mints an ephemeral test user
 *    via the Admin SDK, and persists a Firebase session to
 *    `e2e/.auth/user.json`. Skips when the Admin SDK secrets
 *    (`FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT`) are missing.
 *  - `./global.ts`: logs the SU in via the UI and persists the Firebase
 *    session to `e2e/.auth/su.json`. Skips when `E2E_SU_EMAIL/PASSWORD`
 *    are missing.
 */
export default async function combined(config: FullConfig): Promise<void> {
  await sweepOrphanedE2EFixturesSafely();
  await legacySetup(config);
  await suSetup(config);
}
