import { randomUUID } from 'node:crypto';

import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { importadorPedidoLi } from '../../lib/lojaIntegrada/notificacoes/notificacao';
import { lerLookbackHorasLi } from '../../lib/lojaIntegrada/pedidos/janelaPoll';
import {
  type DepsPollLi,
  executarPollPedidosLi,
  resumirTickPollLi,
} from '../../lib/lojaIntegrada/pedidos/pollPedidos';
import { criarAgendadorLiDoAmbiente } from './agendador';
import { getDb } from './lib/admin';

/**
 * The dependencies of ONE poller tick, bound to the runtime — the poller's
 * counterpart of `depsLeitura.ts`, and the only place they are bound.
 *
 * - `ambiente`: the process environment, read ONCE per tick here and passed
 *   whole; the read switch is checked by the tick and again by each context.
 * - `importadorPresente`: the step-5 seam, read from the table HERE, per tick —
 *   never cached at module load, never hard-coded. Step 5 filled the table, so
 *   the tick passes this gate with no edit here, and the read switch (unset
 *   until the window) is what stops it, still with ZERO reads.
 * - `lookbackHoras`: `LOJA_INTEGRADA_POLL_LOOKBACK_H`, parsed here (`lib/` never
 *   names the process environment). Invalid stays `null`, never the default.
 * - `agendador`: the reads-queue producer from the environment (the sweep-only
 *   valve read once, the region per enqueue).
 * - `esperar`: the pacer's sleep (2 000 ms before every Loja Integrada call).
 */
export function depsDoPollLi(): DepsPollLi {
  const ambiente = process.env;
  return {
    ambiente,
    importadorPresente: importadorPedidoLi() !== null,
    lookbackHoras: lerLookbackHorasLi(ambiente.LOJA_INTEGRADA_POLL_LOOKBACK_H),
    agendador: criarAgendadorLiDoAmbiente(),
    agoraMs: () => Date.now(),
    esperar: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    increment: (by: number) => FieldValue.increment(by),
    gerarExecucaoId: () => randomUUID(),
    logger,
  };
}

/**
 * The 5-minute ORDER POLLER (master plan step 3): per active conta, the orders
 * Loja Integrada says changed since its durable cursor, one synthetic
 * notification each onto `filaLeituraLojaIntegrada`
 * (`lib/lojaIntegrada/pedidos/pollPedidos.ts` owns the whole run).
 *
 * It runs INLINE in its own schedule, not as a queued task, so intake keeps
 * running in sweep-only mode (`LOJA_INTEGRADA_TASKS_DISABLED=1`: each
 * notification is persisted for the reprocess sweep instead).
 *
 * Two gates, each stopping a tick with ZERO reads: the importer seam (filled
 * since step 5, so it passes) and the read switch `LOJA_INTEGRADA_CHAMADAS`,
 * unset everywhere until the window sets it — which keeps the poller inert.
 *
 * 300 s: the tick budgets 220 s across its contas (each at most 100 s, paced at
 * 2 000 ms a call), and a run may overshoot by one pacer interval plus one
 * request deadline before its final write — the gen2 60 s default cannot absorb
 * one conta. Every 5 minutes on the clock, `America/Sao_Paulo` like the other
 * schedules; a tick that finds a conta's lease still held skips it.
 */
export const pollLojaIntegradaPedidos = onSchedule(
  {
    schedule: '*/5 * * * *',
    timeZone: 'America/Sao_Paulo',
    timeoutSeconds: 300,
  },
  async () => {
    const r = await executarPollPedidosLi(getDb(), depsDoPollLi());
    // Counters only: each conta's own line is written by the run itself.
    logger.info('[loja-integrada] order poller tick', resumirTickPollLi(r));
  },
);
