/**
 * The ONE region resolver every Mercado Livre Cloud Tasks queue in this app
 * shares, and the queue-path builder on top of it.
 *
 * ⚠️ This is NOT the codebase region and must never fall back to it. **Cloud
 * Tasks and Cloud Scheduler do not exist in `us-east5`** (both services stop at
 * `us-east4` in the eastern US), so the eleven `onTaskDispatched`/`onSchedule`
 * functions are pinned to `us-east1` via `TASKS_SCHEDULER_REGION`
 * (`functions/src/options.ts`) while the four Firestore triggers stay in the
 * data region. A `FUNCTIONS_REGION` fallback used to sit in each scheduler and
 * is actively harmful: on a backend where that variable names the data region,
 * every enqueue resolves a queue that does not exist, and the Admin SDK then
 * silently targets `us-central1`.
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
