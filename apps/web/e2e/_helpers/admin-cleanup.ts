/**
 * Admin SDK helpers for e2e cleanup + claim verification. Imports the shared
 * firebase-admin singleton from @delfrance/test-fixtures so credentials and
 * project resolution match the rest of the test infra.
 */
import { getAuth } from 'firebase-admin/auth';
import { db, getApp } from '@delfrance/test-fixtures';

function isErrorWithCode(e: unknown, code: string): boolean {
  if (!(e instanceof Error)) return false;
  const errCode = (e as Error & { code?: unknown }).code;
  return typeof errCode === 'string' && errCode === code;
}

export async function deleteAuthUserByEmail(email: string): Promise<void> {
  const auth = getAuth(getApp());
  try {
    const user = await auth.getUserByEmail(email);
    await auth.deleteUser(user.uid);
  } catch (e) {
    if (isErrorWithCode(e, 'auth/user-not-found')) return;
    throw e;
  }
}

/** Ephemeral e2e users older than this are considered leaked and swept. */
const STALE_E2E_USER_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Delete leftover ephemeral e2e users — `e2e-user-*` accounts older than 24h.
 * A run that crashes before `globalTeardown` leaks its user; this sweep, run
 * at the start of `globalSetup`, keeps them from piling up. Returns the count
 * deleted.
 */
export async function sweepStaleE2EUsers(): Promise<number> {
  const auth = getAuth(getApp());
  const cutoff = Date.now() - STALE_E2E_USER_AGE_MS;
  let deleted = 0;
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    const staleUids = page.users
      .filter(
        (u) =>
          (u.email?.startsWith('e2e-user-') ?? false) &&
          Date.parse(u.metadata.creationTime) < cutoff,
      )
      .map((u) => u.uid);
    if (staleUids.length > 0) {
      await auth.deleteUsers(staleUids);
      deleted += staleUids.length;
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return deleted;
}

export async function deleteUsuarioDoc(uid: string): Promise<void> {
  await db().collection('usuarios').doc(uid).delete();
}

export async function deleteCargoById(id: string): Promise<void> {
  await db().collection('cargos').doc(id).delete();
}

export async function getUserPermissionsClaim(email: string): Promise<string | null> {
  const auth = getAuth(getApp());
  const user = await auth.getUserByEmail(email);
  const claims = user.customClaims ?? {};
  const perms = claims['permissions'];
  return typeof perms === 'string' ? perms : null;
}
