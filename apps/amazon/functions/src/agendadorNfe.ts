import { requireRegion } from '@delfrance/core/region';
import { getFunctions } from 'firebase-admin/functions';

import {
  type AgendadorNfeAmazon,
  caminhoDaFilaNfeAmazon,
  criarAgendadorNfeAmazon,
} from '../../lib/amazon/nfe/agendadorNfe';
import type { TarefaNfeAmazon } from '../../lib/amazon/nfe/tarefaNfe';
import { getAdminApp } from './lib/admin';

/**
 * The COMPOSITION ROOT of the NF-e queue's producer for this functions
 * codebase (step 14, PR 14-c) — the app's THIRD `getFunctions(` caller, beside
 * `./agendador` (the reads queue, for the poll) and the App Hosting
 * `lib/firebase/filaLeitura.ts` (the reads queue for the receiver and, since PR
 * 14-d, this same NF-e queue for the re-drive route, behind its one call). The
 * trigger `onNfeAprovadaAmazon` enqueues through it, and so does the task
 * handler's self re-enqueue. What a rejection means, the one named enqueue and
 * the transient naming are the pure module's (`lib/amazon/nfe/agendadorNfe.ts`);
 * this file only reads the environment and binds the Admin SDK's task queue.
 *
 * ⚠️ A SEPARATE root on purpose, never a second export of `./agendador`: that
 * root's closure reaches `notificacoes/notificacao.ts` by value — the context,
 * the conta reads and the SP-API error classes — and the NF-e trigger runs on
 * EVERY `nfev4` write of the project, so its import closure is pinned file by
 * file to reach none of them (`estrutura.test.ts`, D11 by construction).
 * `estrutura.test.ts` also pins the app's four roots and the queue each one binds.
 *
 * The trigger makes it reachable from `src/index.ts`, so esbuild bundles it and
 * `tools/deploy-env/bundle-inlining.test.js` checks the region it inlines on
 * the BUILT bundle; the source-shape pin in `agendadorNfe.test.ts` stays as the
 * failure that names this file.
 */

/**
 * The NF-e queue's region: `AMAZON_TASKS_REGION`, else the `FUNCTIONS_REGION`
 * inlined into the bundle — the same pair as the reads queue, which lives in
 * the same codebase and region. NO default: an unset value throws
 * `MissingRegionError` on the enqueue rather than producing a well-formed path
 * to a queue that does not exist, which the Admin SDK resolves to its own
 * default region and silently drops (#1108). Blank counts as unset
 * (`requireRegion`), and `options.ts` already defaults the first candidate to
 * the inlined region.
 *
 * ⚠️ The argument MUST stay an object literal of STATIC `process.env.X` reads:
 * esbuild's `define` substitutes the member expression and nothing else, so a
 * computed argument leaves `FUNCTIONS_REGION` a live read that is `undefined`
 * after a deploy. `agendadorNfe.test.ts` pins the shape at the source.
 */
export function regiaoDaFilaNfeAmazon(): string {
  return requireRegion({
    AMAZON_TASKS_REGION: process.env.AMAZON_TASKS_REGION,
    FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,
  });
}

/**
 * The queue valve: EXACTLY `'1'` closes it — the SAME variable as the reads
 * queue's sweep-only valve, which here has NO sweep behind it (the trigger
 * raises `tarefas-desligadas` instead). Unset, blank, `'true'`, `'1 '` and
 * `' 1'` all leave enqueuing on — never trim or case-fold a valve.
 */
export function tarefasNfeAmazonDesligadas(): boolean {
  return process.env.AMAZON_TASKS_DISABLED === '1';
}

/**
 * The producer, from the environment. The valve is read ONCE, here; the queue —
 * and so the region — is resolved per enqueue, and never while the valve is
 * closed. The admin app is the codebase's singleton (`getAdminApp`).
 */
export function criarAgendadorNfeAmazonDoAmbiente(): AgendadorNfeAmazon {
  return criarAgendadorNfeAmazon({
    desligado: tarefasNfeAmazonDesligadas(),
    fila: () =>
      getFunctions(getAdminApp()).taskQueue<TarefaNfeAmazon>(
        caminhoDaFilaNfeAmazon(regiaoDaFilaNfeAmazon()),
      ),
  });
}
