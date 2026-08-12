/**
 * Mercado Livre → ERP status maps for the order-import pipeline. Ports three
 * legacy switches onto our schema's enum values:
 *  - `STATUS_ORDER_ML.estadoPedido` (order → pedido state)
 *    `.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:2403-2436`
 *  - `MERCADOLIVREPAYMENT_STATUS.toStatusPagamento` (payment → pagamento status)
 *    `.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:4226-4247`
 *  - `STATUS_SHIPPMENT_MERCADO_LIVRE.toEstadoFrete` +
 *    `MercadoLivreShipping.toEstadoFrete` (shipment → frete state, substatus-aware)
 *    `.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:5095-5116,
 *    5340-5362`
 *
 * All three are pure switches over raw strings — no IO. Each one is
 * deliberately MORE tolerant of an unrecognized value than its legacy
 * counterpart (documented per-function below) EXCEPT the payment-status map,
 * which is deliberately STRICTER (throws) — money correctness outranks
 * import availability there.
 */
import {
  ESTADO_FRETE,
  ESTADO_PEDIDO,
  STATUS_PAGAMENTO,
  type EstadoFrete,
  type EstadoPedido,
  type StatusPagamento,
} from '@delfrance/schemas';

/**
 * ML order `status` → `EstadoPedido`. Mirrors `STATUS_ORDER_ML.estadoPedido`
 * (models.dart:2403-2436).
 *
 * Deviation from legacy: legacy's own `STATUS_ORDER_ML.fromValue` THROWS on an
 * unrecognized raw status before this switch ever runs — in Dart the switch's
 * `default` branch (→ `iniciado`) is effectively dead code, since `this` is
 * already a validated enum member by the time `estadoPedido` runs. This port
 * is deliberately tolerant instead: a status ML adds in the future (or a
 * malformed webhook payload) degrades to `'iniciado'` rather than aborting the
 * whole order import.
 */
export function estadoPedidoFromOrderStatus(status: string): EstadoPedido {
  switch (status) {
    case 'confirmed':
      return ESTADO_PEDIDO.carrinho;
    case 'payment_required':
      return ESTADO_PEDIDO.escolhendoFormaDePagamento;
    case 'payment_in_process':
    case 'partially_paid':
      return ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento;
    case 'paid':
      return ESTADO_PEDIDO.emProcessamento;
    case 'partially_refunded':
      return ESTADO_PEDIDO.estornadoParcialmente;
    case 'pending_cancel':
      return ESTADO_PEDIDO.estornadoIntegralmente;
    case 'cancelled':
      return ESTADO_PEDIDO.cancelado;
    case 'invalid':
      return ESTADO_PEDIDO.fraude;
    default:
      return ESTADO_PEDIDO.iniciado;
  }
}

/**
 * Thrown by `statusPagamentoFromMlPaymentStatus` for a raw ML payment `status`
 * outside the known set.
 *
 * Deliberate divergence from legacy here (the ONE map in this file that gets
 * STRICTER, not more tolerant): `MERCADOLIVREPAYMENT_STATUS.fromString`
 * (models.dart:4217-4219) silently DEFAULTS an unrecognized value to `pending`
 * (`orElse: () => MERCADOLIVREPAYMENT_STATUS.pending`) — it never throws. This
 * port refuses to guess instead: an unrecognized payment status fails the
 * import loudly (retriable/investigable) rather than silently recording a real
 * payment as `pendente`, which could understate what the customer actually
 * paid if the true status were e.g. `approved` under a name ML hasn't
 * documented yet.
 */
export class MlStatusDesconhecidoError extends Error {
  constructor(readonly status: string) {
    super(`Status de pagamento Mercado Livre desconhecido: "${status}"`);
    this.name = 'MlStatusDesconhecidoError';
  }
}

/**
 * ML payment `status` → `StatusPagamento`. Mirrors
 * `MERCADOLIVREPAYMENT_STATUS.toStatusPagamento` (models.dart:4226-4247). See
 * `MlStatusDesconhecidoError`'s docstring for the one deliberate behavioral
 * deviation (throw instead of legacy's silent `pending` default).
 */
export function statusPagamentoFromMlPaymentStatus(status: string): StatusPagamento {
  switch (status) {
    case 'pending':
      return STATUS_PAGAMENTO.pendente;
    case 'approved':
      return STATUS_PAGAMENTO.aprovado;
    case 'authorized':
      return STATUS_PAGAMENTO.em_processo_aprovacao;
    case 'in_process':
      return STATUS_PAGAMENTO.em_revisao;
    case 'in_mediation':
      return STATUS_PAGAMENTO.em_disputa;
    case 'rejected':
      return STATUS_PAGAMENTO.recusado;
    case 'cancelled':
      return STATUS_PAGAMENTO.cancelado;
    case 'refunded':
      return STATUS_PAGAMENTO.estornado;
    case 'charged_back':
      return STATUS_PAGAMENTO.devolvido;
    default:
      throw new MlStatusDesconhecidoError(status);
  }
}

/**
 * Base ML shipment `status` → `EstadoFrete`, ignoring substatus. Mirrors
 * `STATUS_SHIPPMENT_MERCADO_LIVRE.toEstadoFrete` (models.dart:5095-5116).
 * Unknown status → `'iniciado'` (legacy throws here, but this port is
 * tolerant — see `estadoFreteFromShipment`'s docstring).
 */
function estadoFreteFromBaseStatus(status: string): EstadoFrete {
  switch (status) {
    case 'handling':
      return ESTADO_FRETE.empacotado;
    case 'invoice_pending':
      return ESTADO_FRETE.aguardandoAutorizacao;
    case 'ready_to_ship':
      return ESTADO_FRETE.despachoAutorizado;
    case 'shipped':
      return ESTADO_FRETE.postado;
    case 'delivered':
      return ESTADO_FRETE.entregue;
    case 'not_delivered':
      return ESTADO_FRETE.falhaNaEntrega;
    case 'cancelled':
      return ESTADO_FRETE.cancelado;
    case 'pending':
      return ESTADO_FRETE.iniciado;
    default:
      return ESTADO_FRETE.iniciado;
  }
}

/**
 * ML shipment `status` (+ optional `substatus`) → `EstadoFrete`. Mirrors
 * `MercadoLivreShipping.toEstadoFrete` (models.dart:5340-5362): substatus is
 * honored ONLY when `status === 'ready_to_ship'` AND a substatus is present;
 * every other combination falls back to the base status map
 * ({@link estadoFreteFromBaseStatus}) — matching legacy's own fallthrough
 * (`return status.toEstadoFrete();`) exactly.
 *
 * Approved deviation: legacy actually had TWO inconsistent variants — the
 * order-import path (`OrderML.freteFromMercadoLivre`) called the
 * substatus-aware `shippingInstance.toEstadoFrete()`, while the standalone
 * `MercadoLivreShipping.toFrete` path read `status.toEstadoFrete()` directly,
 * ignoring substatus even when present. This port uses ONE substatus-honoring
 * function everywhere (this one, called from `orderShipmentMapping.ts`).
 *
 * `waiting_for_carrier_authorization` maps to `aguardandoValidacaoTransporadora`
 * — reproducing the legacy enum member name CHARACTER-FOR-CHARACTER, typo
 * included (`Transporadora`, missing the second `t`); our `estadoFreteSchema`
 * (`packages/schemas/src/shared/frete.ts:73`) carries that exact same
 * spelling, so this is a byte-exact match to an existing schema value, not a
 * bug being introduced here.
 *
 * Unknown status/substatus → `'iniciado'` (tolerant default — legacy's own
 * switch THROWS on an unrecognized status, but an ML-added status/substatus
 * should degrade shipment tracking, not abort the whole order import).
 */
export function estadoFreteFromShipment(status: string, substatus?: string | null): EstadoFrete {
  if (status === 'ready_to_ship' && substatus != null) {
    switch (substatus) {
      case 'invoice_pending':
        return ESTADO_FRETE.aguardandoNFe;
      case 'waiting_for_carrier_authorization':
        return ESTADO_FRETE.aguardandoValidacaoTransporadora;
      case 'ready_to_print':
        return ESTADO_FRETE.despachoAutorizado;
      case 'ready_for_pickup':
        return ESTADO_FRETE.aguardandoPostagem;
      default:
        return ESTADO_FRETE.postado;
    }
  }
  return estadoFreteFromBaseStatus(status);
}
