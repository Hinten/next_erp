/**
 * `runReconcile` handler — the reconcile core that the `reconciliarNfe` Cloud
 * Function executes in-process. Asserts the re-enqueue decision: re-enqueue while
 * still pending; NO re-enqueue on a terminal outcome (incl. cStat 656, which the
 * core leaves `stillPending === 0`). Mocks the filial runtime + the reconcile core
 * and injects a recording scheduler.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nfe/filial-cert', () => ({ resolveFilialRuntime: vi.fn(async () => ({})) }));
vi.mock('@/lib/nfe/orchestrator/reconcile', () => ({ reconcileByRecibo: vi.fn() }));

import { reconcileByRecibo } from '@/lib/nfe/orchestrator/reconcile';
import { runReconcile } from '@/lib/nfe/handlers/runReconcile';
import type { ConsultaTaskInput, TaskScheduler } from '@/lib/nfe/tasks';

const PAYLOAD = {
  kind: 'consulta-lote',
  filialId: 'F-1',
  nRec: 'REC-1',
  tpEmis: 1,
  attempt: 0,
} as const;

function recordingScheduler(): { scheduler: TaskScheduler; enqueued: ConsultaTaskInput[] } {
  const enqueued: ConsultaTaskInput[] = [];
  return {
    scheduler: {
      async enqueueConsulta(input) {
        enqueued.push(input);
      },
    },
    enqueued,
  };
}

describe('runReconcile', () => {
  it('re-enqueues with attempt+1 while the lote is still pending', async () => {
    vi.mocked(reconcileByRecibo).mockResolvedValue({
      scanned: 1,
      stillPending: 1,
      recovered: 0,
      errored: 0,
      cStat: '105',
    });
    const { scheduler, enqueued } = recordingScheduler();
    const res = await runReconcile({
      fs: {} as never,
      baseRt: {} as never,
      scheduler,
      payload: PAYLOAD,
    });
    expect(res.reEnqueued).toBe(true);
    expect(res.nextAttempt).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ nRec: 'REC-1', attempt: 1 });
  });

  it('does NOT re-enqueue on a terminal outcome (656 → errored, stillPending 0)', async () => {
    vi.mocked(reconcileByRecibo).mockResolvedValue({
      scanned: 1,
      stillPending: 0,
      recovered: 0,
      errored: 1,
      cStat: '656',
    });
    const { scheduler, enqueued } = recordingScheduler();
    const res = await runReconcile({
      fs: {} as never,
      baseRt: {} as never,
      scheduler,
      payload: PAYLOAD,
    });
    expect(res.reEnqueued).toBe(false);
    expect(enqueued).toHaveLength(0);
  });
});
