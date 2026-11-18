import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';

import type { DepsReconcileEstoqueLi } from '../../lib/lojaIntegrada/estoque/reconcile/despachoReconcile';
import { criarAgendadorReconcileEstoqueLiDoAmbiente } from './agendador';

/**
 * The dependencies of one daily stock reconcile SLICE (master plan step 12, PR 12-g) — a
 * reads-queue task of `tipo: 'estoque-reconcile'` — bound to the runtime. The ONE place in this
 * codebase that binds them, so every slice of every run agrees about the environment, the clock
 * and the producer.
 *
 * - `ambiente`: the process environment, passed whole and LIVE: the stock valve, the cap, the store
 *   list's page size and — by the store phase's context loader, as its first act — the read switch
 *   are read from it. `lib/` never names the process environment (`estrutura.test.ts`).
 * - `agoraMs`: the one clock, in ms — the slice's budget (measured from `inicioMs`), the lease and
 *   every stamp of the run.
 * - `inicioMs`: when THIS slice began, stamped by the queue's handler as its FIRST statement.
 * - `esperar`: the pacer's sleep (2 000 ms before every Loja Integrada call of the store phase).
 * - `increment`: a tier-0 `FieldValue`, for the park's reconexão aviso (a 401/403 of the store
 *   phase parks the conta like every reader).
 * - `agendador`: the producer ROOT, built only when an enqueue is due (the sweep-only valve is read
 *   when it is built), never at module load.
 * - `logger`: the slice's one sink (`firebase-functions/v2`), ids and counts only.
 * - `tentativa`, `idTarefa`: the Cloud Tasks attempt (0-based) and the task id, for the last-attempt
 *   rule and the store calls' lines.
 *
 * No `fetch` seam: the package's client uses the runtime's own.
 */
export function depsDeReconcileEstoqueLi(registro: {
  readonly tentativa: number;
  readonly idTarefa: string | null;
  readonly inicioMs: number;
}): DepsReconcileEstoqueLi {
  return {
    ambiente: process.env,
    agoraMs: () => Date.now(),
    inicioMs: registro.inicioMs,
    tentativa: registro.tentativa,
    idTarefa: registro.idTarefa,
    esperar: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    increment: (by: number) => FieldValue.increment(by),
    agendador: criarAgendadorReconcileEstoqueLiDoAmbiente,
    logger,
  };
}
