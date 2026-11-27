import { logger } from 'firebase-functions/v2';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { TASK_MAX_ATTEMPTS } from '@delfrance/data/admin/notifications';
import { TIPO_TAREFA_PRECO_LI } from '@delfrance/schemas';

import { FILA_PRECO_LI } from '../../lib/lojaIntegrada/preco/agendadorPreco';
import {
  type ResultadoPrecoLi,
  processarTarefaPrecoLi,
} from '../../lib/lojaIntegrada/preco/processarPreco';
import { depsDePrecoLi } from './depsEscrita';
import { getDb } from './lib/admin';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * The `detail` of a task whose `tipo` this queue does not serve: dropped, with its one log line as
 * its only trace (nothing could ever process it, so it must not spend retries).
 */
export const DETALHE_TIPO_DESCONHECIDO_PRECO_LI = 'tipo-desconhecido';

/** The queue's ONE line per dispatch (header of {@link filaPrecoLojaIntegrada}). */
const LINHA_DA_TAREFA = '[loja-integrada] tarefa da fila de preço';

/** A record's own property, or `undefined` — never a cast, never a parse. */
function campo(dados: unknown, chave: string): unknown {
  if (typeof dados !== 'object' || dados === null || !Object.hasOwn(dados, chave)) {
    return undefined;
  }
  return Reflect.get(dados, chave);
}

/** One raw value off a task's data, for the log: a short string, else `null` (never an object). */
function campoBruto(dados: unknown, chave: string): string | null {
  const valor = campo(dados, chave);
  return typeof valor === 'string' && valor.length <= 128 ? valor : null;
}

/** The run's generation off the RAW data, for the log: `0` or `1`, else `null`. */
function geracaoBruta(dados: unknown): number | null {
  const valor = campo(dados, 'geracao');
  return valor === 0 || valor === 1 ? valor : null;
}

/** Whether the task may lower a price, off the RAW data, for the log: a boolean, else `null`. */
function baixarBruto(dados: unknown): boolean | null {
  const valor = campo(dados, 'baixar');
  return typeof valor === 'boolean' ? valor : null;
}

/**
 * The outcome's one detail for the line: the motivo, the follow-up, the status or the leaves a
 * refused lowering would have moved, else `null`. A kind added to the run stops this from
 * compiling until it is mapped.
 */
function detalheDoResultado(r: ResultadoPrecoLi): string | number | null {
  switch (r.kind) {
    case 'pulado':
    case 'descartado':
    case 'nao-enviado':
      return r.motivo;
    case 'escrito':
      return r.seguimento;
    case 'recusado':
      return r.status;
    case 'nao-baixado':
      return r.folhas.join(',');
    case 'payload-invalido':
    case 'desligado':
    case 'forma-invalida':
    case 'refletido':
    case 'escrito-lote':
      return null;
  }
}

/**
 * One dispatch, by `tipo`. `inicioDaTarefaMs` is the dispatch's own start, stamped before anything
 * else. The ids on the line are read off the RAW data, one by one, as short strings, numbers,
 * booleans or `null` — so they survive a payload the run refused — never a spread of the data. A
 * run that THROWS writes no line here: the queue retries it, and the platform logs the failure.
 */
async function despachar(
  dados: unknown,
  tentativa: number,
  idTarefa: string | null,
  inicioDaTarefaMs: number,
): Promise<void> {
  const comum = {
    fila: FILA_PRECO_LI,
    tipo: campoBruto(dados, 'tipo'),
    contaId: campoBruto(dados, 'contaId'),
    produtoId: campoBruto(dados, 'produtoId'),
    origem: campoBruto(dados, 'origem'),
    geracao: geracaoBruta(dados),
    baixar: baixarBruto(dados),
    tentativa,
  };

  if (campo(dados, 'tipo') === TIPO_TAREFA_PRECO_LI) {
    const r = await processarTarefaPrecoLi(
      getDb(),
      dados,
      depsDePrecoLi({ tentativa, idTarefa }, inicioDaTarefaMs),
    );
    logger.info(LINHA_DA_TAREFA, { ...comum, kind: r.kind, detail: detalheDoResultado(r) });
    return;
  }

  logger.info(LINHA_DA_TAREFA, {
    ...comum,
    kind: 'dropped',
    detail: DETALHE_TIPO_DESCONHECIDO_PRECO_LI,
  });
}

/**
 * The Loja Integrada PRICE queue (master plan step 13, PR 13-d): ONE function — and so ONE Cloud
 * Tasks queue, auto-provisioned and named after it — for the price send runs, dispatching on the
 * task's `tipo`:
 *
 *  - `preco`: ONE send run of one linked produto of one conta
 *    (`lib/lojaIntegrada/preco/processarPreco.ts`): the payload is ids only, parsed strict by the
 *    run, and the price is derived when the task RUNS — from the ERP at that moment and from a
 *    fresh deciding read of the store — never carried.
 *  - anything else: dropped, with one line.
 *
 * Why a queue of its own, and neither the writes queue (`./filaEscrita`) nor the stock queue
 * (`./filaEstoque`): a whole-catalogue reprice enqueues one task per produto, which on the writes
 * queue would hold the status write-back behind it for about a day, and on the stock queue would
 * hold every stock send — the one that keeps the store from selling what is gone — behind it just
 * as long. Each of the three write queues is single-file on its own; together they make at most
 * three writes in flight per store, each paced by the engine (the worst per store rises to 180
 * calls a minute, `core/ritmo.ts`).
 *
 * Its enqueuers: today the price trigger `onPrecoLojaIntegrada` (PR 13-e) and the send run ITSELF —
 * its one `deriva` follow-up after a read-back saw a drift — both through `./agendadorPreco`, under
 * the functions runtime SA. Later PRs of step 13 add the nightly reconcile's price queue phase
 * (functions runtime SA, through the same root; "Atualizar preços" only starts one such full
 * reconcile run, whose queue phase enqueues the sends under that SA), and the manual price push
 * `POST …/enviar-precos` (the App Hosting runtime SA) — an identity the one codebase-wide
 * `TASKS_INVOKER_SA` list already names.
 *
 * ⚠️ The export name IS the deployed function AND queue name, and it must equal `FILA_PRECO_LI` —
 * the producer targets that string. `index.ts` asserts the pair at module load; rename both
 * together, or every enqueue targets a queue that does not exist (a silent drop).
 *
 * Options — IDENTICAL to the stock queue's, for the same reasons (`index.test.ts` pins every one
 * AND their equality with `filaEstoqueLojaIntegrada`'s; no emulator honours them):
 *
 * - `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 }`: one send run at a time.
 * - `concurrency: 1`, `maxInstances: 1`: one instance serving one request. The queue limit counts
 *   DISPATCHES — an abandoned dispatch frees the slot while its handler may still run — and the
 *   instance limits NARROW that window; they do not close it. Two residuals remain: an abandoned
 *   dispatch still running when the next starts, and a rare duplicate delivery. Both write an
 *   ABSOLUTE price decided by their own fresh read of the ERP and of the store.
 * - `retryConfig`: `maxAttempts` IS `TASK_MAX_ATTEMPTS` (the run concludes a refused write on the
 *   attempt that constant calls last). A FLAT 300 s backoff: no write starts later than 260 s
 *   after a dispatch began, and a write is cut at 20 s, so a RETRY of the same task can only start
 *   after its abandoned attempt can no longer write.
 * - `timeoutSeconds: 300`: the worst run (`PIOR_EXECUCAO_PRECO_LI_MS`, 68 s, measured by the run's
 *   tests) fits with room to spare, and the write deadline (260 s) plus one write deadline (20 s)
 *   ends before the platform cuts the attempt.
 * - NO `secrets:`. The token lives per conta in Firestore.
 * - `...tasksInvokerOptions()`: `roles/run.invoker` on this service and `roles/cloudtasks.enqueuer`
 *   on its queue, applied at deploy time from `TASKS_INVOKER_SA` (#1133). Absent when unset.
 *
 * No Firestore write on a send run's success, and no failure store: a run that cannot finish
 * either THROWS (the queue retries, every attempt re-deriving from a fresh read) or DROPS with a
 * line. Until the window a run makes NO Loja Integrada call: the price valve is unset (`off`: the
 * run returns `desligado` before any read), and at `dry-run` or `on` the read switch — also unset —
 * stops the run at its write context, before any client exists (no call to the store before the
 * cutover).
 */
// ⚠️ No type argument on the call: `tasks-invoker-inventory.test.js` discovers
// task functions by the call text. `req.data` is narrowed to `unknown` instead.
export const filaPrecoLojaIntegrada = onTaskDispatched(
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
