import { describe, expect, it } from 'vitest';
import { ESTADO_PEDIDO } from '@delfrance/schemas';
import type { ItemDoPedido, Pedido } from '@delfrance/schemas';
import {
  type PedidoLite,
  overview,
  porBucket,
  porEstado,
  topProdutos,
  checkoutsPorUsuario,
  rankCheckoutUsers,
} from './aggregations';

describe('checkoutsPorUsuario', () => {
  it('returns an empty report and a single collaborator without an artificial Other row', () => {
    expect(checkoutsPorUsuario([], new Map())).toEqual({ total: 0, rows: [] });
    expect(checkoutsPorUsuario([{ userId: 'a', count: 3 }], new Map([['a', 'Ana']]))).toEqual({
      total: 3,
      rows: [{ userId: 'a', label: 'Ana', count: 3 }],
    });
  });

  it('keeps the top 20 and combines the entire tail into Other without truncating the total', () => {
    const groups = Array.from({ length: 25 }, (_, i) => ({ userId: `user${i}`, count: 25 - i }));
    const names = new Map(groups.map((row) => [row.userId, row.userId]));
    const report = checkoutsPorUsuario(groups, names);
    expect(report.total).toBe(325);
    expect(report.rows).toHaveLength(21);
    expect(report.rows.slice(0, 20).map((row) => row.count)).toEqual(
      Array.from({ length: 20 }, (_, i) => 25 - i),
    );
    expect(report.rows[20]).toEqual({ userId: null, label: 'Outros usuários', count: 15 });
    expect(report.rows.reduce((sum, row) => sum + row.count, 0)).toBe(report.total);
  });

  it('puts missing, unknown and blank-name users in Other without merging duplicate display names', () => {
    expect(
      checkoutsPorUsuario(
        [
          { userId: null, count: 9 },
          { userId: 'missing', count: 8 },
          { userId: 'blank', count: 7 },
          { userId: 'a', count: 3 },
          { userId: 'b', count: 2 },
        ],
        new Map([
          ['blank', '  '],
          ['a', 'Ana'],
          ['b', 'Ana'],
        ]),
      ),
    ).toEqual({
      total: 29,
      rows: [
        { userId: 'a', label: 'Ana', count: 3 },
        { userId: 'b', label: 'Ana', count: 2 },
        { userId: null, label: 'Outros usuários', count: 24 },
      ],
    });
  });

  it('merges counts for the same uid before ranking and breaks ties deterministically', () => {
    expect(
      rankCheckoutUsers([
        { userId: 'b', count: 6 },
        { userId: 'a', count: 2 },
        { userId: 'a', count: 4 },
        { userId: null, count: 100 },
      ]),
    ).toEqual([
      { userId: 'a', count: 6 },
      { userId: 'b', count: 6 },
    ]);
  });
});

// All nullable fields of ItemDoPedido set to null. Spread to override only
// what each test cares about. Avoids repeating 10+ null lines per object.
const baseItem: ItemDoPedido = {
  produtoUid: null,
  ordem: 1,
  ensureUniqueId: null,
  mktplaceId: null,
  sku: null,
  gtin: null,
  nomeDeVenda: null,
  precoDeVenda: 1,
  descontoUnitario: 0,
  quantidade: 1,
  custo: null,
  timestamp: null,
  imposto: null,
};
const i = (patch: Partial<ItemDoPedido>): ItemDoPedido => ({ ...baseItem, ...patch });

function p(estado: Pedido['estado'], itens: Pedido['itens']): PedidoLite {
  return {
    id: Math.random().toString(36).slice(2, 8),
    // Tests only exercise the fields below; cast through `unknown` to bypass
    // the full Pedido shape (every nullable would otherwise need an explicit
    // null) — these objects never round-trip through pedidoSchema.parse.
    data: {
      ehSaida: true,
      estado,
      integracaoPedidoOuterRef: { uid: 'i' },
      itens,
      itensIds: [],
    } as unknown as Pedido,
  };
}

describe('topProdutos', () => {
  it('ranks by total quantity sold across pedidos', () => {
    const dataset: PedidoLite[] = [
      p(ESTADO_PEDIDO.pago, {
        a: [
          i({
            ordem: 1,
            precoDeVenda: 10,
            descontoUnitario: 0,
            quantidade: 3,
            nomeDeVenda: 'Camiseta',
          }),
        ],
        b: [i({ ordem: 2, precoDeVenda: 5, descontoUnitario: 0, quantidade: 1 })],
      }),
      p(ESTADO_PEDIDO.pago, {
        a: [i({ ordem: 1, precoDeVenda: 10, descontoUnitario: 1, quantidade: 2 })],
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

  it('upgrades the label from a later line that carries the nomeDeVenda', () => {
    const rows = topProdutos([
      p(ESTADO_PEDIDO.pago, {
        a: [
          i({ ordem: 1, quantidade: 1 }),
          i({ ordem: 2, quantidade: 1, nomeDeVenda: 'Camiseta' }),
          i({ ordem: 3, quantidade: 1, nomeDeVenda: 'Camiseta renomeada' }),
        ],
      }),
    ]);
    // First real name wins; a later, different one does not overwrite it.
    expect(rows[0]?.label).toBe('Camiseta');
  });

  it('labels with the sku, then the produtoUid, when no line has a nomeDeVenda', () => {
    const comSku = topProdutos([
      p(ESTADO_PEDIDO.pago, { a: [i({ quantidade: 1, sku: 'CAM-1' })] }),
    ]);
    expect(comSku[0]?.label).toBe('CAM-1');

    const semNada = topProdutos([p(ESTADO_PEDIDO.pago, { a: [i({ quantidade: 1 })] })]);
    expect(semNada[0]?.label).toBe('a');
  });

  // The label may only move UP the chain. `topProdutos` folds many pedidos into
  // one row, so "an older line carries the sku, a newer one carries nothing" is
  // an ordinary corpus shape — and a fold that walks the label back down leaves
  // the row worse than the data it was built from.
  it('never downgrades the label when a later line carries less', () => {
    const rows = topProdutos([
      p(ESTADO_PEDIDO.pago, { a: [i({ quantidade: 1, sku: 'CAM-1' })] }),
      p(ESTADO_PEDIDO.pago, { a: [i({ quantidade: 1 })] }),
    ]);
    expect(rows[0]?.label).toBe('CAM-1');
  });

  it('still upgrades from a sku to a name that arrives later', () => {
    const rows = topProdutos([
      p(ESTADO_PEDIDO.pago, { a: [i({ quantidade: 1, sku: 'CAM-1' })] }),
      p(ESTADO_PEDIDO.pago, { a: [i({ quantidade: 1, nomeDeVenda: 'Camiseta' })] }),
    ]);
    expect(rows[0]?.label).toBe('Camiseta');
  });

  it('upgrades from the raw id to a sku that arrives later', () => {
    const rows = topProdutos([
      p(ESTADO_PEDIDO.pago, { a: [i({ quantidade: 1 })] }),
      p(ESTADO_PEDIDO.pago, { a: [i({ quantidade: 1, sku: 'CAM-1' })] }),
    ]);
    expect(rows[0]?.label).toBe('CAM-1');
  });

  it('drops items without produtoUid (NONE bucket and empty key)', () => {
    const rows = topProdutos([
      p(ESTADO_PEDIDO.pago, {
        NONE: [i({ ordem: 1, precoDeVenda: 10, descontoUnitario: 0, quantidade: 99 })],
        '': [i({ ordem: 1, precoDeVenda: 5, descontoUnitario: 0, quantidade: 99 })],
      }),
    ]);
    expect(rows).toEqual([]);
  });

  it('respects topN', () => {
    const itens: Pedido['itens'] = {};
    for (let n = 0; n < 20; n++) {
      itens[`p${n}`] = [i({ ordem: 1, precoDeVenda: 1, descontoUnitario: 0, quantidade: n + 1 })];
    }
    const rows = topProdutos([p(ESTADO_PEDIDO.pago, itens)], 3);
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.produtoUid)).toEqual(['p19', 'p18', 'p17']);
  });
});

describe('porEstado', () => {
  it('counts pedidos per estado and sums totals', () => {
    const rows = porEstado([
      p(ESTADO_PEDIDO.pago, {
        x: [i({ ordem: 1, precoDeVenda: 100, descontoUnitario: 0, quantidade: 1 })],
      }),
      p(ESTADO_PEDIDO.pago, {
        x: [i({ ordem: 1, precoDeVenda: 50, descontoUnitario: 0, quantidade: 1 })],
      }),
      p(ESTADO_PEDIDO.cancelado, {
        x: [i({ ordem: 1, precoDeVenda: 40, descontoUnitario: 0, quantidade: 1 })],
      }),
    ]);
    const pago = rows.find((r) => r.estado === ESTADO_PEDIDO.pago);
    expect(pago?.count).toBe(2);
    expect(pago?.receita).toBe(150);
    const cancelado = rows.find((r) => r.estado === ESTADO_PEDIDO.cancelado);
    expect(cancelado?.count).toBe(1);
    expect(rows[0]?.estado).toBe('pago'); // sorted by count desc
  });
});

describe('porBucket', () => {
  it('returns all four buckets even when some are empty', () => {
    const rows = porBucket([p(ESTADO_PEDIDO.pago, {}), p(ESTADO_PEDIDO.iniciado, {})]);
    const ids = rows.map((r) => r.bucket).sort();
    expect(ids).toEqual(['aberto', 'cancelado', 'concluido', 'processo']);
    const concluido = rows.find((r) => r.bucket === 'concluido');
    expect(concluido?.count).toBe(1);
  });
});

describe('overview', () => {
  it('sums pedidos, receita, itens; ticket médio = receita / pedidos', () => {
    const out = overview([
      p(ESTADO_PEDIDO.pago, {
        a: [i({ ordem: 1, precoDeVenda: 10, descontoUnitario: 0, quantidade: 2 })],
      }),
      p(ESTADO_PEDIDO.pago, {
        a: [i({ ordem: 1, precoDeVenda: 5, descontoUnitario: 1, quantidade: 4 })],
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
