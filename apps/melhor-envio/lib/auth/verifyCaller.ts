/**
 * Thin binding to the shared Bearer/permission guard (#1431). The Admin client,
 * log label and NextResponse construction stay local to this backend.
 */
import { NextResponse } from 'next/server';
import { FirebaseAppError } from 'firebase-admin/app';
import { FirebaseAuthError } from 'firebase-admin/auth';
import { createCallerVerifier, type VerifiedCaller } from '@delfrance/data/admin/auth';

import { getAdminAuth } from '@/lib/firebase/admin';

interface ErrorBody {
  readonly error: string;
  readonly code?: string;
}

export function authError(status: number, body: ErrorBody): NextResponse {
  return NextResponse.json(body, { status });
}

const verifyCallerCore = createCallerVerifier({
  getAdminAuth,
  authErrorType: FirebaseAuthError,
  appErrorType: FirebaseAppError,
  logPrefix: 'melhor-envio/auth',
});

export async function verifyCaller(
  req: Request,
  required: bigint,
): Promise<{ caller: VerifiedCaller } | { error: NextResponse }> {
  const result = await verifyCallerCore(req, required);
  return 'error' in result ? { error: authError(result.error.status, result.error.body) } : result;
}

export type { VerifiedCaller };
/** Re-export PERM for ergonomic per-route imports. */
export { PERM } from '@delfrance/auth';
