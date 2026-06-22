import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { runProcessarPendentes } from '../../lib/nfe/handlers/runProcessarPendentes';
import { getNFeRuntime } from '../../lib/nfe/runtime';
import { safeErrorShape } from '../../lib/nfe/log';
import { getDb } from './lib/admin';

/**
 * Backstop sweep for the async NF-e reconciler (#77) — runs the
 * `processar-pendentes` core **in-process** every 30 min (08:00–19:00 Mon–Fri,
 * America/São_Paulo). Catches lost reconcile tasks, pre-existing stuck docs, and
 * transmits approved EPECs once the filial leaves contingency (`transmitirPosEpec`
 * — which signs + emits, so this function needs `NFE_CERT_ENC_KEY` and, in prod,
 * `NFE_ALLOW_PRODUCAO`). Gated per-doc by `proximaConsultaEm`, so it never
 * consults ahead of a task's schedule. Per-doc errors are reported, not thrown.
 */
export const nfeReconcileSweep = onSchedule(
  {
    schedule: '0,30 8-19 * * 1-5',
    timeZone: 'America/Sao_Paulo',
    // Same cert master key as reconciliarNfe — the sweep resolves filial certs
    // (and the EPEC branch signs). Set: `firebase functions:secrets:set NFE_CERT_ENC_KEY`.
    secrets: ['NFE_CERT_ENC_KEY'],
  },
  async () => {
    const fs = getDb();
    let baseRt;
    try {
      baseRt = getNFeRuntime();
    } catch (e) {
      logger.error('nfeReconcileSweep: runtime not ready', safeErrorShape(e));
      throw e; // surface the misconfig; the next tick retries
    }

    const result = await runProcessarPendentes({ fs, baseRt, params: {} });
    logger.info(
      `nfeReconcileSweep scanned=${result.scanned} recovered=${result.recovered} ` +
        `stillPending=${result.stillPending} errors=${result.errors.length}`,
    );
    if (result.errors.length > 0) {
      // Per-doc failures (already isolated) — log a redacted summary for ops.
      logger.warn(
        'nfeReconcileSweep per-doc errors',
        result.errors.map((e) => ({ chave: e.chave, error: e.error })),
      );
    }
  },
);
