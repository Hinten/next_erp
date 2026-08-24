import { describe, it, expect } from 'vitest';
import { ESTADO_FRETE, ESTADO_PEDIDO, STATUS_PAGAMENTO } from '@delfrance/schemas';
import {
  MlStatusDesconhecidoError,
  estadoFreteFromShipment,
  estadoPedidoFromOrderStatus,
  statusPagamentoFromMlPaymentStatus,
} from './orderStatusMaps';

describe('estadoPedidoFromOrderStatus', () => {
  it.each([
    ['confirmed', ESTADO_PEDIDO.carrinho],
    ['payment_required', ESTADO_PEDIDO.escolhendoFormaDePagamento],
    ['payment_in_process', ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento],
    ['partially_paid', ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento],
    ['paid', ESTADO_PEDIDO.emProcessamento], // NOT 'pago' — legacy quirk, deliberately preserved
    ['partially_refunded', ESTADO_PEDIDO.estornadoParcialmente],
    ['pending_cancel', ESTADO_PEDIDO.estornadoIntegralmente],
    ['cancelled', ESTADO_PEDIDO.cancelado],
    ['invalid', ESTADO_PEDIDO.fraude],
  ] as const)('maps ML order status "%s" to "%s"', (status, expected) => {
    expect(estadoPedidoFromOrderStatus(status)).toBe(expected);
  });

  it('defaults an unknown/empty status to "iniciado" (tolerant read)', () => {
    expect(estadoPedidoFromOrderStatus('a_future_ml_status')).toBe('iniciado');
    expect(estadoPedidoFromOrderStatus('')).toBe('iniciado');
  });
});

describe('statusPagamentoFromMlPaymentStatus', () => {
  it.each([
    ['pending', STATUS_PAGAMENTO.pendente],
    ['approved', STATUS_PAGAMENTO.aprovado],
    ['authorized', STATUS_PAGAMENTO.em_processo_aprovacao],
    ['in_process', STATUS_PAGAMENTO.em_revisao],
    ['in_mediation', STATUS_PAGAMENTO.em_disputa],
    ['rejected', STATUS_PAGAMENTO.recusado],
    ['cancelled', STATUS_PAGAMENTO.cancelado],
    ['refunded', STATUS_PAGAMENTO.estornado],
    ['charged_back', STATUS_PAGAMENTO.devolvido],
  ] as const)('maps ML payment status "%s" to %i', (status, expected) => {
    expect(statusPagamentoFromMlPaymentStatus(status)).toBe(expected);
  });

  it('throws MlStatusDesconhecidoError for an unrecognized status (does NOT silently default to pendente)', () => {
    expect(() => statusPagamentoFromMlPaymentStatus('a_future_ml_status')).toThrow(
      MlStatusDesconhecidoError,
    );

    let caught: MlStatusDesconhecidoError | undefined;
    try {
      statusPagamentoFromMlPaymentStatus('bogus');
    } catch (err) {
      if (!(err instanceof MlStatusDesconhecidoError)) throw err;
      caught = err;
    }
    expect(caught).toBeInstanceOf(MlStatusDesconhecidoError);
    expect(caught?.status).toBe('bogus');
    expect(caught?.message).toContain('bogus');
  });

  it("throws for an empty status (the caller's `payment.status ?? ''` fallback)", () => {
    expect(() => statusPagamentoFromMlPaymentStatus('')).toThrow(MlStatusDesconhecidoError);
  });
});

describe('estadoFreteFromShipment', () => {
  it.each([
    ['handling', ESTADO_FRETE.empacotado],
    ['invoice_pending', ESTADO_FRETE.aguardandoAutorizacao],
    ['ready_to_ship', ESTADO_FRETE.despachoAutorizado],
    ['shipped', ESTADO_FRETE.postado],
    ['delivered', ESTADO_FRETE.entregue],
    ['not_delivered', ESTADO_FRETE.falhaNaEntrega],
    ['cancelled', ESTADO_FRETE.cancelado],
    ['pending', ESTADO_FRETE.iniciado],
  ] as const)('maps base shipment status "%s" to "%s" (no substatus)', (status, expected) => {
    expect(estadoFreteFromShipment(status)).toBe(expected);
    expect(estadoFreteFromShipment(status, null)).toBe(expected);
  });

  it('defaults an unknown status to "iniciado"', () => {
    expect(estadoFreteFromShipment('a_future_ml_status')).toBe('iniciado');
  });

  it.each([
    ['invoice_pending', ESTADO_FRETE.aguardandoNFe],
    ['waiting_for_carrier_authorization', ESTADO_FRETE.aguardandoValidacaoTransporadora],
    ['ready_to_print', ESTADO_FRETE.despachoAutorizado],
    ['ready_for_pickup', ESTADO_FRETE.aguardandoPostagem],
  ] as const)(
    'honors the "ready_to_ship" substatus override "%s" -> "%s"',
    (substatus, expected) => {
      expect(estadoFreteFromShipment('ready_to_ship', substatus)).toBe(expected);
    },
  );

  it('an unrecognized substatus under ready_to_ship falls back to "postado"', () => {
    expect(estadoFreteFromShipment('ready_to_ship', 'some_future_substatus')).toBe('postado');
  });

  it('substatus is IGNORED when status is not "ready_to_ship" (matches legacy fallthrough)', () => {
    expect(estadoFreteFromShipment('shipped', 'invoice_pending')).toBe('postado');
    expect(estadoFreteFromShipment('handling', 'waiting_for_carrier_authorization')).toBe(
      'empacotado',
    );
  });

  it('no substatus on ready_to_ship falls back to the base status mapping', () => {
    expect(estadoFreteFromShipment('ready_to_ship')).toBe('despachoAutorizado');
    expect(estadoFreteFromShipment('ready_to_ship', undefined)).toBe('despachoAutorizado');
  });
});
