/**
 * Grants all permissions to a Firebase user by email.
 *
 * Usage:
 *   FIREBASE_PROJECT_ID=<your-project-id> \
 *   FIREBASE_SERVICE_ACCOUNT='<service-account-json>' \
 *   pnpm grant-all-perms <email>
 *
 * After running, the user must sign out and sign back in for the new claim
 * to take effect (Firebase ID tokens are cached for ~1 hour).
 */
import { getAuth } from 'firebase-admin/auth';
import { getApp } from './admin.js';

// All permission bits OR'd together — mirrors PERM in packages/auth/src/permissions.ts
const ALL_PERMS =
  7n |          // cliente: read | write | delete
  (7n << 8n) |  // produto
  (7n << 16n) | // pedido
  (7n << 24n) | // pagamento
  (7n << 32n) | // nfe
  (3n << 40n) | // configuracoes: read | write (no delete)
  (7n << 48n);  // chat

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: grant-all-perms <email>');
    process.exit(1);
  }

  getApp();
  const auth = getAuth();

  const user = await auth.getUserByEmail(email);
  await auth.setCustomUserClaims(user.uid, { permissions: ALL_PERMS.toString() });

  console.log(`✓ Granted all permissions to ${email} (uid: ${user.uid})`);
  console.log(`  permissions claim: "${ALL_PERMS.toString()}"`);
  console.log('  Sign out and sign back in to apply the new claim.');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
