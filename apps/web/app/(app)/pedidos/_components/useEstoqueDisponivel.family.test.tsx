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
const { docRefs, docRefMock, linhas } = vi.hoisted(() => ({
  docRefs: { current: [] as Array<{ produtoId: string; estoqueId: string }> },
  docRefMock: vi.fn(),
  /** Seeded estoque rows, by doc id — lets a test choose which row exists. */
  linhas: { current: {} as Record<string, { quantidade: number; quantidadeReservada: number }> },
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

/**
 * `useDocSnapshot` answers from `linhas`, keyed by the estoque doc id the hook
 * asked for — so a test can seed the CHILD's row, the PARENT's row or neither
 * and observe which one the badge ends up using. Always LOADED, so the hook
 * settles instead of pinning at "loading".
 */
vi.mock('@delfrance/data/hooks', () => ({
  useDocSnapshot: (ref: { __ref?: string } | null) => {
    const estoqueId = ref?.__ref?.split('/')[1] ?? '';
    const linha = linhas.current[estoqueId];
    return {
      data: linha ? { id: estoqueId, data: linha } : undefined,
      loading: false,
      error: null,
    };
  },
  useSnapshot: () => ({ data: [], loading: false, error: null }),
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
  linhas.current = {};
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
  });

  // ⚠️ The parent's row is subscribed as a FALLBACK, not ignored. `filhoUnicoId`
  // records that the family has one child; it says NOTHING about where the units
  // sit, and a produto whose stock was lançado on the parent and never moved
  // would otherwise render a confident red "0 em estoque".
  it('also subscribes to the parent row, as the fallback', () => {
    render({
      id: 'p1',
      ehKit: false,
      componentesKit: null,
      paiId: null,
      filhoUnicoId: 'c1',
    });
    expect(docRefs.current).toContainEqual({ produtoId: 'p1', estoqueId: 'est-p1-dep1' });
  });

  it('subscribes to the produto itself when it is not a family of one', () => {
    render({ id: 'p1', ehKit: false, componentesKit: null, paiId: null, filhoUnicoId: null });
    expect(docRefs.current).toContainEqual({ produtoId: 'p1', estoqueId: 'est-p1-dep1' });
    // ONE subscription — no fallback exists when nothing was resolved past.
    expect(docRefs.current).toHaveLength(1);
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

/**
 * ⚠️ `filhoUnicoId` says the family has one child; it says NOTHING about where
 * the units sit. A produto whose stock was lançado on the parent and never moved
 * would otherwise render a confident red "0 em estoque" — on the screen where
 * the operator picks quantities, which is worse than hiding the badge.
 */
describe('useEstoqueDisponivel — the sole member has no row', () => {
  const pai = { id: 'p1', ehKit: false, componentesKit: null, paiId: null, filhoUnicoId: 'c1' };

  it('uses the PARENT row when the child has none', () => {
    linhas.current = { 'est-p1-dep1': { quantidade: 12, quantidadeReservada: 0 } };
    expect(render(pai).result.current).toBe(12);
  });

  // ⚠️ Absence, not zero. When both rows exist the sole member answers — the
  // same thing the ERP does for any parent/child split, and the parent's
  // remainder is `residualEstoquePai`'s job.
  it('prefers the child row even when it reads zero', () => {
    linhas.current = {
      'est-c1-dep1': { quantidade: 0, quantidadeReservada: 0 },
      'est-p1-dep1': { quantidade: 12, quantidadeReservada: 0 },
    };
    expect(render(pai).result.current).toBe(0);
  });

  it('uses the child row when it has units', () => {
    linhas.current = { 'est-c1-dep1': { quantidade: 20, quantidadeReservada: 0 } };
    expect(render(pai).result.current).toBe(20);
  });

  it('reports 0 when neither row exists', () => {
    expect(render(pai).result.current).toBe(0);
  });

  it('leaves an ordinary produto reading its own row', () => {
    linhas.current = { 'est-p1-dep1': { quantidade: 7, quantidadeReservada: 0 } };
    const produto = {
      id: 'p1',
      ehKit: false,
      componentesKit: null,
      paiId: null,
      filhoUnicoId: null,
    };
    expect(render(produto).result.current).toBe(7);
  });
});
