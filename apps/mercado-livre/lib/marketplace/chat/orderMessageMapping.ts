/**
 * PURE builders for the Mercado Livre post-sale message import (#532) — no
 * Firestore, no clock reads, no hashing. Mirrors `questionMapping.ts`.
 *
 * ⚠️ UNITS: conversa and mensagem timestamps are MILLISECONDS.
 */
import { coerceToMillis } from '@delfrance/core/datetime';
import { ESTADO_ENVIO, ORIGEM_CONVERSA, TIPO_MENSAGEM } from '@delfrance/schemas';
import type { Conversa, Mensagem } from '@delfrance/schemas';
import type {
  MlConversationStatus,
  MlMessageResource,
  MlPostSaleMessage,
} from '@delfrance/integrations-mercado-livre';

/**
 * ML's `conversation_status.status` vocabulary — exactly two values, per the
 * "Mensagens bloqueadas" reference.
 */
export const STATUS_CONVERSA_ML = { ativa: 'active', bloqueada: 'blocked' } as const;

/**
 * The `blocked_by_*` reasons worth spelling out for an operator. ML's list keeps
 * growing, so this is a lookup with a graceful fallback — never a parser.
 */
const SUBSTATUS_MOTIVO: Record<string, string> = {
  blocked_by_time: 'Prazo de resposta encerrado (30 dias sem mensagens)',
  blocked_by_buyer: 'O comprador bloqueou o recebimento de mensagens',
  blocked_by_mediation: 'Mediação em andamento',
  blocked_by_mediation_fbm: 'Mediação em andamento (venda Fulfillment)',
  blocked_by_fulfillment: 'Venda Fulfillment — liberada só após a entrega',
  blocked_by_payment: 'Pagamento ainda não processado',
  blocked_by_cancelled_order: 'Venda cancelada',
  blocked_by_cancelled_order_by_fraud: 'Venda cancelada por irregularidade',
  blocked_by_cancelled_order_hidden: 'Venda cancelada e não processada',
  blocked_by_conversation_expired: 'Conversa expirada (18 meses da compra)',
  blocked_by_refund: 'Reembolso realizado — só o comprador pode reabrir',
  blocked_by_deactivated_account: 'Conta do comprador ou do vendedor excluída',
  blocked_by_restrictions: 'Restrição sobre o comprador ou o vendedor',
  blocked_by_message_pending_review: 'Conversa em revisão pelo Mercado Livre',
  blocked_by_claim_change_open: 'Troca de produto em andamento',
  blocked_by_claim_change_closed: 'Troca de produto em andamento',
  blocked_by_ai_assistant: 'Atendimento pelo assistente de IA do Mercado Livre',
  blocked_by_ai_assistant_expired: 'Atendimento com o assistente de IA expirado',
  blocked_by_ai_assistant_contact_closed: 'Atendimento com o assistente de IA encerrado',
  blocked_by_resale: 'Mensageria indisponível: a venda contém produto de revenda',
  blocked_by_proximity_groceries: 'Mensageria indisponível para entrega imediata',
};

export interface OrderMessageActionability {
  readonly podeResponder: boolean;
  /** `null` when repliable; otherwise the text the composer shows. */
  readonly motivo: string | null;
  /** ML's live per-thread seller cap, when the response carried one. */
  readonly limiteCaracteres: number | null;
}

/**
 * The owner's directive, applied to post-sale threads.
 *
 * The signal is `conversation_status.status`: `active` means the thread is open
 * to send AND receive; `blocked` means closed. `substatus` names the reason, and
 * ML's list of those is long and still growing — so an unmapped one degrades to
 * a generic sentence rather than throwing or, worse, reading as repliable.
 *
 * ⚠️ An ABSENT `conversation_status` is treated as NOT repliable. It is what the
 * by-id endpoint returns (`conversation_status: null`), so a null here means we
 * never actually asked the pack — and assuming "yes" on missing evidence is the
 * #817 failure mode.
 */
export function orderMessageActionability(
  status: MlConversationStatus | null,
  sellerMaxLength: number | null,
): OrderMessageActionability {
  const limiteCaracteres = sellerMaxLength != null && sellerMaxLength > 0 ? sellerMaxLength : null;

  if (status == null) {
    return {
      podeResponder: false,
      motivo: 'Estado da conversa não informado pelo Mercado Livre',
      limiteCaracteres,
    };
  }

  const valor = (status.status ?? '').trim().toLowerCase();
  if (valor === STATUS_CONVERSA_ML.ativa) {
    return { podeResponder: true, motivo: null, limiteCaracteres };
  }

  const sub = (status.substatus ?? '').trim().toLowerCase();
  const conhecido = SUBSTATUS_MOTIVO[sub];
  return {
    podeResponder: false,
    motivo:
      conhecido ??
      (sub !== ''
        ? `Conversa bloqueada pelo Mercado Livre (${status.substatus ?? sub})`
        : 'Conversa bloqueada pelo Mercado Livre'),
    limiteCaracteres,
  };
}

/**
 * The pack (or, failing that, order) id a message belongs to.
 *
 * `packs` wins and `orders` is the fallback — legacy's own order
 * (`tasks.dart:1513-1525`). A cart of several orders shares ONE pack, so keying
 * on the order id would split one buyer conversation into several threads.
 */
export function packOrOrderIdFromResources(
  resources: readonly MlMessageResource[],
): { id: string; kind: 'pack' | 'order' } | null {
  const pick = (name: string): string | null => {
    for (const r of resources) {
      if ((r.name ?? '').trim().toLowerCase() !== name) continue;
      const id = r.id == null ? '' : String(r.id).trim();
      if (id !== '') return id;
    }
    return null;
  };
  const pack = pick('packs');
  if (pack != null) return { id: pack, kind: 'pack' };
  const order = pick('orders');
  return order == null ? null : { id: order, kind: 'order' };
}

/** Whether a message was authored by the seller (us) rather than the buyer. */
export function isFromSeller(message: MlPostSaleMessage, sellerUserId: number | null): boolean {
  if (sellerUserId == null) return false;
  const from = message.from?.user_id;
  return from != null && String(from) === String(sellerUserId);
}

export interface ConversaFromPackContext {
  readonly clienteOuterRef: string | null;
  readonly integracaoOuterRef: string;
  readonly pedidoOuterRef: string | null;
  /**
   * The conta's colour ALREADY LIFTED into `cor_etiqueta`'s 32-bit ARGB domain
   * by `corToEtiquetaArgb` — never the raw 24-bit `integracao.cor`. The chat
   * etiqueta filter matches its palette with an exact `==`, so an unlifted
   * value paints correctly and is selectable by nothing.
   */
  readonly corEtiqueta: number | null;
  readonly nowMs: number;
  readonly acao: OrderMessageActionability;
  /** `pack_id` when the sale has one, else the order id — the conversa's business key. */
  readonly packOrOrderId: string;
  /** The pedido's own numero, when resolved — a friendlier thread name. */
  readonly pedidoNumero: string | null;
  /**
   * The newest message's epoch-ms timestamp — what "last modified BY THE
   * INTEGRATION" means for this thread, as opposed to `ultima_modificacao`,
   * which is our own write clock. Null when the pack came back empty.
   */
  readonly ultimaMensagemMs: number | null;
  /**
   * `max(ultimaMensagemMs, conversation_status.status_date)` — the value the
   * out-of-order guard compares. Falls back to `ultimaMensagemMs`.
   */
  readonly relogioProvedorMs?: number | null;
}

/**
 * The conversa for a pack thread.
 *
 * ⚠️ `estadoConversa` is deliberately ABSENT — operator triage state, never
 * written by a webhook. The channel closes a thread through `respostaBloqueada`
 * + `atendido`.
 */
export function buildConversaFromPack(ctx: ConversaFromPackContext): Partial<Conversa> {
  return {
    id: ctx.packOrOrderId,
    origem: ORIGEM_CONVERSA.mercadoLivrePedido,
    clienteOuterRef: ctx.clienteOuterRef,
    integracaoOuterRef: ctx.integracaoOuterRef,
    pedidoOuterRef: ctx.pedidoOuterRef,
    nome:
      ctx.pedidoNumero != null && ctx.pedidoNumero !== ''
        ? `Pedido ${ctx.pedidoNumero}`
        : `MercadoLivre ${ctx.packOrOrderId}`,
    cor_etiqueta: ctx.corEtiqueta,
    ultima_modificacao: ctx.nowMs,
    // ⚠️ The PROVIDER clock, and the out-of-order guard reads it. It is the max
    // of the thread's newest message and `conversation_status.status_date`,
    // NOT just the message time: a thread going `blocked` often carries no new
    // message at all, and a message-only watermark would let a stale `active`
    // snapshot land afterwards and reopen a closed thread.
    ultimaModificacaoIntegracao: ctx.relogioProvedorMs ?? ctx.ultimaMensagemMs ?? ctx.nowMs,
    respostaBloqueada: ctx.acao.motivo,
    atendido: !ctx.acao.podeResponder,
  };
}

/**
 * One ML message as a mensagem.
 *
 * ⚠️ Direction comes from `estadoEnvio`, and getting it from the AUTHOR rather
 * than from ML's `status` is the point. `MensagemBubble` renders the customer
 * side on `estadoEnvio === recebido`, and this import writes no `user_id` — so a
 * buyer message must be `recebido` and ours `enviado`. Legacy stamped BOTH as
 * `enviado` (`models.dart:3374-3404`), which under the new identity model would
 * render the whole thread as our own outgoing messages.
 *
 * ⚠️ Since 02/02/2026 on MLB, `from.user_id` on a read is the AI Agent's id, not
 * the buyer's — so "is this ours" is decided by comparing against the SELLER id,
 * never by matching the buyer.
 */
export function buildOrderMensagem(
  message: MlPostSaleMessage,
  ctx: { clienteOuterRef: string | null; sellerUserId: number | null; nowMs: number },
): Partial<Mensagem> {
  const doVendedor = isFromSeller(message, ctx.sellerUserId);
  const criadoMs =
    coerceToMillis(message.message_date?.created) ??
    coerceToMillis(message.message_date?.received) ??
    ctx.nowMs;

  return {
    mid: message.id,
    conteudo: conteudoComAnexos(message),
    tipo: TIPO_MENSAGEM.comum,
    estadoEnvio: doVendedor ? ESTADO_ENVIO.enviado : ESTADO_ENVIO.recebido,
    canal: 0,
    // Only an inbound message has a contact author; ours is the operator's.
    clienteMensagemOuterRef: doVendedor ? null : ctx.clienteOuterRef,
    timestamp: criadoMs,
    data_cadastro: criadoMs,
    visualizado: coerceToMillis(message.message_date?.read),
  };
}

/**
 * One post-sale attachment as its own mensagem, pointing at the stored
 * `Arquivo`.
 *
 * ⚠️ It takes the PARENT message's direction. An attachment belongs to whoever
 * sent the message carrying it, so a buyer photo must render on the customer
 * side — stamping every one `enviado` would show the buyer's photos as ours,
 * which is the exact bug the claims path had to fix (`claimMapping.ts:449`).
 */
export function buildOrderAttachmentMensagem(args: {
  filename: string;
  parentMessage: MlPostSaleMessage;
  parentMessageDocId: string;
  arquivoOuterRef: string;
  clienteOuterRef: string | null;
  sellerUserId: number | null;
  nowMs: number;
}): Partial<Mensagem> {
  const doVendedor = isFromSeller(args.parentMessage, args.sellerUserId);
  const criadoMs =
    coerceToMillis(args.parentMessage.message_date?.created) ??
    coerceToMillis(args.parentMessage.message_date?.received) ??
    args.nowMs;

  return {
    mid: args.parentMessage.id,
    conteudo: args.filename,
    tipo: TIPO_MENSAGEM.arquivo,
    estadoEnvio: doVendedor ? ESTADO_ENVIO.enviado : ESTADO_ENVIO.recebido,
    canal: 0,
    anexoStorage: args.arquivoOuterRef,
    // Groups the attachment under the message that carried it, the way the
    // claims path does — the thread renders them together.
    midGroup: args.parentMessageDocId,
    clienteMensagemOuterRef: doVendedor ? null : args.clienteOuterRef,
    timestamp: criadoMs,
    data_cadastro: criadoMs,
  };
}

/**
 * The message body, with a visible note when ML reports attachments.
 *
 * The attachments themselves are now downloaded into Storage and written as
 * their own mensagens (`orderMessageAttachments.ts`, #1162), so this note is
 * the FALLBACK rather than the whole story — it still carries the count and
 * the names, which is what the operator needs when a download was skipped.
 *
 * Kept unconditionally, and that is deliberate: silently dropping an
 * attachment is worse than not having it, because the operator reads a message
 * saying "segue a foto" with no foto and no sign one was ever sent.
 */
function conteudoComAnexos(message: MlPostSaleMessage): string {
  const texto = message.text ?? '';
  const n = message.message_attachments.length;
  if (n === 0) return texto;
  const nomes = message.message_attachments
    .map((a) => a.original_filename ?? a.filename)
    .filter((x): x is string => typeof x === 'string' && x !== '');
  const lista = nomes.length > 0 ? `: ${nomes.join(', ')}` : '';
  const rotulo = n === 1 ? '1 anexo' : `${n} anexos`;
  return `${texto}\n\n[${rotulo} no Mercado Livre${lista}]`.trim();
}
