import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Firestore } from 'firebase/firestore';
import { createElement, type ReactNode } from 'react';

/**
 * Which estoque document the badge SUBSCRIBES to (#1398).
 *
 * `combineEstoqueDisponivel` is pure and already covered; what this pins is the
 * wiring above it — a pedido line naming the PARENT of a family of one must
 * read the CHILD's row, because the parent is a wrapper holding no available
 * stock and the badge would otherwise show a truthful, useless `0`.
 *
 * ⚠️ Asserted on the doc REF, not on the returned number. The number is what a
 * fixture says it is; the ref is the thing that would silently keep pointing at
 * the wrong produto.
 */
const { docRefs, docRefMock } = vi.hoisted(() => ({
  docRefs: { current: [] as Array<{ produtoId: string; estoqueId: string }> },
  docRefMock: vi.fn(),
}));

vi.mock('@/lib/data/estoqueProdutoCollection', () => ({
  estoqueProdutoCollection: {
    docRef: (_db: unknown, scope: { produtoId: string }, estoqueId: string) => {
      docRefs.current.push({ produtoId: scope.produtoId, estoqueId });
      docRefMock(scope.produtoId, estoqueId);
      return { __ref: `${scope.produtoId}/${estoqueId}` };
    },
    ref: () => ({ __collRef: true }),
  },
}));

vi.mock('@delfrance/data/hooks', () => ({
  useDocSnapshot: () => ({ data: undefined, loading: true, error: null }),
  useSnapshot: () => ({ data: undefined, loading: true, error: null }),
}));

import { useEstoqueDisponivel } from './useEstoqueDisponivel';

const db = {} as Firestore;
const DEP = 'dep1';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

const render = (produto: Parameters<typeof useEstoqueDisponivel>[1]) =>
  renderHook(() => useEstoqueDisponivel(db, produto, DEP), { wrapper });

beforeEach(() => {
  docRefs.current = [];
  docRefMock.mockClear();
});

describe('useEstoqueDisponivel — which produto the badge reads', () => {
  it('subscribes to the CHILD row when the line names a family-of-one parent', () => {
    render({
      id: 'p1',
      ehKit: false,
      componentesKit: null,
      paiId: null,
      filhoUnicoId: 'c1',
    });
    expect(docRefs.current).toContainEqual({ produtoId: 'c1', estoqueId: 'est-c1-dep1' });
    expect(docRefs.current.some((r) => r.produtoId === 'p1')).toBe(false);
  });

  it('subscribes to the produto itself when it is not a family of one', () => {
    render({ id: 'p1', ehKit: false, componentesKit: null, paiId: null, filhoUnicoId: null });
    expect(docRefs.current).toContainEqual({ produtoId: 'p1', estoqueId: 'est-p1-dep1' });
  });

  // ⚠️ The produto doc has not landed yet, so the family fields are absent. That
  // must read as "not known to be a family of one" — today's exact behaviour —
  // rather than throwing or hiding the badge.
  it('falls back to the named produto while the produto doc is still loading', () => {
    render({ id: 'p1', ehKit: false, componentesKit: null });
    expect(docRefs.current).toContainEqual({ produtoId: 'p1', estoqueId: 'est-p1-dep1' });
  });

  // The `paiId` drift guard, end to end: a child carrying a stale pointer reads
  // its OWN row, never the produto the stale pointer names.
  it('does not follow a stale filhoUnicoId on a child', () => {
    render({
      id: 'c1',
      ehKit: false,
      componentesKit: null,
      paiId: 'p1',
      filhoUnicoId: 'algum-outro',
    });
    expect(docRefs.current).toContainEqual({ produtoId: 'c1', estoqueId: 'est-c1-dep1' });
    expect(docRefs.current.some((r) => r.produtoId === 'algum-outro')).toBe(false);
  });
});
