/**
 * Shared reconcile-by-recibo handler — the post-auth, HTTP-free core of what was
 * `POST /api/nfe/reconciliar`. Used by the `reconciliarNfe` Cloud Function
 * (executes it in-process) and importable by any other caller. Auth + request
 * parsing + HTTP/queue-retry mapping stay in the caller; this just does the work.
 *
 * Resolves the filial runtime, consults the lote by recibo (`reconcileByRecibo`),
 * and — while any doc of the lote is still pending (`stillPending > 0`: a doc
 * left in flight under the attempt cap, or one whose round a transient
 * Firestore failure interrupted, uncounted unless its by-chave count had
 * already landed) — re-enqueues the next consult with
 * backoff via the injected scheduler. Throws the orchestrator's typed errors
 * (`NFeCertError`, transport errors); the caller decides their disposition.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { esperaMinimaDoRecibo, nextConsultaDelayMs } from '@delfrance/integrations-nfe';

import type { NFeBaseRuntime } from '../runtime';
import { resolveFilialRuntime } from '../filial-cert';
import { reconcileByRecibo, type ReconcileLoteResult } from '../orchestrator/reconcile';
import type { ConsultaTaskPayload, TaskScheduler } from '../tasks';

export interface RunReconcileResult extends ReconcileLoteResult {
  /** Whether the next consult was scheduled (`stillPending > 0`). */
  readonly reEnqueued: boolean;
  readonly nextAttempt?: number;
}

/**
 * Reconcile one async lote. On `stillPending > 0`, schedule the next consult at
 * `now + max(nextConsultaDelayMs(attempt+1), esperaMinimaDoRecibo(cStat))`: a
 * receipt that answered serviço paralisado (108/109/113/114) waits
 * `RECONCILE_INDISPONIVEL_DELAY_MS` — the same wait `reconcileByRecibo` stamps
 * on each doc's `proximaConsultaEm`, so the sweep never runs ahead of the task
 * (#1654). cStat 656 (consumo indevido) and the attempt cap leave
 * `stillPending === 0`, so neither re-enqueues — the terminal rule lives in
 * `reconcileByRecibo`, not here. The ceiling is that function's per-doc
 * `retries` counter, which every in-flight round advances by one, never
 * `payload.attempt`, which only paces the backoff. The exception is a round a
 * transient Firestore failure interrupted: it is not counted, so a doc whose
 * Firestore failure persists keeps this chain re-enqueuing with no cap, one
 * `consReciNFe` per round (#1654).
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
      scheduleAtMs:
        Date.now() +
        Math.max(nextConsultaDelayMs(nextAttempt), esperaMinimaDoRecibo(result.cStat) ?? 0),
    });
    return { ...result, reEnqueued: true, nextAttempt };
  }
  return { ...result, reEnqueued: false };
}
