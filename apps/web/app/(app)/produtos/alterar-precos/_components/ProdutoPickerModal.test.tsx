import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { Produto } from '@delfrance/schemas';

// jsdom has no real Firestore — mock the live-query layer so the component
// renders a fixed set of rows regardless of the query it builds. `useSnapshot`
// is the seam: what it's called WITH (the query) is exercised by the app
// against real staging Firestore, not here (same split AlteracoesTable.test.tsx
// draws for its virtualizer seam).
const { useSnapshotMock, notifShow } = vi.hoisted(() => ({
  useSnapshotMock: vi.fn(),
  notifShow: vi.fn(),
}));

vi.mock('@delfrance/data/hooks', () => ({ useSnapshot: useSnapshotMock }));
// The query builders record what they were given, so a test can read the
// window (`limit`) and the search term (`where`) off the query each render
// handed `useSnapshot`.
vi.mock('@delfrance/data', () => ({
  buildQuery: (_base: unknown, constraints: unknown[]) => ({ constraints }),
  whereEqual: () => ({}),
  whereOp: (field: string, op: string, value: unknown) => ({ where: [field, op, value] }),
  orderByField: () => ({}),
  limit: (n: number) => ({ limit: n }),
}));
vi.mock('firebase/firestore', () => ({ getDocs: vi.fn(), startAfter: vi.fn() }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: notifShow } }));
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
vi.mock('@/lib/data/produtoCollection', () => ({ produtoCollection: { ref: () => ({}) } }));

// Import AFTER the mocks are registered.
import { ProdutoPickerModal } from './ProdutoPickerModal';

function produto(over: Partial<Produto> = {}): Produto {
  return {
    nome: 'Produto',
    sku: null,
    custo: 10,
    precos: {},
    paiId: null,
    categoriaProdutoOuterRef: null,
    pesoBrutoKg: null,
    pesoLiquidoKg: null,
    ehKit: false,
    componentesKit: null,
    ...over,
  } as Produto;
}

function row(id: string, over: Partial<Produto> = {}) {
  return {
    id,
    path: `produtos/${id}`,
    data: produto({ nome: `Produto ${id}`, sku: `SKU-${id}`, ...over }),
  };
}

function renderModal(onInclude = vi.fn(), onClose = vi.fn()) {
  render(
    <MantineTestProvider>
      <ProdutoPickerModal opened onClose={onClose} onInclude={onInclude} />
    </MantineTestProvider>,
  );
  return { onInclude, onClose };
}

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * jest-dom matchers are NOT registered in this app's vitest setup
 * (vitest.setup.ts imports only @testing-library/react cleanup), so checkbox
 * state is asserted via the DOM property directly.
 */
function isChecked(el: HTMLElement): boolean {
  return (el as HTMLInputElement).checked;
}

type RecordedQuery = {
  constraints: Array<{ limit?: number; where?: [string, string, unknown] }>;
} | null;

/** Every query `useSnapshot` was rendered with, in order. */
function snapshotQueries(): RecordedQuery[] {
  return useSnapshotMock.mock.calls.map((call) => call[0] as RecordedQuery);
}

function limitOf(q: RecordedQuery): number | undefined {
  return q?.constraints.find((c) => c.limit !== undefined)?.limit;
}

function searchesFor(q: RecordedQuery, term: string): boolean {
  return q?.constraints.some((c) => c.where?.[2] === term) ?? false;
}

describe('ProdutoPickerModal', () => {
  it('a new search never opens its listener at the previous search’s widened window', () => {
    // The window reset used to run in an effect AFTER the render that built the
    // new query, so the first listener for a new term opened at the OLD widened
    // limit and only then shrank: an extra billed listener per search change.
    useSnapshotMock.mockReturnValue({
      data: Array.from({ length: 50 }, (_, i) => row(`p${i}`)),
      loading: false,
      error: undefined,
    });
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    // Anti-vacuity: the window really did widen before the search changed.
    expect(limitOf(snapshotQueries().at(-1) ?? null)).toBe(100);

    useSnapshotMock.mockClear();
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar' }), {
      target: { value: 'novo' },
    });

    const limits = snapshotQueries()
      .filter((q) => searchesFor(q, 'novo'))
      .map(limitOf);
    expect(limits.length).toBeGreaterThan(0);
    expect(limits).toEqual(limits.map(() => 50));
  });

  it('clears the selection when the search term or the search field changes', () => {
    useSnapshotMock.mockReturnValue({
      data: [row('a'), row('b')],
      loading: false,
      error: undefined,
    });
    renderModal();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar Produto a' }));
    expect(screen.getByText('1 selecionado(s)')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar' }), {
      target: { value: 'x' },
    });
    expect(screen.getByText('0 selecionado(s)')).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar Produto b' }));
    expect(screen.getByText('1 selecionado(s)')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'SKU' }));
    expect(screen.getByText('0 selecionado(s)')).toBeTruthy();
  });

  it('toggles a single row via its checkbox and includes only that row', () => {
    useSnapshotMock.mockReturnValue({
      data: [row('a'), row('b')],
      loading: false,
      error: undefined,
    });
    const { onInclude } = renderModal();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar Produto a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Incluir selecionados' }));

    expect(onInclude).toHaveBeenCalledTimes(1);
    expect(onInclude).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'a', nome: 'Produto a', sku: 'SKU-a', custo: 10 }),
    ]);
  });

  it('toggles a row by clicking anywhere on it, not just the checkbox', () => {
    useSnapshotMock.mockReturnValue({
      data: [row('a'), row('b')],
      loading: false,
      error: undefined,
    });
    renderModal();

    fireEvent.click(screen.getByText('Produto a'));

    expect(isChecked(screen.getByRole('checkbox', { name: 'Selecionar Produto a' }))).toBe(true);
    expect(isChecked(screen.getByRole('checkbox', { name: 'Selecionar Produto b' }))).toBe(false);
  });

  it('header checkbox selects every loaded row, and including clears the selection', () => {
    useSnapshotMock.mockReturnValue({
      data: [row('a'), row('b')],
      loading: false,
      error: undefined,
    });
    const { onInclude } = renderModal();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar todos os carregados' }));
    expect(isChecked(screen.getByRole('checkbox', { name: 'Selecionar Produto a' }))).toBe(true);
    expect(isChecked(screen.getByRole('checkbox', { name: 'Selecionar Produto b' }))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Incluir selecionados' }));
    expect(onInclude).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'a' }),
      expect.objectContaining({ id: 'b' }),
    ]);

    // Selection is cleared after inclusion — the header checkbox unchecks and
    // the "Incluir selecionados" button is disabled again (nothing selected).
    expect(
      isChecked(screen.getByRole('checkbox', { name: 'Selecionar todos os carregados' })),
    ).toBe(false);
    expect(screen.getByRole('button', { name: 'Incluir selecionados' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('clicking the header checkbox again deselects every loaded row', () => {
    useSnapshotMock.mockReturnValue({
      data: [row('a'), row('b')],
      loading: false,
      error: undefined,
    });
    renderModal();

    const header = screen.getByRole('checkbox', { name: 'Selecionar todos os carregados' });
    fireEvent.click(header);
    fireEvent.click(header);

    expect(isChecked(screen.getByRole('checkbox', { name: 'Selecionar Produto a' }))).toBe(false);
    expect(isChecked(screen.getByRole('checkbox', { name: 'Selecionar Produto b' }))).toBe(false);
  });

  it('does not dedupe repeated inclusion of the same row — dedup is the parent’s job', () => {
    useSnapshotMock.mockReturnValue({
      data: [row('a'), row('b')],
      loading: false,
      error: undefined,
    });
    const { onInclude } = renderModal();

    // Select + include "a" once…
    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar Produto a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Incluir selecionados' }));
    // …then select + include it again. The component has no memory of what
    // it already emitted — it just re-emits whatever is currently checked.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar Produto a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Incluir selecionados' }));

    expect(onInclude).toHaveBeenCalledTimes(2);
    expect(onInclude).toHaveBeenNthCalledWith(1, [expect.objectContaining({ id: 'a' })]);
    expect(onInclude).toHaveBeenNthCalledWith(2, [expect.objectContaining({ id: 'a' })]);
  });

  it('shows a dash for a null sku and null custo', () => {
    useSnapshotMock.mockReturnValue({
      data: [row('a', { sku: null, custo: null })],
      loading: false,
      error: undefined,
    });
    renderModal();

    const cells = screen.getAllByRole('cell');
    const text = cells.map((c) => c.textContent).join('|');
    expect(text).toContain('—');
  });

  it('shows an empty message when there are no rows', () => {
    useSnapshotMock.mockReturnValue({ data: [], loading: false, error: undefined });
    renderModal();
    expect(screen.getByText('Nenhum produto encontrado.')).toBeTruthy();
  });
});
