import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';
import { ESTADO_NFE } from '@delfrance/schemas';
import type { NotaFiscalEletronica } from '@delfrance/schemas';

import {
  NFE_LISTENER_IDLE_MS,
  NFE_MEMO_MAX,
  __resetLatestNfeMemo,
  useLatestNfe,
} from './useLatestNfe';

// Hoisted mutable state so each test can steer the two hooks `useLatestNfe`
// composes, then `rerender()` to observe the result. Mirrors the pattern in
// `PedidoCells.test.tsx`.
const { intersecting, uid, snapState, useSnapshotSpy } = vi.hoisted(() => ({
  intersecting: { current: false },
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
      entry: { isIntersecting: intersecting.current } as unknown as IntersectionObserverEntry,
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
    intersecting.current = false;
    uid.current = 'user-a';
    snapState.current = { data: undefined, loading: true, error: undefined };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens NO listener while the row is off screen', () => {
    const { result } = renderHook(() => useLatestNfe('p1'));

    expect(lastQuery()).toBeNull();
    expect(result.current.status).toBe('idle');
    expect(result.current.latest).toBeUndefined();
  });

  it('subscribes once the row enters the viewport', () => {
    const { result, rerender } = renderHook(() => useLatestNfe('p1'));
    expect(lastQuery()).toBeNull();

    intersecting.current = true;
    act(() => rerender());

    expect(lastQuery()).not.toBeNull();
    expect(result.current.status).toBe('loading');
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
    expect(result.current.latest?.estado).toBe(ESTADO_NFE.aprovada);
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

    // A brand-new mount, still off screen: no listener, but the badge is known.
    snapState.current = { data: undefined, loading: true, error: undefined };
    intersecting.current = false;
    const { result } = renderHook(() => useLatestNfe('p1'));

    expect(lastQuery()).toBeNull();
    expect(result.current.status).toBe('ready');
    expect(result.current.latest?.estado).toBe(ESTADO_NFE.aprovada);
    expect(result.current.latestId).toBe('nfe-1');
  });

  it('remembers "this pedido has no NF-e" distinctly from "never looked"', () => {
    intersecting.current = true;
    const first = renderHook(() => useLatestNfe('p1'));
    snapState.current = { data: [], loading: false, error: undefined, fromCache: false };
    act(() => first.rerender());
    expect(first.result.current.status).toBe('ready');
    expect(first.result.current.latest).toBeUndefined();
    first.unmount();

    intersecting.current = false;
    snapState.current = { data: undefined, loading: true, error: undefined };

    // The pedido that WAS looked at reports a settled "no NF-e"...
    const seen = renderHook(() => useLatestNfe('p1'));
    expect(seen.result.current.status).toBe('ready');
    expect(seen.result.current.latest).toBeUndefined();

    // ...while an unrelated pedido stays `idle`, so its cell renders a
    // placeholder rather than claiming it has no nota fiscal.
    const unseen = renderHook(() => useLatestNfe('outro'));
    expect(unseen.result.current.status).toBe('idle');
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
    expect(a.result.current.latest?.estado).toBe(ESTADO_NFE.aprovada);
    a.unmount();

    // User B signs in on the same tab and the row is off screen (no listener).
    uid.current = 'user-b';
    intersecting.current = false;
    snapState.current = { data: undefined, loading: true, error: undefined };

    const b = renderHook(() => useLatestNfe('p1'));
    expect(b.result.current.status).toBe('idle');
    expect(b.result.current.latest).toBeUndefined();
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
    expect(second.result.current.status).toBe('idle');
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
    expect(renderHook(() => useLatestNfe('p0')).result.current.status).toBe('idle');
    expect(renderHook(() => useLatestNfe(`p${NFE_MEMO_MAX}`)).result.current.status).toBe('ready');
  });
});
