import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

import { ColumnPicker, type ColumnPickerItem } from './ColumnPicker';

function wrap(node: React.ReactNode) {
  // `env="test"` disables Mantine transitions / portals so the Popover
  // dropdown renders synchronously after the trigger click.
  return render(<MantineProvider env="test">{node}</MantineProvider>);
}

/** Build `n` fields labelled `Campo 01`..`Campo NN`. */
function makeFields(n: number): ColumnPickerItem[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `c${i + 1}`,
    label: `Campo ${String(i + 1).padStart(2, '0')}`,
  }));
}

function openPicker() {
  fireEvent.click(screen.getByRole('button', { name: 'Configurar colunas' }));
}

/** Open the picker, then switch it into reorder mode. */
function openReorder() {
  openPicker();
  fireEvent.click(screen.getByRole('button', { name: 'Reordenar colunas' }));
}

describe('ColumnPicker', () => {
  it('hides the search box when at or below the 7-column threshold', () => {
    wrap(
      <ColumnPicker
        fields={makeFields(7)}
        visibleKeys={new Set()}
        onToggle={vi.fn()}
        order={[]}
        onReorder={vi.fn()}
      />,
    );
    openPicker();
    expect(screen.queryByRole('textbox', { name: 'Buscar coluna' })).toBeNull();
  });

  it('shows the search box once there are more than 7 columns', () => {
    wrap(
      <ColumnPicker
        fields={makeFields(8)}
        visibleKeys={new Set()}
        onToggle={vi.fn()}
        order={[]}
        onReorder={vi.fn()}
      />,
    );
    openPicker();
    expect(
      screen.getByRole('textbox', { name: 'Buscar coluna' }),
    ).toBeTruthy();
  });

  it('filters the checkbox list by label as the user types', () => {
    const fields: ColumnPickerItem[] = [
      ...makeFields(7),
      { key: 'nf', label: 'Nota Fiscal' },
    ];
    wrap(
      <ColumnPicker
        fields={fields}
        visibleKeys={new Set()}
        onToggle={vi.fn()}
        order={[]}
        onReorder={vi.fn()}
      />,
    );
    openPicker();
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar coluna' }), {
      target: { value: 'nota' },
    });
    // The matching column survives; the non-matching ones are filtered out.
    expect(screen.getByRole('checkbox', { name: 'Nota Fiscal' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Campo 01' })).toBeNull();
  });

  it('shows an empty message when the query matches nothing', () => {
    wrap(
      <ColumnPicker
        fields={makeFields(8)}
        visibleKeys={new Set()}
        onToggle={vi.fn()}
        order={[]}
        onReorder={vi.fn()}
      />,
    );
    openPicker();
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar coluna' }), {
      target: { value: 'inexistente' },
    });
    expect(screen.getByText('Nenhuma coluna encontrada.')).toBeTruthy();
  });

  it('toggling a checkbox still calls onToggle with the column key', () => {
    const onToggle = vi.fn();
    const fields: ColumnPickerItem[] = [
      ...makeFields(7),
      { key: 'nf', label: 'Nota Fiscal' },
    ];
    wrap(
      <ColumnPicker
        fields={fields}
        visibleKeys={new Set()}
        onToggle={onToggle}
        order={[]}
        onReorder={vi.fn()}
      />,
    );
    openPicker();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nota Fiscal' }));
    expect(onToggle).toHaveBeenCalledWith('nf');
  });

  it('disables the reorder button with fewer than two visible columns', () => {
    wrap(
      <ColumnPicker
        fields={makeFields(3)}
        visibleKeys={new Set(['c1'])}
        onToggle={vi.fn()}
        order={['c1']}
        onReorder={vi.fn()}
      />,
    );
    openPicker();
    expect(
      screen.getByRole('button', { name: 'Reordenar colunas' }),
    ).toHaveProperty('disabled', true);
  });

  it('reorder mode lists only the visible columns', () => {
    wrap(
      <ColumnPicker
        fields={makeFields(3)}
        visibleKeys={new Set(['c1', 'c3'])}
        onToggle={vi.fn()}
        order={['c1', 'c3']}
        onReorder={vi.fn()}
      />,
    );
    openReorder();
    // The two visible columns appear as draggable rows; the hidden one
    // (Campo 02) does not.
    expect(screen.getByRole('button', { name: 'Arrastar Campo 01' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Arrastar Campo 03' })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Arrastar Campo 02' }),
    ).toBeNull();
  });

  it('the down arrow reorders and calls onReorder with the new order', () => {
    const onReorder = vi.fn();
    wrap(
      <ColumnPicker
        fields={makeFields(3)}
        visibleKeys={new Set(['c1', 'c2', 'c3'])}
        onToggle={vi.fn()}
        order={['c1', 'c2', 'c3']}
        onReorder={onReorder}
      />,
    );
    openReorder();
    fireEvent.click(
      screen.getByRole('button', { name: 'Mover Campo 01 para baixo' }),
    );
    expect(onReorder).toHaveBeenCalledWith(['c2', 'c1', 'c3']);
  });

  it('disables the up arrow on the first row and the down arrow on the last', () => {
    wrap(
      <ColumnPicker
        fields={makeFields(2)}
        visibleKeys={new Set(['c1', 'c2'])}
        onToggle={vi.fn()}
        order={['c1', 'c2']}
        onReorder={vi.fn()}
      />,
    );
    openReorder();
    expect(
      screen.getByRole('button', { name: 'Mover Campo 01 para cima' }),
    ).toHaveProperty('disabled', true);
    expect(
      screen.getByRole('button', { name: 'Mover Campo 02 para baixo' }),
    ).toHaveProperty('disabled', true);
  });

  it('the back button returns from reorder mode to the checkbox list', () => {
    wrap(
      <ColumnPicker
        fields={makeFields(3)}
        visibleKeys={new Set(['c1', 'c2'])}
        onToggle={vi.fn()}
        order={['c1', 'c2']}
        onReorder={vi.fn()}
      />,
    );
    openReorder();
    expect(screen.getByText('Reordenar colunas')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    // Back in visibility mode: the checkboxes are shown again.
    expect(screen.getByRole('checkbox', { name: 'Campo 03' })).toBeTruthy();
  });
});
