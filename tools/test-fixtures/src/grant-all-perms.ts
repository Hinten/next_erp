/**
 * Grants all permissions to a Firebase user by email.
 *
 * Usage:
 *   FIREBASE_SERVICE_ACCOUNT='<service-account-json>' \
 *   pnpm grant-all-perms <email>
 *
 *   pnpm grant-all-perms <email> --service-account ./service-account.json
 *
 * After running, the user must sign out and sign back in for the new claim
 * to take effect (Firebase ID tokens are cached for ~1 hour).
 */
import { getAuth } from 'firebase-admin/auth';
import { PERM, rulesClaimsFromBits } from '@delfrance/auth';
import { getApp } from './admin.js';

// Every permission bit OR'd together — derived from PERM so new domains join
// automatically (the previous hand-maintained mirror had drifted: it missed
// categoria, metodoPagamento, mensagem and the imposto domains).
export const ALL_PERMS = Object.values(PERM)
  .flatMap((actions) => Object.values(actions))
  .reduce((acc, bit) => acc | bit, 0n);

export interface GrantAllPermsResult {
  uid: string;
  permissionsClaim: string;
}

/**
 * Programmatic version of the CLI script — used by Playwright globalSetup
 * to mint a test user with full permissions.
 */
export async function grantAllPerms(
  email: string,
  options: { extraClaims?: Record<string, unknown>; serviceAccountPath?: string } = {},
): Promise<GrantAllPermsResult> {
  getApp(options.serviceAccountPath);
  const auth = getAuth();
  const user = await auth.getUserByEmail(email);
  // d_* rules claims spread BEFORE extraClaims so e2e overrides still win.
  await auth.setCustomUserClaims(user.uid, {
    permissions: ALL_PERMS.toString(),
    ...rulesClaimsFromBits(ALL_PERMS),
    ...options.extraClaims,
  });
  return { uid: user.uid, permissionsClaim: ALL_PERMS.toString() };
}

function parseArgs(argv: string[]): { email?: string; serviceAccountPath?: string } {
  const [email, ...rest] = argv;
  let serviceAccountPath: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--service-account' || arg === '-s') {
      serviceAccountPath = rest[index + 1];
      index += 1;
    }
  }

  return { email, serviceAccountPath };
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('grant-all-perms.ts') ||
  process.argv[1]?.endsWith('grant-all-perms.js');

if (isDirectInvocation) {
  const { email, serviceAccountPath } = parseArgs(process.argv.slice(2));
  if (!email) {
    console.error('Usage: grant-all-perms <email> [--service-account <path>]');
    process.exit(1);
  }

  if (
    (process.argv.includes('--service-account') || process.argv.includes('-s')) &&
    !serviceAccountPath
  ) {
    console.error('Missing value for --service-account');
    process.exit(1);
  }

  grantAllPerms(email, { serviceAccountPath })
    .then(({ uid, permissionsClaim }) => {
      console.log(`✓ Granted all permissions to ${email} (uid: ${uid})`);
      console.log(`  permissions claim: "${permissionsClaim}"`);
      console.log('  Sign out and sign back in to apply the new claim.');
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
