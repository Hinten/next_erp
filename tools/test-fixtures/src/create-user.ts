/* eslint-disable no-console -- CLI tool: stdout is the interface */
/**
 * Creates a Firebase Auth user with the given email + password if one
 * doesn't already exist (idempotent — leaves an existing user alone).
 * `emailVerified: true` so the login page accepts it without an email
 * verification round-trip.
 *
 * Thin CLI wrapper around `ensureTestUser` — primarily for bootstrapping the
 * `E2E_SU_EMAIL`/`E2E_SU_PASSWORD` test superuser (see the pre-reqs comment
 * atop `apps/web/e2e/configuracoes.spec.ts`). Follow up with
 * `create-super-user` or `grant-all-perms` to actually grant it permissions —
 * this script only creates the bare Auth account.
 *
 * Usage:
 *   FIREBASE_SERVICE_ACCOUNT='<service-account-json>' \
 *   pnpm create-user <email> <password>
 *
 *   pnpm create-user <email> <password> --service-account ./service-account.json
 */
import { getApp } from './admin.js';
import { ensureTestUser } from './users.js';

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('create-user.ts') ||
  process.argv[1]?.endsWith('create-user.js');

if (isDirectInvocation) {
  const argv = process.argv.slice(2);
  const [email, password, ...rest] = argv;
  if (!email || !password) {
    console.error('Usage: create-user <email> <password> [--service-account <path>]');
    process.exit(1);
  }

  let serviceAccountPath: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--service-account' || rest[i] === '-s') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('-')) {
        console.error('Missing value for --service-account');
        process.exit(1);
      }
      serviceAccountPath = value;
      i += 1;
    }
  }

  // Primes the module-level Admin SDK app singleton with the requested
  // credentials; `ensureTestUser`'s own bare `getApp()` call then reuses it.
  getApp(serviceAccountPath);

  ensureTestUser(email, password)
    .then((user) => {
      console.log(`✓ ${email} exists (uid: ${user.uid})`);
      console.log('  Run create-super-user or grant-all-perms next to grant permissions.');
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
