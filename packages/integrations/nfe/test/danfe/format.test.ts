import { describe, expect, it } from 'vitest';

import {
  cmToPt,
  cutString,
  formatCep,
  formatChaveAcesso,
  formatCpfCnpj,
  formatDate,
  formatMoney,
  formatNNF,
  formatQty,
  formatSerie,
  formatTelefone,
  formatTimeSeconds,
  freteLabel,
  onlyDigits,
} from '../../src/danfe/format';
import { CHAVE } from './fixtures';

describe('danfe/format', () => {
  it('groups the 44-digit chave into eleven blocks of four', () => {
    const grouped = formatChaveAcesso(CHAVE);
    expect(grouped).toBe('3526 0514 2001 6600 0187 5500 1000 0000 0710 0000 0018');
    expect(grouped.split(' ')).toHaveLength(11);
    expect(onlyDigits(grouped)).toBe(CHAVE);
  });

  it('masks CPF (11) and CNPJ (14); falls back to raw otherwise', () => {
    expect(formatCpfCnpj('12345678909')).toBe('123.456.789-09');
    expect(formatCpfCnpj('14200166000187')).toBe('14.200.166/0001-87');
    expect(formatCpfCnpj('123')).toBe('123');
  });

  it('formats CEP and phone numbers', () => {
    expect(formatCep('01001000')).toBe('01001-000');
    expect(formatCep('123')).toBe('123');
    expect(formatTelefone('1133224455')).toBe('(11) 3322-4455');
    expect(formatTelefone('11933224455')).toBe('(11) 93322-4455');
  });

  it('formats money pt-BR with two decimals and no symbol', () => {
    expect(formatMoney('1234.56')).toBe('1.234,56');
    expect(formatMoney('0')).toBe('0,00');
    expect(formatMoney(1000000)).toBe('1.000.000,00');
    expect(formatMoney('')).toBe('');
    expect(formatMoney('abc')).toBe('abc');
  });

  it('formats quantity, número and série', () => {
    expect(formatQty('2.5')).toBe('2,5');
    expect(formatNNF('7')).toBe('000.000.007');
    expect(formatNNF('123456789')).toBe('123.456.789');
    expect(formatSerie('1')).toBe('001');
  });

  it('renders dates/times in São Paulo time', () => {
    expect(formatDate('2026-05-26T15:25:00-03:00')).toBe('26/05/2026');
    expect(formatTimeSeconds('2026-05-26T15:30:12-03:00')).toBe('15:30:12');
  });

  it('labels modalidade do frete and truncates strings', () => {
    expect(freteLabel('0')).toBe('0 - REM. (CIF)');
    expect(freteLabel('9')).toBe('9 - SEM FRETE');
    expect(freteLabel('x')).toBe('');
    expect(cutString('abcdef', 3)).toBe('abc');
    expect(cutString('ab', 3)).toBe('ab');
  });

  it('converts centimetres to points', () => {
    expect(cmToPt(1)).toBeCloseTo(28.3465, 3);
    expect(cmToPt(10)).toBeCloseTo(283.465, 2);
  });
});
