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
  monitorFieldRef,
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
  // Spied so a test can assert the classic fallback built NO query at all —
  // the difference between "renders nothing" and "renders the whole table".
  buildQuerySpy: vi.fn(() => ({ __fakeQuery: true })),
  // The update-monitor drives the only refresh affordance /produtos has left
  // in its header — on its SEARCHED view, which is where the term puts it on
  // the frozen transport. Stubbed so a test can raise `stale` and click it;
  // `stale: false` is what the real hook reports for every other case.
  monitorRef: { current: { stale: false, acknowledge: vi.fn() } },
  // The `field` of the last call, which is how TableView switches the monitor
  // off: `null` while the rows stream. ⚠️ The mock deliberately does NOT act on
  // it — a mock that returned `stale: false` for a null field would keep the
  // rendering test green after someone deleted the production gate.
  monitorFieldRef: { current: undefined as string | null | undefined },
}));

vi.mock('./useCollectionMonitor', () => ({
  useCollectionMonitor: (opts: { field: string | null }) => {
    monitorFieldRef.current = opts.field;
    return monitorRef.current;
  },
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
    buildQuery: buildQuerySpy,
    orderByField: () => ({ __c: 'orderBy' }),
    limit: () => ({ __c: 'limit' }),
    whereOp: whereOpSpy,
    whereArrayContains: whereArrayContainsSpy,
  };
});

import { StrictMode } from 'react';
import { MAX_PAGES, MAX_RESTORED_PAGES, SCROLL_PERSIST_DEBOUNCE_MS, TableView } from './TableView';
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
    monitorFieldRef.current = undefined;
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

    it('keeps a caller-owned query on the live transport, badge included', () => {
      // The branch where the POLICY and the TRANSPORT disagree, and it is live
      // in production: /clientes sets `queryOverride` for a matched endereço
      // search. `pipeline` is null there, so `transportIsLive` is TRUE and
      // `fallbackQuery` hands the caller's query to `useSnapshot` — the rows
      // keep streaming, which is what the badge must report even though
      // `listMode` calls this `static/override`.
      //
      // Sorting such a list changes no transport at all: `fallbackQuery`
      // returns the override and never consults `effectiveOrderBy`. So the
      // badge must read the same before and after the clicks.
      //
      // ⚠️ This is the only assertion on the badge anywhere in the repo. It
      // outlived the toast whose regression test it arrived with (the toast
      // was keyed on the transport, so it fired on every header click of these
      // results while the badge beside it correctly said "Tempo real").
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
      expect(screen.getByText('Tempo real')).toBeDefined();
      fireEvent.click(screen.getByText('Nome'));
      fireEvent.click(screen.getByText('Tipo'));
      expect(
        screen.getByText('Tempo real'),
        'sorting an overridden query changes no transport',
      ).toBeDefined();
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

  /**
   * The control beside the mode badge that puts a frozen list back on the
   * declared query.
   *
   * It exists because the app used to ask for something impossible:
   * `STATIC_REASON_LABEL.sort` says "limpe a ordenação para voltar ao tempo
   * real", but a sort renders no filter chip, `ActiveFilters` returns null with
   * no chips, and `clearAll` never touched the sort — so in the one case that
   * needed an escape hatch, nothing was rendered and nothing could have helped.
   */
  describe('reset control', () => {
    const RESET = 'Limpar ordenação, filtros e busca';
    // ⚠️ Spread, exactly like every other meta fixture in this file, and not by
    // style: `delfrance/default-query-needs-index` engages on a `defaultQuery`
    // whose object has a LITERAL `collectionPath` sibling, and would then
    // demand a real entry in firestore.indexes.json for a collection called
    // "tests". The spread leaves no literal sibling, so the rule bails.
    const metaBase = {
      collectionPath: 'tests',
      permissions: { read: 0n, write: 0n, delete: 0n },
    } as const;
    const declared = {
      ...metaBase,
      defaultQuery: { orderBy: [{ field: 'nome', direction: 'asc' as const }], limit: 25 },
    };
    const resetButton = () => screen.getByRole('button', { name: RESET }) as HTMLButtonElement;

    it('brings a sort-only static list back to the live transport', () => {
      // THE case the control was added for. Nothing is filtered and nothing is
      // searched — the sort alone is what left the streaming path.
      searchParamsRef.current = new URLSearchParams('sort=tipo:desc');
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={declared}
        />,
      );
      expect(screen.getByText('Resultado fixo')).toBeDefined();

      searchParamsRef.current = new URLSearchParams();
      buildPipelineSpy.mockClear();
      buildQuerySpy.mockClear();
      fireEvent.click(resetButton());

      expect(
        buildPipelineSpy,
        'back on the declared query, so nothing may build a pipeline',
      ).not.toHaveBeenCalled();
      expect(
        buildQuerySpy,
        'the declared query streams through a classic query',
      ).toHaveBeenCalled();
      expect(screen.getByText('Tempo real')).toBeDefined();
    });

    it('clears the filter, the term and the sort in one click', () => {
      // One assertion pins all three: `encodeTableState` serialises filters,
      // sort and search together, so dropping any single setter leaves its own
      // key behind in the remembered query string. It also pins that the reset
      // is REMEMBERED as cleared rather than resurrected on the next visit.
      searchParamsRef.current = new URLSearchParams('nome=contains:ana&q=cami&sort=tipo:desc');
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={declared}
          search={{
            placeholder: 'Buscar…',
            toFilters: (term: string) => [{ field: 'nome', op: 'gte' as const, value: term }],
          }}
        />,
      );
      searchParamsRef.current = new URLSearchParams();
      fireEvent.click(resetButton());

      expect(readListViewMemory(MEMORY_KEY)?.qs).toBe('');
    });

    it('does not collide with the chip row’s clear-all locator', () => {
      // Playwright matches an accessible name by SUBSTRING unless a spec passes
      // `exact`, and `clientes.cadastros.e2e.spec.ts` does not — it locates
      // "Limpar filtros" and then asserts the count drops to zero. Naming this
      // control "Limpar filtros e ordenação" would make that spec ambiguous and
      // then red, from a file it never imports. The regex mirrors those
      // semantics so the collision is caught here in milliseconds instead.
      searchParamsRef.current = new URLSearchParams('nome=contains:ana');
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={declared}
        />,
      );
      searchParamsRef.current = new URLSearchParams();

      expect(screen.getAllByRole('button', { name: /Limpar filtros/ })).toHaveLength(1);
    });

    it('is always mounted, and disabled only when nothing of yours is set', () => {
      // "Sempre presente" is the decision: an operator should never have to
      // discover that the way back appears only under some conditions.
      const render = () =>
        wrap(
          <TableView
            schema={testSchema}
            collection={fakeCollection()}
            db={{} as never}
            meta={declared}
          />,
        );

      const pristine = render();
      expect(resetButton().hasAttribute('disabled'), 'nothing to clear').toBe(true);
      pristine.unmount();

      searchParamsRef.current = new URLSearchParams('sort=tipo:desc');
      const sorted = render();
      expect(resetButton().hasAttribute('disabled'), 'a sort is yours to clear').toBe(false);
      sorted.unmount();

      searchParamsRef.current = new URLSearchParams('nome=contains:ana');
      render();
      expect(resetButton().hasAttribute('disabled'), 'a filter is yours to clear').toBe(false);
      searchParamsRef.current = new URLSearchParams();
    });

    it('does not count the orderBy prop as the operator’s sort', () => {
      // `resolveInitialTableState` seeds `sort` from the `orderBy` prop, so
      // `sort !== undefined` is TRUE on a virgin load of any screen passing it
      // — /nfe/comunicacoes today. Counting that would arm the control before
      // the operator touched anything, and clicking it would change nothing
      // they can see: the "enabled button that does nothing" this control's
      // own rule exists to prevent.
      const pristine = wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={declared}
          orderBy={{ field: 'nome', direction: 'asc' }}
        />,
      );
      expect(resetButton().hasAttribute('disabled'), 'the prop is not theirs').toBe(true);
      pristine.unmount();

      // A real header click on top of that prop IS theirs, and must arm it.
      searchParamsRef.current = new URLSearchParams('sort=tipo:desc');
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={declared}
          orderBy={{ field: 'nome', direction: 'asc' }}
        />,
      );
      expect(resetButton().hasAttribute('disabled'), 'a real sort is theirs').toBe(false);
      searchParamsRef.current = new URLSearchParams();
    });

    it('resets to the screen’s own opening order, not past it', () => {
      // The `orderBy` prop is documented as OVERRIDING meta.defaultQuery.orderBy,
      // so a screen may legitimately open on a different order. Resetting to
      // `undefined` would discard that declaration on a click the operator
      // meant as "undo MY changes", and nothing but a reload would bring it
      // back — the URL sync has meanwhile dropped `?sort=`.
      searchParamsRef.current = new URLSearchParams('nome=contains:ana');
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          meta={declared}
          orderBy={{ field: 'tipo', direction: 'desc' }}
        />,
      );
      searchParamsRef.current = new URLSearchParams();
      fireEvent.click(resetButton());

      // The screen's order survived; only the operator's filter went.
      expect(readListViewMemory(MEMORY_KEY)?.qs).toBe('sort=tipo%3Adesc');
      expect(resetButton().hasAttribute('disabled'), 'nothing of theirs is left').toBe(true);
    });

    it('stays offered, and honest, where live is unreachable', () => {
      // A caller-owned query holds the POLICY on static, but none of it is the
      // operator's, so the control must not offer to fix what it cannot reach.
      // Keying the enabled rule on `listMode.mode !== 'live'` — a very
      // plausible reading of "show it when the list is frozen" — enables a
      // button here that would do nothing.
      wrap(
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          queryOverride={{ __q: 'caller' } as never}
          meta={declared}
        />,
      );
      expect(resetButton().hasAttribute('disabled')).toBe(true);
      expect(screen.getByText('Tempo real')).toBeDefined();
    });
  });

  describe('update monitor', () => {
    // The monitor is a SECOND listener, watching for another session's writes
    // behind the rows. It compensates for a frozen result set, so a list whose
    // rows stream has nothing for it to find — every change is already on
    // screen by the time it could report one.
    const metaBase = {
      collectionPath: 'tests',
      permissions: { read: 0n, write: 0n, delete: 0n },
    } as const;
    const declared = {
      ...metaBase,
      defaultQuery: { orderBy: [{ field: 'nome', direction: 'asc' as const }], limit: 25 },
    };
    // ⚠️ `testSchema` carries NEITHER `ultimaModificacao` nor `timestamp`, so
    // every test here would pass vacuously against it: the field resolution
    // returns null on the schema alone and the gate under test is never
    // reached. This schema is what makes the gate the only reason for a null.
    const monitoredSchema = z.object({
      nome: z.string(),
      tipo: z.enum(['0', '1']).describe('Tipo'),
      ultimaModificacao: z.number().nullable().default(null),
    });
    const monitored = () => fakeCollection() as unknown as CollectionHandle<typeof monitoredSchema>;
    const staleIcon = () =>
      screen.queryByRole('button', { name: 'Página desatualizada — atualizar' });
    const renderMonitored = () =>
      wrap(
        <TableView
          schema={monitoredSchema}
          collection={monitored()}
          db={{} as never}
          meta={declared}
        />,
      );

    it('watches nothing while the rows are streaming', () => {
      renderMonitored();
      expect(screen.getByText('Tempo real')).toBeDefined();
      expect(
        monitorFieldRef.current,
        'a null field is what keeps useSnapshot from subscribing at all',
      ).toBe(null);
    });

    it('watches once the rows are frozen', () => {
      // Pins that this is a GATE and not a deletion. The same list, one column
      // filter later, cannot see another session's writes by itself and still
      // owes the operator that signal.
      searchParamsRef.current = new URLSearchParams('nome=contains:ana');
      renderMonitored();
      searchParamsRef.current = new URLSearchParams();
      expect(screen.getByText('Resultado fixo')).toBeDefined();
      expect(monitorFieldRef.current).toBe('ultimaModificacao');
    });

    it('keeps the notice reachable on a frozen list', () => {
      searchParamsRef.current = new URLSearchParams('nome=contains:ana');
      monitorRef.current = { stale: true, acknowledge: vi.fn() };
      renderMonitored();
      searchParamsRef.current = new URLSearchParams();
      expect(screen.getByText('Resultado fixo')).toBeDefined();
      expect(staleIcon(), 'a one-shot result cannot refresh itself').not.toBeNull();
    });

    it('never shows the stale notice beside a “Tempo real” badge', () => {
      // The mock reports `stale` whatever field it is handed, so this fails
      // unless TableView ALSO refuses to render the icon. Two gates, one const:
      // the field closes the listener, this closes the pixel, and only this one
      // is visible to a render.
      monitorRef.current = { stale: true, acknowledge: vi.fn() };
      renderMonitored();
      expect(screen.getByText('Tempo real')).toBeDefined();
      expect(staleIcon(), 'the rows already carry every change').toBeNull();
    });

    it('leaves a caller-owned query watching nothing, because it streams', () => {
      // ⚠️ THE case that separates the two variables. `queryOverride` holds the
      // POLICY on static while `fallbackQuery` hands the caller's query to
      // `useSnapshot`, which streams it — /clientes' endereço search. Keying
      // either gate on `listMode.mode`, a very plausible reading of "watch it
      // when the list is frozen", leaves a pointless listener open here AND
      // paints "desatualizada" beside a "Tempo real" badge. That exact mix-up
      // has already shipped twice out of this file.
      monitorRef.current = { stale: true, acknowledge: vi.fn() };
      wrap(
        <TableView
          schema={monitoredSchema}
          collection={monitored()}
          db={{} as never}
          queryOverride={{ __q: 'caller' } as never}
          meta={declared}
        />,
      );
      expect(screen.getByText('Tempo real')).toBeDefined();
      expect(monitorFieldRef.current).toBe(null);
      expect(staleIcon()).toBeNull();
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
      writeListViewMemory(MEMORY_KEY, { qs: 'nome=contains%3Aana', scroll: 0 });
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
      writeListViewMemory(MEMORY_KEY, { qs: 'nome=contains%3Aana', scroll: 0 });
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
      writeListViewMemory(MEMORY_KEY, { qs: 'nome=contains%3Aana', scroll: 0 });
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
      writeListViewMemory(MEMORY_KEY, { qs: 'pages=10', scroll: 0 });
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
      writeListViewMemory(MEMORY_KEY, { qs: 'pages=2', scroll: 0 });
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
      writeListViewMemory(MEMORY_KEY, { qs: 'pages=2', scroll: 0 });
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

    it('persists where the operator was, not where a later collapse clamped them', async () => {
      // The `onScroll` guard ignores the clamp EVENT, but a timer already armed
      // by a real scroll is not disarmed by it. A callback that read
      // `window.scrollY` when it fired would therefore read whatever a collapse
      // landing inside those 150ms clamped it to — a wheel gesture ending on
      // "Atualizar" or a chip is enough, and `lookupLoading` flipping is not
      // human-timed at all. The offset is captured in the handler instead.
      vi.useFakeTimers();
      vi.stubGlobal('scrollTo', vi.fn());
      const withRows = snapState.current;
      // A third value, so "wrote the clamp" and "never wrote" stay tellable
      // apart from "wrote the right thing".
      writeListViewMemory(MEMORY_KEY, { qs: '', scroll: 900 });
      const { rerender } = wrap(
        <TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />,
      );
      Object.defineProperty(window, 'scrollY', { value: 640, configurable: true });
      window.dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(SCROLL_PERSIST_DEBOUNCE_MS - 50);

      // The table collapses inside the debounce window and the browser clamps.
      snapState.current = { ...withRows, loading: true };
      rerender(
        <MantineTestProvider>
          <TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />
        </MantineTestProvider>,
      );
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
      await vi.advanceTimersByTimeAsync(SCROLL_PERSIST_DEBOUNCE_MS + 20);
      expect(readListViewMemory(MEMORY_KEY)?.scroll).toBe(640);

      snapState.current = withRows;
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it('ignores the browser clamp that follows a collapsed table', async () => {
      // Whenever the table is swapped for skeletons the document collapses
      // below the operator's offset and the browser clamps `scrollY` — which
      // fires a REAL scroll event. Persisting that would overwrite the
      // remembered position with 0, and the one-shot restore latch is long
      // since burned, so the offset is gone for good. A scroll event arriving
      // while there is no table on screen is never the operator moving.
      vi.useFakeTimers();
      vi.stubGlobal('scrollTo', vi.fn());
      const withRows = snapState.current;
      const { rerender } = wrap(
        <TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />,
      );
      Object.defineProperty(window, 'scrollY', { value: 640, configurable: true });
      window.dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(SCROLL_PERSIST_DEBOUNCE_MS + 20);
      expect(readListViewMemory(MEMORY_KEY)?.scroll).toBe(640);

      snapState.current = { ...withRows, loading: true };
      rerender(
        <MantineTestProvider>
          <TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />
        </MantineTestProvider>,
      );
      Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
      window.dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(SCROLL_PERSIST_DEBOUNCE_MS + 20);
      expect(readListViewMemory(MEMORY_KEY)?.scroll).toBe(640);

      snapState.current = withRows;
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
      writeListViewMemory(MEMORY_KEY, { qs: '', scroll: 840 });
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
      writeListViewMemory(MEMORY_KEY, { qs: '', scroll: 840 });
      const { unmount } = wrap(
        <TableView schema={testSchema} collection={fakeCollection()} db={{} as never} />,
      );
      unmount();
      expect(readListViewMemory(MEMORY_KEY)?.scroll).toBe(840);
      vi.unstubAllGlobals();
    });

    it('still collapses the window when the filter changes afterwards', () => {
      writeListViewMemory(MEMORY_KEY, { qs: 'pages=2', scroll: 0 });
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
      writeListViewMemory(MEMORY_KEY, { qs: '', scroll: 840 });
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
      writeListViewMemory(MEMORY_KEY, { qs: '', scroll: 840 });
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
      writeListViewMemory(MEMORY_KEY, { qs: '', scroll: 840 });
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

  describe('"Carregar mais"', () => {
    // The widened read, as the real hooks report it: `data` is KEPT and
    // `loading` flips (usePipelineSnapshot.ts:31 and useSnapshot.ts:133 both do
    // exactly this). The shared stub cannot express that — and over a hundred
    // cases rely on it never reporting `loading` — so these cases drive it by
    // hand and put it back afterwards.
    const settled = snapState.current;
    afterEach(() => {
      snapState.current = settled;
    });

    function beginRefetch() {
      snapState.current = { ...snapState.current, loading: true };
    }
    function settle(rows: number) {
      snapState.current = {
        data: Array.from({ length: rows }, (_, i) => ({
          id: String(i + 1),
          path: `x/${i + 1}`,
          data: { nome: `Row ${i + 1}`, tipo: '0' },
        })),
        loading: false,
        error: undefined,
      };
    }
    const table = (pageSize: number) => (
      <MantineTestProvider>
        <TableView
          schema={testSchema}
          collection={fakeCollection()}
          db={{} as never}
          pageSize={pageSize}
        />
      </MantineTestProvider>
    );

    it('keeps the loaded rows on screen while the wider read is in flight', () => {
      // The reported bug. The WINDOW is the scroller, so swapping the table for
      // three skeletons collapses the document below the operator's offset and
      // the browser clamps `scrollY` to 0 — the list jumps to the top on every
      // click. Keeping the rows mounted removes the height change that starts it.
      //
      // ⚠️ The order is load-bearing: `loading` must flip AFTER the click, which
      // is the sequence the real hook produces. Flipping it first passes even
      // when the mechanism is dead.
      const view = render(table(2));
      fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
      beginRefetch();
      view.rerender(table(2));
      expect(screen.queryByRole('table')).not.toBeNull();
      expect(screen.getByText('Alice')).toBeTruthy();
    });

    it('still shows skeletons when the FILTER changes, not just any refetch', () => {
      // The near miss. Rows that no longer match the chips above them would be
      // actively misleading, so the previous window may only survive a re-read
      // that WIDENS it. Without this pair the case above only proves the rows
      // are kept, never that they stop being kept.
      const view = render(table(2));
      fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
      settle(4);
      view.rerender(table(2));

      fireEvent.click(screen.getByRole('button', { name: 'Filtrar Nome' }));
      fireEvent.change(screen.getByLabelText('Nome contém'), { target: { value: 'ana' } });
      fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
      beginRefetch();
      view.rerender(table(2));
      expect(screen.queryByRole('table')).toBeNull();
    });

    it('still shows skeletons when the SORT changes', () => {
      const view = render(table(2));
      fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
      settle(4);
      view.rerender(table(2));

      fireEvent.click(screen.getByText('Nome'));
      beginRefetch();
      view.rerender(table(2));
      expect(screen.queryByRole('table')).toBeNull();
    });

    it('keeps the button in place, loading, instead of letting it vanish', () => {
      // During a growth the rows on screen are the PREVIOUS window, so their
      // count no longer equals the widened limit and the fullness test goes
      // false. Left at that the footer disappears mid-click and the page jumps
      // under the cursor — the very shift this change exists to remove.
      const view = render(table(2));
      fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
      // ⚠️ Asserted BEFORE `beginRefetch()`, and that order is the whole
      // point. `snap.loading` lags `pages` by one commit, so THIS is the render
      // where the fullness test has already gone false and nothing has replaced
      // it yet — the commit the footer used to disappear on. Skipping straight
      // to the loading commit hides the gap entirely.
      const onClickRender = screen.queryByRole('button', { name: 'Carregar mais' });
      expect(onClickRender).not.toBeNull();
      expect(onClickRender?.hasAttribute('data-loading')).toBe(true);

      beginRefetch();
      view.rerender(table(2));
      expect(
        screen.getByRole('button', { name: 'Carregar mais' }).hasAttribute('data-loading'),
      ).toBe(true);
    });

    it('mirrors the window to ?pages= so browser Back can give it back', () => {
      const replaceState = vi.spyOn(window.history, 'replaceState');
      render(table(2));
      fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
      expect(replaceState).toHaveBeenLastCalledWith(null, '', '/clientes?pages=2');
      replaceState.mockRestore();
    });

    it('drops ?pages= again when the query shape changes', () => {
      // The window described the result set the operator was looking at and is
      // meaningless against a different one — and a stale `pages=4` left in the
      // URL is paid for again on the next reload.
      const replaceState = vi.spyOn(window.history, 'replaceState');
      render(table(2));
      fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
      fireEvent.click(screen.getByRole('button', { name: 'Filtrar Nome' }));
      fireEvent.change(screen.getByLabelText('Nome contém'), { target: { value: 'ana' } });
      fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
      expect(replaceState).toHaveBeenLastCalledWith(null, '', '/clientes?nome=contains%3Aana');
      replaceState.mockRestore();
    });

    it('issues a window arriving in the URL as ONE query', () => {
      // A default page followed by a wider re-read would spend a full page of
      // scanned data before correcting itself, on a database that bills it.
      searchParamsRef.current = new URLSearchParams('pages=3');
      buildPipelineSpy.mockClear();
      render(table(2));
      const limits = buildPipelineSpy.mock.calls.map(
        (call) => (call as unknown as [unknown, { limit: number }])[1].limit,
      );
      expect(limits).toEqual([6]);
    });

    it('clamps a hand-edited window to the ceiling', () => {
      // `?pages=` is a cost lever anyone can type, and this database bills data
      // scanned.
      searchParamsRef.current = new URLSearchParams('pages=999');
      buildPipelineSpy.mockClear();
      render(table(2));
      expect(buildPipelineSpy).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ limit: 2 * MAX_PAGES }),
      );
    });

    it('says so at the ceiling instead of quietly dropping the button', () => {
      // A limit the operator cannot see is indistinguishable from a list that
      // ended, which is how they would conclude the missing rows do not exist.
      settle(MAX_PAGES);
      searchParamsRef.current = new URLSearchParams(`pages=${MAX_PAGES}`);
      render(table(1));
      expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
      expect(screen.getByText(/Limite de carregamento atingido/)).toBeTruthy();
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
      writeListViewMemory(MEMORY_KEY, { qs: 'q=camiseta', scroll: 0 });
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

        // ⚠️ Wait for the notice rather than assuming it. It only exists once
        // the term has RESOLVED: while the resolution is in flight the pipeline
        // is withheld, so the list is momentarily on the classic transport,
        // where there is no frozen result to be stale about and TableView
        // switches the monitor off. Reaching for the button on the call count
        // alone lands in exactly that window.
        const refresh = await vi.waitFor(() =>
          screen.getByRole('button', { name: 'Página desatualizada — atualizar' }),
        );
        expect(screen.getByText('Resultado fixo')).toBeDefined();
        fireEvent.click(refresh);
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
});
