/**
 * Shared CC-e linkage re-check handler (#81) — the post-auth, HTTP-free core the
 * `reconciliarNfe` Cloud Function runs for a `cce-vinculo` task. Re-checks a
 * pending (cStat 136) CC-e via `reconcileCartaCorrecaoVinculo` and, while still
 * pending under the attempt cap, re-enqueues the next re-check through the
 * injected scheduler. The orchestrator persists the record state; this only
 * decides the re-enqueue (mirrors `runReconcile` ↔ `reconcileByRecibo`).
 */
import type { Firestore } from 'firebase-admin/firestore';

import { nextConsultaDelayMs } from '@delfrance/integrations-nfe';

import type { NFeBaseRuntime } from '../runtime';
import {
  reconcileCartaCorrecaoVinculo,
  type ReconcileCceResult,
} from '../orchestrator/carta-correcao';
import type { CceVinculoTaskPayload, TaskScheduler } from '../tasks';

export interface RunReconcileCceResult extends ReconcileCceResult {
  /** Whether the next re-check was scheduled (still cStat 136 under the cap). */
  readonly reEnqueued: boolean;
}

/**
 * Re-check one pending CC-e. On `stillPending` (still 136 under the cap), schedule
 * the next re-check at `now + nextConsultaDelayMs(nextAttempt)`. Every terminal
 * disposition (resolved / capped / rejected / gone / already-resolved) leaves
 * `stillPending === false`, so it does not re-enqueue — the terminal rule lives in
 * `reconcileCartaCorrecaoVinculo`, not here.
 */
export async function runReconcileCce(args: {
  fs: Firestore;
  baseRt: NFeBaseRuntime;
  scheduler: TaskScheduler;
  payload: CceVinculoTaskPayload;
}): Promise<RunReconcileCceResult> {
  const { fs, baseRt, scheduler, payload } = args;
  const result = await reconcileCartaCorrecaoVinculo(fs, baseRt, payload);

  if (result.stillPending && result.nextAttempt !== undefined) {
    await scheduler.enqueueCceVinculo({
      pedidoId: payload.pedidoId,
      nfeId: payload.nfeId,
      cceId: payload.cceId,
      nSeqEvento: payload.nSeqEvento,
      attempt: result.nextAttempt,
      scheduleAtMs: Date.now() + nextConsultaDelayMs(result.nextAttempt),
    });
    return { ...result, reEnqueued: true };
  }
  return { ...result, reEnqueued: false };
}
