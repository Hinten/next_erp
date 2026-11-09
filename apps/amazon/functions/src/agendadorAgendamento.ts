import { requireRegion } from '@delfrance/core/region';
import { getFunctions } from 'firebase-admin/functions';

import {
  type AgendadorAgendamentoAmazon,
  caminhoDaFilaAgendamentoAmazon,
  criarAgendadorAgendamentoAmazon,
} from '../../lib/amazon/agendamento/agendadorAgendamento';
import type { TarefaAgendamentoAmazon } from '../../lib/amazon/agendamento/tarefaAgendamento';
import { getAdminApp } from './lib/admin';

/**
 * The COMPOSITION ROOT of the Easy Ship scheduling queue's producer for this
 * functions codebase (step 15, PR 15-c) — the app's FOURTH `getFunctions(`
 * caller, beside `./agendador` (the reads queue, for the poll), `./agendadorNfe`
 * (the NF-e queue) and the App Hosting `lib/firebase/filaLeitura.ts`. Its
 * consumers: the NF-e task's acceptance seam (E1, bound by `./filaNfe`), the
 * order import (E2, bound by `./depsLeitura`) and the scheduling task's own
 * re-enqueues. What a rejection means, the one named enqueue and the transient
 * naming are the pure module's (`lib/amazon/agendamento/agendadorAgendamento.ts`);
 * this file only reads the environment and binds the Admin SDK's task queue.
 *
 * ⚠️ A SEPARATE root on purpose, never a second builder in `./agendadorNfe`:
 * that root is an entry of the NF-e trigger's EXACT D11 closure, pinned file by
 * file (`estrutura.test.ts`), and the trigger runs on EVERY `nfev4` write of the
 * project — one root per queue keeps that closure from growing (step-15 plan §3
 * decision 23). `estrutura.test.ts` also pins the four roots and the queue each
 * one binds.
 *
 * The NF-e queue makes it reachable from `src/index.ts`, so esbuild bundles it
 * and `tools/deploy-env/bundle-inlining.test.js` checks the region it inlines on
 * the BUILT bundle; the source-shape pin in `agendadorAgendamento.test.ts` stays
 * as the failure that names this file.
 */

/**
 * The scheduling queue's region: `AMAZON_TASKS_REGION`, else the
 * `FUNCTIONS_REGION` inlined into the bundle — the same pair as the reads and
 * NF-e queues, which live in the same codebase and region. NO default: an unset
 * value throws `MissingRegionError` on the enqueue rather than producing a
 * well-formed path to a queue that does not exist, which the Admin SDK resolves
 * to its own default region and silently drops (#1108). Blank counts as unset
 * (`requireRegion`), and `options.ts` already defaults the first candidate to
 * the inlined region.
 *
 * ⚠️ The argument MUST stay an object literal of STATIC `process.env.X` reads:
 * esbuild's `define` substitutes the member expression and nothing else, so a
 * computed argument leaves `FUNCTIONS_REGION` a live read that is `undefined`
 * after a deploy. `agendadorAgendamento.test.ts` pins the shape at the source.
 */
export function regiaoDaFilaAgendamentoAmazon(): string {
  return requireRegion({
    AMAZON_TASKS_REGION: process.env.AMAZON_TASKS_REGION,
    FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,
  });
}

/**
 * The queue valve: EXACTLY `'1'` closes it — the SAME variable as the reads
 * and NF-e queues' valve, which here has NO sweep behind it (the entries log a
 * WARNING and the checkout print schedules instead). Unset, blank, `'true'`,
 * `'1 '` and `' 1'` all leave enqueuing on — never trim or case-fold a valve.
 */
export function tarefasAgendamentoAmazonDesligadas(): boolean {
  return process.env.AMAZON_TASKS_DISABLED === '1';
}

/**
 * The producer, from the environment. The valve is read ONCE, here; the queue —
 * and so the region — is resolved per enqueue, and never while the valve is
 * closed. The admin app is the codebase's singleton (`getAdminApp`).
 */
export function criarAgendadorAgendamentoAmazonDoAmbiente(): AgendadorAgendamentoAmazon {
  return criarAgendadorAgendamentoAmazon({
    desligado: tarefasAgendamentoAmazonDesligadas(),
    fila: () =>
      getFunctions(getAdminApp()).taskQueue<TarefaAgendamentoAmazon>(
        caminhoDaFilaAgendamentoAmazon(regiaoDaFilaAgendamentoAmazon()),
      ),
  });
}
