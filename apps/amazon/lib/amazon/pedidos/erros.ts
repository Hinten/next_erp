/**
 * The order import's own error classes (master plan step 5). PR 5-c adds the one
 * a pure mapper throws; PR 5-d adds the importer's retryable ones.
 *
 * ⚠️ Messages carry ids and closed codes only — never a wire value, a buyer
 * datum or a price. The order id goes in only when it matches the 3-7-7 grammar,
 * so an unvalidated id can never put free text into a log line.
 */
import { PEDIDO_AMAZON_REGEX } from '@delfrance/schemas';

/** Why an order cannot be keyed (each a closed code). */
export const MOTIVO_PEDIDO_AMAZON_ILEGIVEL = {
  /** `lastUpdatedTime` without an offset, or not an instant: the watermark cannot be derived. */
  instanteIlegivel: 'instante-ilegivel',
  /** Two lines with one `orderItemId`: a line identity cannot be built. */
  linhaDuplicada: 'linha-duplicada',
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
    const id = typeof orderId === 'string' && PEDIDO_AMAZON_REGEX.test(orderId) ? orderId : null;
    super(`Pedido da Amazon ${id ?? '<id-invalido>'} ilegível: ${motivo}.`);
    this.name = 'PedidoAmazonIlegivelError';
    this.orderId = id;
    this.motivo = motivo;
  }
}
