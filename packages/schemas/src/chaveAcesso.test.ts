import { describe, expect, it } from 'vitest';

import { chaveAcessoValida, decomporChaveAcesso, dvChaveAcesso } from './chaveAcesso';

const VALIDA = '35260514200166000187550010000000071000000011';
/** NT 2026.004 — the emitente CNPJ body (positions 6–17) is alphanumeric. */
const VALIDA_ALFA = '352601ABCDEFGHIJKL87550010000001234567890120';
/** A CPF emitente (produtor rural): the CPF left-padded with zeros to 14. */
const VALIDA_CPF = '35260500012345678909550010000000091000000093';

describe('dvChaveAcesso', () => {
  it('computes the módulo-11 digit of known chaves', () => {
    expect(dvChaveAcesso(VALIDA.slice(0, 43))).toBe(1);
    expect(dvChaveAcesso(VALIDA_ALFA.slice(0, 43))).toBe(0);
    expect(dvChaveAcesso(VALIDA_CPF.slice(0, 43))).toBe(3);
  });

  it('returns null — never NaN — for anything not shaped like 43 chave characters', () => {
    for (const bad of [
      '',
      VALIDA.slice(0, 42),
      VALIDA,
      `A${VALIDA.slice(1, 43)}`,
      'x'.repeat(43),
    ]) {
      expect(dvChaveAcesso(bad)).toBeNull();
    }
  });
});

describe('chaveAcessoValida', () => {
  it.each([VALIDA, VALIDA_ALFA, VALIDA_CPF])('accepts %s', (c) => {
    expect(chaveAcessoValida(c)).toBe(true);
  });

  // Near-misses: the right shape with one check digit off, a letter outside the
  // CNPJ window, and wrong lengths.
  it.each([
    ['check digit off by one', `${VALIDA.slice(0, 43)}2`],
    ['letter outside positions 7–18', `${VALIDA.slice(0, 2)}A${VALIDA.slice(3)}`],
    ['43 characters', VALIDA.slice(0, 43)],
    ['45 characters', `${VALIDA}0`],
    ['lowercase in the CNPJ window', VALIDA_ALFA.toLowerCase()],
  ])('rejects %s', (_label, c) => {
    expect(chaveAcessoValida(c)).toBe(false);
  });
});

describe('decomporChaveAcesso', () => {
  it('splits a valid chave into its MOC fields', () => {
    expect(decomporChaveAcesso(VALIDA)).toEqual({
      cUF: '35',
      aamm: '2605',
      cnpjCpfEmitente: '14200166000187',
      mod: '55',
      serie: '001',
      nNF: '000000007',
      tpEmis: '1',
      cNF: '00000001',
      cDV: '1',
    });
    expect(decomporChaveAcesso(VALIDA_CPF)?.cnpjCpfEmitente).toBe('00012345678909');
  });

  it('returns null for an invalid chave instead of slicing garbage', () => {
    expect(decomporChaveAcesso(`${VALIDA.slice(0, 43)}2`)).toBeNull();
  });
});
