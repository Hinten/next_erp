import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { z } from 'zod';
import type { CollectionHandle } from '@delfrance/data';
import type { SnapshotRow, SnapshotState } from '@delfrance/data/hooks';

// Stub the snapshot hooks + the query helpers so the table renders a static
// dataset without hitting Firestore's internals. We control the response on a
// per-test basis via the hoisted `snapState`. `pushSpy` captures router
// navigation; `searchParamsRef` lets a test seed the URL. The URL-sync effect
// writes via `window.history.replaceState`, so cases that assert on it spy on
// that directly rather than on the router.
const { snapState, pushSpy, searchParamsRef, buildPipelineSpy, pipelineSupportedRef } = vi.hoisted(
  () => ({
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
  }),
);

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
    whereOp: () => ({ __c: 'where' }),
  };
});

import { TableView } from './TableView';

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
  };
}

function wrap(node: React.ReactNode) {
  // `env="test"` disables Mantine transitions/portals so the ColumnPicker
  // popover renders synchronously and is queryable in jsdom.
  return render(<MantineProvider env="test">{node}</MantineProvider>);
}

describe('TableView', () => {
  afterEach(() => {
    // useLocalStorage persists visible columns; clear so cases don't leak.
    localStorage.clear();
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
      <MantineProvider env="test">
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          selectable
          actions={[{ id: 'del', label: 'Excluir', requiresSelection: true, run: vi.fn() }]}
        />
      </MantineProvider>,
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
  });
});
