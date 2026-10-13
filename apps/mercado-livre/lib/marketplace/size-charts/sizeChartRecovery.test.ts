import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { deferred } from '@delfrance/data/testing';
import { CHART, chartHarness } from './testing/chartHarness';
import { recoverSizeChart } from './sizeChartRecovery';
import { requestSizeChartDeletion } from './sizeChartDelete';
import { currentOperation } from './sizeChartOperation';

function recovery(
  h: ReturnType<typeof chartHarness>,
  operationId: string,
  options: Record<string, unknown> = {},
) {
  return recoverSizeChart(
    { db: h.db as unknown as Firestore, api: h.api, integracaoId: 'account' },
    'table',
    { operationId, ...options },
  );
}
const draft = { ...CHART, id: null, rows: CHART.rows!.map((row) => ({ ...row, id: null })) };

describe('recovering an uncertain chart operation', () => {
  it('requires operator verification to release a chart POST that never reached ML', async () => {
    const h = chartHarness(draft);
    const id = randomUUID();
    h.intercept = async (method) => {
      if (method === 'POST') throw new TypeError('Offline before write');
      return null;
    };
    await expect(h.send(draft, id)).rejects.toMatchObject({ name: 'MercadoLivreNetworkError' });
    await expect(recovery(h, id)).rejects.toMatchObject({ code: 'CHART_UNCONFIRMED' });
    expect(h.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    await recovery(h, id, { confirmNoCreation: true });
    expect((await currentOperation(h.db as unknown as Firestore, 'table', 'account'))?.status).toBe(
      'abandoned',
    );
    await expect(h.send(draft, id)).rejects.toMatchObject({ code: 'CHART_CONFLICT' });
    h.intercept = null;
    await h.send(draft);
    expect(h.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });

  it.each([false, true])(
    'reconciles a failed %s row/rename PUT after a newer draft, without replaying the old edit',
    async (rowFailure) => {
      const h = chartHarness();
      const id = randomUUID();
      const attempted = rowFailure
        ? {
            ...CHART,
            rows: CHART.rows!.map((row, i) =>
              i
                ? row
                : {
                    ...row,
                    attributes: [
                      { id: 'SIZE', value_name: 'M' },
                      { id: 'CHEST', value_name: '91', unit_id: 'cm' },
                    ],
                  },
            ),
          }
        : { ...CHART, nome: 'Old attempt' };
      h.saved(attempted);
      h.intercept = async (method) =>
        method === 'PUT' ? Response.json({}, { status: 500 }) : null;
      await expect(h.send(attempted, id)).rejects.toMatchObject({ status: 500 });
      const newer = { ...attempted, nome: 'Newer draft' };
      h.saved(newer);
      await expect(h.send(newer)).rejects.toMatchObject({ code: 'CHART_BUSY' });
      const writesBefore = h.calls.filter((call) => call.method !== 'GET').length;
      h.intercept = null;
      expect(await recovery(h, id)).toMatchObject({ released: true, chart: null });
      expect(h.calls.filter((call) => call.method !== 'GET')).toHaveLength(writesBefore);
      expect(h.charts()[0]).toEqual(newer);
      await h.send(newer);
      expect(h.remote.names).toEqual({ MLB: 'Newer draft' });
    },
  );

  it('does not recover an operation while its original worker can still write', async () => {
    const h = chartHarness();
    const chart = { ...CHART, nome: 'Rename' };
    h.saved(chart);
    const id = randomUUID();
    const entered = deferred<void>();
    const release = deferred<void>();
    h.intercept = async (method) => {
      if (method === 'PUT') {
        entered.resolve();
        await release.promise;
      }
      return null;
    };
    const sending = h.send(chart, id);
    await entered.promise;
    await expect(recovery(h, id)).rejects.toMatchObject({ code: 'CHART_BUSY' });
    release.resolve();
    await sending;
  });

  it('does not reconcile a different chart ID supplied for an existing-chart update', async () => {
    const h = chartHarness();
    const id = randomUUID();
    const desired = { ...CHART, nome: 'Renamed' };
    h.saved(desired);
    h.intercept = async (method) => (method === 'PUT' ? Response.json({}, { status: 500 }) : null);
    await expect(h.send(desired, id)).rejects.toMatchObject({ status: 500 });
    h.intercept = null;
    await expect(recovery(h, id, { recoveryChartId: '999' })).rejects.toMatchObject({
      code: 'CHART_UNCONFIRMED',
    });
    expect(h.db.documents.get('tabMedi/table/mlChartSync/account')!.activeId).toBe(id);
  });

  it('binds a recovered creation ID while retaining a newer name and measurements', async () => {
    const h = chartHarness(draft);
    const id = randomUUID();
    h.intercept = async (method) => {
      if (method === 'POST') throw new TypeError('Response lost');
      return null;
    };
    await expect(h.send(draft, id)).rejects.toMatchObject({ name: 'MercadoLivreNetworkError' });
    const newer = {
      ...draft,
      nome: 'Keep newer name',
      rows: draft.rows.map((row, i) =>
        i
          ? row
          : {
              ...row,
              attributes: [
                { id: 'SIZE', value_name: 'M' },
                { id: 'CHEST', value_name: '99', unit_id: 'cm' },
              ],
            },
      ),
    };
    h.saved(newer);
    h.intercept = null;
    const result = await recovery(h, id, { recoveryChartId: '501', expectedChart: newer });
    expect(result.chart).toMatchObject({ id: '501', nome: 'Keep newer name' });
    expect(result.chart!.rows![0]!.attributes).toEqual(newer.rows[0]!.attributes);
    expect(h.charts()[0]!.rows![0]!.id).toBe('501:1');
    await h.send(h.charts()[0]!);
    expect(h.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(h.remote.names).toEqual({ MLB: 'Keep newer name' });
  });

  it('keeps the reservation when a competing draft changes during recovery', async () => {
    const h = chartHarness(draft);
    const id = randomUUID();
    h.intercept = async (method) => {
      if (method === 'POST') throw new TypeError('Lost response');
      return null;
    };
    await expect(h.send(draft, id)).rejects.toMatchObject({ name: 'MercadoLivreNetworkError' });
    const expected = { ...draft, nome: 'Reviewed draft' };
    h.saved(expected);
    h.intercept = async () => {
      h.saved({ ...expected, nome: 'Competing writer' });
      return null;
    };
    await expect(
      recovery(h, id, { recoveryChartId: '501', expectedChart: expected }),
    ).rejects.toMatchObject({ code: 'CHART_CONFLICT' });
    expect(h.charts()[0]!.nome).toBe('Competing writer');
    expect(h.charts()[0]!.id).toBeNull();
    expect(h.db.documents.get('tabMedi/table/mlChartSync/account')!.activeId).toBe(id);
  });

  it('does not treat a known accepted chart receipt as a creation that can be discarded', async () => {
    const h = chartHarness(draft);
    const id = randomUUID();
    h.db.occ.beforeCommit = async (ctx) => {
      if (
        ctx.writes.some(
          (write) =>
            write.data.projected && (write.data.projected as { id: string | null }).id === '501',
        )
      ) {
        h.db.occ.beforeCommit = null;
        throw new Error('Failed ID checkpoint');
      }
    };
    await expect(h.send(draft, id)).rejects.toThrow('Failed ID checkpoint');
    const path = `tabMedi/table/mlChartSync/account/mlChartSyncOperations/${id}`;
    h.db.documents.get(path)!.leaseUntilMs = 0;
    await expect(recovery(h, id, { confirmNoCreation: true })).rejects.toMatchObject({
      code: 'CHART_UNCONFIRMED',
    });
    expect(h.db.documents.get('tabMedi/table/mlChartSync/account')!.activeId).toBe(id);
  });

  it('unblocks delete/verify and unrelated charts after explicit recovery', async () => {
    const h = chartHarness(draft);
    const id = randomUUID();
    h.intercept = async (method) => {
      if (method === 'POST') throw new TypeError('Lost response');
      return null;
    };
    await expect(h.send(draft, id)).rejects.toMatchObject({ name: 'MercadoLivreNetworkError' });
    await recovery(h, id, { confirmNoCreation: true });
    h.saved(CHART);
    h.intercept = null;
    await requestSizeChartDeletion(
      { db: h.db as unknown as Firestore, api: h.api, integracaoId: 'account' },
      'table',
      '501',
    );
    expect(h.calls.some((call) => call.method === 'DELETE')).toBe(true);
  });
});
