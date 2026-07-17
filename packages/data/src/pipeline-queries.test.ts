import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the Pipelines subpath. Tests reassign these between cases via reset().
// `vi.hoisted` ensures the mock object is built before vi.mock evaluates.
const { mockPipelinesExports } = vi.hoisted(() => ({
  mockPipelinesExports: {
    field: (n: string) => ({ kind: 'field', name: n }),
    and: (...xs: unknown[]) => ({ kind: 'and', xs }),
    or: (...xs: unknown[]) => ({ kind: 'or', xs }),
    ascending: (f: unknown) => ({ kind: 'asc', f }),
    descending: (f: unknown) => ({ kind: 'desc', f }),
    startsWith: (f: unknown, t: unknown) => ({ kind: 'startsWith', f, t }),
    regexContains: (f: unknown, p: unknown) => ({ kind: 'regexContains', f, p }),
    equal: (l: unknown, r: unknown) => ({ kind: 'equal', l, r }),
    lessThan: (l: unknown, r: unknown) => ({ kind: 'lt', l, r }),
    lessThanOrEqual: (l: unknown, r: unknown) => ({ kind: 'lte', l, r }),
    greaterThan: (l: unknown, r: unknown) => ({ kind: 'gt', l, r }),
    greaterThanOrEqual: (l: unknown, r: unknown) => ({ kind: 'gte', l, r }),
    arrayContains: (f: unknown, v: unknown) => ({ kind: 'arrayContains', f, v }),
    arrayContainsAny: (f: unknown, vs: unknown) => ({ kind: 'arrayContainsAny', f, vs }),
    documentId: (expr: unknown) => ({
      expr,
      as: (alias: string) => ({ kind: 'aliased', alias, expr }),
    }),
  } as Record<string, unknown>,
}));

vi.mock('firebase/firestore/pipelines', () => mockPipelinesExports);

import type { Firestore } from 'firebase/firestore';
import { PipelineUnsupportedError, buildPipeline, isPipelineSupported } from './pipeline-queries';

interface Stage {
  where: ReturnType<typeof vi.fn>;
  sort: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  __calls: string[];
}

function makeStage(): Stage {
  const calls: string[] = [];
  const stage = {
    where: vi.fn(() => {
      calls.push('where');
      return stage;
    }),
    sort: vi.fn(() => {
      calls.push('sort');
      return stage;
    }),
    limit: vi.fn(() => {
      calls.push('limit');
      return stage;
    }),
    select: vi.fn(() => {
      calls.push('select');
      return stage;
    }),
    __calls: calls,
  } as Stage;
  return stage;
}

function makeDb(withPipeline: boolean): {
  db: Firestore;
  stage: Stage;
  collection: ReturnType<typeof vi.fn>;
} {
  const stage = makeStage();
  const collection = vi.fn(() => stage);
  const db = (withPipeline
    ? { pipeline: vi.fn(() => ({ collection })) }
    : {}) as unknown as Firestore;
  return { db, stage, collection };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isPipelineSupported', () => {
  it('returns false when db.pipeline is missing', () => {
    const { db } = makeDb(false);
    expect(isPipelineSupported(db)).toBe(false);
  });

  it('returns true when db.pipeline is a function', () => {
    const { db } = makeDb(true);
    expect(isPipelineSupported(db)).toBe(true);
  });
});

describe('buildPipeline', () => {
  it('throws PipelineUnsupportedError when db.pipeline is missing', () => {
    const { db } = makeDb(false);
    expect(() => buildPipeline(db, { collection: 'clientes' })).toThrow(PipelineUnsupportedError);
  });

  it('builds collection -> where(or(regexContains, regexContains)) -> sort -> limit', () => {
    const { db, stage, collection } = makeDb(true);
    buildPipeline(db, {
      collection: 'clientes',
      search: { fields: ['nome', 'email'], term: 'ma' },
      orderBy: [{ field: 'nome', direction: 'asc' }],
      limit: 50,
    });

    expect(collection).toHaveBeenCalledWith('clientes');
    expect(stage.__calls).toEqual(['where', 'sort', 'limit']);
    expect(stage.where).toHaveBeenCalledWith(expect.objectContaining({ kind: 'or' }));
    expect(stage.sort).toHaveBeenCalledWith(expect.objectContaining({ kind: 'asc' }));
    expect(stage.limit).toHaveBeenCalledWith(50);
  });

  it('uses single regexContains directly (no or) when only one search field', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'x',
      search: { fields: ['nome'], term: 'a' },
    });
    expect(stage.where).toHaveBeenCalledWith(expect.objectContaining({ kind: 'regexContains' }));
  });

  it('similarity search is case- and accent-insensitive and trims whitespace', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'x',
      search: { fields: ['nome'], term: '  Açaí  ' },
    });
    // Pattern: (?i) flag + each ASCII letter expanded to its accent class.
    expect(stage.where).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'regexContains',
        f: 'nome',
        p: '(?i)[aàáâãäå][cç][aàáâãäå][iìíîï]',
      }),
    );
  });

  it('skips where when search term is empty or whitespace', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'x',
      search: { fields: ['nome'], term: '   ' },
    });
    expect(stage.where).not.toHaveBeenCalled();
  });

  it('descending sort wraps field in descending()', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'x',
      orderBy: [{ field: 'createdAt', direction: 'desc' }],
    });
    expect(stage.sort).toHaveBeenCalledWith(expect.objectContaining({ kind: 'desc' }));
  });

  it('applies a single eq filter as where(equal)', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'x',
      filters: [{ field: 'tipo', op: 'eq', value: '1' }],
    });
    expect(stage.where).toHaveBeenCalledWith(expect.objectContaining({ kind: 'equal' }));
  });

  it('contains filter uses regexContains with an accent-folded pattern', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'x',
      filters: [{ field: 'nome', op: 'contains', value: 'Açaí' }],
    });
    expect(stage.where).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'regexContains',
        f: 'nome',
        p: '(?i)[aàáâãäå][cç][aàáâãäå][iìíîï]',
      }),
    );
  });

  it('array-contains filter builds arrayContains(field, value)', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'enviNfe',
      filters: [{ field: 'targetsChnfe', op: 'array-contains', value: '1'.repeat(44) }],
    });
    expect(stage.where).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'arrayContains',
        f: 'targetsChnfe',
        v: '1'.repeat(44),
      }),
    );
  });

  it('array-contains-any filter passes the whole candidate list', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'enviNfe',
      filters: [{ field: 'targetsChnfe', op: 'array-contains-any', value: ['a', 'b', 'c'] }],
    });
    expect(stage.where).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'arrayContainsAny',
        f: 'targetsChnfe',
        vs: ['a', 'b', 'c'],
      }),
    );
  });

  it('array-contains-any wraps a scalar value into a single-element list', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'enviNfe',
      filters: [{ field: 'targetsChnfe', op: 'array-contains-any', value: 'solo' }],
    });
    expect(stage.where).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'arrayContainsAny', vs: ['solo'] }),
    );
  });

  it('array-contains-any with an empty list throws (callers must short-circuit)', () => {
    const { db } = makeDb(true);
    expect(() =>
      buildPipeline(db, {
        collection: 'enviNfe',
        filters: [{ field: 'targetsChnfe', op: 'array-contains-any', value: [] }],
      }),
    ).toThrow(/empty/);
  });

  it('eq with an array value throws (only array-contains-any takes a list)', () => {
    const { db } = makeDb(true);
    expect(() =>
      buildPipeline(db, {
        collection: 'x',
        filters: [{ field: 'tipo', op: 'eq', value: ['1', '2'] }],
      }),
    ).toThrow(/received an array value/);
  });

  it('array-contains with an array value throws (single-element membership only)', () => {
    const { db } = makeDb(true);
    expect(() =>
      buildPipeline(db, {
        collection: 'enviNfe',
        filters: [{ field: 'targetsChnfe', op: 'array-contains', value: ['a', 'b'] }],
      }),
    ).toThrow(/received an array value/);
  });

  it('AND-combines array ops with other column filters in one where(and(...))', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'enviNfe',
      filters: [
        { field: 'targetsChnfe', op: 'array-contains-any', value: ['a', 'b'] },
        { field: 'estado', op: 'eq', value: 'e' },
      ],
    });
    expect(stage.where).toHaveBeenCalledTimes(1);
    expect(stage.where).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'and',
        xs: [
          expect.objectContaining({ kind: 'arrayContainsAny', f: 'targetsChnfe', vs: ['a', 'b'] }),
          expect.objectContaining({ kind: 'equal' }),
        ],
      }),
    );
  });

  it('AND-combines multiple column filters', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'x',
      filters: [
        { field: 'tipo', op: 'eq', value: '1' },
        { field: 'age', op: 'gte', value: 18 },
      ],
    });
    expect(stage.where).toHaveBeenCalledWith(expect.objectContaining({ kind: 'and' }));
  });

  it('search + filters apply as two separate where stages', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'x',
      search: { fields: ['nome'], term: 'ab' },
      filters: [{ field: 'tipo', op: 'eq', value: '1' }],
    });
    expect(stage.where).toHaveBeenCalledTimes(2);
  });

  it('select projects the requested fields plus the document id', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'x',
      select: ['nome', 'email', 'cpf_cnpj'],
      limit: 50,
    });
    expect(stage.__calls).toEqual(['select', 'limit']);
    // Requested columns + the documentId(field('__name__')) projection
    // aliased to 'rowId', so the row identity survives `.select()`.
    expect(stage.select).toHaveBeenCalledWith(
      'nome',
      'email',
      'cpf_cnpj',
      expect.objectContaining({ kind: 'aliased', alias: 'rowId' }),
    );
  });
});
