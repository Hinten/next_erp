/**
 * `cancelar` — the orchestration behind `POST …/links/cancelar` (#367): withdraw
 * ONE payment link by expiring its Mercado Pago preference and marking the doc
 * `cancelado`.
 *
 * The order is the safety: the PUT comes FIRST and the doc is marked only after
 * Mercado Pago accepted it. Marking first would show a "cancelled" link that is
 * still payable; a failed PUT leaves the doc `aberto`, which is the truth.
 *
 * ⚠️ Cancelling does NOT revert the pedido's estado: the link creation flipped
 * `iniciado → aguardandoConfirmacaoDePagamento` (reserving stock and locking the
 * items), and whether cancelling the LAST open link should undo that is an open
 * owner decision — until it is made, the operator moves the pedido by hand.
 *
 * ⚠️ Best effort by nature. Mercado Pago documents no "cancel"; expiring the
 * preference stops a NEW checkout, but a checkout already open or a Pix code
 * already issued may still be paid (live probe P5). A link paid after being
 * cancelled therefore still reads as PAID in the summary (`situacaoDoLink`), so
 * the operator is never told it is safe to re-send.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { linkPgtoMercadoPagoCollection } from '@delfrance/data/admin/collections';
import { MercadoPagoHttpError } from '@delfrance/integrations-mercado-pago';
import {
  MOTIVO_RECUSA_LINK,
  STATUS_LINK_PAGAMENTO,
  type CancelarLinkPagamentoResposta,
} from '@delfrance/schemas';

import { loadMercadoPagoContext } from '../mercadoPago';
import { type FabricaApi, fabricaApiPadrao } from './api';
import { expirarPreferencia } from './expirar';
import { lerLink, metodoIdDoRef, usuarioOuterRef } from './leitura';
import { marcarLinkTerminal } from './linkStore';
import { linkNaoEncontrado, recusaLink, respostaOk, type RespostaLink } from './respostas';

/** Test seam: the Mercado Pago client, built from the account's live token. */
export interface CancelarLinkDeps {
  api?: FabricaApi;
}

export async function cancelarLink(
  db: Firestore,
  i: { uid: string; pedidoId: string; linkId: string; agoraMs: number },
  deps: CancelarLinkDeps = {},
): Promise<RespostaLink<CancelarLinkPagamentoResposta>> {
  const caminho = { pedidoId: i.pedidoId };
  const snap = await linkPgtoMercadoPagoCollection.docRef(db, caminho, i.linkId).get();
  if (!snap.exists) return linkNaoEncontrado();
  const link = lerLink(snap.data());

  // A link with no `modo` was written by the legacy app, under the legacy
  // Mercado Pago APPLICATION. Whether this application's token may alter its
  // preference is unconfirmed (probe P9), so no PUT is attempted: the operator
  // cancels it in the Mercado Pago panel.
  if (link.modo === null) return recusaLink(MOTIVO_RECUSA_LINK.preferenciaInacessivel);

  // Already terminal: cancelling twice — or cancelling a link that was paid up
  // and auto-closed — is a no-op that answers with the status it has.
  if (link.status !== STATUS_LINK_PAGAMENTO.aberto) {
    return respostaOk({ linkId: i.linkId, status: link.status });
  }

  // No preference id ⇒ nothing on Mercado Pago's side to expire.
  if (link.preferenceId === null) return recusaLink(MOTIVO_RECUSA_LINK.semPreferencia);

  // The account comes from the LINK, never from the request: a caller must not be
  // able to point this at another account's token.
  const metodoId = metodoIdDoRef(link.contaRef);
  if (metodoId === null) return recusaLink(MOTIVO_RECUSA_LINK.preferenciaInacessivel);

  const ctx = await loadMercadoPagoContext(db, metodoId);
  const token = await ctx.resolveAccessToken();
  const api = (deps.api ?? fabricaApiPadrao)(token);
  try {
    // A 400 on the full patch is retried once without `date_of_expiration`
    // (`expirarPreferencia`); what reaches the catch is the FINAL answer.
    await expirarPreferencia(api, link.preferenceId, i.agoraMs);
  } catch (err) {
    // 403 / 404: Mercado Pago will not let this application touch the preference
    // (it belongs to another application, or is gone). The link may STILL be
    // payable, so it is NOT marked cancelled — the operator is told to do it in
    // the panel. Anything else (reauth, network, 5xx, 429, a 400 the fallback
    // could not get past) is not an answer about the preference: it goes to the
    // route's mapper.
    if (err instanceof MercadoPagoHttpError && (err.status === 403 || err.status === 404)) {
      return recusaLink(MOTIVO_RECUSA_LINK.preferenciaInacessivel);
    }
    throw err;
  }

  const marcado = await marcarLinkTerminal(db, {
    pedidoId: i.pedidoId,
    linkId: i.linkId,
    status: STATUS_LINK_PAGAMENTO.cancelado,
    encerradoEm: i.agoraMs,
    encerradoPorOuterRef: usuarioOuterRef(i.uid),
    erroEncerramento: null,
  });
  if (marcado === 'inexistente') return linkNaoEncontrado();
  if (marcado === 'marcado') {
    return respostaOk({ linkId: i.linkId, status: STATUS_LINK_PAGAMENTO.cancelado });
  }

  // `ja-terminal`: another writer closed the link between our read and the mark
  // (an auto-close after its last payment, or a second cancel). Report the status
  // it ended up with, not the one we wanted.
  const depois = await linkPgtoMercadoPagoCollection.docRef(db, caminho, i.linkId).get();
  const status = depois.exists ? lerLink(depois.data()).status : STATUS_LINK_PAGAMENTO.cancelado;
  return respostaOk({ linkId: i.linkId, status });
}
