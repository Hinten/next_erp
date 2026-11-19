import { randomUUID } from 'node:crypto';

import { FieldValue } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { LOGGER_STDOUT_AMAZON, registrarEventoAmazon } from '../../lib/amazon/core/log';
import { FLUXO_AMAZON } from '../../lib/amazon/core/valvulas';
import {
  type DepsTickEstoqueAmazon,
  LEITOR_DE_CONTAS_ESTOQUE_AMAZON,
  type ResultadoTickEstoqueAmazon,
  TEMPO_LIMITE_TICK_ESTOQUE_AMAZON_S,
  executarTickEstoqueAmazon,
  resumirTickEstoqueAmazon,
} from '../../lib/amazon/estoque/sincronizacaoEstoque';
import { sanitizarFalhaDaTarefaAmazon } from '../../lib/amazon/notificacoes/notificacao';
import {
  criarAgendadorLotesAmazonDoAmbiente,
  criarProdutorEstoqueAmazonDoAmbiente,
} from './agendadorEstoque';
import { getDb } from './lib/admin';

/**
 * The dependencies of ONE stock tick, bound to the runtime — the only place
 * they are bound. Called once per tick, so nothing below is cached at module
 * load.
 *
 * - `db`: the codebase's Firestore handle (the NAMED database).
 * - `ambiente`: the process environment, passed WHOLE and live: the tick reads
 *   the read switch (`AMAZON_CHAMADAS`) and the stock valve
 *   (`AMAZON_MODO_ESTOQUE`) from it, before any Firestore read. `lib/` never
 *   names the process environment (`estrutura.test.ts`).
 * - `contas`: the production readers — the uncached conta list and ONE raw,
 *   uncached by-id read of each conta.
 * - `produtor`: the stock queue's producer from the codebase's stock root
 *   (`./agendadorEstoque`: the queue valve read once, the region per enqueue,
 *   no default), passed as the THUNK, so a tick with nothing to enqueue builds
 *   none.
 * - `agendador`: the JOBS queue's producer from the same root (its valve and
 *   region alike), a THUNK too: the window `feed-enviar` of a delta feed, a
 *   reconcile request's first page, the re-kick of a stalled run and the
 *   stranded start's `vez` recovery go through it.
 * - `increment`: a tier-0 `FieldValue` for the aviso counter.
 * - `logger`: the app's ONE logger (`LOGGER_STDOUT_AMAZON`).
 * - `gerarExecucaoId`: a fresh id — each conta run's lease holder, and the run a
 *   reconcile request starts.
 */
export function depsDoTickEstoqueAmazon(): DepsTickEstoqueAmazon {
  return {
    db: getDb(),
    ambiente: process.env,
    contas: LEITOR_DE_CONTAS_ESTOQUE_AMAZON,
    produtor: criarProdutorEstoqueAmazonDoAmbiente,
    agendador: criarAgendadorLotesAmazonDoAmbiente,
    agora: () => Date.now(),
    logger: LOGGER_STDOUT_AMAZON,
    increment: (by: number) => FieldValue.increment(by),
    gerarExecucaoId: () => randomUUID(),
  };
}

/**
 * The FIVE-MINUTE STOCK TICK (master plan step 12, PR 12-e2): per active conta,
 * the estoque rows that moved at the conta's depósito since its durable cursor,
 * turned into the conta's SKUs and handed off: 1 to 30 as one named patch task
 * per observation onto the stock queue, 31 to 3,000 as ONE window `feed-enviar`
 * onto the jobs queue, more as a reconcile request; and each conta's stalled
 * reconcile run re-kicked, its stranded feed start recovered
 * (`lib/amazon/estoque/sincronizacaoEstoque.ts` owns the whole run, its lease
 * and its cursor). It makes NO Amazon call and binds no secret: every quantity
 * is computed, and every write sent, by the queues.
 *
 * Two gates keep it inert until the window, each with ZERO Firestore
 * operations and ONE INFO line written by the body: the read switch
 * `AMAZON_CHAMADAS` not exactly `on`, then the stock valve `off`. So no sync
 * document can exist before the window.
 *
 * The numbers (`index.test.ts` pins them off the deployed endpoint):
 *
 * - `3,8,…,58`: every five minutes (`INTERVALO_TICK_ESTOQUE_AMAZON_MS`), as a
 *   minute LIST — the interval pin reads only that shape — and never in the
 *   same minute as another schedule of this codebase (`7,22,37,52` poll,
 *   `10,40` reprocess, `15 7` expiry);
 * - `timeoutSeconds` `TEMPO_LIMITE_TICK_ESTOQUE_AMAZON_S` (240): above the
 *   tick's 200-s budget (`ORCAMENTO_TICK_ESTOQUE_AMAZON_MS`, which leaves the
 *   last conta room for its final write), and below the 270-s lease
 *   (`LEASE_TICK_ESTOQUE_AMAZON_MS`, counted from the tick's START for every
 *   conta), so a live run's lease never expires under it — while the 300-s
 *   interval exceeds the lease, so a crashed run's leases are all free by the
 *   next tick;
 * - `retryCount: 0`: a failed tick is not retried — the next one comes in five
 *   minutes, and a retry would only race the crashed run's lease.
 *
 * ⚠️ The firebase-functions scheduler wrapper logs an escaping error's message
 * itself, so a throw leaves the tick through `sanitizarFalhaDaTarefaAmazon`
 * first: a package error becomes a `FalhaTarefaAmazonError` (class and status,
 * no path, no ref, no cause); anything else — this app's own errors, gRPC, a
 * bug — is rethrown untouched (rule 6).
 *
 * ONE summary line per tick that walked the contas (`evento: 'estoque'`, the
 * counters flattened by `resumirTickEstoqueAmazon`); each conta's run writes its
 * own line. A gated tick writes no summary: its ONE line is the body's.
 */
export const sweepAmazonStock = onSchedule(
  {
    schedule: '3,8,13,18,23,28,33,38,43,48,53,58 * * * *',
    timeZone: 'America/Sao_Paulo',
    timeoutSeconds: TEMPO_LIMITE_TICK_ESTOQUE_AMAZON_S,
    retryCount: 0,
  },
  async () => {
    let r: ResultadoTickEstoqueAmazon;
    try {
      r = await executarTickEstoqueAmazon(depsDoTickEstoqueAmazon());
    } catch (err) {
      throw sanitizarFalhaDaTarefaAmazon(err);
    }
    if (r.portao !== null) return;
    registrarEventoAmazon(
      LOGGER_STDOUT_AMAZON,
      'estoque',
      'INFO',
      '[amazon/estoque] tick de estoque',
      resumirTickEstoqueAmazon(r),
      { fluxo: FLUXO_AMAZON.estoque },
    );
  },
);
