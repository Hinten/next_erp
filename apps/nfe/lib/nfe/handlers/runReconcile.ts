/**
 * Shared reconcile-by-recibo handler — the post-auth, HTTP-free core of what was
 * `POST /api/nfe/reconciliar`. Used by the `reconciliarNfe` Cloud Function
 * (executes it in-process) and importable by any other caller. Auth + request
 * parsing + HTTP/queue-retry mapping stay in the caller; this just does the work.
 *
 * Resolves the filial runtime, consults the lote by recibo (`reconcileByRecibo`),
 * and — while still processing (`cStat=105`, under the cap) — re-enqueues the next
 * consult with backoff via the injected scheduler. Throws the orchestrator's typed
 * errors (`NFeCertError`, transport errors); the caller decides their disposition.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { nextConsultaDelayMs } from '@delfrance/integrations-nfe';

import type { NFeBaseRuntime } from '../runtime';
import { resolveFilialRuntime } from '../filial-cert';
import { reconcileByRecibo, type ReconcileLoteResult } from '../orchestrator/reconcile';
import type { ConsultaTaskPayload, TaskScheduler } from '../tasks';

export interface RunReconcileResult extends ReconcileLoteResult {
  /** Whether the next consult was scheduled (still `cStat=105` under the cap). */
  readonly reEnqueued: boolean;
  readonly nextAttempt?: number;
}

/**
 * Reconcile one async lote. On `stillPending > 0`, schedule the next consult
 * (`now + nextConsultaDelayMs(attempt+1)`). cStat 656 (consumo indevido) and the
 * attempt cap leave `stillPending === 0`, so neither re-enqueues — the terminal
 * rule lives in `reconcileByRecibo`, not here.
 */
export async function runReconcile(args: {
  fs: Firestore;
  baseRt: NFeBaseRuntime;
  scheduler: TaskScheduler;
  payload: ConsultaTaskPayload;
}): Promise<RunReconcileResult> {
  const { fs, baseRt, scheduler, payload } = args;
  const { filialId, nRec, tpEmis, attempt } = payload;

  const rt = await resolveFilialRuntime(fs, baseRt, filialId);
  const result = await reconcileByRecibo({ fs, rt, filialId, nRec, tpEmis, attempt });

  if (result.stillPending > 0) {
    const nextAttempt = attempt + 1;
    await scheduler.enqueueConsulta({
      filialId,
      nRec,
      tpEmis,
      attempt: nextAttempt,
      scheduleAtMs: Date.now() + nextConsultaDelayMs(nextAttempt),
    });
    return { ...result, reEnqueued: true, nextAttempt };
  }
  return { ...result, reEnqueued: false };
}
