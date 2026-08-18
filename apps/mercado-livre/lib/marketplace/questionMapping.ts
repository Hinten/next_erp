/**
 * PURE builders for the Mercado Livre questions import (#532) — no Firestore, no
 * clock reads, no hashing (those live in `questionIds.ts`). Mirrors the split
 * `claimMapping.ts` established.
 *
 * ⚠️ UNITS: conversa and mensagem timestamps are MILLISECONDS since epoch
 * (`millisSinceEpoch()` in `conversaSchema`), unlike the incidente/pedido side,
 * which is microseconds. ML hands us ISO-8601 strings, converted here once.
 */
import { coerceToMillis } from '@delfrance/core/datetime';
import { ESTADO_ENVIO, ORIGEM_CONVERSA, TIPO_MENSAGEM } from '@delfrance/schemas';
import type { Conversa, Mensagem } from '@delfrance/schemas';
import type { MlQuestion } from '@delfrance/integrations-mercado-livre';

/**
 * ML's documented question vocabulary. Plain strings rather than a Zod enum —
 * the wire schema deliberately does not constrain `status` (see
 * `mlQuestionSchema`), so this is a comparison table, not a parser.
 */
export const STATUS_QUESTION = {
  unanswered: 'UNANSWERED',
  answered: 'ANSWERED',
  closedUnanswered: 'CLOSED_UNANSWERED',
  underReview: 'UNDER_REVIEW',
  banned: 'BANNED',
  deleted: 'DELETED',
  disabled: 'DISABLED',
} as const;

/** Legacy parity: the answer mensagem's `mid` equals its doc id (see `questionIds.ts`). */
export const ANSWER_MID = 'ja_respondidanull';

/** Whether we can still post an answer, and the operator-facing reason if not. */
export interface QuestionActionability {
  readonly podeResponder: boolean;
  /** `null` when answerable; otherwise the text the composer shows. */
  readonly motivo: string | null;
}

/**
 * The owner's directive, applied: **import only what we can respond to**.
 *
 * `POST /answers` succeeds on exactly one status — `UNANSWERED` — so every other
 * value is a thread where the composer would be lying. Three further flags make
 * an otherwise-unanswered question unanswerable, and ML documents all three:
 *
 *  - `hold` — ML is withholding the question from the seller;
 *  - `deleted_from_listing` — the question is gone from the listing;
 *  - `suspected_spam` — ML has flagged it, and answering amplifies it.
 *
 * ⚠️ `status` is compared case-INSENSITIVELY. ML's reference prints the values
 * uppercase in its payload samples and lowercase in its prose table, and the
 * legacy Dart enum parsed the lowercase spelling — so a strict uppercase compare
 * would classify perfectly answerable questions as unsupported.
 */
export function questionActionability(question: MlQuestion): QuestionActionability {
  if (question.hold === true) {
    return { podeResponder: false, motivo: 'Pergunta retida pelo Mercado Livre' };
  }
  if (question.deleted_from_listing === true) {
    return { podeResponder: false, motivo: 'Pergunta removida do anúncio' };
  }
  if (question.suspected_spam === true) {
    return { podeResponder: false, motivo: 'Pergunta marcada como spam pelo Mercado Livre' };
  }

  switch ((question.status ?? '').trim().toUpperCase()) {
    case STATUS_QUESTION.unanswered:
      return { podeResponder: true, motivo: null };
    case STATUS_QUESTION.answered:
      return { podeResponder: false, motivo: 'Pergunta já respondida no Mercado Livre' };
    case STATUS_QUESTION.closedUnanswered:
      return { podeResponder: false, motivo: 'Anúncio encerrado sem resposta' };
    case STATUS_QUESTION.underReview:
      return { podeResponder: false, motivo: 'Anúncio em revisão pelo Mercado Livre' };
    case STATUS_QUESTION.banned:
      return { podeResponder: false, motivo: 'Pergunta bloqueada pelo Mercado Livre' };
    case STATUS_QUESTION.deleted:
    case STATUS_QUESTION.disabled:
      return { podeResponder: false, motivo: 'Pergunta excluída no Mercado Livre' };
    default:
      // An ML status we have never seen. Do NOT assume it is answerable: a false
      // "you can reply" is the #817 failure mode, while a false "you cannot" is
      // visible to the operator and recoverable.
      return {
        podeResponder: false,
        motivo: `Pergunta em estado não suportado (${question.status ?? 'sem status'})`,
      };
  }
}

/** The asker's ML user id — the by-id endpoint spells it `buyer_id`, search `from.id`. */
export function questionBuyerId(question: MlQuestion): number | null {
  return question.buyer_id ?? question.from?.id ?? null;
}

/**
 * The public listing URL, the same string the legacy built:
 * `MLB123` → `https://produto.mercadolivre.com.br/MLB-123`.
 *
 * Derived, not fetched — the operator gets a one-click link to the anúncio at
 * the cost of zero ML calls.
 */
export function questionExternalLink(itemId: string | null): string | null {
  if (itemId == null || itemId.trim() === '') return null;
  return `https://produto.mercadolivre.com.br/MLB-${itemId.trim().replace(/^MLB/i, '')}`;
}

export interface ConversaFromQuestionContext {
  /** `documents/clientes/<id>` — the contact. NO usuario is created (#532). */
  readonly clienteOuterRef: string | null;
  readonly integracaoOuterRef: string;
  /** `documents/produtos/<id>`, when the ML item resolves to a linked produto. */
  readonly produtoOuterRef: string | null;
  /** The anúncio title, when the item fetch succeeded. */
  readonly tituloAnuncio: string | null;
  readonly corEtiqueta: number | null;
  /** ONE clock read for the whole import, in MILLISECONDS. */
  readonly nowMs: number;
  readonly acao: QuestionActionability;
}

/**
 * The conversa document for a question.
 *
 * ⚠️ `estadoConversa` is deliberately ABSENT. It is operator triage state — the
 * claims importer restores it after every merge for exactly this reason — so a
 * webhook must never write it. The channel says "this thread is finished"
 * through `respostaBloqueada` + `atendido`, which are channel-owned.
 */
export function buildConversaFromQuestion(
  question: MlQuestion,
  ctx: ConversaFromQuestionContext,
): Partial<Conversa> {
  const buyerId = questionBuyerId(question);
  return {
    id: String(question.id),
    sender_id: buyerId == null ? null : String(buyerId),
    origem: ORIGEM_CONVERSA.mercadoLivrePerguntas,
    clienteOuterRef: ctx.clienteOuterRef,
    integracaoOuterRef: ctx.integracaoOuterRef,
    produtoOuterRef: ctx.produtoOuterRef,
    nome: ctx.tituloAnuncio ?? question.item_id ?? 'Pergunta do Mercado Livre',
    externalLink: questionExternalLink(question.item_id),
    cor_etiqueta: ctx.corEtiqueta,
    data_cadastro: coerceToMillis(question.date_created) ?? ctx.nowMs,
    ultima_modificacao: ctx.nowMs,
    ultimaModificacaoIntegracao: coerceToMillis(question.last_updated) ?? ctx.nowMs,
    respostaBloqueada: ctx.acao.motivo,
    // `atendido` is the channel's "nothing left to do here" flag, and the one
    // `estadoConversa` substitute that does not collide with operator triage.
    atendido: !ctx.acao.podeResponder,
  };
}

/**
 * The buyer's question, as a mensagem.
 *
 * ⚠️ `estadoEnvio: recebido`, NOT the legacy `enviado` (`models.dart:6672`).
 * `MensagemBubble` decides which side of the thread a bubble renders on from
 * `estadoEnvio === recebido || user_id === customerUid`, and this import writes
 * no `user_id` at all — the contact is a cliente now, not a synthetic usuario.
 * Carrying the legacy value here would render the BUYER'S OWN QUESTION as an
 * outbound message. It is also what makes the conversa raise the "aguardando
 * resposta" badge, which counts `recebido`.
 */
export function buildQuestionMensagem(
  question: MlQuestion,
  ctx: { clienteOuterRef: string | null; nowMs: number },
): Partial<Mensagem> {
  const criadoMs = coerceToMillis(question.date_created) ?? ctx.nowMs;
  return {
    mid: String(question.id),
    conteudo: question.text,
    tipo: TIPO_MENSAGEM.comum,
    estadoEnvio: ESTADO_ENVIO.recebido,
    canal: 0,
    clienteMensagemOuterRef: ctx.clienteOuterRef,
    timestamp: criadoMs,
    data_cadastro: criadoMs,
  };
}

/**
 * The seller's answer, as a mensagem — `enviado`, because we sent it, whether
 * from this app or from ML's own web UI.
 *
 * ⚠️ A `BANNED` answer arrives with EMPTY text (ML strips moderated content), so
 * the caller must not let it overwrite stored content. `questionImport` skips
 * the write entirely in that case.
 */
export function buildAnswerMensagem(
  question: MlQuestion,
  ctx: { nowMs: number },
): Partial<Mensagem> {
  const answer = question.answer;
  const criadoMs = coerceToMillis(answer?.date_created) ?? ctx.nowMs;
  return {
    mid: ANSWER_MID,
    conteudo: answer?.text ?? '',
    tipo: TIPO_MENSAGEM.comum,
    estadoEnvio: ESTADO_ENVIO.enviado,
    canal: 0,
    timestamp: criadoMs,
    data_cadastro: criadoMs,
  };
}
