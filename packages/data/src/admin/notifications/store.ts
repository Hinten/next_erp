/**
 * The failures-only notification store — every Firestore operation a channel's
 * ingestion core performs, over an arbitrary `defineAdminCollection` handle.
 *
 * "Failures-only" is the whole point: a notification that processed cleanly
 * leaves NO document behind. The collection therefore holds exactly the backlog
 * the sweep still has work to do on, which is what makes an unbounded
 * `orderBy(processedAt)` cursor cheap on Firestore Enterprise (where an
 * unindexed scan bills by data scanned).
 *
 * The backlog is split into two LANES by `status` — hourly `failed` and daily
 * `deferred` (#808) — sharing one query shape and therefore one composite index.
 */
import type { DocumentData, Firestore, Query } from 'firebase-admin/firestore';
import type { z } from 'zod';

import type { AdminCollectionHandle } from '../defineAdminCollection';
import { isAlreadyExists } from '../grpcErrors';
import { DEFAULT_REPROCESS_LIMIT, type NotificationStatus } from './types';

export interface NotificationStoreConfig<TPayload> {
  /** The channel's `notificacoes*` collection handle. */
  collection: AdminCollectionHandle<z.ZodTypeAny>;
  /**
   * The provider's own event id, used verbatim as the Firestore doc id so a
   * redelivery of the SAME event collides instead of forking. Return null when
   * the wire carries no id — the store mints an auto id, and two id-less
   * deliveries of one event WILL produce two docs (the sweep's in-run dedup key
   * is what bounds the blast radius).
   *
   * ⚠️ A channel with a producer that synthesises notifications — Mercado Livre's
   * order backfill is the worked example — should DERIVE a deterministic id here
   * instead of returning null, or a repeatedly-failing resource accumulates one
   * dead document per attempt with nothing to collide against (#807).
   */
  docIdOf(payload: TPayload): string | null;
  /**
   * The wire fields written onto the persisted doc. Keep this lean — it exists
   * for dead-lettering and replay, not as an event log. A channel with no
   * re-fetch anchor (WhatsApp: the message body exists only in the webhook)
   * must include enough here for the sweep to REPLAY the event.
   */
  toDocFields(payload: TPayload): Record<string, unknown>;
}

export interface NotificationStore<TPayload> {
  /**
   * Create-only write, keyed by the provider event id, stamping
   * `processedAt = now` (the sweep's window gate). A duplicate delivery that
   * also failed hits ALREADY_EXISTS (gRPC 6) → the notification is already
   * recorded, so it is IGNORED rather than clobbering the existing retry state.
   */
  create(
    db: Firestore,
    payload: TPayload,
    status: NotificationStatus,
    tentativas: number,
    erro: string,
  ): Promise<void>;
  /** Advance an existing doc's status/retry counter (merge — keeps the wire fields). */
  mark(
    db: Firestore,
    docId: string,
    status: NotificationStatus,
    tentativas: number,
    erro: string,
    now: number,
  ): Promise<void>;
  /**
   * Move a doc back into the HOT lane with a fresh retry budget, for the moment
   * a deferred precondition finally clears (#808): the seller connected their
   * account, so every notification that was waiting on it is processable now.
   *
   * `processedAt: 0` is what makes it immediate — it is unconditionally older
   * than any `now - window` cutoff, so the very next hot tick picks the doc up
   * rather than waiting out another hour.
   *
   * Resolves `false` when the doc was already gone. `mergeIfExists`, NOT
   * `merge`: the ids come from a query, so a concurrent delete between the read
   * and this write is possible, and an upsert would resurrect the doc as a ghost
   * carrying only these four fields.
   */
  redrive(db: Firestore, docId: string, erro: string): Promise<boolean>;
  /** Remove a resolved doc from the failures-only store. */
  remove(db: Firestore, docId: string): Promise<void>;
  /**
   * The HOT lane's durable-cursor query: every `failed` doc whose LAST ATTEMPT
   * is older than the cutoff, oldest first. `processedAt` is the cursor — it is
   * re-stamped on every attempt, so a doc that keeps failing keeps sliding to
   * the back of the queue instead of starving the rest of the backlog.
   *
   * ⚠️ Needs a `(status ASC, processedAt ASC)` composite index in
   * `firestore.indexes.json`. Firestore Enterprise auto-creates NONE and will
   * silently full-scan (and bill for it) instead of failing loudly.
   */
  pending(db: Firestore, cutoff: number, limit?: number): Query;
  /**
   * The DEFERRED lane's query — identical in shape to {@link pending}, so it
   * rides the SAME `(status ASC, processedAt ASC)` composite index and needs no
   * new one. Only the status value and the caller's window differ (a day rather
   * than an hour), which is the whole point: a precondition that is not met yet
   * gets a slow, cheap cadence instead of crowding the hourly backlog.
   */
  deferred(db: Firestore, cutoff: number, limit?: number): Query;
}

export function createNotificationStore<TPayload>(
  config: NotificationStoreConfig<TPayload>,
): NotificationStore<TPayload> {
  const { collection } = config;

  /** The one query shape both lanes share — see the index note on `pending`. */
  const laneQuery = (
    db: Firestore,
    status: NotificationStatus,
    cutoff: number,
    limit: number,
  ): Query =>
    collection
      .ref(db, {})
      .where('status', '==', status)
      .where('processedAt', '<', cutoff)
      .orderBy('processedAt')
      .limit(limit);

  return {
    async create(db, payload, status, tentativas, erro) {
      const docId = config.docIdOf(payload) ?? collection.newDocId(db, {});
      const data = collection.parse({
        ...config.toDocFields(payload),
        status,
        tentativas,
        erro,
        processedAt: Date.now(),
      });
      try {
        await collection.docRef(db, {}, docId).create(data as DocumentData);
      } catch (err) {
        if (isAlreadyExists(err)) return; // dup — already recorded
        throw err;
      }
    },

    async mark(db, docId, status, tentativas, erro, now) {
      await collection.merge(db, {}, docId, { status, tentativas, erro, processedAt: now });
    },

    redrive(db, docId, erro) {
      return collection.mergeIfExists(db, {}, docId, {
        status: 'failed',
        tentativas: 0,
        erro,
        processedAt: 0,
      });
    },

    async remove(db, docId) {
      await collection.docRef(db, {}, docId).delete();
    },

    pending(db, cutoff, limit = DEFAULT_REPROCESS_LIMIT) {
      return laneQuery(db, 'failed', cutoff, limit);
    },

    deferred(db, cutoff, limit = DEFAULT_REPROCESS_LIMIT) {
      return laneQuery(db, 'deferred', cutoff, limit);
    },
  };
}
