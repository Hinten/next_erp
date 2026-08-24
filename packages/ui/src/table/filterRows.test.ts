import { describe, expect, it } from 'vitest';
import type { SnapshotRow } from '@delfrance/data/hooks';
import { applyColumnFilters } from './filterRows';

type Row = { nome?: string | null; preco?: number | null; ativo?: boolean | null };

function rows(...data: Row[]): SnapshotRow<Row>[] {
  return data.map((d, i) => ({ id: String(i), path: `x/${i}`, data: d }));
}

type TagRow = { tags?: string[] | null };

function tagRows(...data: TagRow[]): SnapshotRow<TagRow>[] {
  return data.map((d, i) => ({ id: String(i), path: `x/${i}`, data: d }));
}

describe('applyColumnFilters', () => {
  it('returns rows unchanged when there are no filters', () => {
    const input = rows({ nome: 'Alice' }, { nome: 'Bob' });
    expect(applyColumnFilters(input, {})).toBe(input);
  });

  it('contains matches case- and accent-insensitively', () => {
    const result = applyColumnFilters(rows({ nome: 'Açaí' }, { nome: 'Banana' }), {
      nome: { op: 'contains', value: 'acai' },
    });
    expect(result.map((r) => r.data.nome)).toEqual(['Açaí']);
  });

  it('contains excludes null/missing values', () => {
    const result = applyColumnFilters(rows({ nome: 'Alice' }, { nome: null }, {}), {
      nome: { op: 'contains', value: 'a' },
    });
    expect(result.map((r) => r.data.nome)).toEqual(['Alice']);
  });

  it('startsWith matches a prefix', () => {
    const result = applyColumnFilters(
      rows({ nome: 'Alice' }, { nome: 'Albert' }, { nome: 'Bob' }),
      {
        nome: { op: 'startsWith', value: 'Al' },
      },
    );
    expect(result.map((r) => r.data.nome)).toEqual(['Alice', 'Albert']);
  });

  it('eq matches strict equality', () => {
    const result = applyColumnFilters(rows({ ativo: true }, { ativo: false }), {
      ativo: { op: 'eq', value: true },
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.data.ativo).toBe(true);
  });

  it('eq null matches missing/null values', () => {
    const result = applyColumnFilters(rows({ nome: 'Alice' }, { nome: null }, {}), {
      nome: { op: 'eq', value: null },
    });
    expect(result).toHaveLength(2);
  });

  it('numeric comparisons (lt/lte/gt/gte)', () => {
    const input = rows({ preco: 10 }, { preco: 20 }, { preco: 30 });
    expect(
      applyColumnFilters(input, { preco: { op: 'lt', value: 20 } }).map((r) => r.data.preco),
    ).toEqual([10]);
    expect(
      applyColumnFilters(input, { preco: { op: 'lte', value: 20 } }).map((r) => r.data.preco),
    ).toEqual([10, 20]);
    expect(
      applyColumnFilters(input, { preco: { op: 'gt', value: 20 } }).map((r) => r.data.preco),
    ).toEqual([30]);
    expect(
      applyColumnFilters(input, { preco: { op: 'gte', value: 20 } }).map((r) => r.data.preco),
    ).toEqual([20, 30]);
  });

  it('resolves nested dotted field paths', () => {
    type Nested = { freteInicial?: { estado?: string } | null };
    const nestedRows = (...data: Nested[]): SnapshotRow<Nested>[] =>
      data.map((d, i) => ({ id: String(i), path: `x/${i}`, data: d }));
    const result = applyColumnFilters(
      nestedRows(
        { freteInicial: { estado: 'entregue' } },
        { freteInicial: { estado: 'postado' } },
        { freteInicial: null },
        {},
      ),
      { 'freteInicial.estado': { op: 'eq', value: 'entregue' } },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.data.freteInicial?.estado).toBe('entregue');
  });

  // Neither array op is reachable from the built-in ColumnFilter UI (it only
  // emits contains/eq/lt/lte/gt/gte), but a virtual column's `renderFilter` can
  // emit them and `buildPipeline` can wire them by hand as an extraFilter — and
  // then the client-side fallback has to agree with what the server pipeline
  // would have returned.
  it('array-contains matches a row whose array holds the value', () => {
    const result = applyColumnFilters(
      tagRows({ tags: ['novo', 'promo'] }, { tags: ['usado'] }, { tags: [] }, {}),
      { tags: { op: 'array-contains', value: 'promo' } },
    );
    expect(result.map((r) => r.data.tags)).toEqual([['novo', 'promo']]);
  });

  it('array-contains excludes non-array and missing values', () => {
    const result = applyColumnFilters(tagRows({ tags: null }, {}), {
      tags: { op: 'array-contains', value: 'promo' },
    });
    expect(result).toHaveLength(0);
  });

  it('array-contains-any matches a row holding ANY of the candidates', () => {
    const result = applyColumnFilters(
      tagRows(
        { tags: ['novo', 'promo'] },
        { tags: ['usado'] },
        { tags: ['liquida'] },
        { tags: [] },
        {},
      ),
      { tags: { op: 'array-contains-any', value: ['promo', 'liquida'] } },
    );
    // Both matching rows, and ONLY those — a candidate list must not degrade to
    // its first element (that would drop `liquida`) nor match everything.
    expect(result.map((r) => r.data.tags)).toEqual([['novo', 'promo'], ['liquida']]);
  });

  it('array-contains-any accepts a bare scalar as a one-candidate list', () => {
    const result = applyColumnFilters(tagRows({ tags: ['promo'] }, { tags: ['usado'] }), {
      tags: { op: 'array-contains-any', value: 'promo' },
    });
    expect(result.map((r) => r.data.tags)).toEqual([['promo']]);
  });

  it('array-contains-any with an empty candidate list matches nothing', () => {
    // An empty list means "no rows" — TableView short-circuits before querying
    // and `buildPipeline` throws on it, so this path should only ever be reached
    // by a caller that skipped both. Matching everything would be the dangerous
    // disagreement: the server would have returned zero rows.
    const result = applyColumnFilters(tagRows({ tags: ['promo'] }, { tags: ['usado'] }), {
      tags: { op: 'array-contains-any', value: [] },
    });
    expect(result).toHaveLength(0);
  });

  it('AND-combines multiple column filters', () => {
    const result = applyColumnFilters(
      rows(
        { nome: 'Alice', ativo: true },
        { nome: 'Albert', ativo: false },
        { nome: 'Bob', ativo: true },
      ),
      { nome: { op: 'startsWith', value: 'Al' }, ativo: { op: 'eq', value: true } },
    );
    expect(result.map((r) => r.data.nome)).toEqual(['Alice']);
  });
});
