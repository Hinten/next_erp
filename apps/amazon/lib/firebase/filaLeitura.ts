/**
 * The App Hosting COMPOSITION ROOT of this backend's three Cloud Tasks
 * producers: the reads queue (`filaLeituraAmazon`, the push receiver's), the
 * NF-e queue (`processAmazonNfeUpload`, since step 14, PR 14-d: the re-drive
 * route `POST /api/marketplace/amazon/enviar-nfe`'s) and the jobs queue
 * (`processAmazonListingsJob`, since step 12a, PR 12-c: the receiver's
 * `FEED_PROCESSING_FINISHED` wake-up). All three are bound to the real Cloud
 * Tasks transport through the file's ONE `getFunctions(` call
 * ({@link filaDoAppHosting}). Outside `lib/amazon` on purpose — it reads
 * `process.env` and calls `getFunctions(`, and `lib/amazon` does neither
 * (`estrutura.test.ts`, which also pins this file as one of the app's
 * `getFunctions(` roots, pinned to its queue set — its three path builders — by
 * `FILAS_DE_CADA_RAIZ`).
 *
 * - The region of ALL three queues: `AMAZON_TASKS_REGION`, then
 *   `FUNCTIONS_REGION`, NO default (`requireRegion` throws `MissingRegionError`;
 *   #1108). Read as STATIC `process.env.X` members, the shape the functions
 *   bundle needs too. Every queue lives in the functions codebase `amazon`, in
 *   ONE region. Without the region-qualified path the Admin SDK targets its own
 *   default region and the task is silently dropped.
 * - The queue valve, the SAME variable for all three: `AMAZON_TASKS_DISABLED`
 *   exactly `'1'` closes it. For the reads queue that is sweep-only mode (the
 *   receiver persists every delivery as `failed` for the reprocess sweep —
 *   never a silent drop). For the NF-e queue there is NO sweep: the re-drive
 *   route answers 503 `AMAZON_TAREFAS_DESLIGADAS` and enqueues nothing. For the
 *   jobs queue the receiver drops the wake-up with a WARNING: the feed's own
 *   poll chain still reads it. Anything else (`true`, ` 1`, blank) leaves it
 *   open.
 *
 * ⚠️ The enqueuing identity (the App Hosting runtime service account) needs
 * `roles/cloudtasks.enqueuer` on EACH queue and `roles/iam.serviceAccountUser`,
 * and each queue function's service `roles/run.invoker` for Cloud Tasks to
 * dispatch: window items W9 (step-3 plan §4; `functions/DEPLOY.md`), never
 * granted from here.
 */
import { requireRegion } from '@delfrance/core/region';
import { getFunctions } from 'firebase-admin/functions';

import {
  type AgendadorAmazon,
  caminhoDaFilaAmazon,
  criarAgendadorAmazon,
} from '../amazon/notificacoes/agendador';
import type { PayloadNotificacaoAmazon } from '../amazon/notificacoes/notificacao';
import {
  type AgendadorLotesAmazon,
  caminhoDaFilaLotesAmazon,
  criarAgendadorLotesAmazon,
} from '../amazon/feeds/agendadorLotes';
import type { TarefaLoteAmazon } from '../amazon/feeds/tarefaLote';
import {
  type AgendadorNfeAmazon,
  caminhoDaFilaNfeAmazon,
  criarAgendadorNfeAmazon,
} from '../amazon/nfe/agendadorNfe';
import type { TarefaNfeAmazon } from '../amazon/nfe/tarefaNfe';
import { getAdminApp } from './admin';

/**
 * The region of ALL three queues (the reads, NF-e and jobs queues), or
 * `MissingRegionError` (names only, no default).
 */
export function regiaoDaFilaLeituraAmazon(): string {
  return requireRegion({
    AMAZON_TASKS_REGION: process.env.AMAZON_TASKS_REGION,
    FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,
  });
}

/** Is the queue valve closed? Exactly `'1'`. */
function valvulaDasFilasFechada(): boolean {
  return process.env.AMAZON_TASKS_DISABLED === '1';
}

/** Is the sweep-only valve of the reads queue closed? Exactly `'1'`. */
export function filaLeituraDesligadaAmazon(): boolean {
  return valvulaDasFilasFechada();
}

/**
 * Is the NF-e queue's valve closed? The SAME variable as the reads queue's, with
 * NO sweep behind it: the re-drive route refuses (503) before it reads anything.
 */
export function filaNfeDesligadaAmazon(): boolean {
  return valvulaDasFilasFechada();
}

/**
 * Is the jobs queue's valve closed? The SAME variable as the other two queues'.
 * The receiver's wake-up is then dropped with a WARNING (nothing persisted): the
 * feed's own poll chain still reads its outcome.
 */
export function filaLotesDesligadaAmazon(): boolean {
  return valvulaDasFilasFechada();
}

/**
 * The Admin SDK's task queue at `caminho` — the file's ONE `getFunctions(`
 * call, shared by every producer; each hands in its own region-qualified path.
 */
function filaDoAppHosting<T>(caminho: string) {
  return getFunctions(getAdminApp()).taskQueue<T>(caminho);
}

/**
 * The receiver's producer: the valve read now, the queue resolved per enqueue
 * (so a region error rejects that enqueue instead of failing a module load).
 */
export function agendadorDaFilaLeituraAmazon(): AgendadorAmazon {
  return criarAgendadorAmazon({
    desligado: filaLeituraDesligadaAmazon(),
    fila: () =>
      filaDoAppHosting<PayloadNotificacaoAmazon>(caminhoDaFilaAmazon(regiaoDaFilaLeituraAmazon())),
  });
}

/**
 * The re-drive route's producer (step 14, PR 14-d): the valve read now, the
 * queue — and so the region — resolved per enqueue and never while the valve is
 * closed. The route enqueues UNNAMED, through `enfileirar` only (step-14 plan §3
 * decision 10: a Cloud Tasks tombstone on a name derived from the pedido would
 * refuse the next legitimate re-drive); the one named enqueue is the trigger's.
 */
export function agendadorDaFilaNfeAmazon(): AgendadorNfeAmazon {
  return criarAgendadorNfeAmazon({
    desligado: filaNfeDesligadaAmazon(),
    fila: () =>
      filaDoAppHosting<TarefaNfeAmazon>(caminhoDaFilaNfeAmazon(regiaoDaFilaLeituraAmazon())),
  });
}

/**
 * The receiver's SECOND producer (step 12a, PR 12-c): the jobs queue, for the
 * `FEED_PROCESSING_FINISHED` wake-up — ONE named enqueue per (seller, feed).
 * The valve read now, the queue — and so the region — resolved per enqueue and
 * never while the valve is closed.
 */
export function agendadorDaFilaLotesAmazon(): AgendadorLotesAmazon {
  return criarAgendadorLotesAmazon({
    desligado: filaLotesDesligadaAmazon(),
    fila: () =>
      filaDoAppHosting<TarefaLoteAmazon>(caminhoDaFilaLotesAmazon(regiaoDaFilaLeituraAmazon())),
  });
}
