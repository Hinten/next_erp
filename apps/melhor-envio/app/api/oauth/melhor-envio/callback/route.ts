/**
 * `GET /api/oauth/melhor-envio/callback?code=…&state=…`
 *
 * The OAuth redirect target registered in the Melhor Envio app. **No
 * Bearer token** — it's a browser redirect from ME — so the signed
 * `state` is the only trust anchor: verify it, **redeem the attempt it
 * names**, resolve the int_frete account, exchange the code for tokens,
 * persist (single-token), and redirect the browser back into the web app.
 *
 * ⚠️ #1034: verifying the signature is NOT enough. A signed state stays valid for
 * its whole freshness window, so a captured one could be replayed to drive a
 * second consent — and here that overwrote the account's Melhor Envio token with
 * the attacker's, which means labels bought afterwards are billed to whoever owns
 * that account. `melhorEnvioOauthState.consume` is the anchor that makes the
 * state single-use. It runs BEFORE the exchange and its failure is `bad_state`,
 * not an `exchange` error — nothing about the ME `code` can rescue an attempt we
 * have no record of.
 */
import { NextResponse } from 'next/server';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMelhorEnvioContext } from '@/lib/freight/melhorEnvio';
import { melhorEnvioOauthState } from '@/lib/freight/oauthState';
import { FreightStateError, verifyState } from '@/lib/freight/state';
import { isMelhorEnvioError } from '@/lib/freight/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * ⚠️ `??` guards only `undefined`/`null`, so a BLANK `WEB_APP_URL=` would yield
 * `base === ''` and redirect the browser to a relative-looking URL. Treat blank
 * as unset — the same `??`-versus-empty-string hole #887 fixed for
 * `*_TASKS_REGION` and #1014 fixed in the Mercado Livre callback.
 */
function webBase(): string {
  const raw = process.env.WEB_APP_URL?.trim();
  return (raw && raw.length > 0 ? raw : 'http://localhost:3000').replace(/\/$/, '');
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

  const db = getAdminFirestore();

  let intFreteId: string;
  try {
    const verified = verifyState(state, secret);
    intFreteId = verified.id;
    // Single-use: a replay of this same state finds the attempt consumed and
    // lands here as `bad_state`, before anything touches the credential.
    await melhorEnvioOauthState.consume(db, intFreteId, verified.nonce);
  } catch (err) {
    if (err instanceof FreightStateError) return backToList({ me: 'error', reason: 'bad_state' });
    throw err;
  }

  try {
    const ctx = await loadMelhorEnvioContext(db, intFreteId);
    await ctx.exchangeAndPersist(code);
    return backToAccount(intFreteId, { me: 'connected' });
  } catch (err) {
    if (isMelhorEnvioError(err))
      return backToAccount(intFreteId, { me: 'error', reason: 'exchange' });
    throw err;
  }
}
