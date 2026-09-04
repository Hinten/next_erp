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
 * `from`. On a thread ML has MIGRATED to the 02/02/2026 agent architecture,
 * `from.user_id` on a read is the AGENT's id.
 *
 * ⚠️ That is a statement about IDENTITY, and it does not generalise to ROUTING.
 * `from.user_id` is exactly the right address to REPLY to — it is the one ML just
 * delivered from — which is what `postSaleRecipientUserId` derives. Reading the
 * warning above as "the field is useless" is what addressed every outbound reply
 * to the agent unconditionally, and 400'd every thread ML had not migrated.
 */
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import {
  conversaCollection,
  mensagemCollection,
  pedidoCollection,
} from '@delfrance/data/admin/collections';
import { MercadoLivreHttpError } from '@delfrance/integrations-mercado-livre';
import type { MercadoLivreApi, MlPackMessages } from '@delfrance/integrations-mercado-livre';

import { corToEtiquetaArgb } from '@delfrance/core/cor';
import { coerceToMillis } from '@delfrance/core/datetime';

import { ack404EhSeguro } from '../notificacoes/notificacaoFrescor';
import { resolvePedidoIdByOrderId } from '../pedidos/orderPedidoResolve';
import { makeConversaIdOrderMessage, makeOrderMensagemId } from './orderMessageIds';
import type { Bucket } from '../core/arquivoUpload';
import { ensureOrderMessageAttachmentArquivo } from './orderMessageAttachments';
import { makeAttachmentMensagemId } from '../claims/claimIds';
import { limparMensagensProvisorias } from './mensagemProvisoria';
import {
  PAGINA_MENSAGENS_THREAD,
  buildConversaFromPack,
  buildOrderAttachmentMensagem,
  buildOrderMensagem,
  orderMessageActionability,
  packOrOrderIdFromResources,
} from './orderMessageMapping';

export interface OrderMessageImportDeps {
  readonly db: Firestore;
  readonly api: MercadoLivreApi;
  /**
   * Storage bucket for attachment `Arquivo`s — `null` skips ALL attachments
   * with one loud warn, matching `claimImport`. The text mensagem still lands
   * carrying its `[n anexos]` note, so nothing is silently lost.
   */
  readonly bucket: Bucket | null;
  readonly integracaoId: string;
  readonly conta: { userId: number | null; cor: number | null };
  /** ONE clock read for the whole import, MILLISECONDS. */
  readonly nowMs: number;
  /**
   * The notification's own `sent` (ms), when it carried one. Tells a 404 that
   * means "deleted" from a 404 that means "ML has not propagated this yet" —
   * ML's reference is explicit that the by-id read 404s during that window and
   * that integrators should retry. See `notificacaoFrescor.ts`.
   */
  readonly notificacaoEnviadaMs?: number | null;
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

function is404(err: unknown): boolean {
  return err instanceof MercadoLivreHttpError && err.status === 404;
}

/**
 * Hard stop on the walk. GETs share a **500 rpm** post-sale budget across the
 * whole application, so one pathological thread must not be able to spend it.
 * Hitting this WARNS rather than truncating silently.
 */
const MAX_PAGINAS_MENSAGENS = 10;

/**
 * The whole thread, not just ML's first page.
 *
 * Returns the first page too (it is the one carrying `conversation_status` and
 * `seller_max_message_length`), with `messages` accumulated across pages.
 */
async function lerThreadCompleta(
  api: OrderMessageImportDeps['api'],
  packOrOrderId: string,
  sellerId: string,
): Promise<MlPackMessages> {
  const primeira = await api.getPackMessages(packOrOrderId, sellerId, {
    limit: PAGINA_MENSAGENS_THREAD,
  });
  const total = primeira.paging?.total ?? null;
  const mensagens = [...primeira.messages];
  if (total == null || mensagens.length >= total) return primeira;

  let paginas = 1;
  while (mensagens.length < total && paginas < MAX_PAGINAS_MENSAGENS) {
    const proxima = await api.getPackMessages(packOrOrderId, sellerId, {
      limit: PAGINA_MENSAGENS_THREAD,
      offset: mensagens.length,
    });
    // Defensive: ML returning an empty page while `total` still says otherwise
    // would spin this loop until the cap for nothing.
    if (proxima.messages.length === 0) break;
    mensagens.push(...proxima.messages);
    paginas += 1;
  }

  if (mensagens.length < total) {
    // ⚠️ Never truncate quietly: a short thread and a capped one look identical
    // in Firestore.
    console.warn('[mercado-livre] thread pós-venda truncada no limite de páginas', {
      packOrOrderId,
      lidas: mensagens.length,
      total,
      maxPaginas: MAX_PAGINAS_MENSAGENS,
    });
  }
  return { ...primeira, messages: mensagens };
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
  const { db, api, bucket, integracaoId, conta, nowMs } = deps;

  const sellerId = conta.userId;
  if (sellerId == null) return skip('sem-seller');

  // (a) the announced message → the pack it belongs to.
  // ⚠️ A 404 here is usually the read-your-writes race, not a deletion. ML's own
  // reference says so for this exact endpoint ("Mensagem não encontrada no
  // servidor. Tente novamente em alguns segundos"), which is also why the
  // receiver delays `messages` by 10s. Acking it loses a real customer message
  // with no record anywhere, so only a 404 on a delivery old enough to rule the
  // race out is acked.
  const pode404 = ack404EhSeguro({ enviadaMs: deps.notificacaoEnviadaMs, nowMs });
  let porId: MlPackMessages;
  try {
    porId = await api.getMessage(messageId);
  } catch (err) {
    if (is404(err) && pode404) return skip('message-404');
    throw err;
  }
  const primeira = porId.messages[0];
  if (!primeira) return skip('sem-mensagens');

  const alvo = packOrOrderIdFromResources(primeira.message_resources);
  if (alvo == null) return skip('sem-pack');

  // (b) the pack's whole thread, WITH the conversation_status.
  let pack: MlPackMessages;
  try {
    pack = await lerThreadCompleta(api, alvo.id, String(sellerId));
  } catch (err) {
    if (is404(err) && pode404) return skip('message-404');
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

  // ⚠️ The watermark the out-of-order guard compares. Both halves matter: a new
  // message moves `ultimaMensagemMs`, while a thread going `blocked` usually
  // moves only `status_date`.
  const statusDateMs = coerceToMillis(pack.conversation_status?.status_date);
  const relogioProvedorMs =
    ultimaMensagemMs == null && statusDateMs == null
      ? null
      : Math.max(ultimaMensagemMs ?? 0, statusDateMs ?? 0);

  const fields = buildConversaFromPack({
    clienteOuterRef,
    integracaoOuterRef: outerRef('integracao', integracaoId),
    pedidoOuterRef: pedidoId == null ? null : outerRef('pedidos', pedidoId),
    // ⚠️ CONVERTED, not copied. `integracao.cor` is a 24-bit RGB int; `cor_etiqueta`
    // is a 32-bit ARGB `Color.value`, and the chat etiqueta filter matches its
    // palette with an exact `==`. A raw copy paints the right colour but is
    // selectable by no etiqueta at all. See `corToEtiquetaArgb`.
    corEtiqueta: corToEtiquetaArgb(conta.cor),
    nowMs,
    acao,
    packOrOrderId: alvo.id,
    pedidoNumero,
    ultimaMensagemMs,
    relogioProvedorMs,
  });

  // ⚠️ ONE transaction, re-reading inside it (root CLAUDE.md rule 7, tier 2).
  // Two notifications for the same pack can be in flight at once — a new
  // message and a status change, or a redelivery racing the sweep — and they
  // fetch DIFFERENT ML snapshots. Without this, an older `active` snapshot
  // finishing last overwrites `respostaBloqueada`/`atendido` and silently
  // reopens a closed thread, handing the operator a composer that cannot send.
  // Same shape as the WhatsApp inbound guard in `processMessages.ts`.
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(conversaRef);
    if (!snap.exists) {
      tx.set(
        conversaRef,
        conversaCollection.parse({
          ...fields,
          data_cadastro: ultimaMensagemMs ?? nowMs,
        }) as DocumentData,
      );
      return;
    }

    // Re-derived from the tx snapshot, never from the read above — that one is
    // stale by the time we get here, which is the whole point.
    const stored = snap.data() as Record<string, unknown> | undefined;
    const armazenado =
      typeof stored?.ultimaModificacaoIntegracao === 'number'
        ? stored.ultimaModificacaoIntegracao
        : null;
    const entrante = fields.ultimaModificacaoIntegracao ?? null;

    if (armazenado != null && entrante != null && entrante < armazenado) {
      // A strictly OLDER provider snapshot. Dropping the conversa patch is the
      // point of the guard; the mensagens below are still written, because they
      // are keyed by ML id and can only add history, never contradict it.
      console.warn('[mercado-livre] thread pós-venda: snapshot mais antigo ignorado', {
        conversaId,
        armazenado,
        entrante,
      });
      return;
    }

    tx.set(conversaRef, conversaCollection.parseMerge(fields) as DocumentData, {
      merge: true,
    });
  });

  // Every message in the thread, at its ML id — an overwrite-set, so a
  // redelivery updates rather than duplicating.
  let avisouSemBucket = false;
  for (const m of mensagens) {
    const messageDocId = makeOrderMensagemId(m.id);

    // Attachments first, then the message — same order as the claims path, so
    // the thread never shows a message whose attachment has not landed yet.
    for (const anexo of m.message_attachments) {
      if (anexo.filename == null || anexo.filename === '') continue;
      if (bucket == null) {
        if (!avisouSemBucket) {
          console.warn(
            '[mercado-livre] pós-venda: bucket de Storage indisponível — TODOS os anexos ignorados',
            { packId: alvo.id },
          );
          avisouSemBucket = true;
        }
        continue;
      }
      const ensured = await ensureOrderMessageAttachmentArquivo(
        { db, api, bucket },
        { contaId: integracaoId, packId: alvo.id, filename: anexo.filename },
      );
      // A skip is already warned about at the source; the text mensagem below
      // still carries the `[n anexos]` note, so the operator sees one existed.
      if (!ensured.ok) continue;
      await mensagemCollection.set(
        db,
        { conversaId },
        makeAttachmentMensagemId(integracaoId, anexo.filename),
        buildOrderAttachmentMensagem({
          filename: anexo.filename,
          parentMessage: m,
          parentMessageDocId: messageDocId,
          arquivoOuterRef: ensured.arquivoOuterRef,
          clienteOuterRef,
          sellerUserId: sellerId,
          nowMs,
        }) as DocumentData,
      );
    }

    await mensagemCollection.set(
      db,
      { conversaId },
      messageDocId,
      buildOrderMensagem(m, { clienteOuterRef, sellerUserId: sellerId, nowMs }) as DocumentData,
    );
  }

  // The real messages are in, so any provisional bubble they superseded can go.
  // Bounded to `ultimaMensagemMs`: a reply sent AFTER this snapshot has not come
  // back from ML yet and keeps its placeholder.
  await limparMensagensProvisorias(db, conversaId, ultimaMensagemMs);

  return { conversaId, pedidoId, skipped: null };
}
