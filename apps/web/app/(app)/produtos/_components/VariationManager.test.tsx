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
  // ⚠️ `data` is deliberately widened: the promoted-survivor tests seed a KIT
  // parent, and a narrow `{nome, sku}` would make the harness reject the very
  // fields the mirror exists to carry.
  const parent = {
    current: {
      data: {
        id: 'p1',
        data: { nome: 'Camiseta', sku: 'CAM' } as Record<string, unknown>,
      },
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
type ChildrenFlush = import('./VariationManager').ChildrenFlush;

/* --------------------------------- fixtures -------------------------------- */

const db = {} as unknown as Firestore;
const DUP_ERROR = 'SKU duplicado entre as variações';
const uidP = varianteFakePath('gT', 'P');
const uidG = varianteFakePath('gT', 'G');
/** A variante with NO `codigo` — its generated SKU is the parent's, verbatim. */
const uidSemCodigo = varianteFakePath('gT', 'U');

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
          { id: 'U', nome: 'Único', codigo: null },
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

function renderManager(value: string[] = [uidP, uidG], membroUnicoId: string | null = null) {
  const flushRef: React.MutableRefObject<ChildrenFlush | null> = { current: null };
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
        membroUnicoId={membroUnicoId}
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
async function startFlush(flush: ChildrenFlush): Promise<{ pending: Promise<unknown> }> {
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
async function settleCommit(pending: Promise<unknown>) {
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
      await expect(flushRef.current!('p1')).resolves.toEqual({ reusedByKey: {} });
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
      await expect(flushRef.current!('p1')).resolves.toEqual({ reusedByKey: {} });
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

  it('writes nothing when the operator never touched the tab (#1374)', async () => {
    // Legacy children store a 1-based `ordem` (root CLAUDE.md rule 8). The flush
    // renumbers from a 0-based loop index, so `ordem !== serverOrdem` for every
    // one of them — and now that the section is persistent this runs on EVERY
    // produto save, not only after the tab was opened. An untouched tab must not
    // rewrite nome/sku/variacoesUid/ordem on documents the save never touched.
    h.setChildren([
      child('c1', 'Camiseta P', 'CAMP', [uidP], 1),
      child('c2', 'Camiseta G', 'CAMG', [uidG], 2),
    ]);
    const { flushRef } = renderManager();
    expect(rowCount()).toBe(2);

    await act(async () => {
      await expect(flushRef.current!('p1')).resolves.toEqual({ reusedByKey: {} });
    });

    expect(h.ops).toEqual([]);
    expect(h.commits).toHaveLength(0);
  });

  it('returns the key to reused-id pairing for a row the #117 reuse absorbed (#1388)', async () => {
    // Delete a child, then regenerate its combo so the staged create carries the
    // SAME SKU: `reconcileStagedChildren` absorbs it onto `c1` and the batch
    // UPDATES that doc, writing nothing under the staged row's own key. The
    // pairing is the only record of where the row went, and the flush clears the
    // row right after — so if it is not returned here it cannot be recovered.
    h.setChildren([child('c1', 'Camiseta P', 'CAMP', [uidP], 0)]);
    // Only the P variant is selected, so Gerar produces exactly one combo — a
    // second one would be a genuine create and mask the absorption below.
    const { flushRef } = renderManager([uidP]);

    await act(async () => {
      fireEvent.click(screen.getAllByLabelText('Remover variação')[0]!);
    });
    fireEvent.click(screen.getByText('Gerar variações'));

    const { pending } = await startFlush(flushRef.current!);
    await settleCommit(pending);

    const result = (await pending) as { reusedByKey: Record<string, string> };
    expect(Object.values(result.reusedByKey)).toEqual(['c1']);
    // The batch UPDATED the reused doc; it never created one under the row key.
    expect(h.ops.some((o) => o.kind === 'set')).toBe(false);
    expect(h.ops.some((o) => o.kind === 'update' && o.id === 'c1')).toBe(true);
  });

  it('clears a staged row that resolved to no write at all', async () => {
    const { flushRef } = renderManager();

    fireEvent.click(screen.getByText('Nova variante'));
    await act(async () => {
      fireEvent.click(screen.getAllByLabelText('Remover variação')[0]!);
    });
    expect(rowCount()).toBe(1);

    await act(async () => {
      await expect(flushRef.current!('p1')).resolves.toEqual({ reusedByKey: {} });
    });

    expect(h.commits).toHaveLength(0);
    expect(rowCount()).toBe(0);
  });
});

/**
 * A family never loses its last child (#1398, PR 8).
 *
 * ⚠️ These assert WHICH outcome, not that there is one. `renomear` keeps the doc
 * id — and with it the estoque rows and their ledger, kit entries, marketplace
 * links, pedido lines — while `criar` starts empty. Getting that backwards is a
 * silent stock loss on the most ordinary edit there is, and both look identical
 * on screen afterwards: one row, named after the produto.
 */
describe('VariationManager — the family keeps a member', () => {
  /** Mark every rendered row for deletion. */
  async function removerTodas() {
    const botoes = screen.getAllByRole('button', { name: 'Remover variação' });
    for (const b of botoes) {
      await act(async () => {
        fireEvent.click(b);
        await Promise.resolve();
      });
    }
  }

  // ⚠️ The child carries a REAL combo. An earlier version of this test used a
  // child with `variacoesUid: null`, so "the taxonomy is cleared" was already
  // true before the code ran — the mutation that stopped clearing it survived.
  it('renames the only child in place instead of deleting it', async () => {
    h.setChildren([child('c1', 'Camiseta P', 'CAM-P', [uidP], 0)]);
    const { flushRef } = renderManager();
    await removerTodas();

    const { pending } = await startFlush(flushRef.current!);
    await settleCommit(pending);

    // ⛔ No delete at all — the id is the anchor for this produto's stock.
    expect(h.ops.filter((o) => o.kind === 'delete')).toEqual([]);
    const renomeada = h.ops.find((o) => o.id === 'c1' && o.kind === 'update');
    // It takes the PARENT's identity: this is the produto's own sellable unit
    // now, not a variation of it.
    expect(renomeada?.data).toMatchObject({ nome: 'Camiseta', sku: 'CAM' });
    // ...and stops being a variation, or the row keeps claiming a combo the
    // produto no longer has.
    expect(renomeada?.data?.variacoesUid).toBeNull();
  });

  it('points filhoUnicoId at the renamed survivor, not at nothing', async () => {
    h.setChildren([child('c1', 'Camiseta P', 'CAM-P', [uidP], 0)]);
    const { flushRef } = renderManager();
    await removerTodas();

    const { pending } = await startFlush(flushRef.current!);
    await settleCommit(pending);

    expect(h.ops).toContainEqual(
      expect.objectContaining({ kind: 'update', id: 'p1', data: { filhoUnicoId: 'c1' } }),
    );
  });

  // ⚠️ Two children's stock cannot merge and choosing a survivor would be
  // arbitrary, so this one starts empty — their estoque subtrees are swept by
  // `onProdutoDeleted` either way. What it stops is the produto being left with
  // no sellable unit at all.
  it('mints a fresh member when every child of a real family is deleted', async () => {
    h.setChildren([
      child('c1', 'Camiseta P', 'CAM-P', [uidP], 0),
      child('c2', 'Camiseta G', 'CAM-G', [uidG], 1),
    ]);
    const { flushRef } = renderManager([]);
    await removerTodas();

    const { pending } = await startFlush(flushRef.current!);
    await settleCommit(pending);

    expect(
      h.ops
        .filter((o) => o.kind === 'delete')
        .map((o) => o.id)
        .sort(),
    ).toEqual(['c1', 'c2']);
    const criada = h.ops.find((o) => o.kind === 'set');
    expect(criada?.data).toMatchObject({ paiId: 'p1', nome: 'Camiseta', variacoesUid: null });
    expect(h.ops).toContainEqual(
      expect.objectContaining({ kind: 'update', id: 'p1', data: { filhoUnicoId: criada!.id } }),
    );
  });

  // ⛔ The hazard the guard exists for. A produto from before #1398 has no
  // children AND holds its own stock; read-tolerance resolves it to itself.
  // Minting an empty member without MOVING the units — a migration's job — points
  // every stock reader at an empty document, and the produto reads 0.
  it('mints nothing for a produto that never had a child', async () => {
    h.setChildren([]);
    const { flushRef } = renderManager([]);

    // Stage a row and take it back: the flush runs with work to do and no
    // persisted delete, which is exactly the shape that must NOT mint.
    fireEvent.click(screen.getByRole('button', { name: 'Nova variante' }));
    await removerTodas();

    const { pending } = await startFlush(flushRef.current!);
    if (h.commits.length > 0) await settleCommit(pending);
    else await act(async () => void (await pending));

    expect(h.ops.filter((o) => o.kind === 'set')).toEqual([]);
  });

  // Deleting one of two leaves a live child, so the invariant never engages —
  // the ordinary delete must stay an ordinary delete.
  it('still deletes outright while another child survives', async () => {
    h.setChildren([
      child('c1', 'Camiseta P', 'CAM-P', [uidP], 0),
      child('c2', 'Camiseta G', 'CAM-G', [uidG], 1),
    ]);
    const { flushRef } = renderManager([]);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Remover variação' })[0]!);
      await Promise.resolve();
    });

    const { pending } = await startFlush(flushRef.current!);
    await settleCommit(pending);

    expect(h.ops.filter((o) => o.kind === 'delete').map((o) => o.id)).toEqual(['c1']);
    expect(h.ops.filter((o) => o.kind === 'set')).toEqual([]);
  });
});

/**
 * ⛔ A `codigo`-less variante must not block the save (found by adversarial review).
 *
 * The sole member copies the parent's SKU verbatim, and `cartesianVariations`
 * emits `base.sku + (variante.codigo ?? '')` — so a variante with no `codigo`
 * generates a child whose SKU **is** the parent's. Both shapes are modelled and
 * legal (`findDuplicateSkus`' own docstring calls the child-SKU == parent-SKU case
 * legacy-legal), and rule 3 exists to absorb exactly that create onto the sole
 * member's document.
 *
 * The duplicate gate ran BEFORE reconciliation, so it threw first: the save was
 * refused, both rows rendered red, and the operator could not proceed without
 * hand-editing a SKU or deleting the member.
 */
describe('VariationManager — the SKU gate runs after the reuse', () => {
  it('absorbs a codigo-less variante onto the sole member instead of refusing', async () => {
    // The family of one, as it exists after #1424: one child carrying the
    // parent's own SKU.
    h.setChildren([child('membro-1', 'Camiseta', 'CAM', null, 0)]);
    const { flushRef } = renderManager([uidSemCodigo], 'membro-1');

    fireEvent.click(screen.getByText('Gerar variações'));

    // No refusal, and the generated row landed ON the member's document.
    const { pending } = await startFlush(flushRef.current!);
    await settleCommit(pending);

    expect(h.ops.filter((o) => o.kind === 'set')).toEqual([]);
    expect(h.ops).toContainEqual(expect.objectContaining({ kind: 'update', id: 'membro-1' }));
  });

  // ...and the near-miss: a genuine collision between two DIFFERENT documents
  // must still be refused, or moving the gate has disarmed it.
  it('still refuses a real collision between two staged rows', async () => {
    h.setChildren([]);
    const { flushRef } = renderManager();

    fireEvent.click(screen.getByText('Gerar variações'));
    await act(async () => {
      const inputs = skuInputs();
      fireEvent.change(inputs[0]!, { target: { value: 'MESMO' } });
      fireEvent.change(inputs[1]!, { target: { value: 'MESMO' } });
      await Promise.resolve();
    });

    await expect(flushRef.current!('p1')).rejects.toThrow(DUP_ERROR);
  });
});

/**
 * ⛔ The mirrored `gtin` does not survive becoming a real variation.
 *
 * `montarMembroUnico` copies the parent's barcode onto a sole member — correct,
 * because it is the same physical article. But the moment rule 3 absorbs that
 * document into the first staged variation, the barcode stops being true of it: a
 * GTIN identifies ONE sellable article, so leaving it would publish variation P
 * carrying the family's barcode while M has none.
 */
describe('VariationManager — the absorbed member drops the family barcode', () => {
  it('clears gtin when a real variation absorbs the sole member', async () => {
    h.setChildren([child('membro-1', 'Camiseta', 'CAM', null, 0)]);
    const { flushRef } = renderManager([uidP, uidG], 'membro-1');

    fireEvent.click(screen.getByText('Gerar variações'));
    const { pending } = await startFlush(flushRef.current!);
    await settleCommit(pending);

    const absorvida = h.ops.find((o) => o.kind === 'update' && o.id === 'membro-1');
    expect(absorvida?.data).toMatchObject({ gtin: null });
  });

  // ⚠️ The near-miss. A row the reuse did NOT absorb is an ordinary edit, and an
  // ordinary edit must never wipe a barcode the operator entered.
  it('leaves gtin alone on an ordinary variation edit', async () => {
    h.setChildren([child('c1', 'Camiseta P', 'CAM-P', [uidP], 0)]);
    const { flushRef } = renderManager();

    await act(async () => {
      fireEvent.change(skuInputs()[0]!, { target: { value: 'CAM-P2' } });
      await Promise.resolve();
    });
    const { pending } = await startFlush(flushRef.current!);
    await settleCommit(pending);

    const editada = h.ops.find((o) => o.kind === 'update' && o.id === 'c1');
    expect(editada?.data).not.toHaveProperty('gtin');
  });
});

/**
 * ⛔ The promoted survivor is a MIRROR, not just a rename.
 *
 * `filhoUnicoId` points at it, so `unidadeVendavel` sends every stock, kit and
 * NF-e reader to it. The `criar` arm builds its member through
 * `montarMembroUnico`; the `renomear` arm used to write only nome/sku/variacoesUid
 * and leave everything else at whatever the variation happened to have.
 *
 * On a KIT parent that is a produto whose sellable unit is a non-kit with no
 * composition — which `calcularAlteracoesEstoque` reads as a line that moves
 * NOTHING.
 */
describe('VariationManager — the renamed survivor mirrors the parent', () => {
  it('takes the parent’s kit fields, not the variation’s defaults', async () => {
    h.parent.current = {
      data: {
        id: 'p1',
        data: {
          nome: 'Cesta',
          sku: 'CES',
          ehKit: true,
          ehKitVirtual: false,
          componentesKit: { 'comp-a': { quantidade: 2, limitarEstoque: true } },
          publicado: true,
          gtin: '789',
        },
      },
      loading: false,
      error: undefined,
    };
    // A variation carrying the create branch's defaults: not a kit, no map.
    h.setChildren([
      { id: 'c1', data: { nome: 'Cesta P', sku: 'CES-P', variacoesUid: [uidP], ordem: 0 } },
    ]);
    const { flushRef } = renderManager();

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Remover variação' })[0]!);
      await Promise.resolve();
    });
    const { pending } = await startFlush(flushRef.current!);
    await settleCommit(pending);

    const promovida = h.ops.find((o) => o.kind === 'update' && o.id === 'c1');
    expect(promovida?.data).toMatchObject({
      nome: 'Cesta',
      ehKit: true,
      componentesKit: { 'comp-a': { quantidade: 2, limitarEstoque: true } },
      componentesKitKeys: ['comp-a'],
      publicado: true,
    });
  });

  // ⚠️ `precos` stays out: the `onProdutoChanged` trigger owns it, with the
  // `propagatePriceToChildren` opt-out this must not defeat.
  it('does not carry precos', async () => {
    h.parent.current = {
      data: { id: 'p1', data: { nome: 'Cesta', sku: 'CES', precos: { l1: { valor: 9 } } } },
      loading: false,
      error: undefined,
    };
    h.setChildren([
      { id: 'c1', data: { nome: 'Cesta P', sku: 'CES-P', variacoesUid: [uidP], ordem: 0 } },
    ]);
    const { flushRef } = renderManager();

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Remover variação' })[0]!);
      await Promise.resolve();
    });
    const { pending } = await startFlush(flushRef.current!);
    await settleCommit(pending);

    expect(h.ops.find((o) => o.kind === 'update' && o.id === 'c1')?.data).not.toHaveProperty(
      'precos',
    );
  });

  // The near-miss: an ordinary variation edit must NOT gain the parent's mirror.
  it('leaves an ordinary edited variation alone', async () => {
    h.setChildren([
      child('c1', 'Camiseta P', 'CAM-P', [uidP], 0),
      child('c2', 'Camiseta G', 'CAM-G', [uidG], 1),
    ]);
    const { flushRef } = renderManager();

    await act(async () => {
      fireEvent.change(skuInputs()[0]!, { target: { value: 'CAM-P2' } });
      await Promise.resolve();
    });
    const { pending } = await startFlush(flushRef.current!);
    await settleCommit(pending);

    expect(h.ops.find((o) => o.kind === 'update' && o.id === 'c1')?.data).not.toHaveProperty(
      'ehKit',
    );
  });
});
