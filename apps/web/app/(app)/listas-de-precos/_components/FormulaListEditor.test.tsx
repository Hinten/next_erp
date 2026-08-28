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

describe('FormulaListEditor — coefficient precision (4 decimals)', () => {
  // The regression test for the reported bug: a 16,5% marketplace commission
  // is 0,165, untypeable while decimalScale was 2. Fails at {2} with '0,16'.
  it('keeps the third decimal on a rate coefficient', () => {
    renderEditor();
    addFormula();
    const comissao = input('Comissão marketplace (M) 1');
    fireEvent.change(comissao, { target: { value: '0,165' } });
    expect(comissao.value).toBe('0,165');
  });

  // Real rates need a fourth digit too — Simples Nacional at 4,65% is 0,0465.
  // `/produtos/alterar-precos` renders these same coefficients at
  // decimalScale={4} (`RegraForm.tsx:156-209`); this keeps the two screens
  // from disagreeing about how precise a rate may be. Fails at {3} ('0,046').
  it('keeps the fourth decimal, matching the alterar-precos screen', () => {
    renderEditor();
    addFormula();
    const imposto = input('Imposto (I) 1');
    fireEvent.change(imposto, { target: { value: '0,0465' } });
    expect(imposto.value).toBe('0,0465');
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

describe('FormulaListEditor — weight-band bounds cap at 2 decimals', () => {
  // The engine rounds the product weight UP to 2 decimals before matching a
  // band (`taxaFixaPorPeso`), so a third digit here is inert and can make a
  // band unreachable. `faixaTaxaFixaPeso.test.ts` pins that reasoning against
  // the engine; this pins the input that follows from it. Fails at
  // decimalScale={3}, which keeps '0,499'.
  it('truncates a third decimal typed into Peso máx.', () => {
    renderEditor();
    addFormula();
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar faixa de peso' }));
    const pesoMax = input('Peso máximo 1 da fórmula 1');
    fireEvent.change(pesoMax, { target: { value: '0,499' } });
    expect(pesoMax.value).toBe('0,49');
  });
});

describe('FormulaListEditor — a stored 3-decimal bound shows its effective value', () => {
  /** Renders one formula row carrying a saved faixa, as a legacy doc would. */
  function renderComFaixa(faixa: Record<string, number>) {
    function HostComFaixa() {
      const [rows, setRows] = useState<unknown[]>([
        { limiar: 100, formula: 'C+T', faixasTaxaFixaPeso: [faixa] },
      ]);
      return (
        <MantineTestProvider>
          <FormulaListEditor label="Fórmulas de cálculo" value={rows} onChange={setRows} />
        </MantineTestProvider>
      );
    }
    render(<HostComFaixa />);
  }

  // Rendering 0.499 raw through decimalScale={2} ROUNDS it to "0,50" — a band
  // end a 0,50 kg product does not fall into. The snap shows 0,49, which is
  // what the engine actually compares against.
  it('floors the max bound instead of rounding it up', () => {
    renderComFaixa({ pesoMinKg: 0, pesoMaxKg: 0.499, taxaFixa: 5 });
    expect(input('Peso máximo 1 da fórmula 1').value).toBe('0,49');
  });

  // The min bound ceils, because the weight is rounded up: 0,251 admits
  // exactly what 0,26 admits, and showing 0,25 would overstate the band.
  it('ceils the min bound instead of truncating it', () => {
    renderComFaixa({ pesoMinKg: 0.251, pesoMaxKg: 2, taxaFixa: 5 });
    expect(input('Peso mínimo 1 da fórmula 1').value).toBe('0,26');
  });

  // Guards the float hazard in the snap: 1.15 * 100 is 114.99999999999999, so
  // a bare Math.floor would display 1,14 and shrink the band by a cent.
  it('does not shift a bound that is already on the grid', () => {
    renderComFaixa({ pesoMinKg: 0.29, pesoMaxKg: 1.15, taxaFixa: 5 });
    expect(input('Peso mínimo 1 da fórmula 1').value).toBe('0,29');
    expect(input('Peso máximo 1 da fórmula 1').value).toBe('1,15');
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
