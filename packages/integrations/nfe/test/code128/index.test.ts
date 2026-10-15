import { describe, expect, it } from 'vitest';

import { encodeChaveNfeZpl } from '../../src/code128';

const NUMERIC = '35260514200166000187550010000000071000000018';
const ALFA = '352601ABCDEFGHIJKL87550010000001234567890120';

describe('encodeChaveNfeZpl', () => {
  it('keeps a numeric chave byte-identical in subset C', () => {
    expect(encodeChaveNfeZpl(NUMERIC)).toEqual({
      kind: 'numeric',
      payload: `>;${NUMERIC}`,
      modules: 277,
    });
  });

  it('switches C -> B -> C around the exact alphanumeric window', () => {
    expect(encodeChaveNfeZpl(ALFA)).toEqual({
      kind: 'mixed',
      payload: '>;352601>6ABCDEFGHIJKL>587550010000001234567890120',
      modules: 365,
    });
  });

  it.each([
    ['short', ALFA.slice(0, -1)],
    ['long', `${ALFA}0`],
    ['lowercase', ALFA.toLowerCase()],
    ['letter in numeric head', `A${ALFA.slice(1)}`],
    ['letter in numeric tail', `${ALFA.slice(0, -1)}A`],
  ])('refuses an invalid chave (%s)', (_case, chave) => {
    expect(encodeChaveNfeZpl(chave)).toBeNull();
  });
});
