/**
 * The listings flows' shared outcome watermark, pure: strictly newer wins, an
 * equal `emMs` keeps the stored, and a stored value with no readable `emMs` is
 * no watermark. The stock binding (`estoque/envioEstoque.ts`) answers exactly
 * what the shared rule answers.
 */
import { describe, expect, it } from 'vitest';

import { decidirGravacaoEnvioEstoque, envioDoPatch } from '../estoque/envioEstoque';
import { decidirGravacaoEnvioListing } from './envioListing';

const T = 1_800_000_000_000;

describe('★ the watermark: strictly newer emMs wins, equal keeps', () => {
  it.each<[string, number, boolean]>([
    ['a stored emMs one ms OLDER ⇒ replaced', T - 1, true],
    ['NEAR-MISS: an EQUAL stored emMs ⇒ the stored is kept', T, false],
    ['a stored emMs one ms NEWER ⇒ kept', T + 1, false],
  ])('%s', (_c, armazenadoMs, escreve) => {
    expect(decidirGravacaoEnvioListing({ emMs: armazenadoMs }, { emMs: T })).toBe(escreve);
  });

  it.each<[string, unknown]>([
    ['nothing stored', null],
    ['an absent field', undefined],
    ['not an object', 'x'],
    ['no emMs', { via: 'patch' }],
    ['a negative emMs', { emMs: -1 }],
    ['a fractional emMs', { emMs: T + 0.5 }],
    ['an unsafe emMs', { emMs: Number.MAX_SAFE_INTEGER + 2 }],
    ['an emMs as text', { emMs: String(T + 5) }],
  ])('a stored value with no readable emMs (%s) is no watermark: replaced', (_c, armazenado) => {
    expect(decidirGravacaoEnvioListing(armazenado, { emMs: T })).toBe(true);
  });

  it('NEAR-MISS: a readable 0 IS a watermark (an emMs of 0 only replaces nothing newer)', () => {
    expect(decidirGravacaoEnvioListing({ emMs: 0 }, { emMs: 0 })).toBe(false);
    expect(decidirGravacaoEnvioListing({ emMs: 0 }, { emMs: 1 })).toBe(true);
  });

  it('reads only emMs: any other field of either side changes nothing', () => {
    expect(decidirGravacaoEnvioListing({ emMs: T, via: 'feed' }, { emMs: T })).toBe(false);
    expect(decidirGravacaoEnvioListing({ emMs: T - 1, resultado: 'aceito' }, { emMs: T })).toBe(
      true,
    );
  });
});

describe('the stock binding answers the shared rule', () => {
  it.each([T - 1, T, T + 1, null])('stored %s', (armazenadoMs) => {
    const novo = envioDoPatch({ status: 'ACCEPTED', submissionId: 's' }, T, 3);
    const armazenado = armazenadoMs === null ? null : { emMs: armazenadoMs };
    expect(decidirGravacaoEnvioEstoque(armazenado, novo)).toBe(
      decidirGravacaoEnvioListing(armazenado, novo),
    );
  });
});
