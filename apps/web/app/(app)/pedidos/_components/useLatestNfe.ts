'use client';

/**
 * The `/pedidos` NF column's data source — a realtime listener on the latest
 * doc in `pedidos/{pedidoId}/nfev4`, **gated on the row being on screen**.
 *
 * Why the gate exists (#1216). The cell must stay realtime: SEFAZ replies land
 * asynchronously and the operator watches the badge move without reloading. But
 * a listener per rendered row makes the list's page size its concurrent-listener
 * count on first paint, and #159/PR #1212 measured what that costs — at
 * `limit: 100` the vendas e2e lane never produced a clean run (a different
 * `/pedidos` LIST spec failed each time while every pedido EDITOR spec passed);
 * at 50 it was 166 passed, 0 failed, 0 flaky. That is a latency profile, not a
 * logic break.
 *
 * The issue proposed one collection-group query over the visible pedido ids.
 * That shape is not reachable: Firestore filters a collection-group query on
 * fields INSIDE the documents (plus `__name__`, the doc's own full path), and
 * the parent id is recoverable only AFTER a read (`doc.ref.parent.parent.id`,
 * as `useSubcollectionIdLookup` does) — never as a `where`. `nfeSchema` carries
 * no `pedidoId`, so batching would need a new denormalized key plus a backfill
 * of the legacy Flutter docs a production export brings with it.
 *
 * So the coupling is broken at the other end. Listener count now tracks screen
 * height instead of `limit`, and — because listeners are TORN DOWN on exit, not
 * merely mounted lazily — it stays bounded however far the operator scrolls.
 *
 * Three things keep that invisible to the operator:
 *
 * 1. `NFE_LISTENER_ROOT_MARGIN` keeps a row subscribed for roughly one screen
 *    beyond the fold, so ordinary scrolling never races the subscription.
 * 2. `NFE_LISTENER_IDLE_MS` delays teardown, so scrolling past a row and back
 *    does not thrash the Watch stream.
 * 3. {@link recallLatestNfe} — the last badge seen for a pedido this session.
 *    Firestore's IndexedDB cache (enabled in `lib/firebase/client.ts`) does emit
 *    a `fromCache: true` snapshot first on re-subscribe, but that does NOT stop
 *    a visual flash: `useSnapshot` sets `loading: true` on every query-identity
 *    change and the cell renders a Skeleton while loading. This memo is what
 *    guarantees a scroll-back repaints instantly.
 */
import { useEffect, useMemo, useState } from 'react';
import { useIntersection } from '@mantine/hooks';
import { useSnapshot } from '@delfrance/data/hooks';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import type { NotaFiscalEletronica } from '@delfrance/schemas';

import { nfeCollection } from '@/lib/data/nfeCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

/**
 * How far outside the viewport a row still counts as "visible". One screen of
 * margin above and below: enough that a normal scroll finds the badge already
 * resolved, small enough that a 100-row page is never all-subscribed at once.
 */
export const NFE_LISTENER_ROOT_MARGIN = '600px 0px';

/**
 * Grace period between a row leaving the viewport and its listener being torn
 * down. Absorbs scroll-past-and-back without re-registering a Watch target.
 */
export const NFE_LISTENER_IDLE_MS = 15_000;

/** Upper bound on the {@link recallLatestNfe} memo, evicted oldest-first. */
export const NFE_MEMO_MAX = 400;

export type LatestNfeStatus = 'idle' | 'loading' | 'ready';

export interface LatestNfeState {
  /** Attach to the cell's outermost element — the intersection target. */
  readonly ref: (element: HTMLDivElement | null) => void;
  /**
   * `idle` means "not subscribed and nothing remembered" — the caller must
   * render a neutral placeholder, NOT the "no NF-e" dash, or an off-screen row
   * would claim a pedido has no nota fiscal.
   */
  readonly status: LatestNfeStatus;
  readonly latest: NotaFiscalEletronica | undefined;
  /** The nfev4 doc id — the `[nfeId]` segment for the DANFE / CC-e routes. */
  readonly latestId: string | undefined;
}

interface NfeMemoEntry {
  readonly data: NotaFiscalEletronica | undefined;
  readonly id: string | undefined;
}

/**
 * Last badge seen per pedido, for the lifetime of the tab. An entry whose
 * `data` is `undefined` is a remembered "this pedido has no NF-e" — distinct
 * from an absent key, which means "never looked".
 */
const latestNfeMemo = new Map<string, NfeMemoEntry>();

function rememberLatestNfe(pedidoId: string, entry: NfeMemoEntry): void {
  // Delete-then-set so re-observing a pedido refreshes its recency; the Map's
  // insertion order is then an LRU and the oldest key is the right eviction.
  latestNfeMemo.delete(pedidoId);
  latestNfeMemo.set(pedidoId, entry);
  while (latestNfeMemo.size > NFE_MEMO_MAX) {
    const oldest = latestNfeMemo.keys().next();
    if (oldest.done) break;
    latestNfeMemo.delete(oldest.value);
  }
}

export function recallLatestNfe(pedidoId: string): NfeMemoEntry | undefined {
  return latestNfeMemo.get(pedidoId);
}

/** Test seam — the memo is module state, so it outlives a `cleanup()`. */
export function __resetLatestNfeMemo(): void {
  latestNfeMemo.clear();
}

export function useLatestNfe(pedidoId: string): LatestNfeState {
  const db = getFirebaseFirestore();
  // `useIntersection` memoizes its ref callback on the PRIMITIVE option values
  // (rootMargin/root/threshold), so this object literal does not re-create the
  // observer each render. Root stays the viewport: TableView renders a plain
  // `<Table>` with no scroll container.
  const { ref, entry } = useIntersection<HTMLDivElement>({
    rootMargin: NFE_LISTENER_ROOT_MARGIN,
  });
  const inView = entry?.isIntersecting ?? false;

  // Sticky-on, delayed-off. Entering cancels any pending teardown (the effect
  // cleanup clears the timer), so a row that flickers across the fold keeps one
  // continuous subscription.
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (inView) {
      setActive(true);
      return;
    }
    const timer = setTimeout(() => setActive(false), NFE_LISTENER_IDLE_MS);
    return () => clearTimeout(timer);
  }, [inView]);

  const query = useMemo(() => {
    // `useSnapshot(null)` IS the teardown: it unsubscribes and no-ops.
    if (!active) return null;
    const base = nfeCollection.ref(db, { pedidoId });
    // `ultima_modificacao` is set on every nfev4 write by the orchestrator
    // (both the initial `tx.set` and `persistPatch`). Ordering by it ensures
    // the doc actually appears in the snapshot — Firestore excludes docs whose
    // ordered field is absent, and the schema's generic `timestamp` field is
    // never set in Phase A. Unchanged from the pre-#1216 per-row query, so no
    // new index is needed: this is a same-parent scan.
    return buildQuery(base, [orderByField('ultima_modificacao', 'desc'), limit(1)]);
  }, [db, pedidoId, active]);

  const { data, loading } = useSnapshot<NotaFiscalEletronica>(query);
  const settled = query !== null && !loading && data !== undefined;

  useEffect(() => {
    if (!settled) return;
    rememberLatestNfe(pedidoId, { data: data?.[0]?.data, id: data?.[0]?.id });
  }, [settled, data, pedidoId]);

  if (settled) {
    return { ref, status: 'ready', latest: data?.[0]?.data, latestId: data?.[0]?.id };
  }
  // Subscribing (or torn down) with a remembered value: repaint it rather than
  // flashing a Skeleton. Deliberately preferred over `loading` — the value is
  // exactly as stale as what the operator was already looking at.
  const remembered = recallLatestNfe(pedidoId);
  if (remembered) {
    return { ref, status: 'ready', latest: remembered.data, latestId: remembered.id };
  }
  return {
    ref,
    status: query !== null ? 'loading' : 'idle',
    latest: undefined,
    latestId: undefined,
  };
}
