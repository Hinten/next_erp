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
 * rescue an attempt we have no record of.
 */
import { NextResponse } from 'next/server';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
import { consumeOauthState } from '@/lib/marketplace/oauthStateStore';
import { MarketplaceStateError, verifyState } from '@/lib/marketplace/state';
import { isMercadoLivreError } from '@/lib/marketplace/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function webBase(): string {
  return (process.env.WEB_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
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
    if (isMercadoLivreError(err))
      return backToAccount(integracaoId, { ml: 'error', reason: 'exchange' });
    throw err;
  }
}
