import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import type { Firestore } from 'firebase/firestore';
import { varianteFakePath, type ComponentesKit } from '@delfrance/schemas';
import { AfterSaveBlockedError } from '@delfrance/ui';
import type { ChildKitEdit } from '@/lib/produtos/kitChildren';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { VariationRow } from './VariationManager';
import type { KitVariacoesFlush } from './KitVariacoesManager';

const h = vi.hoisted(() => ({
  /** Every `saveChildrenComponentesKit` call, so a second save can be asserted absent. */
  saves: [] as Array<Array<{ id: string; componentesKit: unknown }>>,
  children: [] as Array<{ id: string; data: Record<string, unknown> }>,
  edits: [] as Array<{ recipes: ChildKitEdit[]; mirrorSoleMember: boolean }>,
  generation: undefined as Promise<void> | undefined,
  resetRevisionRef: { current: 0 },
  readParent: vi.fn(async (_ref: { id: string }) => ({
    data: (): { ehKit: boolean } | undefined => ({ ehKit: false }),
  })),
  toasts: [] as string[],
  rows: [] as unknown[],
  /** Every value the grid reported through `onDirtyChange`, in order (KNOWN #9 round 3). */
  relatos: [] as boolean[],
}));

vi.mock('@delfrance/data', () => ({
  buildQuery: () => ({ __q: 'children' }),
  whereEqual: () => ({}),
}));

vi.mock('@delfrance/data/hooks', () => ({
  useSnapshot: () => ({ data: h.children, loading: false, error: undefined }),
}));

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  getDocFromServer: h.readParent,
}));

vi.mock('@/lib/produtos/kitChildren', () => ({
  commitChildKitEdits: async (
    _db: unknown,
    _id: string,
    change: { recipes: ChildKitEdit[]; mirrorSoleMember: boolean },
  ) => {
    if (change.recipes.length === 0) return;
    h.edits.push(change);
    h.saves.push(change.recipes.map(({ id, componentesKit }) => ({ id, componentesKit })));
  },
}));

vi.mock('@/lib/data/produtoCollection', () => ({
  produtoCollection: {
    ref: () => ({ __ref: 'produtos' }),
    docRef: (_db: unknown, _context: unknown, id: string) => ({ id }),
  },
}));

vi.mock('@/lib/produtos/clientPort', () => ({
  getVariationChildrenByParent: async (_db: unknown, ids: string[]) => {
    if (!ids.includes('p1') && h.generation) await h.generation;
    return { p1: h.children.map((c) => ({ id: c.id, variacoesUid: [] })) };
  },
}));

// The per-row component editor is its own unit; here it only needs to be a
// handle for staging a map.
vi.mock('./KitManager', async () => {
  const { createElement } = await import('react');
  return {
    stripKitForSave: (v: unknown) => v,
    KitManager: ({
      onChange,
      value,
    }: {
      onChange: (next: unknown) => void;
      value: ComponentesKit | null;
    }) =>
      createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'stage-kit',
          'data-recipe': Object.keys(value ?? {}).join(','),
          onClick: () => onChange({ 'comp-1': { quantidade: 1 } }),
        },
        'stage',
      ),
  };
});

vi.mock('@mantine/notifications', () => ({
  notifications: { show: (args: { message?: string }) => h.toasts.push(args.message ?? '') },
}));

const { KitVariacoesManager } = await import('./KitVariacoesManager');

const db = {} as unknown as Firestore;

/** A STABLE reporter, as the page passes its `useState` setter. */
const relatar = (dirty: boolean) => {
  h.relatos.push(dirty);
};
/** The grid's last report — what the page holds right now. */
const ultimoRelato = () => h.relatos.at(-1);

function rows(): VariationRow[] {
  return h.rows.length > 0
    ? (h.rows as VariationRow[])
    : [
        {
          // Since the doc id is pre-minted at stage time, a row's key IS its doc id
          // on both sides of the save.
          key: 'c1',
          id: 'c1',
          nome: 'Camiseta P',
          sku: 'CAMP',
          variacoesUid: [varianteFakePath('gT', 'P')],
          precos: null,
          deleteMark: false,
        },
      ];
}

function renderManager() {
  const flushRef: { current: KitVariacoesFlush | null } = { current: null };
  function Host() {
    const form = useForm({
      defaultValues: {
        ehKit: true,
        componentesKit: {
          wrong: { quantidade: 1, limitarEstoque: true, timestamp: null },
        } as ComponentesKit | null,
      },
    });
    return (
      <FormProvider {...form}>
        <output data-testid="parent-recipe">
          {Object.keys(form.watch('componentesKit') ?? {}).join(',')}
        </output>
        <button
          type="button"
          onClick={() =>
            form.setValue('componentesKit', {
              replacement: { quantidade: 2, limitarEstoque: true, timestamp: null },
            })
          }
        >
          Use replacement
        </button>
        <KitVariacoesManager
          produtoId="p1"
          db={db}
          grupos={[]}
          rows={rows()}
          flushRef={flushRef}
          resetRevisionRef={h.resetRevisionRef}
          onDirtyChange={relatar}
        />
      </FormProvider>
    );
  }
  const utils = render(
    <MantineTestProvider>
      <Host />
    </MantineTestProvider>,
  );
  const rerender = () =>
    utils.rerender(
      <MantineTestProvider>
        <Host />
      </MantineTestProvider>,
    );
  return { flushRef, rerender };
}

beforeEach(() => {
  h.saves.length = 0;
  h.edits.length = 0;
  h.generation = undefined;
  h.resetRevisionRef.current = 0;
  h.readParent.mockReset();
  h.toasts.length = 0;
  h.children = [{ id: 'c1', data: { componentesKit: null } }];
  h.rows.length = 0;
  h.relatos.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('KitVariacoesManager', () => {
  it('confirms a non-kit on a pristine save, discards its draft, and skips reads on later saves', async () => {
    const { flushRef } = renderManager();
    fireEvent.click(screen.getByTestId('stage-kit'));

    await act(async () => {
      await flushRef.current!('p1', {}, 'confirm-non-kit');
    });
    expect(h.readParent).toHaveBeenCalledExactlyOnceWith({ id: 'p1' });
    expect(h.saves).toEqual([]);
    expect(ultimoRelato()).toBe(false);

    await act(async () => {
      await flushRef.current!('p1', {}, 'confirm-non-kit');
    });
    expect(h.readParent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['is a kit', { ehKit: true }],
    ['no longer exists', undefined],
  ])('keeps a pristine save’s recipe draft when the stored parent %s', async (_label, parent) => {
    h.readParent.mockResolvedValueOnce({ data: () => parent });
    const { flushRef } = renderManager();
    fireEvent.click(screen.getByTestId('stage-kit'));

    await expect(flushRef.current!('p1', {}, 'confirm-non-kit')).rejects.toBeInstanceOf(
      AfterSaveBlockedError,
    );
    expect(h.saves).toEqual([]);
    expect(ultimoRelato()).toBe(true);
    expect(screen.getByTestId('stage-kit').getAttribute('data-recipe')).toBe('comp-1');
  });

  it('does not rewrite a child kit map on a later save once it has been flushed', async () => {
    const { flushRef } = renderManager();

    fireEvent.click(screen.getByTestId('stage-kit'));

    await act(async () => {
      await flushRef.current!('p1', {});
    });
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]).toEqual([{ id: 'c1', componentesKit: { 'comp-1': { quantidade: 1 } } }]);

    // Nothing was staged since. A second produto save must not re-issue the
    // write: `componentesKit` is persisted as a FULL overwrite, so replaying a
    // session-stale map would clobber whatever another writer put there.
    await act(async () => {
      await flushRef.current!('p1', {});
    });
    expect(h.saves).toHaveLength(1);
  });

  it('writes an absorbed row where the pairing says, not where its key points', async () => {
    // The #117 id reuse wrote row `c1`'s data onto `reused-1`. Only the pairing
    // records that; the row still names `c1`.
    h.children = [{ id: 'reused-1', data: { componentesKit: null } }];
    const { flushRef } = renderManager();
    fireEvent.click(screen.getByTestId('stage-kit'));

    await act(async () => {
      await flushRef.current!('p1', { c1: 'reused-1' });
    });

    expect(h.saves[0]).toEqual([
      { id: 'reused-1', componentesKit: { 'comp-1': { quantidade: 1 } } },
    ]);
    expect(h.toasts).toEqual([]);

    // And it must be RELEASED by its source key `c1`, not by the id it was
    // written to. Those differ exactly when the pairing redirects a row, so
    // releasing by id would strand the entry and re-clobber `reused-1` on every
    // later produto save.
    await act(async () => {
      await flushRef.current!('p1', { c1: 'reused-1' });
    });
    expect(h.saves).toHaveLength(1);
  });

  it('does not let a delete-marked variation kit outlive the id that gets reused (#1390)', async () => {
    // The operator stages components for variation X while it is still live,
    // THEN delete-marks it and adds `tmp1` with the same SKU — the #117 flow.
    // Save 1 absorbs `tmp1` onto X and writes its map there. X's own entry is a
    // deliberate drop, so it is not written — but if it is not RELEASED either,
    // save 2 resolves it by `row.id` and overwrites the map the operator just
    // generated, behind a green toast.
    h.rows = [
      {
        key: 'X',
        id: 'X',
        nome: 'Antiga',
        sku: 'ANTIGA',
        variacoesUid: [],
        precos: null,
        deleteMark: false,
      },
    ];
    h.children = [{ id: 'X', data: { componentesKit: null } }];
    const { flushRef, rerender } = renderManager();
    fireEvent.click(screen.getByTestId('stage-kit')); // staged['X']

    // Now X is delete-marked and the replacement row appears.
    h.rows = [
      {
        key: 'X',
        id: 'X',
        nome: 'Antiga',
        sku: 'ANTIGA',
        variacoesUid: [],
        precos: null,
        deleteMark: true,
      },
      {
        key: 'tmp1',
        id: null,
        nome: 'Nova',
        sku: 'ANTIGA',
        variacoesUid: [],
        precos: null,
        deleteMark: false,
      },
    ];
    await act(async () => rerender());
    fireEvent.click(screen.getByTestId('stage-kit')); // staged['tmp1']

    await act(async () => {
      await flushRef.current!('p1', { tmp1: 'X' });
    });
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]!.map((w) => w.id)).toEqual(['X']);

    // Save 2: X lives again, carrying the NEW variation. Nothing may be rewritten.
    h.rows = [
      {
        key: 'X',
        id: 'X',
        nome: 'Nova',
        sku: 'ANTIGA',
        variacoesUid: [],
        precos: null,
        deleteMark: false,
      },
    ];
    await act(async () => rerender());
    await act(async () => {
      await flushRef.current!('p1', {});
    });
    expect(h.saves).toHaveLength(1);
  });

  it('tells the operator and keeps the entry staged when nothing resolves', async () => {
    // The variation's document is not among the children and no pairing covers
    // it: the map is NOT written, so the save must not look like it was.
    h.children = [];
    const { flushRef } = renderManager();
    fireEvent.click(screen.getByTestId('stage-kit'));

    await act(async () => {
      await flushRef.current!('p1', {});
    });
    expect(h.saves).toEqual([]);
    expect(h.toasts.join(' ')).toContain('Não foi possível salvar os componentes de: CAMP');

    // Still staged — the operator can retry once the variation is there.
    h.children = [{ id: 'c1', data: { componentesKit: null } }];
    await act(async () => {
      await flushRef.current!('p1', {});
    });
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]).toEqual([{ id: 'c1', componentesKit: { 'comp-1': { quantidade: 1 } } }]);
  });
});

// #1911 P11 review, KNOWN #9 round 3: the staged maps live HERE, outside the
// produto form, and a Shopee draft's «Publicar» derives a kit model's stock
// from the STORED child composition — so the page must be told while one is
// pending (its «Publicar» gate and its leave-guard read this report).
describe('KitVariacoesManager — reports its staged compositions to the page (KNOWN #9 round 3)', () => {
  it('`false` on mount, `true` once a composition is staged, `false` again once the flush WROTE it', async () => {
    const { flushRef } = renderManager();
    expect(h.relatos).toEqual([false]);

    fireEvent.click(screen.getByTestId('stage-kit'));
    expect(ultimoRelato()).toBe(true);

    await act(async () => {
      await flushRef.current!('p1', {});
    });
    expect(h.saves).toHaveLength(1);
    expect(ultimoRelato()).toBe(false);

    // A new edit after the save is pending again.
    fireEvent.click(screen.getByTestId('stage-kit'));
    expect(ultimoRelato()).toBe(true);
  });

  it('NEAR-MISS: an UNRESOLVED entry stays staged, so the report stays `true` — until the retry writes it', async () => {
    h.children = [];
    const { flushRef } = renderManager();
    fireEvent.click(screen.getByTestId('stage-kit'));
    expect(ultimoRelato()).toBe(true);

    await act(async () => {
      await flushRef.current!('p1', {});
    });
    expect(h.saves).toEqual([]);
    // The save "succeeded" but wrote nothing: still pending, never reported clean.
    expect(h.relatos).toEqual([false, true]);

    h.children = [{ id: 'c1', data: { componentesKit: null } }];
    await act(async () => {
      await flushRef.current!('p1', {});
    });
    expect(h.saves).toHaveLength(1);
    expect(ultimoRelato()).toBe(false);
  });

  it('a DROPPED entry (its variation delete-marked) is released with nothing written, and the report turns `false`', async () => {
    const vivo: VariationRow = {
      key: 'X',
      id: 'X',
      nome: 'Antiga',
      sku: 'ANTIGA',
      variacoesUid: [],
      precos: null,
      deleteMark: false,
    };
    h.rows = [vivo];
    h.children = [{ id: 'X', data: { componentesKit: null } }];
    const { flushRef, rerender } = renderManager();
    fireEvent.click(screen.getByTestId('stage-kit'));
    expect(ultimoRelato()).toBe(true);

    // Marked for deletion: the grid hides it, but its staged map is still there
    // (and still reported) until the flush releases it.
    h.rows = [{ ...vivo, deleteMark: true }];
    await act(async () => rerender());
    expect(ultimoRelato()).toBe(true);

    await act(async () => {
      await flushRef.current!('p1', {});
    });
    expect(h.saves).toEqual([]);
    expect(ultimoRelato()).toBe(false);
  });

  it('preserves the draft while the switch is off and discards it when the save confirms cleanup', async () => {
    const flushRef: { current: KitVariacoesFlush | null } = { current: null };
    function HostComInterruptor() {
      const form = useForm({ defaultValues: { ehKit: true, componentesKit: {} } });
      return (
        <FormProvider {...form}>
          <button
            type="button"
            data-testid="toggle-kit"
            onClick={() => form.setValue('ehKit', !form.getValues('ehKit'))}
          >
            Toggle kit
          </button>
          <KitVariacoesManager
            produtoId="p1"
            db={db}
            grupos={[]}
            rows={rows()}
            flushRef={flushRef}
            resetRevisionRef={h.resetRevisionRef}
            onDirtyChange={relatar}
          />
        </FormProvider>
      );
    }
    render(
      <MantineTestProvider>
        <HostComInterruptor />
      </MantineTestProvider>,
    );
    fireEvent.click(screen.getByTestId('stage-kit'));
    expect(ultimoRelato()).toBe(true);

    const toggle = () => fireEvent.click(screen.getByTestId('toggle-kit'));
    toggle();
    expect(screen.queryByTestId('stage-kit')).toBeNull();
    expect(ultimoRelato()).toBe(true);
    toggle();
    expect(screen.getByTestId('stage-kit').getAttribute('data-recipe')).toBe('comp-1');
    toggle();

    await act(async () => {
      await flushRef.current!('p1', {}, 'discard');
    });
    expect(h.saves).toEqual([]);
    expect(ultimoRelato()).toBe(false);
  });
});

describe('Recomeçar cadastro do kit', () => {
  it('keeps the draft on cancel, then clears saved and generated recipes before rebuilding', async () => {
    const saved = { original: { quantidade: 1, limitarEstoque: true, timestamp: null } };
    h.children = [
      { id: 'c1', data: { componentesKit: saved } },
      { id: 'c2', data: { componentesKit: saved } },
    ];
    const { flushRef } = renderManager();
    const restart = () =>
      fireEvent.click(screen.getByRole('button', { name: 'Recomeçar cadastro do kit' }));
    const generate = async () => {
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Gerar Variações' })),
      );
    };
    const childRecipe = () => screen.getByTestId('stage-kit').getAttribute('data-recipe');
    const parentRecipe = () => screen.getByTestId('parent-recipe').textContent;

    await generate();
    expect(childRecipe()).toBe('original,wrong');
    restart();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(childRecipe()).toBe('original,wrong');
    expect(parentRecipe()).toBe('wrong');

    restart();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar componentes' }));
    expect(childRecipe()).toBe('');
    expect(parentRecipe()).toBe('');
    expect(h.saves).toEqual([]);
    expect(ultimoRelato()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Use replacement' }));
    await generate();
    expect(childRecipe()).toBe('replacement');
    await act(async () => {
      await flushRef.current!('p1', {});
    });
    expect(h.edits).toEqual([
      {
        mirrorSoleMember: true,
        recipes: [
          {
            id: 'c1',
            componentesKit: {
              replacement: { quantidade: 2, limitarEstoque: true, timestamp: null },
            },
            baseline: saved,
          },
          { id: 'c2', componentesKit: null, baseline: saved },
        ],
      },
    ]);
    expect(ultimoRelato()).toBe(false);
  });

  it('ignores a generation result that returns after a committed un-kit', async () => {
    let finish!: () => void;
    h.generation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { flushRef } = renderManager();
    fireEvent.click(screen.getByRole('button', { name: 'Gerar Variações' }));
    await act(async () => {
      await flushRef.current!('p1', {}, 'discard');
      finish();
      await h.generation;
    });
    expect(ultimoRelato()).toBe(false);
    expect(h.toasts).toEqual([]);
    await act(async () => {
      await flushRef.current!('p1', {});
    });
    expect(h.saves).toEqual([]);
  });
});
