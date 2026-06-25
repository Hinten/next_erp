'use client';

import { useEffect, useMemo, useState } from 'react';
import { type Firestore, collectionGroup, getDocs } from 'firebase/firestore';
import { buildQuery, limit as limitConstraint, whereEqual } from '../queries';
import { isRetryableFirestoreError, retryAsync } from './retry';

/** Equality match on a child field (`numeracao` / `chave` for the NF lookup). */
export interface SubcollectionLookupMatch {
  field: string;
  value: unknown;
}

export interface SubcollectionLookupSpec {
  /** Collection-group id to scan (e.g. `'nfev4'`). */
  subcollection: string;
  /** AND-combined equality matches on the child documents. */
  match: SubcollectionLookupMatch[];
  /**
   * Cap on resolved parent ids — also the ceiling the consumer's
   * `documents([...])`/`in` constraint can take. Defaults to 30 (the Firestore
   * `in` limit). One extra doc is fetched to detect truncation.
   */
  limit?: number;
}

export interface SubcollectionIdLookupResult {
  /**
   * Parent document ids of the matching subcollection docs. `null` while no
   * lookup is active or the first result is still loading; `[]` means the
   * lookup ran and matched nothing (the consumer should render no rows).
   */
  ids: string[] | null;
  loading: boolean;
  error: Error | null;
  /** True when more matches existed than the `limit` and were dropped. */
  truncated: boolean;
}

const IDLE: SubcollectionIdLookupResult = {
  ids: null,
  loading: false,
  error: null,
  truncated: false,
};

/**
 * Dedupe + cap the parent ids of the matched subcollection docs. `parentIds`
 * is the raw `doc.ref.parent.parent?.id` of each result (one extra over `cap`
 * is fetched to detect truncation); blanks are dropped, order preserved.
 */
export function resolveParentIds(
  parentIds: ReadonlyArray<string | undefined>,
  cap: number,
): { ids: string[]; truncated: boolean } {
  const truncated = parentIds.length > cap;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const pid of parentIds.slice(0, cap)) {
    if (pid && !seen.has(pid)) {
      seen.add(pid);
      ids.push(pid);
    }
  }
  return { ids, truncated };
}

/**
 * Resolve a collection-group lookup to the ids of the matching documents'
 * **parent** docs. Built for filtering a parent list by a value that lives in a
 * subcollection (the pedido NF column: `nfev4.numeracao` / `nfev4.chave` →
 * pedido ids), which is cheaper than a correlated pipeline subquery for an
 * exact match — it reads only the matching child docs via a collection-group
 * index, not every parent.
 *
 * One-shot (`getDocs`) with the same transient-retry wrapper as
 * `usePipelineSnapshot`; intentionally NOT TanStack `useQuery`, so the generic
 * TableView keeps working without a `QueryClientProvider` ancestor.
 *
 * Pass `null` to no-op (no active lookup). The hook is always called (rules of
 * hooks); `spec` toggles whether it queries.
 */
export function useSubcollectionIdLookup(
  db: Firestore,
  spec: SubcollectionLookupSpec | null,
): SubcollectionIdLookupResult {
  const cap = spec?.limit ?? 30;
  // Content key: identical lookups don't re-fetch; a changed match does.
  const key = useMemo(
    () => (spec ? JSON.stringify([spec.subcollection, spec.match, cap]) : null),
    [spec, cap],
  );

  const [state, setState] = useState<SubcollectionIdLookupResult>(() =>
    spec ? { ...IDLE, loading: true } : IDLE,
  );

  useEffect(() => {
    if (!spec || key === null) {
      setState(IDLE);
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));

    let cancelled = false;
    const qy = buildQuery(collectionGroup(db, spec.subcollection), [
      ...spec.match.map((m) => whereEqual(m.field, m.value)),
      limitConstraint(cap + 1),
    ]);
    retryAsync(() => getDocs(qy), {
      isRetryable: isRetryableFirestoreError,
      isCancelled: () => cancelled,
    })
      .then((snap) => {
        if (cancelled) return;
        // `doc.ref.parent` is the subcollection; `.parent` again is the parent
        // document (nfev4 doc → its `nfev4` collection → the pedido doc).
        const { ids, truncated } = resolveParentIds(
          snap.docs.map((d) => d.ref.parent.parent?.id),
          cap,
        );
        setState({ ids, loading: false, error: null, truncated });
      })
      .catch((err) => {
        if (cancelled) return;
        // Mirror usePipelineSnapshot: wrap a non-Error throw for a stable shape.
        const error = err instanceof Error ? err : new Error(String(err));
        setState({ ids: null, loading: false, error, truncated: false });
      });

    return () => {
      cancelled = true;
    };
    // `db` is stable; `key` encodes the spec content (and `cap`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, key]);

  return state;
}
