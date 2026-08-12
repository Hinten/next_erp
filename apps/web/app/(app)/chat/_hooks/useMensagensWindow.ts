'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FirebaseError } from 'firebase/app';
import { type FirestoreError, type QueryDocumentSnapshot, getDocs } from 'firebase/firestore';
import { buildQuery, limit, orderByField, paginate, whereOp } from '@delfrance/data';
import { useSnapshotWithDocs, type SnapshotRow } from '@delfrance/data/hooks';
import { ESTADO_ENVIO, type Mensagem } from '@delfrance/schemas';
import { mensagemCollection } from '@/lib/data/conversaCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import type { OptimisticMensagem } from '@/lib/chat/mensagemWrite';

/** Live window size — the newest N messages stream in real time (was 200). */
export const WINDOW_SIZE = 60;

/** Target-window sizes: messages loaded on each side of a deep-linked target. */
export const TARGET_OLDER = 30;
export const TARGET_NEWER = 10;

/**
 * A deep-link target (from a global-search match): centre the thread on the
 * message `msgId` whose ordering `ts` (ms-epoch `timestamp`) anchors the window.
 */
export interface TargetSpec {
  msgId: string;
  ts: number;
}

export interface ServerMensagem extends Mensagem {
  _id: string;
}

export type AnyMensagem = ServerMensagem | OptimisticMensagem;

export function isOptimistic(m: AnyMensagem): m is OptimisticMensagem {
  return '_optimistic' in m;
}

export function mensagemKey(m: AnyMensagem): string {
  return isOptimistic(m) ? m._docId : m._id;
}

interface OlderRow {
  id: string;
  data: Mensagem;
  snap: QueryDocumentSnapshot<Mensagem>;
}

/**
 * Merge the two target-window pages into one ascending, deduped list. `olderAsc`
 * (timestamp ≤ ts, already reversed to ascending) and `newerAsc` (timestamp > ts,
 * ascending) partition DISJOINTLY in production (≤ vs >) — the id-dedup here is
 * purely defensive belt-and-braces; sort by `timestamp` (null coerced to 0 so a
 * null-timestamp row sorts oldest). Pure + testable.
 */
export function mergeTargetWindow(olderAsc: OlderRow[], newerAsc: OlderRow[]): OlderRow[] {
  const seen = new Set<string>();
  const out: OlderRow[] = [];
  for (const r of [...olderAsc, ...newerAsc]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  const ts = (r: OlderRow) => r.data.timestamp ?? 0;
  return out.sort((a, b) => ts(a) - ts(b));
}

export interface MensagensWindow {
  /** Chronological (oldest → newest): older pages, live window, then pending. */
  messages: AnyMensagem[];
  loading: boolean;
  error: FirestoreError | undefined;
  /** No older page remains (getDocs returned empty) → show the exhausted note. */
  exhausted: boolean;
  loadingOlder: boolean;
  /** A load-older `getDocs` failed (FirebaseError) — surface an inline retry. */
  olderError: FirebaseError | undefined;
  loadOlder: () => Promise<void>;
  addOptimistic: (entry: OptimisticMensagem) => void;
  markOptimisticError: (docId: string) => void;
  /** True while showing a one-shot window AROUND a deep-link target (no listener). */
  targetMode: boolean;
  /** A target was requested but its doc is absent (deleted) → live fallback + alert. */
  targetMissing: boolean;
}

/**
 * The live message window for one conversa (extracted from `MensagemThread`):
 *   - a real-time window of the newest {@link WINDOW_SIZE} messages
 *     (`onSnapshot`, orderBy timestamp desc);
 *   - one-shot LOAD-OLDER pages (`getDocs` + cursor `paginate({ after })`),
 *     prepended, until Firestore returns an empty page (`exhausted`);
 *   - optimistic entries merged in and reconciled/pruned by the pre-minted doc
 *     id once the server snapshot picks up the write (the #529 contract).
 *
 * The paged/optimistic state is conversa-scoped: `MensagemThread` is rendered
 * with `key={conversaId}` so switching conversa remounts it and resets this
 * state cleanly (no stale older-pages / optimistic bleed between threads).
 *
 * TARGET-WINDOW mode (PR-C5): when a `target` (deep-link from a global-search
 * match) is passed, the live listener is SUSPENDED and a one-shot window is
 * loaded AROUND the target — `timestamp ≤ ts` desc limit 30 + `timestamp > ts`
 * asc limit 10 (two getDocs, merged ascending). Load-older still pages from the
 * oldest of the window. If the target doc is absent (deleted), the hook flags
 * `targetMissing` and falls back to the normal live window.
 */
export function useMensagensWindow(
  conversaId: string,
  target?: TargetSpec | null,
): MensagensWindow {
  const [optimistic, setOptimistic] = useState<OptimisticMensagem[]>([]);
  const [older, setOlder] = useState<OlderRow[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<FirebaseError | undefined>();

  // TARGET-WINDOW state — a one-shot window merged ascending, plus its flags.
  // `targetLoading` starts true when a target is set: `targeting` is already
  // true on the first render, so starting false would flash the empty state
  // for one frame before the fetch effect runs.
  const [targetWindow, setTargetWindow] = useState<OlderRow[]>([]);
  const [targetLoading, setTargetLoading] = useState(() => target != null);
  const [targetMissing, setTargetMissing] = useState(false);

  // Targeting is active only while a target is set AND its doc was found: on a
  // missing/deleted target we drop to the live window (the fallback).
  const targeting = target != null && !targetMissing;

  const liveQuery = useMemo(
    () =>
      // Suspend the live listener while a valid target window is showing.
      targeting
        ? null
        : buildQuery(mensagemCollection.ref(getFirebaseFirestore(), { conversaId }), [
            orderByField('timestamp', 'desc'),
            limit(WINDOW_SIZE),
          ]),
    [conversaId, targeting],
  );

  const { data: liveRows, loading: liveLoading, error } = useSnapshotWithDocs<Mensagem>(liveQuery);

  // Fetch the target window (two bounded getDocs) when the target changes.
  // READ COST: ≤TARGET_OLDER (timestamp≤ts desc) + ≤TARGET_NEWER (timestamp>ts
  // asc) = ≤40 doc reads, one-shot, NO live listener while in this mode.
  const targetMsgId = target?.msgId ?? null;
  const targetTs = target?.ts ?? null;
  useEffect(() => {
    // Leaving target mode (back to present): clear the window + its older pages
    // so the live window starts fresh.
    if (targetMsgId == null || targetTs == null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on target clear; converges
      setTargetWindow([]);
      setTargetMissing(false);
      setOlder([]);
      setExhausted(false);
      return;
    }
    let cancelled = false;
    setTargetLoading(true);
    setTargetMissing(false);
    setOlder([]);
    setExhausted(false);
    const run = async () => {
      const ref = mensagemCollection.ref(getFirebaseFirestore(), { conversaId });
      const [olderSnap, newerSnap] = await Promise.all([
        getDocs(
          buildQuery(ref, [
            whereOp('timestamp', '<=', targetTs),
            orderByField('timestamp', 'desc'),
            limit(TARGET_OLDER),
          ]),
        ),
        getDocs(
          buildQuery(ref, [
            whereOp('timestamp', '>', targetTs),
            orderByField('timestamp', 'asc'),
            limit(TARGET_NEWER),
          ]),
        ),
      ]);
      if (cancelled) return;
      const olderAsc: OlderRow[] = olderSnap.docs
        .map((d) => ({ id: d.id, data: d.data(), snap: d }))
        .reverse();
      const newerAsc: OlderRow[] = newerSnap.docs.map((d) => ({
        id: d.id,
        data: d.data(),
        snap: d,
      }));
      const merged = mergeTargetWindow(olderAsc, newerAsc);
      const found = merged.some((r) => r.id === targetMsgId);
      setTargetWindow(merged);
      setTargetMissing(!found);
      setTargetLoading(false);
      // A full desc page means older history may remain — allow load-older.
      // On a MISSING target we fall back to the live window, whose history is
      // unrelated to this fetch — never carry `exhausted` over (a stale-ts
      // short page would otherwise permanently disable load-older there).
      setExhausted(found ? olderSnap.docs.length < TARGET_OLDER : false);
    };
    run().catch((err: unknown) => {
      if (cancelled) return;
      setTargetLoading(false);
      // A failed target fetch falls back to the live window (like a missing
      // target); rethrow anything that is not a FirebaseError.
      if (err instanceof FirebaseError) {
        setTargetMissing(true);
      } else {
        throw err;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [conversaId, targetMsgId, targetTs]);

  // PRUNE reconciled optimistic entries once the server snapshot includes their
  // pre-minted doc id (otherwise a ghost resurrects when its server row ages out
  // of the window). Length-guarded so the reference stays stable on a no-op.
  useEffect(() => {
    if (!liveRows) return;
    const seen = new Set(liveRows.map((r) => r.id));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing optimistic state to the snapshot; guarded, converges
    setOptimistic((prev) => {
      const next = prev.filter((m) => !seen.has(m._docId));
      return next.length === prev.length ? prev : next;
    });
  }, [liveRows]);

  // FOLD dropped-tail live rows into `older` — closes the "vanishing middle
  // message" gap. The live window is limit-WINDOW_SIZE desc; once older pages
  // are loaded, each newly arriving message pushes the OLDEST live row off the
  // tail. Without this, that row lands in NEITHER `older` nor the live window →
  // a hole in the rendered thread. On each live-window advance we diff the
  // previous vs new live sets; any row that dropped off the tail AND is newer
  // than older's newest is contiguous with the loaded history, so we fold it
  // into `older` (ascending, dedup by id). Guarded to `older` non-empty: with no
  // older page there is no history contiguity to preserve — the window tail is
  // simply the floor, and load-older re-fetches from the current oldest cursor.
  const prevLiveRef = useRef<SnapshotRow<Mensagem>[] | null>(null);
  useEffect(() => {
    const prev = prevLiveRef.current;
    prevLiveRef.current = liveRows ?? null;
    if (!liveRows || !prev) return;
    setOlder((olderPrev) => {
      if (olderPrev.length === 0) return olderPrev;
      // `timestamp` is the query's orderBy key; coerce a (rare) null to 0 so a
      // null-timestamp row sorts oldest rather than breaking the comparison.
      const ts = (r: { data: Mensagem }) => r.data.timestamp ?? 0;
      const newestOlderTs = ts(olderPrev[olderPrev.length - 1]!);
      const liveIds = new Set(liveRows.map((r) => r.id));
      const olderIds = new Set(olderPrev.map((r) => r.id));
      const dropped = prev.filter(
        (r) => !liveIds.has(r.id) && !olderIds.has(r.id) && r.snap != null && ts(r) > newestOlderTs,
      );
      if (dropped.length === 0) return olderPrev;
      const folded: OlderRow[] = dropped.map((r) => ({ id: r.id, data: r.data, snap: r.snap! }));
      return [...olderPrev, ...folded].sort((a, b) => ts(a) - ts(b));
    });
  }, [liveRows]);

  const messages = useMemo<AnyMensagem[]>(() => {
    // The chronological TAIL is either the target window (already ascending) or
    // the live window (desc → reverse). Older pages are stored ascending and
    // prepend before it. `seenIds` dedupes (a boundary row can appear in both).
    const tail = targeting
      ? targetWindow.map((r) => ({ ...r.data, _id: r.id }) as ServerMensagem)
      : (liveRows ?? []).map((r) => ({ ...r.data, _id: r.id }) as ServerMensagem).reverse();
    const olderMapped = older.map((r) => ({ ...r.data, _id: r.id }) as ServerMensagem);
    const server: ServerMensagem[] = [];
    const seenIds = new Set<string>();
    for (const m of [...olderMapped, ...tail]) {
      if (seenIds.has(m._id)) continue;
      seenIds.add(m._id);
      server.push(m);
    }
    const pending = optimistic.filter((m) => !seenIds.has(m._docId));
    return [...server, ...pending];
  }, [targeting, targetWindow, liveRows, older, optimistic]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || exhausted) return;
    // Cursor = the oldest server row currently loaded: the oldest older-page row
    // if any, else — in target mode — the oldest of the target window, else the
    // oldest live row (last of the desc window).
    const cursor =
      older[0]?.snap ?? (targeting ? targetWindow[0]?.snap : liveRows?.[liveRows.length - 1]?.snap);
    if (!cursor) {
      setExhausted(true);
      return;
    }
    setLoadingOlder(true);
    setOlderError(undefined);
    try {
      const q = buildQuery(mensagemCollection.ref(getFirebaseFirestore(), { conversaId }), [
        orderByField('timestamp', 'desc'),
        ...paginate({ after: cursor, pageSize: WINDOW_SIZE }),
      ]);
      const snap = await getDocs(q);
      if (snap.empty) {
        setExhausted(true);
        return;
      }
      // Desc page → reverse to ascending, then prepend before the existing older.
      const page: OlderRow[] = snap.docs
        .map((d) => ({ id: d.id, data: d.data(), snap: d }))
        .reverse();
      setOlder((prev) => [...page, ...prev]);
      if (snap.docs.length < WINDOW_SIZE) setExhausted(true);
    } catch (err) {
      // A `getDocs` failure otherwise becomes an unhandled rejection with zero UI
      // feedback (mirrors useConversaQuery.loadMore): expose it as `olderError`
      // so the thread can render an inline retry; rethrow anything else.
      if (err instanceof FirebaseError) {
        setOlderError(err);
      } else {
        throw err;
      }
    } finally {
      setLoadingOlder(false);
    }
  }, [conversaId, exhausted, liveRows, loadingOlder, older, targeting, targetWindow]);

  const addOptimistic = useCallback((entry: OptimisticMensagem) => {
    setOptimistic((prev) => [...prev, entry]);
  }, []);

  const markOptimisticError = useCallback((docId: string) => {
    setOptimistic((prev) =>
      prev.map((m) => (m._docId === docId ? { ...m, estadoEnvio: ESTADO_ENVIO.erro } : m)),
    );
  }, []);

  return {
    messages,
    // In target mode the "loading" gate is the one-shot window fetch, not the
    // (suspended) live listener.
    loading: targeting ? targetLoading : liveLoading,
    error,
    exhausted,
    loadingOlder,
    olderError,
    loadOlder,
    addOptimistic,
    markOptimisticError,
    targetMode: targeting,
    targetMissing: target != null && targetMissing,
  };
}
