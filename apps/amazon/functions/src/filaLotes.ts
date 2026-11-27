import { randomUUID } from 'node:crypto';

import { FieldValue } from 'firebase-admin/firestore';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { loadAmazonContext } from '../../lib/amazon/core/contexto';
import { LOGGER_STDOUT_AMAZON } from '../../lib/amazon/core/log';
import { type AmbienteAmazon, LWA_CLIENT_SECRET_ENV } from '../../lib/amazon/env';
import { processarPaginaReconciliacaoEstoqueAmazon } from '../../lib/amazon/estoque/reconciliacaoEstoque';
import {
  DESTINO_LOTE_AMAZON,
  type ProvedoresLoteAmazon,
  type RaizLoteAmazon,
  vincularDestinosLoteAmazon,
} from '../../lib/amazon/feeds/destinosLote';
import type { RegistroLoteAmazon } from '../../lib/amazon/feeds/incertoFeed';
import {
  type DepsProcessarLoteAmazon,
  type ProcessadorPaginaPrecoAmazon,
  type ProcessadorPaginaReconciliacaoAmazon,
  type ProcessadorTarefaPrecoSkuAmazon,
  processarLoteAmazon,
} from '../../lib/amazon/feeds/processarLote';
import { sanitizarFalhaDaTarefaAmazon } from '../../lib/amazon/notificacoes/notificacao';
import { paginaPrecoAmazon } from '../../lib/amazon/preco/execucaoPreco';
import {
  processarPrecoSkuAmazon,
  soValidacaoDoDespachoPrecoAmazon,
} from '../../lib/amazon/preco/processarPreco';
import {
  criarAgendadorLotesAmazonDoAmbiente,
  criarProdutorEstoqueAmazonDoAmbiente,
  criarProdutorExecucaoPrecoAmazonDoAmbiente,
  criarProdutorPrecoAmazonDoAmbiente,
} from './agendadorEstoque';
import { getDb } from './lib/admin';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * The Secret Manager names the jobs queue binds: the LWA client secret, read by
 * the context loader for a refresh once the read switch is on — the env
 * reader's own constant, so the binding and the read cannot drift apart.
 * Without it the forced refresh after a 401/403 (on `createFeedDocument`,
 * `createFeed`, `getFeed` or `getFeedDocument`) could not run.
 *
 * ⚠️ A declared secret missing from Secret Manager fails the WHOLE deploy: it
 * is created before the functions deploy (`DEPLOY.md`).
 */
export const SEGREDOS_DOS_LOTES_AMAZON: readonly string[] = [LWA_CLIENT_SECRET_ENV];

/**
 * The attempts Cloud Tasks gives one feed task. No handler counts them: every
 * step a handler takes before a failure is idempotent (named enqueues, tier-1
 * writes, a successor rung enqueued first), so a retry re-runs it, and the
 * chains outlive the last attempt — a poll rung's successor is already durable,
 * a recovery's backstop is the next daily reconcile.
 */
export const TENTATIVAS_LOTE_AMAZON = 5;

/** A real sleep of `ms` milliseconds: the stock builds' pacing between two Amazon calls. */
export function esperarMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A fresh run id (a UUID: inside the stock documents' id grammar). */
export function novoExecucaoIdAmazon(): string {
  return randomUUID();
}

/** `FieldValue.increment(by)`: the aviso counter. */
export function incrementoAmazon(by: number): unknown {
  return FieldValue.increment(by);
}

/** The process environment, WHOLE and live, read when called: a provider's valve. */
export function ambienteDoProcessoAmazon(): AmbienteAmazon {
  return process.env;
}

/**
 * What a provider factory of the seam receives (`RaizLoteAmazon`): the stock
 * root's TWO producers, as thunks — the jobs queue's (a recovery's
 * `feed-enviar`, a reconcile hand-off) and the stock queue's (one patch task
 * per SKU handed to the per-SKU path); neither is built here, a provider
 * builds one only when it enqueues — plus the real sleep of a build's pacing,
 * the aviso counter, a fresh run id for a reconcile a provider requests, and
 * the environment (a thunk too) a provider's recovery reads the valve from.
 */
export const RAIZ_DOS_LOTES_AMAZON: RaizLoteAmazon = {
  agendadorLotes: criarAgendadorLotesAmazonDoAmbiente,
  produtorEstoque: criarProdutorEstoqueAmazonDoAmbiente,
  esperar: esperarMs,
  increment: incrementoAmazon,
  gerarExecucaoId: novoExecucaoIdAmazon,
  ambiente: ambienteDoProcessoAmazon,
};

/**
 * The seam table BOUND, ONCE per process (`lib/amazon/feeds/destinosLote.ts`):
 * each non-null factory called exactly once with {@link RAIZ_DOS_LOTES_AMAZON},
 * at module load, and every dispatch reads these same rows. The stock row is
 * filled (PR 12-f); the price row stays `null` until step 13.
 */
export const PROVEDORES_DOS_LOTES_AMAZON: ProvedoresLoteAmazon = vincularDestinosLoteAmazon(
  RAIZ_DOS_LOTES_AMAZON,
  DESTINO_LOTE_AMAZON,
);

/**
 * The stock reconcile's page (step 12, PR 12-f), BOUND: the dispatch's own
 * deps handed through, plus what only the page needs — the stock queue's
 * producer from the stock root (a THUNK: a page that enqueues no patch builds
 * none), a real sleep for its Amazon pacing, and a fresh run id for the next
 * run its close may start. The dispatcher imports no fluxo's module; this root
 * is where the jobs queue meets the stock flow.
 */
export const PAGINA_RECONCILIACAO_AMAZON: ProcessadorPaginaReconciliacaoAmazon = (
  db,
  tarefa,
  deps,
) =>
  processarPaginaReconciliacaoEstoqueAmazon(db, tarefa, {
    ...deps,
    produtorEstoque: criarProdutorEstoqueAmazonDoAmbiente,
    esperar: esperarMs,
    gerarExecucaoId: novoExecucaoIdAmazon,
  });

/**
 * The price task (step 13, PR 13-d), BOUND: ONE `preco-sku` dispatch of THIS
 * queue, the dispatch's own deps handed through, plus what only the task
 * needs — the context loader, the price producer from the stock root (a
 * THUNK, onto this queue's own path: a task that enqueues nothing builds
 * none) and the preview flag, read from the dispatch's own environment
 * (`soValidacaoDoDespachoPrecoAmazon`: exactly `1`, else off with a WARNING
 * when set). Price rides this function: no new queue, root or grant.
 */
export const TAREFA_PRECO_SKU_AMAZON: ProcessadorTarefaPrecoSkuAmazon = (db, tarefa, deps) =>
  processarPrecoSkuAmazon(tarefa, {
    db,
    ambiente: deps.ambiente,
    agora: deps.agora,
    logger: deps.logger,
    increment: deps.increment,
    carregarContexto: loadAmazonContext,
    produtor: criarProdutorPrecoAmazonDoAmbiente,
    soValidacao: soValidacaoDoDespachoPrecoAmazon(deps.ambiente, deps.logger, deps.registro),
    registro: deps.registro,
    fetch: deps.fetch,
    gerarCorrelationId: deps.gerarCorrelationId,
  });

/**
 * A price run's page (step 13, PR 13-e), BOUND: ONE `preco-pagina` dispatch of
 * THIS queue, the dispatch's own deps handed through, plus what only the page
 * needs — the context loader, the page producer and the price task's producer
 * from the stock root (THUNKS, onto this queue's own path), the preview flag
 * read from the dispatch's own environment (the price task's one reader), and
 * a real sleep for the live read's pacing. No new queue, root or grant.
 */
export const PAGINA_PRECO_AMAZON: ProcessadorPaginaPrecoAmazon = (db, tarefa, deps) =>
  paginaPrecoAmazon(db, tarefa, {
    ambiente: deps.ambiente,
    agora: deps.agora,
    logger: deps.logger,
    increment: deps.increment,
    registro: deps.registro,
    fetch: deps.fetch,
    gerarCorrelationId: deps.gerarCorrelationId,
    carregarContexto: loadAmazonContext,
    produtorPaginas: criarProdutorExecucaoPrecoAmazonDoAmbiente,
    produtorPreco: criarProdutorPrecoAmazonDoAmbiente,
    soValidacao: soValidacaoDoDespachoPrecoAmazon(deps.ambiente, deps.logger, deps.registro),
    esperar: esperarMs,
  });

/**
 * The dependencies of ONE jobs-queue dispatch, bound to the runtime — the one
 * place this codebase binds them:
 *
 * - `ambiente`: the process environment, WHOLE and live — the read switch
 *   (`AMAZON_CHAMADAS`), the LWA pair, each batch fluxo's valve and canary,
 *   read per dispatch, never cached.
 * - `agendador`: the jobs queue's producer for the handlers' OWN enqueues (the
 *   poll rungs, the uncertain wait, the recoveries, a turned-away batch's wait)
 *   — the functions codebase's stock root (`./agendadorEstoque`), built only
 *   when one is due.
 * - `provedores`: the seam's rows, BOUND once per process
 *   ({@link PROVEDORES_DOS_LOTES_AMAZON}): the stock row since PR 12-f, the
 *   price row empty until step 13.
 * - `fetch`: the global one, read at CALL time, handed to the context, the
 *   write client and both document transfers alike (the package never defaults
 *   it).
 * - `increment`: a tier-0 `FieldValue` for the aviso counter.
 * - `logger`: the app's ONE logger. Never `firebase-functions`' logger, never
 *   `console.*`.
 * - `paginaReconciliacao`: the stock reconcile's page, BOUND
 *   ({@link PAGINA_RECONCILIACAO_AMAZON}).
 * - `tarefaPrecoSku` (step 13, PR 13-d): the price task, BOUND
 *   ({@link TAREFA_PRECO_SKU_AMAZON}).
 * - `paginaPreco` (step 13, PR 13-e): a price run's page, BOUND
 *   ({@link PAGINA_PRECO_AMAZON}).
 */
export function depsDosLotesAmazon(registro: RegistroLoteAmazon): DepsProcessarLoteAmazon {
  return {
    ambiente: process.env,
    agora: () => Date.now(),
    logger: LOGGER_STDOUT_AMAZON,
    increment: incrementoAmazon,
    agendador: criarAgendadorLotesAmazonDoAmbiente,
    provedores: PROVEDORES_DOS_LOTES_AMAZON,
    registro,
    fetch: (input, init) => globalThis.fetch(input, init),
    paginaReconciliacao: PAGINA_RECONCILIACAO_AMAZON,
    tarefaPrecoSku: TAREFA_PRECO_SKU_AMAZON,
    paginaPreco: PAGINA_PRECO_AMAZON,
  };
}

/**
 * The Amazon JOBS queue (step 12a, PR 12-c): ONE function — and so ONE Cloud
 * Tasks queue, auto-provisioned and named after it — for every task of the
 * `JSON_LISTINGS_FEED` core: a feed's send, its poll rungs and wake-ups, the
 * wait after a lost `createFeed` answer, and the recoveries; and, since step
 * 12 (PR 12-f), each page of the daily stock reconcile. The body is
 * `lib/amazon/feeds/processarLote.ts`, which dispatches on the payload's
 * `tipo`. Its producers: the handlers' own enqueues (through `./agendadorEstoque`,
 * the functions runtime SA), the seam's providers (through the same root: the
 * stock row since PR 12-f) and the push receiver's `FEED_PROCESSING_FINISHED`
 * wake-up (through `lib/firebase/filaLeitura.ts`, the App Hosting runtime SA).
 * Since step 13 (PR 13-d) it also carries the PRICE task (`preco-sku`, one
 * SKU's offer, {@link TAREFA_PRECO_SKU_AMAZON}), whose own check, wait and
 * pause come back through the stock root, and (PR 13-e) a price run's pages
 * (`preco-pagina`, {@link PAGINA_PRECO_AMAZON}): price has no queue of its own.
 *
 * ⚠️ The export name IS the deployed function AND queue name, and it must equal
 * `FILA_LOTES_AMAZON` — the producers target that string. `index.ts` asserts
 * the pair at module load; rename both together, or every enqueue targets a
 * queue that does not exist (a silent drop).
 *
 * Options, each one deliberate (`index.test.ts` pins every value):
 *
 * - `rateLimits { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 }`:
 *   ONE task at a time across the conta's feed work: one feed in flight per
 *   (fluxo, conta) is the lease's guard, and concurrency 1 additionally keeps
 *   two dispatches from interleaving their reads and writes of one lease or one
 *   record, and keeps the feeds' own rates (`getFeedDocument` refills one call
 *   every 45 s) out of reach.
 * - `retryConfig`: {@link TENTATIVAS_LOTE_AMAZON} attempts, backing off 30 s →
 *   300 s with up to three doublings: a transient report download or `getFeed`
 *   retries well inside its rung's own interval.
 * - `timeoutSeconds: 540`: a send's worst case is its build budget
 *   (`ORCAMENTO_MONTAGEM_LOTE_MS`, 240 s, shared by `membros` and `montar`) plus
 *   the submission twice under the forced-refresh rule — the LWA exchange,
 *   `createFeedDocument`, the upload and `createFeed`, each bounded by the
 *   package's `PRAZO_AMAZON_MS` — 460 s, read off the package by `index.test.ts`.
 * - `memory: '1GiB'`, the first in this codebase: the 256-MiB default cannot
 *   hold a report download (20 MiB compressed, 32 MiB inflated, its UTF-16
 *   decode and its parse tree), nor a catalogue-sized snapshot.
 * - `secrets`: {@link SEGREDOS_DOS_LOTES_AMAZON}.
 * - `...tasksInvokerOptions()`: `roles/run.invoker` on this service and
 *   `roles/cloudtasks.enqueuer` on its queue, from `TASKS_INVOKER_SA` — the
 *   codebase-wide list that names BOTH runtime SAs.
 *
 * Every handler writes ONE dispatch line per run that returns (a refused
 * payload writes the dispatcher's ERROR line); a throw for the queue's retry
 * writes none (the runtime logs it, SANITIZED here: never a package error's
 * message).
 *
 * D11: nothing calls Amazon before the window — the context loader refuses
 * unless `AMAZON_CHAMADAS` is exactly `on`, a submission also needs the fluxo's
 * valve `on` and the canary list exactly `*`; the stock provider reaches Amazon
 * only through that same context.
 */
// ⚠️ No type argument on the call: `tasks-invoker-inventory.test.js` discovers
// task functions by the call text, and the untyped call keeps `req.data` at
// `unknown`, which the dispatcher parses (P0) instead of trusting a cast.
export const processAmazonListingsJob = onTaskDispatched(
  {
    ...tasksInvokerOptions(),
    timeoutSeconds: 540,
    // ⚠️ A report download and its parse do not fit the 256-MiB default.
    memory: '1GiB',
    secrets: [...SEGREDOS_DOS_LOTES_AMAZON],
    retryConfig: {
      maxAttempts: TENTATIVAS_LOTE_AMAZON,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxDoublings: 3,
    },
    // ⚠️ One task at a time: two dispatches never interleave on one lease or
    // one record.
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
  },
  async (req) => {
    const registro: RegistroLoteAmazon = {
      tentativa: req.retryCount ?? 0,
      idTarefa: req.id ?? null,
    };
    try {
      await processarLoteAmazon(getDb(), req.data, depsDosLotesAmazon(registro));
    } catch (err) {
      // The queue's retry: a package error's message can carry a path with a
      // seller id, so it leaves through the app's sanitizing boundary.
      throw sanitizarFalhaDaTarefaAmazon(err);
    }
  },
);
