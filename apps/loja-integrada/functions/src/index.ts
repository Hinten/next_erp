// Import side-effect first: registers global function options (region) before
// any trigger is defined. See options.ts.
//
// ⚠️ This bare import is load-bearing precisely because it has NO binding —
// there is nothing here to look unused, so `no-unused-vars` can never point
// anyone at deleting it. Keep it that way, and keep it FIRST: ESM evaluates
// modules in the order their import declarations appear, so a second
// `from './options'` further down would satisfy `import/no-duplicates` by
// merging INTO that one, moving the option registration after the trigger
// modules. That un-registers the global options for every trigger in this file,
// and it is invisible: the functions deploy fine, to the wrong region (#1108).
import './options';

import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { readCacheDelta, readCacheMark } from '@delfrance/data/admin/cache';

import { sweepLojaIntegradaTokenExpiry as runTokenExpirySweep } from '../../lib/lojaIntegrada/conta/expiracaoSweep';
import {
  FILA_LEITURA_LI,
  type RegistroTarefaLi,
  type ReprocessResult,
  reprocessarAdiadasLi,
  reprocessarNotificacoesLi,
} from '../../lib/lojaIntegrada/notificacoes/notificacao';
import { depsDeLeituraLi } from './depsLeitura';
import * as filaLeitura from './filaLeitura';
import { getDb } from './lib/admin';

/**
 * Loja Integrada Cloud Functions (gen2), codebase `loja-integrada`. Deployed as
 * a deploy-artifact sub-build of `@delfrance/loja-integrada-app` (see
 * scripts/prepare-deploy.mjs and `firebase.loja-integrada.deploy.json`, which
 * ships INERT — running it is a manual coordinated human step, root
 * `CLAUDE.md` rule 8).
 *
 * Master plan step 3 wires the notification pipeline: ONE reads queue
 * (`filaLeituraLojaIntegrada`, ./filaLeitura) dispatching on the task's `tipo`,
 * the 30-minute reprocess sweep over both lanes, and the daily token-expiry
 * sweep. The 5-minute order poller — the queue's first producer — arrives with
 * its own change.
 *
 * Every export below is a Cloud Function name, and the names are unique across
 * codebases (`functions-export-names.test.js`): keep the exports explicit and
 * named, never a wildcard. `index.test.ts` pins every trigger's options and
 * that its maps cover every export.
 */

// Rename-safety: the DEPLOYED function name is the export KEY of the handler
// below, and every producer enqueues against `FILA_LEITURA_LI`. ESM export
// names must be static literals (you can't compute an `export const` name), so
// instead of deriving one from the other we assert — at module load, i.e.
// during Firebase's deploy codebase analysis — that they never drifted. A rename
// that updates only one side fails the deploy loudly here instead of silently
// enqueuing onto a queue that does not exist.
if (!(FILA_LEITURA_LI in filaLeitura)) {
  throw new Error(
    '[loja-integrada] function-name drift: functions/src/filaLeitura.ts must export a ' +
      `handler named '${FILA_LEITURA_LI}' (the enqueue target). ` +
      'Rename the export and the FILA_LEITURA_LI constant together.',
  );
}

/** The ONE reads queue (rate-limited to one dispatch at a time, retry with backoff). */
export { filaLeituraLojaIntegrada } from './filaLeitura';

/**
 * Documents examined per lane on each tick of the reprocess sweep. NOT exported:
 * every runtime export of this file is read as a Cloud Function name.
 */
const LIMITE_POR_RAIA_LI = 10;

/**
 * The `registro` of a sweep run: the same flow as the queue's, with no Cloud
 * Tasks attempt and no task id — the sweep is not a task.
 */
const REGISTRO_DA_VARREDURA: RegistroTarefaLi = {
  fluxo: 'intake',
  tentativa: null,
  idTarefa: null,
};

/**
 * One lane's log lines. `outcomes` and the counts only; per-row failures by
 * DOCUMENT ID — the row itself already holds the reason (`erro`), and an error
 * message is not something this channel's logs repeat (`apps/loja-integrada`
 * CLAUDE.md, "Logging and redaction").
 */
function registrarRaia(
  raia: 'quente' | 'adiada',
  result: ReprocessResult,
  marca: ReturnType<typeof readCacheMark>,
): void {
  logger.info(`[loja-integrada] reprocess sweep (${raia})`, {
    processed: result.processed,
    outcomes: result.outcomes,
    errorCount: result.errors.length,
    // Read-cache hits/misses accrued by THIS lane. Reports the SWEEP process's
    // caches, not the queue's — they are separate deployments.
    readCache: readCacheDelta(marca),
  });
  if (result.errors.length > 0) {
    logger.warn(`[loja-integrada] reprocess sweep (${raia}) had per-doc failures`, {
      docIds: result.errors.slice(0, 10).map((e) => e.docId),
    });
  }
}

/**
 * The backstop over BOTH lanes of `notificacoesLojaIntegrada`, on one tick:
 * first the hot lane (`failed` rows older than an hour), then the deferred lane
 * (a parked conta, an inactive conta, a missing credential, the read switch
 * off), `LIMITE_POR_RAIA_LI` rows each.
 *
 * It runs the SAME pipeline as the queue, inline — the same context, the same
 * read switch, the same importer seam (`depsDeLeituraLi`) — so a re-drive
 * answers exactly what the task would have.
 *
 * The two lanes are logged SEPARATELY, never summed: they answer different
 * questions ("is processing healthy" vs "how many contas still owe us a
 * reconnection"), and a sum would hide a growing deferred backlog inside a
 * healthy `processed`.
 *
 * 540 s: up to twenty rows processed SEQUENTIALLY, each of which may make a
 * paced Loja Integrada round trip (2 000 ms before every call) once the read
 * switch and the importer are on — the gen2 60 s default cannot absorb that.
 */
export const reprocessLojaIntegradaNotifications = onSchedule(
  {
    schedule: '*/30 * * * *',
    timeZone: 'America/Sao_Paulo',
    timeoutSeconds: 540,
  },
  async () => {
    const db = getDb();
    const deps = depsDeLeituraLi(REGISTRO_DA_VARREDURA);

    const marcaQuente = readCacheMark();
    const quente = await reprocessarNotificacoesLi(db, { limit: LIMITE_POR_RAIA_LI }, deps);
    registrarRaia('quente', quente, marcaQuente);

    const marcaAdiada = readCacheMark();
    const adiada = await reprocessarAdiadasLi(db, { limit: LIMITE_POR_RAIA_LI }, deps);
    registrarRaia('adiada', adiada, marcaAdiada);
  },
);

/**
 * The DAILY token-expiry sweep. Walks every Loja Integrada conta, raises the
 * expiry and reconnection avisos at the 30-day horizon and resolves them once a
 * new date or a new credential lands, then closes the orphaned rows of contas
 * that no longer exist (`conta/expiracaoSweep.ts` owns the whole decision).
 *
 * It makes NO call to Loja Integrada: it reads only the stored credential and
 * writes only avisos, so the read switch `LOJA_INTEGRADA_CHAMADAS` does not
 * gate it.
 *
 * Daily, because the token's expiry is a calendar date the operator types in
 * and the first warning is 30 days out — a slower cadence would let the horizon
 * pass between two ticks.
 */
export const sweepLojaIntegradaTokenExpiry = onSchedule(
  {
    schedule: '30 6 * * *',
    timeZone: 'America/Sao_Paulo',
    // One Firestore round trip per conta plus up to five pages of open avisos,
    // sequentially — the gen2 60 s `onSchedule` default cannot absorb that.
    timeoutSeconds: 120,
  },
  async () => {
    const result = await runTokenExpirySweep(getDb(), {
      // Injected because `packages/data/src/admin/**` may only `import type`
      // from firebase-admin — the aviso counter is a tier-0 FieldValue, so two
      // producers landing together cannot lose each other's bump.
      increment: (by: number) => FieldValue.increment(by),
      nowMs: Date.now(),
      logger,
    });
    logger.info('[loja-integrada] token expiry sweep', {
      contas: result.contas,
      semCredencial: result.semCredencial,
      estacionadas: result.estacionadas,
      expiracao: result.expiracao,
      reconexao: result.reconexao,
      orfaos: result.orfaos,
      errorCount: result.erros.length,
    });
  },
);
