import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Firestore } from 'firebase/firestore';
import { ZodError } from 'zod';
import { type GrupoComId, varianteFakePath } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * The children snapshot is driven through a real external store so an emission
 * re-renders the component on its own — that is what makes the optimistic echo
 * observable at the moment it happens, instead of being simulated by a manual
 * `rerender` after the fact.
 */
const h = vi.hoisted(() => {
  type Row = { id: string; data: Record<string, unknown> };
  const listeners = new Set<() => void>();
  const snap = {
    current: { data: [] as Row[], loading: false, error: undefined },
  };
  const parent = {
    current: {
      data: { id: 'p1', data: { nome: 'Camiseta', sku: 'CAM' } },
      loading: false,
      error: undefined,
    },
  };
  const ops: Array<{
    kind: 'set' | 'update' | 'delete';
    id: string;
    data?: Record<string, unknown>;
  }> = [];
  /** Parked `batch.commit()` calls — a test resolves them when it chooses. */
  const commits: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];
  let minted = 0;
  return {
    snap,
    parent,
    ops,
    commits,
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getSnap: () => snap.current,
    /** Emit a children snapshot, the way `onSnapshot` would. */
    setChildren: (rows: Row[]) => {
      snap.current = { data: rows, loading: false, error: undefined };
      for (const l of listeners) l();
    },
    // A COUNTER, never a constant: every staged row's key is a minted id now, so
    // a fixed stub would collapse them all onto one key and one document.
    nextDocId: () => {
      minted += 1;
      return `minted-${minted}`;
    },
    reset: () => {
      ops.length = 0;
      commits.length = 0;
      minted = 0;
      snap.current = { data: [], loading: false, error: undefined };
    },
  };
});

vi.mock('@delfrance/data', () => ({
  buildQuery: () => ({ __q: 'children' }),
  whereEqual: () => ({}),
}));

vi.mock('@delfrance/data/hooks', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useSnapshot: () => useSyncExternalStore(h.subscribe, h.getSnap, h.getSnap),
    useDocSnapshot: () => h.parent.current,
  };
});

// Stubbed so the real module's `defineCollection` never runs against the
// `@delfrance/data` mock above.
vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: {
    ref: () => ({ __ref: 'produtos' }),
    docRef: (_db: unknown, _ctx: unknown, id: string) => ({ id }),
  },
}));

vi.mock('@/lib/produtos/docId', () => ({ newDocId: () => h.nextDocId() }));

vi.mock('@/lib/produtos/references', () => ({
  findProdutoReferences: async () => ({}),
  findManyProdutoReferences: async (_db: unknown, ids: string[]) =>
    new Map(ids.map((id) => [id, {}])),
  hasReferences: () => false,
  describeReferences: () => 'em uso',
}));

vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ href, children }: { href: string; children: React.ReactNode }) =>
      createElement('a', { href }, children),
  };
});

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    writeBatch: () => ({
      set: (ref: { id: string }, data: Record<string, unknown>) =>
        h.ops.push({ kind: 'set', id: ref.id, data }),
      update: (ref: { id: string }, data: Record<string, unknown>) =>
        h.ops.push({ kind: 'update', id: ref.id, data }),
      delete: (ref: { id: string }) => h.ops.push({ kind: 'delete', id: ref.id }),
      // Parks: the flush stays inside `await batch.commit()` until a test
      // resolves it, which is exactly the window the bug lives in.
      commit: () =>
        new Promise<void>((resolve, reject) => {
          h.commits.push({ resolve, reject });
        }),
    }),
  };
});

const { VariationManager } = await import('./VariationManager');

/* --------------------------------- fixtures -------------------------------- */

const db = {} as unknown as Firestore;
const DUP_ERROR = 'SKU duplicado entre as variações';
const uidP = varianteFakePath('gT', 'P');
const uidG = varianteFakePath('gT', 'G');

function grupos(): GrupoComId[] {
  return [
    {
      id: 'gT',
      data: {
        nome: 'Tamanho',
        ordem: 1,
        permiteFotos: false,
        variacoesIds: ['P', 'G'],
        variacoes: [
          { id: 'P', nome: 'P', codigo: 'P' },
          { id: 'G', nome: 'G', codigo: 'G' },
        ],
      },
    },
  ] as GrupoComId[];
}

/** A persisted child, as the snapshot would deliver it. */
function child(
  id: string,
  nome: string,
  sku: string | null,
  variacoesUid: string[] | null,
  ordem: number,
) {
  return { id, data: { nome, sku, variacoesUid, ordem } };
}

function renderManager(value: string[] = [uidP, uidG]) {
  const flushRef: React.MutableRefObject<((parentId: string) => Promise<void>) | null> = {
    current: null,
  };
  const utils = render(
    <MantineTestProvider>
      <VariationManager
        produtoId="p1"
        db={db}
        grupos={grupos()}
        value={value}
        onChange={() => undefined}
        onGroupsChange={() => undefined}
        flushRef={flushRef}
      />
    </MantineTestProvider>,
  );
  return { ...utils, flushRef };
}

/** Every SKU input currently rendered — one per row. */
function skuInputs(): HTMLInputElement[] {
  return screen.getAllByLabelText('SKU') as HTMLInputElement[];
}

function rowCount(): number {
  return screen.queryAllByLabelText('SKU').length;
}

/**
 * Start the flush and let it run up to the parked `commit()`. The promise is
 * created OUTSIDE `act` on purpose.
 */
async function startFlush(
  flush: (id: string) => Promise<void>,
): Promise<{ pending: Promise<void> }> {
  const pending = flush('p1');
  pending.catch(() => undefined);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  // Wrapped: an async function that RETURNS a promise adopts it, so a bare
  // `return pending` would make `await startFlush(...)` wait for the very
  // commit this helper exists to leave parked.
  return { pending };
}

/** Resolve the OLDEST parked commit and let the flush finish. */
async function settleCommit(pending: Promise<void>) {
  const parked = h.commits.shift();
  await act(async () => {
    parked!.resolve();
    await pending;
  });
}

/** Deliver the batch's writes back through the snapshot — latency compensation. */
async function echoWrites(existing: ReturnType<typeof child>[] = []) {
  const written = h.ops.filter((o) => o.kind === 'set' || o.kind === 'update');
  await act(async () => {
    h.setChildren([
      ...existing.filter((e) => !written.some((w) => w.id === e.id)),
      ...written.map((o) => ({ id: o.id, data: o.data! })),
    ]);
  });
}

beforeEach(() => {
  h.reset();
});

afterEach(() => {
  cleanup();
});

describe('VariationManager — staged rows vs the optimistic snapshot echo', () => {
  it('reports no duplicate while the just-created children echo back (#1357)', async () => {
    const { flushRef } = renderManager();

    fireEvent.click(screen.getByText('Gerar variações'));
    expect(skuInputs().map((i) => i.value)).toEqual(['CAMP', 'CAMG']);

    const { pending } = await startFlush(flushRef.current!);
    expect(h.commits).toHaveLength(1);
    expect(h.ops.filter((o) => o.kind === 'set')).toHaveLength(2);

    // The echo lands while the staged rows are still there — `commit()` has not
    // resolved, so `setNewRows([])` has not run. This is the exact state that
    // used to render each variation twice.
    await echoWrites();

    expect(screen.queryAllByText(DUP_ERROR)).toHaveLength(0);
    expect(rowCount()).toBe(2);

    // The blocking half: a save issued in this window must not be refused.
    await act(async () => {
      await expect(flushRef.current!('p1')).resolves.toBeUndefined();
    });

    await settleCommit(pending);
    expect(screen.queryAllByText(DUP_ERROR)).toHaveLength(0);
    expect(rowCount()).toBe(2);
  });

  it('keeps the staged rows when a no-op flush races a batch that is then rejected', async () => {
    const { flushRef } = renderManager();
    fireEvent.click(screen.getByText('Gerar variações'));

    const { pending } = await startFlush(flushRef.current!);
    await echoWrites();

    // A second flush in the window resolves to nothing: the echo already hid
    // the staged rows from `rows`, so this flush never saw — and never wrote —
    // them. It must not clear them either.
    await act(async () => {
      await expect(flushRef.current!('p1')).resolves.toBeUndefined();
    });

    // Now the only batch that ever carried those `set`s fails. Firestore rolls
    // the local writes back, so the echo disappears; the operator's staged work
    // is all that is left and it has to still be there.
    await act(async () => {
      h.commits.shift()!.reject(new Error('permission-denied'));
      h.setChildren([]);
      await pending.catch(() => undefined);
    });

    expect(rowCount()).toBe(2);
    expect(skuInputs().map((i) => i.value)).toEqual(['CAMP', 'CAMG']);
  });

  it('hands the row over to the server doc, so a later edit updates instead of re-creating', async () => {
    const { flushRef } = renderManager();
    fireEvent.click(screen.getByText('Gerar variações'));

    const { pending } = await startFlush(flushRef.current!);
    await echoWrites();
    await settleCommit(pending);

    const created = h.ops.filter((o) => o.kind === 'set').map((o) => o.id);
    h.ops.length = 0;

    fireEvent.change(skuInputs()[0]!, { target: { value: 'CAMP-2' } });
    const { pending: second } = await startFlush(flushRef.current!);

    // An `update` on the SAME doc — proof the echo replaced the staged row
    // instead of leaving a twin that would have been `set` under a fresh id.
    expect(h.ops.map((o) => o.kind)).toContain('update');
    expect(h.ops.some((o) => o.kind === 'set')).toBe(false);
    expect(h.ops.find((o) => o.kind === 'update')!.id).toBe(created[0]);

    await settleCommit(second);
  });

  it('still reports a genuine sibling collision between two different documents', async () => {
    // A legacy child with no `variacoesUid` and the SKU the P combo will get.
    h.setChildren([child('legacy-1', 'Camiseta P', 'CAMP', null, 0)]);
    const { flushRef } = renderManager();

    fireEvent.click(screen.getByText('Gerar variações'));

    // Three rows, two of them genuinely sharing CAMP.
    expect(rowCount()).toBe(3);
    expect(screen.queryAllByText(DUP_ERROR)).toHaveLength(2);

    const err = await flushRef.current!('p1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect((err as ZodError).issues[0]!.message).toContain(`${DUP_ERROR}: CAMP`);
    expect(h.commits).toHaveLength(0);
  });

  it('keeps a manually added row alongside a legacy child that has no variacoesUid', async () => {
    // Both carry an empty combo, so a `sameCombo`-based dedup would eat the new
    // row — `sameCombo([], [])` is true.
    h.setChildren([child('legacy-1', 'Camiseta', 'LEG', null, 0)]);
    renderManager();

    fireEvent.click(screen.getByText('Nova variante'));

    expect(rowCount()).toBe(2);
  });

  it('does not report a duplicate when the id reuse absorbs the staged create (#117)', async () => {
    h.setChildren([child('c1', 'Camiseta P', 'CAMP', [uidP], 0)]);
    const { flushRef } = renderManager();

    // Stage the deletion, then regenerate — the P combo comes back as a new row
    // with the same SKU, which `reconcileStagedChildren` pairs onto `c1`.
    await act(async () => {
      fireEvent.click(screen.getAllByLabelText('Remover variação')[0]!);
    });
    fireEvent.click(screen.getByText('Gerar variações'));
    expect(screen.queryAllByText(DUP_ERROR)).toHaveLength(0);

    const { pending } = await startFlush(flushRef.current!);
    await echoWrites([child('c1', 'Camiseta P', 'CAMP', [uidP], 0)]);

    // Undo the deletion mid-flight — the rows stay enabled while the form
    // submits, so this is reachable. The staged twin must not surface as a
    // second live sibling carrying the same SKU.
    await act(async () => {
      fireEvent.click(screen.getAllByLabelText('Desfazer exclusão')[0]!);
    });
    expect(screen.queryAllByText(DUP_ERROR)).toHaveLength(0);

    await settleCommit(pending);
  });

  it('clears a staged row that resolved to no write at all', async () => {
    const { flushRef } = renderManager();

    fireEvent.click(screen.getByText('Nova variante'));
    await act(async () => {
      fireEvent.click(screen.getAllByLabelText('Remover variação')[0]!);
    });
    expect(rowCount()).toBe(1);

    await act(async () => {
      await expect(flushRef.current!('p1')).resolves.toBeUndefined();
    });

    expect(h.commits).toHaveLength(0);
    expect(rowCount()).toBe(0);
  });
});
