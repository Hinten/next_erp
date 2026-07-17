'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FirebaseError } from 'firebase/app';
import { type QueryDocumentSnapshot, getDocs } from 'firebase/firestore';
import { buildQuery, groupQuery, limit, orderByField, paginate } from '@delfrance/data';
import { type Mensagem } from '@delfrance/schemas';
import {
  type ConversaGroup,
  type FetchedMensagem,
  groupMatches,
  matchFetched,
} from '@/lib/chat/globalSearch';
import { buildSearchRegex } from '@/lib/chat/searchRegex';
import { mensagemCollection } from '@/lib/data/conversaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/**
 * Docs fetched per "Buscar mais antigas" page. The cost guard is a single
 * COLLECTION_GROUP-scope index on `mensagem.timestamp` (firestore.indexes.json)
 * — READ COST: each page is ONE collection-group query reading up to PAGE_SIZE
 * `mensagem` docs (≤300 doc reads). The regex runs CLIENT-SIDE over the fetched
 * docs (Firestore can't regex), so a keystroke never re-reads — only an explicit
 * "Buscar mais antigas" click fetches the next 300-doc page (cursor = last doc
 * snapshot). Messages with a null `timestamp` are absent from the orderBy result
 * (Firestore drops docs missing the sort field) — acceptable for a search index.
 *
 * ACCEPTED remount cost: `/chat` and `/chat/[id]` are separate route segments,
 * so navigating into a thread remounts this hook — accumulated pages are
 * discarded and returning to the results re-reads page 1 (≤300 docs; the
 * `?busca=` param reseeds the term). Bounded and explicit; lifting the shell
 * into a layout or caching cursor pages was judged not worth the complexity.
 */
const PAGE_SIZE = 300;

/** The name of the message subcollection, for the `collectionGroup` query. */
const MENSAGEM_GROUP = 'mensagem';

export interface GlobalSearch {
  /** Whether the current term compiled (non-empty) — drives the fetch + UI. */
  active: boolean;
  /** True when the pattern was invalid/zero-width → literal fallback. */
  isLiteral: boolean;
  /** Matches grouped by conversa, newest-match first. */
  groups: ConversaGroup[];
  /** The effective regex (for the snippet highlighter), or null when idle. */
  regex: RegExp | null;
  /** Total `mensagem` docs fetched and scanned so far. */
  checkedCount: number;
  /** Total matching messages across all groups. */
  matchCount: number;
  /** First page is loading. */
  loading: boolean;
  /** A "Buscar mais antigas" page is loading. */
  loadingMore: boolean;
  error: FirebaseError | undefined;
  /** No older page remains (a fetch returned empty / short). */
  exhausted: boolean;
  /** At least one page has been fetched (distinguishes "idle" from "0 results"). */
  hasFetched: boolean;
  /** Fetch the next 300-doc page (one more collection-group read). */
  loadMore: () => Promise<void>;
}

/**
 * CROSS-CONVERSATION search over the `mensagem` collection-group (PR-C5). One
 * one-shot query per page (orderBy timestamp desc, limit 300, cursor via the
 * last doc snapshot); the regex is applied CLIENT-SIDE reusing the shared thread
 * semantics (`buildSearchRegex` + `matchFetched`), so it is regex-capable,
 * case-insensitive (`iu`), and falls back to a literal search on an invalid
 * pattern. Pages are term-INDEPENDENT (they are just the newest N messages), so
 * refining the term re-matches in memory with zero extra reads; only "Buscar
 * mais antigas" (`loadMore`) fetches another bounded page.
 */
export function useGlobalSearch(term: string): GlobalSearch {
  const { regex, isLiteral } = useMemo(() => buildSearchRegex(term), [term]);
  const active = regex != null;

  const [docs, setDocs] = useState<FetchedMensagem[]>([]);
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<Mensagem> | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<FirebaseError | undefined>();
  const [exhausted, setExhausted] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  // Guards the one-shot first fetch: pages are term-independent, so we fetch the
  // newest page exactly once (when search first becomes active) and never again
  // on a term tweak. A ref (not state) so it doesn't force a render.
  const startedRef = useRef(false);
  const inFlightRef = useRef(false);

  const fetchPage = useCallback(async (after: QueryDocumentSnapshot<Mensagem> | null) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const first = after == null;
    if (first) setLoading(true);
    else setLoadingMore(true);
    setError(undefined);
    try {
      const db = getFirebaseFirestore();
      const base = groupQuery(db, MENSAGEM_GROUP, mensagemCollection.converter);
      const q = buildQuery(base, [
        orderByField('timestamp', 'desc'),
        ...paginate(after ? { after, pageSize: PAGE_SIZE } : { pageSize: PAGE_SIZE }),
      ]);
      const snap = await getDocs(q);
      const page: FetchedMensagem[] = snap.docs.map((d) => ({
        // `d.ref.parent` is the `mensagem` collection; its `.parent` is the
        // `chat/{conversaId}` doc — its id is the conversa the message lives in.
        conversaId: d.ref.parent.parent?.id ?? '',
        mensagemId: d.id,
        timestamp: d.data().timestamp ?? null,
        mensagem: d.data(),
      }));
      setDocs((prev) => (first ? page : [...prev, ...page]));
      setCursor(snap.docs[snap.docs.length - 1] ?? after);
      if (snap.empty || snap.docs.length < PAGE_SIZE) setExhausted(true);
      setHasFetched(true);
    } catch (err) {
      // A `getDocs` failure otherwise becomes an unhandled rejection with no UI
      // feedback (mirrors useMensagensWindow.loadOlder): expose it as `error`;
      // rethrow anything that is not a FirebaseError.
      if (err instanceof FirebaseError) {
        setError(err);
      } else {
        throw err;
      }
    } finally {
      if (first) setLoading(false);
      else setLoadingMore(false);
      inFlightRef.current = false;
    }
  }, []);

  // Kick off the FIRST page as soon as search becomes active. Term-independent,
  // so it runs once — later term edits only re-run the in-memory match below.
  useEffect(() => {
    if (active && !startedRef.current) {
      startedRef.current = true;
      void fetchPage(null);
    }
  }, [active, fetchPage]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMore || exhausted) return;
    await fetchPage(cursor);
  }, [loading, loadingMore, exhausted, cursor, fetchPage]);

  const groups = useMemo(() => {
    if (!regex) return [];
    return groupMatches(matchFetched(docs, regex));
  }, [regex, docs]);

  const matchCount = useMemo(() => groups.reduce((n, g) => n + g.matches.length, 0), [groups]);

  return {
    active,
    isLiteral,
    groups,
    regex,
    checkedCount: docs.length,
    matchCount,
    loading,
    loadingMore,
    error,
    exhausted,
    hasFetched,
    loadMore,
  };
}
