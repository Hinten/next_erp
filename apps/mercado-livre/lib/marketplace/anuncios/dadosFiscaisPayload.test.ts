import { describe, expect, it } from 'vitest';
import { ORIGEM, type Imposto } from '@delfrance/schemas';

import {
  MOTIVO_DADOS_FISCAIS,
  type EntradaDadosFiscais,
  montarDadosFiscais,
  motivoOrigemIndefinida,
  tipoOrigemMercadoLivre,
} from './dadosFiscaisPayload';

const IMPOSTO: Imposto = {
  origem: ORIGEM.nacional,
  cfop: '5101',
  cfopInterestadual: '6101',
  NCM: '61091000',
  CEST: '2806300',
  unidade: 'UN',
  extipi: null,
  configuracaoICMS: { crt: '1', csosn: '102' },
};

function entrada(over: Partial<EntradaDadosFiscais> = {}): EntradaDadosFiscais {
  return {
    sku: 'CAM-P-AZ',
    titulo: 'Camiseta azul P',
    imposto: IMPOSTO,
    operacao: null,
    gtin: '7891234567895',
    pesoBrutoKg: 0.21,
    pesoLiquidoKg: 0.18,
    custo: 19.9,
    ...over,
  };
}

function corpo(over: Partial<EntradaDadosFiscais> = {}) {
  const r = montarDadosFiscais(entrada(over));
  if (!r.ok) throw new Error(`esperava corpo, veio motivo: ${r.motivo}`);
  return r.body;
}

function motivo(over: Partial<EntradaDadosFiscais> = {}) {
  const r = montarDadosFiscais(entrada(over));
  if (r.ok) throw new Error('esperava motivo, veio corpo');
  return r.motivo;
}

describe('tipoOrigemMercadoLivre — the seller’s role, from what the nota says', () => {
  it.each([
    ['0', '5101', 'manufacturer'],
    ['0', '6101', 'manufacturer'],
    ['0', '5401', 'manufacturer'],
    ['0', '5102', 'reseller'],
    ['0', '6102', 'reseller'],
    ['0', '5403', 'reseller'],
    ['0', '5405', 'reseller'],
    // origem 2/7 is foreign goods BOUGHT here — resale, not import.
    ['2', '5102', 'reseller'],
    ['7', '5102', 'reseller'],
    // origem 1/6 is DIRECT import — the seller is the importer, whatever the CFOP.
    ['1', '5102', 'imported'],
    ['6', '5101', 'imported'],
    ['1', null, 'imported'],
  ] as const)('origem %s + CFOP %s → %s', (origem, cfop, esperado) => {
    expect(tipoOrigemMercadoLivre(origem, cfop)).toBe(esperado);
  });

  it.each([
    ['a CFOP of another operation', '5949'],
    ['a remessa CFOP', '5910'],
    ['a near-miss of 5101', '5110'],
    ['a malformed CFOP', '510'],
    ['no CFOP', null],
  ])('%s → null (never a guess)', (_caso, cfop) => {
    expect(tipoOrigemMercadoLivre('0', cfop)).toBeNull();
  });
});

describe('montarDadosFiscais — the body', () => {
  it('a Simples produto with every field: exactly what ML documents, nothing more', () => {
    expect(corpo()).toEqual({
      sku: 'CAM-P-AZ',
      title: 'Camiseta azul P',
      type: 'single',
      register_type: 'final',
      measurement_unit: 'UN',
      cost: 19.9,
      tax_information: {
        ncm: '61091000',
        origin_type: 'manufacturer',
        origin_detail: '0',
        csosn: '102',
        cest: '2806300',
        ean: '7891234567895',
        net_weight: 0.18,
        gross_weight: 0.21,
      },
    });
  });

  it('the codes the imposto lacks come from the operação, like the nota’s', () => {
    const b = corpo({
      imposto: { ...IMPOSTO, NCM: null, CEST: null, unidade: null, cfop: null },
      operacao: { NCM: '61099000', CEST: '2806300', unidade: 'PC', cfop: '5102' },
    });
    expect(b.tax_information.ncm).toBe('61099000');
    expect(b.tax_information.cest).toBe('2806300');
    expect(b.measurement_unit).toBe('PC');
    expect(b.tax_information.origin_type).toBe('reseller');
  });

  it('falls back to the interstate CFOP when the intra-state one is absent', () => {
    const b = corpo({ imposto: { ...IMPOSTO, cfop: null, cfopInterestadual: '6102' } });
    expect(b.tax_information.origin_type).toBe('reseller');
  });

  it('a formatted NCM from the operação is normalised to its 8 digits', () => {
    const b = corpo({ imposto: { ...IMPOSTO, NCM: null }, operacao: { NCM: '6109.10.00' } });
    expect(b.tax_information.ncm).toBe('61091000');
  });

  it('weights are kg with at most 3 decimals, and a zero weight is OMITTED, never sent as 0', () => {
    const b = corpo({ pesoBrutoKg: 0.21049, pesoLiquidoKg: 0 });
    expect(b.tax_information.gross_weight).toBe(0.21);
    expect(b.tax_information).not.toHaveProperty('net_weight');
    expect(corpo({ pesoBrutoKg: 1.2345 }).tax_information.gross_weight).toBe(1.235);
  });

  it('an invalid GTIN is omitted — the nota would say SEM GTIN', () => {
    expect(corpo({ gtin: '123' }).tax_information).not.toHaveProperty('ean');
    expect(corpo({ gtin: null }).tax_information).not.toHaveProperty('ean');
  });

  it('cost is sent only when positive, rounded to cents', () => {
    expect(corpo({ custo: 0 })).not.toHaveProperty('cost');
    expect(corpo({ custo: null })).not.toHaveProperty('cost');
    expect(corpo({ custo: 10.005 }).cost).toBe(10.01);
  });

  it('carries ex_tipi when the imposto has one, trimmed', () => {
    expect(corpo({ imposto: { ...IMPOSTO, extipi: ' 01 ' } }).tax_information.ex_tipi).toBe('01');
    expect(corpo({ imposto: { ...IMPOSTO, extipi: '' } }).tax_information).not.toHaveProperty(
      'ex_tipi',
    );
  });
});

describe('montarDadosFiscais — the refusals', () => {
  it('no NCM anywhere', () => {
    expect(motivo({ imposto: { ...IMPOSTO, NCM: null } })).toBe(MOTIVO_DADOS_FISCAIS.semNcm);
  });

  it('an NCM that is not 8 digits after normalising', () => {
    expect(motivo({ imposto: { ...IMPOSTO, NCM: null }, operacao: { NCM: '6109' } })).toBe(
      MOTIVO_DADOS_FISCAIS.semNcm,
    );
  });

  it('Regime Normal (a CST, no CSOSN) is refused — only Simples is sent', () => {
    expect(
      motivo({ imposto: { ...IMPOSTO, configuracaoICMS: { crt: '3', csosn: null, cst: '00' } } }),
    ).toBe(MOTIVO_DADOS_FISCAIS.regimeNormal);
  });

  it('CRT 3 is refused even if a stray CSOSN is stored beside it', () => {
    expect(motivo({ imposto: { ...IMPOSTO, configuracaoICMS: { crt: '3', csosn: '102' } } })).toBe(
      MOTIVO_DADOS_FISCAIS.regimeNormal,
    );
  });

  it('no ICMS config at all', () => {
    expect(motivo({ imposto: { ...IMPOSTO, configuracaoICMS: null } })).toBe(
      MOTIVO_DADOS_FISCAIS.regimeNormal,
    );
  });

  it('a CFOP that names neither production nor resale — the reason NAMES it', () => {
    expect(motivo({ imposto: { ...IMPOSTO, cfop: '5949' } })).toBe(motivoOrigemIndefinida('5949'));
    expect(motivoOrigemIndefinida('5949')).toContain('5949');
  });
});
