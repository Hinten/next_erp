import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deferred } from '@delfrance/data/testing';
import type { MlSizeChart } from '@delfrance/schemas';
import { CHART, chartHarness } from './testing/chartHarness';
import { SizeChartOperationError, currentOperation } from './sizeChartOperation';
import type { Firestore } from 'firebase-admin/firestore';

const edited = (value = '91') => ({
  ...CHART,
  nome: 'Renamed',
  rows: CHART.rows!.map((row, i) =>
    i
      ? row
      : {
          ...row,
          attributes: [
            { id: 'SIZE', value_name: 'M' },
            { id: 'CHEST', value_name: value, unit_id: 'cm' },
          ],
        },
  ),
});

describe('saved chart send protocol', () => {
  it('sends rename and existing-row PUTs against the remote baseline after a local save', async () => {
    const h = chartHarness();
    const chart = edited();
    h.saved(chart);
    const original = structuredClone(h.db.docs('tabMedi').get('table')!);
    const result = await h.send(chart);
    expect(result.status).toBe('completed');
    expect(h.calls.filter((c) => c.method !== 'GET')).toEqual([
      { method: 'PUT', path: '/catalog/charts/501', body: { names: { MLB: 'Renamed' } } },
      {
        method: 'PUT',
        path: '/catalog/charts/501/rows/501:1',
        body: {
          sites: ['MLB'],
          attributes: [
            { id: 'CHEST', values: [{ name: '91 cm', struct: { number: 91, unit: 'cm' } }] },
          ],
        },
      },
    ]);
    const map = h.db.docs('tabMedi').get('table')!.tabelasDeMedidasMercadoLivre as Record<
      string,
      { tabelas: MlSizeChart[]; metadata?: string }
    >;
    const before = original.tabelasDeMedidasMercadoLivre as typeof map;
    expect(map.account!.metadata).toBe('keep');
    expect(map.account!.tabelas[1]).toEqual(before.account!.tabelas[1]);
    expect(map.other).toEqual(before.other);
    expect(h.db.docs('tabMedi').get('table')!.tabelasMedidasShopee).toEqual(
      original.tabelasMedidasShopee,
    );
  });

  it('makes no mutations for unchanged charts even with reordered remote rows and decimal separators', async () => {
    const h = chartHarness();
    h.remote = { ...h.remote, rows: [...h.remote.rows!].reverse() };
    h.remote.rows![1]!.attributes![1]!.values = [{ name: '90.5 cm' }];
    await h.send(CHART);
    expect(h.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it.each([
    ['90,50', '90,5'],
    ['01', '1'],
  ])('keeps %s distinct from %s', async (before, after) => {
    const base = edited(before);
    const h = chartHarness(base);
    const chart = edited(after);
    h.saved(chart);
    await h.send(chart);
    expect(h.calls.filter((c) => c.path.includes('/rows/') && c.method === 'PUT')).toHaveLength(1);
  });

  it('retains the desired name after validation failure', async () => {
    const h = chartHarness();
    const chart = edited();
    h.saved(chart);
    h.intercept = async (method) =>
      method === 'PUT'
        ? Response.json(
            {
              error: 'chart_validation_error',
              errors: [{ code: 'chart_name_unavailable', message: 'Unavailable' }],
            },
            { status: 400 },
          )
        : null;
    const result = await h.send(chart);
    expect(result.status).toBe('validation');
    expect(result.validationErrors).toHaveLength(1);
    expect(h.charts()[0]!.nome).toBe('Renamed');
  });

  it('checkpoints a rename and resumes the remaining row after a 429', async () => {
    const h = chartHarness();
    const chart = edited();
    h.saved(chart);
    const id = randomUUID();
    h.intercept = async (_method, path) =>
      path.includes('/rows/') ? Response.json({}, { status: 429 }) : null;
    await expect(h.send(chart, id)).rejects.toMatchObject({ status: 429 });
    h.intercept = null;
    await h.send(chart, id);
    expect(
      h.calls.filter((c) => c.method === 'PUT' && c.path === '/catalog/charts/501'),
    ).toHaveLength(1);
    expect(h.calls.filter((c) => c.method === 'PUT' && c.path.includes('/rows/'))).toHaveLength(2);
    await h.send(chart, id);
    expect(h.calls.filter((c) => c.method === 'PUT' && c.path.includes('/rows/'))).toHaveLength(2);
  });

  it('rejects a stale request and simultaneous send before another ML mutation', async () => {
    const h = chartHarness();
    const chart = edited();
    await expect(h.send(chart)).rejects.toBeInstanceOf(SizeChartOperationError);
    expect(h.calls).toHaveLength(0);
    h.saved(chart);
    const entered = deferred<void>();
    const release = deferred<void>();
    h.intercept = async (method) => {
      if (method === 'PUT') {
        entered.resolve();
        await release.promise;
      }
      return null;
    };
    const first = h.send(chart);
    await entered.promise;
    await expect(h.send(chart)).rejects.toMatchObject({ code: 'CHART_BUSY' });
    release.resolve();
    await first;
  });

  it('keeps a newer local edit and stores the receipt when it wins during ML I/O', async () => {
    const h = chartHarness();
    const chart = edited();
    h.saved(chart);
    h.intercept = async (method) => {
      if (method === 'PUT') h.saved({ ...chart, nome: 'Another operator' });
      return null;
    };
    await expect(h.send(chart)).rejects.toMatchObject({ code: 'CHART_CONFLICT' });
    expect(h.charts()[0]!.nome).toBe('Another operator');
    const op = await currentOperation(h.db as unknown as Firestore, 'table', 'account');
    expect(op?.baseline?.names).toEqual({ MLB: 'Renamed' });
    expect(h.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('does not repost a chart when its creation response is lost; explicit recovery validates the account', async () => {
    const draft: MlSizeChart = {
      ...CHART,
      id: null,
      rows: CHART.rows!.map((row) => ({ ...row, id: null })),
    };
    const h = chartHarness(draft);
    const id = randomUUID();
    h.intercept = async (method) => {
      if (method === 'POST') throw new TypeError('Response lost');
      return null;
    };
    await expect(h.send(draft, id)).rejects.toMatchObject({ name: 'MercadoLivreNetworkError' });
    h.intercept = null;
    await expect(h.send(draft, id)).rejects.toMatchObject({ code: 'CHART_UNCONFIRMED' });
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    await h.send(draft, id, '501');
    expect(h.charts()[0]!.id).toBe('501');
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('recovers an accepted row POST after its receipt commit failed without duplicating the row', async () => {
    const h = chartHarness();
    const chart = {
      ...CHART,
      rows: [
        ...CHART.rows!,
        {
          id: null,
          attributes: [
            { id: 'SIZE', value_name: 'GG' },
            { id: 'CHEST', value_name: '110', unit_id: 'cm' },
          ],
        },
      ],
    };
    h.saved(chart);
    const id = randomUUID();
    h.db.occ.beforeCommit = async (ctx) => {
      if (
        ctx.writes.some(
          (w) =>
            w.path.includes('mlChartSyncOperations') &&
            w.data.baseline != null &&
            (w.data.baseline as { rows: unknown[] }).rows.length === 3,
        )
      ) {
        h.db.occ.beforeCommit = null;
        throw new Error('Receipt write failed');
      }
    };
    await expect(h.send(chart, id)).rejects.toThrow('Receipt write failed');
    // The previous invocation has stopped, but its persisted worker reservation
    // remains until the safe lease expiry (as after a process crash).
    const opPath = `tabMedi/table/mlChartSync/account/mlChartSyncOperations/${id}`;
    const op = h.db.documents.get(opPath)!;
    op.leaseUntilMs = 0;
    await h.send(chart, id);
    expect(h.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(h.charts()[0]!.rows![2]!.id).toBe('501:3');
  });
});
