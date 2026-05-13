'use client';

import { useEffect, useState } from 'react';
import type { Pipeline } from '../pipeline-queries';
import type { SnapshotRow, SnapshotState } from './useSnapshot';

interface PipelineExecutable {
  execute(): Promise<{
    results: ReadonlyArray<{
      ref?: { id?: string; path?: string };
      data(): unknown;
    }>;
  }>;
  onSnapshot?(
    next: (snap: {
      results: ReadonlyArray<{
        ref?: { id?: string; path?: string };
        data(): unknown;
      }>;
    }) => void,
    error?: (err: unknown) => void,
  ): () => void;
}

/**
 * Subscribe to a Firestore Pipeline. Mirrors the shape of `useSnapshot` so
 * callers can swap between them without changing render code.
 *
 * Pipelines support both `execute()` (one-shot) and `onSnapshot()` (live).
 * We prefer the live API when present; otherwise we re-execute on mount and
 * surface the result as a static snapshot.
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

    const exec = pipeline as unknown as PipelineExecutable;
    let cancelled = false;

    const handleSnap = (snap: {
      results: ReadonlyArray<{ ref?: { id?: string; path?: string }; data(): unknown }>;
    }) => {
      if (cancelled) return;
      setState({
        data: snap.results.map((r, idx) => ({
          id: r.ref?.id ?? String(idx),
          path: r.ref?.path ?? '',
          data: r.data() as T,
        })),
        loading: false,
        error: undefined,
      });
    };
    const handleErr = (err: unknown) => {
      if (cancelled) return;
      setState({ data: undefined, loading: false, error: err as never });
    };

    if (typeof exec.onSnapshot === 'function') {
      const unsub = exec.onSnapshot(handleSnap, handleErr);
      return () => {
        cancelled = true;
        unsub();
      };
    }

    exec.execute().then(handleSnap).catch(handleErr);
    return () => {
      cancelled = true;
    };
  }, [pipeline]);

  return state;
}
