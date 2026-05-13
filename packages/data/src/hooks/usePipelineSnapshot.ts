'use client';

import { useEffect, useState } from 'react';
import { execute } from 'firebase/firestore/pipelines';
import type { Pipeline } from '../pipeline-queries';
import type { SnapshotRow, SnapshotState } from './useSnapshot';

/**
 * Subscribe to a Firestore Pipeline. Mirrors the shape of `useSnapshot` so
 * callers can swap between them without changing render code.
 *
 * Pipelines today are one-shot — `execute(pipeline)` returns a snapshot once
 * and there is no `onSnapshot` analogue in firebase@12. When the SDK ships a
 * realtime API for pipelines we re-add a live branch here.
 *
 * Pass `null` to no-op (e.g. while context is still loading).
 */
export function usePipelineSnapshot<T>(
  pipeline: Pipeline | null,
): SnapshotState<SnapshotRow<T>[]> {
  const [state, setState] = useState<SnapshotState<SnapshotRow<T>[]>>({
    data: undefined,
    loading: true,
    error: undefined,
  });

  useEffect(() => {
    if (!pipeline) {
      setState({ data: undefined, loading: false, error: undefined });
      return;
    }
    setState((s) => ({ ...s, loading: true }));

    let cancelled = false;
    execute(pipeline)
      .then((snap) => {
        if (cancelled) return;
        setState({
          data: snap.results.map((r, idx) => ({
            id: r.ref?.id ?? r.id ?? String(idx),
            path: r.ref?.path ?? '',
            data: r.data() as T,
          })),
          loading: false,
          error: undefined,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof Error) {
          setState({ data: undefined, loading: false, error: err as never });
        } else {
          // Non-Error throw — wrap so downstream rendering has a stable shape.
          setState({
            data: undefined,
            loading: false,
            error: new Error(String(err)) as never,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [pipeline]);

  return state;
}
