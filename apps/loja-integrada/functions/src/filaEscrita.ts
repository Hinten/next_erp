import { logger } from 'firebase-functions/v2';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import { TIPO_TAREFA_ESCRITA_LI } from '@delfrance/schemas';

import { TIPO_TAREFA_VARREDURA_ESCRITA_LI } from '../../lib/lojaIntegrada/rastreio/agendadorEscrita';
import {
  FILA_ESCRITA_LI,
  tratarTarefaEscritaLi,
  varrerEscritasLi,
} from '../../lib/lojaIntegrada/rastreio/notificacaoEscrita';
import { depsDeEscritaLi } from './depsEscrita';
import { getDb } from './lib/admin';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * The `detail` of a task whose `tipo` this queue does not serve: dropped, with
 * its one log line as its only trace (nothing could ever process it, so it must
 * not spend retries or park a row nobody will read).
 */
export const DETALHE_TIPO_DESCONHECIDO_ESCRITA_LI = 'tipo-desconhecido';

/**
 * How long one varredura dispatch keeps taking rows, in ms. A row it starts just
 * inside this budget still finishes within the function's 300 s: the worst
 * single run is 134 s (a refused tracking code, then the situação from a second
 * deciding read — `PIOR_EXECUCAO_RASTREIO_LI_MS`, measured on the flow's real
 * call and wait sequence), and 140 + 134 = 274 ≤ 300. `index.test.ts` pins the
 * sum. Every row it re-runs shares the dispatch's start for the write deadline.
 */
export const VARREDURA_ESCRITA_ORCAMENTO_MS = 140_000;

/**
 * The task's `tipo`, read off the RAW data: an own property, or `undefined`.
 * Never a cast and never a parse — the pipeline parses a `rastreio` task itself
 * and drops one that does not parse; a `varredura` carries nothing else.
 */
function tipoDaTarefa(dados: unknown): unknown {
  if (typeof dados !== 'object' || dados === null || !Object.hasOwn(dados, 'tipo')) {
    return undefined;
  }
  return Reflect.get(dados, 'tipo');
}

/** One raw id off a task's data, for the log: a short string, else `null` (never an object). */
function campoBruto(dados: unknown, chave: string): string | null {
  if (typeof dados !== 'object' || dados === null || !Object.hasOwn(dados, chave)) return null;
  const valor: unknown = Reflect.get(dados, chave);
  return typeof valor === 'string' && valor.length <= 128 ? valor : null;
}

/**
 * The writes queue's ONE line per dispatch. The ids are read off the RAW data —
 * so they survive a payload the schema dropped — one by one, as short strings
 * or `null`: never a spread of the data, which no reviewer vetted for what it
 * may carry. The reasons of a park, a defer or a failure are on the row.
 */
const LINHA_DA_TAREFA = '[loja-integrada] tarefa da fila de escritas';

/**
 * One dispatch, by `tipo` (header of {@link filaEscritaLojaIntegrada}).
 * `inicioDaTarefaMs` is the dispatch's own start, stamped before anything else.
 */
async function despachar(
  dados: unknown,
  tentativa: number,
  idTarefa: string | null,
  inicioDaTarefaMs: number,
): Promise<void> {
  const tipo = tipoDaTarefa(dados);
  const comum = { fila: FILA_ESCRITA_LI, tipo: campoBruto(dados, 'tipo') };

  if (tipo === TIPO_TAREFA_ESCRITA_LI.rastreio) {
    const r = await tratarTarefaEscritaLi(
      getDb(),
      dados,
      tentativa,
      depsDeEscritaLi({ tentativa, idTarefa }, inicioDaTarefaMs),
    );
    logger.info(LINHA_DA_TAREFA, {
      ...comum,
      outcome: r.outcome,
      kind: r.kind,
      detail: null,
      contaId: campoBruto(dados, 'contaId'),
      numero: campoBruto(dados, 'numero'),
      evento: campoBruto(dados, 'evento'),
      tentativa,
    });
    return;
  }

  if (tipo === TIPO_TAREFA_VARREDURA_ESCRITA_LI) {
    // The rows a varredura re-runs are not this task: no attempt number of
    // their own, and every one of them shares this dispatch's start.
    const r = await varrerEscritasLi(
      getDb(),
      depsDeEscritaLi({ tentativa: null, idTarefa }, inicioDaTarefaMs),
      VARREDURA_ESCRITA_ORCAMENTO_MS,
    );
    logger.info(LINHA_DA_TAREFA, {
      ...comum,
      desligado: r.desligado,
      quente: r.quente,
      adiada: r.adiada,
      tentativa,
    });
    return;
  }

  logger.info(LINHA_DA_TAREFA, {
    ...comum,
    outcome: 'dropped',
    kind: null,
    detail: DETALHE_TIPO_DESCONHECIDO_ESCRITA_LI,
    contaId: campoBruto(dados, 'contaId'),
    numero: campoBruto(dados, 'numero'),
    evento: campoBruto(dados, 'evento'),
    tentativa,
  });
}

/**
 * The Loja Integrada WRITES queue (master plan step 7, PR 7-e): ONE function —
 * and so ONE Cloud Tasks queue, auto-provisioned and named after it — for every
 * write this channel makes to Loja Integrada, dispatching on the task's `tipo`:
 *
 *  - `rastreio`: one freight event of one pedido (posted, delivered, awaiting
 *    pickup) written back to its Loja Integrada order, through the shared
 *    pipeline (`lib/lojaIntegrada/rastreio/notificacaoEscrita.ts`). Its producer
 *    is the freight-history trigger (`./onHistoricoFreteLojaIntegrada`).
 *  - `varredura`: the failure store's two lanes, run INSIDE this queue's single
 *    dispatch slot (`varrerEscritasLi`), enqueued by `./varrerEscritas` every
 *    30 minutes. The shared sweep runs `process` inline, so running it anywhere
 *    else would put a second writer beside this queue — a retry could then move
 *    a delivered order back to "enviado" and e-mail the buyer after "entregue".
 *  - anything else: dropped, with one line.
 *
 * Later write kinds (stock, price, the catalogue) join THIS queue, so every
 * write of the channel stays single-file.
 *
 * ⚠️ The export name IS the deployed function AND queue name, and it must equal
 * `FILA_ESCRITA_LI` — the producer targets that string. `index.ts` asserts the
 * pair at module load; rename both together, or every enqueue targets a queue
 * that does not exist (a silent drop).
 *
 * Options, each one deliberate (rule 7 of the status write-back rests on them,
 * and `index.test.ts` pins every one — no emulator honours them):
 *
 * - `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 }`: one
 *   write task at a time, its sweep included. With the engine's pacer (2 000 ms
 *   per call on average) the queue makes at most 30 calls a minute.
 * - `concurrency: 1`, `maxInstances: 1`: one instance serving one request. The
 *   queue limit counts DISPATCHES — an abandoned dispatch (a reset connection)
 *   frees the slot while its handler may still run — and the instance limits
 *   NARROW that window; they do not close it. Two residuals remain: an
 *   abandoned dispatch whose handler is still running when the next one starts
 *   (should the platform also free the instance's request slot once the caller
 *   is gone), and a rare duplicate delivery by Cloud Tasks. Both are logged as
 *   `escrita-duplicada` by the situação history check that follows a write.
 * - `retryConfig`: `maxAttempts` IS `TASK_MAX_ATTEMPTS` (the pipeline persists
 *   on the attempt that constant calls last). A FLAT 300 s backoff (+5, then
 *   +10 minutes): no write starts later than 260 s after a dispatch began, and a
 *   write is cut at 20 s, so a RETRY of the same task can only start after its
 *   abandoned attempt can no longer write. The whole ladder,
 *   3 × 300 + 2 × 300 = 1 500 s, closes inside the hot sweep's one-hour window.
 * - `timeoutSeconds: 300`: the varredura's 140 s budget plus the worst single
 *   run (`PIOR_EXECUCAO_RASTREIO_LI_MS`, 134 s, measured by the flow's tests)
 *   fits.
 * - NO `secrets:`. The token lives per conta in Firestore.
 * - `...tasksInvokerOptions()`: `roles/run.invoker` on this service and
 *   `roles/cloudtasks.enqueuer` on its queue, applied at deploy time from
 *   `TASKS_INVOKER_SA` (#1133). Its enqueuers are the trigger and the scheduler,
 *   both the functions runtime SA. Absent when unset.
 *
 * Until the window a run makes NO Loja Integrada call: the write valve is unset
 * (`off`: the run defers before any read, and the varredura touches neither
 * lane), and at `dry-run` or `on` the read switch — also unset — stops the run
 * at its write context, before any client exists (D17).
 */
// ⚠️ No type argument on the call: `tasks-invoker-inventory.test.js` discovers
// task functions by the call text. `req.data` is narrowed to `unknown` instead.
export const filaEscritaLojaIntegrada = onTaskDispatched(
  {
    ...tasksInvokerOptions(),
    timeoutSeconds: 300,
    concurrency: 1,
    maxInstances: 1,
    retryConfig: {
      maxAttempts: TASK_MAX_ATTEMPTS,
      minBackoffSeconds: 300,
      maxBackoffSeconds: 300,
      maxDoublings: 0,
    },
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
  },
  async (req) => {
    // FIRST: the write deadline is measured from here.
    const inicioDaTarefaMs = Date.now();
    const dados: unknown = req.data;
    await despachar(dados, req.retryCount ?? 0, req.id ?? null, inicioDaTarefaMs);
  },
);
