import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { FormulaListEditor } from './FormulaListEditor';
import { FORMULA_PADRAO } from './formulaVariaveis';

/**
 * The editor is fully controlled, so a stateful host is needed for "click Add
 * and look at the resulting row" — the component never holds its own rows.
 */
function Host({ label }: { label?: string }) {
  const [rows, setRows] = useState<unknown[]>([]);
  return (
    <MantineTestProvider>
      <FormulaListEditor label={label} value={rows} onChange={setRows} />
    </MantineTestProvider>
  );
}

function renderEditor(label = 'Fórmulas de cálculo') {
  render(<Host label={label} />);
}

/**
 * A nested editor gets NO `label` prop at all. Passing `undefined` to
 * {@link renderEditor} would not do it: an explicit `undefined` argument still
 * triggers the default parameter, so the label would come back.
 */
function renderNestedEditor() {
  render(<Host />);
}

function addFormula() {
  fireEvent.click(screen.getByRole('button', { name: 'Adicionar fórmula' }));
}

function input(name: string): HTMLInputElement {
  return screen.getByLabelText(name) as HTMLInputElement;
}

describe('FormulaListEditor — a new row is pre-filled', () => {
  it('seeds the formula field with FORMULA_PADRAO', () => {
    renderEditor();
    addFormula();
    expect(input('Fórmula 1').value).toBe(FORMULA_PADRAO);
  });

  it('still leaves limiar at 0, so the operator is told to supply it', () => {
    renderEditor();
    addFormula();
    expect(input('Limiar 1').value).toBe('0');
  });
});

describe('FormulaListEditor — coefficient precision (3 decimals)', () => {
  // The regression test for the reported bug. Every coefficient in
  // `(1-(M+I+F+K))` is a RATE, so a 16,5% marketplace commission is 0,165 —
  // untypeable while decimalScale was 2, which truncated the third digit as
  // you typed. This assertion fails at decimalScale={2} (yielding '0,16').
  it('keeps the third decimal on a rate coefficient', () => {
    renderEditor();
    addFormula();
    const comissao = input('Comissão marketplace (M) 1');
    fireEvent.change(comissao, { target: { value: '0,165' } });
    expect(comissao.value).toBe('0,165');
  });

  it('labels each coefficient with the letter it stands for in the formula', () => {
    renderEditor();
    addFormula();
    for (const name of [
      'Taxa fixa (T) 1',
      'Custo fixo (c) 1',
      'Margem de lucro (L) 1',
      'Comissão marketplace (M) 1',
      'Imposto (I) 1',
      'Frete (F) 1',
      'Marketing (K) 1',
    ]) {
      expect(input(name)).toBeTruthy();
    }
  });
});

describe('FormulaListEditor — the variable legend', () => {
  it('renders once for a top-level editor', () => {
    renderEditor();
    expect(screen.getAllByText('Como montar a fórmula')).toHaveLength(1);
    expect(screen.getByText('Custo do produto')).toBeTruthy();
  });

  // A nested editor (one per categoria card) gets no `label`; the category tab
  // renders a single legend of its own, so repeating it here would print it
  // once per card.
  it('is omitted when the editor is nested inside a category card', () => {
    renderNestedEditor();
    expect(screen.queryByText('Como montar a fórmula')).toBeNull();
  });
});
