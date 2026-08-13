/**
 * `GET /api/oauth/mercado-pago/callback?code=…&state=…`
 *
 * The OAuth redirect target registered in the Mercado Pago application. **No
 * Bearer token** — it's a browser redirect from MP — so the signed `state` is
 * the only trust anchor: verify it, resolve the `metodo_pgto` account, exchange
 * the code for tokens, persist (single-token), and redirect the browser back
 * into the web app. Mirrors apps/mercado-livre's OAuth callback.
 */
import { NextResponse } from 'next/server';
import {
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  MercadoPagoReauthRequiredError,
  MercadoPagoValidationError,
} from '@delfrance/integrations-mercado-pago';

import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  MercadoPagoConfigError,
  MercadoPagoContaNotConfiguredError,
  loadMercadoPagoContext,
  mercadoPagoRedirectUri,
} from '@/lib/payments/mercadoPago';
import { PaymentStateError, verifyState } from '@/lib/payments/state';
import { isMercadoPagoError } from '@/lib/payments/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * ⚠️ `??` guards only `undefined`/`null`, so a BLANK `WEB_APP_URL=` would yield
 * `base === ''` and `new URL('/pagamentos/…')` would THROW — a 500 page instead of
 * any redirect at all. Treat blank as unset. Same `??`-versus-empty-string hole
 * #887 fixed for `*_TASKS_REGION`.
 */
function webBase(): string {
  const raw = process.env.WEB_APP_URL?.trim();
  return (raw && raw.length > 0 ? raw : 'http://localhost:3000').replace(/\/$/, '');
}

/**
 * Map a failure to a DISTINCT redirect `reason`.
 *
 * `isMercadoPagoError` matches SEVEN families and this route used to collapse all
 * of them into the single word `exchange`, so a backend missing its credentials was
 * indistinguishable from an expired code — in the browser and in the (absent) logs
 * alike.
 *
 * ⚠️ Order is load-bearing: `MercadoPagoError` is the base of the plugin hierarchy,
 * so it can only be the final fallback. Mirrors the discrimination order already in
 * `lib/payments/respond.ts`.
 *
 * Slugs only — never MP's error text in a query string. `server_config`, not
 * `config`: `config` already means "state secret unset" on the LIST page.
 */
function exchangeFailureReason(err: unknown): string {
  if (err instanceof MercadoPagoConfigError) return 'server_config';
  if (err instanceof MercadoPagoContaNotConfiguredError) return 'conta';
  if (err instanceof MercadoPagoReauthRequiredError) return 'codigo_invalido';
  if (err instanceof MercadoPagoHttpError) return 'mp_recusou';
  if (err instanceof MercadoPagoValidationError) return 'resposta_invalida';
  if (err instanceof MercadoPagoNetworkError) return 'rede';
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

/** The MP response detail, when the error carries one. */
function errorDetail(err: unknown): {
  status?: number | null;
  body?: unknown;
  camposInvalidos?: readonly string[];
} {
  if (err instanceof MercadoPagoHttpError) return { status: err.status, body: err.body };
  if (err instanceof MercadoPagoReauthRequiredError) return { status: err.status, body: err.body };
  // ⚠️ No body for a validation failure: that arm fires on a 200 whose body did
  // not parse, and such a body is the TOKEN RESPONSE — a 200 that merely lacked a
  // required field still carries a live `access_token`. The failing field names
  // are the diagnosis; the payload is a credential.
  if (err instanceof MercadoPagoValidationError)
    return { camposInvalidos: validationPaths(err.issues) };
  return {};
}

/** Redirect to a specific Mercado Pago account page with status params. */
function backToAccount(metodoId: string, params: Record<string, string>): NextResponse {
  const url = new URL(`${webBase()}/pagamentos/mercado-pago/${metodoId}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url.toString());
}

/** Redirect to the account list (used before a trustworthy id is known). */
function backToList(params: Record<string, string>): NextResponse {
  const url = new URL(`${webBase()}/pagamentos/mercado-pago`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url.toString());
}

export async function GET(req: Request): Promise<NextResponse> {
  const params = new URL(req.url).searchParams;
  const code = params.get('code');
  const state = params.get('state');

  const secret = process.env.MERCADO_PAGO_STATE_SECRET;
  if (!secret) return backToList({ mp: 'error', reason: 'config' });
  if (!code || !state) return backToList({ mp: 'error', reason: 'missing_params' });

  let metodoId: string;
  try {
    metodoId = verifyState(state, secret).metodoId;
  } catch (err) {
    if (err instanceof PaymentStateError) return backToList({ mp: 'error', reason: 'bad_state' });
    throw err;
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMercadoPagoContext(db, metodoId);
    await ctx.exchangeAndPersist(code);
    return backToAccount(metodoId, { mp: 'connected' });
  } catch (err) {
    if (isMercadoPagoError(err)) {
      const reason = exchangeFailureReason(err);
      // The ONLY record of this failure — this app logged nothing at all on the
      // OAuth path. `redirectUri` is included because it is computed from env and
      // is otherwise unobservable from outside the running backend.
      //
      // ⚠️ Never log the `code`, the client secret, or any token: `code` is a live
      // credential until exchanged, and Cloud Logging is broadly readable.
      console.error('[mercado-pago/oauth-callback] falha ao trocar o code por tokens', {
        metodoId,
        reason,
        erro: err.name,
        mensagem: err.message,
        redirectUri: mercadoPagoRedirectUri(),
        ...errorDetail(err),
      });
      return backToAccount(metodoId, { mp: 'error', reason });
    }
    throw err;
  }
}
