'use client';

import { useEffect, useState } from 'react';
import { execute } from 'firebase/firestore/pipelines';
import { type Pipeline, PIPELINE_ID_FIELD } from '../pipeline-queries';
import type { SnapshotRow, SnapshotState } from './useSnapshot';

export interface UsePipelineSnapshotOptions {
  /**
   * Re-run the (one-shot) pipeline on this interval, in milliseconds. Pipelines
   * have no `onSnapshot` analogue in firebase@12, so without this a document
   * written *after* the initial `execute()` never surfaces. Polling keeps the
   * result set current — e.g. a record created on a "novo" page shows up once
   * the user navigates back to the list. Omit (or `0`) to fetch exactly once.
   */
  refetchInterval?: number;
}

/**
 * Run a pipeline and map its result set to `SnapshotRow`s. A `.select()` stage
 * strips `PipelineResult.ref`, so `buildPipeline` projects the id under
 * `PIPELINE_ID_FIELD`; read it back here and strip it from `row.data`.
 */
async function executeRows<T>(pipeline: Pipeline): Promise<SnapshotRow<T>[]> {
  const snap = await execute(pipeline);
  return snap.results.map((r) => {
    const data = r.data() as Record<string, unknown>;
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
      // `path` is empty under a projected pipeline (ref is gone); no row
      // consumer reads it, so that is acceptable.
      id,
      path: r.ref?.path ?? '',
      data: data as T,
    };
  });
}

/**
 * Subscribe to a Firestore Pipeline. Mirrors the shape of `useSnapshot` so
 * callers can swap between them without changing render code.
 *
 * Pipelines are one-shot — `execute(pipeline)` returns a snapshot once and
 * there is no `onSnapshot` analogue in firebase@12. When the SDK ships a
 * realtime API for pipelines we re-add a live branch here. Until then, pass
 * `refetchInterval` to poll: the initial load shows the loading skeleton,
 * later refetches swap rows in silently (no skeleton flash).
 *
 * Pass `null` to no-op (e.g. while context is still loading).
 */
export function usePipelineSnapshot<T>(
  pipeline: Pipeline | null,
  { refetchInterval }: UsePipelineSnapshotOptions = {},
): SnapshotState<SnapshotRow<T>[]> {
  const [state, setState] = useState<SnapshotState<SnapshotRow<T>[]>>({
    data: undefined,
    loading: true,
    error: undefined,
  });

  // Initial load — and a full reload (with skeleton) whenever the pipeline
  // identity changes, e.g. the caller applied a new filter or sort.
  useEffect(() => {
    if (!pipeline) {
      setState({ data: undefined, loading: false, error: undefined });
      return;
    }
    setState((s) => ({ ...s, loading: true }));

    let cancelled = false;
    executeRows<T>(pipeline)
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: undefined });
      })
      .catch((err) => {
        if (cancelled) return;
        const error = err instanceof Error ? err : new Error(String(err));
        setState({ data: undefined, loading: false, error: error as never });
      });

    return () => {
      cancelled = true;
    };
  }, [pipeline]);

  // Background revalidation. Re-runs the one-shot query on an interval and
  // swaps the rows in *without* flipping `loading`, so the table refreshes
  // silently instead of flashing the skeleton. Skips while the tab is hidden
  // to avoid pointless reads, and keeps the last good data on a transient
  // refetch error rather than blanking the table.
  useEffect(() => {
    if (!pipeline || !refetchInterval) return;

    let cancelled = false;
    const id = setInterval(() => {
      if (document.hidden) return;
      executeRows<T>(pipeline)
        .then((data) => {
          if (!cancelled) setState((s) => ({ ...s, data, error: undefined }));
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[usePipelineSnapshot] background refetch failed', err);
        });
    }, refetchInterval);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pipeline, refetchInterval]);

  return state;
}
