/**
 * The App Hosting COMPOSITION ROOT of the reads queue (`filaLeituraAmazon`):
 * where the push receiver's producer is bound to the real Cloud Tasks
 * transport. Outside `lib/amazon` on purpose — it reads `process.env` and calls
 * `getFunctions(`, and `lib/amazon` does neither (`estrutura.test.ts`, which
 * also pins this file and the functions codebase's `functions/src/agendador.ts`
 * as the app's only `getFunctions(` callers).
 *
 * - The region: `AMAZON_TASKS_REGION`, then `FUNCTIONS_REGION`, NO default
 *   (`requireRegion` throws `MissingRegionError`; #1108). Read as STATIC
 *   `process.env.X` members, the shape the functions bundle needs too.
 *   Without the region-qualified path the Admin SDK targets its own default
 *   region and the task is silently dropped.
 * - The sweep-only valve: `AMAZON_TASKS_DISABLED` exactly `'1'` closes it; the
 *   receiver then persists every delivery as `failed` for the reprocess sweep
 *   (never a silent drop). Anything else (`true`, ` 1`, blank) leaves it open.
 *
 * ⚠️ The enqueuing identity (the App Hosting runtime service account) needs
 * `roles/cloudtasks.enqueuer` and `roles/iam.serviceAccountUser`, and the
 * queue function's service `roles/run.invoker` for Cloud Tasks to dispatch:
 * window items W9 (step-3 plan §4), never granted from here.
 */
import { requireRegion } from '@delfrance/core/region';
import { getFunctions } from 'firebase-admin/functions';

import {
  type AgendadorAmazon,
  caminhoDaFilaAmazon,
  criarAgendadorAmazon,
} from '../amazon/notificacoes/agendador';
import type { PayloadNotificacaoAmazon } from '../amazon/notificacoes/notificacao';
import { getAdminApp } from './admin';

/** The reads queue's region, or `MissingRegionError` (names only, no default). */
export function regiaoDaFilaLeituraAmazon(): string {
  return requireRegion({
    AMAZON_TASKS_REGION: process.env.AMAZON_TASKS_REGION,
    FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,
  });
}

/** Is the sweep-only valve closed? Exactly `'1'`. */
export function filaLeituraDesligadaAmazon(): boolean {
  return process.env.AMAZON_TASKS_DISABLED === '1';
}

/**
 * The receiver's producer: the valve read now, the queue resolved per enqueue
 * (so a region error rejects that enqueue instead of failing a module load).
 */
export function agendadorDaFilaLeituraAmazon(): AgendadorAmazon {
  return criarAgendadorAmazon({
    desligado: filaLeituraDesligadaAmazon(),
    fila: () =>
      getFunctions(getAdminApp()).taskQueue<PayloadNotificacaoAmazon>(
        caminhoDaFilaAmazon(regiaoDaFilaLeituraAmazon()),
      ),
  });
}
