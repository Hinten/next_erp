import { requireRegion } from '@delfrance/core/region';
import { getFunctions } from 'firebase-admin/functions';

import {
  type ProdutorEstoqueAmazon,
  caminhoDaFilaEstoqueAmazon,
  criarProdutorEstoqueAmazon,
} from '../../lib/amazon/estoque/produtorEstoque';
import type { TarefaEstoqueAmazon } from '../../lib/amazon/estoque/tarefaEstoque';
import {
  type AgendadorLotesAmazon,
  caminhoDaFilaLotesAmazon,
  criarAgendadorLotesAmazon,
} from '../../lib/amazon/feeds/agendadorLotes';
import type { TarefaLoteAmazon } from '../../lib/amazon/feeds/tarefaLote';
import { getAdminApp } from './lib/admin';

/**
 * The COMPOSITION ROOT of the stock flow's producers for this functions
 * codebase (step 12a, PR 12-c; step 12, PR 12-e1) — the app's FIFTH
 * `getFunctions(` caller, beside `./agendador` (the reads queue, for the poll),
 * `./agendadorNfe` (the NF-e queue), `./agendadorAgendamento` (the Easy Ship
 * scheduling queue) and the App Hosting `lib/firebase/filaLeitura.ts`. It binds
 * TWO queues behind its ONE `getFunctions(` call:
 *
 * - the jobs queue `processAmazonListingsJob`, whose consumers are the feed
 *   handlers' own enqueues (the poll rungs, the uncertain wait, the recoveries,
 *   the waits of a turned-away batch), the feed providers' and the reconcile
 *   pages' (`raiz`, bound by `./filaLotes`) and, since step 12, PR 12-f, the
 *   stock tick's delta feeds, reconcile starts, re-kicks and `vez` recoveries
 *   (`./sweepEstoque`)
 *   and the daily reconcile's run starts and adoption rungs
 *   (`./reconciliacaoEstoque`);
 * - the stock queue `processAmazonStockPatch`, whose consumers are the patch
 *   task's own enqueues (the read-back, the 429 pause, bound by
 *   `./filaEstoque`), the five-minute stock tick's per-SKU patch tasks (bound
 *   by `./sweepEstoque`, step 12, PR 12-e2) and the feed providers' and the
 *   reconcile's per-SKU hand-offs (the same `raiz`).
 *
 * What a rejection means, the names and the delay rules are the pure modules'
 * (`lib/amazon/feeds/agendadorLotes.ts`, `lib/amazon/estoque/produtorEstoque.ts`);
 * this file only reads the environment and binds the Admin SDK's task queues.
 *
 * ⚠️ A SEPARATE root on purpose, never a builder in another root: each root's
 * closure is pinned with the queues it binds (`estrutura.test.ts`), and the
 * NF-e trigger's closure — which `./agendadorNfe` belongs to — must reach
 * nothing of the feed core or of the stock flow.
 */

/**
 * The region of BOTH queues this root binds: `AMAZON_TASKS_REGION`, else the
 * `FUNCTIONS_REGION` inlined into the bundle — the same pair as every other
 * queue of this codebase, which all live in one region. NO default: an unset
 * value throws `MissingRegionError` on the enqueue rather than producing a
 * well-formed path to a queue that does not exist, which the Admin SDK resolves
 * to its own default region and silently drops (#1108). Blank counts as unset
 * (`requireRegion`).
 *
 * ⚠️ The argument MUST stay an object literal of STATIC `process.env.X` reads:
 * esbuild's `define` substitutes the member expression and nothing else, so a
 * computed argument leaves `FUNCTIONS_REGION` a live read that is `undefined`
 * after a deploy. `agendadorEstoque.test.ts` pins the shape at the source.
 */
export function regiaoDasFilasDoEstoqueAmazon(): string {
  return requireRegion({
    AMAZON_TASKS_REGION: process.env.AMAZON_TASKS_REGION,
    FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,
  });
}

/**
 * The queue valve: EXACTLY `'1'` closes it — the SAME variable as every other
 * queue of this codebase, read by both producers below. Unset, blank, `'true'`,
 * `'1 '` and `' 1'` all leave enqueuing on — never trim or case-fold a valve.
 */
export function tarefasDoEstoqueAmazonDesligadas(): boolean {
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
    desligado: tarefasDoEstoqueAmazonDesligadas(),
    fila: () =>
      filaDoAmbiente<TarefaLoteAmazon>(caminhoDaFilaLotesAmazon(regiaoDasFilasDoEstoqueAmazon())),
  });
}

/**
 * The stock queue's producer (step 12, PR 12-e1), from the environment: the
 * same valve read ONCE, the same lazily resolved region, the same admin app.
 */
export function criarProdutorEstoqueAmazonDoAmbiente(): ProdutorEstoqueAmazon {
  return criarProdutorEstoqueAmazon({
    desligado: tarefasDoEstoqueAmazonDesligadas(),
    fila: () =>
      filaDoAmbiente<TarefaEstoqueAmazon>(
        caminhoDaFilaEstoqueAmazon(regiaoDasFilasDoEstoqueAmazon()),
      ),
  });
}

/**
 * The Admin SDK's task queue at `caminho` — the file's ONE `getFunctions(`
 * call, which both producers resolve through, per enqueue.
 */
function filaDoAmbiente<T>(caminho: string) {
  return getFunctions(getAdminApp()).taskQueue<T>(caminho);
}
