/**
 * Returns true when all environment variables required for the
 * authenticated e2e flow are configured. Auth-requiring specs read this
 * in `test.beforeAll` and `test.skip` themselves when it returns false,
 * so missing CI secrets degrade gracefully instead of blocking the build.
 */
export function requiresAuthEnv(): boolean {
  return (
    !!process.env.E2E_USER_EMAIL &&
    !!process.env.E2E_USER_PASSWORD &&
    !!process.env.FIREBASE_PROJECT_ID &&
    !!(
      process.env.FIREBASE_SERVICE_ACCOUNT ??
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    )
  );
}
