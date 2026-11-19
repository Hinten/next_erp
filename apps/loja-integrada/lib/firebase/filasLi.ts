/**
 * The App Hosting COMPOSITION ROOT of this backend's Cloud Tasks producers (master plan step 12,
 * PR 12-h — the first time this backend enqueues): the STOCK queue (`filaEstoqueLojaIntegrada`,
 * the manual push `POST …/enviar-estoque`) and the READS queue (`filaLeituraLojaIntegrada`, the
 * operator's reconcile `POST …/conta/[id]/estoque/reconciliar`, which enqueues a run's first
 * slice). Both are bound to the real Cloud Tasks transport through this file's ONE
 * `getFunctions(` call ({@link filaDoAppHosting}); the WRITES queue is never bound here
 * (`estrutura.test.ts` pins the queue set of every root). Outside `lib/lojaIntegrada` on purpose:
 * it reads `process.env`, which nothing under that folder may.
 *
 * - The region of both queues: `LOJA_INTEGRADA_TASKS_REGION`, then `FUNCTIONS_REGION`, NO default
 *   (`requireRegion` throws `MissingRegionError`; #1108), resolved PER ENQUEUE — and once more by
 *   each route before it reads anything ({@link regiaoDasFilasLiAppHosting}), so a missing region
 *   is a 500 with nothing read. Every queue lives in the functions codebase `loja-integrada`, in ONE
 *   region: the value here must EQUAL the `FUNCTIONS_REGION` that bundle was built with. Without the
 *   region-qualified path the Admin SDK targets its own default region and the task is silently
 *   dropped. Set in THIS backend's App Hosting console only, never as an `apphosting.yaml` row.
 * - The sweep-only valve, the SAME variable on both surfaces: `LOJA_INTEGRADA_TASKS_DISABLED`
 *   exactly `'1'` closes every producer here (the pure modules' one rule,
 *   `valvulaDeTarefasLiFechada`); both routes then answer 503 `LI_TAREFAS_DESLIGADAS` before any
 *   read. Anything else (`true`, ` 1`, blank) leaves it open.
 * - No `oidcToken` option: the Admin SDK stamps the ENQUEUER's own identity on the task.
 *
 * ⚠️ The enqueuing identity (this backend's runtime service account) needs
 * `roles/cloudtasks.enqueuer` on both queues, `roles/iam.serviceAccountUser` on ITSELF, and each
 * queue function's service `roles/run.invoker` for Cloud Tasks to dispatch — the deploy grants the
 * first and the last from `TASKS_INVOKER_SA`, which must therefore name this SA too
 * (`functions/DEPLOY.md`). Never granted from here.
 */
import { requireRegion } from '@delfrance/core/region';
import { getFunctions } from 'firebase-admin/functions';

import type { TarefaFilaEstoqueLi, TarefaReconcileEstoqueLi } from '@delfrance/schemas';

import {
  type AgendadorEstoqueLi,
  FILA_ESTOQUE_LI,
  criarAgendadorEstoqueLi,
} from '../lojaIntegrada/estoque/agendadorEstoque';
import {
  type AgendadorReconcileEstoqueLi,
  criarAgendadorReconcileEstoqueLi,
} from '../lojaIntegrada/estoque/reconcile/agendadorReconcile';
import {
  FILA_LEITURA_LI,
  valvulaDeTarefasLiFechada,
} from '../lojaIntegrada/notificacoes/agendador';
import { getAdminApp } from './admin';

/** The region of both queues, or `MissingRegionError` (names only, no default). */
export function regiaoDasFilasLiAppHosting(): string {
  return requireRegion({
    LOJA_INTEGRADA_TASKS_REGION: process.env.LOJA_INTEGRADA_TASKS_REGION,
    FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,
  });
}

/** Is the sweep-only valve closed on this backend? Exactly `'1'`. */
export function tarefasLiDesligadasNoAppHosting(): boolean {
  return valvulaDeTarefasLiFechada(process.env.LOJA_INTEGRADA_TASKS_DISABLED);
}

/**
 * The Admin SDK's task queue named `fila` in the queues' region — the file's ONE `getFunctions(`
 * call, shared by both producers.
 */
function filaDoAppHosting<T>(fila: string) {
  return getFunctions(getAdminApp()).taskQueue<T>(
    `locations/${regiaoDasFilasLiAppHosting()}/functions/${fila}`,
  );
}

/**
 * The manual push's producer: the valve read now, the queue — and so the region — resolved per
 * enqueue and never while the valve is closed.
 */
export function agendadorEstoqueLiDoAppHosting(): AgendadorEstoqueLi {
  return criarAgendadorEstoqueLi({
    fila: () => filaDoAppHosting<TarefaFilaEstoqueLi>(FILA_ESTOQUE_LI),
    desligado: tarefasLiDesligadasNoAppHosting(),
  });
}

/**
 * The operator reconcile's producer, on the READS queue: the valve read now, the queue resolved
 * per enqueue and never while the valve is closed.
 */
export function agendadorReconcileLiDoAppHosting(): AgendadorReconcileEstoqueLi {
  return criarAgendadorReconcileEstoqueLi({
    fila: () => filaDoAppHosting<TarefaReconcileEstoqueLi>(FILA_LEITURA_LI),
    desligado: tarefasLiDesligadasNoAppHosting(),
  });
}
