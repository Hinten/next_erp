/**
 * The order import's own error classes (master plan step 5). PR 5-c adds the one
 * a pure mapper throws; PR 5-d adds the importer's three retryable ones.
 *
 * ⚠️ Messages carry ids, counts and closed codes only — never a wire value, a
 * buyer datum or a price. The order id goes in only when it matches the 3-7-7
 * grammar and the conta id only when it matches its own, so an unvalidated id
 * can never put free text into a log line. No class here carries a `cause`: the
 * task wrapper logs a thrown error whole, and the shared core persists and
 * prints its message.
 */
import { CONTA_ID_AMAZON_REGEX, PEDIDO_AMAZON_REGEX } from '@delfrance/schemas';

/** The order id when it matches the 3-7-7 grammar, else `null`. */
function idDoPedidoOuNulo(orderId: unknown): string | null {
  return typeof orderId === 'string' && PEDIDO_AMAZON_REGEX.test(orderId) ? orderId : null;
}

/** The conta id when it matches the conta grammar, else `null`. */
function idDaContaOuNulo(contaId: unknown): string | null {
  return typeof contaId === 'string' && CONTA_ID_AMAZON_REGEX.test(contaId) ? contaId : null;
}

/** `<conta>/<order>` for a message, each through its grammar. */
function rotuloDoPedido(contaId: unknown, orderId: unknown): string {
  const conta = idDaContaOuNulo(contaId) ?? '<conta-invalida>';
  return `${conta}/${idDoPedidoOuNulo(orderId) ?? '<id-invalido>'}`;
}

/** A non-negative whole count for a message (anything else reads 0). */
function contagem(valor: number): number {
  return Number.isSafeInteger(valor) && valor >= 0 ? valor : 0;
}

/** Why an order cannot be keyed (each a closed code). */
export const MOTIVO_PEDIDO_AMAZON_ILEGIVEL = {
  /** `lastUpdatedTime` without an offset, or not an instant: the watermark cannot be derived. */
  instanteIlegivel: 'instante-ilegivel',
  /** Two lines with one `orderItemId`: a line identity cannot be built. */
  linhaDuplicada: 'linha-duplicada',
  /**
   * The answer names ANOTHER order than the one asked for (not byte-equal), or
   * an id outside the 3-7-7 grammar: the deterministic pedido id would key the
   * wrong document (PR 5-d's read check).
   */
  pedidoDivergente: 'pedido-divergente',
} as const satisfies Record<string, string>;

export type MotivoPedidoAmazonIlegivel =
  (typeof MOTIVO_PEDIDO_AMAZON_ILEGIVEL)[keyof typeof MOTIVO_PEDIDO_AMAZON_ILEGIVEL];

/**
 * An order a key cannot be built from. Deterministic: a retry reads the same
 * body, so PR 5-e's classifier parks it (`recusa-deterministica`).
 */
export class PedidoAmazonIlegivelError extends Error {
  /** The order id when it matches the 3-7-7 grammar, else `null`. */
  readonly orderId: string | null;
  readonly motivo: MotivoPedidoAmazonIlegivel;

  constructor(orderId: unknown, motivo: MotivoPedidoAmazonIlegivel) {
    const id = idDoPedidoOuNulo(orderId);
    super(`Pedido da Amazon ${id ?? '<id-invalido>'} ilegível: ${motivo}.`);
    this.name = 'PedidoAmazonIlegivelError';
    this.orderId = id;
    this.motivo = motivo;
  }
}

/**
 * A POLL task whose `getOrder` answered an OLDER `lastUpdatedTime` than the
 * search the poll enqueued it from (PR 5-d, plan §3 decision 3), on a QUEUE
 * attempt: the read lags, so the task retries (10 s, then 20 s) instead of
 * importing a state the poll has already seen pass. A sweep re-drive (no queue
 * attempt, at least 30 min later) never throws it: it imports what it reads.
 * Retryable — PR 5-e's classifier answers `null` for it.
 */
export class AmazonLeituraDefasadaError extends Error {
  readonly contaId: string | null;
  readonly orderId: string | null;

  constructor(contaId: string, orderId: string) {
    super(
      `Leitura defasada do pedido da Amazon ${rotuloDoPedido(contaId, orderId)}; ` +
        'a fila tenta de novo.',
    );
    this.name = 'AmazonLeituraDefasadaError';
    this.contaId = idDaContaOuNulo(contaId);
    this.orderId = idDoPedidoOuNulo(orderId);
  }
}

/**
 * Persistent contention on one pedido: every attempt of the import batch lost a
 * precondition (PR 5-d, `escritaPedido.ts`). Nothing was written; the queue
 * retries. Retryable — PR 5-e's classifier answers `null` for it.
 */
export class AmazonPedidoEmConflitoError extends Error {
  readonly contaId: string | null;
  readonly orderId: string | null;
  readonly tentativas: number;

  constructor(contaId: string, orderId: string, tentativas: number) {
    const n = contagem(tentativas);
    super(
      `Não foi possível gravar o pedido da Amazon ${rotuloDoPedido(contaId, orderId)}: ` +
        `${String(n)} lotes seguidos perderam uma precondição.`,
    );
    this.name = 'AmazonPedidoEmConflitoError';
    this.contaId = idDaContaOuNulo(contaId);
    this.orderId = idDoPedidoOuNulo(orderId);
    this.tentativas = n;
  }
}

/**
 * A FIRST-SEEN order that Amazon reports CANCELLED, or with any other reversal
 * signal, less than the recent-cancel window ago (PR 5-d, plan §3 decisions 12
 * and 44): no record is ever made of it, and a
 * no-write decision cannot be guarded by a precondition, so the import waits
 * until no other importer can still hold an older read of it. Zero writes;
 * retryable — each retry re-fetches the order and re-reads the pedido. PR 5-e's
 * classifier answers `null` for it.
 */
export class AmazonCancelamentoRecenteError extends Error {
  readonly contaId: string | null;
  readonly orderId: string | null;
  /** How long ago Amazon's clock moved, in whole seconds (a count, never a value). */
  readonly idadeS: number;

  constructor(contaId: string, orderId: string, idadeS: number) {
    const n = contagem(idadeS);
    super(
      `Pedido da Amazon ${rotuloDoPedido(contaId, orderId)} cancelado ou revertido há pouco ` +
        `(${String(n)} s); a importação espera e tenta de novo.`,
    );
    this.name = 'AmazonCancelamentoRecenteError';
    this.contaId = idDaContaOuNulo(contaId);
    this.orderId = idDoPedidoOuNulo(orderId);
    this.idadeS = n;
  }
}
