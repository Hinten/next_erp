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
 */
export const reconcileAmazonStock = onSchedule(
  {
    schedule: '44 3 * * *',
    timeZone: 'America/Sao_Paulo',
    timeoutSeconds: 120,
    retryCount: 0,
  },
  async () => {
    let r: ResultadoReconciliacaoDiaria;
    try {
      r = await executarReconciliacaoDiariaEstoqueAmazon(depsDaReconciliacaoDiariaEstoqueAmazon());
    } catch (err) {
      throw sanitizarFalhaDaTarefaAmazon(err);
    }
    if (r.portao !== null) return;
    registrarEventoAmazon(
      LOGGER_STDOUT_AMAZON,
      'estoque',
      'INFO',
      '[amazon/estoque] reconciliação diária de estoque',
      resumirReconciliacaoDiariaEstoqueAmazon(r),
      { fluxo: FLUXO_AMAZON.estoque },
    );
  },
);
