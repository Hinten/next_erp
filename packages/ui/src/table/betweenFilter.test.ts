import { describe, expect, it } from 'vitest';
import { expandColumnFilter } from '../schema/types';
import { encodeFilterValue, parseFiltersFromParams } from './useTableUrlState';
import { describeFilter } from './describeFilter';
import { applyColumnFilters } from './filterRows';
import type { FilterableField } from '../schema/types';

/**
 * The `between` op is UI-only: it never reaches `buildPipeline`, and it carries a
 * SECOND operand that no other op has. Both of those make it exactly the kind of
 * addition that half-lands — the filter applies, the URL writes, and the link
 * reopens unfiltered because one layer never learned the op.
 *
 * These pin every layer it has to cross.
 */
const criacao: FilterableField = {
  key: 'criacao',
  kind: 'datetime',
  label: 'Criação',
  dateUnit: 'us',
};
const valor: FilterableField = { key: 'valor', kind: 'currency', label: 'Valor' };

describe('between — query expansion', () => {
  it('expands to an inclusive gte + lte pair', () => {
    expect(expandColumnFilter('criacao', { op: 'between', value: 10, valueTo: 20 })).toEqual([
      { field: 'criacao', op: 'gte', value: 10 },
      { field: 'criacao', op: 'lte', value: 20 },
    ]);
  });

  it('degrades to the single bound it has, rather than comparing against undefined', () => {
    // A comparison against `undefined` matches nothing and reads as an empty
    // result set — indistinguishable from "no rows match".
    expect(expandColumnFilter('valor', { op: 'between', value: 5, valueTo: null })).toEqual([
      { field: 'valor', op: 'gte', value: 5 },
    ]);
    expect(expandColumnFilter('valor', { op: 'between', value: null, valueTo: 9 })).toEqual([
      { field: 'valor', op: 'lte', value: 9 },
    ]);
  });

  it('leaves every other op exactly as it was', () => {
    expect(expandColumnFilter('nome', { op: 'contains', value: 'ana' })).toEqual([
      { field: 'nome', op: 'contains', value: 'ana' },
    ]);
  });
});

describe('between — URL round trip', () => {
  const roundTrip = (v: Parameters<typeof encodeFilterValue>[0], field: FilterableField) => {
    const params = new URLSearchParams();
    params.set(field.key, `${v.op}:${encodeFilterValue(v)}`);
    return parseFiltersFromParams(params, [field])[field.key];
  };

  it('survives encode → decode with both bounds', () => {
    // The bug this rules out: an op absent from FILTER_OPS writes to the URL and
    // is dropped on hydration, so a shared link silently reopens UNFILTERED.
    expect(roundTrip({ op: 'between', value: 100, valueTo: 200 }, criacao)).toEqual({
      op: 'between',
      value: 100,
      valueTo: 200,
    });
  });

  it('survives a one-sided range', () => {
    expect(roundTrip({ op: 'between', value: 100, valueTo: null }, criacao)).toEqual({
      op: 'between',
      value: 100,
      valueTo: null,
    });
  });

  it('drops a range with neither bound instead of filtering on nothing', () => {
    expect(roundTrip({ op: 'between', value: null, valueTo: null }, criacao)).toBeUndefined();
  });

  it('does not throw on a hand-mangled link', () => {
    // Runs from a useState initializer, so a throw here takes down the whole
    // TableView subtree during render.
    const params = new URLSearchParams('criacao=between:notanumber');
    expect(() => parseFiltersFromParams(params, [criacao])).not.toThrow();
    expect(parseFiltersFromParams(params, [criacao]).criacao).toBeUndefined();
  });
});

describe('between — chip and client-side mirror', () => {
  it('reads as one range, in one text node', () => {
    const text = describeFilter('Valor', { op: 'between', value: 10, valueTo: 50 }, valor);
    expect(text).toBe('Valor: de 10 até 50');
  });

  it('describes an incomplete range honestly', () => {
    expect(describeFilter('Valor', { op: 'between', value: 10, valueTo: null }, valor)).toBe(
      'Valor: a partir de 10',
    );
  });

  it('filters rows inclusively on both ends', () => {
    const rows = [5, 10, 30, 50, 51].map((n, i) => ({
      id: String(i),
      path: `x/${i}`,
      data: { valor: n },
    }));
    const kept = applyColumnFilters(rows, { valor: { op: 'between', value: 10, valueTo: 50 } });
    expect(kept.map((r) => r.data.valor)).toEqual([10, 30, 50]);
  });
});
