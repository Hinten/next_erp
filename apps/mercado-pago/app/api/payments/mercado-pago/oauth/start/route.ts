/**
 * `GET /api/payments/mercado-pago/oauth/start?metodoId=…`
 *
 * Mints the signed-state Mercado Pago consent URL for a `metodo_pgto` account
 * and returns it as JSON. The browser then navigates there. The Bearer token
 * (PERM.metodoPagamento.write) authorizes minting the state; the state itself
 * is the integrity guarantee the public callback verifies.
 */
import { NextResponse } from 'next/server';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoPagoContext } from '@/lib/payments/mercadoPago';
import { signState } from '@/lib/payments/state';
import { isMercadoPagoError, mercadoPagoErrorResponse } from '@/lib/payments/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.metodoPagamento.write);
  if ('error' in auth) return auth.error;

  const metodoId = new URL(req.url).searchParams.get('metodoId');
  if (!metodoId) {
    return NextResponse.json({ error: 'metodoId é obrigatório.' }, { status: 400 });
  }

  const secret = process.env.MERCADO_PAGO_STATE_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'MERCADO_PAGO_STATE_SECRET não configurado.' },
      { status: 500 },
    );
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMercadoPagoContext(db, metodoId);
    const state = signState(metodoId, secret);
    const authorizeUrl = ctx.authorizeUrl(state);
    return NextResponse.json({ authorizeUrl });
  } catch (err) {
    if (isMercadoPagoError(err)) return mercadoPagoErrorResponse(err);
    throw err;
  }
}
