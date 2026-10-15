/**
 * Bearer-token verification for /api/nfe/* routes.
 *
 * The shared guard owns token/permission decisions. This adapter supplies the
 * app-specific Admin client, diagnostics and NextResponse construction.
 *
 * There is no OIDC service-caller path: the async reconciler runs in-process
 * inside the nfe Cloud Functions codebase; these routes admit Firebase users.
 */
import { NextResponse } from 'next/server';
import { FirebaseAppError } from 'firebase-admin/app';
import { FirebaseAuthError } from 'firebase-admin/auth';
import { createCallerVerifier, type VerifiedCaller } from '@delfrance/data/admin/auth';

import { getAdminAuth } from '@/lib/firebase/admin';

interface ErrorBody {
  readonly error: string;
  readonly code?: string;
  /** SEFAZ status code + reason, when the failure is a fiscal rejection. */
  readonly cStat?: string;
  readonly xMotivo?: string;
}

export function authError(status: number, body: ErrorBody): NextResponse {
  return NextResponse.json(body, { status });
}

const verifyCallerCore = createCallerVerifier({
  getAdminAuth,
  authErrorType: FirebaseAuthError,
  appErrorType: FirebaseAppError,
  logPrefix: 'nfe/auth',
  includeAuthErrorMessageInLog: true,
  includeAdminErrorMessageInResponse: true,
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
