import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
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
const { docRefs, docRefMock, estoqueReads, produtoBatches, produtos, linhas } = vi.hoisted(() => ({
  docRefs: { current: [] as Array<{ produtoId: string; estoqueId: string }> },
  docRefMock: vi.fn(),
  /** Every estoque document actually fetched, by id. */
  estoqueReads: { current: [] as string[] },
  /** Every `getDocsByIds` call's id list — one entry per CHUNKED QUERY. */
  produtoBatches: { current: [] as string[][] },
  produtos: { current: {} as Record<string, Record<string, unknown>> },
  /** Seeded estoque rows for the BADGE's own/fallback subscriptions, by doc id. */
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

vi.mock('@/lib/data/produtoCollection', () => ({ produtoCollection: { __handle: 'produtos' } }));

vi.mock('@/lib/data/getDocsByIds', () => ({
  getDocsByIds: async (_db: unknown, _handle: unknown, ids: readonly string[]) => {
    produtoBatches.current.push([...ids]);
    const out = new Map<string, Record<string, unknown>>();
    for (const id of ids) {
      const p = produtos.current[id];
      if (p) out.set(id, p);
    }
    return out;
  },
}));

vi.mock('firebase/firestore', async (importActual) => {
  const actual = await importActual<typeof import('firebase/firestore')>();
  return {
    ...actual,
    getDocFromServer: async (ref: { __ref?: string }) => {
      const id = ref.__ref ?? '';
      estoqueReads.current.push(id);
      const [, estoqueId] = id.split('/');
      const linha = estoques.current[estoqueId ?? ''];
      return { exists: () => linha !== undefined, data: () => linha };
    },
  };
});

const { estoques } = vi.hoisted(() => ({
  estoques: { current: {} as Record<string, { quantidade: number; quantidadeReservada: number }> },
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
  estoqueReads.current = [];
  produtoBatches.current = [];
  produtos.current = {};
  estoques.current = {};
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
 * A kit component can itself be the PARENT of a family of one — and that is the
 * case #1398 was opened on: kit `pQfcNwrP9hJB0bhfpfGM` read `disponível = 0`
 * while both its components held 20 and 14 units on their children.
 *
 * ⚠️ The read COST is asserted, not just the number. Resolving N components with
 * N extra `getDoc`s would double the reads of a query that fires while the
 * operator is typing; `getDocsByIds` chunks at the SDK's 30-id `in` cap, so a
 * kit of any realistic size costs ONE extra query.
 */
describe('useEstoqueDisponivel — kit components resolve through the sole member', () => {
  const kitProduto = (componentes: Record<string, { quantidade: number }>) => ({
    id: 'kit',
    ehKit: true,
    componentesKit: componentes as never,
    paiId: null,
    filhoUnicoId: null,
  });

  it('reads the CHILD row for a component that is a family-of-one parent', async () => {
    produtos.current = {
      comp: { paiId: null, filhoUnicoId: 'comp-child' },
    };
    estoques.current = { 'est-comp-child-dep1': { quantidade: 14, quantidadeReservada: 0 } };

    const { result } = render(kitProduto({ comp: { quantidade: 1 } }));
    await waitFor(() => expect(estoqueReads.current.length).toBeGreaterThan(0));

    // The kit names `comp`; the badge reads `comp-child`, where the stock is.
    expect(estoqueReads.current).toContain('comp-child/est-comp-child-dep1');
    expect(estoqueReads.current).not.toContain('comp/est-comp-dep1');
    await waitFor(() => expect(result.current).toBe(14));
  });

  // ⚠️ The cost guarantee. One chunked query for the whole component set.
  it('resolves every component in ONE batched query', async () => {
    produtos.current = {
      a: { paiId: null, filhoUnicoId: 'a-child' },
      b: { paiId: null, filhoUnicoId: null },
      c: { paiId: null, filhoUnicoId: 'c-child' },
    };
    estoques.current = {
      'est-a-child-dep1': { quantidade: 5, quantidadeReservada: 0 },
      'est-b-dep1': { quantidade: 9, quantidadeReservada: 0 },
      'est-c-child-dep1': { quantidade: 7, quantidadeReservada: 0 },
    };

    const { result } = render(
      kitProduto({ a: { quantidade: 1 }, b: { quantidade: 1 }, c: { quantidade: 1 } }),
    );
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(produtoBatches.current).toHaveLength(1);
    expect(produtoBatches.current[0]).toEqual(['a', 'b', 'c']);
    // min(5, 9, 7) over the components; the kit itself holds nothing.
    await waitFor(() => expect(result.current).toBe(5));
  });

  it('reads one estoque doc per DISTINCT target', async () => {
    // Two components resolving to the same produto must not read it twice.
    produtos.current = {
      a: { paiId: null, filhoUnicoId: 'alvo' },
      alvo: { paiId: null, filhoUnicoId: null },
    };
    estoques.current = { 'est-alvo-dep1': { quantidade: 4, quantidadeReservada: 0 } };

    const { result } = render(kitProduto({ a: { quantidade: 1 }, alvo: { quantidade: 1 } }));
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(estoqueReads.current).toEqual(['alvo/est-alvo-dep1']);
  });

  // A component whose produto doc could not be read resolves to ITSELF, so it
  // counts as 0 rather than as some other produto's stock.
  it('falls back to the component itself when its produto doc is missing', async () => {
    produtos.current = {};
    estoques.current = { 'est-comp-dep1': { quantidade: 3, quantidadeReservada: 0 } };

    const { result } = render(kitProduto({ comp: { quantidade: 1 } }));
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(estoqueReads.current).toEqual(['comp/est-comp-dep1']);
    await waitFor(() => expect(result.current).toBe(3));
  });

  // ⚠️ Same finding as the badge's own row, from the other side: a component
  // whose sole member has NO row keeps its own, or the whole kit reads 0 — the
  // harm #1398 was opened on, reintroduced by the fix for it.
  it('falls back to the COMPONENT’s own row when its sole member has none', async () => {
    produtos.current = { comp: { paiId: null, filhoUnicoId: 'comp-child' } };
    estoques.current = { 'est-comp-dep1': { quantidade: 9, quantidadeReservada: 0 } };

    const { result } = render(kitProduto({ comp: { quantidade: 1 } }));
    await waitFor(() => expect(result.current).not.toBeNull());

    // The sole member is tried first; the component's own row is the second read.
    expect(estoqueReads.current).toEqual(['comp-child/est-comp-child-dep1', 'comp/est-comp-dep1']);
    await waitFor(() => expect(result.current).toBe(9));
  });

  // ABSENCE, not zero — the sole member answers whenever it has a row at all.
  it('does not fall back when the sole member has a zero row', async () => {
    produtos.current = { comp: { paiId: null, filhoUnicoId: 'comp-child' } };
    estoques.current = {
      'est-comp-child-dep1': { quantidade: 0, quantidadeReservada: 0 },
      'est-comp-dep1': { quantidade: 9, quantidadeReservada: 0 },
    };

    const { result } = render(kitProduto({ comp: { quantidade: 1 } }));
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(estoqueReads.current).toEqual(['comp-child/est-comp-child-dep1']);
    await waitFor(() => expect(result.current).toBe(0));
  });

  // The `paiId` drift guard, on the component path too.
  it('does not follow a stale filhoUnicoId on a component that is a child', async () => {
    produtos.current = { comp: { paiId: 'algum-pai', filhoUnicoId: 'nao-seguir' } };
    estoques.current = { 'est-comp-dep1': { quantidade: 6, quantidadeReservada: 0 } };

    const { result } = render(kitProduto({ comp: { quantidade: 1 } }));
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(estoqueReads.current).toEqual(['comp/est-comp-dep1']);
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
