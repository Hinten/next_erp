'use client';

import { useEffect, useState } from 'react';
import {
  type DocumentReference,
  type DocumentSnapshot,
  type FirestoreError,
  type Query,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
  onSnapshot,
} from 'firebase/firestore';

/**
 * Listen options for BOTH hooks below. The flag is not a nicety — without it
 * `fromCache` is a signal that can never fire.
 *
 * The SDK decides in `QueryListener.shouldRaiseEvent`: a snapshot carrying no
 * document changes is delivered only when `syncStateChanged` (the cache -> server
 * transition) coincides with `includeMetadataChanges === true`; otherwise it
 * returns `false` and the event is dropped. So by default a consumer sees
 * `fromCache: false` ONLY when the server's copy also differs in DATA from the
 * cached one. Open a record whose cached copy is already correct — the common
 * case once anything has been viewed in the session — and the listener never
 * fires again: `fromCache` stays `true` forever.
 *
 * Four gates in this repo read that signal, and all four were silently dead on
 * that path: `useServerTruthSeed` (the ObjectView re-seed AND `baseline.current`,
 * which is the ADR 0011 tier-3 concurrency guard — a null baseline means the save
 * is unguarded), `useCollectionMonitor`, the produto editor's server-truth seed,
 * and `RecalcularPrecosScreen`'s lista preselect.
 *
 * The cost is one extra emission per listener when its target first becomes
 * CURRENT, plus one per `hasPendingWrites` flip. Both are per-listener, not
 * per-document, and every consumer above already de-duplicates its own work.
 */
const SERVER_SYNC_LISTEN_OPTIONS = { includeMetadataChanges: true } as const;

export interface SnapshotState<T> {
  data: T | undefined;
  loading: boolean;
  error: FirestoreError | undefined;
  /**
   * Firestore metadata from the LATEST emission. With the IndexedDB persistent
   * cache (`persistentLocalCache`), `onSnapshot` emits a `fromCache: true`
   * snapshot FIRST — served from the local cache, which a just-committed
   * transaction may not have updated yet (transactions have no latency
   * compensation) — then a `fromCache: false` snapshot once the server
   * responds. Consumers that must seed from SERVER truth (e.g. an edit form)
   * gate on `fromCache === false`. Left `undefined` by non-Firestore sources
   * (the one-shot Pipelines hook), which are always authoritative.
   *
   * ⚠️ That second emission only exists because both listeners below pass
   * `includeMetadataChanges: true`. WITHOUT it the SDK drops the cache -> server
   * transition whenever the document data is unchanged, and `fromCache` stays
   * `true` for the life of the listener — see the note on those calls. Every
   * gate above is written as `=== false` / `!== false` rather than truthiness
   * precisely so the `undefined` (non-Firestore) case stays distinguishable;
   * none of them can distinguish "server said nothing changed" on its own.
   */
  fromCache?: boolean;
  /** Latest emission carries local writes not yet acknowledged by the server. */
  hasPendingWrites?: boolean;
}

/**
 * One row in a collection snapshot. `path` is the full Firestore document
 * path (`pedidos/abc/pagamentos/xyz`) — handy for collection-group queries
 * where the parent id needs to be recovered for deep-linking.
 *
 * `snap` (the raw `QueryDocumentSnapshot`) is populated ONLY by the opt-in
 * {@link useSnapshotWithDocs}; it is a cursor for `paginate({ after })`. Plain
 * {@link useSnapshot} leaves it `undefined` (no behavioural change to existing
 * callers).
 */
export interface SnapshotRow<T> {
  id: string;
  path: string;
  data: T;
  snap?: QueryDocumentSnapshot<T>;
}

/**
 * Map a `QuerySnapshot` to `SnapshotRow`s. Pure (no React/Firestore side
 * effects) so it can be unit-tested with a plain fake snapshot. `includeDocs`
 * attaches the raw `QueryDocumentSnapshot` as `row.snap` for cursor pagination.
 */
export function mapSnapshotRows<T>(snap: QuerySnapshot<T>, includeDocs: boolean): SnapshotRow<T>[] {
  return snap.docs.map((d) => {
    const row: SnapshotRow<T> = { id: d.id, path: d.ref.path, data: d.data() };
    if (includeDocs) row.snap = d;
    return row;
  });
}

/**
 * Subscribe to a Firestore Query in real time. Resolves on the first server
 * snapshot; subsequent updates push state without re-mounting.
 *
 * Pass `null` to no-op (e.g. while a tenantId is still loading). The hook
 * tears down the subscription on unmount and on query identity change.
 */
export function useSnapshot<T>(q: Query<T> | null): SnapshotState<SnapshotRow<T>[]> {
  return useSnapshotRows(q, false);
}

/**
 * Like {@link useSnapshot}, but each row also carries its raw
 * `QueryDocumentSnapshot` as `row.snap` — the cursor `paginate({ after })`
 * needs to fetch the next page one-shot (e.g. the chat inbox's "Carregar
 * mais"). Additive: the shape is identical to `useSnapshot` plus the optional
 * `snap` field, so callers that don't need the cursor keep using `useSnapshot`.
 */
export function useSnapshotWithDocs<T>(q: Query<T> | null): SnapshotState<SnapshotRow<T>[]> {
  return useSnapshotRows(q, true);
}

function useSnapshotRows<T>(
  q: Query<T> | null,
  includeDocs: boolean,
): SnapshotState<SnapshotRow<T>[]> {
  const [state, setState] = useState<SnapshotState<SnapshotRow<T>[]>>({
    data: undefined,
    loading: true,
    error: undefined,
  });

  useEffect(() => {
    if (!q) {
      setState({ data: undefined, loading: false, error: undefined });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    const unsub = onSnapshot(
      q,
      SERVER_SYNC_LISTEN_OPTIONS,
      (snap: QuerySnapshot<T>) => {
        setState({
          data: mapSnapshotRows(snap, includeDocs),
          loading: false,
          error: undefined,
          fromCache: snap.metadata.fromCache,
          hasPendingWrites: snap.metadata.hasPendingWrites,
        });
      },
      (error) => setState({ data: undefined, loading: false, error }),
    );
    return unsub;
  }, [q, includeDocs]);

  return state;
}

/**
 * Subscribe to a single Firestore document. Returns `data: undefined` when
 * the doc does not exist; readers should check explicitly.
 */
export function useDocSnapshot<T>(
  ref: DocumentReference<T> | null,
): SnapshotState<{ id: string; data: T } | null> {
  const [state, setState] = useState<SnapshotState<{ id: string; data: T } | null>>({
    data: undefined,
    loading: true,
    error: undefined,
  });

  useEffect(() => {
    if (!ref) {
      setState({ data: undefined, loading: false, error: undefined });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    const unsub = onSnapshot(
      ref,
      SERVER_SYNC_LISTEN_OPTIONS,
      (snap: DocumentSnapshot<T>) => {
        const data = snap.data();
        setState({
          data: data === undefined ? null : { id: snap.id, data },
          loading: false,
          error: undefined,
          fromCache: snap.metadata.fromCache,
          hasPendingWrites: snap.metadata.hasPendingWrites,
        });
      },
      (error) => setState({ data: undefined, loading: false, error }),
    );
    return unsub;
  }, [ref]);

  return state;
}
