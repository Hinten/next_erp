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
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { type CacheReport, readCacheDelta, readCacheMark } from '@delfrance/data/admin/cache';

import {
  type ExpiracaoSweepAmazonResult,
  sweepAmazonExpiracoes,
} from '../../lib/amazon/conta/expiracaoSweep';
import {
  type CampoLogAmazon,
  LOGGER_STDOUT_AMAZON,
  camposSeguros,
  registrarEventoAmazon,
} from '../../lib/amazon/core/log';
import {
  FILA_LEITURA_AMAZON,
  FLUXO_LEITURA_AMAZON,
  type ReprocessResult,
  reprocessarAdiadasAmazon,
  reprocessarNotificacoesAmazon,
} from '../../lib/amazon/notificacoes/notificacao';
import { SEGREDOS_DE_LEITURA_AMAZON, depsDeLeituraAmazon } from './depsLeitura';
import * as filaLeitura from './filaLeitura';
import { getDb } from './lib/admin';

/**
 * Amazon Cloud Functions (gen2), codebase `amazon`. Deployed as a
 * deploy-artifact sub-build of `@delfrance/amazon-app` (see
 * scripts/prepare-deploy.mjs and `firebase.amazon.deploy.json`, which ships
 * INERT — running it is a manual coordinated human step, root `CLAUDE.md`
 * rule 8, window item W9).
 *
 * Master plan step 3 (PR 3-d) wires the intake pipeline: ONE reads queue
 * (`filaLeituraAmazon`, ./filaLeitura) dispatching on the task's `tipo`, fed by
 * the App Hosting push receiver; the 30-minute reprocess sweep over both lanes;
 * and the daily expiry sweep (the step-2 body). Step 4 adds the backstop poll.
 *
 * ⚠️ ONE logger: every line goes through `LOGGER_STDOUT_AMAZON` /
 * `registrarEventoAmazon` (`lib/amazon/core/log.ts`). This file never imports
 * `firebase-functions`' logger and never calls `console.*`, and a per-row sweep
 * error is logged by DOCUMENT ID only — never a message (`estrutura.test.ts`).
 *
 * Every export below is a Cloud Function name, and the names are unique across
 * codebases (`functions-export-names.test.js`): keep the exports explicit and
 * named, never a wildcard, and never a helper. `index.test.ts` pins every
 * trigger's options and that its maps cover every export.
 */

// Rename-safety: the DEPLOYED function name is the export KEY of the handler
// below, and every producer enqueues against `FILA_LEITURA_AMAZON`. ESM export
// names must be static literals (you can't compute an `export const` name), so
// instead of deriving one from the other we assert — at module load, i.e.
// during Firebase's deploy codebase analysis — that they never drifted. A rename
// that updates only one side fails the deploy loudly here instead of silently
// enqueuing onto a queue that does not exist.
if (!(FILA_LEITURA_AMAZON in filaLeitura)) {
  throw new Error(
    '[amazon] function-name drift: functions/src/filaLeitura.ts must export a ' +
      `handler named '${FILA_LEITURA_AMAZON}' (the enqueue target). ` +
      'Rename the export and the FILA_LEITURA_AMAZON constant together.',
  );
}

/** The ONE reads queue (one dispatch at a time, retry with backoff). */
export { filaLeituraAmazon } from './filaLeitura';

/**
 * Documents examined per lane on each tick of the reprocess sweep. NOT exported:
 * every runtime export of this file is read as a Cloud Function name.
 */
const LIMITE_POR_RAIA_AMAZON = 10;

/**
 * The failed rows one lane's WARNING line names: as many document ids as the
 * sink writes UNCHANGED, the rest counted in `omitidos`. The sink masks and then
 * cuts every campo at 256 bytes (`camposSeguros`), and a poll id alone runs to
 * ~170 bytes (`poll:<conta ≤128>:<order>:<µs>`), so a COUNT of ids would let it
 * cut the last one mid-string — a line naming a document that does not exist.
 * The sink's own function is the test, so masking is covered as well as length.
 */
function docIdsNaLinha(docIds: readonly string[]): { docIds: string; omitidos: number } {
  const nomeados: string[] = [];
  for (const id of docIds) {
    const candidato = [...nomeados, id].join(',');
    if (camposSeguros({ docIds: candidato }).docIds === candidato) nomeados.push(id);
  }
  return { docIds: nomeados.join(','), omitidos: docIds.length - nomeados.length };
}

/** A cache name as a log key: anything outside `[A-Za-z0-9]` becomes `_`. */
function chaveDoCache(nome: string): string {
  return nome.replace(/[^A-Za-z0-9]/g, '_');
}

/**
 * A lane's read-cache delta, FLATTENED to primitives (the logger takes nothing
 * else): `readCache_<cache>_hits` / `_misses` per cache, nothing when no cache
 * is registered.
 */
function camposDoCache(relatorio: CacheReport): Record<string, CampoLogAmazon> {
  const campos: Record<string, CampoLogAmazon> = {};
  for (const [nome, { hits, misses }] of Object.entries(relatorio ?? {})) {
    campos[`readCache_${chaveDoCache(nome)}_hits`] = hits;
    campos[`readCache_${chaveDoCache(nome)}_misses`] = misses;
  }
  return campos;
}

/** A lane's outcome counts, FLATTENED: `outcome_<label>` per label. */
function camposDosDesfechos(outcomes: Readonly<Record<string, number>>): Record<string, number> {
  const campos: Record<string, number> = {};
  for (const [rotulo, quantos] of Object.entries(outcomes)) campos[`outcome_${rotulo}`] = quantos;
  return campos;
}

/**
 * One lane's lines. The counts, the flattened outcomes and THIS lane's
 * read-cache delta; per-row failures by DOCUMENT ID only, in a second WARNING
 * line — the row itself already holds the reason (`erro`), and the shared
 * core's `errors[].message` is never logged (an error message is not something
 * this channel's logs repeat). The shared core reports no error class, so none
 * is printed.
 *
 * The counts line is a WARNING when the lane PARKED a row — at its cap or on a
 * terminal outcome, no sweep re-drives it again — and INFO otherwise: a row
 * still `failed` or `deferred` comes back on a later tick.
 */
function registrarRaia(
  lane: 'hot' | 'deferred',
  result: ReprocessResult,
  marca: ReturnType<typeof readCacheMark>,
): void {
  const envelope = { fluxo: FLUXO_LEITURA_AMAZON.reprocesso };
  registrarEventoAmazon(
    LOGGER_STDOUT_AMAZON,
    'varredura',
    (result.outcomes.parked ?? 0) > 0 ? 'WARNING' : 'INFO',
    `[amazon] varredura de reprocessamento (${lane})`,
    {
      varredura: 'reprocesso',
      lane,
      processed: result.processed,
      erros: result.errors.length,
      ...camposDosDesfechos(result.outcomes),
      // The SWEEP process's caches, not the queue's — separate deployments.
      ...camposDoCache(readCacheDelta(marca)),
    },
    envelope,
  );
  if (result.errors.length > 0) {
    const nomeados = docIdsNaLinha(result.errors.map((e) => e.docId));
    registrarEventoAmazon(
      LOGGER_STDOUT_AMAZON,
      'varredura',
      'WARNING',
      `[amazon] varredura de reprocessamento (${lane}) com falhas por documento`,
      {
        varredura: 'reprocesso',
        lane,
        erros: result.errors.length,
        docIds: nomeados.docIds,
        docIds_omitidos: nomeados.omitidos,
      },
      envelope,
    );
  }
}

/**
 * The backstop over BOTH lanes of `notificacoesAmazon`, on one tick: first the
 * hot lane (`failed` rows older than an hour), then the deferred lane (the read
 * switch off, an unknown seller, a parked or inactive conta, a missing
 * credential, the empty importer seam), `LIMITE_POR_RAIA_AMAZON` rows each.
 *
 * It runs the SAME pipeline as the queue, inline — the same context, the same
 * read switch, the same importer seam (`depsDeLeituraAmazon`) — so a re-drive
 * answers exactly what the task would have.
 *
 * The two lanes are logged SEPARATELY, never summed: they answer different
 * questions ("is processing healthy" vs "how many notifications still wait on a
 * precondition"), and a sum would hide a growing deferred backlog inside a
 * healthy `processed`.
 *
 * `10,40`: twice an hour, staggered off the on-the-half-hour cron of the other
 * channels' reprocess sweeps. 540 s: up to twenty rows processed SEQUENTIALLY, each of which may make an LWA
 * refresh and an SP-API read once the read switch and the importer are on — the
 * gen2 60 s default cannot absorb that. The LWA client secret is bound for the
 * same reason as on the queue.
 */
export const reprocessAmazonNotifications = onSchedule(
  {
    schedule: '10,40 * * * *',
    timeZone: 'America/Sao_Paulo',
    timeoutSeconds: 540,
    secrets: [...SEGREDOS_DE_LEITURA_AMAZON],
  },
  async () => {
    const db = getDb();
    const deps = depsDeLeituraAmazon();

    const marcaQuente = readCacheMark();
    const quente = await reprocessarNotificacoesAmazon(db, { limit: LIMITE_POR_RAIA_AMAZON }, deps);
    registrarRaia('hot', quente, marcaQuente);

    const marcaAdiada = readCacheMark();
    const adiada = await reprocessarAdiadasAmazon(db, { limit: LIMITE_POR_RAIA_AMAZON }, deps);
    registrarRaia('deferred', adiada, marcaAdiada);
  },
);

/**
 * The expiry sweep's result, FLATTENED to primitives for its one line. The
 * per-entry `erros` are counted and their CLASS names joined (the body records
 * the class, never a message: `conta/expiracaoSweep.ts`); the conta and aviso
 * ids stay out of the line.
 */
function camposDaExpiracao(r: ExpiracaoSweepAmazonResult): Record<string, CampoLogAmazon> {
  const segredo = r.segredo;
  return {
    varredura: 'expiracao',
    contas: r.contas,
    inativas: r.inativas,
    semCredencial: r.semCredencial,
    estacionadas: r.estacionadas,
    reautorizacao_avisados: r.reautorizacao.avisados,
    reautorizacao_resolvidos: r.reautorizacao.resolvidos,
    reconexao_avisados: r.reconexao.avisados,
    reconexao_resolvidos: r.reconexao.resolvidos,
    orfaos_lidos: r.orfaos.lidos,
    orfaos_paginas: r.orfaos.paginas,
    orfaos_truncado: r.orfaos.truncado,
    orfaos_resolvidos: r.orfaos.resolvidos,
    segredo_acao: segredo.acao,
    segredo_dias: segredo.acao === 'avisado' || segredo.acao === 'resolvido' ? segredo.dias : null,
    erros: r.erros.length,
    erros_classes: r.erros.length === 0 ? null : [...new Set(r.erros.map((e) => e.erro))].join(','),
  };
}

/**
 * The DAILY expiry sweep (the step-2 body, `conta/expiracaoSweep.ts`): walks
 * every Amazon conta, raises the reauthorization and reconnection avisos at
 * the 30-day horizon and resolves them once a new grant lands, closes the
 * orphaned rows of contas that no longer exist, and — only while the read
 * switch is on — warns about the app's LWA client secret
 * (`AMAZON_LWA_SEGREDO_EXPIRA_EM`).
 *
 * It makes NO Amazon call: it reads only the stored credential and writes only
 * avisos, so it binds NO secret — a declared secret missing from Secret
 * Manager would fail the whole deploy for a function that never reads it.
 *
 * Daily, because the horizons are calendar days; 07:15 São Paulo, off every
 * other channel's daily sweep.
 */
export const sweepAmazonExpirations = onSchedule(
  {
    schedule: '15 7 * * *',
    timeZone: 'America/Sao_Paulo',
    // One Firestore round trip per conta plus up to five pages of open avisos,
    // sequentially — the gen2 60 s `onSchedule` default cannot absorb that.
    timeoutSeconds: 120,
  },
  async () => {
    const result = await sweepAmazonExpiracoes(getDb(), {
      // Injected because `packages/data/src/admin/**` may only `import type`
      // from firebase-admin — the aviso counter is a tier-0 FieldValue, so two
      // producers landing together cannot lose each other's bump.
      increment: (by: number) => FieldValue.increment(by),
      nowMs: Date.now(),
      ambiente: process.env,
      logger: LOGGER_STDOUT_AMAZON,
    });
    registrarEventoAmazon(
      LOGGER_STDOUT_AMAZON,
      'varredura',
      result.erros.length > 0 ? 'WARNING' : 'INFO',
      '[amazon] varredura de expiração',
      camposDaExpiracao(result),
    );
  },
);
