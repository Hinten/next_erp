/**
 * `GET /api/oauth/mercado-livre/callback?code=…&state=…` — #291
 *
 * The OAuth redirect target registered in the Mercado Livre application. **No
 * Bearer token** — it's a browser redirect from ML — so the signed `state` is
 * the only trust anchor: verify it, resolve the `integracao` account, exchange
 * the code for tokens, persist (single-token), and redirect the browser back
 * into the web app. Mirrors apps/melhor-envio's OAuth callback.
 *
 * The whole path is live: `exchangeAndPersist` (`lib/marketplace/mercadoLivre.ts`)
 * exchanges the code, saves the token to the account's `tokenDuravel`
 * subcollection, and denormalizes the ML seller id onto the `integracao` doc so
 * an inbound webhook resolves the account with one equality query.
 */
import { NextResponse } from 'next/server';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoLivreContext } from '@/lib/marketplace/mercadoLivre';
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

  let integracaoId: string;
  try {
    integracaoId = verifyState(state, secret).integracaoId;
  } catch (err) {
    if (err instanceof MarketplaceStateError)
      return backToList({ ml: 'error', reason: 'bad_state' });
    throw err;
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMercadoLivreContext(db, integracaoId);
    await ctx.exchangeAndPersist(code);
    return backToAccount(integracaoId, { ml: 'connected' });
  } catch (err) {
    if (isMercadoLivreError(err))
      return backToAccount(integracaoId, { ml: 'error', reason: 'exchange' });
    throw err;
  }
}
