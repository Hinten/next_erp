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
