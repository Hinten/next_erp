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

  // ⚠️ The dedup is right about the READ and was silent about the arithmetic.
  // Two components drawing on one produto share ONE pool; giving both aliases
  // the full stock says a kit needing 1+1 of a 4-unit produto can be built four
  // times. It can be built twice — and overstating availability is the direction
  // ADR 0014 goes out of its way to avoid on the kit path.
  it('divides a SHARED target between the components that alias onto it', async () => {
    produtos.current = {
      a: { paiId: null, filhoUnicoId: 'alvo' },
      alvo: { paiId: null, filhoUnicoId: null },
    };
    estoques.current = { 'est-alvo-dep1': { quantidade: 4, quantidadeReservada: 0 } };

    const { result } = render(kitProduto({ a: { quantidade: 1 }, alvo: { quantidade: 1 } }));
    await waitFor(() => expect(result.current).not.toBeNull());

    // 4 units, 2 consumed per kit ⇒ 2 kits, not 4.
    await waitFor(() => expect(result.current).toBe(2));
  });

  it('honours each alias’s own quantidade when dividing', async () => {
    produtos.current = {
      a: { paiId: null, filhoUnicoId: 'alvo' },
      alvo: { paiId: null, filhoUnicoId: null },
    };
    estoques.current = { 'est-alvo-dep1': { quantidade: 9, quantidadeReservada: 0 } };

    // 1 + 2 = 3 units per kit ⇒ floor(9 / 3) = 3 kits.
    const { result } = render(kitProduto({ a: { quantidade: 1 }, alvo: { quantidade: 2 } }));
    await waitFor(() => expect(result.current).not.toBeNull());
    await waitFor(() => expect(result.current).toBe(3));
  });

  // ⚠️ The ordinary case must be untouched: one component per target divides by
  // its own demand, which the helper then divides again — so the value handed
  // over has to stay the raw stock.
  it('does not divide when nothing aliases', async () => {
    produtos.current = { comp: { paiId: null, filhoUnicoId: 'comp-child' } };
    estoques.current = { 'est-comp-child-dep1': { quantidade: 9, quantidadeReservada: 0 } };

    const { result } = render(kitProduto({ comp: { quantidade: 2 } }));
    await waitFor(() => expect(result.current).not.toBeNull());
    // 9 / 2 = 4.5 — the helper's own division, applied once and NOT rounded.
    // Pinning the fraction is the point: it proves nothing divided twice.
    await waitFor(() => expect(result.current).toBe(4.5));
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

  // ⚠️ The spread puts the DOC id last, so a stray `id` on the document cannot
  // win. `produtoSchema` is strip-policy, so a SUCCESSFUL parse never carries
  // one — but `parseSoftRead` returns the RAW document when the schema rejects
  // it, and read-tolerance for unmodelled legacy shapes is mandatory (rule 8).
  // A legacy doc that both fails to parse and carries an `id` would otherwise
  // redirect the read to a produto the kit never names.
  it('uses the DOC id, not an id field the document happens to carry', async () => {
    produtos.current = { comp: { id: 'outro-produto', paiId: null, filhoUnicoId: null } };
    estoques.current = {
      'est-comp-dep1': { quantidade: 5, quantidadeReservada: 0 },
      'est-outro-produto-dep1': { quantidade: 99, quantidadeReservada: 0 },
    };

    const { result } = render(kitProduto({ comp: { quantidade: 1 } }));
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(estoqueReads.current).toEqual(['comp/est-comp-dep1']);
    await waitFor(() => expect(result.current).toBe(5));
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

/**
 * ⛔ The alias case with the units still on the PARENT (found by adversarial review).
 *
 * A kit listing both a family-of-one parent and its own sole member gives two
 * entries pointing at the CHILD. When the units were lançado on the parent and
 * never moved, the child has no row — so the target misses, and only the parent
 * reaches the own-row fallback (the child's `alvo === id`, so it is excluded from
 * the fallback set by construction).
 *
 * Keying the fallback by component id then left the child with no value at all,
 * and `kitEstoqueDisponivel` scores an absent entry as **0** — so the whole kit
 * read zero. That is the harm #1398 was opened on, reintroduced by the very code
 * written to prevent it.
 */
describe('useEstoqueDisponivel — an aliased kit whose units sit on the parent', () => {
  const kitProduto = (componentes: Record<string, { quantidade: number }>) => ({
    id: 'kit',
    ehKit: true,
    componentesKit: componentes as never,
    paiId: null,
    filhoUnicoId: null,
  });

  it('finds the parent’s units and divides them between BOTH aliases', async () => {
    produtos.current = {
      pai: { paiId: null, filhoUnicoId: 'filho' },
      filho: { paiId: 'pai', filhoUnicoId: null },
    };
    // The units never moved: the child has no row at all.
    estoques.current = { 'est-pai-dep1': { quantidade: 10, quantidadeReservada: 0 } };

    const { result } = render(kitProduto({ pai: { quantidade: 1 }, filho: { quantidade: 1 } }));

    // 10 units, one pool, two entries needing 1 each ⇒ 5 kits. NOT 0, and not 10.
    await waitFor(() => expect(result.current).toBe(5));
  });

  // The near-miss that keeps the division honest: the SAME two aliases when the
  // child DOES hold the units must still read from the child, and still divide.
  it('divides the CHILD’s units the same way when they were moved', async () => {
    produtos.current = {
      pai: { paiId: null, filhoUnicoId: 'filho' },
      filho: { paiId: 'pai', filhoUnicoId: null },
    };
    estoques.current = { 'est-filho-dep1': { quantidade: 10, quantidadeReservada: 0 } };

    const { result } = render(kitProduto({ pai: { quantidade: 1 }, filho: { quantidade: 1 } }));

    await waitFor(() => expect(result.current).toBe(5));
    expect(estoqueReads.current).not.toContain('pai/est-pai-dep1');
  });

  // ⚠️ And the ordinary single-component fallback must stay byte-identical: one
  // entry on a target with no row still reads the parent's raw stock, undivided.
  it('leaves a single component’s fallback undivided', async () => {
    produtos.current = { pai: { paiId: null, filhoUnicoId: 'filho' } };
    estoques.current = { 'est-pai-dep1': { quantidade: 10, quantidadeReservada: 0 } };

    const { result } = render(kitProduto({ pai: { quantidade: 1 } }));

    await waitFor(() => expect(result.current).toBe(10));
  });
});

/**
 * The OTHER direction of the same fallback, and the one #1402 makes ordinary.
 *
 * Every test above names the PARENT in `componentesKit`, because that is what
 * every kit in the corpus does today. The conversion rewrites those maps to name
 * the CHILD, and `KitManager` writes new kits that way from the start — so on
 * those `alvo === id`, the old `alvo !== id` gate matched nothing, and the whole
 * safety net silently became dead code.
 *
 * The units it protects do not go away when the ids move. The conversion
 * deliberately leaves a RESERVED remainder on the parent — a reservation is keyed
 * on the produto the pedido LINE names — and an *entrada* booked on a parent after
 * conversion is never swept up at all.
 */
describe('useEstoqueDisponivel — the kit names the child, the units are on the parent', () => {
  const kitProduto = (componentes: Record<string, { quantidade: number }>) => ({
    id: 'kit',
    ehKit: true,
    componentesKit: componentes as never,
    paiId: null,
    filhoUnicoId: null,
  });

  // ⚠️ `pai` MUST carry `filhoUnicoId: 'filho'`. Without it this passed for a
  // family of MANY just as happily — reviewer-found, and the reason the near-miss
  // below now exists: the fallback is only legitimate when the parent points back
  // at this very child.
  it('falls back to the PARENT row when the named child has none', async () => {
    produtos.current = {
      filho: { paiId: 'pai', filhoUnicoId: null },
      pai: { paiId: null, filhoUnicoId: 'filho' },
    };
    estoques.current = { 'est-pai-dep1': { quantidade: 9, quantidadeReservada: 0 } };

    const { result } = render(kitProduto({ filho: { quantidade: 1 } }));
    await waitFor(() => expect(result.current).not.toBeNull());

    // The child is tried first; the parent's row is the second read.
    expect(estoqueReads.current).toEqual(['filho/est-filho-dep1', 'pai/est-pai-dep1']);
    await waitFor(() => expect(result.current).toBe(9));
  });

  // ABSENCE, not zero — the same rule the parent-named direction obeys. A child
  // that HAS a row is the answer whatever it reads, or a produto whose stock
  // genuinely ran out would start reporting its parent's leftovers.
  it('does not fall back when the child has a zero row', async () => {
    produtos.current = {
      filho: { paiId: 'pai', filhoUnicoId: null },
      pai: { paiId: null, filhoUnicoId: 'filho' },
    };
    estoques.current = {
      'est-filho-dep1': { quantidade: 0, quantidadeReservada: 0 },
      'est-pai-dep1': { quantidade: 9, quantidadeReservada: 0 },
    };

    const { result } = render(kitProduto({ filho: { quantidade: 1 } }));
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(estoqueReads.current).toEqual(['filho/est-filho-dep1']);
    await waitFor(() => expect(result.current).toBe(0));
  });

  /**
   * ⛔ The near-miss the suite could not express, and the bug it caught.
   *
   * `unidadeVendavel` maps EVERY child to itself, so `alvo === id` holds for a
   * variation of a family of MANY exactly as it does for a sole member. Letting
   * those fall back has both halves of the ADR 0014 failure at once: `m` reads
   * units that belong to `p`, `m` and `g` collectively, and because `m` and `g`
   * are DISTINCT targets the pool division never fires — so a kit needing 1+1 of
   * a 100-unit parent reads 100 assemblable instead of 50.
   */
  it('counts a variation of a family of MANY as zero, not its parent’s pool', async () => {
    produtos.current = {
      m: { paiId: 'camiseta', filhoUnicoId: null },
      g: { paiId: 'camiseta', filhoUnicoId: null },
      // The parent points at NEITHER — it is a family of many.
      camiseta: { paiId: null, filhoUnicoId: null },
    };
    estoques.current = { 'est-camiseta-dep1': { quantidade: 100, quantidadeReservada: 0 } };

    const { result } = render(kitProduto({ m: { quantidade: 1 }, g: { quantidade: 1 } }));
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(estoqueReads.current).not.toContain('camiseta/est-camiseta-dep1');
    await waitFor(() => expect(result.current).toBe(0));
  });

  // ...and the drift case, which the same reciprocity test covers for free: a
  // parent whose pointer names a DIFFERENT child says nothing about this one.
  it('refuses the fallback when the parent points at another child', async () => {
    produtos.current = {
      filho: { paiId: 'pai', filhoUnicoId: null },
      pai: { paiId: null, filhoUnicoId: 'outro' },
    };
    estoques.current = { 'est-pai-dep1': { quantidade: 9, quantidadeReservada: 0 } };

    const { result } = render(kitProduto({ filho: { quantidade: 1 } }));
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(estoqueReads.current).not.toContain('pai/est-pai-dep1');
    await waitFor(() => expect(result.current).toBe(0));
  });

  // ⚠️ The near-miss that bounds the extra read: a component with no `paiId` has
  // no other half to ask, so it must cost exactly one read and count as 0 — not
  // wander off to some other produto.
  it('does not read a second row for a component that has no parent', async () => {
    produtos.current = { avulso: { paiId: null, filhoUnicoId: null } };
    estoques.current = {};

    const { result } = render(kitProduto({ avulso: { quantidade: 1 } }));
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(estoqueReads.current).toEqual(['avulso/est-avulso-dep1']);
    await waitFor(() => expect(result.current).toBe(0));
  });

  // ⚠️ A kit naming BOTH halves reads ONE pool, not two — the parent's row answers
  // for both aliases, so the division below it stays honest. Reading two rows here
  // would say a kit needing 1+1 of a 4-unit produto can be built four times.
  it('reads the parent row ONCE when the kit names both halves', async () => {
    produtos.current = {
      pai: { paiId: null, filhoUnicoId: 'filho' },
      filho: { paiId: 'pai', filhoUnicoId: null },
    };
    estoques.current = { 'est-pai-dep1': { quantidade: 4, quantidadeReservada: 0 } };

    const { result } = render(kitProduto({ pai: { quantidade: 1 }, filho: { quantidade: 1 } }));
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(estoqueReads.current.filter((r) => r === 'pai/est-pai-dep1')).toHaveLength(1);
    await waitFor(() => expect(result.current).toBe(2));
  });
});
