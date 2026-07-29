/**
 * Returns true when the environment variables required for the authenticated
 * e2e flow are configured. `globalSetup` (`apps/web/e2e/global-setup.ts`) now
 * throws before any spec runs if these are missing, so in practice this is
 * always true by the time a spec's `test.skip` reads it — kept as a defensive
 * per-spec check, not a graceful-degradation path.
 *
 * The e2e user is ephemeral — `globalSetup` mints it via the Admin SDK — so
 * the only prerequisites are the Firebase project id and a service account;
 * there are no `E2E_USER_*` secrets anymore.
 */
export function requiresAuthEnv(): boolean {
  return (
    !!process.env.FIREBASE_PROJECT_ID &&
    !!(process.env.FIREBASE_SERVICE_ACCOUNT ?? process.env.FIREBASE_SERVICE_ACCOUNT_PATH)
  );
}
