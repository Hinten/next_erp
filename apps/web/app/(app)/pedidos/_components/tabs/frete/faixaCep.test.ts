import { describe, expect, it } from 'vitest';
import { faixaCepOptionString, type FaixaDeCep } from '@delfrance/schemas';
import { format, money } from '@delfrance/core/money';
import { faixaLabel, formatCep, parseFaixaOptionString, selectableFaixas } from './faixaCep';

const faixas: FaixaDeCep[] = [
  { cepInicial: '01000000', cepFinal: '01999999', custo: 15, valor: 20, prazo: 1 },
  { cepInicial: '02000000', cepFinal: '02999999', custo: 18.5, valor: 25, prazo: 2 },
];

describe('selectableFaixas', () => {
  it('keeps only the faixas whose range contains the destination CEP', () => {
    expect(selectableFaixas(faixas, '01310100')).toEqual([faixas[0]]);
    expect(selectableFaixas(faixas, '02500000')).toEqual([faixas[1]]);
    expect(selectableFaixas(faixas, '05000000')).toEqual([]);
  });

  it('boundaries are inclusive (legacy <= / >=)', () => {
    expect(selectableFaixas(faixas, '01000000')).toEqual([faixas[0]]);
    expect(selectableFaixas(faixas, '01999999')).toEqual([faixas[0]]);
  });

  it('no destination CEP / no faixas → nothing selectable', () => {
    expect(selectableFaixas(faixas, null)).toEqual([]);
    expect(selectableFaixas(null, '01310100')).toEqual([]);
    expect(selectableFaixas(faixas, 'abc')).toEqual([]);
  });
});

describe('parseFaixaOptionString', () => {
  it('round-trips the Dart optionString (integral doubles keep the .0)', () => {
    const option = faixaCepOptionString(faixas[0]!);
    expect(option).toBe('01000000 - 01999999 - 15.0 - 20.0 - 1');
    expect(parseFaixaOptionString(option)).toEqual(faixas[0]);
  });

  it('parses fractional values', () => {
    const option = faixaCepOptionString(faixas[1]!);
    expect(option).toBe('02000000 - 02999999 - 18.5 - 25.0 - 2');
    expect(parseFaixaOptionString(option)).toEqual(faixas[1]);
  });

  it('malformed strings return null (legacy widget catches and warns)', () => {
    expect(parseFaixaOptionString('01000000 - 01999999')).toBeNull();
    expect(parseFaixaOptionString('')).toBeNull();
  });

  it('unparseable numbers fall back to 0 (legacy tryParse ?? 0)', () => {
    expect(parseFaixaOptionString('a - b - x - y - z')).toEqual({
      cepInicial: 'a',
      cepFinal: 'b',
      custo: 0,
      valor: 0,
      prazo: 0,
    });
  });
});

describe('faixaLabel / formatCep', () => {
  it('formats an 8-digit CEP with the dash', () => {
    expect(formatCep('01310100')).toBe('01310-100');
    expect(formatCep('xyz')).toBe('xyz');
  });

  it('mirrors the legacy FaixaDeCep.toString layout', () => {
    const valor = format(money(2000));
    expect(faixaLabel(faixas[0]!)).toBe(`${valor} - 1 dias úteis (de 01000-000 a 01999-999)`);
  });
});
