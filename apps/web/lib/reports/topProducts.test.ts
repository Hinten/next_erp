import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import { ESTADO_PEDIDO } from '@delfrance/schemas';
import {
  aggregateTopProducts,
  buildTopProductsPipeline,
  hydrateTopProductsRows,
  isHydratedTopProductsRow,
  isTopProductsReport,
  loadTopProductsReport,
  normalizeTopProductsFilters,
  topProductsDateRange,
  topProductsGroupFromResult,
  type TopProductsFilters,
  type TopProductsProduct,
  type TopProductsSaleGroup,
} from './topProducts';

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('firebase/firestore/pipelines', () => {
  const expression = (kind: string, ...args: unknown[]): Record<string, unknown> => ({
    kind,
    args,
    as: (alias: string) => ({ kind, args, alias }),
    ifAbsent: (fallback: unknown) => expression('ifAbsent', { kind, args }, fallback),
    ifNull: (fallback: unknown) => expression('ifNull', { kind, args }, fallback),
  });
  return {
    execute: mocks.execute,
    field: (name: string) => expression('field', name),
    constant: (value: unknown) => expression('constant', value),
    documentId: (...args: unknown[]) => expression('documentId', ...args),
    and: (...args: unknown[]) => expression('and', ...args),
    array: (...args: unknown[]) => expression('array', ...args),
    map: (...args: unknown[]) => expression('map', ...args),
    equal: (...args: unknown[]) => expression('equal', ...args),
    equalAny: (...args: unknown[]) => expression('equalAny', ...args),
    greaterThanOrEqual: (...args: unknown[]) => expression('gte', ...args),
    lessThan: (...args: unknown[]) => expression('lt', ...args),
    lessThanOrEqual: (...args: unknown[]) => expression('lte', ...args),
    isType: (...args: unknown[]) => expression('isType', ...args),
    conditional: (...args: unknown[]) => expression('conditional', ...args),
    mapEntries: (...args: unknown[]) => expression('mapEntries', ...args),
    sum: (...args: unknown[]) => expression('sum', ...args),
  };
});

interface Stage {
  kind: string;
  args: unknown[];
}
interface FakePipeline {
  stages: Stage[];
}
function database() {
  const pipelines: FakePipeline[] = [];
  const db = {
    pipeline: () => {
      const stages: Stage[] = [];
      const pipeline: FakePipeline & Record<string, unknown> = { stages };
      for (const kind of ['collection', 'documents', 'where', 'select', 'unnest', 'aggregate']) {
        pipeline[kind] = (...args: unknown[]) => {
          stages.push({ kind, args });
          return pipeline;
        };
      }
      pipelines.push(pipeline);
      return pipeline;
    },
  } as unknown as Firestore;
  return { db, pipelines };
}
const filters: TopProductsFilters = {
  startUs: 1_000_000,
  endExclusiveUs: 2_000_000,
  estados: [ESTADO_PEDIDO.pago, ESTADO_PEDIDO.finalizado],
  accountIds: [],
  ehSaida: true,
};
const group = (
  produtoId: string | null,
  quantidade: number,
  invalidLines = 0,
): TopProductsSaleGroup => ({ produtoId, quantidade, invalidLines });
const products = (data: Record<string, TopProductsProduct>) => new Map(Object.entries(data));
const snapshot = (data: Record<string, unknown>[]) => ({
  results: data.map((row) => ({ data: () => row })),
});

beforeEach(() => {
  mocks.execute.mockReset();
});

describe('top-products query', () => {
  it('filters the complete order range, expands map buckets, and returns grouped sums without top-N truncation', () => {
    const { db, pipelines } = database();
    buildTopProductsPipeline(db, { ...filters, accountIds: ['shop'] });
    const stages = pipelines[0]!.stages;
    expect(stages.map((stage) => stage.kind)).toEqual([
      'collection',
      'where',
      'select',
      'unnest',
      'unnest',
      'aggregate',
    ]);
    expect(stages[0]!.args).toEqual(['pedidos']);
    const predicate = JSON.stringify(stages[1]!.args);
    expect(predicate).toContain('ehSaida');
    expect(predicate).toContain('timestamp');
    expect(predicate).toContain('1000000');
    expect(predicate).toContain('2000000');
    expect(predicate).toContain('pago');
    expect(predicate).toContain('finalizado');
    expect(predicate).toContain('documents/integracao/shop');
    expect(predicate).toContain('"integracao/shop"');
    expect(JSON.stringify(stages[2]!.args)).toContain('mapEntries');
    expect(stages[3]!.args).toEqual([
      expect.objectContaining({ kind: 'field', args: ['itemGroups'] }),
    ]);
    expect(JSON.stringify(stages[4]!.args)).toContain('itemGroups.v');
    expect(stages[5]!.args).toEqual([
      {
        groups: [
          expect.objectContaining({ kind: 'field', args: ['itemGroups.k'], alias: 'produtoId' }),
        ],
        accumulators: [
          expect.objectContaining({ kind: 'sum', alias: 'quantidade' }),
          expect.objectContaining({ kind: 'sum', alias: 'invalidLines' }),
        ],
      },
    ]);
  });

  it('rejects an empty state selection while empty accounts include all accounts', () => {
    const { db, pipelines } = database();
    expect(() => buildTopProductsPipeline(db, { ...filters, estados: [] })).toThrow(
      'pelo menos um estado',
    );
    buildTopProductsPipeline(db, filters);
    expect(JSON.stringify(pipelines[0]!.stages[1])).not.toContain('integracaoPedidoOuterRef');
  });

  it('canonicalizes set order while retaining different selected accounts and states', () => {
    expect(normalizeTopProductsFilters({ ...filters, accountIds: ['b', 'a', 'a'] })).toEqual({
      ...filters,
      estados: [ESTADO_PEDIDO.finalizado, ESTADO_PEDIDO.pago],
      accountIds: ['a', 'b'],
    });
    expect(normalizeTopProductsFilters({ ...filters, accountIds: ['01', '1'] }).accountIds).toEqual(
      ['01', '1'],
    );
    expect(() => normalizeTopProductsFilters({ ...filters, accountIds: ['a/b'] })).toThrow('Conta');
    expect(() =>
      normalizeTopProductsFilters({ ...filters, endExclusiveUs: filters.startUs }),
    ).toThrow('período');
  });

  it('validates aggregate quantities and invalid-line counts at the wire boundary', () => {
    expect(
      topProductsGroupFromResult({ produtoId: 'p', quantidade: 2.5, invalidLines: 1 }),
    ).toEqual(group('p', 2.5, 1));
    expect(
      topProductsGroupFromResult({ produtoId: 'NONE', quantidade: 3, invalidLines: 0 }),
    ).toEqual(group(null, 3));
    expect(topProductsGroupFromResult({ produtoId: '', quantidade: 3, invalidLines: 0 })).toEqual(
      group(null, 3),
    );
    for (const quantidade of [-1, NaN, Infinity, '3', null]) {
      expect(() =>
        topProductsGroupFromResult({ produtoId: 'p', quantidade, invalidLines: 0 }),
      ).toThrow('inválida');
    }
    expect(() =>
      topProductsGroupFromResult({ produtoId: 'p', quantidade: 1, invalidLines: 0.5 }),
    ).toThrow('inválida');
  });

  it('loads only sold products and their components with structural projections', async () => {
    const { db, pipelines } = database();
    const catalog: Record<string, Record<string, unknown>> = {
      kit: { ehKit: true, componentesKit: { variant: { quantidade: 3, limitarEstoque: false } } },
      simple: { ehKit: false },
      variant: { paiId: 'parent', ehKit: false },
    };
    mocks.execute.mockImplementation(async (pipeline: FakePipeline) => {
      const documentStage = pipeline.stages.find((stage) => stage.kind === 'documents');
      if (!documentStage)
        return snapshot([
          { produtoId: 'kit', quantidade: 2, invalidLines: 0 },
          { produtoId: 'simple', quantidade: 4, invalidLines: 0 },
        ]);
      const paths = documentStage.args[0] as string[];
      return snapshot(
        paths.flatMap((path) => {
          const id = path.split('/')[1]!;
          return catalog[id] ? [{ rowId: id, ...catalog[id] }] : [];
        }),
      );
    });
    const result = await loadTopProductsReport(db, filters);
    expect(result.rows.map((row) => [row.produtoId, row.quantidade])).toEqual([
      ['parent', 6],
      ['simple', 4],
    ]);
    expect(result.totalQuantidade).toBe(10);
    expect(pipelines.slice(1).map((pipeline) => pipeline.stages[0]!.args)).toEqual([
      [['produtos/kit', 'produtos/simple']],
      [['produtos/variant']],
    ]);
    for (const pipeline of pipelines.slice(1)) {
      expect(pipeline.stages[1]!.args.slice(1)).toEqual(['paiId', 'ehKit', 'componentesKit']);
    }
  });

  it('makes no catalog read for an empty range and propagates query failures', async () => {
    const { db } = database();
    mocks.execute.mockResolvedValue(snapshot([]));
    expect(await loadTopProductsReport(db, filters)).toEqual({
      rows: [],
      totalQuantidade: 0,
      diagnostics: [],
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const error = new FirebaseError('permission-denied', 'Denied');
    mocks.execute.mockRejectedValue(error);
    await expect(loadTopProductsReport(db, filters)).rejects.toBe(error);
  });
});

describe('kit expansion and parent ranking', () => {
  it('combines variations before ranking and uses IDs rather than display names for identity', () => {
    const report = aggregateTopProducts(
      [group('a', 4), group('b', 4), group('c', 7)],
      products({
        a: { paiId: 'same-parent' },
        b: { paiId: 'same-parent' },
        c: { paiId: 'other-parent' },
      }),
    );
    expect(report.rows.map((row) => [row.produtoId, row.quantidade])).toEqual([
      ['same-parent', 8],
      ['other-parent', 7],
    ]);
    expect(report.rows[0]!.variations).toEqual([
      { produtoId: 'a', quantidade: 4 },
      { produtoId: 'b', quantidade: 4 },
    ]);
  });

  it('multiplies every kit component, merges direct sales, and treats virtual kits equally', () => {
    const report = aggregateTopProducts(
      [group('kit', 2), group('virtual', 1), group('blue', 4)],
      products({
        kit: { ehKit: true, componentesKit: { blue: { quantidade: 3, limitarEstoque: false } } },
        virtual: { ehKit: true, ehKitVirtual: true, componentesKit: { red: { quantidade: 2 } } },
        blue: { paiId: 'shirt' },
        red: { paiId: 'shirt' },
      }),
    );
    expect(report.rows).toEqual([
      {
        produtoId: 'shirt',
        quantidade: 12,
        variations: [
          { produtoId: 'blue', quantidade: 10 },
          { produtoId: 'red', quantidade: 2 },
        ],
      },
    ]);
    expect(report.diagnostics).toEqual([]);
  });

  it('keeps standalone, family-of-one, missing product and missing-parent quantities', () => {
    const report = aggregateTopProducts(
      [group('standalone', 2), group('only-child', 3), group('deleted', 4)],
      products({
        standalone: {},
        'only-child': { paiId: 'missing-parent' },
      }),
    );
    expect(report.rows.map((row) => row.produtoId)).toEqual([
      'deleted',
      'missing-parent',
      'standalone',
    ]);
    expect(report.totalQuantidade).toBe(9);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({ kind: 'missing-product', produtoId: 'deleted', quantidade: 4 }),
    );
  });

  it('retains known component quantity when its catalog document was deleted', () => {
    const report = aggregateTopProducts(
      [group('kit', 2)],
      products({
        kit: { ehKit: true, componentesKit: { deleted: { quantidade: 3 } } },
      }),
    );
    expect(report.rows[0]).toEqual({
      produtoId: 'deleted',
      quantidade: 6,
      variations: [{ produtoId: 'deleted', quantidade: 6 }],
    });
    expect(report.diagnostics[0]).toMatchObject({ kind: 'missing-product', produtoId: 'deleted' });
  });

  it('diagnoses invalid recipes and nested kits without counting the kit itself or recursing', () => {
    const report = aggregateTopProducts(
      [group('empty', 2), group('bad', 1), group('outer', 3)],
      products({
        empty: { ehKit: true },
        bad: {
          ehKit: true,
          componentesKit: {
            valid: { quantidade: 2 },
            invalid: { quantidade: NaN },
            junk: null,
          },
        },
        outer: { ehKit: true, componentesKit: { inner: { quantidade: 2 } } },
        valid: {},
        inner: { ehKit: true, componentesKit: { valid: { quantidade: 100 } } },
      }),
    );
    expect(report.rows.map((row) => [row.produtoId, row.quantidade])).toEqual([['valid', 2]]);
    expect(report.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      'invalid-kit',
      'invalid-kit',
      'nested-kit',
    ]);
  });

  it('handles unlinked items, invalid source lines, zero units and deterministic quantity ties', () => {
    const report = aggregateTopProducts(
      [group(null, 99), group('b', 1.5), group('a', 1.5, 1), group('zero', 0)],
      products({ a: {}, b: {} }),
    );
    expect(report.rows.map((row) => row.produtoId)).toEqual(['a', 'b']);
    expect(report.totalQuantidade).toBe(3);
    expect(report.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      'unlinked-items',
      'invalid-quantity',
    ]);
  });
});

describe('visible-row decoration', () => {
  const rows = [
    {
      produtoId: 'parent',
      quantidade: 3,
      variations: [{ produtoId: 'variant', quantidade: 3 }],
    },
  ];
  const foto = {
    arquivoOuterRef: 'documents/arquivos/original',
    arquivo200pxOuterRef: 'arquivos/small',
    arquivo400pxOuterRef: 'arquivos/medium',
  };
  function installReader(fileError?: FirebaseError) {
    mocks.execute.mockImplementation(async (pipeline: FakePipeline) => {
      const paths = pipeline.stages[0]!.args[0] as string[];
      if (paths[0]!.startsWith('produtos/'))
        return snapshot([
          { rowId: 'parent', nome: 'Parent', sku: 'P', fotos: [foto] },
          { rowId: 'variant', nome: 'Blue', sku: 'P-B', fotos: [] },
        ]);
      if (fileError) throw fileError;
      return snapshot(
        paths.flatMap((path) =>
          path === 'arquivos/original'
            ? [{ rowId: 'original', url: 'https://example.test/photo.jpg' }]
            : [],
        ),
      );
    });
  }

  it('hydrates only selected IDs and shares parent fallback photos through a lazy derivative ladder', async () => {
    const { db, pipelines } = database();
    installReader();
    const hydrated = await hydrateTopProductsRows(db, rows);
    expect(hydrated[0]).toMatchObject({
      nome: 'Parent',
      sku: 'P',
      photoUrl: 'https://example.test/photo.jpg',
    });
    expect(hydrated[0]!.variations[0]).toMatchObject({
      nome: 'Blue',
      photoUrl: 'https://example.test/photo.jpg',
    });
    expect(pipelines.map((pipeline) => pipeline.stages[0]!.args[0])).toEqual([
      ['produtos/parent', 'produtos/variant'],
      ['arquivos/small'],
      ['arquivos/medium'],
      ['arquivos/original'],
    ]);
  });

  it('does not load lower derivatives once the best candidate resolves', async () => {
    const { db, pipelines } = database();
    installReader();
    mocks.execute.mockImplementation(async (pipeline: FakePipeline) => {
      const paths = pipeline.stages[0]!.args[0] as string[];
      return paths[0]!.startsWith('produtos/')
        ? snapshot([{ rowId: 'parent', nome: 'Parent', fotos: [foto] }])
        : snapshot([{ rowId: 'small', url: 'https://example.test/small.jpg' }]);
    });
    expect((await hydrateTopProductsRows(db, rows))[0]!.photoUrl).toBe(
      'https://example.test/small.jpg',
    );
    expect(pipelines).toHaveLength(2);
  });

  it('degrades denied photo decorations to null while propagating catalog and network errors', async () => {
    const { db } = database();
    installReader(new FirebaseError('permission-denied', 'Photos denied'));
    expect((await hydrateTopProductsRows(db, rows))[0]!.photoUrl).toBeNull();
    const error = new FirebaseError('unavailable', 'Offline');
    installReader(error);
    await expect(hydrateTopProductsRows(db, rows)).rejects.toBe(error);
    mocks.execute.mockRejectedValue(new FirebaseError('permission-denied', 'Products denied'));
    await expect(hydrateTopProductsRows(db, rows)).rejects.toThrow('Products denied');
  });

  it('keeps deleted product labels usable and skips every query for an empty visible set', async () => {
    const { db } = database();
    mocks.execute.mockResolvedValue(snapshot([]));
    expect((await hydrateTopProductsRows(db, rows))[0]).toMatchObject({
      nome: 'parent',
      sku: null,
      photoUrl: null,
    });
    mocks.execute.mockClear();
    expect(await hydrateTopProductsRows(db, [])).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe('calendar and persisted result boundaries', () => {
  it('includes the complete end day in microseconds', () => {
    expect(topProductsDateRange('2026-09-01', '2026-09-30')).toEqual({
      startUs: new Date(2026, 8, 1).getTime() * 1000,
      endExclusiveUs: new Date(2026, 9, 1).getTime() * 1000,
    });
    expect(topProductsDateRange('2026-02-30', '2026-03-01')).toBeNull();
    expect(topProductsDateRange('2026-09-02', '2026-09-01')).toBeNull();
  });

  it('accepts typed report data and rejects corrupt cache payloads and unsafe photo URLs', () => {
    const report = aggregateTopProducts([group('p', 2)], products({ p: {} }));
    expect(isTopProductsReport(report)).toBe(true);
    const fractional = aggregateTopProducts(
      [group('a', 0.1), group('b', 0.2), group('c', 0.3)],
      products({
        a: { paiId: 'parent' },
        b: { paiId: 'parent' },
        c: { paiId: 'parent' },
      }),
    );
    expect(isTopProductsReport(fractional)).toBe(true);
    expect(
      isTopProductsReport({
        ...fractional,
        rows: [{ ...fractional.rows[0], quantidade: 0.6001 }],
        totalQuantidade: 0.6001,
      }),
    ).toBe(false);
    expect(isTopProductsReport({ ...report, totalQuantidade: Infinity })).toBe(false);
    expect(isTopProductsReport({ ...report, totalQuantidade: 3 })).toBe(false);
    expect(
      isTopProductsReport({
        ...report,
        rows: [...report.rows, ...report.rows],
        totalQuantidade: 4,
      }),
    ).toBe(false);
    expect(isTopProductsReport({ ...report, diagnostics: [{ kind: 'invented' }] })).toBe(false);
    const row = {
      ...report.rows[0]!,
      nome: 'Product',
      sku: null,
      photoUrl: null,
      variations: [{ produtoId: 'p', quantidade: 2, nome: 'Product', sku: null, photoUrl: null }],
    };
    expect(isHydratedTopProductsRow(row)).toBe(true);
    expect(isHydratedTopProductsRow({ ...row, photoUrl: 'javascript:alert(1)' })).toBe(false);
    expect(
      isHydratedTopProductsRow({
        ...row,
        variations: [row.variations[0], row.variations[0]],
      }),
    ).toBe(false);
    expect(isHydratedTopProductsRow({ ...row, quantidade: 3 })).toBe(false);
    expect(
      isHydratedTopProductsRow({
        ...row,
        variations: [{ produtoId: 'p', quantidade: 2 }],
      }),
    ).toBe(false);
  });
});
