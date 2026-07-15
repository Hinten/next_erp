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

import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoPagoContext } from '@/lib/payments/mercadoPago';
import { PaymentStateError, verifyState } from '@/lib/payments/state';
import { isMercadoPagoError } from '@/lib/payments/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function webBase(): string {
  return (process.env.WEB_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
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
    if (isMercadoPagoError(err))
      return backToAccount(metodoId, { mp: 'error', reason: 'exchange' });
    throw err;
  }
}
