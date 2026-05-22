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

describe('ColumnPicker', () => {
  it('hides the search box when at or below the 7-column threshold', () => {
    wrap(
      <ColumnPicker
        fields={makeFields(7)}
        visibleKeys={new Set()}
        onToggle={vi.fn()}
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
      <ColumnPicker fields={fields} visibleKeys={new Set()} onToggle={vi.fn()} />,
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
      <ColumnPicker fields={fields} visibleKeys={new Set()} onToggle={onToggle} />,
    );
    openPicker();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nota Fiscal' }));
    expect(onToggle).toHaveBeenCalledWith('nf');
  });
});
