import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  CRT,
  CSOSN,
  CST,
  CST_PIS_COFINS,
  ORIGEM,
  problemasDeEmissaoDoImposto,
  type ProblemaDeEmissao,
} from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { ImpostoConfigEditor } from './ImpostoConfigEditor';
import type { ImpostoConfigValue } from './types';

const TITULO = 'A NF-e recusaria esta configuração';

function renderEditor(
  value: ImpostoConfigValue,
  problemas?: readonly ProblemaDeEmissao[],
  onChange: (next: ImpostoConfigValue) => void = vi.fn(),
) {
  return render(
    <MantineTestProvider>
      <ImpostoConfigEditor value={value} onChange={onChange} problemas={problemas} />
    </MantineTestProvider>,
  );
}

const invalido = (label: string) => screen.getByLabelText(label).getAttribute('aria-invalid');

/** CSOSN 500 with only `pST` of the ICMS-ST retido trio — the issue's shape. */
const PARCIAL_500: ImpostoConfigValue = {
  origem: ORIGEM.nacional,
  configuracaoICMS: {
    crt: CRT.simplesNacional,
    csosn: CSOSN.icmsCobradoAnteriormente,
    csosn500: { pST: 20 },
  },
};

describe('ImpostoConfigEditor — the problems the NF-e engine would raise (#1655)', () => {
  it('shows an orange Alert listing each message, and flags the fields inline', () => {
    const problemas = problemasDeEmissaoDoImposto(PARCIAL_500);
    expect(problemas).toHaveLength(1);
    renderEditor(PARCIAL_500, problemas);

    const alerta = screen.getByText(TITULO).closest('[role="alert"]');
    expect(alerta).not.toBeNull();
    expect(alerta?.textContent).toContain(problemas[0]?.mensagem);
    expect(invalido('vBCSTRet (R$)')).toBe('true');
    expect(invalido('vICMSSTRet (R$)')).toBe('true');
    // Near-miss: the member that IS filled is not the problem.
    expect(invalido('pST (%)')).not.toBe('true');
  });

  it('shows nothing without problems', () => {
    renderEditor(PARCIAL_500, []);
    expect(screen.queryByText(TITULO)).toBeNull();
    expect(invalido('vBCSTRet (R$)')).not.toBe('true');
  });

  it('flags the CSOSN select when the CSOSN has no sub-config', () => {
    const value: ImpostoConfigValue = {
      origem: ORIGEM.nacional,
      configuracaoICMS: { crt: CRT.simplesNacional, csosn: CSOSN.outros, csosn900: null },
    };
    renderEditor(value, problemasDeEmissaoDoImposto(value));
    expect(screen.getByRole('combobox', { name: 'CSOSN' }).getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(screen.getByText(TITULO)).toBeTruthy();
  });

  it('flags both PIS rates of a CST 49 config that carries both', () => {
    const value: ImpostoConfigValue = {
      origem: ORIGEM.nacional,
      configuracaoPIS: { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0.65, vAliqProd: 0.1 },
    };
    renderEditor(value, problemasDeEmissaoDoImposto(value));
    // The section starts collapsed (only ICMS opens by default); the Alert
    // above the accordion is what tells the operator to open it.
    fireEvent.click(screen.getByRole('button', { name: 'PIS / COFINS' }));
    expect(invalido('Alíquota do PIS (%)')).toBe('true');
    expect(invalido('Alíquota do PIS por unidade (R$)')).toBe('true');
  });

  it('renders a raw soft-read value without throwing (characterization)', () => {
    // parseSoftRead hands the RAW document back when the schema fails, and the
    // hosts spread it into the editor as-is.
    const raw = {
      configuracaoICMS: { crt: 1, csosn: '999', csosn500: 'x' },
      configuracaoPIS: { CST: 49 },
    } as unknown as ImpostoConfigValue;
    const problemas = problemasDeEmissaoDoImposto(raw);
    expect(problemas).toEqual([]);
    expect(() => renderEditor(raw, problemas)).not.toThrow();
    expect(screen.queryByText(TITULO)).toBeNull();
  });

  it('renders an off-enum CSOSN under a Simples Nacional CRT with no sub-config grid', () => {
    const raw = {
      configuracaoICMS: { crt: CRT.simplesNacional, csosn: '999', csosn500: { pST: 20 } },
    } as unknown as ImpostoConfigValue;
    renderEditor(raw, problemasDeEmissaoDoImposto(raw));
    expect(screen.queryByLabelText('pST (%)')).toBeNull();
    expect(screen.queryByText(/não possui campos adicionais/)).toBeNull();
  });
});

describe('IcmsSection — choosing a CSOSN (characterization)', () => {
  it('clears every Simples Nacional sub-config slot and keeps the Regime Normal blobs', () => {
    const onChange = vi.fn();
    const value: ImpostoConfigValue = {
      configuracaoICMS: {
        crt: CRT.simplesNacional,
        csosn: CSOSN.icmsCobradoAnteriormente,
        cst: CST.tributadaIntegralmente,
        csosn101: { pCredSN: 1, vCredICMSSN: 1 },
        csosn500: { pST: 20 },
        icms00: null,
      },
    };
    renderEditor(value, [], onChange);
    fireEvent.click(screen.getByRole('combobox', { name: 'CSOSN' }));
    fireEvent.click(screen.getByRole('option', { name: /^900 - Outros/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toEqual({
      configuracaoICMS: {
        crt: CRT.simplesNacional,
        csosn: CSOSN.outros,
        cst: CST.tributadaIntegralmente,
        csosn101: null,
        csosn201: null,
        csosn202ou203: null,
        csosn500: null,
        csosn900: null,
        icms00: null,
      },
    });
  });

  it('shows the no-fields note for a CSOSN that reads no slot', () => {
    renderEditor({
      configuracaoICMS: { crt: CRT.simplesNacional, csosn: CSOSN.tributadaSemCredito },
    });
    expect(screen.getByText('CSOSN 102 não possui campos adicionais de ICMS.')).toBeTruthy();
  });
});
