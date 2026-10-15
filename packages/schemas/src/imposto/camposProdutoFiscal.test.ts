import { describe, expect, it } from 'vitest';

import { camposProdutoFiscal, gtinFiscal } from './camposProdutoFiscal';

const VAZIO = { cfop: null, cfopInterestadual: null, NCM: null, CEST: null, unidade: null };

describe('camposProdutoFiscal — the nota’s per-field operação fallback', () => {
  it('the item’s value wins over the operação’s, field by field', () => {
    const campos = camposProdutoFiscal(
      { cfop: '5101', cfopInterestadual: '6101', NCM: '61091000', CEST: '2806300', unidade: 'UN' },
      { cfop: '5102', cfopInterestadual: '6102', NCM: '99999999', CEST: '1111111', unidade: 'PC' },
    );
    expect(campos).toEqual({
      cfop: '5101',
      cfopInterestadual: '6101',
      NCM: '61091000',
      CEST: '2806300',
      unidade: 'UN',
    });
  });

  it('a field the item lacks comes from the operação — and only that field', () => {
    const campos = camposProdutoFiscal(
      { ...VAZIO, cfop: '5101', unidade: 'UN' },
      { cfop: '5102', NCM: '61091000', CEST: '2806300', unidade: 'PC' },
    );
    expect(campos).toEqual({
      cfop: '5101',
      cfopInterestadual: null,
      NCM: '61091000',
      CEST: '2806300',
      unidade: 'UN',
    });
  });

  it('absent on both sides is null, never a default', () => {
    expect(camposProdutoFiscal(VAZIO, null)).toEqual(VAZIO);
    expect(camposProdutoFiscal({}, {})).toEqual(VAZIO);
  });

  it('a RAW operação with a non-string value reads as absent instead of throwing', () => {
    const campos = camposProdutoFiscal(VAZIO, { NCM: 61091000, CEST: { x: 1 }, unidade: true });
    expect(campos).toEqual(VAZIO);
  });

  it('keeps the operação’s empty string VERBATIM (the NF-e’s `if (!NCM)` owns what it means)', () => {
    // Near-miss for the fold: '' must NOT be promoted to null here — that would
    // change nothing for the NF-e today, but it is a decision this helper does
    // not own.
    expect(camposProdutoFiscal(VAZIO, { NCM: '' }).NCM).toBe('');
  });
});

describe('gtinFiscal — the cEAN rule', () => {
  it.each(['12345678', '7891234567895', '12345678901234'])('%s (8–14 digits) is a GTIN', (g) => {
    expect(gtinFiscal(g)).toBe(g);
  });

  it.each([
    ['7 digits', '1234567'],
    ['15 digits', '123456789012345'],
    ['empty', ''],
    ['letters', '789123456789X'],
    ['spaces', ' 7891234567895'],
    ['the literal', 'SEM GTIN'],
  ])('%s → null (the nota says SEM GTIN)', (_caso, g) => {
    expect(gtinFiscal(g)).toBeNull();
  });

  it('null / undefined → null', () => {
    expect(gtinFiscal(null)).toBeNull();
    expect(gtinFiscal(undefined)).toBeNull();
  });
});
