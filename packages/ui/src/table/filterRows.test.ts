import { describe, expect, it } from 'vitest';
import type { SnapshotRow } from '@delfrance/data/hooks';
import { applyColumnFilters } from './filterRows';

type Row = { nome?: string | null; preco?: number | null; ativo?: boolean | null };

function rows(...data: Row[]): SnapshotRow<Row>[] {
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
