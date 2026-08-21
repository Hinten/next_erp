'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FirebaseError } from 'firebase/app';
import { type Query, type QueryConstraint, getDocs } from 'firebase/firestore';
import {
  buildQuery,
  limit as fsLimit,
  orderByField,
  paginate,
  whereArrayContains,
  whereEqual,
} from '@delfrance/data';
import { mapSnapshotRows, useSnapshotWithDocs, type SnapshotRow } from '@delfrance/data/hooks';
import { type Conversa } from '@delfrance/schemas';
import {
  CONVERSA_PAGE_SIZE,
  conversaConstraintSpecs,
  type ConstraintSpec,
  type ConversaFilterInput,
  type ConversaOrdem,
  type ConversaTab,
} from '@/lib/chat/conversaConstraints';
import { conversaCollection } from '@/lib/data/conversaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export interface UseConversaQueryInput extends ConversaFilterInput {
  tab: ConversaTab;
  ordem: ConversaOrdem;
  uid: string | null | undefined;
}

export interface UseConversaQueryResult {
  rows: SnapshotRow<Conversa>[];
  loading: boolean;
  error: Error | undefined;
  /** More one-shot pages may exist (page-1 came back full and not exhausted). */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

/** Map a declarative spec to a real `QueryConstraint` (the impure seam). */
function specToConstraint(spec: ConstraintSpec): QueryConstraint {
  switch (spec.kind) {
    case 'where':
      return spec.op === 'array-contains'
        ? whereArrayContains(spec.field, spec.value)
        : whereEqual(spec.field, spec.value);
    case 'orderBy':
      return orderByField(spec.field, spec.direction);
    case 'limit':
      return fsLimit(spec.value);
  }
}

/**
 * Conversa list query for one tab + ordering + filter set. Page 1 is LIVE
 * (`useSnapshotWithDocs`, limit 200) so new activity lands immediately; deeper
 * pages are one-shot `getDocs` via `paginate({ after })` (no extra listeners),
 * appended after the live page. New/updated docs stay in the live page; the
 * merge dedupes an older one-shot copy that has since surfaced live.
 */
export function useConversaQuery(input: UseConversaQueryInput): UseConversaQueryResult {
  const db = getFirebaseFirestore();

  // Base (filter + orderBy) constraints, sans the limit — reused for both the
  // live query and the paginated fetches. `specs` also drives the reset key.
  const { baseConstraints, resetKey } = useMemo(() => {
    const specs = conversaConstraintSpecs({
      tab: input.tab,
      ordem: input.ordem,
      uid: input.uid,
      integracaoId: input.integracaoId,
      etiqueta: input.etiqueta,
      clienteOuterRef: input.clienteOuterRef,
    });
    return {
      baseConstraints: specs.filter((s) => s.kind !== 'limit').map(specToConstraint),
      resetKey: JSON.stringify(specs),
    };
  }, [
    input.tab,
    input.ordem,
    input.uid,
    input.integracaoId,
    input.etiqueta,
    input.clienteOuterRef,
  ]);

  // The Atendimento tab filters `usuarios array-contains <uid>` — while auth is
  // still resolving there is no uid, and a query built with `''` would attach a
  // pointless listener (and could even match a doc whose `usuarios` carries an
  // empty string). Hold the query `null` until the uid exists (Copilot review,
  // PR #583; same pattern as useChatBadges' ativasQuery).
  const needsUid = input.tab === 'atendimento';
  const liveQuery = useMemo<Query<Conversa> | null>(
    () =>
      needsUid && !input.uid
        ? null
        : buildQuery(conversaCollection.ref(db, {}), [
            ...baseConstraints,
            fsLimit(CONVERSA_PAGE_SIZE),
          ]),
    // `resetKey` captures the constraint identity (buildQuery/constraints are
    // fresh objects each render); depend on it plus `db`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, resetKey, needsUid, input.uid],
  );

  const live = useSnapshotWithDocs<Conversa>(liveQuery);

  const [extraRows, setExtraRows] = useState<SnapshotRow<Conversa>[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [moreError, setMoreError] = useState<Error | undefined>();

  // Reset the paginated tail whenever the query identity changes. Setting
  // state in an effect is the sanctioned reset shape here: the reset must
  // also discard in-flight loadMore results, and an in-render "derive from
  // key" swap can't cancel those.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    setExtraRows([]);
    setExhausted(false);
    setLoadingMore(false);
    setMoreError(undefined);
  }, [resetKey]);

  // Merge: live page first (authoritative + fresh), then the one-shot tail with
  // any id already surfaced live dropped. `live.data` is dereferenced inside
  // the memo (a `?? []` binding outside would mint a fresh array per render
  // and defeat the memo).
  const rows = useMemo(() => {
    const liveRows = live.data ?? [];
    const seen = new Set(liveRows.map((r) => r.id));
    const tail = extraRows.filter((r) => !seen.has(r.id));
    return [...liveRows, ...tail];
  }, [live.data, extraRows]);

  const loadMore = useCallback(() => {
    if (loadingMore || exhausted) return;
    const cursor = rows[rows.length - 1]?.snap;
    if (!cursor) return;

    setLoadingMore(true);
    setMoreError(undefined);
    void (async () => {
      try {
        const pageQuery = buildQuery(conversaCollection.ref(db, {}), [
          ...baseConstraints,
          ...paginate({ after: cursor, pageSize: CONVERSA_PAGE_SIZE }),
        ]);
        const snap = await getDocs(pageQuery);
        const newRows = mapSnapshotRows(snap, true);
        setExtraRows((prev) => {
          const seen = new Set(prev.map((r) => r.id));
          return [...prev, ...newRows.filter((r) => !seen.has(r.id))];
        });
        if (newRows.length < CONVERSA_PAGE_SIZE) setExhausted(true);
      } catch (err) {
        if (err instanceof FirebaseError) {
          setMoreError(err);
        } else {
          throw err;
        }
      } finally {
        setLoadingMore(false);
      }
    })();
  }, [loadingMore, exhausted, rows, db, baseConstraints]);

  const hasMore = !exhausted && rows.length >= CONVERSA_PAGE_SIZE;

  return {
    rows,
    loading: live.loading,
    error: live.error ?? moreError,
    hasMore,
    loadingMore,
    loadMore,
  };
}
