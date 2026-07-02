import { describe, expect, it } from 'vitest';

import { roundReais } from '@delfrance/core/money';

import { apportionDescontos, buildGenItems } from '../../../lib/nfe/orchestrator/generator-input';
import type { FiscalItem, PedidoBundle } from '../../../lib/nfe/orchestrator/bundle';

/**
 * Regression tests for the discount handling in the NF-e generator input.
 *
 * Bugs fixed:
 *  - the wire `<prod><vProd>` must be GROSS (`vUnCom × qCom`) with the discount
 *    in `<prod><vDesc>`, else SEFAZ rejects with cStat 629;
 *  - `pedido.descontoTotal` must be apportioned across items (it was silently
 *    dropped, overstating `vNF` and mismatching payments → cStat 865).
 */

/** Minimal bundle carrying only the fields buildGenItems/apportionDescontos read. */
function bundleWith(
  operacao: Record<string, unknown>,
  pedido: Record<string, unknown> = {},
): PedidoBundle {
  return {
    pedidoId: 'PED-TEST',
    operacao,
    pedido,
  } as unknown as PedidoBundle;
}

/** Minimal FiscalItem — `vProd` is net-of-unit-discount, `vProdBruto` is gross. */
function item(partial: Partial<FiscalItem>): FiscalItem {
  const precoDeVenda = partial.precoDeVenda ?? 100;
  const quantidade = partial.quantidade ?? 1;
  const descontoUnitario = partial.descontoUnitario ?? null;
  return {
    produtoUid: 'prod-1',
    itemIndex: 0,
    sku: 'SKU-1',
    gtin: null,
    nomeDeVenda: 'Camiseta',
    precoDeVenda,
    descontoUnitario,
    quantidade,
    imposto: {
      origem: '0',
      unidade: 'UN',
      NCM: '61091000',
      cfop: '5102',
      configuracaoICMS: { crt: '1', csosn: '102' },
    },
    vProd: roundReais((precoDeVenda - (descontoUnitario ?? 0)) * quantidade),
    vProdBruto: roundReais(precoDeVenda * quantidade),
    ...partial,
  } as FiscalItem;
}

const OP = { cfop: '5102', cfopInterestadual: '6102', NCM: '61091000', unidade: 'UN' };

describe('buildGenItems — discount on the wire', () => {
  it('emits GROSS vProd + vDesc for a per-unit discount (not a net vProd)', () => {
    const it0 = item({ precoDeVenda: 100, quantidade: 2, descontoUnitario: 10 });
    const [gi] = buildGenItems([it0], bundleWith(OP), false);
    // vUnCom × qCom = 100 × 2 = 200 (gross); vDesc = 10 × 2 = 20; net = 180.
    expect(gi!.vProd).toBe(200);
    expect(gi!.vDesc).toBe(20);
    expect(gi!.vUnCom).toBe(100);
    expect(gi!.qCom).toBe(2);
  });

  it('omits vDesc when there is no discount', () => {
    const [gi] = buildGenItems([item({ precoDeVenda: 50, quantidade: 3 })], bundleWith(OP), false);
    expect(gi!.vProd).toBe(150);
    expect(gi!.vDesc).toBeUndefined();
  });

  it('throws when the discount exceeds the gross item value', () => {
    // descontoTotal larger than the whole order → apportioned share blows past gross.
    const it0 = item({ precoDeVenda: 10, quantidade: 1 });
    expect(() => buildGenItems([it0], bundleWith(OP, { descontoTotal: 999 }), false)).toThrow(
      /desconto .* exceeds the gross item value/,
    );
  });
});

describe('apportionDescontos — pedido-level descontoTotal', () => {
  it('splits descontoTotal proportional to net subtotal, remainder on the last item', () => {
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 1 }), // net 100
      item({ produtoUid: 'b', precoDeVenda: 300, quantidade: 1 }), // net 300
    ];
    // descontoTotal 40 over net total 400 → 10 to item A (25%), 30 remainder to B.
    const vDescs = apportionDescontos(items, bundleWith(OP, { descontoTotal: 40 }));
    expect(vDescs).toEqual([10, 30]);
    expect(vDescs[0]! + vDescs[1]!).toBe(40);
  });

  it('adds the unit discount to the apportioned order share', () => {
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 1, descontoUnitario: 5 }), // unit 5, net 95
      item({ produtoUid: 'b', precoDeVenda: 100, quantidade: 1 }), // net 100
    ];
    // order desc 39 over net 195 → A share round(39*95/195)=19 (used), B remainder 20.
    // A total vDesc = 5 + 19 = 24; B total = 0 + 20 = 20.
    const vDescs = apportionDescontos(items, bundleWith(OP, { descontoTotal: 39 }));
    expect(vDescs[0]).toBe(24);
    expect(vDescs[1]).toBe(20);
  });

  it('returns only the unit discounts when descontoTotal is 0/absent', () => {
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 2, descontoUnitario: 3 }), // 6
      item({ produtoUid: 'b', precoDeVenda: 100, quantidade: 1 }), // 0
    ];
    expect(apportionDescontos(items, bundleWith(OP))).toEqual([6, 0]);
  });

  it('never leaks a rounding cent: Σ vDesc equals Σ unit discount + descontoTotal', () => {
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 33.33, quantidade: 1 }),
      item({ produtoUid: 'b', precoDeVenda: 33.33, quantidade: 1 }),
      item({ produtoUid: 'c', precoDeVenda: 33.34, quantidade: 1 }),
    ];
    const vDescs = apportionDescontos(items, bundleWith(OP, { descontoTotal: 10 }));
    const sum = vDescs.reduce((s, v) => s + v, 0);
    expect(roundReais(sum)).toBe(10);
  });

  it('does not overshoot when equal shares land on a half-cent (Σ stays exact, no negative)', () => {
    // 4 × R$1,00 with a R$0,02 order discount: naïve per-item rounding gives
    // 0,01+0,01+0,01 = 0,03 > 0,02 and a negative last share. The cumulative
    // method must keep Σ = 0,02 with every share ≥ 0.
    const items = Array.from({ length: 4 }, (_, i) =>
      item({ produtoUid: `p${i}`, precoDeVenda: 1, quantidade: 1 }),
    );
    const vDescs = apportionDescontos(items, bundleWith(OP, { descontoTotal: 0.02 }));
    expect(vDescs.every((v) => v >= 0)).toBe(true);
    expect(roundReais(vDescs.reduce((s, v) => s + v, 0))).toBe(0.02);
  });

  it('does not overshoot on the classic 20-item × R$0,50 case (would be R$0,57 naïvely)', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      item({ produtoUid: `p${i}`, precoDeVenda: 10, quantidade: 1 }),
    );
    const vDescs = apportionDescontos(items, bundleWith(OP, { descontoTotal: 0.5 }));
    expect(vDescs.every((v) => v >= 0)).toBe(true);
    expect(roundReais(vDescs.reduce((s, v) => s + v, 0))).toBe(0.5);
  });
});
