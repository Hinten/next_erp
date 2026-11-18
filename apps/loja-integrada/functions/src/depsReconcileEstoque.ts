import { logger } from 'firebase-functions/v2';

import type { DepsReconcileEstoqueLi } from '../../lib/lojaIntegrada/estoque/reconcile/despachoReconcile';
import { criarAgendadorReconcileEstoqueLiDoAmbiente } from './agendador';

/**
 * The dependencies of one daily stock reconcile SLICE (master plan step 12, PR 12-g) — a
 * reads-queue task of `tipo: 'estoque-reconcile'` — bound to the runtime. The ONE place in this
 * codebase that binds them, so every slice of every run agrees about the environment, the clock
 * and the producer.
 *
 * - `ambiente`: the process environment, passed whole and LIVE: the stock valve and the cap are
 *   read from it. `lib/` never names the process environment (`estrutura.test.ts`).
 * - `agoraMs`: the one clock, in ms — the slice's budget (measured from `inicioMs`), the lease and
 *   every stamp of the run.
 * - `inicioMs`: when THIS slice began, stamped by the queue's handler as its FIRST statement.
 * - `agendador`: the producer ROOT, built only when an enqueue is due (the sweep-only valve is read
 *   when it is built), never at module load.
 * - `logger`: the slice's one sink (`firebase-functions/v2`), ids and counts only.
 * - `tentativa`: the Cloud Tasks attempt (0-based), for the last-attempt rule.
 */
export function depsDeReconcileEstoqueLi(registro: {
  readonly tentativa: number;
  readonly inicioMs: number;
}): DepsReconcileEstoqueLi {
  return {
    ambiente: process.env,
    agoraMs: () => Date.now(),
    inicioMs: registro.inicioMs,
    tentativa: registro.tentativa,
    agendador: criarAgendadorReconcileEstoqueLiDoAmbiente,
    logger,
  };
}
