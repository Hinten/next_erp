import { describe, expect, it } from 'vitest';
import type { ItemDoPedido } from '../collection/pedido';
import { derivePedidoTotals, flattenItensDevolvidos } from './totals';

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
