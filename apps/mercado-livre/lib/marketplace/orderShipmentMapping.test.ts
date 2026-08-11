import { describe, expect, it } from 'vitest';
import type { MlShipment, MlShipmentPayment } from '@delfrance/integrations-mercado-livre';
import { ESTADO_FRETE } from '@delfrance/schemas';
import type { EstadoFrete } from '@delfrance/schemas';
import {
  mergeEstadoFretePreservando,
  mergeFreteInicial,
  mlShipmentToFreteInicial,
} from './orderShipmentMapping';

function shipment(over: Partial<MlShipment> = {}): MlShipment {
  return {
    id: 41602594503,
    status: 'shipped',
    substatus: null,
    tracking_number: 'MEL00002438290969',
    last_updated: '2026-07-20T14:38:37.322-03:00',
    // The `x-format-new` body (#957): delivery windows and `list_cost` live
    // under `lead_time`. `base_cost` has NO counterpart there, so it stays on
    // the legacy side — two different quantities, not one renamed. The captured
    // real payloads at the bottom of this file are why.
    base_cost: 16.2,
    lead_time: {
      list_cost: 8.91,
      estimated_delivery_time: { date: '2026-07-24T00:00:00.000-03:00' },
    },
    ...over,
  };
}

function shippingPayment(over: Partial<MlShipmentPayment> = {}): MlShipmentPayment {
  return { status: 'approved', amount: 8.91, ...over };
}

describe('mlShipmentToFreteInicial', () => {
  it('maps a shipped shipment onto the frete fields, summing approved-only shipping payments', () => {
    const mapped = mlShipmentToFreteInicial({
      shipment: shipment(),
      shippingPayments: [
        shippingPayment({ amount: 8.91 }),
        shippingPayment({ status: 'pending', amount: 99 }),
      ],
      integracaoFreteOuterRef: 'documents/mercadoEnvios/int1',
      enderecoOuterRef: 'documents/endereco/end1',
      prazoDespachoUs: 1_753_000_000_000_000,
      modalidadeOverride: null,
    });

    expect(mapped.externalId).toBe('41602594503');
    expect(mapped.externalOptionIntegracao).toBe('mercadoLivre');
    expect(mapped.estado).toBe('postado'); // base status mapping for 'shipped', no substatus
    expect(mapped.integracaoFreteOuterRef).toBe('documents/mercadoEnvios/int1');
    expect(mapped.enderecoFreteOuterReference).toBe('documents/endereco/end1');
    expect(mapped.modalidade).toBe('1'); // no override → contratacaoDestinatario
    expect(mapped.codRastreio).toBe('MEL00002438290969');
    expect(mapped.valorCobrado).toBe(8.91); // only the 'approved' entry counts, the 'pending' one is excluded
    expect(mapped.custoCalculado).toBe(16.2);
    expect(mapped.custoFinal).toBe(8.91);
    expect(mapped.dataPrevisaoEntrega).toBe(Date.parse('2026-07-24T00:00:00.000-03:00') * 1000);
    expect(mapped.ultimaModificacao).toBe(Date.parse('2026-07-20T14:38:37.322-03:00') * 1000);
    expect(mapped.prazoDespacho).toBe(1_753_000_000_000_000);
  });

  it('sums multiple approved shipping payments and tolerates a numeric-string amount', () => {
    const mapped = mlShipmentToFreteInicial({
      shipment: shipment(),
      shippingPayments: [
        shippingPayment({ amount: 5 }),
        shippingPayment({ amount: '3.5' }),
        shippingPayment({ status: 'rejected', amount: 1000 }),
      ],
      integracaoFreteOuterRef: null,
      enderecoOuterRef: null,
      prazoDespachoUs: null,
      modalidadeOverride: null,
    });
    expect(mapped.valorCobrado).toBe(8.5);
  });

  it('treats an unparseable shipping-payment amount as 0, matching legacy double.tryParse ?? 0', () => {
    const mapped = mlShipmentToFreteInicial({
      shipment: shipment(),
      shippingPayments: [shippingPayment({ amount: 'not-a-number' })],
      integracaoFreteOuterRef: null,
      enderecoOuterRef: null,
      prazoDespachoUs: null,
      modalidadeOverride: null,
    });
    expect(mapped.valorCobrado).toBe(0);
  });

  it('reports a MISSING list_cost as null, never as a fabricated 0', () => {
    // The distinction is load-bearing: `mergeFreteInicial` preserves the stored
    // value on `null`, so an omitted cost can no longer overwrite a correct one
    // with zero (#957). Legacy mapped `?? 0` and merged unconditionally.
    const mapped = mlShipmentToFreteInicial({
      shipment: shipment({ lead_time: { list_cost: null } }),
      shippingPayments: [],
      integracaoFreteOuterRef: null,
      enderecoOuterRef: null,
      prazoDespachoUs: null,
      modalidadeOverride: null,
    });
    expect(mapped.custoFinal).toBeNull();
    expect(mapped.custoCalculado).toBe(16.2); // present → still mapped
    expect(mapped.dataPrevisaoEntrega).toBeNull();
  });

  it('honors a modalidadeOverride when provided', () => {
    const mapped = mlShipmentToFreteInicial({
      shipment: shipment(),
      shippingPayments: [],
      integracaoFreteOuterRef: null,
      enderecoOuterRef: null,
      prazoDespachoUs: null,
      modalidadeOverride: '0',
    });
    expect(mapped.modalidade).toBe('0');
  });

  it('honors the substatus override only while status == ready_to_ship', () => {
    const mapped = mlShipmentToFreteInicial({
      shipment: shipment({ status: 'ready_to_ship', substatus: 'invoice_pending' }),
      shippingPayments: [],
      integracaoFreteOuterRef: null,
      enderecoOuterRef: null,
      prazoDespachoUs: null,
      modalidadeOverride: null,
    });
    expect(mapped.estado).toBe('aguardandoNFe');
  });

  it('maps every base STATUS_SHIPPMENT_MERCADO_LIVRE value with no substatus', () => {
    const table: Array<[string, EstadoFrete]> = [
      ['handling', ESTADO_FRETE.empacotado],
      ['invoice_pending', ESTADO_FRETE.aguardandoAutorizacao],
      ['ready_to_ship', ESTADO_FRETE.despachoAutorizado],
      ['shipped', ESTADO_FRETE.postado],
      ['delivered', ESTADO_FRETE.entregue],
      ['not_delivered', ESTADO_FRETE.falhaNaEntrega],
      ['cancelled', ESTADO_FRETE.cancelado],
      ['pending', ESTADO_FRETE.iniciado],
    ];
    for (const [status, expected] of table) {
      const mapped = mlShipmentToFreteInicial({
        shipment: shipment({ status, substatus: null }),
        shippingPayments: [],
        integracaoFreteOuterRef: null,
        enderecoOuterRef: null,
        prazoDespachoUs: null,
        modalidadeOverride: null,
      });
      expect(mapped.estado).toBe(expected);
    }
  });

  it('handles a null lead_time — every cost becomes null, nothing is invented', () => {
    const mapped = mlShipmentToFreteInicial({
      shipment: shipment({ lead_time: null, base_cost: null, tracking_number: null }),
      shippingPayments: [],
      integracaoFreteOuterRef: null,
      enderecoOuterRef: null,
      prazoDespachoUs: null,
      modalidadeOverride: null,
    });
    expect(mapped.custoFinal).toBeNull();
    expect(mapped.custoCalculado).toBeNull();
    expect(mapped.dataPrevisaoEntrega).toBeNull();
    expect(mapped.codRastreio).toBeNull();
  });
});

describe('mergeEstadoFretePreservando', () => {
  it('keeps despachoAutorizado when the incoming estado is a pre-authorization regression (iniciado)', () => {
    expect(
      mergeEstadoFretePreservando(ESTADO_FRETE.despachoAutorizado, ESTADO_FRETE.iniciado),
    ).toBe('despachoAutorizado');
  });

  it('keeps despachoAutorizado when the incoming estado regresses to aguardandoAutorizacao', () => {
    expect(
      mergeEstadoFretePreservando(
        ESTADO_FRETE.despachoAutorizado,
        ESTADO_FRETE.aguardandoAutorizacao,
      ),
    ).toBe('despachoAutorizado');
  });

  it('does NOT preserve despachoAutorizado against an unrelated incoming estado (forward progress wins)', () => {
    expect(mergeEstadoFretePreservando(ESTADO_FRETE.despachoAutorizado, ESTADO_FRETE.postado)).toBe(
      'postado',
    );
  });

  it('keeps checkFinalizado when the incoming estado is any pre-checkout estado', () => {
    const preCheckout: EstadoFrete[] = [
      ESTADO_FRETE.fulfillment,
      ESTADO_FRETE.iniciado,
      ESTADO_FRETE.aguardandoAutorizacao,
      ESTADO_FRETE.aguardandoNFe,
      ESTADO_FRETE.aguardandoValidacaoTransporadora,
      ESTADO_FRETE.despachoAutorizado,
      ESTADO_FRETE.emSeparacao,
      ESTADO_FRETE.empacotado,
      ESTADO_FRETE.aguardandoPostagem,
    ];
    for (const novo of preCheckout) {
      expect(mergeEstadoFretePreservando(ESTADO_FRETE.checkFinalizado, novo)).toBe(
        'checkFinalizado',
      );
    }
  });

  it('lets checkFinalizado be overwritten by a genuine post-checkout estado (postado)', () => {
    expect(mergeEstadoFretePreservando(ESTADO_FRETE.checkFinalizado, ESTADO_FRETE.postado)).toBe(
      'postado',
    );
  });

  it('lets checkFinalizado be overwritten by a terminal estado (entregue)', () => {
    expect(mergeEstadoFretePreservando(ESTADO_FRETE.checkFinalizado, ESTADO_FRETE.entregue)).toBe(
      'entregue',
    );
  });

  it('otherwise always takes the incoming estado (no special-cased old estado)', () => {
    expect(mergeEstadoFretePreservando(ESTADO_FRETE.iniciado, ESTADO_FRETE.empacotado)).toBe(
      'empacotado',
    );
    expect(mergeEstadoFretePreservando(ESTADO_FRETE.postado, ESTADO_FRETE.entregue)).toBe(
      'entregue',
    );
    expect(mergeEstadoFretePreservando(ESTADO_FRETE.entregue, ESTADO_FRETE.cancelado)).toBe(
      'cancelado',
    );
  });
});

/* ---------------- captured real ML payloads: base_cost is its own quantity --------------- */
// These two shipments were captured from the live API and sit verbatim in
// `.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart`. They are the
// evidence that `lead_time.cost` must NEVER stand in for the legacy `base_cost`
// (#957) — a substitution that looks harmless and silently wipes the freight
// cost from a pedido. Keep them: a synthetic fixture cannot make this argument.

describe('mlShipmentToFreteInicial — real captured payloads', () => {
  it('free shipping: cost is 0 while base_cost is 38.90 — the 0 must never reach custoCalculado', () => {
    // `.old/…/models.dart:3128,3150,3154` — base_cost: 38.9, cost: 0, list_cost: 19.45.
    // Free shipping is a 100% discount, so ML's `cost` is a GENUINE zero. Were it
    // mapped to `custoCalculado`, `??` would not treat it as missing: it would
    // overwrite a correct stored value and then beat `custoFinal` in
    // `derivePedidoFreteTotals`' `custoCalculado ?? custoFinal` precedence,
    // zeroing the freight cost on the orders where it is largest.
    const mapped = mlShipmentToFreteInicial({
      shipment: shipment({
        base_cost: 38.9,
        lead_time: { cost: 0, list_cost: 19.45 } as never,
      }),
      shippingPayments: [],
      integracaoFreteOuterRef: null,
      enderecoOuterRef: null,
      prazoDespachoUs: null,
      modalidadeOverride: null,
    });
    expect(mapped.custoCalculado).toBe(38.9);
    expect(mapped.custoCalculado).not.toBe(0);
    expect(mapped.custoFinal).toBe(19.45);
  });

  it('paid with NO discount: cost === list_cost, yet base_cost is nearly double', () => {
    // `.old/…/models.dart:5122,5142,5147` — base_cost: 16.2, cost: 8.91, list_cost: 8.91.
    // The decisive sample: nothing is discounted here, so "they agree when there
    // is no discount" is simply false. `base_cost` is a different quantity, and
    // reading `cost` would understate this shipment's cost by 45%.
    const mapped = mlShipmentToFreteInicial({
      shipment: shipment({
        base_cost: 16.2,
        lead_time: { cost: 8.91, list_cost: 8.91 } as never,
      }),
      shippingPayments: [],
      integracaoFreteOuterRef: null,
      enderecoOuterRef: null,
      prazoDespachoUs: null,
      modalidadeOverride: null,
    });
    expect(mapped.custoCalculado).toBe(16.2);
    expect(mapped.custoFinal).toBe(8.91);
  });

  it('a migrated body without base_cost yields null, so the merge PRESERVES the stored cost', () => {
    // The whole point of returning null rather than substituting: losing the
    // field is acceptable, overwriting a correct value with a different quantity
    // is not.
    const mapped = mlShipmentToFreteInicial({
      shipment: shipment({ base_cost: null, lead_time: { cost: 0, list_cost: 19.45 } as never }),
      shippingPayments: [],
      integracaoFreteOuterRef: null,
      enderecoOuterRef: null,
      prazoDespachoUs: null,
      modalidadeOverride: null,
    });
    expect(mapped.custoCalculado).toBeNull();

    const merged = mergeFreteInicial({ custoCalculado: 38.9, custoFinal: 19.45 } as never, mapped);
    expect(merged.custoCalculado).toBe(38.9);
  });
});
