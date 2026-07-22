/* eslint-disable no-console -- CLI tool: stdout is the interface */
/**
 * Promotes a Firebase user (by email) to a durable SUPER USER.
 *
 * Unlike `grant-all-perms` (which grants only the currently-defined PERM bits
 * and is NOT a superuser), this mints the full `SUPERUSER_MASK` + the `su`
 * rules short-circuit claim AND flips `usuarios/<uid>.isSuperUser = true`, so a
 * later claims-recompute from the admin UI keeps them super.
 *
 * Usage:
 *   FIREBASE_SERVICE_ACCOUNT='<service-account-json>' \
 *   pnpm create-super-user <email>
 *
 *   pnpm create-super-user <email> --service-account ./service-account.json
 *
 *   # also set the multi-tenant claim (so useTenant + the grupoEconomico/<id>
 *   # tenant-doc read work in a manual session):
 *   pnpm create-super-user <email> --grupo <grupoEconomicoId>
 *
 * After running, the user must sign out and sign back in for the new claims to
 * take effect (Firebase ID tokens are cached for ~1 hour).
 */
import { getAuth } from 'firebase-admin/auth';
import { rulesClaimsFromBits } from '@delfrance/auth';
import { SUPERUSER_MASK, usuarioSchema } from '@delfrance/schemas';
import { db, getApp } from './admin.js';
import { flagValueError, parseScriptArgs } from './args.js';

export interface CreateSuperUserResult {
  uid: string;
}

export async function createSuperUser(
  email: string,
  options: { serviceAccountPath?: string; grupo?: string } = {},
): Promise<CreateSuperUserResult> {
  getApp(options.serviceAccountPath);
  const auth = getAuth();
  const user = await auth.getUserByEmail(email);

  // Durable flag: a later claims-recompute reads this doc and keeps them super.
  const ref = db(options.serviceAccountPath).collection('usuarios').doc(user.uid);
  const snap = await ref.get();
  if (snap.exists) {
    await ref.set({ isSuperUser: true, jaFoiSuperUser: true }, { merge: true });
  } else {
    const doc = usuarioSchema.parse({
      // `??` keeps an empty/whitespace displayName (Firebase stores ''), which
      // would fail usuarioSchema's nome.min(1); `|| email` falls back instead.
      nome: user.displayName?.trim() || email,
      email,
      isSuperUser: true,
      jaFoiSuperUser: true,
      timestamp: Date.now(),
    });
    await ref.set(doc);
  }

  await auth.setCustomUserClaims(user.uid, {
    permissions: SUPERUSER_MASK.toString(),
    su: true,
    ...rulesClaimsFromBits(SUPERUSER_MASK),
    ...(options.grupo ? { grupoEconomico: options.grupo } : {}),
  });

  return { uid: user.uid };
}

const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('create-super-user.ts') ||
  process.argv[1]?.endsWith('create-super-user.js');

if (isDirectInvocation) {
  const argv = process.argv.slice(2);
  const { email, serviceAccountPath, grupo } = parseScriptArgs(argv);
  if (!email) {
    console.error('Usage: create-super-user <email> [--service-account <path>] [--grupo <id>]');
    process.exit(1);
  }
  const flagErr = flagValueError(argv);
  if (flagErr) {
    console.error(flagErr);
    process.exit(1);
  }

  createSuperUser(email, { serviceAccountPath, grupo })
    .then(({ uid }) => {
      console.log(`✓ ${email} is now a SUPER USER (uid: ${uid})`);
      console.log(
        `  usuarios/${uid}.isSuperUser = true; claims: permissions=SUPERUSER_MASK, su=true`,
      );
      if (grupo) console.log(`  grupoEconomico claim: "${grupo}"`);
      console.log('  Sign out and sign back in to apply the new claims.');
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
