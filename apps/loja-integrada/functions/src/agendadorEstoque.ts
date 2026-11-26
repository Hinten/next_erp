import { getFunctions } from 'firebase-admin/functions';

import type { TarefaFilaEstoqueLi } from '@delfrance/schemas';

import {
  type AgendadorEstoqueLi,
  FILA_ESTOQUE_LI,
  criarAgendadorEstoqueLi,
} from '../../lib/lojaIntegrada/estoque/agendadorEstoque';
import { regiaoDaFilaLi, tarefasLiDesligadas } from './agendador';
import { getAdminApp } from './lib/admin';

/**
 * The COMPOSITION ROOT of the STOCK-queue producer for this functions codebase (master plan
 * step 12, PR 12-e): the send run's one `deriva` follow-up, the stock trigger and its kit fan-out
 * (PR 12-f) and the daily reconcile's queue phase (PR 12-g) enqueue through it. The manual push
 * (PR 12-h) enqueues from App Hosting, through that backend's own root (`lib/firebase/filasLi.ts`). What a rejection means, the window, the task name and
 * the schedule are the pure module's (`lib/lojaIntegrada/estoque/agendadorEstoque.ts`); this
 * file only binds the Admin SDK's task queue, mapping the producer's `agendarParaMs` onto the
 * SDK's `scheduleTime`.
 *
 * The region and the sweep-only valve are read through the READS root's own readers
 * (`./agendador`), as the writes root does: ONE region for all four queues — each is created
 * with its function, by the same deploy, in `FUNCTIONS_REGION` — and one reader whose static
 * environment-read shape the bundle-inlining proof already covers. A second copy here would be a
 * second shape `define` must inline, and a second place to drift (#1108). This file reads no
 * environment variable itself.
 *
 * `LOJA_INTEGRADA_TASKS_DISABLED=1` closes this producer too: a run whose read-back saw a drift
 * then logs one WARNING and keeps its landed write, and the next event or the daily reconcile
 * re-covers the produto.
 */
export function criarAgendadorEstoqueLiDoAmbiente(): AgendadorEstoqueLi {
  return criarAgendadorEstoqueLi({
    fila: () =>
      getFunctions(getAdminApp()).taskQueue<TarefaFilaEstoqueLi>(
        `locations/${regiaoDaFilaLi()}/functions/${FILA_ESTOQUE_LI}`,
      ),
    desligado: tarefasLiDesligadas(),
  });
}
