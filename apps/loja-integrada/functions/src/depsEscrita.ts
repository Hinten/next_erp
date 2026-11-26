import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';

import type { DepsKitsEstoqueLi } from '../../lib/lojaIntegrada/estoque/processarKitsEstoque';
import type { DepsEstoqueLi } from '../../lib/lojaIntegrada/estoque/processarEstoque';
import type { DepsPrecoLi } from '../../lib/lojaIntegrada/preco/processarPreco';
import type {
  DepsEscritaLi,
  RegistroEscritaLi,
} from '../../lib/lojaIntegrada/rastreio/processarRastreio';
import { criarAgendadorEstoqueLiDoAmbiente } from './agendadorEstoque';
import { criarAgendadorPrecoLiDoAmbiente } from './agendadorPreco';

/**
 * The dependencies of one WRITE run — a `rastreio` dispatch of the writes queue,
 * or every row a `varredura` dispatch re-runs (master plan step 7, PR 7-e) —
 * bound to the runtime. The ONE place in this codebase that binds them, so the
 * task and its in-queue sweep can never disagree about the environment, the
 * clock or the deadline.
 *
 * - `ambiente`: the process environment, passed whole and LIVE — the write
 *   valve, its canary list and the read switch are read by the run itself, once,
 *   as its first statements. `lib/` never names the process environment
 *   (`estrutura.test.ts`).
 * - `inicioDaTarefaMs`: when THIS dispatch began, stamped by the queue's handler
 *   as its first statement. The engine starts no write later than its deadline
 *   after it, and for a varredura every row it re-runs shares the dispatch's
 *   stamp — the queue's retry backoff is sized against that bound.
 * - `agoraMs`: the one live clock, in ms — the pacer's, the avisos', a conta
 *   park's, the varredura's budget and window.
 * - `esperar`: the writes pacer's sleep.
 * - `increment`: a tier-0 `FieldValue`, for every aviso counter a run bumps, so
 *   two producers landing together cannot lose each other's bump.
 * - `logger`: the run's one sink (`firebase-functions/v2`), ids and counts only —
 *   including the ERROR line of a row the sweep parks at its cap.
 * - `registro`: the Cloud Tasks attempt and the task id, for the app logger's
 *   lines (`null` attempt for the rows of a varredura: they are not the task).
 *
 * No `fetch` seam: the package's clients use the runtime's own.
 */
export function depsDeEscritaLi(
  registro: RegistroEscritaLi,
  inicioDaTarefaMs: number,
): DepsEscritaLi {
  return {
    ambiente: process.env,
    inicioDaTarefaMs,
    agoraMs: () => Date.now(),
    esperar: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    increment: (by: number) => FieldValue.increment(by),
    logger,
    registro,
  };
}

/**
 * The dependencies of one STOCK send run — a dispatch of the stock queue (master plan step 12,
 * PR 12-e) — bound HERE, beside the writes queue's, by spreading {@link depsDeEscritaLi}: the two
 * queues can then never disagree about the environment, the clock, the pacer's sleep or the write
 * deadline. The stock valve, its canary list, the read switch and the cap
 * (`LOJA_INTEGRADA_ESTOQUE_MAX`) all ride the same LIVE `ambiente`, read by the run itself.
 *
 * - `tentativa`: the Cloud Tasks attempt, 0-based — only the queue's LAST one concludes a refused
 *   write (`recusado` and its aviso); every earlier one rethrows so the retry re-derives.
 * - `agendador`: the stock queue's producer, for the run's one `deriva` follow-up, built from the
 *   environment per dispatch (the sweep-only valve read once, the queue resolved per enqueue).
 *
 * ⚠️ The stock trigger binds its own deps (`./onEstoqueLojaIntegrada`): an Eventarc event is not
 * a task, and it builds its handle and producer lazily, after the zero-read gates.
 */
export function depsDeEstoqueLi(
  registro: { readonly tentativa: number; readonly idTarefa: string | null },
  inicioDaTarefaMs: number,
): DepsEstoqueLi {
  return {
    ...depsDeEscritaLi(registro, inicioDaTarefaMs),
    tentativa: registro.tentativa,
    agendador: criarAgendadorEstoqueLiDoAmbiente(),
  };
}

/**
 * The dependencies of one `estoque-kits` FAN-OUT — a dispatch of the stock queue (master plan
 * step 12, PR 12-f) — taken from {@link depsDeEstoqueLi}, so the fan-out and the send runs it
 * enqueues can never disagree about the environment (the stock valve, the cap), the clock, the
 * attempt or the producer. It makes no Loja Integrada call, so it takes no pacer, no deadline and
 * no registro; its lines go through `firebase-functions/v2`'s logger, ids and counts only.
 */
export function depsDeKitsEstoqueLi(
  registro: { readonly tentativa: number; readonly idTarefa: string | null },
  inicioDaTarefaMs: number,
): DepsKitsEstoqueLi {
  const { ambiente, agoraMs, tentativa, agendador } = depsDeEstoqueLi(registro, inicioDaTarefaMs);
  return { ambiente, agoraMs, tentativa, agendador, logger };
}

/**
 * The dependencies of one PRICE send run — a dispatch of the price queue (master plan step 13,
 * PR 13-d) — bound HERE, beside the writes and stock queues', by spreading {@link depsDeEscritaLi}:
 * the three queues can then never disagree about the environment, the clock, the pacer's sleep or
 * the write deadline. The price valve, its canary list, the read switch and the clear's forma
 * (`LOJA_INTEGRADA_PRECO_PROMO_LIMPO`) all ride the same LIVE `ambiente`, read by the run itself.
 *
 * - `tentativa`: the Cloud Tasks attempt, 0-based — only the queue's LAST one concludes a refused
 *   write (`recusado` and its aviso); every earlier one rethrows so the retry re-derives.
 * - `agendador`: the PRICE queue's producer (never the stock one), for the run's one `deriva`
 *   follow-up, built from the environment per dispatch (the sweep-only valve read once, the queue
 *   resolved per enqueue).
 */
export function depsDePrecoLi(
  registro: { readonly tentativa: number; readonly idTarefa: string | null },
  inicioDaTarefaMs: number,
): DepsPrecoLi {
  return {
    ...depsDeEscritaLi(registro, inicioDaTarefaMs),
    tentativa: registro.tentativa,
    agendador: criarAgendadorPrecoLiDoAmbiente(),
  };
}
