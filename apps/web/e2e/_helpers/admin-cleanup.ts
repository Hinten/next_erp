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
