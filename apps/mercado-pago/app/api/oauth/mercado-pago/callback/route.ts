/**
 * `GET /api/oauth/mercado-pago/callback?code=…&state=…`
 *
 * The OAuth redirect target registered in the Mercado Pago application. **No
 * Bearer token** — it's a browser redirect from MP — so the signed `state` is
 * the only trust anchor: verify it, **redeem the attempt it names**, resolve the
 * `metodo_pgto` account, exchange the code for tokens, persist (single-token),
 * and redirect the browser back into the web app. Mirrors apps/mercado-livre's
 * OAuth callback.
 *
 * ⚠️ #1034: verifying the signature is NOT enough. A signed state stays valid for
 * its whole freshness window, so a captured one could be replayed to drive a
 * second consent — and here that repoints the account at the attacker's MP
 * collector, which means CUSTOMER PAYMENTS land in a stranger's account.
 * `mercadoPagoOauthState.consume` is the anchor that makes the state single-use,
 * and it also yields the PKCE `code_verifier` for the exchange. It runs BEFORE
 * the exchange and its failure is `bad_state`, not an `exchange` error — nothing
 * about the MP `code` can rescue an attempt we have no record of.
 */
import { NextResponse } from 'next/server';

import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoPagoContext } from '@/lib/payments/mercadoPago';
import { mercadoPagoOauthState } from '@/lib/payments/oauthState';
import { PaymentStateError, verifyState } from '@/lib/payments/state';
import { isMercadoPagoError } from '@/lib/payments/respond';

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

  const db = getAdminFirestore();

  let metodoId: string;
  let codeVerifier: string | null;
  try {
    const verified = verifyState(state, secret);
    metodoId = verified.id;
    // Single-use: a replay of this same state finds the attempt consumed and
    // lands here as `bad_state`, before anything touches the credential.
    ({ codeVerifier } = await mercadoPagoOauthState.consume(db, metodoId, verified.nonce));
  } catch (err) {
    if (err instanceof PaymentStateError) return backToList({ mp: 'error', reason: 'bad_state' });
    throw err;
  }

  try {
    const ctx = await loadMercadoPagoContext(db, metodoId);
    await ctx.exchangeAndPersist(code, codeVerifier ?? undefined);
    return backToAccount(metodoId, { mp: 'connected' });
  } catch (err) {
    if (isMercadoPagoError(err))
      return backToAccount(metodoId, { mp: 'error', reason: 'exchange' });
    throw err;
  }
}
