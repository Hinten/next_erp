import { describe, expect, it } from 'vitest';
import type { ItemDoPedido } from '../collection/pedido';
import {
  derivePedidoTotals,
  flattenItensDevolvidos,
  itemSubtotal,
  somaBrutaItensDevolvidos,
} from './totals';

function item(precoDeVenda: number, descontoUnitario: number, quantidade: number, custo: number) {
  return { precoDeVenda, descontoUnitario, quantidade, custo } as unknown as ItemDoPedido;
}

describe('derivePedidoTotals', () => {
  it('derives every money cache like the Flutter factory', () => {
    const itens = [item(10, 1, 2, 4), item(5, 0, 3, 2)]; // subtotal 18+15=33, custo 8+6=14
    const totals = derivePedidoTotals({
      itens,
      descontoTotal: 3,
      freteInicial: { valorCobrado: 7, custoCalculado: 5, custoFinal: 9 },
      itensDevolvidos: { orig1: { p1: [item(10, 1, 1, 4)] } }, // dev value 9, custo 4
    });
    expect(totals.subtotal).toBe(33);
    expect(totals.valorCusto).toBe(14);
    expect(totals.valorFreteInicial).toBe(7);
    // custoCalculado wins over custoFinal
    expect(totals.custoFreteInicial).toBe(5);
    expect(totals.valorDevolucao).toBe(9);
    expect(totals.valorCustoDevolvidos).toBe(4);
    // round2(round2(33 - 3) + 7) = 37
    expect(totals.valorCobrado).toBe(37);
  });

  it('falls back to custoFinal when custoCalculado is absent', () => {
    const totals = derivePedidoTotals({
      itens: [item(10, 0, 1, 0)],
      descontoTotal: 0,
      freteInicial: { valorCobrado: 0, custoCalculado: null, custoFinal: 8 },
    });
    expect(totals.custoFreteInicial).toBe(8);
  });

  it('treats a null frete / empty returns as zero', () => {
    const totals = derivePedidoTotals({
      itens: [item(10, 0, 1, 3)],
      descontoTotal: 0,
      freteInicial: null,
      itensDevolvidos: null,
    });
    expect(totals.valorFreteInicial).toBe(0);
    expect(totals.custoFreteInicial).toBe(0);
    expect(totals.valorDevolucao).toBe(0);
    expect(totals.valorCobrado).toBe(10);
  });

  it('rounds valorDevolucao once, from the raw sum of the returned lines', () => {
    const derive = (itensDevolvidos: Record<string, Record<string, ItemDoPedido[]>>) =>
      derivePedidoTotals({
        itens: [item(10, 0, 1, 0)],
        descontoTotal: 0,
        freteInicial: null,
        itensDevolvidos,
      }).valorDevolucao;
    // 0.5 × 1.01 = 0.505 raw → 0.51
    expect(derive({ o: { p: [item(1.01, 0, 0.5, 0)] } })).toBe(0.51);
    // 0.404 + 0.404 = 0.808 raw → 0.81 (rounding per line would read 0.80)
    expect(derive({ o: { p: [item(1.01, 0, 0.4, 0), item(1.01, 0, 0.4, 0)] } })).toBe(0.81);
  });

  it('keeps valorDevolucao finite for a returned line with no quantidade (reads as 0)', () => {
    const semQuantidade = {
      precoDeVenda: 10,
      descontoUnitario: 0,
      custo: 0,
    } as unknown as ItemDoPedido;
    const totals = derivePedidoTotals({
      itens: [item(10, 0, 1, 0)],
      descontoTotal: 0,
      freteInicial: null,
      itensDevolvidos: { o: { p: [semQuantidade, item(4, 0, 1, 0)] } },
    });
    expect(totals.valorDevolucao).toBe(4);
  });
});

describe('somaBrutaItensDevolvidos', () => {
  const linha = (precoDeVenda: unknown, descontoUnitario: unknown, quantidade: unknown) => ({
    precoDeVenda,
    descontoUnitario,
    quantidade,
  });

  it('sums (preço − desconto) × quantidade over every origin and the NONE bucket', () => {
    const devolvidos = { o1: { p1: [item(10, 1, 2, 0)] }, NONE: { p2: [item(5, 0, 1, 0)] } };
    expect(somaBrutaItensDevolvidos(devolvidos)).toBe(23);
    // NEAR-MISS: the NONE bucket is part of the sum
    expect(somaBrutaItensDevolvidos({ o1: devolvidos.o1 })).toBe(18);
  });

  it('is UNROUNDED — the caller decides the one rounding', () => {
    expect(somaBrutaItensDevolvidos({ o: { p: [item(1.01, 0, 0.5, 0)] } })).toBe(1.01 * 0.5);
    expect(somaBrutaItensDevolvidos({ o: { p: [item(1.01, 0, 0.5, 0)] } })).not.toBe(0.51);
  });

  it('yields the IDENTICAL float as flatten + itemSubtotal for a typed map', () => {
    const devolvidos = {
      o1: {
        p1: [item(1.1, 0.05, 0.1, 0), item(2.2, 0, 3, 0), item(3.3, 0.33, 0.7, 0)],
        p2: [item(0.1, 0, 3, 0)],
      },
      NONE: { p3: [item(9.99, 0.01, 1.5, 0), item(0.07, 0, 0.3, 0)] },
      o2: { p1: [item(4.35, 0.15, 2.5, 0)] },
    };
    const viaFlatten = flattenItensDevolvidos(devolvidos).reduce(
      (soma, i) => soma + itemSubtotal(i),
      0,
    );
    expect(somaBrutaItensDevolvidos(devolvidos)).toBe(viaFlatten);
  });

  it('is 0 for a null / undefined / non-object devolução', () => {
    for (const vazio of [null, undefined, {}, 'texto', 5, true, [], [linha(10, 0, 1)]]) {
      expect(somaBrutaItensDevolvidos(vazio)).toBe(0);
    }
  });

  it('counts a non-finite-number field as 0 — a numeric string is NOT coerced', () => {
    const valido = linha(4, 0, 1);
    // '10' × 2 would be 20 under a bare `-` / `*`; the fail-safe reads the string as 0
    expect(somaBrutaItensDevolvidos({ o: { p: [linha('10', 0, 2), valido] } })).toBe(4);
    // a string discount is 0, so the price is not reduced by it
    expect(somaBrutaItensDevolvidos({ o: { p: [linha(10, '3', 2)] } })).toBe(20);
    expect(somaBrutaItensDevolvidos({ o: { p: [linha(10, 0, '2'), valido] } })).toBe(4);
    // a missing quantidade is 0 (a bare `*` would give NaN), a null discount is 0
    expect(somaBrutaItensDevolvidos({ o: { p: [{ precoDeVenda: 10 }, valido] } })).toBe(4);
    expect(somaBrutaItensDevolvidos({ o: { p: [linha(10, null, 2)] } })).toBe(20);
    // NaN / Infinity fields are 0
    expect(somaBrutaItensDevolvidos({ o: { p: [linha(Infinity, 0, 1), valido] } })).toBe(4);
    expect(somaBrutaItensDevolvidos({ o: { p: [linha(10, 0, NaN), valido] } })).toBe(4);
  });

  it('skips a non-object bucket, a non-array list and a non-object item without throwing', () => {
    const bagunca = {
      o1: 5,
      o2: { p1: 'texto', p2: [linha(10, 0, 1), null, 3, 'x'], p3: null },
      o3: null,
      NONE: { p4: { 0: linha(99, 0, 1) } },
    };
    const soma = somaBrutaItensDevolvidos(bagunca);
    expect(soma).toBe(10);
    expect(Number.isNaN(soma)).toBe(false);
  });
});

describe('flattenItensDevolvidos', () => {
  it('flattens the nested map and tolerates null', () => {
    expect(flattenItensDevolvidos(null)).toEqual([]);
    const flat = flattenItensDevolvidos({
      origA: { p1: [item(1, 0, 1, 0)], p2: [item(2, 0, 1, 0)] },
      origB: { p1: [item(3, 0, 1, 0)] },
    });
    expect(flat).toHaveLength(3);
  });
});

// The canonical rounding (`roundReais`) is tested in `@delfrance/core/money`.
