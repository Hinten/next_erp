'use client';

import { useEffect, useState } from 'react';
import { execute } from 'firebase/firestore/pipelines';
import { type Pipeline, PIPELINE_ID_FIELD } from '../pipeline-queries';
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
          data: snap.results.map((r) => {
            const data = r.data() as Record<string, unknown>;
            // A pipeline with `.select(...)` returns ad-hoc records whose
            // `ref` is undefined — `buildPipeline` then projects the id as
            // PIPELINE_ID_FIELD. Read it back and strip it so it doesn't
            // leak into `row.data`.
            const projectedId =
              typeof data[PIPELINE_ID_FIELD] === 'string'
                ? (data[PIPELINE_ID_FIELD] as string)
                : undefined;
            if (PIPELINE_ID_FIELD in data) delete data[PIPELINE_ID_FIELD];
            const id = r.ref?.id ?? r.id ?? projectedId ?? '';
            if (!id) {
              // eslint-disable-next-line no-console
              console.warn(
                '[usePipelineSnapshot] result has no document id — pipeline used ' +
                  '.select() without the id projection (see PIPELINE_ID_FIELD).',
              );
            }
            return {
              // `path` is empty under a projected pipeline (ref is gone);
              // no row consumer reads it, so that is acceptable.
              id,
              path: r.ref?.path ?? '',
              data: data as T,
            };
          }),
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
