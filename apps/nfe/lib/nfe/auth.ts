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
import { OAuth2Client } from 'google-auth-library';
import { PERM, hasPerm } from '@delfrance/auth';

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
    // the public runtime API, so we duck-type on { code: string }. Only
    // codes starting with `auth/` are token-validation failures — anything
    // else (e.g. ENOENT from loading the service-account file) is an
    // admin-init failure and must surface as 500, not 401.
    if (e instanceof Error && typeof (e as { code?: unknown }).code === 'string') {
      const code = (e as Error & { code: string }).code;
      if (code.startsWith('auth/')) {
        console.warn(`[nfe/auth] verifyIdToken rejected: ${code} - ${e.message}`);
        return {
          error: authError(401, {
            error: `Token inválido ou expirado (${code}).`,
            code,
          }),
        };
      }
      console.error(`[nfe/auth] admin init failed: ${code} - ${e.message}`);
      return {
        error: authError(500, {
          error: `Falha ao inicializar Firebase Admin (${code}): ${e.message}`,
          code,
        }),
      };
    }
    throw e;
  }
}

/**
 * A service caller authenticated by a Google **OIDC** token — the identity
 * Cloud Tasks (and Cloud Scheduler) presents. Distinct from `VerifiedCaller`,
 * which is a Firebase Auth user.
 */
export interface VerifiedServiceCaller {
  readonly email: string;
}

// Google's OIDC token verifier — validates signature, expiry and issuer
// (`accounts.google.com`) against Google's public certs. One instance reused
// across requests (it caches the cert set).
const oidcVerifier = new OAuth2Client();

/**
 * Verify a Google-issued OIDC bearer token (Cloud Tasks / Cloud Scheduler).
 *
 * Unlike `verifyCaller`, this does NOT go through Firebase Auth — a Cloud Tasks
 * token is signed by Google, not Firebase's securetoken service, so
 * `verifyIdToken` (Firebase) would reject it. We instead check:
 *   - the token's signature + expiry + issuer (via `OAuth2Client.verifyIdToken`),
 *   - `aud` equals our own endpoint URL (`audience`) — Cloud Tasks set it to the
 *     target URL, so this binds the token to this exact endpoint,
 *   - `email_verified` is true and `email` is in the allow-list (the
 *     `nfe-task-runner` service account).
 *
 * `audience` / `allowedEmails` are passed in (from `NFE_TASKS_ENDPOINT` /
 * `NFE_TASK_SA_EMAILS`) so the route owns the config read and tests can inject.
 */
export async function verifyServiceCaller(
  req: Request,
  opts: { audience: string | undefined; allowedEmails: ReadonlySet<string> },
): Promise<{ service: VerifiedServiceCaller } | { error: NextResponse }> {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: authError(401, { error: 'Authorization Bearer token ausente.' }) };
  }
  if (!opts.audience) {
    return {
      error: authError(500, { error: 'NFE_TASKS_ENDPOINT ausente — não é possível validar a audience OIDC.' }),
    };
  }
  if (opts.allowedEmails.size === 0) {
    return {
      error: authError(500, { error: 'NFE_TASK_SA_EMAILS ausente — nenhuma service account autorizada.' }),
    };
  }
  const idToken = authHeader.slice('Bearer '.length);
  try {
    const ticket = await oidcVerifier.verifyIdToken({ idToken, audience: opts.audience });
    const payload = ticket.getPayload();
    if (
      !payload ||
      payload.email_verified !== true ||
      !payload.email ||
      !opts.allowedEmails.has(payload.email)
    ) {
      return { error: authError(403, { error: 'Service account não autorizada para esta operação.' }) };
    }
    return { service: { email: payload.email } };
  } catch (e) {
    // verifyIdToken throws a plain Error on signature/expiry/audience mismatch.
    if (e instanceof Error) {
      console.warn(`[nfe/auth] verifyServiceCaller rejected OIDC token: ${e.message}`);
      return { error: authError(401, { error: 'Token OIDC inválido ou expirado.' }) };
    }
    throw e;
  }
}

/** Parse the `NFE_TASK_SA_EMAILS` CSV allow-list into a set. */
export function allowedServiceEmails(): ReadonlySet<string> {
  const csv = process.env.NFE_TASK_SA_EMAILS ?? '';
  return new Set(
    csv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Re-export PERM for ergonomic per-route imports. */
export { PERM };
