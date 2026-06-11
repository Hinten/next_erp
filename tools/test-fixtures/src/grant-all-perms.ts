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
import { getApp } from './admin.js';

// All permission bits OR'd together — mirrors PERM in packages/auth/src/permissions.ts
export const ALL_PERMS =
  0b111111n | // cliente (bits 0-2) + endereco (bits 3-5): read | write | delete
  (7n << 8n) | // produto
  (7n << 16n) | // pedido
  (7n << 24n) | // pagamento
  (7n << 32n) | // nfe
  (3n << 40n) | // configuracoes: read | write (no delete)
  (7n << 48n) | // chat
  (7n << 56n) | // integracao
  (7n << 64n) | // estoque
  (7n << 72n) | // fiscal
  (7n << 80n) | // arquivo
  (7n << 88n); // frete

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
  await auth.setCustomUserClaims(user.uid, {
    permissions: ALL_PERMS.toString(),
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
