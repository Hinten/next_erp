import { describe, expect, it } from 'vitest';
import type { Pedido } from '@delfrance/schemas';
import {
  type PedidoLite,
  overview,
  porBucket,
  porEstado,
  topProdutos,
} from './aggregations';

function p(estado: Pedido['estado'], itens: Pedido['itens']): PedidoLite {
  return {
    id: Math.random().toString(36).slice(2, 8),
    data: {
      ehSaida: true,
      estado,
      integracaoPedidoOuterRef: { uid: 'i' },
      itens,
      itensIds: [],
    } as Pedido,
  };
}

describe('topProdutos', () => {
  it('ranks by total quantity sold across pedidos', () => {
    const dataset: PedidoLite[] = [
      p('pago', {
        a: [{ ordem: 1, precoDeVenda: 10, descontoUnitario: 0, quantidade: 3, nomeDeVenda: 'Camiseta' }],
        b: [{ ordem: 2, precoDeVenda: 5, descontoUnitario: 0, quantidade: 1 }],
      }),
      p('pago', {
        a: [{ ordem: 1, precoDeVenda: 10, descontoUnitario: 1, quantidade: 2 }],
      }),
    ];
    const rows = topProdutos(dataset, 5);
    expect(rows.length).toBe(2);
    expect(rows[0]?.produtoUid).toBe('a');
    expect(rows[0]?.quantidade).toBe(5);
    expect(rows[0]?.receita).toBeCloseTo(3 * 10 + 2 * (10 - 1));
    expect(rows[0]?.label).toBe('Camiseta');
    expect(rows[0]?.pedidos).toBe(2);
    expect(rows[1]?.produtoUid).toBe('b');
  });

  it('drops items without produtoUid (NONE bucket and empty key)', () => {
    const rows = topProdutos([
      p('pago', {
        NONE: [{ ordem: 1, precoDeVenda: 10, descontoUnitario: 0, quantidade: 99 }],
        '': [{ ordem: 1, precoDeVenda: 5, descontoUnitario: 0, quantidade: 99 }],
      }),
    ]);
    expect(rows).toEqual([]);
  });

  it('respects topN', () => {
    const itens: Pedido['itens'] = {};
    for (let i = 0; i < 20; i++) {
      itens[`p${i}`] = [
        { ordem: 1, precoDeVenda: 1, descontoUnitario: 0, quantidade: i + 1 },
      ];
    }
    const rows = topProdutos([p('pago', itens)], 3);
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.produtoUid)).toEqual(['p19', 'p18', 'p17']);
  });
});

describe('porEstado', () => {
  it('counts pedidos per estado and sums totals', () => {
    const rows = porEstado([
      p('pago', { x: [{ ordem: 1, precoDeVenda: 100, descontoUnitario: 0, quantidade: 1 }] }),
      p('pago', { x: [{ ordem: 1, precoDeVenda: 50, descontoUnitario: 0, quantidade: 1 }] }),
      p('cancelado', { x: [{ ordem: 1, precoDeVenda: 40, descontoUnitario: 0, quantidade: 1 }] }),
    ]);
    const pago = rows.find((r) => r.estado === 'pago');
    expect(pago?.count).toBe(2);
    expect(pago?.receita).toBe(150);
    const cancelado = rows.find((r) => r.estado === 'cancelado');
    expect(cancelado?.count).toBe(1);
    expect(rows[0]?.estado).toBe('pago'); // sorted by count desc
  });
});

describe('porBucket', () => {
  it('returns all four buckets even when some are empty', () => {
    const rows = porBucket([
      p('pago', {}),
      p('iniciado', {}),
    ]);
    const ids = rows.map((r) => r.bucket).sort();
    expect(ids).toEqual(['aberto', 'cancelado', 'concluido', 'processo']);
    const concluido = rows.find((r) => r.bucket === 'concluido');
    expect(concluido?.count).toBe(1);
  });
});

describe('overview', () => {
  it('sums pedidos, receita, itens; ticket médio = receita / pedidos', () => {
    const out = overview([
      p('pago', {
        a: [{ ordem: 1, precoDeVenda: 10, descontoUnitario: 0, quantidade: 2 }],
      }),
      p('pago', {
        a: [{ ordem: 1, precoDeVenda: 5, descontoUnitario: 1, quantidade: 4 }],
      }),
    ]);
    expect(out.pedidos).toBe(2);
    expect(out.receita).toBeCloseTo(20 + 16);
    expect(out.ticketMedio).toBeCloseTo(36 / 2);
    expect(out.itensVendidos).toBe(6);
  });

  it('handles empty input without dividing by zero', () => {
    expect(overview([])).toEqual({
      pedidos: 0,
      receita: 0,
      ticketMedio: 0,
      itensVendidos: 0,
    });
  });
});
