import { describe, expect, it, vi } from 'vitest';
import {
  buildProductLocationReport,
  depositoOuterRefVariants,
  produtoIdFromEstoquePath,
  shapeProductLocationRows,
  type ProductLocationReader,
  type ProductLocationStock,
} from './productLocation';

function stock(
  path: string,
  localizacao: string | null,
  overrides: Partial<ProductLocationStock['data']> = {},
): ProductLocationStock {
  return {
    path,
    data: {
      parentId: 'denormalized-id-must-not-win',
      localizacao,
      quantidade: 10,
      quantidadeReservada: 2,
      ...overrides,
    },
  };
}

describe('depositoOuterRefVariants', () => {
  it('queries both tolerated depósito reference shapes', () => {
    expect(depositoOuterRefVariants('documents/depositos/dep-1')).toEqual([
      'documents/depositos/dep-1',
      'depositos/dep-1',
    ]);
    expect(depositoOuterRefVariants('depositos/dep-1')).toEqual([
      'documents/depositos/dep-1',
      'depositos/dep-1',
    ]);
  });

  it('rejects an empty or non-depósito reference', () => {
    expect(() => depositoOuterRefVariants('')).toThrow('Selecione um depósito válido.');
    expect(() => depositoOuterRefVariants('documents/produtos/p1')).toThrow(
      'Selecione um depósito válido.',
    );
  });
});

describe('produtoIdFromEstoquePath', () => {
  it('takes produto identity from the owning document path', () => {
    expect(produtoIdFromEstoquePath('produtos/path-owner/estoques/est-1')).toBe('path-owner');
    expect(produtoIdFromEstoquePath('estoques/est-1')).toBeNull();
  });
});

describe('shapeProductLocationRows', () => {
  it('drops empty locations, joins produto details, and uses shared availability math', () => {
    const rows = shapeProductLocationRows(
      [
        stock('produtos/p2/estoques/e2', ' B-2 ', { quantidade: 3, quantidadeReservada: 5 }),
        stock('produtos/p1/estoques/e1', 'A-10', { quantidade: 10, quantidadeReservada: 2 }),
        stock('produtos/p3/estoques/e3', '   '),
      ],
      new Map([
        ['p1', { sku: 'SKU-1', nome: 'Camisa' }],
        ['p2', { sku: null, nome: 'Calça' }],
      ]),
    );

    expect(rows).toEqual([
      {
        key: 'produtos/p1/estoques/e1',
        produtoId: 'p1',
        sku: 'SKU-1',
        produto: 'Camisa',
        localizacao: 'A-10',
        total: 10,
        reservado: 2,
        disponivel: 8,
      },
      {
        key: 'produtos/p2/estoques/e2',
        produtoId: 'p2',
        sku: null,
        produto: 'Calça',
        localizacao: 'B-2',
        total: 3,
        reservado: 5,
        disponivel: -2,
      },
    ]);
  });

  it('does not let a negative stored reservation invent availability', () => {
    const [row] = shapeProductLocationRows(
      [stock('produtos/path-owner/estoques/e1', 'A-1', { quantidade: 8, quantidadeReservada: -2 })],
      new Map(),
    );
    expect(row).toMatchObject({ produtoId: 'path-owner', produto: 'path-owner', disponivel: 8 });
  });
});

describe('buildProductLocationReport', () => {
  it('deduplicates the two ref queries and loads produto details in bounded batches', async () => {
    const located = Array.from({ length: 31 }, (_, index) =>
      stock(`produtos/p${index}/estoques/e${index}`, `A-${index}`),
    );
    const readStocks = vi
      .fn<ProductLocationReader['readStocks']>()
      .mockResolvedValueOnce(located)
      .mockResolvedValueOnce([located[0]!]);
    const readProducts = vi.fn<ProductLocationReader['readProducts']>(
      async (ids) => new Map(ids.map((id) => [id, { sku: `SKU-${id}`, nome: `Produto ${id}` }])),
    );
    const progress = vi.fn();

    const rows = await buildProductLocationReport(
      { readStocks, readProducts },
      'documents/depositos/dep-1',
      progress,
    );

    expect(readStocks.mock.calls.map(([ref]) => ref).sort()).toEqual([
      'depositos/dep-1',
      'documents/depositos/dep-1',
    ]);
    expect(readProducts).toHaveBeenCalledTimes(2);
    expect(readProducts.mock.calls.map(([ids]) => ids.length)).toEqual([30, 1]);
    expect(rows).toHaveLength(31);
    expect(progress).toHaveBeenLastCalledWith({ phase: 'produtos', done: 31, total: 31 });
  });
});
