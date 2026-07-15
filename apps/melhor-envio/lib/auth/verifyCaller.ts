/**
 * Bearer-token verification for callable-style routes in apps/melhor-envio.
 *
 * `Authorization: Bearer <idToken>` → `getAdminAuth().verifyIdToken` →
 * permission check against the BigInt-encoded `permissions` claim. Returns
 * either `{ caller }` (success) or `{ error: NextResponse }` (failure with
 * the right status code already prepared).
 *
 * Per-app copy of the same helper apps/integrations and apps/nfe each carry
 * (`apps/nfe/lib/nfe/auth.ts:verifyCaller`) — each server app keeps its own so
 * they deploy and log independently.
 */
import { NextResponse } from 'next/server';
import { FirebaseAppError } from 'firebase-admin/app';
import { FirebaseAuthError } from 'firebase-admin/auth';
import { PERM, hasPerm } from '@delfrance/auth';

import { getAdminAuth } from '@/lib/firebase/admin';

interface ErrorBody {
  readonly error: string;
  readonly code?: string;
}

export function authError(status: number, body: ErrorBody): NextResponse {
  return NextResponse.json(body, { status });
}

export interface VerifiedCaller {
  readonly uid: string;
  readonly permissions: string | undefined;
}

export async function verifyCaller(
  req: Request,
  required: bigint,
): Promise<{ caller: VerifiedCaller } | { error: NextResponse }> {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: authError(401, { error: 'Authorization Bearer token ausente.' }) };
  }
  const idToken = authHeader.slice('Bearer '.length);
  try {
    const decoded = await getAdminAuth().verifyIdToken(idToken);
    const perms = decoded.permissions as string | undefined;
    if (!hasPerm(perms, required)) {
      return { error: authError(403, { error: 'Sem permissão para esta operação.' }) };
    }
    return { caller: { uid: decoded.uid, permissions: perms } };
  } catch (e) {
    // FirebaseAuthError (`code` always 'auth/'-prefixed, e.g.
    // 'auth/id-token-expired') is a token-validation failure → 401.
    // FirebaseAppError (e.g. 'app/invalid-credential') means getAdminAuth()
    // failed to initialize the Admin SDK — an operational failure, not the
    // caller's fault → 500. Anything else is unexpected: rethrow.
    if (e instanceof FirebaseAuthError) {
      const code = e.code;
      console.warn(`[melhor-envio/auth] verifyIdToken rejected: ${code}`);
      return { error: authError(401, { error: `Token inválido ou expirado (${code}).`, code }) };
    }
    if (e instanceof FirebaseAppError) {
      const code = e.code;
      console.error(`[melhor-envio/auth] admin init failed: ${code} - ${e.message}`);
      return {
        error: authError(500, {
          error: `Falha ao inicializar Firebase Admin (${code}).`,
          code,
        }),
      };
    }
    throw e;
  }
}

/** Re-export PERM for ergonomic per-route imports. */
export { PERM };
