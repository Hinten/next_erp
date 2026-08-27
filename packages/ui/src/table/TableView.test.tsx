import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MantineTestProvider } from '../testing/mantine';
import { z } from 'zod';
import type { CollectionHandle } from '@delfrance/data';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';

// Stub the snapshot hooks + the query helpers so the table renders a static
// dataset without hitting Firestore's internals. We control the response on a
// per-test basis via the hoisted `snapState`. `pushSpy` captures router
// navigation; `searchParamsRef` lets a test seed the URL. The URL-sync effect
// writes via `window.history.replaceState`, so cases that assert on it spy on
// that directly rather than on the router.
const {
  snapState,
  pushSpy,
  searchParamsRef,
  buildPipelineSpy,
  pipelineSupportedRef,
  whereOpSpy,
  whereArrayContainsSpy,
} = vi.hoisted(() => ({
  snapState: {
    current: {
      data: [
        { id: '1', path: 'x/1', data: { nome: 'Alice', tipo: '0' } },
        { id: '2', path: 'x/2', data: { nome: 'Bob', tipo: '1' } },
      ],
      loading: false,
      error: undefined,
    } as SnapshotState<SnapshotRow<{ nome?: string; tipo?: string }>[]>,
  },
  pushSpy: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
  buildPipelineSpy: vi.fn(() => ({ __pipeline: true })),
  // Flip to false in a test to exercise the classic-query fallback path.
  pipelineSupportedRef: { current: true },
  // Spied so the fallback tests can assert which constraint each
  // extraFilters op maps to. Return values only matter as identities.
  whereOpSpy: vi.fn(() => ({ __c: 'where' })),
  whereArrayContainsSpy: vi.fn(() => ({ __c: 'whereArrayContains' })),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushSpy,
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/clientes',
  useSearchParams: () => searchParamsRef.current,
}));

vi.mock('@delfrance/data/hooks', async () => {
  const actual =
    await vi.importActual<typeof import('@delfrance/data/hooks')>('@delfrance/data/hooks');
  return { ...actual, useSnapshot: () => snapState.current };
});
vi.mock('@delfrance/data/hooks/usePipelineSnapshot', () => ({
  usePipelineSnapshot: () => snapState.current,
}));
vi.mock('@delfrance/data/pipeline-queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@delfrance/data/pipeline-queries')>();
  return {
    ...actual,
    isPipelineSupported: (_db: unknown) => pipelineSupportedRef.current,
    buildPipeline: buildPipelineSpy,
  };
});
vi.mock('@delfrance/data', async () => {
  const actual = await vi.importActual<typeof import('@delfrance/data')>('@delfrance/data');
  return {
    ...actual,
    // Bypass real query construction — the TableView calls these but the
    // returned object only matters as a stable identity for useSnapshot deps.
    buildQuery: () => ({ __fakeQuery: true }),
    orderByField: () => ({ __c: 'orderBy' }),
    limit: () => ({ __c: 'limit' }),
    whereOp: whereOpSpy,
    whereArrayContains: whereArrayContainsSpy,
  };
});

import { MAX_RESTORED_PAGES, TableView } from './TableView';
import { listViewMemoryKey, readListViewMemory, writeListViewMemory } from './listViewMemory';

/** The slot this harness's table uses: pathname '/clientes' + collection 'tests'. */
const MEMORY_KEY = listViewMemoryKey('/clientes', 'tests');

const testSchema = z.object({
  nome: z.string(),
  tipo: z.enum(['0', '1']).describe('Tipo'),
  observacoes: z.string().nullable().optional(),
});

function fakeCollection(): CollectionHandle<typeof testSchema> {
  return {
    resolvePath: () => 'tests',
    ref: () => ({}) as never,
    docRef: () => ({}) as never,
    converter: {} as never,
    merge: () => Promise.resolve(),
  };
}

function wrap(node: React.ReactNode) {
  // `MantineTestProvider` renders the ColumnPicker popover inline instead of
  // through a portal, so it is queryable in jsdom.
  return render(<MantineTestProvider>{node}</MantineTestProvider>);
}

describe('TableView', () => {
  afterEach(() => {
    // useLocalStorage persists visible columns; clear so cases don't leak.
    localStorage.clear();
    // The sticky list memory persists filters/sort per screen in sessionStorage
    // and is restored whenever the URL is bare — so without this, one case's
    // filter silently reopens in the next, and which cases break depends on the
    // order they ran in.
    sessionStorage.clear();
    // The URL-sync effect mutates the URL via history.replaceState; reset it
    // so one case's query string doesn't bleed into the next.
    window.history.replaceState(null, '', '/clientes');
    pipelineSupportedRef.current = true;
  });

  it('renders one header per non-unknown field by default', () => {
    wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Nome', 'Tipo', 'Observacoes']));
  });

  it('limits columns to defaultColumns when provided', () => {
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        defaultColumns={['nome']}
      />,
    );
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toContain('Nome');
    expect(headers).not.toContain('Tipo');
  });

  it('hydrates visible columns from localStorage', () => {
    // fakeCollection().resolvePath() → 'tests'.
    localStorage.setItem('delfrance:tableview:columns:tests', JSON.stringify(['nome']));
    wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toContain('Nome');
    expect(headers).not.toContain('Tipo');
  });

  it('persists a column toggle to localStorage', () => {
    wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
    // Open the ColumnPicker popover and uncheck "Tipo".
    fireEvent.click(screen.getByRole('button', { name: 'Configurar colunas' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tipo' }));
    const stored = JSON.parse(
      localStorage.getItem('delfrance:tableview:columns:tests') ?? '[]',
    ) as string[];
    expect(stored).not.toContain('tipo');
    expect(stored).toContain('nome');
  });

  it('omits a hidden field from the picker so every checkbox on offer renders a column', () => {
    // Mirrors /produtos: `nome` is hidden because a virtual column REPLACES it,
    // and `tipo` is relabelled. The picker used to consult neither — it listed
    // TWO "Nome" checkboxes, the schema one being a control that ticks,
    // persists and renders nothing, because `visibleColumns` drops it. On
    // /produtos that dead entry was the only match for a "integra" search,
    // while the working column is labelled "Canais de venda".
    localStorage.setItem('delfrance:tableview:columns:tests', JSON.stringify(['tipo']));
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        fields={{ nome: { hidden: true }, tipo: { label: 'Classificação' } }}
        virtualColumns={[
          {
            key: 'nomeLink',
            label: 'Nome',
            dependsOn: ['nome'],
            renderCell: (row) => <span>{row.data.nome}</span>,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Configurar colunas' }));

    // Exactly one "Nome" — the virtual column. The hidden schema field is gone.
    expect(screen.getAllByRole('checkbox', { name: 'Nome' })).toHaveLength(1);
    // And the picker names a column exactly as its header does.
    expect(screen.getByRole('checkbox', { name: 'Classificação' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Tipo' })).toBeNull();

    // The checkbox that IS on offer produces a column.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nome' }));
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Classificação',
      'Nome',
    ]);
  });

  it('reorders columns via the picker and persists the new order', () => {
    wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
    // Default order follows the schema: Nome, Tipo, Observacoes.
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Nome',
      'Tipo',
      'Observacoes',
    ]);

    // Open the ColumnPicker, switch to reorder mode and move "Nome" down.
    fireEvent.click(screen.getByRole('button', { name: 'Configurar colunas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reordenar colunas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mover Nome para baixo' }));

    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Tipo',
      'Nome',
      'Observacoes',
    ]);
    const stored = JSON.parse(
      localStorage.getItem('delfrance:tableview:columns:tests') ?? '[]',
    ) as string[];
    expect(stored).toEqual(['tipo', 'nome', 'observacoes']);
  });

  it('clicking a row calls router.push with the rowHref', () => {
    pushSpy.mockClear();
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        rowHref={(id) => `/tests/${id}`}
      />,
    );
    // Click the cell containing "Alice" — the click handler is on the
    // surrounding <tr>, which receives the event via bubbling.
    fireEvent.click(screen.getByText('Alice'));
    expect(pushSpy).toHaveBeenCalledWith('/tests/1');
  });

  it('shows an empty state when no rows', () => {
    snapState.current = { data: [], loading: false, error: undefined };
    wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
    expect(screen.getByText(/Nenhum resultado/)).toBeTruthy();
    // Reset for sibling tests.
    snapState.current = {
      data: [
        { id: '1', path: 'x/1', data: { nome: 'Alice', tipo: '0' } },
        { id: '2', path: 'x/2', data: { nome: 'Bob', tipo: '1' } },
      ],
      loading: false,
      error: undefined,
    };
  });

  it('hydrates the pipeline filters from the URL query string', () => {
    searchParamsRef.current = new URLSearchParams('nome=contains:ana');
    buildPipelineSpy.mockClear();
    wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
    expect(buildPipelineSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filters: [{ field: 'nome', op: 'contains', value: 'ana' }],
      }),
    );
    searchParamsRef.current = new URLSearchParams();
  });

  it('hydrates the initial sort from ?sort= in the URL', () => {
    searchParamsRef.current = new URLSearchParams('sort=nome:desc');
    buildPipelineSpy.mockClear();
    wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
    expect(buildPipelineSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderBy: [{ field: 'nome', direction: 'desc' }],
      }),
    );
    searchParamsRef.current = new URLSearchParams();
  });

  it('writes the sort to the URL via history.replaceState when a header is clicked', () => {
    searchParamsRef.current = new URLSearchParams();
    // The view mirrors filters/sort into the URL with window.history.replaceState
    // (not router.replace) — see the URL-sync effect in TableView for why.
    const replaceState = vi.spyOn(window.history, 'replaceState');
    wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
    fireEvent.click(screen.getByText('Nome'));
    expect(replaceState).toHaveBeenCalledWith(null, '', '/clientes?sort=nome%3Aasc');
    replaceState.mockRestore();
  });

  it('actionsPanel renders the right-side panel and replaces the top ActionBar', () => {
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        selectable
        actionsPanel
        newHref="/tests/novo"
        actions={[{ id: 'del', label: 'Excluir', requiresSelection: true, run: vi.fn() }]}
      />,
    );
    const panel = screen.getByRole('complementary', { name: 'Ações' });
    expect(within(panel).getByRole('button', { name: 'Excluir' })).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Novo' })).toBeTruthy();
    // The top ActionBar is replaced — the action exists once, in the panel.
    expect(screen.getAllByRole('button', { name: 'Excluir' })).toHaveLength(1);
  });

  it('persists the panel collapse state per collection in localStorage', () => {
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        actionsPanel
        actions={[{ id: 'del', label: 'Excluir', run: vi.fn() }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Recolher ações' }));
    expect(localStorage.getItem('delfrance:tableview:actionspanel:tests')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Excluir' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Expandir ações' })).toBeTruthy();
  });

  it('renderActionsPanelExtra renders inside the panel and follows the collapse state', () => {
    const extra = vi.fn(({ collapsed }: { collapsed: boolean }) => (
      <span>{collapsed ? 'compacto' : 'expandido'}</span>
    ));
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        actionsPanel={{ width: 300 }}
        renderActionsPanelExtra={extra}
        actions={[{ id: 'del', label: 'Excluir', run: vi.fn() }]}
      />,
    );
    const panel = screen.getByRole('complementary', { name: 'Ações' });
    expect(within(panel).getByText('expandido')).toBeTruthy();
    // Mantine rewrites a numeric `w` to rem and scales it: 300 / 16 = 18.75rem.
    expect(getComputedStyle(panel).width).toContain('18.75rem');

    fireEvent.click(screen.getByRole('button', { name: 'Recolher ações' }));
    expect(screen.getByText('compacto')).toBeTruthy();
  });

  it('onSelectionChange reports the checked rows, and fires only when the id set changes', () => {
    const onSelectionChange = vi.fn();
    const { rerender } = wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        selectable
        onSelectionChange={onSelectionChange}
      />,
    );
    // One mount call with the empty selection.
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar 1' }));
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
    expect(onSelectionChange.mock.lastCall?.[0]).toMatchObject([{ id: '1' }]);

    // A re-render with an unchanged selection must NOT re-fire: consumers set
    // state from this callback, and `selectedRows` is re-derived every tick.
    rerender(
      <MantineTestProvider>
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          selectable
          onSelectionChange={onSelectionChange}
        />
      </MantineTestProvider>,
    );
    expect(onSelectionChange).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar 1' }));
    expect(onSelectionChange).toHaveBeenCalledTimes(3);
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
  });

  it('drops selected ids that leave the row set (ghost selection)', () => {
    const { rerender } = wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        selectable
        actions={[{ id: 'del', label: 'Excluir', requiresSelection: true, run: vi.fn() }]}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar 1' }));
    const button = screen.getByRole('button', { name: 'Excluir' }) as HTMLButtonElement;
    expect(button.hasAttribute('disabled')).toBe(false);

    // Row '1' disappears from the snapshot (filter change / deleted elsewhere).
    snapState.current = {
      data: [{ id: '2', path: 'x/2', data: { nome: 'Bob', tipo: '1' } }],
      loading: false,
      error: undefined,
    };
    rerender(
      <MantineTestProvider>
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          selectable
          actions={[{ id: 'del', label: 'Excluir', requiresSelection: true, run: vi.fn() }]}
        />
      </MantineTestProvider>,
    );
    // The stale id was reconciled away: bulk actions disable again and the
    // header checkbox is neither checked nor indeterminate.
    expect(button.hasAttribute('disabled')).toBe(true);
    const headerCheckbox = screen.getByRole('checkbox', {
      name: 'Selecionar todas as linhas',
    }) as HTMLInputElement;
    expect(headerCheckbox.checked).toBe(false);
    expect(headerCheckbox.indeterminate).toBe(false);
    // Reset for sibling tests.
    snapState.current = {
      data: [
        { id: '1', path: 'x/1', data: { nome: 'Alice', tipo: '0' } },
        { id: '2', path: 'x/2', data: { nome: 'Bob', tipo: '1' } },
      ],
      loading: false,
      error: undefined,
    };
  });

  it('selectable adds a checkbox column and enables bulk actions on selection', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const { container } = wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        selectable
        actions={[{ id: 'del', label: 'Excluir', requiresSelection: true, run }]}
      />,
    );
    const button = screen.getByRole('button', { name: 'Excluir' }) as HTMLButtonElement;
    expect(button.hasAttribute('disabled')).toBe(true);
    const rowCheckbox = within(container).getByRole('checkbox', { name: 'Selecionar 1' });
    fireEvent.click(rowCheckbox);
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(run).toHaveBeenCalled();
  });

  describe('extraFilters', () => {
    it('appends extraFilters into the pipeline filter spec', () => {
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          extraFilters={[{ field: 'targetsChnfe', op: 'array-contains', value: 'k'.repeat(44) }]}
        />,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          filters: [{ field: 'targetsChnfe', op: 'array-contains', value: 'k'.repeat(44) }],
        }),
      );
    });

    it('AND-combines extraFilters with the user column filters (extra first)', () => {
      searchParamsRef.current = new URLSearchParams('nome=contains:ana');
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          extraFilters={[{ field: 'targetsChnfe', op: 'array-contains-any', value: ['a', 'b'] }]}
        />,
      );
      // One filters array → buildPipeline AND-combines them in one where(and()).
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          filters: [
            { field: 'targetsChnfe', op: 'array-contains-any', value: ['a', 'b'] },
            { field: 'nome', op: 'contains', value: 'ana' },
          ],
        }),
      );
      searchParamsRef.current = new URLSearchParams();
    });

    it('an empty-array value short-circuits: no query, empty state rendered', () => {
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          extraFilters={[{ field: 'targetsChnfe', op: 'array-contains-any', value: [] }]}
        />,
      );
      expect(buildPipelineSpy).not.toHaveBeenCalled();
      // The snapshot stub still carries 2 rows — they must not leak through.
      expect(screen.getByText('Nenhum resultado.')).toBeTruthy();
      expect(screen.queryByText('Alice')).toBeNull();
    });

    it('classic fallback maps array ops to whereArrayContains / whereOp', () => {
      pipelineSupportedRef.current = false;
      whereArrayContainsSpy.mockClear();
      whereOpSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          extraFilters={[
            { field: 'targetsChnfe', op: 'array-contains', value: 'X' },
            { field: 'targetsChnfe', op: 'array-contains-any', value: ['a', 'b'] },
          ]}
        />,
      );
      expect(whereArrayContainsSpy).toHaveBeenCalledWith('targetsChnfe', 'X');
      expect(whereOpSpy).toHaveBeenCalledWith('targetsChnfe', 'array-contains-any', ['a', 'b']);
    });

    it('an empty array on a non-array-contains-any op does NOT short-circuit', () => {
      // The "no rows" shortcut is scoped to array-contains-any candidate
      // lists; an empty array on eq must reach buildPipeline so its runtime
      // guard surfaces the programmer error instead of an empty table.
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          extraFilters={[{ field: 'nome', op: 'eq', value: [] }]}
        />,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          filters: expect.arrayContaining([{ field: 'nome', op: 'eq', value: [] }]),
        }),
      );
      expect(screen.queryByText('Nenhum resultado.')).toBeNull();
    });

    it('classic fallback throws on an array value for a scalar op', () => {
      pipelineSupportedRef.current = false;
      // React re-logs render-phase throws via console.error — silence it so
      // the expected failure doesn't pollute the test output.
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(() =>
          wrap(
            <TableView
              schema={testSchema}
              collection={fakeCollection()}
              db={{} as never}
              extraFilters={[{ field: 'nome', op: 'eq', value: ['a'] }]}
            />,
          ),
        ).toThrow(/received an array value/);
      } finally {
        consoleError.mockRestore();
      }
    });
  });

  describe('meta.defaultQuery', () => {
    const metaBase = {
      collectionPath: 'tests',
      permissions: { read: 0n, write: 0n, delete: 0n },
    } as const;

    it('seeds the pipeline orderBy and limit from meta.defaultQuery', () => {
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={{
            ...metaBase,
            defaultQuery: { orderBy: [{ field: 'nome', direction: 'asc' }], limit: 25 },
          }}
        />,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          orderBy: [{ field: 'nome', direction: 'asc' }],
          limit: 25,
        }),
      );
    });

    it('first header click flips the meta-default ascending sort to descending', () => {
      // Regression: with the default sort coming from meta (not the legacy
      // orderBy prop), the column shows ascending but `sort` state is still
      // undefined. toggleSort must flip relative to the *displayed* sort, so
      // one click goes to desc — not re-set asc (a visual no-op).
      const replaceState = vi.spyOn(window.history, 'replaceState');
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={{
            ...metaBase,
            defaultQuery: { orderBy: [{ field: 'nome', direction: 'asc' }], limit: 50 },
          }}
        />,
      );
      fireEvent.click(screen.getByText('Nome'));
      expect(replaceState).toHaveBeenCalledWith(null, '', '/clientes?sort=nome%3Adesc');
      replaceState.mockRestore();
    });

    it('lets the pageSize prop override meta.defaultQuery.limit', () => {
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          pageSize={10}
          meta={{
            ...metaBase,
            defaultQuery: { orderBy: [{ field: 'nome', direction: 'asc' }], limit: 25 },
          }}
        />,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ limit: 10 }),
      );
    });

    it('prepends literal base filters and binds param filters from queryParams', () => {
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          queryParams={{ tipo: '1' }}
          meta={{
            ...metaBase,
            defaultQuery: {
              where: [{ field: 'tipo', param: true }],
              orderBy: [{ field: 'nome', direction: 'asc' }],
              limit: 50,
            },
          }}
        />,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          filters: [{ field: 'tipo', op: 'eq', value: '1' }],
        }),
      );
    });

    it('keeps projection enabled when every visible virtual column declares dependsOn', () => {
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          virtualColumns={[
            { key: 'v1', label: 'V1', dependsOn: ['extra'], renderCell: () => null },
          ]}
        />,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          select: expect.arrayContaining(['nome', 'tipo', 'observacoes', 'extra']),
        }),
      );
    });

    it('disables projection when a visible virtual column omits dependsOn', () => {
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          virtualColumns={[{ key: 'v1', label: 'V1', renderCell: () => null }]}
        />,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ select: undefined }),
      );
    });

    it('"Carregar mais" grows the query limit by the page size', () => {
      // 2 rows in the snapshot === pageSize 2 → the page looks full → button.
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          pageSize={2}
        />,
      );
      const button = screen.getByRole('button', { name: 'Carregar mais' });
      buildPipelineSpy.mockClear();
      fireEvent.click(button);
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ limit: 4 }),
      );
    });

    it('applies column filters client-side on the classic-query fallback path', () => {
      // No Pipelines support → fromQuery (also stubbed to snapState) feeds the
      // rows; the server didn't filter, so TableView must narrow them itself.
      pipelineSupportedRef.current = false;
      searchParamsRef.current = new URLSearchParams('nome=contains:alice');
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      expect(screen.getByText('Alice')).toBeTruthy();
      expect(screen.queryByText('Bob')).toBeNull();
      searchParamsRef.current = new URLSearchParams();
    });

    it('throws when a declared param has no queryParams binding', () => {
      // The component throws during render (baseFilters memo) — an unbound
      // filter would silently widen the list to the whole collection.
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() =>
        wrap(
          <TableView
            schema={testSchema}
            collection={fakeCollection()}
            db={{} as never}
            meta={{
              ...metaBase,
              defaultQuery: {
                where: [{ field: 'tipo', param: true }],
                orderBy: [{ field: 'nome', direction: 'asc' }],
                limit: 50,
              },
            }}
          />,
        ),
      ).toThrow(/param "tipo"/);
      spy.mockRestore();
    });

    it('takes the default column set from meta.defaultQuery.columns', () => {
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={{
            ...metaBase,
            defaultQuery: {
              orderBy: [{ field: 'nome', direction: 'asc' }],
              limit: 50,
              columns: ['tipo'],
            },
          }}
        />,
      );
      const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
      expect(headers).toContain('Tipo');
      expect(headers).not.toContain('Nome');
    });

    it('narrows the pipeline projection to meta.defaultQuery.columns', () => {
      // The column set IS the `select()` projection — Enterprise bills data
      // scanned, which is why the declaration lives on defaultQuery.
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={{
            ...metaBase,
            defaultQuery: {
              orderBy: [{ field: 'nome', direction: 'asc' }],
              limit: 50,
              columns: ['nome'],
            },
          }}
        />,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ select: ['nome'] }),
      );
    });

    it('lets the defaultColumns prop override meta.defaultQuery.columns', () => {
      // One meta can back several screens with different column sets — e.g.
      // integracaoMeta serves /canais/balcao, /mercado-livre and /whatsapp.
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          defaultColumns={['tipo']}
          meta={{
            ...metaBase,
            defaultQuery: {
              orderBy: [{ field: 'nome', direction: 'asc' }],
              limit: 50,
              columns: ['nome'],
            },
          }}
        />,
      );
      const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
      expect(headers).toContain('Tipo');
      expect(headers).not.toContain('Nome');
    });
  });

  describe('forcedOrderBy', () => {
    const metaBase = {
      collectionPath: 'tests',
      permissions: { read: 0n, write: 0n, delete: 0n },
    } as const;
    const recencyMeta = {
      ...metaBase,
      defaultQuery: { orderBy: [{ field: 'observacoes', direction: 'desc' as const }], limit: 50 },
    };

    it('overrides meta.defaultQuery.orderBy', () => {
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={recencyMeta}
          forcedOrderBy={{ field: 'nome', direction: 'asc' }}
        />,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orderBy: [{ field: 'nome', direction: 'asc' }] }),
      );
    });

    it('outranks a user header sort', () => {
      // A header sort would break the same inequality/orderBy coupling the
      // forced sort exists to satisfy, so it must NOT win.
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={recencyMeta}
          forcedOrderBy={{ field: 'nome', direction: 'asc' }}
        />,
      );
      // The forced sort is what reaches Firestore (not `recencyMeta`'s)...
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orderBy: [{ field: 'nome', direction: 'asc' }] }),
      );
      fireEvent.click(screen.getByText('Tipo'));
      // ...and clicking a header never issues the sort the user asked for.
      // (`toggleSort` drops the click outright — see the next case for why.)
      expect(buildPipelineSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orderBy: [{ field: 'tipo', direction: 'asc' }] }),
      );
    });

    it('makes header clicks inert instead of queueing a delayed re-sort', () => {
      // Recording the click would change nothing NOW and then silently re-sort
      // the list the moment the forced sort clears — a jump with no visible
      // cause. Assert the click is dropped, not just outranked: clearing the
      // forced sort must return to the DECLARED default, not to 'tipo'.
      const { rerender } = wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={recencyMeta}
          forcedOrderBy={{ field: 'nome', direction: 'asc' }}
        />,
      );
      fireEvent.click(screen.getByText('Tipo'));
      buildPipelineSpy.mockClear();
      rerender(
        <MantineTestProvider>
          <TableView
            schema={testSchema}
            collection={fakeCollection()}
            db={{} as never}
            meta={recencyMeta}
          />
        </MantineTestProvider>,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orderBy: [{ field: 'observacoes', direction: 'desc' }] }),
      );
      expect(buildPipelineSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orderBy: [{ field: 'tipo', direction: 'asc' }] }),
      );
    });

    it('falls back to the declared default once cleared', () => {
      const { rerender } = wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={recencyMeta}
          forcedOrderBy={{ field: 'nome', direction: 'asc' }}
        />,
      );
      buildPipelineSpy.mockClear();
      rerender(
        <MantineTestProvider>
          <TableView
            schema={testSchema}
            collection={fakeCollection()}
            db={{} as never}
            meta={recencyMeta}
          />
        </MantineTestProvider>,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orderBy: [{ field: 'observacoes', direction: 'desc' }] }),
      );
    });
  });

  describe('sticky list memory', () => {
    it('reopens the last filter when the URL carries none', () => {
      // The reported bug: filter /produtos, open a record, click Cancelar. The
      // detail page navigates to the BARE list path, so the query string that
      // held the filter is gone by the time the list remounts.
      writeListViewMemory(MEMORY_KEY, { qs: 'nome=contains%3Aana', pages: 1, scroll: 0 });
      buildPipelineSpy.mockClear();
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ filters: [{ field: 'nome', op: 'contains', value: 'ana' }] }),
      );
    });

    it('issues the restored filter as the FIRST query, not a second one', () => {
      // Restoring from an effect would spend one full unfiltered page of
      // scanned data before correcting itself — and this database bills data
      // scanned. Exactly one query, already narrowed.
      writeListViewMemory(MEMORY_KEY, { qs: 'nome=contains%3Aana', pages: 1, scroll: 0 });
      buildPipelineSpy.mockClear();
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      // `buildPipelineSpy` is declared with no parameters, so `mock.calls` is
      // typed `[][]` and `call[1]` is a TS2493. Go through `unknown`.
      const filterSets = buildPipelineSpy.mock.calls.map(
        (call) => (call as unknown as [unknown, { filters?: unknown[] }])[1].filters,
      );
      expect(filterSets).toEqual([[{ field: 'nome', op: 'contains', value: 'ana' }]]);
    });

    it('lets the URL win over the memory, so a shared link is never overridden', () => {
      writeListViewMemory(MEMORY_KEY, { qs: 'nome=contains%3Aana', pages: 1, scroll: 0 });
      searchParamsRef.current = new URLSearchParams('nome=contains:bob');
      buildPipelineSpy.mockClear();
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ filters: [{ field: 'nome', op: 'contains', value: 'bob' }] }),
      );
      searchParamsRef.current = new URLSearchParams();
    });

    it('records the filter as soon as it is applied', () => {
      searchParamsRef.current = new URLSearchParams('nome=contains:ana');
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      expect(readListViewMemory(MEMORY_KEY)?.qs).toBe('nome=contains%3Aana');
      searchParamsRef.current = new URLSearchParams();
    });

    it('remembers a cleared list as cleared, so clearing sticks', () => {
      // An empty query string is NOT "no memory": without storing it, clearing
      // every filter would be undone by the previous entry on the next visit.
      searchParamsRef.current = new URLSearchParams('nome=contains:ana');
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      searchParamsRef.current = new URLSearchParams();
      fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
      expect(readListViewMemory(MEMORY_KEY)?.qs).toBe('');
    });

    it('restores the "Carregar mais" window, capped', () => {
      writeListViewMemory(MEMORY_KEY, { qs: '', pages: 10, scroll: 0 });
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          pageSize={2}
        />,
      );
      // Capped rather than obeyed: re-reading an unbounded window on every
      // return is billed data scanned, and on /pedidos it is a listener count.
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ limit: 2 * MAX_RESTORED_PAGES }),
      );
    });

    it('does not collapse the restored window on mount', () => {
      // Every effect runs once on mount, including the one that resets the
      // window whenever the query shape changes. Unguarded, it undoes the
      // restore a beat after it lands and the page count never comes back.
      writeListViewMemory(MEMORY_KEY, { qs: '', pages: 2, scroll: 0 });
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          pageSize={2}
        />,
      );
      const limits = buildPipelineSpy.mock.calls.map(
        (call) => (call as unknown as [unknown, { limit: number }])[1].limit,
      );
      expect(limits).not.toContain(2);
      expect(limits.at(-1)).toBe(4);
    });

    it('still collapses the window when the filter changes afterwards', () => {
      writeListViewMemory(MEMORY_KEY, { qs: '', pages: 2, scroll: 0 });
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          pageSize={2}
        />,
      );
      buildPipelineSpy.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Filtrar Nome' }));
      fireEvent.change(screen.getByLabelText('Nome contém'), { target: { value: 'ana' } });
      fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
      expect(buildPipelineSpy).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ limit: 2 }),
      );
    });

    it('puts the scroll back once the rows are on screen', async () => {
      // Deferred to the rows because scrolling to an offset the document is not
      // yet tall enough for silently lands at the bottom instead.
      const scrollTo = vi.fn();
      vi.stubGlobal('scrollTo', scrollTo);
      writeListViewMemory(MEMORY_KEY, { qs: '', pages: 1, scroll: 840 });
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 840));
      vi.unstubAllGlobals();
    });

    it('waits for rows, so an empty first paint does not burn the restore', async () => {
      // The restore fires once. Spending it on a paint with no rows would
      // scroll a short document to an offset it cannot reach — and then never
      // try again when the rows actually arrive.
      const scrollTo = vi.fn();
      vi.stubGlobal('scrollTo', scrollTo);
      writeListViewMemory(MEMORY_KEY, { qs: '', pages: 1, scroll: 840 });
      const withRows = snapState.current;
      snapState.current = { data: [], loading: false, error: undefined };

      const { rerender } = wrap(
        <TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />,
      );
      // ⚠️ The wait is load-bearing. The restore goes through
      // `requestAnimationFrame`, so asserting "not called" immediately after
      // `wrap()` passes even when the guard is gone — nothing has had a chance
      // to fire yet. Give the frame time to land first.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(scrollTo).not.toHaveBeenCalled();

      snapState.current = withRows;
      rerender(
        <MantineTestProvider>
          <TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />
        </MantineTestProvider>,
      );
      await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 840));
      vi.unstubAllGlobals();
    });

    it('does not erase the remembered scroll offset on mount', async () => {
      // The URL sync persists on mount, before the caller has reported a scroll
      // and before the restore has landed. Seeded with a zero it would blank the
      // offset that was on its way back, so leaving again right away lost it.
      vi.stubGlobal('scrollTo', vi.fn());
      writeListViewMemory(MEMORY_KEY, { qs: '', pages: 1, scroll: 840 });
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      expect(readListViewMemory(MEMORY_KEY)?.scroll).toBe(840);
      vi.unstubAllGlobals();
    });

    it('keeps foreign query params instead of deleting them', () => {
      // The URL sync used to rebuild the query string from scratch, which wiped
      // ?copyFrom / ?copiarDe / ?userCliente — params the surrounding page was
      // still going to read.
      window.history.replaceState(null, '', '/clientes?copyFrom=abc');
      const replaceState = vi.spyOn(window.history, 'replaceState');
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      fireEvent.click(screen.getByText('Nome'));
      expect(replaceState).toHaveBeenLastCalledWith(
        null,
        '',
        '/clientes?copyFrom=abc&sort=nome%3Aasc',
      );
      replaceState.mockRestore();
    });

    it('does not put a foreign param into the memory', () => {
      window.history.replaceState(null, '', '/clientes?copyFrom=abc');
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      fireEvent.click(screen.getByText('Nome'));
      // `copyFrom` belongs to the navigation that carried it, not to this
      // screen's saved position — restoring it later would be nonsense.
      expect(readListViewMemory(MEMORY_KEY)?.qs).toBe('sort=nome%3Aasc');
    });
  });

  describe('active filter chips', () => {
    it('names what is hiding rows, using the displayed column label', () => {
      searchParamsRef.current = new URLSearchParams('nome=contains:ana');
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          fields={{ nome: { label: 'Nome do cliente' } }}
        />,
      );
      expect(screen.getByText('Nome do cliente contém "ana"')).toBeTruthy();
      searchParamsRef.current = new URLSearchParams();
    });

    it('renders nothing at all when the list is unfiltered', () => {
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      expect(screen.queryByRole('button', { name: 'Limpar filtros' })).toBeNull();
    });

    it('never renders a bare column label, which would break the e2e sort helper', () => {
      // `clickColumnSort` is getByText(label, { exact: true }) under Playwright
      // strict mode; a chip equal to a header label resolves to two nodes.
      searchParamsRef.current = new URLSearchParams('nome=contains:ana&tipo=eq:0');
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      expect(screen.getAllByText('Nome', { exact: true })).toHaveLength(1);
      expect(screen.getAllByText('Tipo', { exact: true })).toHaveLength(1);
      searchParamsRef.current = new URLSearchParams();
    });

    it('removes one filter and leaves the rest', () => {
      searchParamsRef.current = new URLSearchParams('nome=contains:ana&tipo=eq:0');
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      searchParamsRef.current = new URLSearchParams();
      buildPipelineSpy.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Remover filtro Nome contém "ana"' }));
      expect(buildPipelineSpy).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ filters: [{ field: 'tipo', op: 'eq', value: '0' }] }),
      );
    });

    it('clears every filter at once', () => {
      searchParamsRef.current = new URLSearchParams('nome=contains:ana&tipo=eq:0');
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      searchParamsRef.current = new URLSearchParams();
      buildPipelineSpy.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
      expect(buildPipelineSpy).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ filters: [] }),
      );
      expect(screen.queryByRole('button', { name: 'Limpar filtros' })).toBeNull();
    });
  });

  describe('search prop', () => {
    const search = {
      placeholder: 'Buscar por nome…',
      toFilters: (term: string) => [{ field: 'nome', op: 'gte' as const, value: term }],
      toForcedOrderBy: () => ({ field: 'nome', direction: 'asc' as const }),
    };

    it('feeds the term into the query and forces the order it requires', () => {
      // A prefix RANGE must be the first orderBy or the query is invalid on the
      // classic path and silently stops matching its index on the Pipelines one.
      searchParamsRef.current = new URLSearchParams('q=camiseta');
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          search={search}
        />,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          filters: [{ field: 'nome', op: 'gte', value: 'camiseta' }],
          orderBy: [{ field: 'nome', direction: 'asc' }],
        }),
      );
      searchParamsRef.current = new URLSearchParams();
    });

    it('shows a restored term in the box and as a chip', () => {
      writeListViewMemory(MEMORY_KEY, { qs: 'q=camiseta', pages: 1, scroll: 0 });
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          search={search}
        />,
      );
      expect((screen.getByLabelText('Buscar') as HTMLInputElement).value).toBe('camiseta');
      expect(screen.getByText('Busca: "camiseta"')).toBeTruthy();
    });

    it('leaves ?q= alone when the table does not own the search box', () => {
      // /clientes and /nfe/comunicacoes resolve their term asynchronously and
      // keep their own input; wiping their param would clear their search.
      window.history.replaceState(null, '', '/clientes?q=meu-termo');
      const replaceState = vi.spyOn(window.history, 'replaceState');
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      fireEvent.click(screen.getByText('Nome'));
      expect(replaceState).toHaveBeenLastCalledWith(
        null,
        '',
        '/clientes?q=meu-termo&sort=nome%3Aasc',
      );
      replaceState.mockRestore();
    });

    it('renders no search box when the prop is absent', () => {
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      expect(screen.queryByLabelText('Buscar')).toBeNull();
    });
  });
});
