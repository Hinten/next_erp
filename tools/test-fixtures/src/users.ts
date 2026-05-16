import { type UserRecord, getAuth } from 'firebase-admin/auth';
import { getApp } from './admin';

/**
 * Ensure a Firebase Auth user exists with the given email + password. Used
 * by Playwright's globalSetup to mint a test user once per run.
 *
 * If the user exists, leaves it alone (idempotent). If it doesn't, creates
 * one with `emailVerified: true` so the login page accepts it without an
 * email verification round-trip.
 */
export async function ensureTestUser(
  email: string,
  password: string,
): Promise<UserRecord> {
  getApp();
  const auth = getAuth();
  try {
    return await auth.getUserByEmail(email);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== 'auth/user-not-found') throw err;
    return await auth.createUser({
      email,
      password,
      emailVerified: true,
      displayName: 'E2E Test User',
    });
  }
}
