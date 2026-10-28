import { randomUUID } from 'node:crypto';

import { FieldValue } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import {
  LOGGER_STDOUT_AMAZON,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../../lib/amazon/core/log';
import { importadorPedidoAmazon } from '../../lib/amazon/notificacoes/destinos';
import { sanitizarFalhaDaTarefaAmazon } from '../../lib/amazon/notificacoes/notificacao';
import { TEMPO_LIMITE_POLL_AMAZON_S } from '../../lib/amazon/pedidos/orcamentoPoll';
import {
  type DepsPollAmazon,
  FLUXO_POLL_AMAZON,
  type ResultadoTickPollAmazon,
  executarPollPedidosAmazon,
  resumirTickPollAmazon,
} from '../../lib/amazon/pedidos/pollPedidos';
import { criarAgendadorAmazonDoAmbiente } from './agendador';
import { SEGREDOS_DE_LEITURA_AMAZON } from './depsLeitura';
import { getDb } from './lib/admin';

/**
 * The dependencies of ONE poll tick, bound to the runtime — the poll's
 * counterpart of `depsLeitura.ts`, and the only place they are bound. Called
 * once per tick, so nothing below is cached at module load.
 *
 * - `ambiente`: the process environment, passed WHOLE and live. The tick reads
 *   the read switch (`AMAZON_CHAMADAS`) and the look-back
 *   (`AMAZON_POLL_LOOKBACK_H`) from it; each conta's context reads the switch
 *   again and the LWA pair. `lib/` never names the process environment
 *   (`estrutura.test.ts`).
 * - `importadorPresente`: the step-5 seam (`lib/amazon/notificacoes/destinos.ts`),
 *   read from the table HERE, per tick — never cached, never hard-coded. Step 5
 *   filled it (PR 5-e), so this gate is open for good and the read switch is
 *   the only one left; the gate code stays, so an emptied seam would close the
 *   poll again with ZERO Firestore operations.
 * - `agendador`: this codebase's own producer root (`./agendador`): the
 *   sweep-only valve read once per tick, the region per enqueue (no default).
 * - `esperar`: a real sleep, bound only so a test can prove the poll never
 *   calls it (a 429 stops the conta; the bucket refills ~179 s per token).
 * - `logger`: the app's ONE logger (`LOGGER_STDOUT_AMAZON`).
 *
 * No `fetch`, `gerarCorrelationId` or `agendarPrazo` seam: the package's client
 * uses the runtime's own `fetch`, behind the read switch, and the enqueue
 * deadline its unref'd production timer.
 */
export function depsDoPollAmazon(): DepsPollAmazon {
  return {
    ambiente: process.env,
    importadorPresente: importadorPedidoAmazon() !== null,
    agendador: criarAgendadorAmazonDoAmbiente(),
    agora: () => Date.now(),
    increment: (by: number) => FieldValue.increment(by),
    logger: LOGGER_STDOUT_AMAZON,
    gerarExecucaoId: () => randomUUID(),
    esperar: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}

/**
 * The summary line's severity: WARNING when an app-wide refusal stopped the
 * tick before every conta ran (`abortado`), INFO otherwise. Each conta's run
 * wrote its own line at its own severity already.
 */
function severidadeDoTick(r: ResultadoTickPollAmazon): SeveridadeAmazon {
  return r.abortado === null ? 'INFO' : 'WARNING';
}

/**
 * The 15-minute BACKSTOP POLL (master plan step 4): per active conta, the orders
 * Amazon says changed since its durable cursor, one synthetic `origem: 'poll'`
 * notification each onto `filaLeituraAmazon`
 * (`lib/amazon/pedidos/pollPedidos.ts` owns the whole run, its lease and its
 * cursor).
 *
 * It runs INLINE in its own schedule, not as a queued task, so intake keeps
 * running in sweep-only mode (`AMAZON_TASKS_DISABLED=1`: each notification is
 * persisted `failed` for the reprocess sweep instead).
 *
 * One gate keeps it inert until the window, with ZERO Firestore operations: the
 * read switch `AMAZON_CHAMADAS`, unset everywhere until W5. (The first gate, an
 * empty importer seam, is permanently open since step 5 filled it.) So no poll
 * document — and no bootstrap anchor — can exist before the window.
 *
 * The numbers (`index.test.ts` pins them off the deployed endpoint):
 *
 * - `7,22,37,52`: every 15 minutes (`INTERVALO_POLL_AMAZON_MS`), never in the
 *   same minute as another schedule of this codebase (`10,40` reprocess, `15 7`
 *   expiry);
 * - `timeoutSeconds` `TEMPO_LIMITE_POLL_AMAZON_S` (300): above the tick's 240-s
 *   budget (`ORCAMENTO_TICK_MS`, which leaves the last conta room for its final
 *   write), and below the 360-s lease (`LEASE_POLL_MS`), so a live run's lease
 *   never expires under it — while the 900-s interval exceeds the lease, so a
 *   crashed run's lease is free by the next tick;
 * - `retryCount: 0`: a failed tick is not retried — the next one comes in 15
 *   minutes, and a retry would only race the crashed run's lease;
 * - the LWA client secret, because a conta's run may refresh its access token.
 *
 * ⚠️ The firebase-functions scheduler wrapper logs an escaping error's message
 * itself, so a throw leaves the tick through `sanitizarFalhaDaTarefaAmazon`
 * first: a package error becomes a `FalhaTarefaAmazonError` (class and status,
 * no path, no ref, no cause); anything else — this app's own errors, gRPC, a bug
 * — is rethrown untouched (rule 6).
 *
 * ONE summary line per tick (`evento: 'poll'`, the counters flattened by
 * `resumirTickPollAmazon`); each conta's run writes its own line.
 */
export const pollAmazonOrders = onSchedule(
  {
    schedule: '7,22,37,52 * * * *',
    timeZone: 'America/Sao_Paulo',
    timeoutSeconds: TEMPO_LIMITE_POLL_AMAZON_S,
    retryCount: 0,
    secrets: [...SEGREDOS_DE_LEITURA_AMAZON],
  },
  async () => {
    let r: ResultadoTickPollAmazon;
    try {
      r = await executarPollPedidosAmazon(getDb(), depsDoPollAmazon());
    } catch (err) {
      throw sanitizarFalhaDaTarefaAmazon(err);
    }
    registrarEventoAmazon(
      LOGGER_STDOUT_AMAZON,
      'poll',
      severidadeDoTick(r),
      '[amazon] poll de pedidos',
      resumirTickPollAmazon(r),
      { fluxo: FLUXO_POLL_AMAZON },
    );
  },
);
