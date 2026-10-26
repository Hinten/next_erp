/**
 * The CLOSED vocabularies the pure order mappers report in (master plan step 5,
 * PR 5-c): pedido incidentes, log events and the two "not imported" outcomes.
 * Codes only — the importer (PR 5-d) writes the incidentes, logs the events by
 * count and turns the outcomes into dispositions. Nothing here reads a clock,
 * Firestore or the environment.
 *
 * One module for all three, so no mapper imports another just for a string and
 * the importer reads every code from one place.
 *
 * ⚠️ The aviso motivos are NOT here: they are `MOTIVO_PEDIDO_AMAZON` in
 * `@delfrance/schemas` (PR 5-b), because the web renders them. Only a code the
 * web never reads lives in this file.
 */

/**
 * A pedido INCIDENTE (`amz-<code>`, created once, resolved by the operator on
 * the pedido's Incidentes tab): a permanent fact of the order, which no later
 * import can see end — so never an aviso (plan §3 decision 26). PR 6 adds the
 * two payment codes.
 */
export const INCIDENTE_PEDIDO_AMAZON = {
  /** `fulfilledBy: AMAZON` (FBA is not used, D7), or an `UNFULFILLABLE` order. */
  logisticaAmazon: 'logistica-amazon',
  /** A first import of a non-reversed approved order with a 0 or absent quantity or price. */
  valorZerado: 'valor-zerado',
  /** A reversed sale (a reversal package, an executed line cancellation after shipment, a zeroed SHIPPED). */
  possivelReembolso: 'possivel-reembolso',
  /** Amazon cancelled, but the goods are out or the estado is the operator's: nothing was released. */
  canceladoAposEnvio: 'cancelado-apos-envio',
  /** Amazon cancelled while the stored pagamento sits off the importer's ladder (an operator's). */
  pagamentoDivergente: 'pagamento-divergente',
} as const satisfies Record<string, string>;

export type IncidentePedidoAmazon =
  (typeof INCIDENTE_PEDIDO_AMAZON)[keyof typeof INCIDENTE_PEDIDO_AMAZON];

/**
 * A LOG event (one WARNING count line per occurrence, ids and counts only,
 * PR 5-d). Never a stored record: these are what make a rare case countable.
 */
export const EVENTO_PEDIDO_AMAZON = {
  /**
   * An executed line cancellation on an order Amazon still has to ship (plan §3
   * decision 6, 2026-10-22): the pedido is held at our error and a person fixes
   * the lines. Its own code, so the case is countable.
   */
  cancelamentoParcial: 'cancelamento-parcial',
  /** A terminal estado moved back to a live one (only when Amazon itself had cancelled). */
  ressuscitado: 'ressuscitado',
  /** A stored price of exactly 0 filled by a positive incoming one on an approved order. */
  precoPreenchido: 'preco-preenchido',
  /** A changed (non-zero) line value after shipment: logged, never applied. */
  divergenciaPosEnvio: 'divergencia-pos-envio',
  /** A line sold by weight or volume (`measurement.unit` other than `COUNT`). */
  medidaNaoUnitaria: 'medida-nao-unitaria',
  /** A stored line the item schema refuses: the lines were left as stored. */
  itensArmazenadosIlegiveis: 'itens-armazenados-ilegiveis',
  /** A stored freight block the freight schema refuses: the block was left as stored. */
  freteArmazenadoIlegivel: 'frete-armazenado-ilegivel',
} as const satisfies Record<string, string>;

export type EventoPedidoAmazon = (typeof EVENTO_PEDIDO_AMAZON)[keyof typeof EVENTO_PEDIDO_AMAZON];

/**
 * Why a FIRST-SEEN order is not imported at all — zero writes of any kind.
 *
 * - `cancelado-nao-importado`: Amazon's order is CANCELLED (the importer waits
 *   out a short window first, PR 5-d; plan §3 decision 12);
 * - `reversao-nao-importada`: any other reversal signal on an order this ERP
 *   never stored — a returned, refused or lost package, an executed line
 *   cancellation after shipment, a zeroed or emptied SHIPPED (plan §3 decision
 *   44, the 2026-10-22 answer). The importer waits out the same short window
 *   first, because an importer still holding an older, pre-reversal read could
 *   otherwise create the pedido after the skip (the importer's header, PR 5-d).
 */
export const MOTIVO_NAO_IMPORTADO_AMAZON = {
  canceladoNaoImportado: 'cancelado-nao-importado',
  reversaoNaoImportada: 'reversao-nao-importada',
} as const satisfies Record<string, string>;

export type MotivoNaoImportadoAmazon =
  (typeof MOTIVO_NAO_IMPORTADO_AMAZON)[keyof typeof MOTIVO_NAO_IMPORTADO_AMAZON];

/** Unique and sorted, so an equal input reports an equal list. */
export function codigosOrdenados<T extends string>(codigos: Iterable<T>): T[] {
  return [...new Set(codigos)].sort();
}
