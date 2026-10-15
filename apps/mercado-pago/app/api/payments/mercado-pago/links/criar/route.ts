/**
 * `POST /api/payments/mercado-pago/links/criar` — create the Mercado Pago
 * Checkout Pro payment link(s) of a pedido (#367).
 *
 * Body: `criarLinksPagamentoBodySchema` (`@delfrance/schemas`) — the ONE contract
 * this route shares with the web tab. The client mints each link's doc id, so a
 * retried request re-sends the same ids and the server recognises a replay.
 *
 * Thin on purpose: this file authenticates, reads + validates the body and maps
 * errors. Everything else — the account and flag checks, the eligibility rule, the
 * sequential preference creation with its cleanup, the transaction that persists
 * the links and flips the pedido to `aguardandoConfirmacaoDePagamento` — is
 * `criarLinks` (`lib/payments/links/criarLinks.ts`).
 *
 * Permission: `PERM_LINK_PAGAMENTO.gerenciar` = `pedido.write | pagamento.write`.
 * ⚠️ `hasPerm` requires EVERY bit of a mask, so an operator holding only
 * `pedido.write` gets a 403 here — the route flips the pedido's estado AND
 * creates a payment instrument, so it needs both.
 *
 * Responses (the body is the orchestration's, verbatim — `RespostaLink`):
 *  - 201 `{ links, estado, reaproveitado: false }` · 200 `{ …, reaproveitado: true }`
 *    when every link id already existed (a replay: no Mercado Pago call);
 *  - 400 `LINK_BODY_INVALIDO` — not JSON or fails the schema (this route, field
 *    paths only), or an `expiraEm` outside today..today+29 days or whose end is
 *    less than 60 minutes away (`criarLinks`);
 *  - 404 `PEDIDO_NAO_ENCONTRADO` · 404 `MP_CONTA_NAO_CONFIGURADA` (respond.ts);
 *  - 409 `LINK_NAO_ELEGIVEL` + `reason`; 409 `MP_REAUTH_REQUIRED` (respond.ts);
 *  - 502/503/500 from `respond.ts` for a Mercado Pago failure. Anything else
 *    rethrows as a 500.
 */
import { NextResponse } from 'next/server';
import { nowMillis } from '@delfrance/core/datetime';
import { PERM_LINK_PAGAMENTO, criarLinksPagamentoBodySchema } from '@delfrance/schemas';

import { verifyCaller } from '@/lib/auth/verifyCaller';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { criarLinks } from '@/lib/payments/links/criarLinks';
import { lerCorpo } from '@/lib/payments/lerCorpo';
import { isMercadoPagoError, mercadoPagoErrorResponse } from '@/lib/payments/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM_LINK_PAGAMENTO.gerenciar);
  if ('error' in auth) return auth.error;

  const corpo = await lerCorpo(req, criarLinksPagamentoBodySchema);
  if (!corpo.ok) return corpo.response;

  const db = getAdminFirestore();
  try {
    const r = await criarLinks(db, {
      uid: auth.caller.uid,
      corpo: corpo.data,
      agoraMs: nowMillis(),
    });
    return NextResponse.json(r.corpo, { status: r.status });
  } catch (err) {
    if (isMercadoPagoError(err)) return mercadoPagoErrorResponse(err);
    throw err;
  }
}
