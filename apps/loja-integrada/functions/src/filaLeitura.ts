import { logger } from 'firebase-functions/v2';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { TIPO_TAREFA_LI } from '@delfrance/schemas';

import {
  FILA_LEITURA_LI,
  type ResultadoTarefaLi,
  TASK_MAX_ATTEMPTS,
  camposDoRegistroDaTarefaLi,
  tratarTarefaLeituraLi,
} from '../../lib/lojaIntegrada/notificacoes/notificacao';
import { depsDeLeituraLi } from './depsLeitura';
import { getDb } from './lib/admin';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * The `detail` of a task whose `tipo` this queue does not serve: dropped, with
 * this log line as its only trace (nothing could ever process it, so it must not
 * spend retries or park a row nobody will read).
 */
export const DETALHE_TIPO_DESCONHECIDO_LI = 'tipo-desconhecido';

/**
 * The task's `tipo`, read off the RAW data: an own property, or `undefined`.
 * Never a cast and never a parse — the pipeline parses a `pedido` task itself,
 * and drops one that does not parse.
 */
function tipoDaTarefa(dados: unknown): unknown {
  if (typeof dados !== 'object' || dados === null || !Object.hasOwn(dados, 'tipo')) {
    return undefined;
  }
  return Reflect.get(dados, 'tipo');
}

/**
 * One dispatch, by `tipo`. `pedido` runs one notification through the channel's
 * pipeline (context, importer seam, disposition); any other `tipo` — a payload
 * with none, or one a later step will add — is dropped.
 */
async function despachar(
  dados: unknown,
  retryCount: number,
  idTarefa: string | null,
): Promise<ResultadoTarefaLi> {
  if (tipoDaTarefa(dados) === TIPO_TAREFA_LI.pedido) {
    return tratarTarefaLeituraLi(
      getDb(),
      dados,
      retryCount,
      depsDeLeituraLi({ fluxo: 'intake', tentativa: retryCount, idTarefa }),
    );
  }
  return { outcome: 'dropped', kind: null, detail: DETALHE_TIPO_DESCONHECIDO_LI };
}

/**
 * The Loja Integrada READS queue (master plan step 3): ONE function — and so
 * ONE Cloud Tasks queue, auto-provisioned and named after it — for every read
 * task, dispatching on the task's `tipo`. Order intake today; the import-job and
 * reconcile reads join it later. The order poller enqueues onto it now, the
 * inbound webhook from step 4.
 *
 * ⚠️ The export name IS the deployed function AND queue name, and it must equal
 * `FILA_LEITURA_LI` — the producer targets that string. `index.ts` asserts the
 * pair at module load; rename both together, or every enqueue targets a queue
 * that does not exist (a silent drop).
 *
 * Options, each one deliberate:
 *
 * - `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 }`:
 *   concurrency 1 is a CORRECTNESS property, not a knob. The pacer sleeps
 *   2 000 ms before every Loja Integrada call made through a context, so under
 *   concurrency 1 the queue makes at most 30 calls a minute across task
 *   boundaries with no shared state. A second concurrent dispatch would halve
 *   that guarantee.
 * - `retryConfig`: `maxAttempts` IS `TASK_MAX_ATTEMPTS` — the pipeline persists
 *   instead of throwing on the attempt that constant calls last, so a queue that
 *   gave up earlier would drop the notification with no failure document, and
 *   one that gave up later would re-deliver a payload already recorded. Backoff
 *   60 s → 300 s with one doubling: the platform's throttle window is
 *   undocumented, and at 60 s each retry lands in a fresh minute where 10 s
 *   would land all three inside one.
 * - `timeoutSeconds: 300`: one order import re-fetches through the paced
 *   client. The whole ladder — 3 × 300 s plus 2 backoffs of ≤ 300 s, 1 500 s —
 *   closes well inside the hot reprocess sweep's one-hour window
 *   (`index.test.ts` pins the arithmetic).
 * - NO `secrets:`. The Loja Integrada token lives per conta in Firestore, and a
 *   declared secret missing from Secret Manager fails the whole deploy.
 * - `...tasksInvokerOptions()`: `roles/run.invoker` on this service and
 *   `roles/cloudtasks.enqueuer` on its queue, applied at deploy time from
 *   `TASKS_INVOKER_SA` (#1133). Absent when unset.
 *
 * In step 3 a `pedido` run makes NO Loja Integrada call: the read switch is off
 * until the window (it defers), and once on, the importer seam is still empty
 * (it parks as `importador-ausente`).
 */
// ⚠️ No type argument on the call: `tasks-invoker-inventory.test.js` discovers
// task functions by the literal call text, which a `<T>` between the name and
// the parenthesis hides. `req.data` is narrowed to `unknown` in the body instead.
export const filaLeituraLojaIntegrada = onTaskDispatched(
  {
    ...tasksInvokerOptions(),
    timeoutSeconds: 300,
    retryConfig: {
      maxAttempts: TASK_MAX_ATTEMPTS,
      minBackoffSeconds: 60,
      maxBackoffSeconds: 300,
      maxDoublings: 1,
    },
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
  },
  async (req) => {
    const dados: unknown = req.data;
    const tentativa = req.retryCount ?? 0;
    const r = await despachar(dados, tentativa, req.id ?? null);
    // ONE line per dispatch (a transient failure that rethrows for the queue's
    // retry writes none: the runtime logs the throw). The ids are read off the
    // RAW data one by one, as short strings or `null` — never a spread of the
    // data, which no reviewer has vetted for what it may carry. `detail` is set
    // only on the arms that leave no document (`done`, `dropped`); a park, a
    // defer or a failure writes its reason on the row.
    const campos = camposDoRegistroDaTarefaLi(r, dados);
    logger.info('[loja-integrada] tarefa da fila de leitura', {
      fila: FILA_LEITURA_LI,
      ...campos,
      tentativa,
    });
  },
);
