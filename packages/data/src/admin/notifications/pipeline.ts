/**
 * The shared inbound-webhook ingestion pipeline.
 *
 * Three stages, one core. A channel supplies only what is genuinely its own —
 * the collection, the payload shape, and `process` — and gets the resilience
 * behaviour (retry disposition, dead-lettering, the durable-cursor sweep) for
 * free and identical everywhere.
 *
 * ```
 * 1. RECEIVER   parse the raw POST → enqueue the lean payload → ack 200 fast.
 *               NO Firestore write on the happy path. If the ENQUEUE itself
 *               fails, `persistFailure` records it so the sweep drains it —
 *               the provider must never see a 5xx during an enqueue outage
 *               (some disable a topic after repeated 5xx).
 * 2. TASK       `handleTask` runs inside `onTaskDispatched`. Deterministic
 *               outcomes are disposed of immediately; a TRANSIENT failure is
 *               re-thrown so the queue retries with backoff, and only on the
 *               FINAL attempt is it persisted (a throw there would drop it).
 * 3. SWEEP      `reprocess` runs inside `onSchedule`. It re-drives every
 *               `failed` doc older than the window — an account may have
 *               connected, an outage cleared — deleting on resolution and
 *               parking at the retry cap.
 * ```
 *
 * The contract `process` must honour: **deterministic outcomes RETURN, transient
 * failures THROW.** That single rule is what lets the same function serve both a
 * fresh queued task and a sweep re-drive without knowing which it is in.
 *
 * ## TRANSIENT-BOUNDARY note (why the catches narrow on bare `Error`)
 *
 * Three catches here test `err instanceof Error` and nothing more, which
 * normally warrants the `delfrance/no-error-as-sole-instanceof` warning — the
 * repo's rule that `Error` narrows nothing. They carry a scoped disable because
 * here the breadth IS the specification, not an oversight:
 *
 *  - by the contract above, `process` RETURNS every deterministic outcome, so
 *    anything it THROWS is transient and retryable **whatever class it is**;
 *  - this is generic infrastructure — it cannot enumerate the error classes of
 *    channels that don't exist yet (a provider SDK's own type, a gRPC wrapper),
 *    and narrowing to today's classes would silently swallow tomorrow's;
 *  - the one thing that must NOT be treated as transient — a non-`Error` throw,
 *    which is always a coding bug — is re-thrown on the first line of each catch.
 *
 * A CHANNEL's `process` must still narrow properly on its own error classes.
 * This exemption stops at the boundary.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { z } from 'zod';

import type { AdminCollectionHandle } from '../defineAdminCollection';
import { createNotificationStore } from './store';
import {
  MAX_TENTATIVAS,
  ONE_HOUR_MS,
  type NotificationDisposition,
  type NotificationPhase,
  type NotificationStatus,
  type ReprocessOptions,
  type ReprocessResult,
  TASK_MAX_ATTEMPTS,
} from './types';

export interface NotificationPipelineConfig<TPayload, TOutcome> {
  /** Log prefix, e.g. `'mercado-livre'`. Rendered as `[mercado-livre] …`. */
  channel: string;
  /** The channel's failures-only `notificacoes*` collection handle. */
  collection: AdminCollectionHandle<z.ZodTypeAny>;
  /**
   * Re-validates the payload on the far side of the Cloud Tasks wire boundary
   * (belt-and-suspenders — the producer already validated it). A parse failure
   * is a coding/enqueue bug, never a provider problem, so it DROPS: no persist,
   * no retry, nothing to re-drive.
   */
  taskSchema: z.ZodType<TPayload>;
  /** Provider event id → Firestore doc id. Null ⇒ mint an auto id. */
  docIdOf(payload: TPayload): string | null;
  /**
   * In-run sweep dedup key (ML `resource`, MP `paymentId`, WA `messageId`).
   * A duplicate within one run is SKIPPED, not deleted — it stays for a later
   * run in case the first copy's processing turns out not to cover it.
   */
  dedupKeyOf(payload: TPayload): string | null;
  /** The wire fields written onto a persisted failure doc. */
  toDocFields(payload: TPayload): Record<string, unknown>;
  /** Rehydrate a payload from a swept doc (`parsed` is soft-read, `raw` is verbatim). */
  fromDoc(parsed: unknown, raw: Record<string, unknown>): TPayload;
  /** The channel's work. Deterministic outcomes RETURN; transient failures THROW. */
  process(db: Firestore, payload: TPayload): Promise<TOutcome>;
  /**
   * Map the channel's outcome onto the shared disposition vocabulary. The
   * `payload` is passed too, because most channels build their operator-facing
   * `reason` from the wire fields (the seller id that matched no account, the
   * unsupported topic) rather than from the outcome.
   *
   * ⚠️ The `phase` argument is load-bearing, not decoration. A terminal
   * non-error can warrant different handling depending on whether a document
   * exists yet: Mercado Livre treats an unparseable `resource` as `drop` in the
   * task (nothing to create) but `park` in the sweep (a row already exists and
   * is KEPT as an audit trail rather than deleted). Collapsing the two would
   * silently start deleting rows that used to be parked.
   *
   * This is also the natural place for a channel's own drop/park logging — it
   * is called exactly once per outcome per phase.
   */
  toDisposition(
    outcome: TOutcome,
    payload: TPayload,
    phase: NotificationPhase,
  ): NotificationDisposition;
}

/**
 * What the queued-task handler reports. Deliberately minimal: each channel maps
 * this onto its own public `TaskResult` shape (adding the account id, topic,
 * field, … its callers log), so the shared core never has to know those names.
 */
export interface NotificationTaskResult<TPayload, TOutcome> {
  outcome: 'done' | 'failed' | 'parked' | 'dropped';
  /** The validated payload — absent only when the payload itself failed to parse. */
  payload?: TPayload;
  /** The channel's own outcome — absent when the task never reached `process`. */
  result?: TOutcome;
}

export interface NotificationPipeline<TPayload, TOutcome> {
  /**
   * Persist a notification as `failed` so the sweep re-drives it. The RECEIVER
   * calls this as its enqueue-failure fallback; the task handler calls it on a
   * final-attempt transient failure.
   */
  persistFailure(db: Firestore, payload: TPayload, erro: string): Promise<void>;
  /** Persist a notification as `parked` (terminal — the sweep never re-drives it). */
  persistParked(db: Firestore, payload: TPayload, erro: string): Promise<void>;
  /** The `onTaskDispatched` body. `retryCount` is the 0-based attempt index. */
  handleTask(
    db: Firestore,
    data: unknown,
    retryCount: number,
  ): Promise<NotificationTaskResult<TPayload, TOutcome>>;
  /** The `onSchedule` backstop. */
  reprocess(db: Firestore, opts?: ReprocessOptions): Promise<ReprocessResult>;
}

/** The counter key a resolved/dropped disposition increments in `outcomes`. */
function labelOf(d: NotificationDisposition & { kind: 'resolve' | 'drop' }): string {
  return d.label ?? (d.kind === 'resolve' ? 'done' : 'dropped');
}

export function defineNotificationPipeline<TPayload, TOutcome>(
  config: NotificationPipelineConfig<TPayload, TOutcome>,
): NotificationPipeline<TPayload, TOutcome> {
  const store = createNotificationStore<TPayload>(config);
  const { channel, collection } = config;

  const persistFailure = (db: Firestore, payload: TPayload, erro: string): Promise<void> =>
    store.create(db, payload, 'failed', 0, erro);
  const persistParked = (db: Firestore, payload: TPayload, erro: string): Promise<void> =>
    store.create(db, payload, 'parked', 0, erro);

  return {
    persistFailure,
    persistParked,

    async handleTask(db, data, retryCount) {
      const parsed = config.taskSchema.safeParse(data);
      if (!parsed.success) return { outcome: 'dropped' }; // coding/enqueue bug — drop
      const payload = parsed.data;

      let result: TOutcome;
      try {
        result = await config.process(db, payload);
        // A bare `Error` is the deliberate contract at this catch, not a missed
        // narrowing — see the TRANSIENT-BOUNDARY note in this module's header.
        // eslint-disable-next-line delfrance/no-error-as-sole-instanceof
      } catch (err) {
        // Transient (Firestore / provider API / network). Retry in-task until
        // the final attempt; then persist `failed` so the sweep re-drives it —
        // a throw on the LAST attempt would drop the notification entirely.
        if (!(err instanceof Error)) throw err;
        if (retryCount < TASK_MAX_ATTEMPTS - 1) throw err; // let the queue retry with backoff
        try {
          await persistFailure(db, payload, err.message);
        } catch (persistErr) {
          // A *correlated* outage — the very Firestore whose failure we are
          // recovering from also refused the record. We cannot note it locally:
          // log the dropped notification and re-throw the ORIGINAL error so the
          // failed final attempt still surfaces in Cloud Tasks' error metrics.
          if (!(persistErr instanceof Error)) throw persistErr;
          console.error(
            `[${channel}] notification DROPPED — transient failure AND persist failed on the final attempt`,
            {
              docId: config.docIdOf(payload),
              cause: err.message,
              persistError: persistErr.message,
            },
          );
          throw err; // surface the original failure to Cloud Tasks
        }
        return { outcome: 'failed', payload };
      }

      const disposition = config.toDisposition(result, payload, 'task');
      if (disposition.kind === 'fail') {
        await persistFailure(db, payload, disposition.reason);
        return { outcome: 'failed', payload, result };
      }
      if (disposition.kind === 'park') {
        await persistParked(db, payload, disposition.reason);
        return { outcome: 'parked', payload, result };
      }
      if (disposition.kind === 'drop') {
        return { outcome: 'dropped', payload, result };
      }
      // resolve — NOTHING persisted (the cost win).
      return { outcome: 'done', payload, result };
    },

    async reprocess(db, opts = {}) {
      const now = opts.now ?? Date.now();
      const cutoff = now - (opts.olderThanMs ?? ONE_HOUR_MS);

      const snap = await store.pending(db, cutoff, opts.limit).get();

      const seen = new Set<string>();
      const outcomes: Record<string, number> = {};
      const errors: Array<{ docId: string; message: string }> = [];
      let processed = 0;

      for (const d of snap.docs) {
        const raw = d.data() as Record<string, unknown>;

        const parsedDoc = collection.parseRead(raw, collection.docPath({}, d.id));
        const payload = config.fromDoc(parsedDoc, raw);

        const dedupKey = config.dedupKeyOf(payload);
        if (dedupKey && seen.has(dedupKey)) continue; // dup within this run — leave it for a later one
        if (dedupKey) seen.add(dedupKey);

        const tentativas = ((parsedDoc as { tentativas?: number }).tentativas ?? 0) + 1;

        try {
          const result = await config.process(db, payload);
          const disposition = config.toDisposition(result, payload, 'sweep');

          let label: string;
          if (disposition.kind === 'resolve' || disposition.kind === 'drop') {
            // Settled, or no longer ours to process — leave the failures store.
            await store.remove(db, d.id);
            label = labelOf(disposition);
          } else if (disposition.kind === 'park') {
            // Terminal — keep the row as an audit trail, never re-drive it.
            await store.mark(db, d.id, 'parked', tentativas, disposition.reason, now);
            label = 'parked';
          } else {
            // Still failing — re-drive until the cap, then park.
            const status: NotificationStatus = tentativas >= MAX_TENTATIVAS ? 'parked' : 'failed';
            await store.mark(db, d.id, status, tentativas, disposition.reason, now);
            label = status;
          }
          outcomes[label] = (outcomes[label] ?? 0) + 1;
          processed += 1;
          // See the TRANSIENT-BOUNDARY note in this module's header.
          // eslint-disable-next-line delfrance/no-error-as-sole-instanceof
        } catch (err) {
          // Batch-isolation boundary: a transient failure on ONE notification
          // must never abort the sweep. Bump tentativas (parking at the cap);
          // if even that mark write fails, collect and move on. Non-Error
          // throws still propagate — they are coding bugs, not outages.
          if (!(err instanceof Error)) throw err;
          try {
            const status: NotificationStatus = tentativas >= MAX_TENTATIVAS ? 'parked' : 'failed';
            await store.mark(db, d.id, status, tentativas, err.message, now);
            // This doc is lost to the run either way; the only job here is to stop
            // a second failure from masking the first one we are about to report.
            // eslint-disable-next-line delfrance/no-error-as-sole-instanceof
          } catch (markErr) {
            if (!(markErr instanceof Error)) throw markErr;
          }
          errors.push({ docId: d.id, message: err.message });
        }
      }

      return { processed, outcomes, errors };
    },
  };
}
