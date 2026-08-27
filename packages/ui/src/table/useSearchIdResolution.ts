'use client';

import { useEffect, useState } from 'react';

/**
 * What a `search.resolveIds` implementation hands back.
 *
 * `truncated` says more documents matched than the resolver was willing to
 * return, so the list on screen is a prefix of the real answer.
 */
export interface SearchIdResolution {
  ids: readonly string[];
  truncated?: boolean;
}

/** A page-supplied resolver. `null` means "this term is not mine". */
export type SearchIdResolver = (term: string) => Promise<SearchIdResolution | null>;

export interface SearchIdResolutionState {
  /**
   * `undefined` — no resolver, one still running, or it declined this term:
   * the term belongs to `search.toFilters`.
   * `string[]` — the resolver handled the term. An EMPTY array is a real
   * answer ("handled, nothing matched"), not an absence.
   */
  ids: readonly string[] | undefined;
  loading: boolean;
  error: Error | null;
  truncated: boolean;
}

/** The last settled resolution, tagged with the term it answers. */
interface Settled {
  term: string;
  ids: readonly string[] | undefined;
  error: Error | null;
  truncated: boolean;
}

const NOTHING_SETTLED: Settled = { term: '', ids: undefined, error: null, truncated: false };
const IDLE: SearchIdResolutionState = {
  ids: undefined,
  loading: false,
  error: null,
  truncated: false,
};

/**
 * Run a page-supplied async resolver over the current search term.
 *
 * The search box's term is usually a value the collection can be filtered by
 * directly (a nome prefix). Some terms are not: a marketplace item id lives in
 * a link SUBCOLLECTION, so finding the produto it belongs to costs a
 * collection-group query first. That resolution is asynchronous, which is the
 * only reason it cannot go through `search.toFilters`.
 *
 * Three outcomes, and the difference between the last two is load-bearing:
 *
 * - **declined** (`null`) — not this resolver's kind of term. `ids` stays
 *   `undefined` and the caller falls through to `toFilters`. This is what lets
 *   ONE box serve two search modes.
 * - **handled, empty** (`{ ids: [] }`) — the caller must render an empty table
 *   WITHOUT querying the collection. Falling through here would run the other
 *   mode's filter over a term it was never meant for, and report its miss as
 *   though the id search had never happened.
 * - **handled, non-empty** — the caller constrains the query to those ids.
 *
 * One-shot per term, deliberately NOT TanStack `useQuery`: `TableView` renders
 * in trees with no `QueryClientProvider` ancestor, same constraint (and same
 * shape) as `useSubcollectionIdLookup`.
 *
 * ⚠️ Only the settled ANSWER is state; `loading` is derived from whether that
 * answer is tagged with the term being asked about. Storing it would mean
 * flipping it on synchronously inside the effect — a cascading render on every
 * keystroke past the debounce, and what `react-hooks/set-state-in-effect`
 * flags. The tag also does the staleness work for free: two resolutions can be
 * in flight at once and settle out of order, and a late answer for `MLB1`
 * landing after a fast one for `MLB12` is simply not the current term's.
 */
export function useSearchIdResolution(
  resolve: SearchIdResolver | undefined,
  term: string,
): SearchIdResolutionState {
  const [settled, setSettled] = useState<Settled>(NOTHING_SETTLED);

  useEffect(() => {
    if (!resolve || term === '') return;

    let cancelled = false;
    resolve(term)
      .then((res) => {
        if (cancelled) return;
        setSettled({
          term,
          ids: res?.ids,
          error: null,
          truncated: res?.truncated === true,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Mirror usePipelineSnapshot / useSubcollectionIdLookup: wrap a
        // non-Error throw so consumers always get a `.message`.
        setSettled({
          term,
          ids: undefined,
          error: err instanceof Error ? err : new Error(String(err)),
          truncated: false,
        });
      });

    return () => {
      cancelled = true;
    };
    // `resolve` is expected to be stable (module-level or memoized) exactly like
    // the rest of the `search` config, which TableView already treats as
    // identity-tracked. An inline arrow here would re-run this every render.
  }, [resolve, term]);

  if (resolve === undefined || term === '') return IDLE;
  if (settled.term !== term) {
    return { ids: undefined, loading: true, error: null, truncated: false };
  }
  return {
    ids: settled.ids,
    loading: false,
    error: settled.error,
    truncated: settled.truncated,
  };
}
