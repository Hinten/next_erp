/**
 * `runReconcileCce` handler — the CC-e re-check core the `reconciliarNfe` Cloud
 * Function runs for a `cce-vinculo` task. Asserts the re-enqueue decision:
 * re-enqueue while still pending (cStat 136 under the cap); NO re-enqueue on any
 * terminal disposition. Mocks the orchestrator re-check + injects a recording
 * scheduler. #81.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nfe/orchestrator/carta-correcao', () => ({
  reconcileCartaCorrecaoVinculo: vi.fn(),
}));

import { reconcileCartaCorrecaoVinculo } from '@/lib/nfe/orchestrator/carta-correcao';
import { runReconcileCce } from '@/lib/nfe/handlers/runReconcileCce';
import type { CceVinculoTaskInput, CceVinculoTaskPayload, TaskScheduler } from '@/lib/nfe/tasks';

const PAYLOAD: CceVinculoTaskPayload = {
  kind: 'cce-vinculo',
  pedidoId: 'PED-1',
  nfeId: 's1',
  cceId: 'cce-1',
  nSeqEvento: 1,
  attempt: 0,
};

function recordingScheduler(): { scheduler: TaskScheduler; enqueued: CceVinculoTaskInput[] } {
  const enqueued: CceVinculoTaskInput[] = [];
  return {
    scheduler: {
      async enqueueConsulta() {
        /* unused by runReconcileCce */
      },
      async enqueueCceVinculo(input) {
        enqueued.push(input);
      },
    },
    enqueued,
  };
}

describe('runReconcileCce', () => {
  it('re-enqueues the next re-check while still pending (136 under the cap)', async () => {
    vi.mocked(reconcileCartaCorrecaoVinculo).mockResolvedValue({
      cStat: '136',
      stillPending: true,
      nextAttempt: 1,
      disposition: 'pending',
    });
    const { scheduler, enqueued } = recordingScheduler();

    const res = await runReconcileCce({
      fs: {} as never,
      baseRt: {} as never,
      scheduler,
      payload: PAYLOAD,
    });

    expect(res.reEnqueued).toBe(true);
    expect(enqueued).toHaveLength(1);
    // Same nSeqEvento + cceId, attempt advanced to nextAttempt.
    expect(enqueued[0]).toMatchObject({ cceId: 'cce-1', nSeqEvento: 1, attempt: 1 });
  });

  it('does NOT re-enqueue on a terminal disposition (resolved)', async () => {
    vi.mocked(reconcileCartaCorrecaoVinculo).mockResolvedValue({
      cStat: '135',
      stillPending: false,
      disposition: 'resolved',
    });
    const { scheduler, enqueued } = recordingScheduler();

    const res = await runReconcileCce({
      fs: {} as never,
      baseRt: {} as never,
      scheduler,
      payload: PAYLOAD,
    });

    expect(res.reEnqueued).toBe(false);
    expect(enqueued).toHaveLength(0);
  });
});
