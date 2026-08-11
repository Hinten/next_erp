/**
 * Shared vocabulary for the inbound-webhook notification pipeline.
 *
 * Every channel that receives asynchronous marketplace/provider events runs the
 * same three-stage design (see `pipeline.ts` for the full flow and
 * `.claude/skills/webhook-notifications/`):
 *
 *   receiver → ENQUEUE + ack 200 fast (no Firestore write on the happy path)
 *            → `onTaskDispatched` handler (retry with backoff)
 *            → `onSchedule` sweep (durable-cursor backstop over `processedAt`),
 *              which drains TWO lanes: the hourly `failed` one and the daily
 *              `deferred` one (#808)
 *
 * A document is persisted ONLY when a notification can't be processed; a
 * success writes nothing. That is deliberate — the earlier persist-first design
 * cost a Firestore write per notification and an ungated create-trigger gave no
 * control over the upstream API call rate.
 */

/** In-task retry cap — mirrors the Cloud Tasks `retryConfig.maxAttempts`. */
export const TASK_MAX_ATTEMPTS = 3;

/** Cross-sweep reprocess cap — after this many sweeps a `failed` doc is parked. */
export const MAX_TENTATIVAS = 5;

/**
 * The DEFERRED lane's cap (#808). A deferred doc is re-driven once a day, so
 * this is a horizon in days: seven of them, enough to cover a weekend or a
 * holiday between a notification arriving and its seller connecting the account.
 *
 * It can be this much larger than {@link MAX_TENTATIVAS} precisely because the
 * lane is slow AND cheap: a still-deferred doc costs one indexed lookup per day
 * and never touches the provider's API.
 */
export const MAX_TENTATIVAS_DEFERRED = 7;

/** One hour — the default sweep window (the legacy reprocess interval). */
export const ONE_HOUR_MS = 60 * 60 * 1000;

/** One day — the default window of the deferred lane, i.e. its per-doc cadence. */
export const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/** Default page size for one sweep run. */
export const DEFAULT_REPROCESS_LIMIT = 50;

/**
 * The persisted local processing state. A success is never persisted at all.
 *
 * `failed` and `deferred` are two RETRY LANES over the same collection, told
 * apart by this field alone — see {@link NotificationDisposition}. `parked` is
 * terminal in both.
 */
export type NotificationStatus = 'failed' | 'parked' | 'deferred';

/**
 * The normalized outcome vocabulary the shared pipeline understands. Each
 * channel maps its own `ProcessOutcome` union onto this via
 * `NotificationPipelineConfig.toDisposition`.
 *
 * | disposition | in the queued task          | in the HOT sweep               | in the DEFERRED sweep            |
 * | ----------- | --------------------------- | ------------------------------ | -------------------------------- |
 * | `resolve`   | persist nothing             | DELETE the doc (it's settled)  | DELETE the doc                   |
 * | `drop`      | persist nothing             | DELETE the doc (not ours)      | DELETE the doc                   |
 * | `park`      | create `status: 'parked'`   | mark `parked` (terminal)       | mark `parked` (terminal)         |
 * | `fail`      | create `status: 'failed'`   | mark `failed`, park at the cap | RE-DRIVE into the hot lane       |
 * | `defer`     | create `status: 'deferred'` | mark `deferred` (leaves the    | mark `deferred`, park at         |
 * |             |                             | hot lane)                      | `MAX_TENTATIVAS_DEFERRED`        |
 *
 * ⚠️ `resolve` and `drop` produce identical WRITES; they differ in the queued
 * task's reported outcome (`done` vs `dropped`). Keep both — the distinction is
 * what an operator reads off a sweep's `outcomes` map to tell "we settled it"
 * from "it was never ours".
 *
 * ⚠️ `fail` vs `defer` is NOT a severity dial — it is a statement about WHO can
 * clear the blockage. `fail` means "we could not do it, try again shortly";
 * `defer` means "a precondition outside this system is not met yet" (Mercado
 * Livre's seller has not connected their account, #808). A deferred doc leaves
 * the hot pool entirely, so it burns no hourly retries and crowds out no genuine
 * failure, and it gets a horizon in DAYS instead of hours. Using `fail` for a
 * precondition is exactly the bug #808 fixed: the notification parked ~6 h in
 * and was never re-driven again.
 *
 * A `fail` in the deferred lane means the precondition finally cleared and the
 * work itself failed — so the doc GRADUATES back to the hot lane with a fresh
 * retry budget rather than counting against the deferred horizon.
 *
 * `label` overrides the counter key a disposition increments in
 * `ReprocessResult.outcomes`, so a channel keeps its own operator-facing
 * vocabulary (`reconciled`, `processed`, …). It defaults to `done` / `dropped` /
 * `parked` per arm; `fail` and `defer` have no label because their key is
 * decided by the retry cap (`failed`/`deferred` below it, `parked` at it).
 */
export type NotificationDisposition =
  | { kind: 'resolve'; label?: string }
  | { kind: 'drop'; reason?: string; label?: string }
  | { kind: 'park'; reason: string }
  | { kind: 'fail'; reason: string }
  | { kind: 'defer'; reason: string };

/**
 * Which stage is asking for a disposition. This is NOT cosmetic: a channel can
 * legitimately want a terminal non-error handled differently depending on
 * whether a document exists yet.
 *
 * Mercado Livre is the live example — an unparseable `resource` is `drop` in the
 * task (nothing to create) but `park` in the sweep (a row already exists and is
 * kept as an audit trail rather than deleted).
 *
 * Deliberately TWO values, not three: the deferred lane also asks as `'sweep'`,
 * because the question a channel answers here is "does a document exist yet",
 * and in both sweeps it does. Adding a third value would force every channel's
 * `toDisposition` to grow a case that answers identically to one it already has.
 */
export type NotificationPhase = 'task' | 'sweep';

/** What the `onTaskDispatched` handler reports back to its caller. */
export interface TaskResult {
  outcome: 'done' | 'failed' | 'parked' | 'dropped' | 'deferred';
  /** Channel-supplied context for the caller's log line (account id, topic, …). */
  context?: Record<string, unknown>;
}

export interface ReprocessOptions {
  /**
   * Only re-drive notifications last attempted before `now - olderThanMs`.
   * Defaults to {@link ONE_HOUR_MS} in the hot lane and {@link ONE_DAY_MS} in
   * the deferred one — in both cases this window IS the per-doc cadence, since
   * `processedAt` is re-stamped on every attempt.
   */
  olderThanMs?: number;
  /** Max docs examined in one run. */
  limit?: number;
  /** Injectable clock (tests). */
  now?: number;
}

export interface ReprocessResult {
  processed: number;
  outcomes: Record<string, number>;
  errors: Array<{ docId: string; message: string }>;
}
