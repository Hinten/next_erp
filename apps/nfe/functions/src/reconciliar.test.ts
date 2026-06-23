/**
 * `reconciliarNfe` disposition: the queue retries iff the handler throws.
 * Handled outcomes (incl. cStat 656 terminal) and deterministic failures
 * (bad payload, cert-unavailable) RETURN; transient failures (runtime not
 * ready, transport) THROW. 656 must never re-run (SEFAZ-ban risk).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NFeCertError } from '@delfrance/integrations-nfe';

// vi.hoisted so the mock fns exist before the hoisted vi.mock factories run.
const { getNFeRuntime, runReconcile, runReconcileCce } = vi.hoisted(() => ({
  getNFeRuntime: vi.fn(),
  runReconcile: vi.fn(),
  runReconcileCce: vi.fn(),
}));
vi.mock('./lib/admin', () => ({ getDb: () => ({}) }));
vi.mock('../../lib/nfe/runtime', () => ({ getNFeRuntime }));
vi.mock('../../lib/nfe/handlers/runReconcile', () => ({ runReconcile }));
vi.mock('../../lib/nfe/handlers/runReconcileCce', () => ({ runReconcileCce }));
vi.mock('../../lib/nfe/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/nfe/tasks')>();
  return {
    ...actual,
    createTaskScheduler: vi.fn(() => ({
      async enqueueConsulta() {},
      async enqueueCceVinculo() {},
    })),
  };
});

import { handleReconciliarTask } from './reconciliar';

const PAYLOAD = { kind: 'consulta-lote', filialId: 'F-1', nRec: 'REC-1', tpEmis: 1, attempt: 0 };
const CCE_PAYLOAD = {
  kind: 'cce-vinculo',
  pedidoId: 'PED-1',
  nfeId: 's1',
  cceId: 'cce-1',
  nSeqEvento: 1,
  attempt: 0,
};

beforeEach(() => {
  getNFeRuntime.mockReset();
  getNFeRuntime.mockReturnValue({});
  runReconcile.mockReset();
  runReconcileCce.mockReset();
});

describe('handleReconciliarTask disposition', () => {
  it('returns (no retry) on a malformed payload', async () => {
    await expect(handleReconciliarTask({ kind: 'consulta-lote' })).resolves.toBeUndefined();
    expect(runReconcile).not.toHaveBeenCalled();
  });

  it('returns (no retry) on a handled outcome including cStat 656', async () => {
    runReconcile.mockResolvedValue({
      scanned: 1,
      stillPending: 0,
      recovered: 0,
      errored: 1,
      cStat: '656',
      reEnqueued: false,
    });
    await expect(handleReconciliarTask(PAYLOAD)).resolves.toBeUndefined();
  });

  it('returns (no retry) when the filial cert is unavailable (NFeCertError)', async () => {
    runReconcile.mockRejectedValue(new NFeCertError('sem certificado'));
    await expect(handleReconciliarTask(PAYLOAD)).resolves.toBeUndefined();
  });

  it('throws (queue retries) when the runtime is not ready', async () => {
    getNFeRuntime.mockImplementation(() => {
      throw new Error('chain missing');
    });
    await expect(handleReconciliarTask(PAYLOAD)).rejects.toThrow(/chain missing/);
  });

  it('throws (queue retries) on a transport/unexpected error', async () => {
    runReconcile.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(handleReconciliarTask(PAYLOAD)).rejects.toThrow(/ETIMEDOUT/);
  });

  it('routes a cce-vinculo task to runReconcileCce (not runReconcile)', async () => {
    runReconcileCce.mockResolvedValue({
      cStat: '135',
      stillPending: false,
      disposition: 'resolved',
      reEnqueued: false,
    });
    await expect(handleReconciliarTask(CCE_PAYLOAD)).resolves.toBeUndefined();
    expect(runReconcileCce).toHaveBeenCalledTimes(1);
    expect(runReconcile).not.toHaveBeenCalled();
  });

  it('throws (queue retries) on a transport error during the CC-e re-check', async () => {
    runReconcileCce.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(handleReconciliarTask(CCE_PAYLOAD)).rejects.toThrow(/ETIMEDOUT/);
  });
});
