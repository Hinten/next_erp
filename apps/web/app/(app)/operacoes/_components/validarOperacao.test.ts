/**
 * The operação form's finalidade/tipo validation (#330) — the shared
 * `violacoesDaOperacao` rules, each routed to the field the operator fixes.
 */
import { describe, expect, it } from 'vitest';

import { validarOperacao } from './operacaoFields';

const paths = (values: Record<string, unknown>) => validarOperacao(values).map((i) => i.path);

describe('validarOperacao', () => {
  it('a normal operação, a débito 04 saída and a crédito 01 entrada are clean', () => {
    expect(validarOperacao({ tipo: 1, finNFe: 1, tpNFDebito: null, tpNFCredito: null })).toEqual(
      [],
    );
    expect(validarOperacao({ tipo: 1, finNFe: 6, tpNFDebito: '04' })).toEqual([]);
    expect(validarOperacao({ tipo: 0, finNFe: 5, tpNFCredito: '01' })).toEqual([]);
  });

  it('a nota de débito without its tipo points at tpNFDebito, with the SEFAZ code', () => {
    expect(validarOperacao({ tipo: 1, finNFe: 6, tpNFDebito: null })).toEqual([
      { path: 'tpNFDebito', message: 'Informe o tipo da nota de débito. (SEFAZ 1009)' },
    ]);
  });

  it('a stale tipo after switching the finalidade points at that tipo', () => {
    expect(paths({ tipo: 1, finNFe: 1, tpNFDebito: '04', tpNFCredito: '01' })).toEqual([
      'tpNFDebito',
      'tpNFCredito',
    ]);
  });

  it('the wrong direction points at the tipo de operação', () => {
    expect(paths({ tipo: 1, finNFe: 5, tpNFCredito: '01' })).toEqual(['tipo']);
    expect(paths({ tipo: 0, finNFe: 6, tpNFDebito: '06' })).toEqual(['tipo']);
  });

  it('an absent finalidade is a normal nota, and crédito 02 is not judged without a date', () => {
    expect(validarOperacao({ tipo: 1, finNFe: null })).toEqual([]);
    expect(validarOperacao({ tipo: 0, finNFe: 5, tpNFCredito: '02' })).toEqual([]);
  });
});
