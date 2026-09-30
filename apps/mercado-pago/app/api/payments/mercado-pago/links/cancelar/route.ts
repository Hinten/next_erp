/**
 * `POST /api/payments/mercado-pago/links/cancelar` — cancel ONE open payment link
 * of a pedido (#367): expire its Mercado Pago preference so the link stops being
 * payable, then mark the link doc `cancelado`.
 *
 * Body: `cancelarLinkPagamentoBodySchema` — `{ pedidoId, linkId }` and NOTHING else.
 * ⚠️ There is deliberately no `metodoId`: the account is read from the link doc's
 * own `contaMercadoPagoOuterRef`, never from the request, and the strict schema
 * turns a smuggled one into a 400 instead of ignoring it.
 *
 * Thin on purpose (see `criar/route.ts`); the work is `cancelarLink`
 * (`lib/payments/links/cancelarLink.ts`). The pedido's estado is NOT reverted.
 *
 * Permission: `PERM_LINK_PAGAMENTO.gerenciar` (`pedido.write | pagamento.write`;
 * `hasPerm` requires both bits).
 *
 * Responses (verbatim from the orchestration): 200 `{ linkId, status }` (also for a
 * link that was already terminal — no Mercado Pago call) · 400 `LINK_BODY_INVALIDO`
 * · 404 `LINK_NAO_ENCONTRADO` · 409 `LINK_NAO_ELEGIVEL` + `reason`
 * (`preferenciaInacessivel` — a legacy-app preference the new app cannot touch —
 * or `semPreferencia`) · `respond.ts` for a Mercado Pago failure.
 */
import { NextResponse } from 'next/server';
import { nowMillis } from '@delfrance/core/datetime';
import { PERM_LINK_PAGAMENTO, cancelarLinkPagamentoBodySchema } from '@delfrance/schemas';

import { verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { cancelarLink } from '@/lib/payments/links/cancelarLink';
import { lerCorpo } from '@/lib/payments/lerCorpo';
import { isMercadoPagoError, mercadoPagoErrorResponse } from '@/lib/payments/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM_LINK_PAGAMENTO.gerenciar);
  if ('error' in auth) return auth.error;

  const corpo = await lerCorpo(req, cancelarLinkPagamentoBodySchema);
  if (!corpo.ok) return corpo.response;

  const db = getAdminFirestore();
  try {
    const r = await cancelarLink(db, {
      uid: auth.caller.uid,
      pedidoId: corpo.data.pedidoId,
      linkId: corpo.data.linkId,
      agoraMs: nowMillis(),
    });
    return NextResponse.json(r.corpo, { status: r.status });
  } catch (err) {
    if (isMercadoPagoError(err)) return mercadoPagoErrorResponse(err);
    throw err;
  }
}
