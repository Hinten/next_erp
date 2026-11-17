import { FieldValue } from 'firebase-admin/firestore';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { loadAmazonContext } from '../../lib/amazon/core/contexto';
import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';
import { LWA_CLIENT_SECRET_ENV } from '../../lib/amazon/env';
import {
  type DepsProcessarEstoqueAmazon,
  type RegistroEstoqueAmazon,
  processarEstoqueAmazon,
} from '../../lib/amazon/estoque/processarEstoque';
import { sanitizarFalhaDaTarefaAmazon } from '../../lib/amazon/notificacoes/notificacao';
import { criarProdutorEstoqueAmazonDoAmbiente } from './agendadorEstoque';
import { getDb } from './lib/admin';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * The Secret Manager names the stock queue binds: the LWA client secret, read
 * by the context loader for a refresh once the read switch is on — the env
 * reader's own constant, so the binding and the read cannot drift apart.
 * Without it the forced refresh after a 401/403 (on `getListingsItem` or the
 * PATCH) could not run.
 *
 * ⚠️ A declared secret missing from Secret Manager fails the WHOLE deploy: it
 * is created before the functions deploy (`DEPLOY.md`).
 */
export const SEGREDOS_DO_ESTOQUE_AMAZON: readonly string[] = [LWA_CLIENT_SECRET_ENV];

/**
 * The attempts Cloud Tasks gives one stock task. The body counts none: every
 * retry it asks for (a transient read, a PATCH that may have landed, the task's
 * own budget, a refused 429 pause) re-reads both sides before it decides again,
 * and a task that runs out of attempts is backstopped by the next reconcile.
 */
export const TENTATIVAS_ESTOQUE_AMAZON = 5;

/**
 * The dependencies of ONE stock dispatch, bound to the runtime — the one place
 * this codebase binds them:
 *
 * - `db`: the codebase's Firestore handle (the NAMED database).
 * - `ambiente`: the process environment, WHOLE and live — the read switch
 *   (`AMAZON_CHAMADAS`), the LWA pair, the stock valve and canary
 *   (`AMAZON_MODO_ESTOQUE`, `AMAZON_CANARIO_ESTOQUE`), read per dispatch, never
 *   cached.
 * - `carregarContexto`: the context loader (`loadAmazonContext`, the read
 *   switch FIRST).
 * - `produtor`: the stock queue's producer for the task's OWN enqueues (the one
 *   read-back, named after Amazon's submission; the 429 pause, unnamed) — the
 *   functions codebase's stock root (`./agendadorEstoque`), built only when one
 *   is due.
 * - `increment`: a tier-0 `FieldValue` for the aviso counter.
 * - `logger`: the app's ONE logger. Never `firebase-functions`' logger, never
 *   `console.*`.
 */
export function depsDoEstoqueAmazon(registro: RegistroEstoqueAmazon): DepsProcessarEstoqueAmazon {
  return {
    db: getDb(),
    ambiente: process.env,
    agora: () => Date.now(),
    logger: LOGGER_STDOUT_AMAZON,
    increment: (by: number) => FieldValue.increment(by),
    carregarContexto: loadAmazonContext,
    produtor: criarProdutorEstoqueAmazonDoAmbiente,
    registro,
  };
}

/**
 * The Amazon STOCK queue (master plan step 12, PR 12-e1): ONE function — and so
 * ONE Cloud Tasks queue, auto-provisioned and named after it — for the
 * per-SKU availability PATCH. One task is one SKU of one conta, carrying
 * identities only: the quantity is computed when the task RUNS, from a fresh
 * read of the ERP, and compared with Amazon's live listing. Its producers, all
 * through the functions codebase's stock root (`./agendadorEstoque`): this
 * handler's own enqueues (the read-back, the 429 pause) and, as the stock flow
 * grows, the feed providers' per-SKU hand-offs (`./filaLotes`' seam root). The
 * body is `lib/amazon/estoque/processarEstoque.ts` (P0–P10).
 *
 * ⚠️ The export name IS the deployed function AND queue name, and it must equal
 * `FILA_ESTOQUE_AMAZON` — the producers target that string. `index.ts` asserts
 * the pair at module load; rename both together, or every enqueue targets a
 * queue that does not exist (a silent drop).
 *
 * Options, each one deliberate (`index.test.ts` pins every value):
 *
 * - `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 2 }`:
 *   ⚠️ `maxConcurrentDispatches: 1` is the ORDERING GUARD between one conta's
 *   patches. A PATCH body is an ABSOLUTE quantity and nothing stamps it with an
 *   event clock Amazon would compare, so two dispatches of one SKU (a delta
 *   and its read-back, two observations, a reconcile's) must never interleave
 *   their read and their PATCH: an older dispatch's PATCH could then land after
 *   a newer one's and stand. Concurrency 1 bounds DISPATCHES, not executions,
 *   which is why the body also checks its own budget right before the PATCH.
 *   Two dispatches per second stays under `getListingsItem`'s and
 *   `patchListingsItem`'s 5 rps.
 * - `retryConfig`: {@link TENTATIVAS_ESTOQUE_AMAZON} attempts, backing off
 *   10 s → 300 s with up to three doublings. A 429 is not a retry: the body
 *   re-enqueues the payload UNNAMED 60 s later and returns (and only when that
 *   re-enqueue is refused does it fall back to a retry: nothing was sent).
 * - `timeoutSeconds: 300`: the Amazon worst case of ONE dispatch is 160 s (an
 *   LWA refresh, `getListingsItem`, its forced refresh and the read again, the
 *   PATCH, its forced refresh and the PATCH again — each bounded by the
 *   package's `PRAZO_AMAZON_MS`); the Firestore reads before the PATCH are
 *   bounded by the body's own budget (`ORCAMENTO_ANTES_DO_PATCH_MS`, 200 s),
 *   which leaves the PATCH, its refresh and a second PATCH inside the timeout.
 *   `index.test.ts` reads both off the package and the body.
 * - `secrets`: {@link SEGREDOS_DO_ESTOQUE_AMAZON}.
 * - `...tasksInvokerOptions()`: `roles/run.invoker` on this service and
 *   `roles/cloudtasks.enqueuer` on its queue, from `TASKS_INVOKER_SA` — the
 *   codebase-wide list that names BOTH runtime SAs.
 *
 * The body writes the ONE `evento: 'estoque'` dispatch line on every end it
 * decides, its deliberate throws for the queue's retry included; this root
 * writes none. A throw leaves SANITIZED here: never a package error's message.
 *
 * D11: nothing calls Amazon before the window — the stock valve `off` reads
 * nothing, the context loader refuses unless `AMAZON_CHAMADAS` is exactly `on`,
 * and a PATCH also needs the stock valve `on` and a canary hit.
 */
// ⚠️ No type argument on the call: `tasks-invoker-inventory.test.js` discovers
// task functions by the call text, and the untyped call keeps `req.data` at
// `unknown`, which the body parses (P0) instead of trusting a cast.
export const processAmazonStockPatch = onTaskDispatched(
  {
    ...tasksInvokerOptions(),
    timeoutSeconds: 300,
    secrets: [...SEGREDOS_DO_ESTOQUE_AMAZON],
    retryConfig: {
      maxAttempts: TENTATIVAS_ESTOQUE_AMAZON,
      minBackoffSeconds: 10,
      maxBackoffSeconds: 300,
      maxDoublings: 3,
    },
    // ⚠️ The ordering guard between one conta's patches: an absolute PATCH
    // carries no clock Amazon compares.
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 2 },
  },
  async (req) => {
    const registro: RegistroEstoqueAmazon = {
      tentativa: req.retryCount ?? 0,
      idTarefa: req.id ?? null,
    };
    try {
      await processarEstoqueAmazon(req.data, depsDoEstoqueAmazon(registro));
    } catch (err) {
      // The queue's retry: a package error's message can carry a path with a
      // seller id, so it leaves through the app's sanitizing boundary.
      throw sanitizarFalhaDaTarefaAmazon(err);
    }
  },
);
