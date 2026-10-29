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
 * import can see end — so never an aviso (plan §3 decision 26). PR 6 added the
 * two payment codes and the money arm of `pagamento-divergente`; PR 5-f the two
 * codes for what the order money cannot state (`dinheiroAmazon.ts`).
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
  /**
   * The pagamento does not match the pedido: Amazon cancelled while the stored
   * pagamento sits off the importer's ladder (an operator's), OR (PR 6) the
   * payment executions do not add up to what the NF-e states (`valor` then
   * covers the note's total, or keeps the larger sum), OR (PR 6) an approved
   * order's pagamento could not be created because the stored lines do not
   * state a total, OR (PR 5-f) a pedido Amazon approved ends `pago` with no
   * pagamento because the read is a possible reversal, which never creates one
   * (`pagamentoAmazon.ts`). One id for every arm.
   */
  pagamentoDivergente: 'pagamento-divergente',
  /** (PR 6) Amazon's `paymentMethod` is absent or not in the table: the pagamento is a 99. */
  formaPagamentoDesconhecida: 'forma-pagamento-desconhecida',
  /** (PR 6) More than one payment execution: ONE pagamento, the largest leg's forma. */
  pagamentoDividido: 'pagamento-dividido',
  /**
   * (PR 5-f) A read Amazon approved carries, on a line that also charges
   * SHIPPING, a DISCOUNT whose shipping part is not itemised: the whole discount
   * went to `descontoTotal` with the freight gross, and the payment check cannot
   * see it. The NF-e's discount, freight and total need a person.
   */
  descontoNaoDetalhado: 'desconto-nao-detalhado',
  /**
   * (PR 5-f) A read Amazon approved carries a TAX breakdown that is not exactly
   * 0: Amazon shows the tax apart, so its other amounts may be tax-exclusive
   * while the line price is read as tax-inclusive. The NF-e's values need a person.
   */
  impostoDestacado: 'imposto-destacado',
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
   * decision 6, 2026-10-22): the lines are held for a person to fix, the
   * pedido at our error unless the goods are out or the freight removes stock
   * (then the estado stays, and with the goods out it holds the reservation;
   * PR 5-f). Its own code, so the case is countable.
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
  /** (PR 6) A pagamento `estornado` moved back to `aprovado` (the pedido resurrected with it). */
  pagamentoRessuscitado: 'pagamento-ressuscitado',
  /**
   * (PR 6) A non-blank `acquirerId` the shared card rule refused (not a valid
   * 14-character CNPJ): `cnpj_instituicao` stays `null`. Never the value.
   */
  cnpjInstituicaoRecusado: 'cnpj-instituicao-recusado',
  /**
   * (PR 5-c1) A non-blank card brand the shared fold (`bandeiraDoNomeDaMarca`)
   * does not know: `bandeira` is stored as 99 (outros). The fold's contract
   * leaves the count to its caller, and Amazon writes brands in CamelCase
   * (`MasterCard`, capture C1), so a compound one (`AmericanExpress`) lands
   * here rather than on its code. Never the brand itself.
   */
  bandeiraDesconhecida: 'bandeira-desconhecida',
  /**
   * (PR 7) A package the freight table does not know, or one without a usable
   * reference: no package status moved the freight estado (the aviso
   * `pacote-status-desconhecido` is the signal; this line counts it). Never the token.
   */
  pacoteNaoMapeado: 'pacote-nao-mapeado',
  /**
   * (PR 7) A `PENDING_SCHEDULE` package — or an order still to ship without
   * packages — whose invoice status is absent or unknown: no freight change,
   * never a guess.
   */
  notaFiscalNaoInformada: 'nota-fiscal-nao-informada',
  /** (PR 7) Invoice status `NOT_REQUIRED` on a `PENDING_SCHEDULE` read: unexpected for a BR Easy Ship order. */
  notaFiscalNaoExigida: 'nota-fiscal-nao-exigida',
  /** (PR 7) A non-empty stored `codRastreio` was replaced by Amazon's. Never the value. */
  codRastreioDivergente: 'codRastreio-divergente',
  /** (PR 7) A freight failure (`despachoNegado`, …) moved back to a live rung on a newer order clock. */
  freteRessuscitado: 'frete-ressuscitado',
  /**
   * (PR 5-f) One count line on EVERY read that derives the
   * `desconto-nao-detalhado` incidente (which is created once): the lines, never an amount.
   */
  descontoNaoDetalhado: 'desconto-nao-detalhado',
  /**
   * (PR 5-f) One count line on EVERY read that derives the `imposto-destacado`
   * incidente (which is created once): the TAX rows, never an amount.
   */
  impostoDestacado: 'imposto-destacado',
} as const satisfies Record<string, string>;

/** The freight events (PR 7): their log lines carry the package counts. */
export const EVENTOS_FRETE_AMAZON: ReadonlySet<EventoPedidoAmazon> = new Set<EventoPedidoAmazon>([
  EVENTO_PEDIDO_AMAZON.pacoteNaoMapeado,
  EVENTO_PEDIDO_AMAZON.notaFiscalNaoInformada,
  EVENTO_PEDIDO_AMAZON.notaFiscalNaoExigida,
  EVENTO_PEDIDO_AMAZON.codRastreioDivergente,
  EVENTO_PEDIDO_AMAZON.freteRessuscitado,
]);

/** The order-money events (PR 5-f): their log lines carry the ressalvas counts. */
export const EVENTOS_DINHEIRO_AMAZON: ReadonlySet<EventoPedidoAmazon> = new Set<EventoPedidoAmazon>(
  [EVENTO_PEDIDO_AMAZON.descontoNaoDetalhado, EVENTO_PEDIDO_AMAZON.impostoDestacado],
);

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
