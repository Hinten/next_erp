/**
 * `GET /api/oauth/mercado-livre/callback?code=…&state=…` — #291
 *
 * The OAuth redirect target registered in the Mercado Livre application. **No
 * Bearer token** — it's a browser redirect from ML — so the signed `state` is
 * the only trust anchor: verify it, redeem the attempt it names, resolve the
 * `integracao` account, exchange the code for tokens, persist (single-token),
 * and redirect the browser back into the web app. Mirrors apps/melhor-envio's
 * OAuth callback.
 *
 * ⚠️ #821: verifying the signature is NOT enough. A signed state stays valid for
 * its whole freshness window, so a captured one could be replayed to drive a
 * second consent and overwrite the account's credential. `consumeOauthState` is
 * the anchor that makes the state single-use, and it also yields the PKCE
 * `code_verifier` for the exchange. It runs BEFORE the exchange and its failure
 * is a `bad_state`, not an `exchange` error — nothing about the ML `code` can
 * rescue an attempt we have no record of. Note the two failure vocabularies are
 * deliberately disjoint: a state/attempt problem is `bad_state`, and only a
 * genuine exchange failure reaches {@link exchangeFailureReason} (#1014).
 */
import { NextResponse } from 'next/server';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
} from '@delfrance/integrations-mercado-livre';

import { getAdminFirestore } from '@/lib/firebase/admin';
import {
  MercadoLivreConfigError,
  MercadoLivreContaNotConfiguredError,
  loadMercadoLivreContext,
  mercadoLivreRedirectUri,
} from '@/lib/marketplace/mercadoLivre';
import { consumeOauthState } from '@/lib/marketplace/oauthStateStore';
import { MarketplaceStateError, verifyState } from '@/lib/marketplace/state';
import { isMercadoLivreError } from '@/lib/marketplace/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * ⚠️ `??` guards only `undefined`/`null`, so a BLANK `WEB_APP_URL=` would yield
 * `base === ''` and redirect the browser to a relative-looking URL. Treat blank as
 * unset — same `??`-versus-empty-string hole #887 fixed for `*_TASKS_REGION`, and
 * the same one `mercadoLivreRedirectUri()` carries.
 */
function webBase(): string {
  const raw = process.env.WEB_APP_URL?.trim();
  return (raw && raw.length > 0 ? raw : 'http://localhost:3000').replace(/\/$/, '');
}

/**
 * Map a failure to a DISTINCT redirect `reason`.
 *
 * `isMercadoLivreError` matches five disjoint families — missing server credentials,
 * a bad integração doc, an ML rejection, a dead code, a network failure — and this
 * route used to collapse all of them into the single word `exchange`. That made a
 * misconfigured backend indistinguishable from an expired authorization code, from
 * the browser and from the logs alike.
 *
 * Slugs only: never put ML's error text in a query string. `exchange` stays as the
 * fallback so an unrecognised member of the guard still redirects instead of 500ing.
 *
 * ⚠️ `server_config`, not `config` — `config` already means "the state secret is
 * unset" on the LIST page, and reusing it here would merge two unrelated causes.
 */
function exchangeFailureReason(err: unknown): string {
  if (err instanceof MercadoLivreConfigError) return 'server_config';
  if (err instanceof MercadoLivreContaNotConfiguredError) return 'conta';
  if (err instanceof MercadoLivreReauthRequiredError) return 'codigo_invalido';
  if (err instanceof MercadoLivreHttpError) return 'ml_rejeitou';
  if (err instanceof MercadoLivreNetworkError) return 'rede';
  return 'exchange';
}

/**
 * The ML response detail, when the error carries one. Both classes below hold the
 * parsed body; `MercadoLivreReauthRequiredError` only started doing so alongside
 * this change (it previously dropped status + body for `invalid_grant`, which is
 * the single most likely code-exchange failure).
 */
function errorDetail(err: unknown): { status?: number | null; body?: unknown } {
  if (err instanceof MercadoLivreHttpError) return { status: err.status, body: err.body };
  if (err instanceof MercadoLivreReauthRequiredError) return { status: err.status, body: err.body };
  return {};
}

/** Redirect to a specific Mercado Livre account page with status params. */
function backToAccount(integracaoId: string, params: Record<string, string>): NextResponse {
  const url = new URL(`${webBase()}/canais/mercado-livre/${integracaoId}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url.toString());
}

/** Redirect to the account list (used before a trustworthy id is known). */
function backToList(params: Record<string, string>): NextResponse {
  const url = new URL(`${webBase()}/canais/mercado-livre`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url.toString());
}

export async function GET(req: Request): Promise<NextResponse> {
  const params = new URL(req.url).searchParams;
  const code = params.get('code');
  const state = params.get('state');

  const secret = process.env.MERCADO_LIVRE_STATE_SECRET;
  if (!secret) return backToList({ ml: 'error', reason: 'config' });
  if (!code || !state) return backToList({ ml: 'error', reason: 'missing_params' });

  const db = getAdminFirestore();

  let integracaoId: string;
  let codeVerifier: string | null;
  try {
    const verified = verifyState(state, secret);
    integracaoId = verified.integracaoId;
    // Single-use: a replay of this same state finds the attempt consumed and
    // lands here as `bad_state`, before anything touches the credential.
    ({ codeVerifier } = await consumeOauthState(db, integracaoId, verified.nonce));
  } catch (err) {
    if (err instanceof MarketplaceStateError)
      return backToList({ ml: 'error', reason: 'bad_state' });
    throw err;
  }

  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);
    await ctx.exchangeAndPersist(code, codeVerifier ?? undefined);
    return backToAccount(integracaoId, { ml: 'connected' });
  } catch (err) {
    if (isMercadoLivreError(err)) {
      const reason = exchangeFailureReason(err);
      // The ONLY record of this failure. Without it the operator sees a six-character
      // slug in a toast and nothing else — which is exactly how a broken connect stayed
      // undiagnosable. `redirectUri` is included because it is computed from env and is
      // otherwise unobservable from outside the running backend.
      //
      // ⚠️ Never log the `code`, the client secret, or any token: `code` is a live
      // credential until it is exchanged, and Cloud Logging is broadly readable.
      console.error('[mercado-livre/oauth-callback] falha ao trocar o code por tokens', {
        integracaoId,
        reason,
        erro: err.name,
        mensagem: err.message,
        redirectUri: mercadoLivreRedirectUri(),
        ...errorDetail(err),
      });
      return backToAccount(integracaoId, { ml: 'error', reason });
    }
    throw err;
  }
}
