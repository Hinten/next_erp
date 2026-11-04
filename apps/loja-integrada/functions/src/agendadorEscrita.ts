import { getFunctions } from 'firebase-admin/functions';

import {
  type AgendadorEscritaLi,
  type TarefaFilaEscritaLi,
  criarAgendadorEscritaLi,
} from '../../lib/lojaIntegrada/rastreio/agendadorEscrita';
import { FILA_ESCRITA_LI } from '../../lib/lojaIntegrada/rastreio/notificacaoEscrita';
import { regiaoDaFilaLi, tarefasLiDesligadas } from './agendador';
import { getAdminApp } from './lib/admin';

/**
 * The COMPOSITION ROOT of the WRITES-queue producer for this functions codebase
 * (master plan step 7, PR 7-e): the freight-history trigger enqueues one named
 * `rastreio` task per event through it, and the varredura scheduler one
 * `varredura` task per tick. What a rejection means, the task naming and the
 * already-exists rule are the pure module's
 * (`lib/lojaIntegrada/rastreio/agendadorEscrita.ts`); this file only binds the
 * Admin SDK's task queue.
 *
 * The region and the sweep-only valve are read through the READS root's own
 * readers (`./agendador`): ONE region for both queues — the queue is created
 * with its function, by the same deploy, in `FUNCTIONS_REGION` — and one reader
 * whose static environment-read shape the bundle-inlining proof already covers.
 * A second copy here would be a second shape `define` must inline, and a second
 * place to drift (#1108). This file reads no environment variable itself.
 *
 * `LOJA_INTEGRADA_TASKS_DISABLED=1` closes this producer too: every write event
 * is then persisted `failed` by its trigger, and the varredura cannot be
 * enqueued either, so nothing writes while tasks are off — the rows wait and do
 * not age.
 */
export function criarAgendadorEscritaLiDoAmbiente(): AgendadorEscritaLi {
  return criarAgendadorEscritaLi({
    fila: () =>
      getFunctions(getAdminApp()).taskQueue<TarefaFilaEscritaLi>(
        `locations/${regiaoDaFilaLi()}/functions/${FILA_ESCRITA_LI}`,
      ),
    desligado: tarefasLiDesligadas(),
  });
}
