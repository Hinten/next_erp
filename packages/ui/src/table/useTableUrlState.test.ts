import { describe, expect, it } from 'vitest';
import type { FilterableField } from '../schema/types';
import { parseFiltersFromParams, parseSortFromParams } from './useTableUrlState';

function field(key: string, kind: FilterableField['kind']): FilterableField {
  return { key, kind, label: key };
}

const FIELDS: FilterableField[] = [
  field('nome', 'string'),
  field('preco', 'currency'),
  field('ativo', 'boolean'),
  field('estado', 'enum'),
  field('timestamp', 'datetime'),
  field('nf', 'string'), // synthetic virtual-column (subcollection-lookup) field
];

function parse(qs: string) {
  return parseFiltersFromParams(new URLSearchParams(qs), FIELDS);
}

describe('parseFiltersFromParams', () => {
  it('coerces datetime bounds to numbers (micros/millis)', () => {
    expect(parse('timestamp=gte:1700000000000000')).toEqual({
      timestamp: { op: 'gte', value: 1700000000000000 },
    });
  });

  it('coerces numeric/currency filters to numbers', () => {
    expect(parse('preco=lte:150')).toEqual({ preco: { op: 'lte', value: 150 } });
  });

  it('keeps string/enum filters as strings', () => {
    expect(parse('nome=contains:ana&estado=eq:pago')).toEqual({
      nome: { op: 'contains', value: 'ana' },
      estado: { op: 'eq', value: 'pago' },
    });
  });

  it('parses booleans', () => {
    expect(parse('ativo=eq:true')).toEqual({ ativo: { op: 'eq', value: true } });
  });

  it('preserves a subfield-encoded subcollection-lookup value verbatim', () => {
    // The NF filter encodes `"<subfield>:<term>"`; the leading op is split off,
    // the rest (which itself contains a colon) stays intact as the value.
    expect(parse('nf=eq:numeracao:1234')).toEqual({
      nf: { op: 'eq', value: 'numeracao:1234' },
    });
  });

  it('skips params without a known field or with a bad op', () => {
    expect(parse('desconhecido=eq:x&preco=bogus:1')).toEqual({});
  });

  it('drops a datetime value that is not a number', () => {
    expect(parse('timestamp=gte:notanumber')).toEqual({});
  });
});

describe('parseSortFromParams', () => {
  it('parses a nested sort field + direction', () => {
    expect(
      parseSortFromParams(new URLSearchParams('sort=freteInicial.prazoDespacho:desc')),
    ).toEqual({ field: 'freteInicial.prazoDespacho', direction: 'desc' });
  });

  it('rejects a malformed direction', () => {
    expect(parseSortFromParams(new URLSearchParams('sort=numero:sideways'))).toBeUndefined();
  });
});
