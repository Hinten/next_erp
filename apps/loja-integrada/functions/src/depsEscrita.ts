import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';

import type {
  DepsEscritaLi,
  RegistroEscritaLi,
} from '../../lib/lojaIntegrada/rastreio/processarRastreio';

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
