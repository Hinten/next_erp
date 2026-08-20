/**
 * Collapses one or several `useQuery` results into the three things a retry
 * affordance needs: the failure to show, whether a retry is in flight, and the
 * callback that re-runs it.
 *
 * Deliberately NOT a hook — it calls none, so it is free of the rules-of-hooks
 * and stale-dependency traps and can be called conditionally, inside a branch,
 * or after an early return.
 */
import type { UseQueryResult } from '@tanstack/react-query';

/** The slice this needs, so any query-shaped object (or a test stub) works. */
export type RetryableQuery = Pick<
  UseQueryResult<unknown, unknown>,
  'error' | 'isFetching' | 'refetch'
>;

export interface QueryRetry {
  /** The FIRST error among the queries, in the order given. `null` when none failed. */
  readonly error: unknown;
  /** A query that failed is fetching again — a healthy sibling loading does not count. */
  readonly retrying: boolean;
  /** Re-runs EXACTLY the queries that currently hold an error. */
  readonly retry: () => void;
}

/**
 * Pass the queries in the order the operator should hear about them: for a
 * chained load, the first link first, since a later link's failure is usually a
 * consequence of the earlier one.
 *
 * ⚠️ Only the FAILED queries are refetched, and that is a correctness
 * requirement rather than an optimisation. `Query.fetch` has no `enabled` gate
 * (verified in query-core 5.100.10 — `enabled` is only consulted when deciding
 * whether an observer keeps the query active), so `refetch()` runs a disabled
 * query's `queryFn` anyway. Refetching a whole chain would fire the downstream
 * links with the very inputs their `enabled` guard exists to withhold — for the
 * size-chart editor, `sizeChartSpecs({ domainId: null! })`.
 *
 * No re-entrancy guard is needed, unlike the hand-rolled pagination retry in
 * `chat/_components/MensagemThread.tsx`: `refetch()` defaults to
 * `cancelRefetch: true`, so a double-click cancels and restarts rather than
 * stacking. It also never rejects (the observer swallows the rejection unless
 * `throwOnError`), so there is nothing here to catch.
 *
 * ⚠️ Because `refetch()` bypasses `enabled`, a query whose `queryFn` opens with
 * `if (!client) throw new Error('not ready')` can produce that bare `Error` if
 * auth drops between the failure and the click. It maps to the `unknown`
 * fallback and is not retryable — degraded, but not broken.
 */
export function queryRetry(...queries: readonly RetryableQuery[]): QueryRetry {
  const failed = queries.filter((q) => q.error != null);
  return {
    error: failed[0]?.error ?? null,
    retrying: failed.some((q) => q.isFetching),
    retry: () => {
      for (const q of failed) void q.refetch();
    },
  };
}
