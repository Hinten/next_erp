import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ColumnFilterValue } from '@delfrance/ui';
import { MantineTestProvider } from '@/lib/testing/mantine';

// `CollectionSelect` owns a live Firestore query and a recents cache; neither is
// under test here. The stub keeps its contract — it emits the full
// `documents/<col>/<id>` doc-path string — because that string IS the where
// clause, so a stub emitting a bare id would make the test agree with a
// component that filters nothing.
vi.mock('@/components/collection-select/CollectionSelect', () => ({
  CollectionSelect: ({ label, onChange }: { label: string; onChange: (next: unknown) => void }) => (
    <button type="button" onClick={() => onChange('documents/clientes/cli-1')}>
      {label}
    </button>
  ),
}));

vi.mock('@/lib/data/clienteCollection', () => ({ clienteCollection: {} }));

// Import AFTER the mocks are registered.
import { ClienteColumnFilter, formatClienteFilterValue } from './ClienteColumnFilter';

/** The SegmentedControl renders a radio input per segment; read its state directly. */
function segmentChecked(name: string): boolean {
  return (screen.getByRole('radio', { name }) as HTMLInputElement).checked;
}

function renderFilter(value?: ColumnFilterValue) {
  const onChange = vi.fn<(next: ColumnFilterValue | undefined) => void>();
  render(
    <MantineTestProvider>
      <ClienteColumnFilter value={value} onChange={onChange} />
    </MantineTestProvider>,
  );
  return onChange;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('ClienteColumnFilter', () => {
  it('opens on the Cliente segment and emits an eq on the stored doc path', () => {
    const onChange = renderFilter();
    expect(segmentChecked('Cliente')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Filtrar por cliente' }));
    expect(onChange).toHaveBeenCalledWith({ op: 'eq', value: 'documents/clientes/cli-1' });
  });

  it('emits isNull when Anônimo is picked', () => {
    // The op, not `{op:'eq', value:null}` — see `isNullFilter.test.ts` for why
    // the value alone cannot survive the URL.
    const onChange = renderFilter();
    fireEvent.click(screen.getByRole('radio', { name: 'Anônimo' }));
    expect(onChange).toHaveBeenCalledWith({ op: 'isNull', value: null });
  });

  it('clears the filter when switching back to Cliente with nothing picked', () => {
    const onChange = renderFilter({ op: 'isNull', value: null });
    fireEvent.click(screen.getByRole('radio', { name: 'Cliente' }));
    // "Cliente, no pick" honestly means no filter — not a filter on nothing.
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('reopens on Anônimo for a hydrated URL / restored sticky filter', () => {
    // The mode is seeded once from the incoming value. Get this wrong and a
    // reload shows the rows filtered while the control claims otherwise.
    renderFilter({ op: 'isNull', value: null });
    expect(segmentChecked('Anônimo')).toBe(true);
  });

  it('Limpar drops the filter and returns to the Cliente segment', () => {
    const onChange = renderFilter({ op: 'isNull', value: null });
    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
    expect(segmentChecked('Cliente')).toBe(true);
  });
});

describe('formatClienteFilterValue', () => {
  it('names the empty state the way the cell does', () => {
    // `ClienteCell` renders the literal "Anônimo" for a null ref. A chip saying
    // anything else would describe the same rows with a second vocabulary.
    expect(formatClienteFilterValue(null)).toBe('Anônimo');
  });

  it('degrades a specific cliente to its bare id, never the stored path', () => {
    expect(formatClienteFilterValue('documents/clientes/cli-1')).toBe('cli-1');
  });

  it('keeps a value it cannot split verbatim rather than mangling it', () => {
    expect(formatClienteFilterValue('cli-1')).toBe('cli-1');
  });

  it('never folds the null filter onto a cliente whose id is the word "null"', () => {
    // The near-miss: an id is a string and could be anything. Discriminating on
    // `value === null` — the type, not the text — is what keeps them apart.
    expect(formatClienteFilterValue('documents/clientes/null')).toBe('null');
    expect(formatClienteFilterValue(null)).not.toBe(
      formatClienteFilterValue('documents/clientes/null'),
    );
  });
});
