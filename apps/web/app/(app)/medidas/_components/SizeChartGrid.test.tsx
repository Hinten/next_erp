import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';

import type { ChartRowDraft } from '@/lib/mercado-livre/chartRows';
import type { ChartColumn } from '@/lib/mercado-livre/chartSpec';
import { SizeChartGrid } from './SizeChartGrid';

const columns: ChartColumn[] = [
  {
    key: 'SIZE',
    label: 'Tamanho',
    hint: null,
    required: true,
    mainCandidate: true,
    sizeEquivalence: false,
    unit: { default: null, options: [] },
    connector: null,
    parts: [{ attributeId: 'SIZE', label: 'Tamanho', kind: 'text', values: [] }],
  },
  {
    key: 'CHEST',
    label: 'Largura do peito da roupa',
    hint: null,
    required: false,
    mainCandidate: false,
    sizeEquivalence: false,
    unit: { default: 'cm', options: [] },
    connector: null,
    parts: [{ attributeId: 'CHEST', label: 'Peito', kind: 'number', values: [] }],
  },
];

const preenchido = (value_name: string) => ({ value_id: null, value_name, valueList: null });

const rows: ChartRowDraft[] = [
  {
    key: 'g/1/v/p',
    varianteUid: null,
    id: null,
    cells: { SIZE: preenchido('P') },
    deleted: false,
  },
];

function show(onCellChange = vi.fn(), linhas: ChartRowDraft[] = rows) {
  render(
    <MantineTestProvider>
      <SizeChartGrid
        columns={columns}
        rows={linhas}
        units={{ SIZE: null, CHEST: 'cm' }}
        cellErrors={new Map()}
        mainAttributeId="SIZE"
        sent={false}
        disabled={false}
        onCellChange={onCellChange}
        onUnitChange={vi.fn()}
        onToggleDelete={vi.fn()}
      />
    </MantineTestProvider>,
  );
  return onCellChange;
}

/**
 * ⚠️ The cells stay plain `TextInput`s, NOT `DecimalInput`: Mercado Livre stores
 * a measurement as a STRING and echoes it back verbatim on the anúncio, so a
 * widget that parses to `number | null` would erase `10,50` into `10,5`. What
 * IS normalised is the separator, because a grid showing `10.5` on one row and
 * `10,5` on the next is the state this repo had before the AI fill localised
 * its own answers.
 */
describe('SizeChartGrid — the decimal separator', () => {
  it('localizes a dot typed into a measurement cell', () => {
    const onCellChange = show();

    fireEvent.change(screen.getByLabelText('Peito (linha 1)'), { target: { value: '10.5' } });

    expect(onCellChange).toHaveBeenCalledWith(0, 'CHEST', {
      value_id: null,
      value_name: '10,5',
      valueList: null,
    });
  });

  it('leaves a partially typed decimal alone', () => {
    // `'10.'` is mid-keystroke, not a decimal yet — rewriting it would fight
    // the operator on the very next character.
    const onCellChange = show();

    fireEvent.change(screen.getByLabelText('Peito (linha 1)'), { target: { value: '10.' } });

    expect(onCellChange).toHaveBeenCalledWith(0, 'CHEST', {
      value_id: null,
      value_name: '10.',
      valueList: null,
    });
  });

  it('does NOT localize a dot in a free-text cell', () => {
    // ANTI-VACUITY: the rule is scoped to `kind === 'number'`, and a size label
    // like `Tam. 1.5` is a name, not a measurement.
    const onCellChange = show();

    fireEvent.change(screen.getByLabelText('Tamanho (linha 1)'), {
      target: { value: 'Tam. 1.5' },
    });

    expect(onCellChange).toHaveBeenCalledWith(0, 'SIZE', {
      value_id: null,
      value_name: 'Tam. 1.5',
      valueList: null,
    });
  });

  it('clears the cell to null rather than an empty string', () => {
    const preenchida: ChartRowDraft[] = [
      { ...rows[0]!, cells: { ...rows[0]!.cells, CHEST: preenchido('52') } },
    ];
    const onCellChange = show(vi.fn(), preenchida);

    fireEvent.change(screen.getByLabelText('Peito (linha 1)'), { target: { value: '' } });

    expect(onCellChange).toHaveBeenCalledWith(0, 'CHEST', {
      value_id: null,
      value_name: null,
      valueList: null,
    });
  });
});
