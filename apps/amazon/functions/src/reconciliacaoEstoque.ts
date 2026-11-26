import { randomUUID } from 'node:crypto';

import { FieldValue } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { LOGGER_STDOUT_AMAZON, registrarEventoAmazon } from '../../lib/amazon/core/log';
import { FLUXO_AMAZON } from '../../lib/amazon/core/valvulas';
import {
  type DepsReconciliacaoDiariaEstoqueAmazon,
  type ResultadoReconciliacaoDiaria,
  executarReconciliacaoDiariaEstoqueAmazon,
  resumirReconciliacaoDiariaEstoqueAmazon,
} from '../../lib/amazon/estoque/reconciliacaoEstoque';
import { sanitizarFalhaDaTarefaAmazon } from '../../lib/amazon/notificacoes/notificacao';
import {
  type DepsBackstopDiarioPrecoAmazon,
  executarBackstopDiarioPrecoAmazon,
  resumirBackstopDiarioPrecoAmazon,
} from '../../lib/amazon/preco/backstopPreco';
import { criarAgendadorLotesAmazonDoAmbiente } from './agendadorEstoque';
import { getDb } from './lib/admin';

/**
 * The dependencies of ONE daily run, bound to the runtime — the only place
 * they are bound. Called once per run, so nothing below is cached at module
 * load.
 *
 * - `db`: the codebase's Firestore handle (the NAMED database).
 * - `ambiente`: the process environment, passed WHOLE and live: the run reads
 *   the read switch (`AMAZON_CHAMADAS`) and the stock valve
 *   (`AMAZON_MODO_ESTOQUE`) from it, before any Firestore read. `lib/` never
 *   names the process environment (`estrutura.test.ts`).
 * - `agendador`: the JOBS queue's producer from the codebase's stock root
 *   (`./agendadorEstoque`: the queue valve read once, the region per enqueue,
 *   no default), a THUNK, so a run with nothing to enqueue builds none: the
 *   first page of each run it starts, the re-kick of a stalled run, and the
 *   feed backstop's adoption rung.
 * - `increment`: a tier-0 `FieldValue` for the aviso counter.
 * - `logger`: the app's ONE logger (`LOGGER_STDOUT_AMAZON`).
 * - `gerarExecucaoId`: a fresh run id per run started.
 */
export function depsDaReconciliacaoDiariaEstoqueAmazon(): DepsReconciliacaoDiariaEstoqueAmazon {
  return {
    db: getDb(),
    ambiente: process.env,
    agora: () => Date.now(),
    logger: LOGGER_STDOUT_AMAZON,
    increment: (by: number) => FieldValue.increment(by),
    agendador: criarAgendadorLotesAmazonDoAmbiente,
    gerarExecucaoId: () => randomUUID(),
  };
}

/**
 * The dependencies of ONE daily PRICE step (step 13, PR 13-f), bound to the
 * runtime: the same db, environment (the read switch and the PRICE valve,
 * `AMAZON_MODO_PRECO`), clock and logger, and the same JOBS producer from the
 * stock root, a THUNK — built only for an adoption rung.
 */
export function depsDoBackstopDiarioPrecoAmazon(): DepsBackstopDiarioPrecoAmazon {
  return {
    db: getDb(),
    ambiente: process.env,
    agora: () => Date.now(),
    logger: LOGGER_STDOUT_AMAZON,
    agendador: criarAgendadorLotesAmazonDoAmbiente,
  };
}

/**
 * `passo` run to its end: its value, or its rejection (a synchronous throw of
 * its binding included) — never a throw here, so the root runs its next step
 * before it rethrows (the job's docblock below).
 */
async function liquidar<T>(passo: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  const [r] = await Promise.allSettled([Promise.resolve().then(passo)]);
  if (r === undefined) throw new TypeError('reconciliacaoEstoque.ts: um passo sempre se liquida');
  return r;
}

/** A failure's CLASS for a line — its `name`, never its message. */
function classeDaFalha(err: unknown): string {
  const nome = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : null;
  return typeof nome === 'string' ? nome : 'desconhecido';
}

/**
 * The DAILY STOCK RECONCILE (master plan step 12, PR 12-f): per active Amazon
 * conta, the stock feed's daily backstop — a submitted feed whose record has
 * not moved for six hours gets ONE adoption rung a day, a missing record is
 * re-created from the lease first — and then the start of the conta's
 * reconcile run, whose pages (on the jobs queue) walk every link doc of the
 * conta, read Amazon's live quantities and send the drift
 * (`lib/amazon/estoque/reconciliacaoEstoque.ts` owns the run: Start, its pages,
 * the decide and the close). It makes NO Amazon call and binds no secret here:
 * the pages read Amazon through the jobs queue's own context.
 *
 * Two gates keep it inert until the window, each with ZERO Firestore
 * operations and ONE INFO line written by the body: the read switch
 * `AMAZON_CHAMADAS` not exactly `on`, then the stock valve `off`.
 *
 * "Send all" is this job, forced from Cloud Scheduler (`gcloud scheduler jobs
 * run`): a run re-reads every SKU and sends what drifted, delayed 20 minutes
 * like every reconcile send. There is no force-all feed.
 *
 * The numbers (`index.test.ts` pins them off the deployed endpoint):
 *
 * - `44 3 * * *`: daily at 03:44 in São Paulo, a minute no other schedule of
 *   this codebase uses (`7,22,37,52` poll, `10,40` reprocess, `15 7` expiry,
 *   the tick's `3,8,…,58`);
 * - `timeoutSeconds: 120`: a few by-id reads, writes and enqueues per conta —
 *   the walk itself runs on the jobs queue, page by page;
 * - `retryCount: 0`: a failed run is not retried — every Start it would redo
 *   is also made by the next request, by the tick's re-kick of a stalled run,
 *   or by tomorrow's run.
 *
 * ⚠️ The firebase-functions scheduler wrapper logs an escaping error's message
 * itself, so a throw leaves the run through `sanitizarFalhaDaTarefaAmazon`
 * first (rule 6: this app's own errors, gRPC and bugs are rethrown untouched).
 *
 * ONE summary line per run that walked the contas (`evento: 'estoque'`, the
 * counters flattened by `resumirReconciliacaoDiariaEstoqueAmazon`); each conta
 * writes its own line. A gated run writes no summary: its ONE line is the
 * body's.
 *
 * Since step 13 (PR 13-f) the same job runs the DAILY PRICE step AFTER the
 * stock step (`lib/amazon/preco/backstopPreco.ts`): per active conta, the
 * price feed's daily backstop — ADOPTION only, never a run re-kick and never a
 * send. Both steps ALWAYS run: each is settled on its own, so a stock throw or
 * a gated stock run never skips price, nor the reverse, and the FIRST failure
 * is rethrown only after both finished, through the same sanitizing boundary;
 * when both failed, the other one first leaves ONE ERROR line of its own
 * (its class, never its message), so nothing is swallowed (rule 6). The price
 * step has its own gates (the read switch, then the price valve), and a gated
 * one is SILENT — zero reads, no line, no producer built — so a fully gated
 * run still writes exactly the stock gate's one line. A price step that walked
 * the contas writes ONE line per active conta and ONE summary (`evento:
 * 'preco'`, `resumirBackstopDiarioPrecoAmazon`). Its cost: one conta query
 * and, per active conta, at most one lease read, one record read (and create)
 * and one adoption rung. The export keeps its deployed name: a rename is a
 * delete and a create.
 */
export const reconcileAmazonStock = onSchedule(
  {
    schedule: '44 3 * * *',
    timeZone: 'America/Sao_Paulo',
    timeoutSeconds: 120,
    retryCount: 0,
  },
  async () => {
    const estoque: PromiseSettledResult<ResultadoReconciliacaoDiaria> = await liquidar(() =>
      executarReconciliacaoDiariaEstoqueAmazon(depsDaReconciliacaoDiariaEstoqueAmazon()),
    );
    if (estoque.status === 'fulfilled' && estoque.value.portao === null) {
      registrarEventoAmazon(
        LOGGER_STDOUT_AMAZON,
        'estoque',
        'INFO',
        '[amazon/estoque] reconciliação diária de estoque',
        resumirReconciliacaoDiariaEstoqueAmazon(estoque.value),
        { fluxo: FLUXO_AMAZON.estoque },
      );
    }
    const preco = await liquidar(() =>
      executarBackstopDiarioPrecoAmazon(depsDoBackstopDiarioPrecoAmazon()),
    );
    if (preco.status === 'fulfilled' && preco.value.portao === null) {
      registrarEventoAmazon(
        LOGGER_STDOUT_AMAZON,
        'preco',
        'INFO',
        '[amazon/preco] passo diário de preço',
        resumirBackstopDiarioPrecoAmazon(preco.value),
        { fluxo: FLUXO_AMAZON.preco },
      );
    }
    // The FIRST failure, only now that both steps finished; the other one leaves its own line.
    const falhas = (
      [
        [FLUXO_AMAZON.estoque, estoque],
        [FLUXO_AMAZON.preco, preco],
      ] as const
    ).flatMap(([fluxo, passo]) =>
      passo.status === 'rejected' ? [{ fluxo, motivo: passo.reason as unknown }] : [],
    );
    const [primeira, ...demais] = falhas;
    for (const falha of demais) {
      registrarEventoAmazon(
        LOGGER_STDOUT_AMAZON,
        falha.fluxo,
        'ERROR',
        `[amazon/${falha.fluxo}] passo diário falhou (outra falha é relançada)`,
        { fase: 'diario', erro: classeDaFalha(falha.motivo) },
        { fluxo: falha.fluxo },
      );
    }
    if (primeira !== undefined) throw sanitizarFalhaDaTarefaAmazon(primeira.motivo);
  },
);
