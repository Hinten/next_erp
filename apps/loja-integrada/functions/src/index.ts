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

import { sweepLojaIntegradaTokenExpiry as runTokenExpirySweep } from '../../lib/lojaIntegrada/conta/expiracaoSweep';
import { getDb } from './lib/admin';

/**
 * Loja Integrada Cloud Functions (gen2), codebase `loja-integrada`. Deployed as
 * a deploy-artifact sub-build of `@delfrance/loja-integrada-app` (see
 * scripts/prepare-deploy.mjs and `firebase.loja-integrada.deploy.json`, which
 * ships INERT — running it is a manual coordinated human step, root
 * `CLAUDE.md` rule 8).
 *
 * Every export below is a Cloud Function name, and the names are unique across
 * codebases (`functions-export-names.test.js`): keep the exports explicit and
 * named, never a wildcard.
 */

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
