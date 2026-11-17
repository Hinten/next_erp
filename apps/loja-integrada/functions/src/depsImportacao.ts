import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';

import type { DepsDespachoImportacaoLi } from '../../lib/lojaIntegrada/importacao/despacho';
import { criarAgendadorImportacaoLiDoAmbiente } from './agendador';
import { getBucket } from './lib/admin';

/**
 * The dependencies of one product-import DISPATCH (master plan step 9) — a reads-queue task of
 * `tipo: 'importacao'` — bound to the runtime. The ONE place in this codebase that binds them, so
 * every dispatch of every job agrees about the environment, the clock and the producer.
 *
 * - `ambiente`: the process environment, passed whole and LIVE — read by the context loader once,
 *   as its first statement, for the read switch only. `lib/` never names the process environment
 *   (`estrutura.test.ts`).
 * - `agoraMs`: the one clock, in ms — the dispatch's budget (measured from `inicioMs`) and every
 *   stamp of the job and its subcollections.
 * - `inicioMs`: when THIS dispatch began, stamped by the queue's handler as its FIRST statement,
 *   so the job read and the context load count against the budget too.
 * - `esperar`: the pacer's sleep (2 000 ms before every Loja Integrada call).
 * - `increment`: a tier-0 `FieldValue`, for the avisos' counters — the park's reconexão aviso and
 *   the import's summary aviso — so two producers landing together cannot lose each other's bump.
 * - `agendador`: the producer ROOT, built only when a hand-off is due (the sweep-only valve is read
 *   when it is built), never at module load.
 * - `bucket`: the default Cloud Storage bucket the photos of a "complete" run are stored in
 *   (`lib/admin.ts`, `getBucket`: `FIREBASE_CONFIG.storageBucket`, then the admin app's own option),
 *   resolved only when a dispatch asks for it — never at module load; `null` when nothing names
 *   one, and the dispatch then skips the run's photos and stamps the job `fotosIndisponiveis`.
 * - `logger`: the run's one sink (`firebase-functions/v2`), ids and counts only.
 * - `tentativa`, `idTarefa`: the Cloud Tasks attempt (0-based) and the task id, for the last-attempt
 *   rule and the context's call lines.
 *
 * No `fetch` seam: the package's client uses the runtime's own.
 */
export function depsDeImportacaoLi(registro: {
  readonly tentativa: number;
  readonly idTarefa: string | null;
  readonly inicioMs: number;
}): DepsDespachoImportacaoLi {
  return {
    ambiente: process.env,
    agoraMs: () => Date.now(),
    inicioMs: registro.inicioMs,
    esperar: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    increment: (by: number) => FieldValue.increment(by),
    agendador: criarAgendadorImportacaoLiDoAmbiente,
    bucket: () => getBucket(),
    logger,
    tentativa: registro.tentativa,
    idTarefa: registro.idTarefa,
  };
}
