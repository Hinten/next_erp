/**
 * The ONE region resolver every Mercado Livre Cloud Tasks queue in this app
 * shares, and the queue-path builder on top of it.
 *
 * ⚠️ **Cloud Tasks and Cloud Scheduler do not exist in `us-east5`** (both
 * services stop at `us-east4` in the eastern US), which is why the ML functions
 * codebase — all fifteen functions, the four Firestore triggers included —
 * deploys to `us-east1` and not to the ML backend's own region. Queues and
 * schedules could not live in `us-east5` at all; the triggers follow them
 * because Firebase imposes no hard region match on a Firestore trigger, and one
 * region for one codebase beats saving a cross-region hop on four of them.
 *
 * ⚠️ It must still never fall back to `FUNCTIONS_REGION`. The two normally hold
 * the same value today, but they are set independently — only this one is read
 * by the App Hosting backend — so a fallback would silently paper over a
 * genuine mismatch. That is what it did before: on a backend whose
 * `FUNCTIONS_REGION` named a region without Cloud Tasks, every enqueue resolved
 * a queue that cannot exist, and the Admin SDK then targeted `us-central1`.
 *
 * ⚠️ It lives in its own module because it was previously copied into each
 * scheduler, and #1108 fixed exactly one of the five copies — the notification
 * one — leaving the mass-import, stock, price-sync and NF-e upload queues
 * pointing at `us-east5`. `mlTasksRegion.test.ts` is the drift backstop: it
 * asserts all five enqueuers resolve the SAME region.
 *
 * The value must match `MERCADO_LIVRE_TASKS_REGION` on the App Hosting backend
 * (Cloud Run does not expose its own region as an env var, only the metadata
 * server does, so it has to be configured) — see `functions/DEPLOY.md`.
 */

/** Region every ML task queue and its `onTaskDispatched` function live in. */
export function mlTasksRegion(): string {
  return process.env.MERCADO_LIVRE_TASKS_REGION?.trim() || 'us-east1';
}

/**
 * The region-qualified queue name `getFunctions().taskQueue()` expects. The
 * qualification is mandatory: an unqualified name makes the Admin SDK default
 * to `us-central1` and the task is SILENTLY DROPPED.
 *
 * Also the operator-facing description of where an enqueue was aimed — the
 * `/importar-todos` failure path puts it in the 503 body so the next region
 * mismatch names itself instead of surfacing as a bare RPC error.
 */
export function mlQueuePath(queueName: string): string {
  return `locations/${mlTasksRegion()}/functions/${queueName}`;
}
