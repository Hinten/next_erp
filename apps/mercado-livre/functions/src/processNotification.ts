import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import {
  MERCADO_LIVRE_NOTIFICATION_QUEUE,
  TASK_MAX_ATTEMPTS,
  handleNotificationTask,
} from '../../lib/marketplace/notificacoes/notificacao';
import { getDb } from './lib/admin';
import { readCacheSummary } from '@delfrance/data/admin/cache';
import { TASKS_SCHEDULER_REGION } from './options';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * Cloud Tasks dispatcher for ML webhook notifications (Step 6). The receiver
 * (App Hosting route) enqueues the lean payload onto this function's
 * auto-provisioned queue; the queue dispatches here and runs the work
 * **in-process** (no HTTP hop, no OIDC) at a rate bounded by `rateLimits`.
 *
 * `retryConfig.maxAttempts` mirrors `TASK_MAX_ATTEMPTS`: the handler retries a
 * transient failure with backoff, and on the FINAL attempt persists it as
 * `failed` (so the `onSchedule` sweep re-drives it) instead of throwing — the
 * throw/persist disposition lives in `handleNotificationTask` so it stays
 * unit-testable. The happy path persists NOTHING (the cost win).
 *
 * ⚠️ The export name below IS the deployed function + queue name — it MUST equal
 * `MERCADO_LIVRE_NOTIFICATION_QUEUE` (the receiver enqueues against that string).
 * Rename both together, or the enqueue targets a non-existent queue (silent drop).
 *
 * Secrets: `MERCADO_LIVRE_CLIENT_ID` / `MERCADO_LIVRE_CLIENT_SECRET` are bound on
 * THIS function (mirrors `processMassImport.ts`) because the Step 9 order-import
 * default runner (`notificacao.ts`'s `runOrderImport`) calls
 * `loadMercadoLivreContext` → `resolveChannelContext`, which refreshes the
 * account's ML access token via `mercadoLivreOAuthConfig()` (reads both env
 * vars) whenever it's near expiry — same rationale as the mass-import function.
 */
export const processMercadoLivreNotification = onTaskDispatched(
  {
    // Cloud Tasks does not exist in us-east5 — see TASKS_SCHEDULER_REGION.
    region: TASKS_SCHEDULER_REGION,
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
    secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET'],
  },
  async (req) => {
    const result = await handleNotificationTask(getDb(), req.data, req.retryCount ?? 0);
    // ⚠️ `outcome` alone is not enough, and that gap is not theoretical: on the
    // first live run this line reported a bare success for every delivery while
    // the listing status never changed, because `done` is the disposition for
    // BOTH "synced the listing" and "found no link and did nothing".
    //
    // `kind` separates a processed topic from an ignored one; `detail` carries
    // the handler's own outcome (the items sync returns an `ItemsSyncOutcome`);
    // `resource` names the listing, which `topic` does not; and `user_id`
    // matters most on `deferred`, where the reason naming it is written to
    // Firestore and would otherwise never reach a log.
    //
    // ONE call on purpose - the fields land in `jsonPayload` and are filterable
    // (`jsonPayload.detail="no-link"`), so more fields beat more lines.
    const payload = req.data as { resource?: unknown; user_id?: unknown } | null;
    logger.info('[mercado-livre] processed notification task', {
      queue: MERCADO_LIVRE_NOTIFICATION_QUEUE,
      outcome: result.outcome,
      kind: result.kind ?? null,
      detail: result.detail ?? null,
      topic: result.topic,
      resource: typeof payload?.resource === 'string' ? payload.resource : null,
      user_id: typeof payload?.user_id === 'number' ? payload.user_id : null,
      integracaoId: result.integracaoId ?? null,
      retryCount: req.retryCount ?? 0,
      // CUMULATIVE for this instance — a notification has no tick to bracket.
      // The three-reads-into-one collapse is what this line makes visible.
      readCache: readCacheSummary(),
    });
  },
);
