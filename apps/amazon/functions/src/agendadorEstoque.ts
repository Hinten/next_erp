import { requireRegion } from '@delfrance/core/region';
import { getFunctions } from 'firebase-admin/functions';

import {
  type AgendadorLotesAmazon,
  caminhoDaFilaLotesAmazon,
  criarAgendadorLotesAmazon,
} from '../../lib/amazon/feeds/agendadorLotes';
import type { TarefaLoteAmazon } from '../../lib/amazon/feeds/tarefaLote';
import { getAdminApp } from './lib/admin';

/**
 * The COMPOSITION ROOT of the stock flow's producers for this functions
 * codebase (step 12a, PR 12-c) — the app's FIFTH `getFunctions(` caller, beside
 * `./agendador` (the reads queue, for the poll), `./agendadorNfe` (the NF-e
 * queue), `./agendadorAgendamento` (the Easy Ship scheduling queue) and the App
 * Hosting `lib/firebase/filaLeitura.ts`. It binds the jobs queue
 * `processAmazonListingsJob`, whose consumers are the feed handlers' own
 * enqueues (the poll rungs, the uncertain wait, the recoveries, the waits of a
 * turned-away batch). What a rejection means, the name and the delay rules are
 * the pure module's (`lib/amazon/feeds/agendadorLotes.ts`); this file only
 * reads the environment and binds the Admin SDK's task queue.
 *
 * ⚠️ A SEPARATE root on purpose, never a builder in another root: each root's
 * closure is pinned with the queues it binds (`estrutura.test.ts`), and the
 * NF-e trigger's closure — which `./agendadorNfe` belongs to — must reach
 * nothing of the feed core.
 */

/**
 * The jobs queue's region: `AMAZON_TASKS_REGION`, else the `FUNCTIONS_REGION`
 * inlined into the bundle — the same pair as every other queue of this
 * codebase, which all live in one region. NO default: an unset value throws
 * `MissingRegionError` on the enqueue rather than producing a well-formed path
 * to a queue that does not exist, which the Admin SDK resolves to its own
 * default region and silently drops (#1108). Blank counts as unset
 * (`requireRegion`).
 *
 * ⚠️ The argument MUST stay an object literal of STATIC `process.env.X` reads:
 * esbuild's `define` substitutes the member expression and nothing else, so a
 * computed argument leaves `FUNCTIONS_REGION` a live read that is `undefined`
 * after a deploy. `agendadorEstoque.test.ts` pins the shape at the source.
 */
export function regiaoDaFilaLotesAmazon(): string {
  return requireRegion({
    AMAZON_TASKS_REGION: process.env.AMAZON_TASKS_REGION,
    FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,
  });
}

/**
 * The queue valve: EXACTLY `'1'` closes it — the SAME variable as every other
 * queue of this codebase. Unset, blank, `'true'`, `'1 '` and `' 1'` all leave
 * enqueuing on — never trim or case-fold a valve.
 */
export function tarefasLotesAmazonDesligadas(): boolean {
  return process.env.AMAZON_TASKS_DISABLED === '1';
}

/**
 * The jobs queue's producer, from the environment. The valve is read ONCE,
 * here; the queue — and so the region — is resolved per enqueue, and never
 * while the valve is closed. The admin app is the codebase's singleton
 * (`getAdminApp`).
 */
export function criarAgendadorLotesAmazonDoAmbiente(): AgendadorLotesAmazon {
  return criarAgendadorLotesAmazon({
    desligado: tarefasLotesAmazonDesligadas(),
    fila: () =>
      getFunctions(getAdminApp()).taskQueue<TarefaLoteAmazon>(
        caminhoDaFilaLotesAmazon(regiaoDaFilaLotesAmazon()),
      ),
  });
}
