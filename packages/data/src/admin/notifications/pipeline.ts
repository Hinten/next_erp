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
 *               `failed` doc older than the window — an outage may have cleared
 *               — deleting on resolution and parking at the retry cap.
 * 3b. SLOW LANE `reprocessDeferred`, from the SAME scheduled function, does the
 *               same over `deferred` docs on a DAILY window and a far longer cap
 *               (#808). A `defer` is not a failure: it says a precondition
 *               outside this system is not met yet — Mercado Livre's seller has
 *               not connected their account — and such a doc must not spend the
 *               hourly retry budget waiting for a human. A channel that can
 *               OBSERVE the precondition clearing also calls `redrive` to pull
 *               the doc back into the hot lane immediately.
 * ```
 *
 * The contract `process` must honour: **deterministic outcomes RETURN, transient
 * failures THROW.** That single rule is what lets the same function serve a fresh
 * queued task, a hot re-drive and a deferred re-drive without knowing which it is
 * in — all three call it identically and only the disposition differs.
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
  MAX_TENTATIVAS_DEFERRED,
  ONE_DAY_MS,
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
   * ⚠️ Reach for `defer` rather than `fail` when the blocker is a PRECONDITION
   * this system does not control and a human may clear later — an account that
   * is not connected yet, a credential that has to be re-granted. `fail` gives
   * such a doc an hours-long horizon and then parks it forever, which is #808.
   * Genuine work that failed and should be retried shortly stays `fail`.
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
  outcome: 'done' | 'failed' | 'parked' | 'dropped' | 'deferred';
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
  /** The `onSchedule` backstop over the HOT lane (`failed`, hourly). */
  reprocess(db: Firestore, opts?: ReprocessOptions): Promise<ReprocessResult>;
  /**
   * The `onSchedule` backstop over the DEFERRED lane (`deferred`, daily). Same
   * loop, same `process`, different window and cap — see `NotificationStatus`.
   * Call it from the same scheduled function as `reprocess`: the 24 h window is
   * itself the cadence gate, so running it every 30 minutes costs one indexed
   * query that returns nothing 47 times out of 48.
   */
  reprocessDeferred(db: Firestore, opts?: ReprocessOptions): Promise<ReprocessResult>;
  /**
   * Move one doc back into the hot lane, for a channel that can observe the
   * deferred precondition clearing (Mercado Livre watches `integracao` for the
   * seller id being stamped). Resolves `false` when the doc was already gone.
   *
   * This is a LATENCY optimisation layered on `reprocessDeferred`, never a
   * replacement for it: a channel that cannot observe the event, or whose
   * trigger is not deployed, still drains daily.
   */
  redrive(db: Firestore, docId: string, erro: string): Promise<boolean>;
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
      if (disposition.kind === 'defer') {
        // A precondition outside this system is not met yet. Persist into the
        // SLOW lane so it burns none of the hourly budget while it waits.
        await store.create(db, payload, 'deferred', 0, disposition.reason);
        return { outcome: 'deferred', payload, result };
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

    redrive: (db, docId, erro) => store.redrive(db, docId, erro),

    reprocess: (db, opts = {}) => sweepLane(db, opts, 'hot'),

    reprocessDeferred: (db, opts = {}) => sweepLane(db, opts, 'deferred'),
  };

  /**
   * The body both sweeps share. Everything except the QUERY and what a
   * still-blocked doc becomes is identical — same rehydration, same in-run
   * dedup, same `process`, same per-doc isolation — and keeping it in one place
   * is what stops the two lanes from drifting apart in their error handling.
   */
  async function sweepLane(
    db: Firestore,
    opts: ReprocessOptions,
    lane: 'hot' | 'deferred',
  ): Promise<ReprocessResult> {
    const now = opts.now ?? Date.now();
    const cutoff = now - (opts.olderThanMs ?? (lane === 'hot' ? ONE_HOUR_MS : ONE_DAY_MS));

    const snap = await (
      lane === 'hot'
        ? store.pending(db, cutoff, opts.limit)
        : store.deferred(db, cutoff, opts.limit)
    ).get();

    /**
     * What a doc that is STILL blocked becomes. In the hot lane it stays
     * `failed` until `MAX_TENTATIVAS`; in the deferred one it stays `deferred`
     * until the far longer `MAX_TENTATIVAS_DEFERRED`. Either cap ends in
     * `parked`, and this is also the fallback for a doc whose processing threw:
     * an unknown failure is charged to the lane the doc is already in.
     */
    const stillBlocked = (tentativas: number): NotificationStatus => {
      if (lane === 'hot') return tentativas >= MAX_TENTATIVAS ? 'parked' : 'failed';
      return tentativas >= MAX_TENTATIVAS_DEFERRED ? 'parked' : 'deferred';
    };

    const seen = new Set<string>();
    const outcomes: Record<string, number> = {};
    const errors: Array<{ docId: string; message: string }> = [];
    let processed = 0;

    for (const d of snap.docs) {
      const raw = d.data() as Record<string, unknown>;

      // Seeded from the RAW doc so the catch below can still mark the
      // document when REHYDRATION itself is what failed; recomputed from the
      // parsed doc as soon as that succeeds (the parse applies the schema
      // default). `parseRead` is soft — it logs and returns raw rather than
      // throwing on a schema mismatch — but `fromDoc` is CHANNEL-supplied and
      // this is generic infrastructure, so it is not ours to assume total.
      let tentativas = (typeof raw.tentativas === 'number' ? raw.tentativas : 0) + 1;

      try {
        const parsedDoc = collection.parseRead(raw, collection.docPath({}, d.id));
        const payload = config.fromDoc(parsedDoc, raw);
        tentativas = ((parsedDoc as { tentativas?: number }).tentativas ?? 0) + 1;

        const dedupKey = config.dedupKeyOf(payload);
        if (dedupKey && seen.has(dedupKey)) continue; // dup within this run — leave it for a later one
        if (dedupKey) seen.add(dedupKey);

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
        } else if (lane === 'hot' && disposition.kind === 'defer') {
          // MIGRATION into the slow lane. Reached by a doc the receiver
          // persisted as `failed` without ever running `process` (its enqueue
          // failed), so this sweep is the first time anything learned the real
          // blocker. `tentativas: 0`, not the accumulated count: the deferred
          // horizon is a fresh clock starting the moment we learn it is blocked,
          // exactly as the task phase creates it.
          await store.mark(db, d.id, 'deferred', 0, disposition.reason, now);
          label = 'deferred';
        } else if (lane === 'deferred' && disposition.kind === 'fail') {
          // GRADUATION. The precondition cleared — the account connected — and
          // the work itself is what failed now. That is ordinary retryable work,
          // so the doc rejoins the hot lane with a full budget rather than
          // spending the daily horizon it no longer needs.
          await store.redrive(db, d.id, disposition.reason);
          label = 'redriven';
        } else {
          // Still blocked — re-drive within this lane until its cap, then park.
          const status = stillBlocked(tentativas);
          await store.mark(db, d.id, status, tentativas, disposition.reason, now);
          label = status;
        }
        outcomes[label] = (outcomes[label] ?? 0) + 1;
        processed += 1;
        // See the TRANSIENT-BOUNDARY note in this module's header.
        // eslint-disable-next-line delfrance/no-error-as-sole-instanceof
      } catch (err) {
        // Batch-isolation boundary: a failure on ONE notification must never
        // abort the sweep — that covers rehydrating it as well as processing
        // it. Bump tentativas (parking at the cap); if even that mark write
        // fails, collect and move on. Non-Error throws still propagate — they
        // are coding bugs, not outages.
        if (!(err instanceof Error)) throw err;
        try {
          await store.mark(db, d.id, stillBlocked(tentativas), tentativas, err.message, now);
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
  }
}
