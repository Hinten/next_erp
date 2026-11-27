import { getFunctions } from 'firebase-admin/functions';

import type { TarefaPrecoLi } from '@delfrance/schemas';

import {
  type AgendadorPrecoLi,
  FILA_PRECO_LI,
  criarAgendadorPrecoLi,
} from '../../lib/lojaIntegrada/preco/agendadorPreco';
import { regiaoDaFilaLi, tarefasLiDesligadas } from './agendador';
import { getAdminApp } from './lib/admin';

/**
 * The COMPOSITION ROOT of the PRICE-queue producer for this functions codebase (master plan
 * step 13, PR 13-d): today the price trigger (`./onPrecoLojaIntegrada`, PR 13-e) and the send
 * run's one `deriva` follow-up enqueue through it, both as the functions runtime SA; the nightly
 * reconcile's price queue phase (a later PR of step 13) will too — "Atualizar preços" included,
 * which only starts one full reconcile run and enqueues no send itself. Only the manual price
 * push will enqueue from App Hosting, through that backend's own root. What a rejection means, the window, the task name and the schedule are the pure module's
 * (`lib/lojaIntegrada/preco/agendadorPreco.ts`); this file only binds the Admin SDK's task queue,
 * mapping the producer's `agendarParaMs` onto the SDK's `scheduleTime`.
 *
 * The region and the sweep-only valve are read through the READS root's own readers
 * (`./agendador`), as the writes and stock roots do: ONE region for all four queues — each is
 * created with its function, by the same deploy, in `FUNCTIONS_REGION` — and one reader whose
 * static environment-read shape the bundle-inlining proof already covers. A second copy here would
 * be a second shape `define` must inline, and a second place to drift (#1108). This file reads no
 * environment variable itself.
 *
 * `LOJA_INTEGRADA_TASKS_DISABLED=1` closes this producer too: the trigger then logs one WARNING
 * and skips the event's remaining enqueues, and a run whose read-back saw a drift logs one WARNING
 * and keeps its landed write; the next event of the produto re-covers either.
 */
export function criarAgendadorPrecoLiDoAmbiente(): AgendadorPrecoLi {
  return criarAgendadorPrecoLi({
    fila: () =>
      getFunctions(getAdminApp()).taskQueue<TarefaPrecoLi>(
        `locations/${regiaoDaFilaLi()}/functions/${FILA_PRECO_LI}`,
      ),
    desligado: tarefasLiDesligadas(),
  });
}
