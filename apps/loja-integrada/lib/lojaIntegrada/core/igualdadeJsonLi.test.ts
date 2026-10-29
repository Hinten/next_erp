/**
 * `deepEqual`, the one comparator of JSON values this app's write engine, its
 * flows and the fixture scanner share. Its SCOPE is the contract: key order is
 * the only thing it folds. Every pair below that must stay distinct is a value a
 * looser fold would have read as "already written" (and so skipped a write) or
 * as "unchanged" (and so let a leaked value through the scanner).
 */
import { describe, expect, it } from 'vitest';

import { deepEqual } from './igualdadeJsonLi';

describe('deepEqual — what it folds', () => {
  it('EQUAL pair: key order is ignored, at every depth', () => {
    expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(
      deepEqual(
        { x: { p: null, q: 'v' }, y: [{ k: 1, j: 2 }] },
        { y: [{ j: 2, k: 1 }], x: { q: 'v', p: null } },
      ),
    ).toBe(true);
  });

  it('EQUAL pair: the same primitive is the same value — a tracking code, a codigo, a number, a boolean, null', () => {
    expect(deepEqual('PJ1BR', 'PJ1BR')).toBe(true);
    expect(deepEqual('pedido_enviado', 'pedido_enviado')).toBe(true);
    expect(deepEqual(165, 165)).toBe(true);
    expect(deepEqual(false, false)).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual('', '')).toBe(true);
    expect(deepEqual([], [])).toBe(true);
    expect(deepEqual({}, {})).toBe(true);
  });
});

describe('deepEqual — what it must keep DISTINCT', () => {
  it.each([
    ['array order', [1, 2], [2, 1]],
    ['a number and its string', 1, '1'],
    ['a decimal string and its shorter form', '10.00', '10'],
    ['null and an empty string', '', null],
    ['an object and an array', {}, []],
    ['a trailing space', 'PJ1BR', 'PJ1BR '],
    ['another case', 'PJ1BR', 'pj1br'],
    ['a codigo in another case', 'pedido_enviado', 'Pedido_Enviado'],
    ['false and null', false, null],
    ['0 and false', 0, false],
    ['arrays of different length', [1], [1, 1]],
  ] as const)('⚠️ NEAR-MISS: %s stays distinct', (_caso, a, b) => {
    expect(deepEqual(a, b)).toBe(false);
    expect(deepEqual(b, a)).toBe(false);
  });

  it('⚠️ NEAR-MISS: null and an ABSENT key stay distinct, and so do two different absent keys', () => {
    expect(deepEqual({ objeto: null }, {})).toBe(false);
    expect(deepEqual({}, { objeto: null })).toBe(false);
    expect(deepEqual({ a: null }, { b: null })).toBe(false);
    // A top-level absent value is not null either.
    expect(deepEqual(undefined, null)).toBe(false);
  });

  it('⚠️ NEAR-MISS: a nested difference anywhere is a difference', () => {
    expect(
      deepEqual({ envios: [{ id: 1, objeto: 'A' }] }, { envios: [{ id: 1, objeto: 'B' }] }),
    ).toBe(false);
    expect(deepEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 1, d: 2 } } })).toBe(false);
  });

  it('⚠️ NEAR-MISS: a key inherited from the prototype is not an own key', () => {
    // `toString` is on every object's prototype: an own-key compare never sees it.
    expect(deepEqual({ toString: 1 }, {})).toBe(false);
    expect(deepEqual({}, { constructor: null })).toBe(false);
  });
});
