import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase/firestore';
import { randomUUID } from 'node:crypto';
import {
  CHART,
  chartHarness,
} from '../../../apps/mercado-livre/lib/marketplace/size-charts/testing/chartHarness';
import { saveChartTransaction } from '../../../apps/web/lib/mercado-livre/chartPersistence';

// This tooling-owned regression joins both production entrypoints without an
// app-to-app production dependency. Only the two SDK adapters are substituted;
// the save transaction, sync journal, diff and outgoing HTTP adapter run real.
const h = vi.hoisted(() => ({ db: null as ReturnType<typeof chartHarness>['db'] | null }));
vi.mock('../../../apps/web/lib/data/tabelaDeMedidasCollection', () => ({
  tabelaDeMedidasCollection: { docRef: () => h.db!.doc('tabMedi/table') },
}));
vi.mock('firebase/firestore', async (importActual) => ({
  ...(await importActual<typeof import('firebase/firestore')>()),
  FieldPath: class {
    constructor(...publicSegments: string[]) {
      this.segments = publicSegments;
    }
    readonly segments: string[];
  },
  runTransaction: (_db: unknown, callback: (tx: unknown) => Promise<unknown>) =>
    h.db!.runTransaction((tx) =>
      callback({
        ...tx,
        get: async (ref: Parameters<typeof tx.get>[0]) => {
          const snap = (await tx.get(ref)) as { exists: boolean; data: () => unknown };
          return { ...snap, exists: () => snap.exists };
        },
      }),
    ),
}));

describe('web save followed by actual Mercado Livre sync (#1799)', () => {
  it('preserves immediate local persistence and sends the saved rename and ID-bearing row edit', async () => {
    const harness = chartHarness();
    h.db = harness.db;
    const chart = {
      ...CHART,
      nome: 'Saved rename',
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
    };
    const saved = await saveChartTransaction({
      db: {} as Firestore,
      tabMediId: 'table',
      integracaoId: 'account',
      chart,
      chartIndex: 0,
      original: CHART,
    });
    expect(harness.charts()[0]).toEqual(chart);
    expect(harness.calls).toHaveLength(0);
    await harness.send(saved.chart, randomUUID());
    expect(harness.calls.filter((call) => call.method === 'PUT').map((call) => call.path)).toEqual([
      '/catalog/charts/501',
      '/catalog/charts/501/rows/501:1',
    ]);
    expect(harness.remote.names).toEqual({ MLB: 'Saved rename' });
    expect(harness.charts()[1]!.id).toBeNull();
  });
});
