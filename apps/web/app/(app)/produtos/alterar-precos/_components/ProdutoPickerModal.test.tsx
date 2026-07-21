import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
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
vi.mock('@delfrance/data', () => ({
  buildQuery: (base: unknown) => base,
  whereEqual: () => ({}),
  whereOp: () => ({}),
  orderByField: () => ({}),
  limit: () => ({}),
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
    <MantineProvider>
      <ProdutoPickerModal opened onClose={onClose} onInclude={onInclude} />
    </MantineProvider>,
  );
  return { onInclude, onClose };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('ProdutoPickerModal', () => {
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

    expect(screen.getByRole('checkbox', { name: 'Selecionar Produto a' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Selecionar Produto b' })).not.toBeChecked();
  });

  it('header checkbox selects every loaded row, and including clears the selection', () => {
    useSnapshotMock.mockReturnValue({
      data: [row('a'), row('b')],
      loading: false,
      error: undefined,
    });
    const { onInclude } = renderModal();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Selecionar todos os carregados' }));
    expect(screen.getByRole('checkbox', { name: 'Selecionar Produto a' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Selecionar Produto b' })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Incluir selecionados' }));
    expect(onInclude).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'a' }),
      expect.objectContaining({ id: 'b' }),
    ]);

    // Selection is cleared after inclusion — the header checkbox unchecks and
    // the "Incluir selecionados" button is disabled again (nothing selected).
    expect(
      screen.getByRole('checkbox', { name: 'Selecionar todos os carregados' }),
    ).not.toBeChecked();
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

    expect(screen.getByRole('checkbox', { name: 'Selecionar Produto a' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Selecionar Produto b' })).not.toBeChecked();
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
