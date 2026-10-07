import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  mlChartSyncCollection,
  tabelaDeMedidasCollection,
} from '@delfrance/data/admin/collections';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { acquireOperation, operationContext } from './sizeChartOperation';
import { CHART, chartHarness } from './testing/chartHarness';
import { syncSizeCharts } from './sizeChartSync';
import { deferred } from '@delfrance/data/testing';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'chart operation contention (real Firestore)',
  () => {
    it('admits exactly one of two simultaneous sends through the real account reservation', async () => {
      const db = getAdminFirestore();
      const id = randomUUID();
      const ref = tabelaDeMedidasCollection.docRef(db, {}, id);
      await ref.set({ tabelasDeMedidasMercadoLivre: { account: { tabelas: [CHART] } } });
      try {
        const outcomes = await Promise.allSettled(
          [1, 2].map(() =>
            acquireOperation(operationContext(db, id, 'account'), randomUUID(), 0, CHART),
          ),
        );
        expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
        const control = await mlChartSyncCollection.docRef(db, { tabMediId: id }, 'account').get();
        expect(control.exists).toBe(true);
        expect(control.data()!.activeId).toBe(
          outcomes.find((result) => result.status === 'fulfilled')!.value.id,
        );
      } finally {
        await db.recursiveDelete(ref);
      }
    });

    it('preserves a competing chart edit after the remote rename and rejects the old write-back', async () => {
      const db = getAdminFirestore();
      const id = randomUUID();
      const h = chartHarness();
      const desired = { ...CHART, nome: 'Renamed' };
      const ref = tabelaDeMedidasCollection.docRef(db, {}, id);
      await ref.set({
        tabelasDeMedidasMercadoLivre: {
          account: { tabelas: [desired] },
          other: { tabelas: [CHART] },
        },
        legacy: 'keep',
      });
      const entered = deferred<void>();
      const release = deferred<void>();
      h.intercept = async (method) => {
        if (method === 'PUT') {
          entered.resolve();
          await release.promise;
        }
        return null;
      };
      try {
        const send = syncSizeCharts({ db, api: h.api, integracaoId: 'account' }, id, {
          operationId: randomUUID(),
          chartIndex: 0,
          chart: desired,
        });
        // Attach rejection handling before releasing the provider response.
        const failure = expect(send).rejects.toMatchObject({ code: 'CHART_CONFLICT' });
        await entered.promise;
        await ref.update({
          'tabelasDeMedidasMercadoLivre.account.tabelas': [{ ...desired, nome: 'Newer edit' }],
        });
        release.resolve();
        await failure;
        const saved = await ref.get();
        expect(saved.exists).toBe(true);
        expect(saved.data()!.tabelasDeMedidasMercadoLivre.account.tabelas[0].nome).toBe(
          'Newer edit',
        );
        expect(saved.data()!.tabelasDeMedidasMercadoLivre.other.tabelas[0].id).toBe(CHART.id);
        expect(saved.data()!.legacy).toBe('keep');
      } finally {
        release.resolve();
        await db.recursiveDelete(ref);
      }
    });
  },
);
