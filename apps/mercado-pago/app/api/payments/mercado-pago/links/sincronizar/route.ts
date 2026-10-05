/**
 * `POST /api/payments/mercado-pago/links/sincronizar` — pull a pedido's payments
 * from Mercado Pago and reconcile them (#367).
 *
 * Covers the two gaps a webhook cannot: a notification that never arrived, and a
 * link created by the legacy app whose `notification_url` still points at the
 * legacy host. Each payment found goes through the SAME path a webhook takes
 * (`processNotificationPayload`: refetch, collector safety net, map, reconcile,
 * auto-close), so a sync can never write something a notification would not.
 *
 * Body: `sincronizarLinksPagamentoBodySchema` — `{ pedidoId }` and nothing else;
 * the accounts to search are derived server-side from the pedido's own links and
 * payments. Thin on purpose (see `criar/route.ts`); the work is `sincronizarPedido`
 * (`lib/payments/links/sincronizarPedido.ts`).
 *
 * Permission: `PERM_LINK_PAGAMENTO.gerenciar` (`pedido.write | pagamento.write`;
 * `hasPerm` requires both bits) — it WRITES pagamentos and can move the pedido's
 * estado, so it is not the read-only `ler` mask.
 *
 * Responses (verbatim from the orchestration): 200 `{ encontrados, reconciliados,
 * ignorados, falhas, transicoes, truncado }` · 400 `LINK_BODY_INVALIDO` · 404
 * `PEDIDO_NAO_ENCONTRADO` · 409 `LINK_NAO_ELEGIVEL` + `reason` (`semConta`) · 429
 * `MP_REQUISICAO_REPETIDA` (Mercado Pago refuses the same search twice in a
 * minute) · `respond.ts` for any other Mercado Pago failure. A dead grant on ONE
 * account is a `falhas` row (`paymentId: '-'`); only when NO account could be
 * synchronised does it surface as 409 `MP_REAUTH_REQUIRED`.
 */
import { NextResponse } from 'next/server';
import { nowMillis } from '@delfrance/core/datetime';
import { PERM_LINK_PAGAMENTO, sincronizarLinksPagamentoBodySchema } from '@delfrance/schemas';

import { verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { sincronizarPedido } from '@/lib/payments/links/sincronizarPedido';
import { lerCorpo } from '@/lib/payments/lerCorpo';
import { isMercadoPagoError, mercadoPagoErrorResponse } from '@/lib/payments/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM_LINK_PAGAMENTO.gerenciar);
  if ('error' in auth) return auth.error;

  const corpo = await lerCorpo(req, sincronizarLinksPagamentoBodySchema);
  if (!corpo.ok) return corpo.response;

  const db = getAdminFirestore();
  try {
    const r = await sincronizarPedido(db, {
      pedidoId: corpo.data.pedidoId,
      agoraMs: nowMillis(),
    });
    return NextResponse.json(r.corpo, { status: r.status });
  } catch (err) {
    if (isMercadoPagoError(err)) return mercadoPagoErrorResponse(err);
    throw err;
  }
}
