import { describe, expect, it } from 'vitest';

import { buildModificationEntry } from './modificationHistory';

const base = {
  path: 'produtos/p1',
  subcolecao: null,
  docId: 'p1',
  eventId: 'evt1',
  eventTimeMicros: 1_000_000,
};

describe('buildModificationEntry — kind', () => {
  it('is "create" when before is undefined', () => {
    const entry = buildModificationEntry({
      ...base,
      before: undefined,
      after: { nome: 'Produto' },
      ignore: [],
    });
    expect(entry?.kind).toBe('create');
  });

  it('is "delete" when after is undefined', () => {
    const entry = buildModificationEntry({
      ...base,
      before: { nome: 'Produto' },
      after: undefined,
      ignore: [],
    });
    expect(entry?.kind).toBe('delete');
  });

  it('is "update" when both revisions are present', () => {
    const entry = buildModificationEntry({
      ...base,
      before: { nome: 'A' },
      after: { nome: 'B' },
      ignore: [],
    });
    expect(entry?.kind).toBe('update');
  });
});

describe('buildModificationEntry — ignore / null-on-empty-diff', () => {
  it('returns null when every changed field sits in `ignore`', () => {
    const entry = buildModificationEntry({
      ...base,
      before: { timestamp: 1, nome: 'igual' },
      after: { timestamp: 2, nome: 'igual' },
      ignore: ['timestamp'],
    });
    expect(entry).toBeNull();
  });

  it('returns null when nothing changed at all', () => {
    const entry = buildModificationEntry({
      ...base,
      before: { nome: 'igual' },
      after: { nome: 'igual' },
      ignore: [],
    });
    expect(entry).toBeNull();
  });

  it('reports only the non-ignored field when a mix changes', () => {
    const entry = buildModificationEntry({
      ...base,
      before: { nome: 'A', timestamp: 1 },
      after: { nome: 'B', timestamp: 2 },
      ignore: ['timestamp'],
    });
    expect(entry?.campos).toEqual(['nome']);
  });
});

describe('buildModificationEntry — undefined coercion', () => {
  it('coerces a field missing from `after` to null on the "new" side', () => {
    const entry = buildModificationEntry({
      ...base,
      before: { extra: 'x' },
      after: {},
      ignore: [],
    });
    expect(entry?.changes.extra).toEqual({ old: 'x', new: null });
  });

  it('coerces a field missing from `before` to null on the "old" side', () => {
    const entry = buildModificationEntry({
      ...base,
      before: {},
      after: { extra: 'x' },
      ignore: [],
    });
    expect(entry?.changes.extra).toEqual({ old: null, new: 'x' });
  });
});

describe('buildModificationEntry — path/subcolecao/docId/eventId/timestamp threading', () => {
  it('threads every identifying field onto the built entry unchanged', () => {
    const entry = buildModificationEntry({
      before: { nome: 'A' },
      after: { nome: 'B' },
      ignore: [],
      path: 'produtos/p1/estoques/e1',
      subcolecao: 'estoques',
      docId: 'e1',
      eventId: 'evt-xyz',
      eventTimeMicros: 424_242_000,
    });
    expect(entry).toMatchObject({
      path: 'produtos/p1/estoques/e1',
      subcolecao: 'estoques',
      docId: 'e1',
      eventId: 'evt-xyz',
      timestamp: 424_242_000,
    });
  });

  it('threads a null subcolecao unchanged (document IS the produto)', () => {
    const entry = buildModificationEntry({
      ...base,
      before: { nome: 'A' },
      after: { nome: 'B' },
      ignore: [],
    });
    expect(entry?.subcolecao).toBeNull();
  });
});
