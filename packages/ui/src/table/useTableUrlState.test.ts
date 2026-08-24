import { describe, expect, it } from 'vitest';
import type { ColumnFilterValue, FilterableField } from '../schema/types';
import { encodeFilterValue, parseFiltersFromParams, parseSortFromParams } from './useTableUrlState';

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
  // Synthetic virtual-column field backing an ARRAY document field: its `kind`
  // describes the array, never its elements, which is why the list ops decode
  // by op rather than by kind.
  field('canais', 'string'),
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

  it('decodes an array-contains-any candidate list', () => {
    expect(parse('canais=array-contains-any:abc,def')).toEqual({
      canais: { op: 'array-contains-any', value: ['abc', 'def'] },
    });
  });

  it('decodes a single-value array-contains', () => {
    expect(parse('canais=array-contains:abc')).toEqual({
      canais: { op: 'array-contains', value: 'abc' },
    });
  });

  it('drops an array-contains-any with an empty list', () => {
    // An empty candidate list means "no rows" — not a filter worth restoring
    // from a URL, and `buildPipeline` throws on it.
    expect(parse('canais=array-contains-any:')).toEqual({});
  });

  it('skips params without a known field or with a bad op', () => {
    expect(parse('desconhecido=eq:x&preco=bogus:1')).toEqual({});
  });

  it('drops a datetime value that is not a number', () => {
    expect(parse('timestamp=gte:notanumber')).toEqual({});
  });
});

describe('encodeFilterValue ⇄ parseFiltersFromParams round trip', () => {
  function roundTrip(field: string, v: ColumnFilterValue) {
    const params = new URLSearchParams();
    params.set(field, `${v.op}:${encodeFilterValue(v.value)}`);
    return parseFiltersFromParams(params, FIELDS)[field];
  }

  it('restores a candidate list unchanged', () => {
    const v: ColumnFilterValue = { op: 'array-contains-any', value: ['abc', 'def', 'ghi'] };
    expect(roundTrip('canais', v)).toEqual(v);
  });

  it('restores a candidate containing the list separator', () => {
    // The join would otherwise split `a,b` into two candidates and silently
    // widen the filter — hence the per-element percent-encoding.
    const v: ColumnFilterValue = { op: 'array-contains-any', value: ['a,b', 'c'] };
    expect(roundTrip('canais', v)).toEqual(v);
  });

  it('leaves scalar values untouched', () => {
    expect(roundTrip('preco', { op: 'lte', value: 150 })).toEqual({ op: 'lte', value: 150 });
    expect(roundTrip('ativo', { op: 'eq', value: true })).toEqual({ op: 'eq', value: true });
    expect(roundTrip('nome', { op: 'contains', value: 'ana' })).toEqual({
      op: 'contains',
      value: 'ana',
    });
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
