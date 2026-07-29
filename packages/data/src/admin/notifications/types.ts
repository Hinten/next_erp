/**
 * Shared vocabulary for the inbound-webhook notification pipeline.
 *
 * Every channel that receives asynchronous marketplace/provider events runs the
 * same three-stage design (see `pipeline.ts` for the full flow and
 * `.claude/skills/webhook-notifications/`):
 *
 *   receiver → ENQUEUE + ack 200 fast (no Firestore write on the happy path)
 *            → `onTaskDispatched` handler (retry with backoff)
 *            → `onSchedule` sweep (durable-cursor backstop over `processedAt`)
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

/** One hour — the default sweep window (the legacy reprocess interval). */
export const ONE_HOUR_MS = 60 * 60 * 1000;

/** Default page size for one sweep run. */
export const DEFAULT_REPROCESS_LIMIT = 50;

/** The persisted local processing state. A success is never persisted at all. */
export type NotificationStatus = 'failed' | 'parked';

/**
 * The normalized outcome vocabulary the shared pipeline understands. Each
 * channel maps its own `ProcessOutcome` union onto this via
 * `NotificationPipelineConfig.toDisposition`.
 *
 * | disposition | in the queued task        | in the sweep                     |
 * | ----------- | ------------------------- | -------------------------------- |
 * | `resolve`   | persist nothing           | DELETE the doc (it's settled)    |
 * | `drop`      | persist nothing           | DELETE the doc (no longer ours)  |
 * | `park`      | create `status: 'parked'` | mark `parked` (terminal)         |
 * | `fail`      | create `status: 'failed'` | mark `failed`, park at the cap   |
 *
 * ⚠️ `resolve` and `drop` produce identical WRITES; they differ in the queued
 * task's reported outcome (`done` vs `dropped`). Keep both — the distinction is
 * what an operator reads off a sweep's `outcomes` map to tell "we settled it"
 * from "it was never ours".
 *
 * `label` overrides the counter key a disposition increments in
 * `ReprocessResult.outcomes`, so a channel keeps its own operator-facing
 * vocabulary (`reconciled`, `processed`, …). It defaults to `done` / `dropped` /
 * `parked` per arm; the `fail` arm has no label because its key is decided by
 * the retry cap (`failed` below it, `parked` at it).
 */
export type NotificationDisposition =
  | { kind: 'resolve'; label?: string }
  | { kind: 'drop'; reason?: string; label?: string }
  | { kind: 'park'; reason: string }
  | { kind: 'fail'; reason: string };

/**
 * Which stage is asking for a disposition. This is NOT cosmetic: a channel can
 * legitimately want a terminal non-error handled differently depending on
 * whether a document exists yet.
 *
 * Mercado Livre is the live example — an unparseable `resource` is `drop` in the
 * task (nothing to create) but `park` in the sweep (a row already exists and is
 * kept as an audit trail rather than deleted).
 */
export type NotificationPhase = 'task' | 'sweep';

/** What the `onTaskDispatched` handler reports back to its caller. */
export interface TaskResult {
  outcome: 'done' | 'failed' | 'parked' | 'dropped';
  /** Channel-supplied context for the caller's log line (account id, topic, …). */
  context?: Record<string, unknown>;
}

export interface ReprocessOptions {
  /** Only re-drive notifications last attempted before `now - olderThanMs`. */
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
