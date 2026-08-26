import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Fragment, createElement } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';
import { ESTADO_NFE } from '@delfrance/schemas';
import type { NotaFiscalEletronica } from '@delfrance/schemas';

import {
  NFE_LISTENER_IDLE_MS,
  NFE_LISTENER_UNSEEN_MS,
  NFE_MEMO_MAX,
  NFE_OPTIMISTIC_BUDGET,
  __resetLatestNfeMemo,
  useLatestNfe,
} from './useLatestNfe';
import type { LatestNfeStatus } from './useLatestNfe';

// Hoisted mutable state so each test can steer the two hooks `useLatestNfe`
// composes, then `rerender()` to observe the result. Mirrors the pattern in
// `PedidoCells.test.tsx`.
const { intersecting, uid, snapState, useSnapshotSpy } = vi.hoisted(() => ({
  // `null` = the observer has not reported yet (the real hook's `entry` before
  // its first callback). Distinct from `false`, which is a positive "off
  // screen" report — the gate treats them differently on purpose.
  intersecting: { current: null as boolean | null },
  // The signed-in uid the memo is scoped to. Swapping it stands in for a
  // logout + a second operator signing in on the same tab (a client-side
  // navigation, so module state survives).
  uid: { current: 'user-a' as string | null },
  snapState: {
    current: {
      data: undefined,
      loading: true,
      error: undefined,
    } as SnapshotState<SnapshotRow<NotaFiscalEletronica>[]>,
  },
  useSnapshotSpy: vi.fn(),
}));

vi.mock('@mantine/hooks', async () => {
  const actual = await vi.importActual<typeof import('@mantine/hooks')>('@mantine/hooks');
  return {
    ...actual,
    // The real hook builds an IntersectionObserver on ref attach, which jsdom
    // cannot drive. Stand in for the observed state directly.
    useIntersection: () => ({
      ref: () => {},
      entry:
        intersecting.current === null
          ? null
          : ({ isIntersecting: intersecting.current } as unknown as IntersectionObserverEntry),
    }),
  };
});

vi.mock('@delfrance/data/hooks', async () => {
  const actual =
    await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return {
    ...actual,
    // A spy, NOT a bare stub: the ARGUMENT is the assertion. `null` means the
    // listener is torn down, and that is the only deterministic proof the
    // viewport gate actually reduces the concurrent-listener count (#1216).
    useSnapshot: (q: unknown) => {
      useSnapshotSpy(q);
      return snapState.current;
    },
  };
});

vi.mock('@/lib/firebase/client', () => ({
  getFirebaseFirestore: () => ({}),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: uid.current === null ? null : { uid: uid.current }, loading: false }),
}));

vi.mock('@/lib/data/nfeCollection', () => ({
  nfeCollection: { ref: () => ({ __nfeRef: true }) },
}));

vi.mock('@delfrance/data', async () => {
  const actual = await vi.importActual<typeof import('@delfrance/data')>('@delfrance/data');
  return {
    ...actual,
    buildQuery: () => ({ __fakeQuery: true }),
    orderByField: () => ({ __c: 'orderBy' }),
    limit: () => ({ __c: 'limit' }),
  };
});

/** The argument of the most recent `useSnapshot` call. */
function lastQuery(): unknown {
  return useSnapshotSpy.mock.calls.at(-1)?.[0];
}

function nfeRow(estado: NotaFiscalEletronica['estado']): SnapshotRow<NotaFiscalEletronica>[] {
  return [
    {
      id: 'nfe-1',
      path: 'pedidos/p1/nfev4/nfe-1',
      data: { estado, numeracao: 7 } as NotaFiscalEletronica,
    },
  ];
}

describe('useLatestNfe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetLatestNfeMemo();
    useSnapshotSpy.mockClear();
    // Default to "the observer has not reported yet", the real state at mount.
    intersecting.current = null;
    uid.current = 'user-a';
    snapState.current = { data: undefined, loading: true, error: undefined };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes at mount, without waiting for the observer to report', () => {
    // Load-bearing: intersection delivery must NOT sit on the critical path of
    // the first badge. Those callbacks are throttled and can lag by seconds
    // while a 100-row table renders, which made `pedidos-nfe-snapshot` marginal
    // against its 10s assertion when the gate waited for them.
    const { result } = renderHook(() => useLatestNfe('p1'));

    expect(lastQuery()).not.toBeNull();
    expect(result.current.status).toBe('loading');
  });

  it('drops the listener shortly after the observer reports the row off screen', () => {
    const { rerender } = renderHook(() => useLatestNfe('p1'));
    expect(lastQuery()).not.toBeNull();

    intersecting.current = false;
    act(() => rerender());
    act(() => {
      vi.advanceTimersByTime(NFE_LISTENER_UNSEEN_MS - 1);
    });
    expect(lastQuery()).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    // This is the proof the gate still bounds the concurrent-listener count:
    // the off-screen tail of a 100-row first paint releases within ~1s.
    expect(lastQuery()).toBeNull();
  });

  it('bounds the FIRST-PAINT peak, not just the burst duration', () => {
    // #159 measured a first-paint LATENCY effect, so shortening the burst is
    // not the same as fixing it. Mount a full page's worth of rows with the
    // observer silent (exactly first paint) and count live subscriptions.
    const hooks = Array.from({ length: NFE_OPTIMISTIC_BUDGET + 40 }, (_, i) =>
      renderHook(() => useLatestNfe(`p${i}`)),
    );
    const live = hooks.filter((h) => h.result.current.status !== 'idle').length;

    expect(live).toBe(NFE_OPTIMISTIC_BUDGET);
    expect(live).toBeLessThan(hooks.length);

    // Slots are handed back when a row goes away, so scrolling — which unmounts
    // rows behind it — keeps refilling the budget rather than exhausting it
    // once and starving every later row.
    hooks.forEach((h) => h.unmount());
    const afterScroll = renderHook(() => useLatestNfe('fresh'));
    expect(afterScroll.result.current.status).not.toBe('idle');
  });

  it('gives a slot to a row that REPLACES a full page (the filter re-query)', () => {
    // React renders the NEW tree before committing the deletions of the old
    // one, so a claim made in a `useState` initializer sees a budget still held
    // by rows that are about to unmount — every replacement row starts inactive
    // and sits waiting on an intersection callback. That is the exact shape
    // that failed `pedidos-nfe-snapshot` 3/3: the spec filters to ONE pedido
    // before asserting the badge.
    //
    // Separate `renderHook` roots cannot catch this (each mount/unmount is its
    // own commit), so this drives ONE tree that swaps its children.
    const seen: Record<string, LatestNfeStatus> = {};
    function Row({ id }: { id: string }) {
      seen[id] = useLatestNfe(id).status;
      return null;
    }
    const page = (ids: string[]) =>
      createElement(Fragment, null, ...ids.map((id) => createElement(Row, { key: id, id })));

    const full = Array.from({ length: NFE_OPTIMISTIC_BUDGET }, (_, i) => `full-${i}`);
    const { rerender } = render(page(full));
    act(() => rerender(page(['filtered'])));

    expect(seen.filtered).not.toBe('idle');
  });

  it('keeps a row the observer reports visible subscribed indefinitely', () => {
    intersecting.current = true;
    const { rerender } = renderHook(() => useLatestNfe('p1'));

    act(() => {
      vi.advanceTimersByTime(NFE_LISTENER_IDLE_MS * 3);
    });
    act(() => rerender());

    expect(lastQuery()).not.toBeNull();
  });

  it('reports the latest doc once the snapshot settles', () => {
    intersecting.current = true;
    const { result, rerender } = renderHook(() => useLatestNfe('p1'));

    snapState.current = {
      data: nfeRow(ESTADO_NFE.aprovada),
      loading: false,
      error: undefined,
      fromCache: false,
    };
    act(() => rerender());

    expect(result.current.status).toBe('ready');
    expect(result.current.badge?.estado).toBe(ESTADO_NFE.aprovada);
    expect(result.current.latestId).toBe('nfe-1');
  });

  it('keeps the listener through the grace period, then tears it down', () => {
    intersecting.current = true;
    const { rerender } = renderHook(() => useLatestNfe('p1'));
    snapState.current = {
      data: nfeRow(ESTADO_NFE.gerado),
      loading: false,
      error: undefined,
      fromCache: false,
    };
    act(() => rerender());
    expect(lastQuery()).not.toBeNull();

    intersecting.current = false;
    act(() => rerender());
    act(() => {
      vi.advanceTimersByTime(NFE_LISTENER_IDLE_MS - 1);
    });
    expect(lastQuery()).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(lastQuery()).toBeNull();
  });

  it('cancels a pending teardown when the row comes back before the grace period', () => {
    intersecting.current = true;
    const { rerender } = renderHook(() => useLatestNfe('p1'));
    snapState.current = {
      data: nfeRow(ESTADO_NFE.gerado),
      loading: false,
      error: undefined,
      fromCache: false,
    };
    act(() => rerender());

    intersecting.current = false;
    act(() => rerender());
    act(() => {
      vi.advanceTimersByTime(NFE_LISTENER_IDLE_MS - 1);
    });

    intersecting.current = true;
    act(() => rerender());
    act(() => {
      vi.advanceTimersByTime(NFE_LISTENER_IDLE_MS * 2);
    });

    expect(lastQuery()).not.toBeNull();
  });

  it('repaints a torn-down row from the memo instead of flashing a skeleton', () => {
    intersecting.current = true;
    const first = renderHook(() => useLatestNfe('p1'));
    snapState.current = {
      data: nfeRow(ESTADO_NFE.aprovada),
      loading: false,
      error: undefined,
      fromCache: false,
    };
    act(() => first.rerender());
    first.unmount();

    // A brand-new mount that the observer then reports off screen: once the
    // optimistic subscription is released there is no listener, but the badge
    // is still painted from the memo rather than falling back to a skeleton.
    snapState.current = { data: undefined, loading: true, error: undefined };
    intersecting.current = false;
    const { result, rerender } = renderHook(() => useLatestNfe('p1'));
    act(() => {
      vi.advanceTimersByTime(NFE_LISTENER_UNSEEN_MS);
    });
    act(() => rerender());

    expect(lastQuery()).toBeNull();
    expect(result.current.status).toBe('ready');
    expect(result.current.badge?.estado).toBe(ESTADO_NFE.aprovada);
    expect(result.current.latestId).toBe('nfe-1');
    // ⚠️ The badge repaints, the DOCUMENT does not. `downloadNfeXml` reads the
    // XML out of whatever object it is handed, so a remembered render must
    // expose none — otherwise a scrolled-back row serves a stale `procNFe`.
    expect(result.current.doc).toBeUndefined();
  });

  it('remembers "this pedido has no NF-e" distinctly from "never looked"', () => {
    intersecting.current = true;
    const first = renderHook(() => useLatestNfe('p1'));
    snapState.current = { data: [], loading: false, error: undefined, fromCache: false };
    act(() => first.rerender());
    expect(first.result.current.status).toBe('ready');
    expect(first.result.current.badge).toBeUndefined();
    first.unmount();

    intersecting.current = false;
    snapState.current = { data: undefined, loading: true, error: undefined };

    // The pedido that WAS looked at reports a settled "no NF-e"...
    const seen = renderHook(() => useLatestNfe('p1'));
    expect(seen.result.current.status).toBe('ready');
    expect(seen.result.current.badge).toBeUndefined();

    // ...while an unrelated pedido stays `idle`, so its cell renders a
    // placeholder rather than claiming it has no nota fiscal.
    const unseen = renderHook(() => useLatestNfe('outro'));
    expect(unseen.result.current.status).not.toBe('ready');
  });

  it('never replays one operator’s badge to the next signed-in user', () => {
    // Logout is `signOut()` + `router.replace('/login')` — a CLIENT navigation
    // with no reload — so this module-level memo survives it. Without an owner
    // it would paint user B's rows with user A's NF-e.
    intersecting.current = true;
    const a = renderHook(() => useLatestNfe('p1'));
    snapState.current = {
      data: nfeRow(ESTADO_NFE.aprovada),
      loading: false,
      error: undefined,
      fromCache: false,
    };
    act(() => a.rerender());
    expect(a.result.current.badge?.estado).toBe(ESTADO_NFE.aprovada);
    a.unmount();

    // User B signs in on the same tab and the row is off screen (no listener).
    uid.current = 'user-b';
    intersecting.current = false;
    snapState.current = { data: undefined, loading: true, error: undefined };

    const b = renderHook(() => useLatestNfe('p1'));
    expect(b.result.current.status).not.toBe('ready');
    expect(b.result.current.badge).toBeUndefined();
  });

  it('does not remember an empty CACHED snapshot as “no NF-e”', () => {
    // `persistentLocalCache` emits `fromCache: true` first, and for a query
    // nothing has cached that emission is `[]`. Rendering it is fine; storing
    // it would persist a false negative later mounts replay as a settled dash.
    intersecting.current = true;
    const first = renderHook(() => useLatestNfe('p1'));
    snapState.current = { data: [], loading: false, error: undefined, fromCache: true };
    act(() => first.rerender());
    // Rendered as "no NF-e" for now — the same listener corrects it.
    expect(first.result.current.status).toBe('ready');
    first.unmount();

    intersecting.current = false;
    snapState.current = { data: undefined, loading: true, error: undefined };

    // Nothing was persisted, so an unsubscribed remount says "unknown".
    const second = renderHook(() => useLatestNfe('p1'));
    expect(second.result.current.status).not.toBe('ready');
  });

  it('bounds the memo, evicting the oldest pedido first', () => {
    // Fill past the cap. Each pedido is observed once, then unmounted.
    for (let i = 0; i < NFE_MEMO_MAX + 1; i += 1) {
      intersecting.current = true;
      const h = renderHook(() => useLatestNfe(`p${i}`));
      snapState.current = {
        data: nfeRow(ESTADO_NFE.gerado),
        loading: false,
        error: undefined,
        fromCache: false,
      };
      act(() => h.rerender());
      h.unmount();
    }

    intersecting.current = false;
    snapState.current = { data: undefined, loading: true, error: undefined };

    // `p0` was evicted; the most recent one survives.
    expect(renderHook(() => useLatestNfe('p0')).result.current.status).not.toBe('ready');
    expect(renderHook(() => useLatestNfe(`p${NFE_MEMO_MAX}`)).result.current.status).toBe('ready');
  });
});
