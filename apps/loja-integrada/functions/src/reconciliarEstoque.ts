import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { agendarReconcileEstoqueLi } from '../../lib/lojaIntegrada/estoque/reconcile/agendamentoReconcile';
import { criarAgendadorReconcileEstoqueLiDoAmbiente } from './agendador';

/**
 * The NIGHTLY start of the Loja Integrada daily stock reconcile (master plan step 12, PR 12-g).
 * At 04:23 São Paulo — a minute none of this codebase's other schedules fires at
 * (`index.test.ts` computes it) — it enqueues ONE named task, the run's first slice
 * (`estoque-reconcile-<AAAAMMDD>`, seq 0), onto the reads queue, and that is all it does
 * (`estoque/reconcile/agendamentoReconcile.ts`): it reads NO Firestore document and calls no Loja
 * Integrada endpoint. With the stock valve `off` it does nothing at all; the read switch is not
 * read (with it off, the run's ERP phase still rebuilds the snapshot and the kits map, and its
 * store phase stops at the switch). The run itself — one chain of time-boxed slices for every
 * conta — runs inside the reads queue (`./filaLeitura`).
 *
 * 60 s: one enqueue. `retryCount: 3`: a transient Cloud Tasks failure is rethrown, and Cloud
 * Scheduler's retry carries the SAME schedule time, so it names the same run and the same task
 * (an answered already-exists is success) — one hiccup does not cost a night.
 */
export const reconciliarEstoqueLojaIntegrada = onSchedule(
  {
    schedule: '23 4 * * *',
    timeZone: 'America/Sao_Paulo',
    timeoutSeconds: 60,
    retryCount: 3,
  },
  async (evento) => {
    await agendarReconcileEstoqueLi({
      ambiente: process.env,
      horaAgendada: evento.scheduleTime,
      agoraMs: () => Date.now(),
      agendador: criarAgendadorReconcileEstoqueLiDoAmbiente,
      logger,
    });
  },
);
