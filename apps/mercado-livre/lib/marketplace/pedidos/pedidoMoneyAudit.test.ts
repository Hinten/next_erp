import { describe, expect, it } from 'vitest';
import type { ItemDoPedido } from '@delfrance/schemas';

import { auditarDescontoTotal, auditarValorCobrado, type FreteMoney } from './pedidoMoneyAudit';

function item(precoDeVenda: number, quantidade = 1): ItemDoPedido {
  return {
    produtoUid: 'p',
    ordem: 1,
    ensureUniqueId: `u-${precoDeVenda}`,
    mktplaceId: 'MLB1',
    sku: null,
    gtin: null,
    nomeDeVenda: 'Item',
    precoDeVenda,
    descontoUnitario: 0,
    quantidade,
    custo: null,
    timestamp: null,
    imposto: null,
  };
}

const frete = (valorCobrado: number): FreteMoney => ({
  valorCobrado,
  custoCalculado: null,
  custoFinal: null,
});

/*
 * ⚠️ A checker needs TWO controls. Every block below pins a known-GOOD pedido
 * producing NO finding and a known-BAD one producing one — a reconciliation
 * that only ever proves "no finding" is indistinguishable from one that cannot
 * report anything at all, which is how the version this replaces shipped two
 * phantom verdicts.
 */
describe('auditarValorCobrado — the owner decides which formula judges', () => {
  describe('BEFORE the conference: no freteInicial, so the SEED is the owner', () => {
    it('does NOT report the single-order live vector (49,97 + 12,99 rode the order payment)', () => {
      // The regression this module exists for. Judged by the conference's
      // formula this pedido looks R$ 12,99 short — a phantom on money that is
      // entirely correct, because the freight is in the payment, not a block.
      const r = auditarValorCobrado({
        valorCobradoArmazenado: 62.96,
        itens: [item(49.97)],
        descontoTotal: 0,
        frete: null,
        totalTransacoes: 49.97,
        totalShippingCost: 12.99,
        totalCupom: 0,
      });

      expect(r.dono).toBe('semente');
      expect(r.veredicto).toEqual({ tipo: 'confere' });
      // Anti-vacuity: the canonical figure really IS the one that would have
      // fired, so "confere" is the owner choice doing work, not an empty pass.
      expect(r.canonico).toBe(49.97);
      expect(r.esperado).toBe(62.96);
    });

    it('DOES report a seed that genuinely does not add up', () => {
      const r = auditarValorCobrado({
        valorCobradoArmazenado: 40,
        itens: [item(49.97)],
        descontoTotal: 0,
        frete: null,
        totalTransacoes: 49.97,
        totalShippingCost: 12.99,
        totalCupom: 0,
      });

      expect(r.veredicto).toEqual({ tipo: 'achado', gap: -22.96 });
    });

    it('treats an off-by-descontoTotal seed as a real finding, not the known coupon gap', () => {
      // The coupon carve-out belongs to the conference alone: the seed
      // subtracts the coupon itself, so a gap of exactly that size there means
      // something else went wrong.
      const r = auditarValorCobrado({
        valorCobradoArmazenado: 62.96,
        itens: [item(49.97)],
        descontoTotal: 10,
        frete: null,
        totalTransacoes: 49.97,
        totalShippingCost: 12.99,
        totalCupom: 10,
      });

      expect(r.esperado).toBe(52.96); // seed nets the coupon
      expect(r.veredicto).toEqual({ tipo: 'achado', gap: 10 });
    });
  });

  describe('AFTER the conference: freteInicial present, so the canonical derive judges', () => {
    it('does NOT report the PACK live vector (149,94 items + 85,99 shipment freight)', () => {
      const r = auditarValorCobrado({
        valorCobradoArmazenado: 235.93,
        itens: [item(50), item(99.94)],
        descontoTotal: 0,
        frete: frete(85.99),
        // The pack's own payments: no shipping_cost anywhere, and the seed was
        // orders[0] alone — both far from the stored value, and neither judges.
        totalTransacoes: 149.94,
        totalShippingCost: 0,
        totalCupom: 0,
      });

      expect(r.dono).toBe('conferencia');
      expect(r.veredicto).toEqual({ tipo: 'confere' });
      expect(r.semente).toBe(149.94); // the context row, deliberately different
    });

    it('DOES report a pack total that is short by the freight', () => {
      // The dangerous value: at 149,94 the `pago` advance fires with the
      // buyer's freight payment still uncounted.
      const r = auditarValorCobrado({
        valorCobradoArmazenado: 149.94,
        itens: [item(50), item(99.94)],
        descontoTotal: 0,
        frete: frete(85.99),
        totalTransacoes: 149.94,
        totalShippingCost: 0,
        totalCupom: 0,
      });

      expect(r.veredicto).toEqual({ tipo: 'achado', gap: -85.99 });
    });

    it('names an off-by-descontoTotal gap instead of reporting it', () => {
      // `applyFreteStep` omits the coupon term the canonical derive has. Known,
      // unsettled until live step 6.3 — so it is named, never a finding.
      const r = auditarValorCobrado({
        valorCobradoArmazenado: 120,
        itens: [item(100)],
        descontoTotal: 5,
        frete: frete(20),
        totalTransacoes: 100,
        totalShippingCost: 0,
        totalCupom: 5,
      });

      expect(r.esperado).toBe(115);
      expect(r.veredicto).toEqual({ tipo: 'diferenca-conhecida', descontoTotal: 5 });
    });

    it('still reports a gap that merely LOOKS like the coupon when there is none', () => {
      // `descontoTotal: 0` must never swallow a real R$ 0 … 0 gap match. Guards
      // the `descontoTotal !== 0` half of the carve-out.
      const r = auditarValorCobrado({
        valorCobradoArmazenado: 120,
        itens: [item(100)],
        descontoTotal: 0,
        frete: frete(25),
        totalTransacoes: 100,
        totalShippingCost: 0,
        totalCupom: 0,
      });

      expect(r.veredicto).toEqual({ tipo: 'achado', gap: -5 });
    });
  });

  it('reports an absent total — the advance refuses a null valorCobrado (#791)', () => {
    const r = auditarValorCobrado({
      valorCobradoArmazenado: null,
      itens: [item(100)],
      descontoTotal: 0,
      frete: frete(20),
      totalTransacoes: 100,
      totalShippingCost: 0,
      totalCupom: 0,
    });

    expect(r.veredicto).toEqual({ tipo: 'ausente' });
  });
});

describe('auditarDescontoTotal', () => {
  it('gives NO verdict on a pack — the writer used orders[0], the sum spans all', () => {
    const r = auditarDescontoTotal({
      descontoTotalArmazenado: 0, // orders[0] carried no coupon…
      totalCupom: 12.5, // …but a sibling did
      ehPack: true,
    });

    expect(r).toEqual({ tipo: 'sem-veredito-pack', somaDoPack: 12.5 });
  });

  it('DOES judge a single order, both ways', () => {
    expect(
      auditarDescontoTotal({ descontoTotalArmazenado: 12.5, totalCupom: 12.5, ehPack: false }),
    ).toEqual({ tipo: 'confere' });
    expect(
      auditarDescontoTotal({ descontoTotalArmazenado: 0, totalCupom: 12.5, ehPack: false }),
    ).toEqual({ tipo: 'diverge', recalculado: 12.5 });
  });

  it('reports an absent value on a single order', () => {
    expect(
      auditarDescontoTotal({ descontoTotalArmazenado: undefined, totalCupom: 0, ehPack: false }),
    ).toEqual({ tipo: 'ausente' });
  });
});
