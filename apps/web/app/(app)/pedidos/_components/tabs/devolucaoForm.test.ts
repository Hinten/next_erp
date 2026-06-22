import { describe, expect, it } from 'vitest';
import type { ItemDoPedido } from '@delfrance/schemas';
import {
  buildDevolucaoRows,
  buildItensDevolvidos,
  distributeReturn,
  returnedQtyByProduto,
  type DevolucaoRow,
} from './devolucaoForm';

function item(overrides: Partial<ItemDoPedido> & { _rowId?: string }): ItemDoPedido {
  return {
    produtoUid: 'p1',
    ordem: 1,
    nomeDeVenda: 'Produto 1',
    precoDeVenda: 10,
    descontoUnitario: 0,
    quantidade: 1,
    custo: 4,
    ...overrides,
  } as ItemDoPedido;
}

describe('returnedQtyByProduto', () => {
  it('sums returned quantity per produto across origins', () => {
    const dev = {
      o1: { p1: [item({ quantidade: 2 })] },
      o2: { p1: [item({ quantidade: 1 })], p2: [item({ produtoUid: 'p2', quantidade: 3 })] },
    };
    expect(returnedQtyByProduto(dev)).toEqual({ p1: 3, p2: 3 });
  });

  it('is empty for null', () => {
    expect(returnedQtyByProduto(null)).toEqual({});
  });
});

describe('buildDevolucaoRows', () => {
  it('groups sold items per produto with sold + returned quantities, ordered by ordem', () => {
    const sold = [
      item({ produtoUid: 'p2', ordem: 2, nomeDeVenda: 'B', quantidade: 1 }),
      item({ produtoUid: 'p1', ordem: 1, nomeDeVenda: 'A', quantidade: 3 }),
    ];
    const dev = { o1: { p1: [item({ quantidade: 2 })] } };
    const rows = buildDevolucaoRows(sold, dev);
    expect(rows.map((r) => r.produtoUid)).toEqual(['p1', 'p2']); // ordem 1 before 2
    expect(rows[0]).toMatchObject({ produtoUid: 'p1', nome: 'A', soldQty: 3, returnedQty: 2 });
    expect(rows[1]).toMatchObject({ produtoUid: 'p2', nome: 'B', soldQty: 1, returnedQty: 0 });
  });

  it('buckets items without a produtoUid under NONE', () => {
    const rows = buildDevolucaoRows([item({ produtoUid: null, nomeDeVenda: 'Avulso' })], null);
    expect(rows[0]?.produtoUid).toBe('NONE');
    expect(rows[0]?.nome).toBe('Avulso');
  });
});

describe('distributeReturn', () => {
  it('fills rows in order, capped at each row quantity, preserving price/custo', () => {
    const source = [
      item({ ordem: 1, quantidade: 3, precoDeVenda: 10, custo: 4 }),
      item({ ordem: 2, quantidade: 2, precoDeVenda: 12, custo: 5 }),
    ];
    const out = distributeReturn(source, 4);
    expect(out).toEqual([
      expect.objectContaining({ quantidade: 3, precoDeVenda: 10, custo: 4 }),
      expect.objectContaining({ quantidade: 1, precoDeVenda: 12, custo: 5 }),
    ]);
  });

  it('strips the synthetic _rowId', () => {
    const out = distributeReturn([item({ _rowId: 'row-1', quantidade: 2 })], 1);
    expect(out[0]).not.toHaveProperty('_rowId');
    expect(out[0]?.quantidade).toBe(1);
  });

  it('returns nothing when the returned quantity is zero', () => {
    expect(distributeReturn([item({ quantidade: 5 })], 0)).toEqual([]);
  });
});

describe('buildItensDevolvidos', () => {
  const rows: DevolucaoRow[] = [
    {
      produtoUid: 'p1',
      nome: 'A',
      soldQty: 3,
      returnedQty: 2,
      sourceItems: [item({ quantidade: 3 })],
    },
    {
      produtoUid: 'p2',
      nome: 'B',
      soldQty: 1,
      returnedQty: 0,
      sourceItems: [item({ produtoUid: 'p2', quantidade: 1 })],
    },
  ];

  it('groups returned rows under the origin key, skipping zero rows', () => {
    const out = buildItensDevolvidos(rows, 'ped1');
    expect(out).toEqual({ ped1: { p1: [expect.objectContaining({ quantidade: 2 })] } });
  });

  it('returns null when nothing is returned', () => {
    const cleared = rows.map((r) => ({ ...r, returnedQty: 0 }));
    expect(buildItensDevolvidos(cleared, 'ped1')).toBeNull();
  });

  it('round-trips through returnedQtyByProduto', () => {
    const out = buildItensDevolvidos(rows, 'ped1');
    expect(returnedQtyByProduto(out)).toEqual({ p1: 2 });
  });
});
