import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { FirebaseError } from 'firebase/app';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SnapshotRow } from '@delfrance/data/hooks';
import type { Pedido } from '@delfrance/schemas';

import {
  PREFETCH_MAX_WAIT_MS,
  clienteQueryKey,
  collectRowReadTargets,
  intFreteTipoQueryKey,
  seedRowReads,
  usePedidoRowReadPrefetch,
} from './rowReadPrefetch';

const { getDocsByIdsMock } = vi.hoisted(() => ({ getDocsByIdsMock: vi.fn() }));

vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/data/clienteCollection', () => ({ clienteCollection: {} }));
vi.mock('@/lib/data/intFreteCollection', () => ({ intFreteCollection: {} }));
vi.mock('@/lib/data/getDocsByIds', () => ({
  getDocsByIds: (...args: unknown[]) => getDocsByIdsMock(...args),
}));
vi.mock('@/lib/data/dereferenceOuterRef', () => ({
  // The real helper accepts three legacy ref shapes; for these tests a bare
  // path string is enough.
  dereferenceOuterRef: (_db: unknown, ref: unknown) =>
    typeof ref === 'string' && ref.length > 0 ? { path: ref } : null,
}));

// A REAL provider rather than a mocked `useQueryClient`. Mocking it is the
// obvious shortcut and it silently lies: the hook seeds the instance the mock
// hands it while the assertions read another, so every seeding test fails with
// an empty cache and looks like a seeding bug.
//
// ⚠️ `gcTime: Infinity` is load-bearing under fake timers.
// `vi.runAllTimersAsync()` runs EVERY pending timer, and that includes
// TanStack's garbage collector — which evicts a seeded entry the moment it has
// no observer, exactly the state a freshly-seeded key is in before its cell
// enables. Without this, every seeding assertion reads `undefined` and the
// production code looks broken when it is not. (In the app the cells mount
// their disabled `useQuery` immediately, so the entry always has an observer.)
function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
}

let queryClient = makeClient();
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children);

function row(id: string, cliente: string | null, frete: string | null): SnapshotRow<Pedido> {
  return {
    id,
    path: `pedidos/${id}`,
    data: {
      clientePedidoOuterRef: cliente,
      freteInicial: frete ? { integracaoFreteOuterRef: frete } : null,
    } as unknown as Pedido,
  };
}

const toPath = (ref: unknown) => (typeof ref === 'string' && ref.length > 0 ? ref : null);

describe('collectRowReadTargets', () => {
  it('dedupes shared refs so N rows do not become N reads', () => {
    // The saving is real precisely because rows share clientes and int_fretes.
    const rows = [
      row('p1', 'clientes/a', 'int_frete/x'),
      row('p2', 'clientes/a', 'int_frete/x'),
      row('p3', 'clientes/b', 'int_frete/x'),
    ];
    const { clientes, intFretes } = collectRowReadTargets(rows, toPath);

    expect(clientes.map((c) => c.id)).toEqual(['a', 'b']);
    expect(intFretes.map((f) => f.id)).toEqual(['x']);
  });

  it('skips rows with no ref instead of emitting empty ids', () => {
    const { clientes, intFretes } = collectRowReadTargets(
      [row('p1', null, null), row('p2', 'clientes/a', null)],
      toPath,
    );

    expect(clientes.map((c) => c.id)).toEqual(['a']);
    expect(intFretes).toEqual([]);
  });
});

describe('seedRowReads', () => {
  it('seeds each cell key with the shape that cell’s own queryFn returns', () => {
    // ⚠️ ClienteCell stores the cliente DOCUMENT; FreteCell stores only `tipo`.
    // Seeding the wrong shape renders a differently-shaped object.
    const qc = makeClient();
    const cliente = { nome: 'Fulano', cpf_cnpj: '1' };
    seedRowReads(
      qc,
      [{ path: 'clientes/a', id: 'a' }],
      new Map([['a', cliente]]),
      [{ path: 'int_frete/x', id: 'x' }],
      new Map([['x', { tipo: 'melhorEnvios' as never }]]),
    );

    expect(qc.getQueryData(clienteQueryKey('clientes/a'))).toEqual(cliente);
    expect(qc.getQueryData(intFreteTipoQueryKey('int_frete/x'))).toBe('melhorEnvios');
  });

  it('leaves a missed id unseeded so that cell falls back to its own read', () => {
    const qc = makeClient();
    seedRowReads(qc, [{ path: 'clientes/a', id: 'a' }], new Map(), [], new Map());

    expect(qc.getQueryData(clienteQueryKey('clientes/a'))).toBeUndefined();
  });
});

describe('usePedidoRowReadPrefetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getDocsByIdsMock.mockReset();
    queryClient = makeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases the cells even when onRows NEVER fires', () => {
    // The graceful-degradation floor. If the provider is wired but the callback
    // never arrives — an empty page, a TableView that changed shape — the cells
    // must still read for themselves rather than wait forever.
    const { result } = renderHook(() => usePedidoRowReadPrefetch(), { wrapper });
    expect(result.current.status).toBe('pending');

    act(() => {
      vi.advanceTimersByTime(PREFETCH_MAX_WAIT_MS);
    });

    expect(result.current.status).toBe('settled');
    expect(getDocsByIdsMock).not.toHaveBeenCalled();
  });

  it('releases the cells when the batch REJECTS', async () => {
    // A failed prefetch must cost a fallback read, never a blank column.
    getDocsByIdsMock.mockRejectedValue(new FirebaseError('unavailable', 'offline'));
    const { result } = renderHook(() => usePedidoRowReadPrefetch(), { wrapper });

    await act(async () => {
      result.current.onRows([row('p1', 'clientes/a', null)]);
      await vi.runAllTimersAsync();
    });

    expect(result.current.status).toBe('settled');
  });

  it('settles immediately when the page references nothing to batch', async () => {
    const { result } = renderHook(() => usePedidoRowReadPrefetch(), { wrapper });

    await act(async () => {
      result.current.onRows([row('p1', null, null)]);
    });

    expect(result.current.status).toBe('settled');
    expect(getDocsByIdsMock).not.toHaveBeenCalled();
  });

  it('issues ONE batched read per collection, not one per row', async () => {
    // This is the whole point: 40 rows must not become 40 reads.
    getDocsByIdsMock.mockResolvedValue(new Map());
    const rows = Array.from({ length: 40 }, (_, i) =>
      row(`p${i}`, `clientes/c${i}`, `int_frete/f${i % 3}`),
    );
    const { result } = renderHook(() => usePedidoRowReadPrefetch(), { wrapper });

    await act(async () => {
      result.current.onRows(rows);
      await vi.runAllTimersAsync();
    });

    // One call per collection — chunking at the 30-id `in` cap happens inside
    // `getDocsByIds`, not here.
    expect(getDocsByIdsMock).toHaveBeenCalledTimes(2);
    const clienteIds = getDocsByIdsMock.mock.calls[0]?.[2] as string[];
    expect(clienteIds).toHaveLength(40);
    const freteIds = getDocsByIdsMock.mock.calls[1]?.[2] as string[];
    expect(freteIds).toHaveLength(3);
    expect(result.current.status).toBe('settled');
  });

  it('seeds the batch result into the keys the cells read', async () => {
    // End to end through the hook: what `getDocsByIds` returns must land under
    // the cell's own query key, or the cells re-read everything and the batch
    // is pure overhead.
    getDocsByIdsMock.mockResolvedValue(new Map([['a', { nome: 'Fulano' }]]));
    const { result } = renderHook(() => usePedidoRowReadPrefetch(), { wrapper });

    await act(async () => {
      result.current.onRows([row('p1', 'clientes/a', null)]);
      await vi.runAllTimersAsync();
    });

    expect(queryClient.getQueryData(clienteQueryKey('clientes/a'))).toEqual({ nome: 'Fulano' });
  });

  it('ignores a superseded batch so a stale page cannot seed the current one', async () => {
    // Filtering re-queries the page; the in-flight batch is then for rows nobody
    // is looking at.
    let resolveFirst: (v: Map<string, unknown>) => void = () => {};
    getDocsByIdsMock
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolveFirst = res as typeof resolveFirst;
          }),
      )
      .mockResolvedValue(new Map([['b', { nome: 'Segundo' }]]));

    const { result } = renderHook(() => usePedidoRowReadPrefetch(), { wrapper });
    act(() => result.current.onRows([row('p1', 'clientes/a', null)]));
    await act(async () => {
      result.current.onRows([row('p2', 'clientes/b', null)]);
      await vi.runAllTimersAsync();
    });

    await act(async () => {
      resolveFirst(new Map([['a', { nome: 'Primeiro' }]]));
      await vi.runAllTimersAsync();
    });

    expect(queryClient.getQueryData(clienteQueryKey('clientes/a'))).toBeUndefined();
  });
});
