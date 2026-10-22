import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { TIPO_TAREFA_AMAZON } from '@delfrance/schemas';

import {
  LOGGER_STDOUT_AMAZON,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../../lib/amazon/core/log';
import {
  FILA_LEITURA_AMAZON,
  FLUXO_LEITURA_AMAZON,
  type ResultadoNotificacaoAmazon,
  type ResultadoTarefaAmazon,
  TASK_MAX_ATTEMPTS,
  camposDoRegistroDaTarefaAmazon,
  tratarTarefaLeituraAmazon,
} from '../../lib/amazon/notificacoes/notificacao';
import { SEGREDOS_DE_LEITURA_AMAZON, depsDeLeituraAmazon } from './depsLeitura';
import { getDb } from './lib/admin';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * The `detalhe` of a task whose `tipo` this queue does not serve: dropped, with
 * the dispatch's one log line as its only trace (nothing could ever process it,
 * so it must not spend retries or leave a row nobody will read). Firestore is
 * never touched for it.
 */
export const DETALHE_TIPO_DESCONHECIDO_AMAZON = 'tipo-desconhecido';

/**
 * The drops that are the pipeline WORKING — the conta is gone, or the order
 * belongs to a seller the conta no longer holds — and so log at INFO. Every
 * OTHER drop loses a notification that nothing will re-drive, with this line as
 * its only trace: `payload-invalido` (a producer/schema mismatch, which the
 * shared core drops with no row), `tipo-desconhecido` (a producer deployed
 * before its consumer), and any drop reason a later step adds until it is
 * listed here — fail loud.
 */
const DESCARTES_ESPERADOS_AMAZON: ReadonlySet<string> = new Set<ResultadoNotificacaoAmazon['kind']>(
  ['conta-inexistente', 'vendedor-mudou'],
);

/**
 * The dispatch line's severity, by whether a person has to look — not by
 * whether the run "failed". WARNING: `failed` (the hot sweep re-drives it),
 * `parked` (terminal: no sweep ever re-drives it) and every drop outside
 * {@link DESCARTES_ESPERADOS_AMAZON} (the notification is gone). INFO: `done`,
 * `deferred` (the deferred sweep re-drives it) and an expected drop. An alert
 * on WARNING must see the unrecoverable arms, not only the self-healing one.
 */
function severidadeDaTarefa(r: ResultadoTarefaAmazon): SeveridadeAmazon {
  switch (r.resultado) {
    case 'failed':
    case 'parked':
      return 'WARNING';
    case 'dropped':
      return r.detalhe !== null && DESCARTES_ESPERADOS_AMAZON.has(r.detalhe) ? 'INFO' : 'WARNING';
    case 'done':
    case 'deferred':
      return 'INFO';
  }
}

/**
 * One dispatch, by `tipo`, read off the RAW data by grammar
 * (`camposDoRegistroDaTarefaAmazon`: an own data property, never a getter, never
 * a cast). `pedido` runs one notification through the channel's pipeline (read
 * switch, routing, context, importer seam, disposition); any other `tipo` — a
 * payload with none, or one a later step will add (step 9's link job, step
 * 12a's feeds) — is dropped here.
 */
async function despachar(
  dados: unknown,
  tentativa: number,
  idTarefa: string | null,
): Promise<ResultadoTarefaAmazon> {
  if (camposDoRegistroDaTarefaAmazon(dados).tipo === TIPO_TAREFA_AMAZON.pedido) {
    return tratarTarefaLeituraAmazon(getDb(), dados, {
      ...depsDeLeituraAmazon(),
      registro: { fluxo: FLUXO_LEITURA_AMAZON.intake, tentativa, idTarefa },
    });
  }
  return {
    resultado: 'dropped',
    detalhe: DETALHE_TIPO_DESCONHECIDO_AMAZON,
    contaId: null,
    amazonOrderId: null,
    origem: null,
  };
}

/**
 * The Amazon READS queue (master plan step 3; step-3 plan §3 decision 19): ONE
 * function — and so ONE Cloud Tasks queue, auto-provisioned and named after it
 * — for every read task, dispatching on the task's `tipo`. Order intake today;
 * step 9's link job joins it later. The push receiver (App Hosting) enqueues
 * onto it now, the step-4 backstop poll from PR 4-b.
 *
 * ⚠️ The export name IS the deployed function AND queue name, and it must equal
 * `FILA_LEITURA_AMAZON` — the producers target that string. `index.ts` asserts
 * the pair at module load; rename both together, or every enqueue targets a
 * queue that does not exist (a silent drop).
 *
 * Options, each one deliberate:
 *
 * - `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 0.5 }`:
 *   `getOrder`'s documented rate (step 5's importer is its one caller here).
 *   ⚠️ A RATE inside this queue, NOT a mutual exclusion: the reprocess sweep
 *   (`index.ts`) re-drives rows through the same pipeline and importer INLINE,
 *   in its own service, concurrently with this queue — a deferred row of an
 *   order can run there while a new push or poll task for that order runs here.
 *   So step 5's importer still carries its own tier-2 watermark (root
 *   `CLAUDE.md` rule 7); this setting never stands in for it.
 * - `retryConfig`: `maxAttempts` IS `TASK_MAX_ATTEMPTS` — the pipeline persists
 *   instead of throwing on the attempt that constant calls last, so a queue that
 *   gave up earlier would drop the notification with no failure document, and
 *   one that gave up later would re-deliver a payload already recorded. Backoff
 *   10 s → 300 s with up to three doublings.
 * - `timeoutSeconds: 120`: one order import (an LWA refresh plus one SP-API
 *   read, each bounded at 20 s by the package). The whole ladder — 3 × 120 s plus
 *   2 backoffs of ≤ 300 s, 960 s — closes well inside the hot reprocess sweep's
 *   one-hour window (`index.test.ts` pins the arithmetic).
 * - `secrets: ['AMAZON_LWA_CLIENT_SECRET']`: the LWA refresh needs it once the
 *   read switch is on. ⚠️ A declared secret missing from Secret Manager fails
 *   the WHOLE deploy, so it is created before this one (window item W1).
 * - `...tasksInvokerOptions()`: `roles/run.invoker` on this service and
 *   `roles/cloudtasks.enqueuer` on its queue, applied at deploy time from
 *   `TASKS_INVOKER_SA` (#1133). Absent when unset.
 *
 * In step 3 a `pedido` run makes NO Amazon call: the read switch is off until
 * the window (it defers, before any Firestore read), and once on, the importer
 * seam is still empty (it defers as `importador-ausente`).
 */
// ⚠️ No type argument on the call: `tasks-invoker-inventory.test.js` discovers
// task functions by the call text, and the untyped call keeps `req.data` at
// `unknown`, which the body narrows by grammar instead of trusting a cast.
export const filaLeituraAmazon = onTaskDispatched(
  {
    ...tasksInvokerOptions(),
    timeoutSeconds: 120,
    secrets: [...SEGREDOS_DE_LEITURA_AMAZON],
    retryConfig: {
      maxAttempts: TASK_MAX_ATTEMPTS,
      minBackoffSeconds: 10,
      maxBackoffSeconds: 300,
      maxDoublings: 3,
    },
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 0.5 },
  },
  async (req) => {
    const dados: unknown = req.data;
    const tentativa = req.retryCount ?? 0;
    const idTarefa = req.id ?? null;
    const r = await despachar(dados, tentativa, idTarefa);
    // ONE line per dispatch (a transient failure that rethrows for the queue's
    // retry writes none: the runtime logs the throw, already sanitized by the
    // pipeline's boundary). The ids are read off the RAW data one by one, each
    // by grammar — never a spread of the data, and NEVER the seller id. A park,
    // a defer or a failure also writes its reason on the row; `detalhe` is set
    // only on the arms that leave no document.
    const campos = camposDoRegistroDaTarefaAmazon(dados);
    registrarEventoAmazon(
      LOGGER_STDOUT_AMAZON,
      'tarefa',
      severidadeDaTarefa(r),
      '[amazon] tarefa da fila de leitura',
      {
        fila: FILA_LEITURA_AMAZON,
        resultado: r.resultado,
        detalhe: r.detalhe,
        tipo: campos.tipo ?? null,
        origem: r.origem ?? campos.origem ?? null,
        amazonOrderId: r.amazonOrderId ?? campos.amazonOrderId ?? null,
        notificationId: campos.notificationId ?? null,
      },
      {
        conta: r.contaId ?? campos.contaId ?? null,
        fluxo: FLUXO_LEITURA_AMAZON.intake,
        tentativa,
        idTarefa,
      },
    );
  },
);
