import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';
import { ESTADO_PEDIDO } from '@delfrance/schemas';
import {
  createMemoryReportCacheStorage,
  createReportCache,
  REPORT_CACHE_TTL_MS,
  type ReportCacheScope,
} from './reportCache';
import type {
  hydrateTopProductsRows,
  loadTopProductsReport,
  HydratedTopProductsRow,
  TopProductsFilters,
  TopProductsReport,
  TopProductsRow,
} from './topProducts';
import { createTopProductsRunner, topProductsCacheKey } from './topProductsSession';

const BASE = 1_800_000_000_000;
// Every data read is injected; this Firestore stand-in is never queried.
const db = {} as Firestore;
const scope: ReportCacheScope = {
  version: 'best-sellers:1',
  project: 'project-a',
  database: 'default',
  transport: 'staging',
  userId: 'operator-a',
  permissions: '31',
};
const filters: TopProductsFilters = {
  startUs: 1_000_000,
  endExclusiveUs: 2_000_000,
  estados: [ESTADO_PEDIDO.pago, ESTADO_PEDIDO.finalizado],
  accountIds: ['shop-b', 'shop-a'],
  ehSaida: true,
};
const report: TopProductsReport = {
  rows: [
    {
      produtoId: 'parent-a',
      quantidade: 8,
      variations: [
        { produtoId: 'variation-a', quantidade: 5 },
        { produtoId: 'variation-b', quantidade: 3 },
      ],
    },
    {
      produtoId: 'parent-b',
      quantidade: 4,
      variations: [{ produtoId: 'parent-b', quantidade: 4 }],
    },
    {
      produtoId: 'parent-c',
      quantidade: 1,
      variations: [{ produtoId: 'variation-c', quantidade: 1 }],
    },
  ],
  totalQuantidade: 13,
  diagnostics: [],
};

function decorated(rows: readonly TopProductsRow[]): HydratedTopProductsRow[] {
  const display = (id: string) => ({
    nome: 'Product ' + id,
    sku: 'SKU-' + id,
    photoUrl: 'https://example.test/' + id + '.jpg',
  });
  return rows.map((row) => ({
    ...row,
    ...display(row.produtoId),
    variations: row.variations.map((variation) => ({
      ...variation,
      ...display(variation.produtoId),
    })),
  }));
}

function setup() {
  const clock = { now: BASE };
  const storage = createMemoryReportCacheStorage();
  const load = vi.fn<typeof loadTopProductsReport>().mockResolvedValue(report);
  const hydrate = vi
    .fn<typeof hydrateTopProductsRows>()
    .mockImplementation(async (_db, rows) => decorated(rows));
  const makeRunner = () =>
    createTopProductsRunner({
      cache: createReportCache({ storage, now: () => clock.now }),
      now: () => clock.now,
      load,
      hydrate,
    });
  return { clock, storage, load, hydrate, makeRunner, runner: makeRunner() };
}

describe('top-products report session', () => {
  it('reuses the complete snapshot and resolved photos without another data read', async () => {
    const { runner, load, hydrate } = setup();
    const first = await runner.run(db, scope, filters, 2);
    const repeat = await runner.run(db, scope, filters, 2);
    expect(first).toMatchObject({ fromCache: false, generatedAt: BASE });
    expect(repeat).toEqual({ ...first, fromCache: true });
    expect(repeat.rows[0]?.photoUrl).toBe('https://example.test/parent-a.jpg');
    expect(repeat.rows[0]?.variations[0]?.photoUrl).toBe('https://example.test/variation-a.jpg');
    expect(load).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it('restores the persisted snapshot in a new runner without resetting its expiry', async () => {
    const { runner, makeRunner, load, hydrate, clock } = setup();
    const first = await runner.run(db, scope, filters, 2);
    clock.now += 60_000;
    const afterReload = await makeRunner().run(db, scope, filters, 2);
    expect(afterReload).toEqual({ ...first, fromCache: true });
    expect(afterReload.expiresAt).toBe(BASE + REPORT_CACHE_TTL_MS);
    expect(load).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it('hydrates only newly visible top-N rows and retains earlier decorations', async () => {
    const { runner, load, hydrate } = setup();
    await runner.run(db, scope, filters, 1);
    const expanded = await runner.run(db, scope, filters, 3);
    expect(expanded.rows).toHaveLength(3);
    expect(hydrate.mock.calls[0]?.[1].map((row) => row.produtoId)).toEqual(['parent-a']);
    expect(hydrate.mock.calls[1]?.[1].map((row) => row.produtoId)).toEqual([
      'parent-b',
      'parent-c',
    ]);
    const reduced = await runner.run(db, scope, filters, 1);
    expect(reduced.rows).toEqual(expanded.rows.slice(0, 1));
    await runner.run(db, scope, filters, 3);
    expect(load).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it('reuses cross-tab enrichment for Top 1, Top 3, Top 2 and a Top 3 reload without more reads', async () => {
    const { runner: tabA, makeRunner, load, hydrate, clock } = setup();
    const first = await tabA.run(db, scope, filters, 1);
    const tabB = makeRunner();
    clock.now += 60_000;
    const expanded = await tabB.run(db, scope, filters, 3);
    expect(load).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledTimes(2);
    clock.now += 60_000;
    const reduced = await tabA.run(db, scope, filters, 2);
    const reloaded = await makeRunner().run(db, scope, filters, 3);
    expect(reduced.rows).toEqual(expanded.rows.slice(0, 2));
    expect(reloaded.rows).toEqual(expanded.rows);
    expect(reloaded.generatedAt).toBe(first.generatedAt);
    expect(reloaded.expiresAt).toBe(first.expiresAt);
    expect(load).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it('unions concurrent tab enrichment when the smaller view finishes last', async () => {
    const { runner: tabA, makeRunner, load, hydrate } = setup();
    await tabA.run(db, scope, filters, 1);
    let resolve!: (rows: HydratedTopProductsRow[]) => void;
    hydrate.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const tabB = makeRunner();
    const small = tabB.run(db, scope, filters, 2);
    await vi.waitFor(() => expect(hydrate).toHaveBeenCalledTimes(2));
    const large = await tabA.run(db, scope, filters, 3);
    resolve(decorated(report.rows.slice(1, 2)));
    expect((await small).rows).toEqual(large.rows.slice(0, 2));
    const reloaded = await makeRunner().run(db, scope, filters, 3);
    expect(reloaded.rows).toEqual(large.rows);
    expect(reloaded.expiresAt).toBe(BASE + REPORT_CACHE_TTL_MS);
    expect(load).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledTimes(3);
  });

  it('keeps a newer cross-tab refresh when an old snapshot finishes enrichment later', async () => {
    const { runner: tabA, makeRunner, load, hydrate, clock } = setup();
    await tabA.run(db, scope, filters, 1);
    let resolve!: (rows: HydratedTopProductsRow[]) => void;
    hydrate.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const enriching = tabA.run(db, scope, filters, 3);
    await vi.waitFor(() => expect(hydrate).toHaveBeenCalledTimes(2));
    const updated: TopProductsReport = {
      rows: [
        {
          produtoId: 'new-parent',
          quantidade: 2,
          variations: [{ produtoId: 'new-parent', quantidade: 2 }],
        },
      ],
      totalQuantidade: 2,
      diagnostics: [],
    };
    clock.now += 60_000;
    load.mockResolvedValueOnce(updated);
    const fresh = await makeRunner().run(db, scope, filters, 1, true);
    resolve(decorated(report.rows.slice(1)));
    await enriching;
    expect(await makeRunner().run(db, scope, filters, 3)).toEqual({ ...fresh, fromCache: true });
    expect(await tabA.run(db, scope, filters, 3)).toEqual({ ...fresh, fromCache: true });
    expect(load).toHaveBeenCalledTimes(2);
    expect(hydrate).toHaveBeenCalledTimes(3);
  });

  it('does not merge invalid persisted decorations into a valid same-snapshot write', async () => {
    const { runner, makeRunner, hydrate, load, storage } = setup();
    await runner.run(db, scope, filters, 1);
    let resolve!: (rows: HydratedTopProductsRow[]) => void;
    hydrate.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const enriching = runner.run(db, scope, filters, 2);
    await vi.waitFor(() => expect(hydrate).toHaveBeenCalledTimes(2));
    const invalid = decorated(report.rows.slice(2));
    invalid[0]!.quantidade = 999;
    storage.map.set(topProductsCacheKey(scope, filters), {
      schemaVersion: 1,
      generatedAt: BASE,
      requestStartedAt: BASE,
      data: { report, hydratedRows: invalid },
    });
    resolve(decorated(report.rows.slice(1, 2)));
    const result = await enriching;
    expect((await makeRunner().run(db, scope, filters, 2)).rows).toEqual(result.rows);
    expect(load).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it('expires exactly six hours after generation, including after a reload', async () => {
    const { runner, makeRunner, load, hydrate, clock } = setup();
    await runner.run(db, scope, filters, 1);
    clock.now = BASE + REPORT_CACHE_TTL_MS - 1;
    expect((await makeRunner().run(db, scope, filters, 1)).fromCache).toBe(true);
    clock.now++;
    const fresh = await makeRunner().run(db, scope, filters, 1);
    expect(fresh.fromCache).toBe(false);
    expect(fresh.generatedAt).toBe(clock.now);
    expect(fresh.expiresAt).toBe(clock.now + REPORT_CACHE_TTL_MS);
    expect(load).toHaveBeenCalledTimes(2);
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it('refreshes explicitly and retains the previous snapshot if the aggregate fails', async () => {
    const { runner, load, clock } = setup();
    const original = await runner.run(db, scope, filters, 1);
    clock.now++;
    load.mockRejectedValueOnce(new TypeError('Query failed'));
    await expect(runner.run(db, scope, filters, 1, true)).rejects.toThrow('Query failed');
    expect(await runner.run(db, scope, filters, 1)).toEqual({ ...original, fromCache: true });
    const updated: TopProductsReport = {
      rows: [
        {
          produtoId: 'updated',
          quantidade: 2,
          variations: [{ produtoId: 'updated', quantidade: 2 }],
        },
      ],
      totalQuantidade: 2,
      diagnostics: [],
    };
    load.mockResolvedValueOnce(updated);
    clock.now++;
    const refreshed = await runner.run(db, scope, filters, 1, true);
    expect(refreshed).toMatchObject({ report: updated, fromCache: false, generatedAt: clock.now });
    expect(await runner.run(db, scope, filters, 1)).toEqual({ ...refreshed, fromCache: true });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('retains cached results if forced decoration fails', async () => {
    const { runner, hydrate, clock } = setup();
    const original = await runner.run(db, scope, filters, 1);
    clock.now++;
    hydrate.mockRejectedValueOnce(new TypeError('Decoration failed'));
    await expect(runner.run(db, scope, filters, 1, true)).rejects.toThrow('Decoration failed');
    expect(await runner.run(db, scope, filters, 1)).toEqual({ ...original, fromCache: true });
  });

  it('deduplicates the same in-flight request', async () => {
    const { runner, load, hydrate } = setup();
    let resolve!: (value: TopProductsReport) => void;
    load.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = runner.run(db, scope, filters, 2);
    const concurrent = runner.run(db, scope, filters, 2);
    expect(concurrent).toBe(first);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    resolve(report);
    expect(await concurrent).toEqual(await first);
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it('serializes different top-N requests without losing cached decoration work', async () => {
    const { runner, load, hydrate } = setup();
    const [small, large] = await Promise.all([
      runner.run(db, scope, filters, 1),
      runner.run(db, scope, filters, 3),
    ]);
    expect(small.rows).toHaveLength(1);
    expect(large.rows).toHaveLength(3);
    expect(load).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledTimes(2);
    await runner.run(db, scope, filters, 3);
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  it('normalizes selection sets while separating identities, permissions and filters', async () => {
    const { runner, load } = setup();
    await runner.run(db, scope, filters, 1);
    await runner.run(
      db,
      scope,
      {
        ...filters,
        accountIds: ['shop-a', 'shop-b', 'shop-a'],
        estados: [ESTADO_PEDIDO.finalizado, ESTADO_PEDIDO.pago, ESTADO_PEDIDO.pago],
      },
      1,
    );
    expect(load).toHaveBeenCalledTimes(1);
    await runner.run(db, { ...scope, userId: 'operator-b' }, filters, 1);
    await runner.run(db, { ...scope, permissions: '63' }, filters, 1);
    await runner.run(db, scope, { ...filters, ehSaida: false }, 1);
    expect(load).toHaveBeenCalledTimes(4);
    expect(topProductsCacheKey(scope, filters)).not.toBe(
      topProductsCacheKey(scope, { ...filters, accountIds: ['01', '1'] }),
    );
  });

  it('caches empty reports without trying to hydrate nonexistent products', async () => {
    const { runner, makeRunner, load, hydrate } = setup();
    load.mockResolvedValueOnce({ rows: [], totalQuantidade: 0, diagnostics: [] });
    expect((await runner.run(db, scope, filters, 1)).rows).toEqual([]);
    expect((await makeRunner().run(db, scope, filters, 1)).fromCache).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(hydrate).not.toHaveBeenCalled();
  });

  it('rejects an invalid top-N before making any reads', async () => {
    const { runner, load, hydrate } = setup();
    for (const topN of [0, 51, 1.5, Number.NaN]) {
      await expect(runner.run(db, scope, filters, topN)).rejects.toThrow(RangeError);
    }
    expect(load).not.toHaveBeenCalled();
    expect(hydrate).not.toHaveBeenCalled();
  });
});
