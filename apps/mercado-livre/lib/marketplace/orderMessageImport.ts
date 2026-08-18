/**
 * Mercado Livre **post-sale messages → chat** import (#532) — the `messages`
 * topic's handler. Same split as the questions import: pure ids, pure builders,
 * orchestration here.
 *
 * ── The directive ─────────────────────────────────────────────────────────────
 * **Import only what we can respond to.** A pack whose `conversation_status` is
 * `blocked` never opens a thread; an existing thread is still updated, because
 * the delivery that reports the block is the only thing that can close a thread
 * we opened while it was active.
 *
 * ── Why TWO ML calls ──────────────────────────────────────────────────────────
 * A `messages` notification's `resource` is a bare message id, not a path, and
 * carries no pack. So: `getMessage(id)` yields `message_resources`, which names
 * the pack; `getPackMessages(pack, seller)` yields the whole thread AND the
 * `conversation_status` that decides actionability. The by-id endpoint answers
 * `conversation_status: null`, so it cannot settle that question on its own.
 *
 * ⚠️ Both calls pass `mark_as_read=false`. The plain GET marks the thread READ as
 * a side effect, and an importer must not clear the seller's unread state.
 *
 * ⚠️ The identity of the counterparty is the PEDIDO's cliente, never the message
 * `from`. Since 02/02/2026 on MLB, ML's AI Agent intermediates the conversation
 * and `from.user_id` on a read is the AGENT's id.
 */
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import {
  conversaCollection,
  mensagemCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';
import type { MercadoLivreApi, MlPackMessages } from '@delfrance/integrations-mercado-livre';

import { resolvePedidoIdByOrderId } from './orderPedidoResolve';
import { makeConversaIdOrderMessage, makeOrderMensagemId } from './orderMessageIds';
import {
  buildConversaFromPack,
  buildOrderMensagem,
  orderMessageActionability,
  packOrOrderIdFromResources,
} from './orderMessageMapping';

export interface OrderMessageImportDeps {
  readonly db: Firestore;
  readonly api: MercadoLivreApi;
  readonly integracaoId: string;
  readonly conta: { userId: number | null; cor: number | null };
  /** ONE clock read for the whole import, MILLISECONDS. */
  readonly nowMs: number;
}

export type OrderMessageImportSkip =
  | 'message-404'
  | 'sem-pack'
  | 'sem-seller'
  | 'sem-mensagens'
  | 'nao-respondivel';

export interface OrderMessageImportResult {
  readonly conversaId: string | null;
  readonly pedidoId: string | null;
  readonly skipped: OrderMessageImportSkip | null;
}

function skip(reason: OrderMessageImportSkip): OrderMessageImportResult {
  return { conversaId: null, pedidoId: null, skipped: reason };
}

function outerRef(collection: string, id: string): string {
  return `documents/${collection}/${id}`;
}

/** A 404 is deterministic — ack it rather than burning the retry budget. */
function is404(err: unknown): boolean {
  return err instanceof MercadoLivreHttpError && err.status === 404;
}

/**
 * Import the thread a `messages` notification belongs to.
 *
 * THROWS on a transient failure so the queue and sweep retry; deterministic
 * outcomes RETURN a skip reason. Idempotent — every document id is derived from
 * ML ids, so a redelivery updates in place.
 */
export async function importOrderMessageMercadoLivre(
  deps: OrderMessageImportDeps,
  messageId: string,
): Promise<OrderMessageImportResult> {
  const { db, api, integracaoId, conta, nowMs } = deps;

  const sellerId = conta.userId;
  if (sellerId == null) return skip('sem-seller');

  // (a) the announced message → the pack it belongs to.
  let porId: MlPackMessages;
  try {
    porId = await api.getMessage(messageId);
  } catch (err) {
    if (is404(err)) return skip('message-404');
    throw err;
  }
  const primeira = porId.messages[0];
  if (!primeira) return skip('sem-mensagens');

  const alvo = packOrOrderIdFromResources(primeira.message_resources);
  if (alvo == null) return skip('sem-pack');

  // (b) the pack's whole thread, WITH the conversation_status.
  let pack: MlPackMessages;
  try {
    pack = await api.getPackMessages(alvo.id, String(sellerId));
  } catch (err) {
    if (is404(err)) return skip('message-404');
    throw err;
  }

  const acao = orderMessageActionability(pack.conversation_status, pack.seller_max_message_length);
  const conversaId = makeConversaIdOrderMessage(integracaoId, alvo.id);
  const conversaRef = conversaCollection.docRef(db, {}, conversaId);
  const existente = await conversaRef.get();

  // A thread we cannot reply to never opens. An existing one is still updated:
  // that delivery is the only event that can close what we opened while active.
  if (!acao.podeResponder && !existente.exists) return skip('nao-respondivel');

  // The pedido carries the identity. `resolvePedidoIdByOrderId` matches the
  // orderML chain on pack_id FIRST and then id — the same key this thread uses.
  // `resolvePedidoIdByOrderId` queries the numeric `pack_id`/`id` fields, so
  // the string id has to become a number. A pack id is ~2e15, comfortably
  // inside the safe-integer range — but a value that is NOT a safe integer
  // would silently become a query for a different number, so it degrades to
  // "no pedido" instead.
  const alvoNumerico = /^\d+$/.test(alvo.id) ? Number(alvo.id) : Number.NaN;
  const pedidoId = Number.isSafeInteger(alvoNumerico)
    ? await resolvePedidoIdByOrderId(db, alvoNumerico)
    : null;
  const pedido = pedidoId == null ? null : await pedidoCollection.docRef(db, {}, pedidoId).get();
  const pedidoData = pedido?.exists ? (pedido.data() as Record<string, unknown>) : null;
  const clienteOuterRef =
    typeof pedidoData?.clientePedidoOuterRef === 'string' ? pedidoData.clientePedidoOuterRef : null;
  const pedidoNumero =
    pedidoData?.numero == null || pedidoData.numero === '' ? null : String(pedidoData.numero);

  // The thread's own newest timestamp, not our write clock.
  const mensagens = pack.messages.length > 0 ? pack.messages : porId.messages;
  const carimbos = mensagens
    .map((m) => buildOrderMensagem(m, { clienteOuterRef, sellerUserId: sellerId, nowMs }).timestamp)
    .filter((t): t is number => typeof t === 'number');
  const ultimaMensagemMs = carimbos.length > 0 ? Math.max(...carimbos) : null;

  const fields = buildConversaFromPack({
    clienteOuterRef,
    integracaoOuterRef: outerRef('integracao', integracaoId),
    pedidoOuterRef: pedidoId == null ? null : outerRef('pedidos', pedidoId),
    corEtiqueta: conta.cor,
    nowMs,
    acao,
    packOrOrderId: alvo.id,
    pedidoNumero,
    ultimaMensagemMs,
  });

  if (existente.exists) {
    await conversaCollection.merge(db, {}, conversaId, fields as DocumentData);
  } else {
    await conversaCollection.set(db, {}, conversaId, {
      ...fields,
      data_cadastro: ultimaMensagemMs ?? nowMs,
    } as DocumentData);
  }

  // Every message in the thread, at its ML id — an overwrite-set, so a
  // redelivery updates rather than duplicating.
  for (const m of mensagens) {
    await mensagemCollection.set(
      db,
      { conversaId },
      makeOrderMensagemId(m.id),
      buildOrderMensagem(m, { clienteOuterRef, sellerUserId: sellerId, nowMs }) as DocumentData,
    );
  }

  return { conversaId, pedidoId, skipped: null };
}
