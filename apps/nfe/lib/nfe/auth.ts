/**
 * Bearer-token verification for /api/nfe/* routes.
 *
 * Mirrors the pattern in `apps/integrations/app/api/admin/users/route.ts`:
 * `Authorization: Bearer <idToken>` → `getAdminAuth().verifyIdToken` →
 * permission check via the BigInt-encoded `permissions` claim.
 *
 * Returns either `{ decoded }` (success) or `{ error: NextResponse }`
 * (failure with the right status code already prepared).
 */
import { NextResponse } from 'next/server';
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
    // firebase-admin throws FirebaseAuthError (an Error subclass with a
    // string `code` like 'auth/id-token-expired'). The class isn't part of
    // the public runtime API, so we duck-type on { code: string }.
    if (e instanceof Error && typeof (e as { code?: unknown }).code === 'string') {
      return { error: authError(401, { error: 'Token inválido ou expirado.' }) };
    }
    throw e;
  }
}

/** Re-export PERM for ergonomic per-route imports. */
export { PERM };
