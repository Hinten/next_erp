/**
 * Returns true when the environment variables required for the authenticated
 * e2e flow are configured. Auth-requiring specs read this in `test.beforeAll`
 * and `test.skip` themselves when it returns false, so missing CI secrets
 * degrade gracefully instead of blocking the build.
 *
 * The e2e user is ephemeral — `globalSetup` mints it via the Admin SDK — so
 * the only prerequisites are the Firebase project id and a service account;
 * there are no `E2E_USER_*` secrets anymore.
 */
export function requiresAuthEnv(): boolean {
  return (
    !!process.env.FIREBASE_PROJECT_ID &&
    !!(
      process.env.FIREBASE_SERVICE_ACCOUNT ??
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    )
  );
}
