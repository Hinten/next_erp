import { logger } from 'firebase-functions/v2';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import { TIPO_TAREFA_ESTOQUE_LI } from '@delfrance/schemas';

import { FILA_ESTOQUE_LI } from '../../lib/lojaIntegrada/estoque/agendadorEstoque';
import {
  type ResultadoEstoqueLi,
  processarTarefaEstoqueLi,
} from '../../lib/lojaIntegrada/estoque/processarEstoque';
import { depsDeEstoqueLi } from './depsEscrita';
import { getDb } from './lib/admin';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * The `detail` of a task whose `tipo` this queue does not serve: dropped, with its one log line as
 * its only trace (nothing could ever process it, so it must not spend retries).
 */
export const DETALHE_TIPO_DESCONHECIDO_ESTOQUE_LI = 'tipo-desconhecido';

/**
 * The `detail` of a kit fan-out task (`estoque-kits`): the queue's payload union already carries
 * the tipo, and its consumer ships with its producer (master plan step 12, PR 12-f). Until then
 * nothing enqueues one, and one that arrives is dropped with its line.
 */
export const DETALHE_SEM_CONSUMIDOR_ESTOQUE_LI = 'sem-consumidor';

/** The queue's ONE line per dispatch (header of {@link filaEstoqueLojaIntegrada}). */
const LINHA_DA_TAREFA = '[loja-integrada] tarefa da fila de estoque';

/**
 * The task's `tipo`, read off the RAW data: an own property, or `undefined`. Never a cast and
 * never a parse — the run parses an `estoque` task itself (strict) and returns
 * `payload-invalido` for one that does not parse.
 */
function tipoDaTarefa(dados: unknown): unknown {
  if (typeof dados !== 'object' || dados === null || !Object.hasOwn(dados, 'tipo')) {
    return undefined;
  }
  return Reflect.get(dados, 'tipo');
}

/** One raw value off a task's data, for the log: a short string, else `null` (never an object). */
function campoBruto(dados: unknown, chave: string): string | null {
  if (typeof dados !== 'object' || dados === null || !Object.hasOwn(dados, chave)) return null;
  const valor: unknown = Reflect.get(dados, chave);
  return typeof valor === 'string' && valor.length <= 128 ? valor : null;
}

/** The run's generation off the RAW data, for the log: `0` or `1`, else `null`. */
function geracaoBruta(dados: unknown): number | null {
  if (typeof dados !== 'object' || dados === null || !Object.hasOwn(dados, 'geracao')) return null;
  const valor: unknown = Reflect.get(dados, 'geracao');
  return valor === 0 || valor === 1 ? valor : null;
}

/** The outcome's one detail for the line: the motivo, the follow-up or the status, else `null`. */
function detalheDoResultado(r: ResultadoEstoqueLi): string | number | null {
  switch (r.kind) {
    case 'pulado':
    case 'descartado':
    case 'nao-enviado':
      return r.motivo;
    case 'escrito':
      return r.seguimento;
    case 'recusado':
      return r.status;
    case 'payload-invalido':
    case 'desligado':
    case 'teto-invalido':
    case 'refletido':
    case 'escrito-lote':
      return null;
  }
}

/**
 * One dispatch, by `tipo`. `inicioDaTarefaMs` is the dispatch's own start, stamped before anything
 * else. The ids on the line are read off the RAW data, one by one, as short strings or `null` —
 * so they survive a payload the run refused — never a spread of the data. A run that THROWS writes
 * no line here: the queue retries it, and the platform logs the failure.
 */
async function despachar(
  dados: unknown,
  tentativa: number,
  idTarefa: string | null,
  inicioDaTarefaMs: number,
): Promise<void> {
  const tipo = tipoDaTarefa(dados);
  const comum = {
    fila: FILA_ESTOQUE_LI,
    tipo: campoBruto(dados, 'tipo'),
    contaId: campoBruto(dados, 'contaId'),
    produtoId: campoBruto(dados, 'produtoId'),
    origem: campoBruto(dados, 'origem'),
    geracao: geracaoBruta(dados),
    tentativa,
  };

  if (tipo === TIPO_TAREFA_ESTOQUE_LI.estoque) {
    const r = await processarTarefaEstoqueLi(
      getDb(),
      dados,
      depsDeEstoqueLi({ tentativa, idTarefa }, inicioDaTarefaMs),
    );
    logger.info(LINHA_DA_TAREFA, { ...comum, kind: r.kind, detail: detalheDoResultado(r) });
    return;
  }

  const detail =
    tipo === TIPO_TAREFA_ESTOQUE_LI.estoqueKits
      ? DETALHE_SEM_CONSUMIDOR_ESTOQUE_LI
      : DETALHE_TIPO_DESCONHECIDO_ESTOQUE_LI;
  logger.info(LINHA_DA_TAREFA, { ...comum, kind: 'dropped', detail });
}

/**
 * The Loja Integrada STOCK queue (master plan step 12, PR 12-e): ONE function — and so ONE Cloud
 * Tasks queue, auto-provisioned and named after it — for the stock send runs, dispatching on the
 * task's `tipo`:
 *
 *  - `estoque`: ONE send run of one child produto of one conta
 *    (`lib/lojaIntegrada/estoque/processarEstoque.ts`): the payload is ids only, parsed strict by
 *    the run, and the quantity is derived when the task RUNS, never carried. Its producers: the
 *    run's own `deriva` follow-up (through `./agendadorEstoque`) today; the stock trigger, the
 *    reconcile and the manual push later.
 *  - `estoque-kits`: dropped with `sem-consumidor` until its consumer and producer ship together
 *    (PR 12-f).
 *  - anything else: dropped, with one line.
 *
 * Why a queue of its own, and not an arm of the writes queue (`./filaEscrita`): a full stock pass
 * enqueues one task per produto, and the status write-back must never wait behind it. Each queue
 * is single-file on its own; together they make at most two writes in flight per store, each
 * paced by the engine (the worst per store rises to 150 calls a minute, `core/ritmo.ts`).
 *
 * ⚠️ The export name IS the deployed function AND queue name, and it must equal `FILA_ESTOQUE_LI`
 * — the producer targets that string. `index.ts` asserts the pair at module load; rename both
 * together, or every enqueue targets a queue that does not exist (a silent drop).
 *
 * Options — IDENTICAL to the writes queue's, for the same reasons (`index.test.ts` pins every one
 * AND their equality with `filaEscritaLojaIntegrada`'s; no emulator honours them):
 *
 * - `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 }`: one send run at a time.
 * - `concurrency: 1`, `maxInstances: 1`: one instance serving one request. The queue limit counts
 *   DISPATCHES — an abandoned dispatch frees the slot while its handler may still run — and the
 *   instance limits NARROW that window; they do not close it. Two residuals remain: an abandoned
 *   dispatch still running when the next starts, and a rare duplicate delivery. Both write an
 *   ABSOLUTE quantity decided by their own fresh read, and both are bounded by the next event of
 *   the produto or the daily reconcile.
 * - `retryConfig`: `maxAttempts` IS `TASK_MAX_ATTEMPTS` (the run concludes a refused write on the
 *   attempt that constant calls last). A FLAT 300 s backoff: no write starts later than 260 s
 *   after a dispatch began, and a write is cut at 20 s, so a RETRY of the same task can only start
 *   after its abandoned attempt can no longer write.
 * - `timeoutSeconds: 300`: the worst run (`PIOR_EXECUCAO_ESTOQUE_LI_MS`, 68 s, measured by the
 *   run's tests) fits with room to spare, and the write deadline (260 s) plus one write deadline
 *   (20 s) ends before the platform cuts the attempt.
 * - NO `secrets:`. The token lives per conta in Firestore.
 * - `...tasksInvokerOptions()`: `roles/run.invoker` on this service and `roles/cloudtasks.enqueuer`
 *   on its queue, applied at deploy time from `TASKS_INVOKER_SA` (#1133). Its enqueuer today is
 *   the functions runtime SA (the `deriva` follow-up). Absent when unset.
 *
 * No Firestore write on success, and no failure store: a run that cannot finish either THROWS
 * (the queue retries, every attempt re-deriving from a fresh read) or DROPS with a line, and the
 * daily reconcile re-covers the produto. Until the window a run makes NO Loja Integrada call: the
 * stock valve is unset (`off`: the run returns `desligado` before any read), and at `dry-run` or
 * `on` the read switch — also unset — stops the run at its write context, before any client exists
 * (no call to the store before the cutover).
 */
// ⚠️ No type argument on the call: `tasks-invoker-inventory.test.js` discovers
// task functions by the call text. `req.data` is narrowed to `unknown` instead.
export const filaEstoqueLojaIntegrada = onTaskDispatched(
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
