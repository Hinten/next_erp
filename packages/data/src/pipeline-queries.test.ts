import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the Pipelines subpath. Tests reassign these between cases via reset().
// `vi.hoisted` ensures the mock object is built before vi.mock evaluates.
const { mockPipelinesExports } = vi.hoisted(() => ({
  mockPipelinesExports: {
    field: (n: string) => ({
      kind: 'field',
      name: n,
      as: (alias: string) => ({ kind: 'aliased', alias, expr: { kind: 'field', name: n } }),
    }),
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
    documentMatches: (rquery: unknown) => ({ kind: 'documentMatches', rquery }),
  } as Record<string, unknown>,
}));

vi.mock('firebase/firestore/pipelines', () => mockPipelinesExports);

import type { Firestore } from 'firebase/firestore';
import {
  PipelineUnsupportedError,
  buildPipeline,
  isPipelineSupported,
  sanitizeSearchDsl,
} from './pipeline-queries';

interface Stage {
  where: ReturnType<typeof vi.fn>;
  sort: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
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
    search: vi.fn(() => {
      calls.push('search');
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

  it('idIn with an empty list throws instead of silently full-scanning the collection', () => {
    const { db } = makeDb(true);
    expect(() => buildPipeline(db, { collection: 'pedidos', idIn: [] })).toThrow(/empty id list/);
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

  it('an object select entry projects field(x).as(y)', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'produtos/p1/historicoDeModificacoes',
      select: [{ field: 'changes.precos', as: 'change' }],
    });
    expect(stage.select).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'aliased',
        alias: 'change',
        expr: expect.objectContaining({ kind: 'field', name: 'changes.precos' }),
      }),
      expect.objectContaining({ kind: 'aliased', alias: 'rowId' }),
    );
  });

  it('mixes bare string and object select entries, plus the appended rowId', () => {
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'produtos/p1/historicoDeModificacoes',
      select: [{ field: 'changes.custo', as: 'change' }, 'timestamp'],
    });
    expect(stage.select).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'aliased', alias: 'change' }),
      'timestamp',
      expect.objectContaining({ kind: 'aliased', alias: 'rowId' }),
    );
  });

  it('rejects a select entry that would collide with the reserved rowId projection', () => {
    const { db } = makeDb(true);
    expect(() =>
      buildPipeline(db, {
        collection: 'produtos',
        select: [{ field: 'sku', as: 'rowId' }],
      }),
    ).toThrow(/reserved/);
    expect(() => buildPipeline(db, { collection: 'produtos', select: ['rowId'] })).toThrow(
      /reserved/,
    );
  });
});

describe('buildPipeline textSearch', () => {
  it('emits the search stage FIRST, ahead of every where', () => {
    // ⚠️ The one property that is not a preference: Firestore requires `search`
    // to sit next to the source. Emitting it after a `where` does not produce a
    // slower plan, it produces an invalid pipeline — so the ORDER is the
    // assertion here, not merely the presence of the stage.
    const { db, stage } = makeDb(true);
    buildPipeline(db, {
      collection: 'produtos',
      textSearch: { query: 'Gatinho' },
      filters: [{ field: 'paiId', op: 'eq', value: null }],
      orderBy: [{ field: 'nome', direction: 'asc' }],
      limit: 50,
    });

    expect(stage.__calls).toEqual(['search', 'where', 'sort', 'limit']);
    expect(stage.search).toHaveBeenCalledWith({
      query: { kind: 'documentMatches', rquery: 'Gatinho' },
    });
  });

  it('omits retrievalDepth entirely rather than sending undefined', () => {
    // Sending the key as `undefined` is not the same as leaving it off: the
    // backend default is what the measurement was taken against, and an
    // explicit undefined is a shape nobody probed.
    const { db, stage } = makeDb(true);
    buildPipeline(db, { collection: 'produtos', textSearch: { query: 'Bandeja' } });
    expect(stage.search.mock.calls[0]?.[0]).not.toHaveProperty('retrievalDepth');

    const segundo = makeDb(true);
    buildPipeline(segundo.db, {
      collection: 'produtos',
      textSearch: { query: 'Bandeja', retrievalDepth: 200 },
    });
    expect(segundo.stage.search).toHaveBeenCalledWith(
      expect.objectContaining({ retrievalDepth: 200 }),
    );
  });

  it('refuses to run textSearch and the substring search over one term', () => {
    const { db } = makeDb(true);
    expect(() =>
      buildPipeline(db, {
        collection: 'produtos',
        textSearch: { query: 'Gatinho' },
        search: { fields: ['nome'], term: 'Gatinho' },
      }),
    ).toThrow(/alternatives/);
  });
});

describe('sanitizeSearchDsl', () => {
  // ⚠️ BOTH HALVES, deliberately. This function decides which two terms are the
  // SAME query, and a test that only shows it folding cannot show where the fold
  // STOPS — the failure mode is folding too much, silently, which is why the
  // repo keeps an equivalence-fold inventory at all.

  it('folds a term whose operators the DSL would have read as syntax', () => {
    // The hazard, on a real catalogue name: the hyphen is documented negation,
    // so raw this asks for "Porta, but NOT lápis".
    expect(sanitizeSearchDsl('Porta-lápis')).toBe('Porta lápis');
    expect(sanitizeSearchDsl('Camiseta  Polo')).toBe('Camiseta Polo');
    expect(sanitizeSearchDsl('  Bandeja  ')).toBe('Bandeja');
    expect(sanitizeSearchDsl('"Camiseta" (Polo)')).toBe('Camiseta Polo');
  });

  it('keeps NEAR-MISSES distinct — the analyzer relates them, not this', () => {
    // Singular and plural must arrive as different DSL strings. Stemming is a
    // property of the pt-BR index and happens at QUERY time; folding them here
    // would move a measured backend behaviour into untested string code.
    expect(sanitizeSearchDsl('Camiseta')).not.toBe(sanitizeSearchDsl('Camisetas'));
    // Accents survive. Measured on staging, folding is INCONSISTENT across
    // words (`Leao` reaches `Leão`, `Ceramica` does not reach `Cerâmica`), so
    // stripping them here would replace a partial backend behaviour with a
    // total one and change which rows come back.
    expect(sanitizeSearchDsl('Leão')).toBe('Leão');
    expect(sanitizeSearchDsl('Leão')).not.toBe(sanitizeSearchDsl('Leao'));
    // Case survives too: the analyzer lowercases, this does not pretend to.
    expect(sanitizeSearchDsl('Bandeja')).not.toBe(sanitizeSearchDsl('bandeja'));
  });

  it('returns undefined when nothing searchable survives', () => {
    // A term of pure operators must not become the empty DSL string, which
    // `documentMatches('')` would send as a query matching who-knows-what.
    expect(sanitizeSearchDsl('')).toBeUndefined();
    expect(sanitizeSearchDsl('   ')).toBeUndefined();
    expect(sanitizeSearchDsl('---')).toBeUndefined();
    expect(sanitizeSearchDsl('"" ()')).toBeUndefined();
  });
});
