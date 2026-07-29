import { describe, expect, it } from 'vitest';
import { ESTADO_PEDIDO } from '@delfrance/schemas';
import type { ItemDoPedido } from '@delfrance/schemas';
import {
  buildItensDevolvidos,
  clonePedidoItems,
  editRowsFromItensDevolvidos,
  isReturnableOrigin,
  newAvulsoRow,
  type DevolucaoEditRow,
} from './devolucaoForm';

function item(overrides: Partial<ItemDoPedido> = {}): ItemDoPedido {
  return {
    produtoUid: 'p1',
    ordem: 1,
    nomeDeVenda: 'Produto 1',
    sku: 'SKU1',
    precoDeVenda: 10,
    descontoUnitario: 0,
    quantidade: 2,
    custo: 4,
    ...overrides,
  } as ItemDoPedido;
}

describe('clonePedidoItems', () => {
  it('clones an origin order into capped, produto-locked rows', () => {
    const rows = clonePedidoItems(
      {
        numero: 'PED-9',
        itens: { p1: [item({ quantidade: 3 })], p2: [item({ produtoUid: 'p2', quantidade: 1 })] },
      },
      'origin1',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      originId: 'origin1',
      originLabel: 'PED-9',
      produtoUid: 'p1',
      quantidade: 3,
      maxQty: 3,
    });
    expect(rows[1]).toMatchObject({ produtoUid: 'p2', quantidade: 1, maxQty: 1 });
  });

  it('falls back to a Pedido <id> label when número is absent', () => {
    const rows = clonePedidoItems({ itens: { p1: [item()] } }, 'abc');
    expect(rows[0]?.originLabel).toBe('Pedido abc');
  });

  it('normalizes a "NONE" / "" produto key to no produto', () => {
    const none = clonePedidoItems({ itens: { NONE: [item({ produtoUid: null })] } }, 'o');
    const empty = clonePedidoItems({ itens: { '': [item({ produtoUid: null })] } }, 'o');
    expect(none[0]?.produtoUid).toBeNull();
    expect(empty[0]?.produtoUid).toBeNull();
  });
});

describe('newAvulsoRow', () => {
  it('creates an empty avulso row with no produto and no cap', () => {
    const row = newAvulsoRow();
    expect(row).toMatchObject({ originId: 'NONE', produtoUid: null, maxQty: null, quantidade: 1 });
  });
});

describe('buildItensDevolvidos', () => {
  function row(overrides: Partial<DevolucaoEditRow>): DevolucaoEditRow {
    return {
      rowId: 'r',
      originId: 'origin1',
      originLabel: 'PED-9',
      produtoUid: 'p1',
      nome: 'Produto 1',
      sku: 'SKU1',
      precoDeVenda: 10,
      descontoUnitario: 0,
      custo: 4,
      quantidade: 2,
      maxQty: 3,
      source: item(),
      _delete: false,
      ...overrides,
    };
  }

  it('groups rows under origin/produto with the edited quantity', () => {
    const out = buildItensDevolvidos([row({ quantidade: 2 })]);
    expect(out).toEqual({
      origin1: { p1: [expect.objectContaining({ quantidade: 2, precoDeVenda: 10 })] },
    });
  });

  it('places avulso rows under NONE keyed by the picked produto', () => {
    const out = buildItensDevolvidos([
      row({ originId: 'NONE', produtoUid: 'pX', nome: 'Avulso X', maxQty: null }),
    ]);
    expect(out).toEqual({
      NONE: { pX: [expect.objectContaining({ produtoUid: 'pX', nomeDeVenda: 'Avulso X' })] },
    });
  });

  it('skips deleted rows, zero-qty rows, and avulso rows without a produto', () => {
    expect(buildItensDevolvidos([row({ _delete: true })])).toBeNull();
    expect(buildItensDevolvidos([row({ quantidade: 0 })])).toBeNull();
    expect(buildItensDevolvidos([row({ originId: 'NONE', produtoUid: null })])).toBeNull();
  });

  it('strips a synthetic _rowId leaking from the source item', () => {
    const out = buildItensDevolvidos([
      row({ source: { ...item(), _rowId: 'row-1' } as ItemDoPedido }),
    ]);
    expect(out?.origin1?.p1?.[0]).not.toHaveProperty('_rowId');
  });

  it('trims nomeDeVenda before persisting (null when blank)', () => {
    expect(
      buildItensDevolvidos([row({ nome: '  Produto X  ' })])?.origin1?.p1?.[0]?.nomeDeVenda,
    ).toBe('Produto X');
    expect(buildItensDevolvidos([row({ nome: '   ' })])?.origin1?.p1?.[0]?.nomeDeVenda).toBeNull();
  });
});

describe('editRowsFromItensDevolvidos round-trips', () => {
  it('seeds rows from a saved map and rebuilds an equal map', () => {
    const saved = {
      origin1: { p1: [item({ quantidade: 2 })] },
      NONE: { pX: [item({ produtoUid: 'pX', nomeDeVenda: 'Avulso X', quantidade: 1 })] },
    };
    const rows = editRowsFromItensDevolvidos(saved);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.originId === 'NONE')).toMatchObject({
      produtoUid: 'pX',
      maxQty: null,
    });
    const rebuilt = buildItensDevolvidos(rows);
    expect(rebuilt?.origin1?.p1?.[0]?.quantidade).toBe(2);
    expect(rebuilt?.NONE?.pX?.[0]?.quantidade).toBe(1);
  });

  it('is empty for null', () => {
    expect(editRowsFromItensDevolvidos(null)).toEqual([]);
  });
});

describe('isReturnableOrigin', () => {
  const none = new Set<string>();

  it('accepts a paid saída order', () => {
    expect(isReturnableOrigin({ ehSaida: true, estado: ESTADO_PEDIDO.pago }, 'o1', none)).toBe(
      true,
    );
    expect(
      isReturnableOrigin({ ehSaida: true, estado: ESTADO_PEDIDO.finalizado }, 'o1', none),
    ).toBe(true);
  });

  it('rejects an entrada, a non-returnable estado, or an excluded id', () => {
    expect(isReturnableOrigin({ ehSaida: false, estado: ESTADO_PEDIDO.pago }, 'o1', none)).toBe(
      false,
    );
    expect(isReturnableOrigin({ ehSaida: true, estado: ESTADO_PEDIDO.iniciado }, 'o1', none)).toBe(
      false,
    );
    expect(
      isReturnableOrigin({ ehSaida: true, estado: ESTADO_PEDIDO.pago }, 'o1', new Set(['o1'])),
    ).toBe(false);
  });
});
