import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CST_PIS_COFINS } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { PisCofinsSection } from './PisCofinsSection';
import type { ImpostoConfigValue } from './types';

/**
 * A CONTROLLED harness (it hands what `onChange` emits straight back as
 * `value`), so a keystroke's re-render is what the assertions see — the
 * DecimalInput suite's rule. `spy` records every emission.
 */
function Harness({
  initial,
  errosPorCampo,
  spy,
}: {
  initial: ImpostoConfigValue;
  errosPorCampo?: ReadonlyMap<string, string>;
  spy?: (next: ImpostoConfigValue) => void;
}) {
  const [value, setValue] = useState<ImpostoConfigValue>(initial);
  return (
    <MantineTestProvider>
      <PisCofinsSection
        value={value}
        onChange={(next) => {
          spy?.(next);
          setValue(next);
        }}
        errosPorCampo={errosPorCampo}
      />
      <output data-testid="pis">{JSON.stringify(value.configuracaoPIS ?? null)}</output>
    </MantineTestProvider>
  );
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

const ALIQUOTAS_DO_WIRE = [
  'Alíquota do PIS (%)',
  'Alíquota do PIS por unidade (R$)',
  'Alíquota da COFINS (%)',
  'Alíquota da COFINS por unidade (R$)',
];

/** Every wire rate/quantity set to 6 decimals — more than the wire's 4. */
const SEIS_CASAS: ImpostoConfigValue = {
  configuracaoPIS: {
    CST: CST_PIS_COFINS.outrasOperacoesSaida,
    pPIS: 1.654321,
    vAliqProd: 1.654321,
  },
  configuracaoCOFINS: {
    CST: CST_PIS_COFINS.outrasOperacoesSaida,
    pCOFINS: 1.654321,
    vAliqProd: 1.654321,
  },
  configuracaoPISST: { compoeTotalNota: false, pPIS: 1.654321, vAliqProd: null },
};

describe('PisCofinsSection — the wire precision (TDec_0302a04 / TDec_1104v: 4 decimals)', () => {
  it.each(ALIQUOTAS_DO_WIRE)('%s shows a stored 6-decimal value at 4 decimals', (label) => {
    render(<Harness initial={SEIS_CASAS} />);
    expect(input(label).value).toBe('1,6543');
  });

  it('PIS-ST, which is never emitted, keeps 6 decimals (near-miss)', () => {
    render(<Harness initial={SEIS_CASAS} />);
    expect(input('Alíquota do PIS ST (%)').value).toBe('1,654321');
  });

  it('does not accept a fifth decimal while typing', () => {
    const initial: ImpostoConfigValue = {
      configuracaoPIS: { CST: CST_PIS_COFINS.tributavelAliquotaBasica, pPIS: null },
    };
    render(<Harness initial={initial} />);
    const pPIS = input('Alíquota do PIS (%)');
    fireEvent.change(pPIS, { target: { value: '1,65432' } });
    expect(pPIS.value).toBe('1,6543');
    expect(JSON.parse(screen.getByTestId('pis').textContent ?? 'null')).toMatchObject({
      pPIS: 1.6543,
    });
  });

  it('never rewrites a stored value it only displays rounded: mount, focus and blur emit nothing', () => {
    const spy = vi.fn();
    render(<Harness initial={SEIS_CASAS} spy={spy} />);
    for (const label of ALIQUOTAS_DO_WIRE) {
      const el = input(label);
      fireEvent.focus(el);
      fireEvent.focusOut(el);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('PisCofinsSection — inline problems (#1655)', () => {
  const ambas: ImpostoConfigValue = {
    configuracaoPIS: { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0.65, vAliqProd: 0.1 },
    configuracaoCOFINS: { CST: CST_PIS_COFINS.outrasOperacoesSaida, pCOFINS: 3, vAliqProd: null },
  };
  const msg =
    'PIS (CST 49): preencha só a alíquota (%) ou só a alíquota por unidade (R$), não as duas.';

  it('flags each field a problem names, and only those', () => {
    const errosPorCampo = new Map([
      ['configuracaoPIS.pPIS', msg],
      ['configuracaoPIS.vAliqProd', msg],
    ]);
    render(<Harness initial={ambas} errosPorCampo={errosPorCampo} />);
    expect(input('Alíquota do PIS (%)').getAttribute('aria-invalid')).toBe('true');
    expect(input('Alíquota do PIS por unidade (R$)').getAttribute('aria-invalid')).toBe('true');
    expect(input('Alíquota da COFINS (%)').getAttribute('aria-invalid')).not.toBe('true');
    expect(screen.getAllByText(msg)).toHaveLength(2);
  });

  it('flags nothing without problems', () => {
    render(<Harness initial={ambas} />);
    for (const label of ALIQUOTAS_DO_WIRE) {
      expect(input(label).getAttribute('aria-invalid')).not.toBe('true');
    }
  });
});
