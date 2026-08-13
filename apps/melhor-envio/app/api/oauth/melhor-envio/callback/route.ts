/**
 * `GET /api/oauth/melhor-envio/callback?code=…&state=…`
 *
 * The OAuth redirect target registered in the Melhor Envio app. **No
 * Bearer token** — it's a browser redirect from ME — so the signed
 * `state` is the only trust anchor: verify it, resolve the int_frete
 * account, exchange the code for tokens, persist (single-token), and
 * redirect the browser back into the web app.
 */
import { NextResponse } from 'next/server';
import {
  MelhorEnvioHttpError,
  MelhorEnvioNetworkError,
  MelhorEnvioReauthRequiredError,
  MelhorEnvioSchemaError,
} from '@delfrance/integrations-freight-br';

import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  MelhorEnvioConfigError,
  MelhorEnvioContaNotConfiguredError,
  loadMelhorEnvioContext,
  melhorEnvioRedirectUri,
} from '@/lib/freight/melhorEnvio';
import { FreightStateError, verifyState } from '@/lib/freight/state';
import { isMelhorEnvioError } from '@/lib/freight/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * ⚠️ `??` guards only `undefined`/`null`, so a BLANK `WEB_APP_URL=` yielded
 * `base === ''` and `new URL('/logistica/…')` THREW — a 500 page instead of any
 * redirect at all. Treat blank as unset. Same `??`-versus-empty-string hole #887
 * fixed for `*_TASKS_REGION`, and the one `melhorEnvioRedirectUri()` carries.
 */
function webBase(): string {
  const raw = process.env.WEB_APP_URL?.trim();
  return (raw && raw.length > 0 ? raw : 'http://localhost:3000').replace(/\/$/, '');
}

/** ME's `invalid_grant` shape: it never special-cases the code, unlike ML. */
function isInvalidGrant(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  return (body as { error?: unknown }).error === 'invalid_grant';
}

/**
 * Map a failure to a DISTINCT redirect `reason`.
 *
 * `isMelhorEnvioError` matches SEVEN families and this route used to collapse all
 * of them into the single word `exchange`, so a backend missing its credentials
 * was indistinguishable from an expired code — in the browser and in the (absent)
 * logs alike.
 *
 * ⚠️ Two ME-specific traps, both of which a copy of the Mercado Livre mapper gets
 * wrong:
 *   1. ME never special-cases `invalid_grant` in the package — an expired or reused
 *      authorization code arrives as a plain `MelhorEnvioHttpError`. So
 *      `codigo_invalido` must come from the BODY, not from `instanceof`.
 *   2. Order matters: `MelhorEnvioNetworkError` and `MelhorEnvioSchemaError` both
 *      extend the base, so the base can only be the final fallback.
 *
 * Slugs only — never ME's error text in a query string. `server_config`, not
 * `config`: `config` already means "state secret unset" on the LIST page.
 */
function exchangeFailureReason(err: unknown): string {
  if (err instanceof MelhorEnvioConfigError) return 'server_config';
  if (err instanceof MelhorEnvioContaNotConfiguredError) return 'conta';
  if (err instanceof MelhorEnvioReauthRequiredError) return 'codigo_invalido';
  if (err instanceof MelhorEnvioHttpError)
    return isInvalidGrant(err.body) ? 'codigo_invalido' : 'me_recusou';
  if (err instanceof MelhorEnvioSchemaError) return 'resposta_invalida';
  if (err instanceof MelhorEnvioNetworkError) return 'rede';
  return 'exchange';
}

/**
 * Zod issue PATHS and codes — never the issue objects themselves.
 *
 * An issue can carry the offending input, and the value under inspection here is a
 * TOKEN RESPONSE: logging raw issues risks putting a live access_token into Cloud
 * Logging. `refresh_token: invalid_type` is the whole diagnostic value.
 */
function validationPaths(issues: unknown): readonly string[] {
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) => {
    // ⚠️ Guard the ELEMENT, not just the array. `issues` is typed `unknown`, and
    // destructuring a `null` entry throws a TypeError — from inside the catch
    // block, where it would replace the redirect with a 500. A helper whose whole
    // job is to make a failure legible must not be able to cause a worse one.
    if (typeof issue !== 'object' || issue === null) return '(desconhecido)';
    const { path, code } = issue as { path?: unknown; code?: unknown };
    const caminho = Array.isArray(path) && path.length > 0 ? path.join('.') : '(raiz)';
    return `${caminho}: ${typeof code === 'string' ? code : 'desconhecido'}`;
  });
}

/** The ME response detail, when the error carries one. */
function errorDetail(err: unknown): {
  status?: number | null;
  body?: unknown;
  camposInvalidos?: readonly string[];
} {
  if (err instanceof MelhorEnvioHttpError) return { status: err.status, body: err.body };
  if (err instanceof MelhorEnvioReauthRequiredError) return { status: err.status, body: err.body };
  // ⚠️ Deliberately NOT `err.body` here. On a schema error the body is the
  // TOKEN RESPONSE itself — a 200 that merely lacked a required field still
  // carries a live `access_token`. The failing field names are the diagnosis;
  // the payload is a credential. (`MelhorEnvioHttpError`'s body is safe by
  // contrast: it is a non-2xx ERROR body.)
  if (err instanceof MelhorEnvioSchemaError)
    return { camposInvalidos: validationPaths(err.issues) };
  return {};
}

/** Redirect to a specific Melhor Envio account page with status params. */
function backToAccount(intFreteId: string, params: Record<string, string>): NextResponse {
  const url = new URL(`${webBase()}/logistica/melhor-envios/${intFreteId}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url.toString());
}

/** Redirect to the account list (used before a trustworthy id is known). */
function backToList(params: Record<string, string>): NextResponse {
  const url = new URL(`${webBase()}/logistica/melhor-envios`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url.toString());
}

export async function GET(req: Request): Promise<NextResponse> {
  const params = new URL(req.url).searchParams;
  const code = params.get('code');
  const state = params.get('state');

  const secret = process.env.MELHOR_ENVIO_STATE_SECRET;
  if (!secret) return backToList({ me: 'error', reason: 'config' });
  if (!code || !state) return backToList({ me: 'error', reason: 'missing_params' });

  let intFreteId: string;
  try {
    intFreteId = verifyState(state, secret).intFreteId;
  } catch (err) {
    if (err instanceof FreightStateError) return backToList({ me: 'error', reason: 'bad_state' });
    throw err;
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMelhorEnvioContext(db, intFreteId);
    await ctx.exchangeAndPersist(code);
    return backToAccount(intFreteId, { me: 'connected' });
  } catch (err) {
    if (isMelhorEnvioError(err)) {
      const reason = exchangeFailureReason(err);
      // The ONLY record of this failure — this app logged nothing at all on the
      // OAuth path. `redirectUri` is included because it is computed from env and
      // is otherwise unobservable from outside the running backend.
      //
      // ⚠️ Never log the `code`, the client secret, or any token: `code` is a live
      // credential until exchanged, and Cloud Logging is broadly readable.
      console.error('[melhor-envio/oauth-callback] falha ao trocar o code por tokens', {
        intFreteId,
        reason,
        erro: err.name,
        mensagem: err.message,
        redirectUri: melhorEnvioRedirectUri(),
        ...errorDetail(err),
      });
      return backToAccount(intFreteId, { me: 'error', reason });
    }
    throw err;
  }
}
