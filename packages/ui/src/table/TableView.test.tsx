import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
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
  buildQuerySpy,
  monitorRef,
  notifyShow,
  widenState,
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
  // ⚠️ Tags the built pipeline with `__widen` so the snapshot stub can answer
  // the two pipelines DIFFERENTLY. Without that, TableView's primary query and
  // its empty-result widening share one canned response, and a widening test
  // passes on the primary's rows while asserting nothing about the second
  // query.
  buildPipelineSpy: vi.fn((_db: unknown, spec?: { textSearch?: unknown }) => ({
    __pipeline: true,
    __widen: !!spec?.textSearch,
  })),
  // What the WIDENING query returns. Separate from `snapState` for the reason
  // above; defaults to "answered, nothing found" so no existing case widens.
  widenState: {
    current: {
      data: [],
      loading: false,
      error: undefined,
    } as SnapshotState<SnapshotRow<{ nome?: string; tipo?: string }>[]>,
  },
  // Flip to false in a test to exercise the classic-query fallback path.
  pipelineSupportedRef: { current: true },
  // Spied so the fallback tests can assert which constraint each
  // extraFilters op maps to. Return values only matter as identities.
  whereOpSpy: vi.fn(() => ({ __c: 'where' })),
  whereArrayContainsSpy: vi.fn(() => ({ __c: 'whereArrayContains' })),
  // Spied so a test can assert the classic fallback built NO query at all —
  // the difference between "renders nothing" and "renders the whole table".
  buildQuerySpy: vi.fn(() => ({ __fakeQuery: true })),
  // The update-monitor drives the only refresh affordance /produtos has
  // left in its header. Stubbed so a test can raise `stale` and click it;
  // `stale: false` is what the real hook reports for every other case.
  notifyShow: vi.fn(),
  monitorRef: { current: { stale: false, acknowledge: vi.fn() } },
}));

vi.mock('./useCollectionMonitor', () => ({
  useCollectionMonitor: () => monitorRef.current,
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
  usePipelineSnapshot: (p: { __widen?: boolean } | null) =>
    p?.__widen ? widenState.current : snapState.current,
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
    buildQuery: buildQuerySpy,
    orderByField: () => ({ __c: 'orderBy' }),
    limit: () => ({ __c: 'limit' }),
    whereOp: whereOpSpy,
    whereArrayContains: whereArrayContainsSpy,
  };
});

vi.mock('@mantine/notifications', async () => {
  const actual =
    await vi.importActual<typeof import('@mantine/notifications')>('@mantine/notifications');
  return { ...actual, notifications: { show: (...args: unknown[]) => notifyShow(...args) } };
});

import { StrictMode } from 'react';
import { MAX_RESTORED_PAGES, SCROLL_PERSIST_DEBOUNCE_MS, TableView } from './TableView';
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
    // Same reason, for the MOCKED `useSearchParams`. It sits beside the three
    // above because it is the same class of leak, and it was the one missing:
    // a case that sets a filter param left it set for every case after it, so
    // whether the next one passed depended on the order they ran in.
    searchParamsRef.current = new URLSearchParams();
    pipelineSupportedRef.current = true;
    monitorRef.current = { stale: false, acknowledge: vi.fn() };
    widenState.current = { data: [], loading: false, error: undefined };
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

  it('renders no column picker under showColumnPicker={false}', () => {
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        showColumnPicker={false}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Configurar colunas' })).toBeNull();
  });

  it('ignores a persisted column set under showColumnPicker={false}', () => {
    // ⚠️ This, not the hidden button, is what makes the screen fixed. Hiding
    // the ⚙ while still hydrating localStorage would pin every returning
    // operator to whatever they last picked — including a set saved BEFORE the
    // screen went fixed — with no control left to change it, and would decide
    // the query's projection from a choice nobody can see.
    localStorage.setItem('delfrance:tableview:columns:tests', JSON.stringify(['nome']));
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        showColumnPicker={false}
      />,
    );
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Nome', 'Tipo', 'Observacoes']));
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

  // `rowLinkColumn` — the row is clickable but MOUSE-ONLY without it: the row's
  // handler takes no event, so Tab/Enter/Cmd-click/"Copy link address" are all
  // unreachable. Naming a column wraps its cell in a real anchor.
  //
  // jsdom renders the real `next/link` (nothing mocks it), but with no
  // AppRouterContext its own onClick returns early — so these cases assert the
  // rendered `href` and OUR handler's effects, never a next/link navigation.

  it('renders no row link and still pushes on click when rowLinkColumn is unset', () => {
    // The negative and the untouched default path in ONE case, so they cannot
    // drift apart: an implementation that always wrapped would fail both halves.
    pushSpy.mockClear();
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        rowHref={(id) => `/tests/${id}`}
      />,
    );
    expect(screen.queryByRole('link', { name: 'Alice' })).toBeNull();
    fireEvent.click(screen.getByText('Alice'));
    expect(pushSpy).toHaveBeenCalledWith('/tests/1');
  });

  it("rowLinkColumn wraps that column's cell in an anchor carrying the rowHref", () => {
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        rowHref={(id) => `/tests/${id}`}
        rowLinkColumn="nome"
      />,
    );
    expect(screen.getByRole('link', { name: 'Alice' }).getAttribute('href')).toBe('/tests/1');
    expect(screen.getByRole('link', { name: 'Bob' }).getAttribute('href')).toBe('/tests/2');
  });

  it('wraps only the named column', () => {
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        defaultColumns={['nome', 'tipo']}
        rowHref={(id) => `/tests/${id}`}
        rowLinkColumn="nome"
      />,
    );
    // Two rows, one link each, and it is the Nome cell — the Tipo cell (an
    // enum, so a <Badge>) stays unwrapped. Queried by role rather than by cell
    // text so the case does not depend on how a given kind renders.
    expect(screen.getAllByRole('link')).toHaveLength(2);
    const [, firstRow] = screen.getAllByRole('row'); // index 0 is the header
    const cells = within(firstRow!).getAllByRole('cell');
    expect(within(cells[0]!).getByRole('link').getAttribute('href')).toBe('/tests/1');
    expect(within(cells[1]!).queryByRole('link')).toBeNull();
  });

  it('clicking the row link does not also fire the row navigation', () => {
    // The double-push guard. Without `stopPropagation` a click runs next/link's
    // push AND the row's `router.push` in one tick — two undeduped App Router
    // pushes, so Back needs two presses. This case is the entire justification
    // for stopping propagation; if it ever goes green after the guard is
    // removed, the guard is not doing what its comment claims.
    pushSpy.mockClear();
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        rowHref={(id) => `/tests/${id}`}
        rowLinkColumn="nome"
      />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Alice' }));
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it('clicking outside the row link still navigates via router.push', () => {
    pushSpy.mockClear();
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        defaultColumns={['nome', 'tipo']}
        rowHref={(id) => `/tests/${id}`}
        rowLinkColumn="nome"
      />,
    );
    // Proves the anchor did not swallow the rest of the row: the Tipo cell has
    // no link, so its click bubbles to the <tr> exactly as it did before.
    const [, firstRow] = screen.getAllByRole('row'); // index 0 is the header
    fireEvent.click(within(firstRow!).getAllByRole('cell')[1]!);
    expect(pushSpy).toHaveBeenCalledWith('/tests/1');
  });

  it('does not navigate from the row link while text is selected with the mouse', () => {
    // Asserting `defaultPrevented` — not merely "no push" — is what pins the
    // cancellation contract: next/link bails when the handler preventDefaults,
    // and jsdom's Link never navigates anyway, so "no push" alone would pass
    // even if the guard were deleted.
    //
    // `detail: 1` is load-bearing and must be explicit: testing-library's click
    // defaults to `detail: 0`, which is the KEYBOARD shape (see the near-miss
    // below), so without it this case would assert the opposite of what its
    // name says.
    pushSpy.mockClear();
    const selection = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ toString: () => 'Ali' } as unknown as Selection);
    try {
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          rowHref={(id) => `/tests/${id}`}
          rowLinkColumn="nome"
        />,
      );
      const link = screen.getByRole('link', { name: 'Alice' });
      const event = createEvent.click(link, { detail: 1 });
      fireEvent(link, event);
      expect(event.defaultPrevented).toBe(true);
      expect(pushSpy).not.toHaveBeenCalled();
    } finally {
      selection.mockRestore();
    }
  });

  it('still navigates on Enter while text is selected elsewhere on the page', () => {
    // The NEAR-MISS half of the case above, and the whole reason the guard is
    // scoped to `detail > 0`. `getSelection()` is document-scoped, and moving
    // focus does not clear a selection — so a user who selected text anywhere,
    // then Tabbed to a row link and pressed Enter, would otherwise have the
    // navigation cancelled with nothing to explain why: the exact gesture this
    // prop exists to enable, killed by a guard copied from a mouse-only row.
    // A keyboard-activated click carries `detail === 0`.
    const selection = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ toString: () => 'selected elsewhere' } as unknown as Selection);
    try {
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          rowHref={(id) => `/tests/${id}`}
          rowLinkColumn="nome"
        />,
      );
      const link = screen.getByRole('link', { name: 'Alice' });
      const event = createEvent.click(link, { detail: 0 });
      fireEvent(link, event);
      expect(event.defaultPrevented).toBe(false);
    } finally {
      selection.mockRestore();
    }
  });

  it('renders no row link when onRowClick is set, and says so', () => {
    // `onRowClick` outranks `rowHref`, so a link would navigate where the row
    // opens a modal instead. Inert for every row on every render ⇒ a
    // design-time fact ⇒ warned, not left to present as "the prop does nothing".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onRowClick = vi.fn();
    try {
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          rowHref={(id) => `/tests/${id}`}
          rowLinkColumn="nome"
          onRowClick={onRowClick}
        />,
      );
      expect(screen.queryByRole('link', { name: 'Alice' })).toBeNull();
      fireEvent.click(screen.getByText('Alice'));
      expect(onRowClick).toHaveBeenCalledWith('1', expect.objectContaining({ nome: 'Alice' }));
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/onRowClick is set/));
    } finally {
      warn.mockRestore();
    }
  });

  it('warns when rowLinkColumn is set without a rowHref', () => {
    // The likeliest slip of all: the two props sit adjacent in the skill's
    // snippet, so copying one without the other names a perfectly valid column
    // that can never link to anything.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          rowLinkColumn="nome"
        />,
      );
      expect(screen.queryAllByRole('link')).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/rowHref is not set/));
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves the row accessible name unchanged', () => {
    // The one case standing between a future `aria-label` on that anchor and a
    // silently broken e2e suite: a descendant's aria-label REPLACES its text in
    // the row's name-from-contents computation, so every
    // `getByRole('row', { name })` locator in apps/web/e2e would stop matching
    // at once, with nothing here to say why.
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        rowHref={(id) => `/tests/${id}`}
        rowLinkColumn="nome"
      />,
    );
    expect(screen.getByRole('row', { name: /Alice/ })).toBeTruthy();
  });

  it('names the row link after the id when the linked value is empty', () => {
    // A nullable primary is ordinary here (`pedido.numero`, `cliente.nome` are
    // both `.nullable().default(null)`). The default renderer emits `—`, so
    // without a fallback every such row is an identical em dash in a screen
    // reader's links list — indistinguishable, on the exact audience this prop
    // exists for.
    // `finally`, not a trailing assignment: a failing assertion would otherwise
    // skip the restore and leave every LATER case rendering null-named rows,
    // turning one red test into a cascade that hides its own cause.
    snapState.current = {
      data: [
        { id: '1', path: 'x/1', data: { nome: null as unknown as string, tipo: '0' } },
        { id: '2', path: 'x/2', data: { nome: '', tipo: '1' } },
      ],
      loading: false,
      error: undefined,
    };
    try {
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          rowHref={(id) => `/tests/${id}`}
          rowLinkColumn="nome"
        />,
      );
      // Distinct names, and each still points at its own row.
      expect(screen.getByRole('link', { name: 'Abrir 1' }).getAttribute('href')).toBe('/tests/1');
      expect(screen.getByRole('link', { name: 'Abrir 2' }).getAttribute('href')).toBe('/tests/2');
    } finally {
      snapState.current = {
        data: [
          { id: '1', path: 'x/1', data: { nome: 'Alice', tipo: '0' } },
          { id: '2', path: 'x/2', data: { nome: 'Bob', tipo: '1' } },
        ],
        loading: false,
        error: undefined,
      };
    }
  });

  it('does not label the row link when the cell has text', () => {
    // The NEAR-MISS of the case above, and the guard on the rule the prop's
    // docstring states: an `aria-label` on a cell that HAS text would replace
    // that text in the row's name-from-contents computation, renaming every row
    // and breaking the e2e `getByRole('row', { name })` locators. The fallback
    // must fire ONLY where there is no text to replace.
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        rowHref={(id) => `/tests/${id}`}
        rowLinkColumn="nome"
      />,
    );
    expect(screen.getByRole('link', { name: 'Alice' }).hasAttribute('aria-label')).toBe(false);
    expect(screen.queryByRole('link', { name: 'Abrir 1' })).toBeNull();
  });

  it('wraps a virtual column too', () => {
    // The virtual branch is the only one that can reach `row.id`, which is why
    // /produtos had to hand-roll its link there. Both branches are wrapped so
    // such a screen can adopt the prop instead.
    wrap(
      <TableView
        schema={testSchema}
        collection={fakeCollection()}
        db={{} as never}
        defaultColumns={['ir']}
        virtualColumns={[
          {
            key: 'ir',
            label: 'Ir',
            dependsOn: [],
            renderCell: (row) => <span>abrir {row.id}</span>,
          },
        ]}
        rowHref={(id) => `/tests/${id}`}
        rowLinkColumn="ir"
      />,
    );
    expect(screen.getByRole('link', { name: 'abrir 1' }).getAttribute('href')).toBe('/tests/1');
  });

  it('renders no row link for a row with an empty id', () => {
    // An `<a href="/tests/">` would be worse than today's dead row: it is
    // keyboard-reachable and lands on a 404.
    snapState.current = {
      data: [{ id: '', path: 'x/', data: { nome: 'Alice', tipo: '0' } }],
      loading: false,
      error: undefined,
    };
    // `finally` so a failure here cannot cascade into every later case.
    try {
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          rowHref={(id) => `/tests/${id}`}
          rowLinkColumn="nome"
        />,
      );
      expect(screen.queryAllByRole('link')).toHaveLength(0);
    } finally {
      snapState.current = {
        data: [
          { id: '1', path: 'x/1', data: { nome: 'Alice', tipo: '0' } },
          { id: '2', path: 'x/2', data: { nome: 'Bob', tipo: '1' } },
        ],
        loading: false,
        error: undefined,
      };
    }
  });

  it('warns and renders no row link when rowLinkColumn names a hidden field', () => {
    // The /produtos shape: `fields: { nome: { hidden: true } }` replaces a
    // schema column with a virtual one. Naming the hidden key would render
    // nothing, forever, while the row kept navigating — indistinguishable from
    // "the prop does nothing" without this warning.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          fields={{ nome: { hidden: true } }}
          rowHref={(id) => `/tests/${id}`}
          rowLinkColumn="nome"
        />,
      );
      expect(screen.queryAllByRole('link')).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/rowLinkColumn="nome"/));
    } finally {
      warn.mockRestore();
    }
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
      // A column filter puts this table on the STATIC transport. The declared
      // query with no filters now STREAMS (`resolveListMode`), and the pipeline
      // is not built at all — so the seeding this test is about has to be
      // observed on the path that still uses it.
      searchParamsRef.current = new URLSearchParams('observacoes=contains:x');
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

    it('STREAMS the declared query, and drops to the pipeline for anything else', () => {
      // The #40 fix, pinned at the seam. The declared query — no filter, no
      // search, declared sort — is the ONLY shape both index guards already
      // assert an index for, so it is the only shape allowed to hold an open
      // listener. Everything else must fall back to the one-shot pipeline.
      //
      // Without this case the gate could be deleted and every other test here
      // would still pass: they assert what the PIPELINE is built with, and
      // removing the gate simply routes everything back through it.
      const meta = {
        ...metaBase,
        defaultQuery: { orderBy: [{ field: 'nome', direction: 'asc' as const }], limit: 25 },
      };
      buildPipelineSpy.mockClear();
      buildQuerySpy.mockClear();
      const { unmount } = wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={meta}
        />,
      );
      expect(
        buildPipelineSpy,
        'the declared query must not build a pipeline',
      ).not.toHaveBeenCalled();
      expect(buildQuerySpy, 'the declared query must build a classic query').toHaveBeenCalled();
      unmount();

      // One column filter is enough to leave the live path.
      searchParamsRef.current = new URLSearchParams('observacoes=contains:x');
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={meta}
        />,
      );
      expect(buildPipelineSpy, 'a filtered query must go back to the pipeline').toHaveBeenCalled();
    });

    it('warns that sorting stops the list updating itself', () => {
      // The freeze is deliberate but invisible — the rows simply stop moving.
      // The badge is the standing indicator; this is the one-time explanation
      // of what just changed.
      notifyShow.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={{
            ...metaBase,
            defaultQuery: { orderBy: [{ field: 'nome', direction: 'asc' as const }], limit: 25 },
          }}
        />,
      );
      fireEvent.click(screen.getByText('Nome'));
      expect(notifyShow).toHaveBeenCalledTimes(1);
      expect(notifyShow.mock.calls[0]![0]).toMatchObject({ color: 'yellow' });
    });

    it('does not warn again once the list is already static', () => {
      // Self-limiting rather than flag-limited: the first departing sort makes
      // the table static, so every later click fails the `transportIsLive`
      // guard. Isolated deliberately — the click here lands on `tipo:asc`, which
      // is NOT the declared order, so the only thing suppressing the toast is
      // that the table had already left the live path. Remove that guard and
      // this case fires.
      searchParamsRef.current = new URLSearchParams('sort=tipo:desc');
      notifyShow.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={{
            ...metaBase,
            defaultQuery: { orderBy: [{ field: 'nome', direction: 'asc' as const }], limit: 25 },
          }}
        />,
      );
      fireEvent.click(screen.getByText('Tipo'));
      expect(notifyShow).not.toHaveBeenCalled();
    });

    it('stays silent under a caller-owned query, which is still streaming', () => {
      // The branch where the POLICY and the TRANSPORT disagree, and it is live
      // in production: /clientes sets `queryOverride` for a matched endereço
      // search. `pipeline` is null there, so `transportIsLive` is TRUE and
      // `fallbackQuery` hands the caller's query to `useSnapshot` — the rows
      // keep streaming.
      //
      // Keyed on the transport, this toast fired on every header click of those
      // results, announcing that the list had stopped updating itself while the
      // badge beside it correctly read "Tempo real". Keyed on the policy
      // (`listMode`, which reports `static/override` here) it stays quiet,
      // because sorting does not change that transport at all: `fallbackQuery`
      // returns the override and never consults `effectiveOrderBy`.
      notifyShow.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          queryOverride={{ __q: 'caller' } as never}
          meta={{
            ...metaBase,
            defaultQuery: { orderBy: [{ field: 'nome', direction: 'asc' as const }], limit: 25 },
          }}
        />,
      );
      fireEvent.click(screen.getByText('Nome'));
      fireEvent.click(screen.getByText('Tipo'));
      expect(notifyShow, 'sorting an overridden query changes no transport').not.toHaveBeenCalled();
      // And the badge must still say the truth about that list.
      expect(screen.getByText('Tempo real')).toBeDefined();
    });

    it('lets the SEARCH keep the orderBy lead when a column range is also active', () => {
      // /produtos' search emits a `nome` PREFIX RANGE and forces `nome asc` to
      // keep it leading; its docstring says another sort "silently stop[s] using
      // produtos(paiId, nome) — turning the seek this search exists to be into
      // the full scan". A column range is therefore the SECOND inequality, and
      // the second one is a post-filter either way, so the lead belongs to the
      // search — which has an index built for it.
      //
      // Ranked the other way round, typing in the search box while a date range
      // was open silently demoted the search's own range and scanned.
      searchParamsRef.current = new URLSearchParams('observacoes=between:1..9&q=cami');
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={metaBase}
          search={{
            placeholder: 'Buscar',
            toFilters: (t) => [{ field: 'nome', op: 'gte', value: t }],
            toForcedOrderBy: () => ({ field: 'nome', direction: 'asc' as const }),
          }}
        />,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orderBy: [{ field: 'nome', direction: 'asc' }] }),
      );
    });

    it('gives a column range the lead when no search is competing for it', () => {
      searchParamsRef.current = new URLSearchParams('observacoes=between:1..9');
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={metaBase}
        />,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orderBy: [{ field: 'observacoes', direction: 'desc' }] }),
      );
    });

    it('lets a header click flip the range column, the one legal sort here', () => {
      // `forcedSort` outranks the user sort, so without this the range column's
      // own header is a dead control: the click writes `?sort=` to the URL while
      // the table stays put. The DIRECTION is free — both are index-legal.
      searchParamsRef.current = new URLSearchParams(
        'observacoes=between:1..9&sort=observacoes:asc',
      );
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={metaBase}
        />,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ orderBy: [{ field: 'observacoes', direction: 'asc' }] }),
      );
    });

    it('widens the projection by an action predicate, and disables it when undeclared', () => {
      // The trap this pins: `row.data` is a `select()` projection on the static
      // path, so a predicate reading a field nobody projected gets `undefined`
      // and refuses EVERY row — behind a disabled button with a plausible
      // tooltip. Three pedido actions already re-read the whole document to
      // dodge exactly this.
      searchParamsRef.current = new URLSearchParams('observacoes=contains:x');
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={{
            ...metaBase,
            defaultQuery: {
              orderBy: [{ field: 'nome', direction: 'asc' as const }],
              columns: ['nome'],
              limit: 25,
            },
          }}
          selectable
          actions={[
            {
              id: 'g',
              label: 'Guardada',
              requiresSelection: true,
              rowIneligibleReason: () => null,
              rowEligibilityFields: ['tipo'],
              run: () => {},
            },
          ]}
        />,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ select: expect.arrayContaining(['nome', 'tipo']) }),
      );

      // No declaration ⇒ full-document read, the same escape hatch a virtual
      // column without `dependsOn` gets. `select: undefined` is that read.
      buildPipelineSpy.mockClear();
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={{
            ...metaBase,
            defaultQuery: {
              orderBy: [{ field: 'nome', direction: 'asc' as const }],
              columns: ['nome'],
              limit: 25,
            },
          }}
          selectable
          actions={[
            {
              id: 'g',
              label: 'Guardada',
              requiresSelection: true,
              rowIneligibleReason: () => null,
              run: () => {},
            },
          ]}
        />,
      );
      expect(buildPipelineSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ select: undefined }),
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
      // A column filter puts this table on the STATIC transport. The declared
      // query with no filters now STREAMS (`resolveListMode`), and the pipeline
      // is not built at all — so the seeding this test is about has to be
      // observed on the path that still uses it.
      searchParamsRef.current = new URLSearchParams('observacoes=contains:x');
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
      // A column filter puts this table on the STATIC transport. The declared
      // query with no filters now STREAMS (`resolveListMode`), and the pipeline
      // is not built at all — so the seeding this test is about has to be
      // observed on the path that still uses it.
      searchParamsRef.current = new URLSearchParams('observacoes=contains:x');
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
          // Base first, the operator's column filter after — which is the
          // ordering this test is named for.
          filters: [
            { field: 'tipo', op: 'eq', value: '1' },
            { field: 'observacoes', op: 'contains', value: 'x' },
          ],
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
      // A column filter puts this table on the STATIC transport. The declared
      // query with no filters now STREAMS (`resolveListMode`), and the pipeline
      // is not built at all — so the seeding this test is about has to be
      // observed on the path that still uses it.
      searchParamsRef.current = new URLSearchParams('observacoes=contains:x');
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
      // Asserted through the TRANSPORT, which is now the stronger form. Only a
      // query that is byte-for-byte the declared one reaches the live path
      // (`resolveListMode`), so "no pipeline was built" IS "the sort is the
      // declared default". Had the click been recorded as `tipo:asc`, the sort
      // would differ from the declaration, the table would be static, and the
      // pipeline WOULD have been built — so this negative cannot pass vacuously.
      expect(buildPipelineSpy).not.toHaveBeenCalled();
      expect(buildQuerySpy).toHaveBeenCalled();
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
      // Same reasoning as the case above: reaching the LIVE transport is only
      // possible for the declared query, so this proves the fallback landed on
      // it — and additionally that clearing a forced sort restores streaming.
      expect(buildPipelineSpy).not.toHaveBeenCalled();
      expect(buildQuerySpy).toHaveBeenCalled();
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

    it('keeps the restored window under StrictMode', async () => {
      // `apps/web/next.config` sets `reactStrictMode: true`, so in dev React
      // mounts, unmounts and REMOUNTS on the same fiber and runs every effect
      // twice. A boolean "skip my first run" ref does not survive that — it is
      // already armed on the second run, so the reset fires and the restored
      // window vanishes in `next dev` while production is fine. Rendering
      // without StrictMode (as every other case here does) cannot see it.
      writeListViewMemory(MEMORY_KEY, { qs: '', pages: 2, scroll: 0 });
      buildPipelineSpy.mockClear();
      render(
        <StrictMode>
          <MantineTestProvider>
            <TableView
              schema={testSchema}
              collection={fakeCollection()}
              db={{} as never}
              pageSize={2}
            />
          </MantineTestProvider>
        </StrictMode>,
      );
      const limits = buildPipelineSpy.mock.calls.map(
        (call) => (call as unknown as [unknown, { limit: number }])[1].limit,
      );
      expect(limits.at(-1)).toBe(4);
    });

    it('writes the scroll offset once the gesture settles, not during it', async () => {
      // A per-frame write runs ~60 stringify+setItem pairs a second for the
      // whole gesture and none of them is ever read — the offset is consumed
      // only by the next mount. The intermediate offsets must never land.
      vi.useFakeTimers();
      vi.stubGlobal('scrollTo', vi.fn());
      wrap(<TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />);
      for (const y of [10, 40, 90, 140]) {
        Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
        window.dispatchEvent(new Event('scroll'));
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(readListViewMemory(MEMORY_KEY)?.scroll ?? 0).toBe(0);

      await vi.advanceTimersByTimeAsync(SCROLL_PERSIST_DEBOUNCE_MS + 20);
      expect(readListViewMemory(MEMORY_KEY)?.scroll).toBe(140);
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it('flushes a pending scroll when the list unmounts', async () => {
      // Clicking a row within the debounce window of the last scroll is exactly
      // the gesture this feature exists to remember; without the flush it is
      // the one gesture that loses it.
      vi.useFakeTimers();
      vi.stubGlobal('scrollTo', vi.fn());
      const { unmount } = wrap(
        <TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />,
      );
      Object.defineProperty(window, 'scrollY', { value: 640, configurable: true });
      window.dispatchEvent(new Event('scroll'));
      unmount();
      expect(readListViewMemory(MEMORY_KEY)?.scroll).toBe(640);
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it('abandons the remembered scroll once the operator changes the query', async () => {
      // The search box and the chip row are interactive while the first query
      // — sized to the RESTORED window, so possibly slow — is still loading.
      // An operator who filters in that gap must not be thrown down a result
      // set they never scrolled when their own rows finally land.
      const scrollTo = vi.fn();
      vi.stubGlobal('scrollTo', scrollTo);
      writeListViewMemory(MEMORY_KEY, { qs: '', pages: 1, scroll: 840 });
      const withRows = snapState.current;
      snapState.current = { data: [], loading: false, error: undefined };

      const { rerender } = wrap(
        <TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />,
      );
      // Their own filter, before any row has arrived.
      fireEvent.click(screen.getByRole('button', { name: 'Filtrar Nome' }));
      fireEvent.change(screen.getByLabelText('Nome contém'), { target: { value: 'ana' } });
      fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));

      snapState.current = withRows;
      rerender(
        <MantineTestProvider>
          <TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />
        </MantineTestProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(scrollTo).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('does not zero a remembered offset when it unmounts without a scroll', async () => {
      // The StrictMode mount/cleanup/remount cycle would otherwise flush
      // `scrollY` 0 over the offset the restore is still on its way to
      // putting back.
      vi.stubGlobal('scrollTo', vi.fn());
      writeListViewMemory(MEMORY_KEY, { qs: '', pages: 1, scroll: 840 });
      const { unmount } = wrap(
        <TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />,
      );
      unmount();
      expect(readListViewMemory(MEMORY_KEY)?.scroll).toBe(840);
      vi.unstubAllGlobals();
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

    describe('resolveIds', () => {
      function renderWithResolver(resolveIds: (term: string) => Promise<unknown>) {
        searchParamsRef.current = new URLSearchParams('q=MLB1');
        buildPipelineSpy.mockClear();
        wrap(
          <TableView
            schema={testSchema}
            collection={fakeCollection()}
            db={{} as never}
            search={{ ...search, resolveIds: resolveIds as never }}
          />,
        );
      }

      afterEach(() => {
        searchParamsRef.current = new URLSearchParams();
      });

      it('constrains the query to the resolved ids and drops the term filters', async () => {
        // The two search modes are alternatives, never conjuncts: AND-ing the
        // nome range onto an id restriction asks for rows satisfying both.
        renderWithResolver(() => Promise.resolve({ ids: ['a', 'b'] }));
        await vi.waitFor(() =>
          expect(buildPipelineSpy).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ idIn: ['a', 'b'], filters: [] }),
          ),
        );
        // ⚠️ Matcher, not `.mock.lastCall[1]`: indexing a `vi.fn` call tuple
        // is `TS2493` under this repo's tsconfig.
        expect(buildPipelineSpy).not.toHaveBeenLastCalledWith(
          expect.anything(),
          expect.objectContaining({ orderBy: [{ field: 'nome', direction: 'asc' }] }),
        );
      });

      it('falls through to toFilters when the resolver declines the term', async () => {
        renderWithResolver(() => Promise.resolve(null));
        await vi.waitFor(() =>
          expect(buildPipelineSpy).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({
              filters: [{ field: 'nome', op: 'gte', value: 'MLB1' }],
              orderBy: [{ field: 'nome', direction: 'asc' }],
            }),
          ),
        );
      });

      it('renders an empty table WITHOUT querying when the resolver matched nothing', async () => {
        // ⚠️ `{ ids: [] }` is a real answer, not an absence. Falling through
        // here would run the nome range over a term nobody meant as a name and
        // report ITS miss instead.
        renderWithResolver(() => Promise.resolve({ ids: [] }));
        await vi.waitFor(() => expect(screen.getByText('Nenhum resultado.')).toBeTruthy());
        expect(buildPipelineSpy).not.toHaveBeenCalled();
      });

      it('warns when the resolution hit its cap instead of passing off a prefix as the answer', async () => {
        renderWithResolver(() => Promise.resolve({ ids: ['a'], truncated: true }));
        await vi.waitFor(() => expect(screen.getByText(/Refine o termo/)).toBeTruthy());
      });

      it('surfaces a resolver failure instead of rendering an empty list', async () => {
        renderWithResolver(() => Promise.reject(new Error('boom')));
        await vi.waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
      });

      it('re-resolves the term when the update-monitor refreshes', async () => {
        // ⚠️ Without `refreshKey` threaded into the hook, "Atualizar" re-runs
        // the row query against the id list resolved MINUTES ago — fresh rows
        // read from a stale set, which is the exact state that banner exists to
        // get the operator out of.
        monitorRef.current = { stale: true, acknowledge: vi.fn() };
        const resolveIds = vi.fn(() => Promise.resolve({ ids: ['a'] }));
        renderWithResolver(resolveIds);
        await vi.waitFor(() => expect(resolveIds).toHaveBeenCalledTimes(1));

        fireEvent.click(screen.getByRole('button', { name: 'Página desatualizada — atualizar' }));
        await vi.waitFor(() => expect(resolveIds).toHaveBeenCalledTimes(2));
      });

      it('builds NO classic query while an id restriction is active', async () => {
        // Only the pipeline can honour `idIn`. On the classic fallback the
        // choice is between rendering nothing and rendering the WHOLE
        // collection under a term that matched one row — the same reason the
        // subcollection lookup bails there, which a search resolution has to
        // share rather than fall through.
        pipelineSupportedRef.current = false;
        buildQuerySpy.mockClear();
        // `truncated` is the settle beacon: `useSnapshot` is mocked to return
        // rows whatever query it is handed, so the empty state cannot say
        // whether the resolution landed — this hint only renders once it has.
        renderWithResolver(() => Promise.resolve({ ids: ['a', 'b'], truncated: true }));
        await vi.waitFor(() => expect(screen.getByText(/Refine o termo/)).toBeTruthy());
        expect(buildQuerySpy).not.toHaveBeenCalled();
        pipelineSupportedRef.current = true;
      });
    });
  });

  describe('search.toTextQuery — widening an empty result', () => {
    const metaWiden = {
      collectionPath: 'tests',
      permissions: { read: 0n, write: 0n, delete: 0n },
    } as const;

    /** The prefix range the widening exists to sit BEHIND. */
    const searchWiden = {
      placeholder: 'Buscar',
      toFilters: (t: string) => [{ field: 'nome', op: 'gte' as const, value: t }],
      toForcedOrderBy: () => ({ field: 'nome', direction: 'asc' as const }),
      toTextQuery: (t: string) => t.trim() || undefined,
    };

    function renderComBusca(termo = 'cami') {
      searchParamsRef.current = new URLSearchParams(`q=${encodeURIComponent(termo)}`);
      buildPipelineSpy.mockClear();
      return wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={metaWiden}
          search={searchWiden}
        />,
      );
    }

    /** Every spec `buildPipeline` was handed that carried a text search. */
    function especsDeTexto() {
      return buildPipelineSpy.mock.calls
        .map((c) => c[1] as { textSearch?: { query: string }; filters?: unknown[] } | undefined)
        .filter((spec) => !!spec?.textSearch);
    }

    it('does not widen while the primary query is returning rows', () => {
      // The common path, and the one that must cost nothing. `snapState` still
      // holds Alice and Bob.
      renderComBusca();
      expect(especsDeTexto()).toHaveLength(0);
      expect(screen.queryByText(/Mostrando nomes que contêm/)).toBeNull();
    });

    it('widens once the primary has answered with nothing, and says so', () => {
      snapState.current = { data: [], loading: false, error: undefined };
      widenState.current = {
        data: [{ id: '9', path: 'x/9', data: { nome: 'Bandeja Gatinho', tipo: '0' } }],
        loading: false,
        error: undefined,
      };
      renderComBusca();

      const especs = especsDeTexto();
      expect(especs).toHaveLength(1);
      expect(especs[0]?.textSearch).toEqual({ query: 'cami' });
      // The rows have to reach the TABLE, not just the query — `rows` is what
      // selection, counts and the action bar all read.
      expect(screen.getByText('Bandeja Gatinho')).toBeTruthy();
      expect(screen.getByText(/Mostrando nomes que contêm/)).toBeTruthy();
    });

    it('drops the search filters the widening exists to get past', () => {
      // ⚠️ The mistake this pins is silent and self-confirming: re-applying the
      // prefix range that JUST returned nothing guarantees the widened query
      // returns nothing too, so the feature looks implemented, runs a second
      // billed query, and can never produce a row.
      snapState.current = { data: [], loading: false, error: undefined };
      renderComBusca();

      const filtros = (especsDeTexto()[0]?.filters ?? []) as Array<{ field: string; op: string }>;
      expect(filtros.some((f) => f.field === 'nome' && f.op === 'gte')).toBe(false);
    });

    it('does not widen while a refetch is in flight over an empty result', () => {
      // ⚠️ `data: []` WITH `loading: true` is the state that discriminates, and
      // it is a real one: `usePipelineSnapshot` sets `loading` via
      // `setState(s => ({ ...s, loading: true }))`, so the PREVIOUS rows survive
      // into the next fetch. Written with `data: undefined` this test passes
      // with the `!snap.loading` guard deleted — the `?? -1` below already
      // rejects undefined — and would have pinned nothing.
      snapState.current = { data: [], loading: true, error: undefined };
      renderComBusca();
      expect(especsDeTexto()).toHaveLength(0);
    });

    it('does not widen when the primary query FAILED', () => {
      // ⚠️ An error is not an empty result. Widening past it answers a question
      // the primary never got to ask: the operator reads "nothing starts with
      // this, here is what contains it" when the truth is that the first query
      // broke.
      //
      // ⚠️ Same discrimination problem as above, and worth stating because the
      // state is NOT one today's hooks produce — the catch in
      // `usePipelineSnapshot` nulls `data`, so the `?? -1` would stop the
      // widening on its own and a test written that way is vacuous. This pins
      // the `!snap.error` guard against a hook that keeps the last rows on
      // failure, which is exactly what it already does while loading.
      snapState.current = {
        data: [],
        loading: false,
        error: new Error('boom') as never,
      };
      renderComBusca();
      expect(especsDeTexto()).toHaveLength(0);
      expect(screen.getByText('boom')).toBeTruthy();
    });

    it('sanitises the term, so a DSL operator is not read as syntax', () => {
      // `-` negates in the search DSL, so the raw term would ask for
      // "Porta but NOT lápis" and come back empty with nothing to notice.
      snapState.current = { data: [], loading: false, error: undefined };
      renderComBusca('Porta-lápis');
      expect(especsDeTexto()[0]?.textSearch).toEqual({ query: 'Porta lápis' });
    });

    it('issues nothing when the term sanitises away entirely', () => {
      snapState.current = { data: [], loading: false, error: undefined };
      renderComBusca('---');
      expect(especsDeTexto()).toHaveLength(0);
    });

    it('never widens on the classic fallback, which has no text search', () => {
      // The emulator e2e lane runs this path. A test written against the
      // widening would pass on staging and fail there, or vice versa.
      pipelineSupportedRef.current = false;
      snapState.current = { data: [], loading: false, error: undefined };
      renderComBusca();
      expect(especsDeTexto()).toHaveLength(0);
      expect(screen.queryByText(/Mostrando nomes que contêm/)).toBeNull();
      pipelineSupportedRef.current = true;
    });
  });
});
