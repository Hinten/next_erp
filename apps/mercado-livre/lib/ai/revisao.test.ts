import { describe, expect, it } from 'vitest';

import { MAX_ANTERIOR, normalizarAnterior } from './revisao';

describe('normalizarAnterior', () => {
  it('keeps a well-formed entry verbatim', () => {
    expect(
      normalizarAnterior([{ id: 'BRAND', value_id: '123', value_name: 'Nike', unit_id: null }]),
    ).toEqual([{ id: 'BRAND', value_id: '123', value_name: 'Nike', unit_id: null }]);
  });

  // The crash Copilot found: the route used to cast the raw array, and
  // `buildAttributePrompt` maps `a.id` over it — one null turned a hand-made
  // body into a 500.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'BRAND'],
    ['a number', 7],
    ['an array', ['BRAND', 'Nike']],
  ])('drops %s instead of throwing on it', (_label, junk) => {
    expect(normalizarAnterior([junk])).toEqual([]);
  });

  it('drops an entry with no usable id', () => {
    expect(
      normalizarAnterior([
        { id: '', value_name: 'Nike' },
        { id: '   ', value_name: 'Nike' },
        { id: 42, value_name: 'Nike' },
        { value_name: 'Nike' },
      ]),
    ).toEqual([]);
  });

  it('drops an entry whose value_name is not text', () => {
    expect(
      normalizarAnterior([
        { id: 'BRAND', value_name: null },
        { id: 'BRAND', value_name: 12 },
        { id: 'BRAND' },
      ]),
    ).toEqual([]);
  });

  // One bad row must not lose the operator's whole correction — the same
  // tolerance `applyAiAttributes` already applies to model output.
  it('keeps the good entries alongside a bad one', () => {
    expect(normalizarAnterior([{ id: 'BRAND', value_name: 'Nike' }, null, 'x'])).toEqual([
      { id: 'BRAND', value_id: null, value_name: 'Nike', unit_id: null },
    ]);
  });

  it('coerces a non-string value_id/unit_id to null rather than forwarding it', () => {
    expect(
      normalizarAnterior([{ id: 'LENGTH', value_id: 99, value_name: '30', unit_id: {} }]),
    ).toEqual([{ id: 'LENGTH', value_id: null, value_name: '30', unit_id: null }]);
  });

  it('answers with an empty list for anything that is not an array', () => {
    expect(normalizarAnterior(undefined)).toEqual([]);
    expect(normalizarAnterior(null)).toEqual([]);
    expect(normalizarAnterior({ id: 'BRAND', value_name: 'Nike' })).toEqual([]);
  });

  it('caps well above a legitimate answer, which the response schema bounds at 40', () => {
    expect(MAX_ANTERIOR).toBeGreaterThan(40);
  });
});
