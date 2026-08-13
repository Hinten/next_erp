// Import side-effect first: registers global function options (region) before
// any trigger is defined. See options.ts.
import './options';

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';

import {
  WHATSAPP_NOTIFICATION_QUEUE,
  reprocessNotifications,
} from '../../lib/whatsapp/notificacao';
import { sweepStaleOutbound } from '../../lib/whatsapp/outbound';
import { readCacheDelta, readCacheMark } from '@delfrance/data/admin/cache';
import { getDb } from './lib/admin';
import * as notificationHandlers from './processNotification';

/**
 * WhatsApp Cloud API Cloud Functions (gen2), codebase `whatsapp`. Deployed as a
 * deploy-artifact sub-build of `@delfrance/whatsapp-app` (see
 * scripts/prepare-deploy.mjs + firebase.whatsapp.deploy.json).
 *
 * #527 wires the resilient inbound notification pipeline as a **Cloud Tasks
 * queue** (`processWhatsappNotification`, ./processNotification) + an
 * `onSchedule` reprocess sweep. Mirrors apps/mercado-pago/functions, adapted
 * payments → whatsapp.
 *
 * #529 adds the OUTBOUND send path: `sendOutbound` (`./sendOutbound`, an
 * `onDocumentCreated` on `chat/{conversaId}/mensagem/{mensagemId}`) transmits
 * operator/auto-reply messages via the Cloud API, plus `reprocessStaleOutbound`
 * (`onSchedule`) as the stuck-`salva` backstop. Both delegate to the pure
 * disposition in `lib/whatsapp/outbound.ts`.
 */

// Rename-safety: the DEPLOYED function name is the export KEY of the handler
// below, and the receiver enqueues against `WHATSAPP_NOTIFICATION_QUEUE`.
// ESM export names must be static literals (you can't compute an `export const`
// name), so instead of deriving one from the other we assert — at module load,
// i.e. during Firebase's deploy codebase-analysis — that they never drifted. A
// rename that updates only one side fails the deploy loudly here instead of
// silently enqueuing onto a queue that doesn't exist.
if (!(WHATSAPP_NOTIFICATION_QUEUE in notificationHandlers)) {
  throw new Error(
    `[whatsapp] function-name drift: functions/src/processNotification.ts must export a ` +
      `handler named '${WHATSAPP_NOTIFICATION_QUEUE}' (the enqueue target). ` +
      `Rename the export and the WHATSAPP_NOTIFICATION_QUEUE constant together.`,
  );
}

/** The queue-based notification processor (rate-limited, retry-with-backoff). */
export { processWhatsappNotification } from './processNotification';

/**
 * The outbound send trigger (#529) — an `onDocumentCreated` bound to the
 * `chat/{conversaId}/mensagem/{mensagemId}` path. (The drift assert above guards
 * only the enqueue-target QUEUE name; this trigger is bound by Eventarc to a
 * document path, not a queue string, so it needs none.)
 */
export { sendOutbound } from './sendOutbound';

/**
 * Reprocess backstop: re-drives persisted `failed` notifications older than 1h
 * (the queued task exhausted its retries, or a not-yet-linked account has since
 * connected). Runs each inline, per-doc isolated, deduped by `messageId`,
 * bounded — success deletes the doc, a persistent failure parks it at the cap.
 * Mirrors apps/mercado-pago's `reprocessMercadoPagoNotifications`.
 */
export const reprocessWhatsappNotifications = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'America/Sao_Paulo' },
  async () => {
    const cacheMark = readCacheMark();
    const result = await reprocessNotifications(getDb());
    logger.info('[whatsapp] reprocess sweep', {
      processed: result.processed,
      outcomes: result.outcomes,
      errorCount: result.errors.length,
      // Read-cache hits/misses accrued by THIS tick. Reports the SWEEP process's
      // caches, not the task consumer's — they are separate deployments.
      readCache: readCacheDelta(cacheMark),
    });
    if (result.errors.length > 0) {
      logger.warn('[whatsapp] reprocess sweep had per-doc failures', {
        errors: result.errors.slice(0, 10),
      });
    }
  },
);

/**
 * Outbound send backstop (#529): re-drives outbound mensagens stuck in `salva`
 * older than 10 min — a `sendOutbound` trigger that never fired, threw before
 * patching, or lost its ack. Collection-group query over `mensagem`
 * (`estadoEnvio == salva AND timestamp < cutoff`), each re-run through the pure
 * disposition (non-WhatsApp conversas drop on the fast-path). Bounded + per-doc
 * isolated. Faster than the 15-min cadence would suggest since Eventarc's own
 * `retry: true` handles most transient failures first; this catches the rest.
 */
export const reprocessStaleOutbound = onSchedule(
  { schedule: 'every 15 minutes', timeZone: 'America/Sao_Paulo' },
  async () => {
    const cacheMark = readCacheMark();
    const result = await sweepStaleOutbound(getDb());
    logger.info('[whatsapp] reprocessStaleOutbound sweep', {
      processed: result.processed,
      outcomes: result.outcomes,
      errorCount: result.errors.length,
      // Read-cache hits/misses accrued by THIS tick. Reports the SWEEP process's
      // caches, not the task consumer's — they are separate deployments.
      readCache: readCacheDelta(cacheMark),
    });
    if (result.errors.length > 0) {
      logger.warn('[whatsapp] reprocessStaleOutbound had per-doc failures', {
        errors: result.errors.slice(0, 10),
      });
    }
  },
);
