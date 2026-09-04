import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import {
  WHATSAPP_NOTIFICATION_QUEUE,
  TASK_MAX_ATTEMPTS,
  handleNotificationTask,
} from '../../lib/whatsapp/notificacao';
import { getDb } from './lib/admin';
import { readCacheSummary } from '@delfrance/data/admin/cache';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * Cloud Tasks dispatcher for WhatsApp Cloud API webhook notifications (#527).
 * The receiver (App Hosting route) enqueues the lean per-change payload onto
 * this function's auto-provisioned queue; the queue dispatches here and runs
 * the work **in-process** (no HTTP hop, no OIDC) at a rate bounded by
 * `rateLimits`.
 *
 * `retryConfig.maxAttempts` mirrors `TASK_MAX_ATTEMPTS`: the handler retries a
 * transient failure with backoff, and on the FINAL attempt persists it as
 * `failed` (so the `onSchedule` sweep re-drives it) instead of throwing — the
 * throw/persist disposition lives in `handleNotificationTask` so it stays
 * unit-testable. The happy path persists NOTHING (the cost win).
 *
 * ⚠️ The export name below IS the deployed function + queue name — it MUST equal
 * `WHATSAPP_NOTIFICATION_QUEUE` (the receiver enqueues against that string).
 * Rename both together, or the enqueue targets a non-existent queue (silent drop).
 */
export const processWhatsappNotification = onTaskDispatched(
  {
    // roles/run.invoker on this service + roles/cloudtasks.enqueuer on its
    // queue, applied at deploy time from TASKS_INVOKER_SA. Absent when unset.
    ...tasksInvokerOptions(),
    retryConfig: {
      maxAttempts: TASK_MAX_ATTEMPTS,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxDoublings: 2,
    },
    rateLimits: { maxConcurrentDispatches: 3, maxDispatchesPerSecond: 5 },
  },
  async (req) => {
    // ⚠️ NARROW cast, never a spread. `req.data.value` is the raw change body and
    // carries MESSAGE CONTENT — naming only these two keys is what keeps it
    // unreachable from this scope. `messageId` is Meta's opaque wamid and
    // `phoneNumberId` is OUR business number id; the customer's own phone
    // (`contacts[].wa_id` / `messages[].from`) is never logged.
    //
    // Read off the RAW payload, not the `TaskResult`: these two survive the
    // shared pipeline's schema-parse drop, where there is no validated payload
    // and no channel result at all — the case an operator most needs named.
    const payload = req.data as { messageId?: unknown; phoneNumberId?: unknown } | null;
    const result = await handleNotificationTask(getDb(), req.data, req.retryCount ?? 0);
    // ⚠️ `outcome` alone is not enough, and that gap is not theoretical: on
    // Mercado Livre's first live run this line reported a bare success for every
    // delivery while nothing was being written, because `done` is the
    // disposition for BOTH "wrote an inbound mensagem" and "found a redelivery
    // and did nothing" (#1087, fixed for ML in #1136).
    //
    // `kind` separates an unsupported-field drop from a malformed-value one and
    // both from the shared pipeline's schema-parse drop (which carries no `kind`
    // at all); `detail` says what the change actually did; `messageId` names the
    // subject, which `field` does not; `phoneNumberId` is what a park for an
    // unresolvable conta is ABOUT, and today reaches only a `console.error`.
    //
    // ONE call on purpose — the fields land in `jsonPayload` and are filterable
    // (`jsonPayload.detail="vazio"`), so more fields beat more lines. `?? null`
    // rather than leaving them undefined: Cloud Logging drops `undefined` keys,
    // so the key would vanish instead of reading as absent.
    logger.info('[whatsapp] processed notification task', {
      queue: WHATSAPP_NOTIFICATION_QUEUE,
      outcome: result.outcome,
      kind: result.kind ?? null,
      detail: result.detail ?? null,
      field: result.field ?? null,
      messageId: typeof payload?.messageId === 'string' ? payload.messageId : null,
      phoneNumberId: typeof payload?.phoneNumberId === 'string' ? payload.phoneNumberId : null,
      contaId: result.contaId ?? null,
      // Counts, not a `detail` member — one `statuses[]` can carry entries with
      // different fates. `null` when the change carried no statuses at all.
      statuses: result.statuses ?? null,
      retryCount: req.retryCount ?? 0,
      // CUMULATIVE for this instance — a notification has no tick to bracket
      // (the sweep in `index.ts` brackets its own with mark/delta instead).
      readCache: readCacheSummary(),
    });
  },
);
