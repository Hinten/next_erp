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

import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMelhorEnvioContext } from '@/lib/freight/melhorEnvio';
import { FreightStateError, verifyState } from '@/lib/freight/state';
import { isMelhorEnvioError } from '@/lib/freight/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function webBase(): string {
  return (process.env.WEB_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
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
    if (isMelhorEnvioError(err))
      return backToAccount(intFreteId, { me: 'error', reason: 'exchange' });
    throw err;
  }
}
