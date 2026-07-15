/**
 * `GET /api/payments/mercado-pago/conta?metodoId=…`
 *
 * Connection status for a Mercado Pago account: `/users/me` when a valid (or
 * refreshable) credential exists. A dead/absent credential is **not** an error
 * here — the whole point is to render the disconnected state — so it returns
 * `{ connected: false }` instead of 409. Requires PERM.metodoPagamento.read.
 * Mirrors apps/mercado-livre's `conta` route.
 */
import { NextResponse } from 'next/server';
import {
  MercadoPagoReauthRequiredError,
  createMercadoPagoApi,
} from '@delfrance/integrations-mercado-pago';
import { metodoPagamentoCollection } from '@delfrance/data/admin/collections';

import { PERM, verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { loadMercadoPagoContext } from '@/lib/payments/mercadoPago';
import { isMercadoPagoError, mercadoPagoErrorResponse } from '@/lib/payments/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.metodoPagamento.read);
  if ('error' in auth) return auth.error;

  const metodoId = new URL(req.url).searchParams.get('metodoId');
  if (!metodoId) {
    return NextResponse.json({ error: 'metodoId é obrigatório.' }, { status: 400 });
  }

  const db = getAdminFirestore();
  try {
    const ctx = await loadMercadoPagoContext(db, metodoId);
    const accessToken = await ctx.resolveAccessToken();
    const api = createMercadoPagoApi({ getAccessToken: async () => accessToken });
    const me = await api.getMe();
    // Heal the denormalized collector id if it drifted (e.g. the OAuth
    // callback's merge failed after the credential was already persisted) —
    // the webhook receiver resolves accounts by this field.
    if (me.id != null && ctx.conta.user_id !== me.id) {
      await metodoPagamentoCollection.merge(db, {}, metodoId, { user_id: me.id });
    }
    return NextResponse.json({
      connected: true,
      me: { id: me.id, nickname: me.nickname ?? null, email: me.email ?? null },
    });
  } catch (err) {
    // A missing/expired credential is the "not connected" state, not a failure.
    if (err instanceof MercadoPagoReauthRequiredError) {
      return NextResponse.json({ connected: false, me: null });
    }
    if (isMercadoPagoError(err)) return mercadoPagoErrorResponse(err);
    throw err;
  }
}
