'use client';

import { useEffect, useState } from 'react';
import {
  type DocumentReference,
  type DocumentSnapshot,
  type FirestoreError,
  type Query,
  type QuerySnapshot,
  onSnapshot,
} from 'firebase/firestore';

export interface SnapshotState<T> {
  data: T | undefined;
  loading: boolean;
  error: FirestoreError | undefined;
}

/**
 * One row in a collection snapshot. `path` is the full Firestore document
 * path (`pedidos/abc/pagamentos/xyz`) — handy for collection-group queries
 * where the parent id needs to be recovered for deep-linking.
 */
export interface SnapshotRow<T> {
  id: string;
  path: string;
  data: T;
}

/**
 * Subscribe to a Firestore Query in real time. Resolves on the first server
 * snapshot; subsequent updates push state without re-mounting.
 *
 * Pass `null` to no-op (e.g. while a tenantId is still loading). The hook
 * tears down the subscription on unmount and on query identity change.
 */
export function useSnapshot<T>(
  q: Query<T> | null,
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
          data: snap.docs.map((d) => ({
            id: d.id,
            path: d.ref.path,
            data: d.data(),
          })),
          loading: false,
          error: undefined,
        });
      },
      (error) => setState({ data: undefined, loading: false, error }),
    );
    return unsub;
  }, [q]);

  return state;
}

/**
 * Subscribe to a single Firestore document. Returns `data: undefined` when
 * the doc does not exist; readers should check explicitly.
 */
export function useDocSnapshot<T>(
  ref: DocumentReference<T> | null,
): SnapshotState<{ id: string; data: T } | null> {
  const [state, setState] = useState<
    SnapshotState<{ id: string; data: T } | null>
  >({
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
        });
      },
      (error) => setState({ data: undefined, loading: false, error }),
    );
    return unsub;
  }, [ref]);

  return state;
}
