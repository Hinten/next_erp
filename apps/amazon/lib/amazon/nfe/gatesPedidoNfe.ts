/**
 * The LIVE order's gates before an NF-e upload (step 14, PR 14-b): what the
 * `getOrder` read of THIS dispatch says about whether the sale may receive its
 * note. Pure: the read is the caller's (`pedidos/lerPedidoAmazon.ts`, the one
 * `getOrder` caller, PR 14-c), and this module only reads its answer.
 *
 * Why live and on every dispatch: the open cancellation request exists only on
 * `getOrder`, and capture C1 showed a CANCELLED order keeping its order-level
 * `invoiceStatus` `ACCEPTED`, so neither the stored pedido nor the invoice
 * status proves the sale is live (step-14 plan §3 decision 8).
 *
 * ## The gates, in order (the first match answers)
 *
 * 1. `fulfillmentStatus` `CANCELLED` ⇒ `pedido-cancelado`;
 * 2. `PENDING` or `PENDING_AVAILABILITY` (the importer's `pre` phase) ⇒
 *    `pedido-pendente`: not paid yet, no note;
 * 3. an OPEN cancellation request — a line carrying `cancellationRequest`
 *    without its own `cancellationExecution`, read through the importer's own
 *    line reader (`pedidos/itensAmazon.ts`, imported, never copied) ⇒
 *    `cancelamento-solicitado`;
 * 4. `fulfilledBy` other than `MERCHANT`, or `programs` without
 *    `DELIVERY_BY_AMAZON` (absent included) ⇒ `nao-dba`: not a
 *    Delivery-by-Amazon order (D7's scope edge). ⚠️ Never keyed on
 *    `AMAZON_EASY_SHIP`, which no real BR capture carries;
 * 5. the ORDER-level `tax.taxInvoicing.invoiceStatus` `NOT_REQUIRED` ⇒
 *    `nf-nao-requerida` — the one place in the NF-e folder that reads the
 *    UPPER_SNAKE order vocabulary (`INVOICE_STATUS_AMAZON`), and only for this
 *    arm: it never meets the Delivery API's PascalCase statuses;
 * 6. any other status (absent, `UNFULFILLABLE`, a value this code does not
 *    know) ⇒ `status-pedido-desconhecido`;
 * 7. `UNSHIPPED`, `PARTIALLY_SHIPPED`, `SHIPPED` ⇒ `segue`.
 *
 * Every comparison is exact (the importer's phase reader and constants), so a
 * `'cancelled'` or a `'DELIVERY_BY_AMAZON '` is not a match.
 *
 * @throws {PedidoAmazonIlegivelError} (from the line reader) an order whose two
 *   lines share an `orderItemId`: a line identity cannot be built.
 */
import type { PedidoWireAmazon } from '@delfrance/integrations-amazon-sp-api';

import { INVOICE_STATUS_AMAZON } from '../frete/estadoFreteAmazon';
import { FULFILLED_BY_AMAZON } from '../pedidos/estadoPedidoAmazon';
import { linhasRecebidasAmazon } from '../pedidos/itensAmazon';
import { faseVendaAmazon } from '../pedidos/vendaAmazon';
import { MOTIVO_NFE_AMAZON } from './motivosNfe';
import { PROGRAMA_DBA_AMAZON } from './pedidoNfe';

/** Why the live order stops an upload. */
export type MotivoPortaoPedidoNfeAmazon =
  | typeof MOTIVO_NFE_AMAZON.pedidoCancelado
  | typeof MOTIVO_NFE_AMAZON.pedidoPendente
  | typeof MOTIVO_NFE_AMAZON.cancelamentoSolicitado
  | typeof MOTIVO_NFE_AMAZON.naoDba
  | typeof MOTIVO_NFE_AMAZON.nfNaoRequerida
  | typeof MOTIVO_NFE_AMAZON.statusPedidoDesconhecido;

/** The live order's verdict. */
export type PortaoPedidoNfeAmazon =
  | { readonly segue: true }
  | { readonly segue: false; readonly motivo: MotivoPortaoPedidoNfeAmazon };

const parar = (motivo: MotivoPortaoPedidoNfeAmazon): PortaoPedidoNfeAmazon => ({
  segue: false,
  motivo,
});

/**
 * Whether some line carries a request its OWN execution has not closed (gate 3).
 * EXPORTED for the Easy Ship scheduling decision (step 15), which refuses on the
 * same open request: one predicate, never a second copy of it.
 */
export function solicitacaoCancelamentoAbertaAmazon(order: PedidoWireAmazon): boolean {
  return linhasRecebidasAmazon(order).some(
    (l) => l.solicitacaoCancelamento && !l.execucaoCancelamento,
  );
}

/**
 * Whether the order is merchant-fulfilled AND in the Delivery-by-Amazon program
 * (gate 4). EXPORTED for the Easy Ship scheduling decision (step 15), which
 * schedules only such an order: one predicate, never a second copy of it.
 */
export function ehPedidoDbaAmazon(order: PedidoWireAmazon): boolean {
  if (order.fulfillment?.fulfilledBy !== FULFILLED_BY_AMAZON.merchant) return false;
  const programas = order.programs;
  return Array.isArray(programas) && programas.includes(PROGRAMA_DBA_AMAZON);
}

/** The live order's gates (module header). */
export function gatesDoPedidoAmazonParaNfe(order: PedidoWireAmazon): PortaoPedidoNfeAmazon {
  const fase = faseVendaAmazon(order.fulfillment?.fulfillmentStatus);
  if (fase === 'cancelado') return parar(MOTIVO_NFE_AMAZON.pedidoCancelado);
  if (fase === 'pre') return parar(MOTIVO_NFE_AMAZON.pedidoPendente);
  if (solicitacaoCancelamentoAbertaAmazon(order)) {
    return parar(MOTIVO_NFE_AMAZON.cancelamentoSolicitado);
  }
  if (!ehPedidoDbaAmazon(order)) return parar(MOTIVO_NFE_AMAZON.naoDba);
  if (order.tax?.taxInvoicing?.invoiceStatus === INVOICE_STATUS_AMAZON.notRequired) {
    return parar(MOTIVO_NFE_AMAZON.nfNaoRequerida);
  }
  if (fase === 'desconhecida') return parar(MOTIVO_NFE_AMAZON.statusPedidoDesconhecido);
  return { segue: true };
}
