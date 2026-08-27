import { describe, expect, it } from 'vitest';

import { isPartialMlbItemId, isValidMlbItemId, maskMlbItemId } from './itemId';

describe('maskMlbItemId', () => {
  const cases: Array<[string, string]> = [
    ['MLB-5146021467', 'MLB5146021467'],
    ['mlb5146021467', 'MLB5146021467'],
    ['  MLB 5146021467  ', 'MLB5146021467'],
    ['MLB5146021467', 'MLB5146021467'],
    ['M', 'M'],
    ['ML', 'ML'],
    ['MLB', 'MLB'],
    ['5146021467', '5146021467'],
    ['', ''],
    ['---', ''],
  ];

  it.each(cases)('normalises %j to %j', (raw, expected) => {
    expect(maskMlbItemId(raw)).toBe(expected);
  });

  /**
   * ⚠️ The regression this file exists for. A real `item.permalink` carries a
   * SLUG, and a URL copied from the browser (or from the app's own "ver no
   * Mercado Livre" anchor) carries a `#position=…&tracking_id=…` fragment too.
   * Collecting every digit after `MLB` turns those into `MLB514602146742` — a
   * value that still passes `isValidMlbItemId`, so the submit gate lets it
   * through, ML 404s, and the doc id hashes to a different key.
   */
  const permalinks: Array<[string, string]> = [
    ['https://produto.mercadolivre.com.br/MLB-5146021467', 'MLB5146021467'],
    ['https://www.mercadolivre.com.br/p/MLB5146021467', 'MLB5146021467'],
    [
      'https://produto.mercadolivre.com.br/MLB-5146021467-camiseta-preta-tamanho-42-_JM',
      'MLB5146021467',
    ],
    [
      'https://produto.mercadolivre.com.br/MLB-5146021467-titulo-_JM#position=1&tracking_id=8f1a',
      'MLB5146021467',
    ],
    [
      'https://www.mercadolivre.com.br/camiseta/p/MLB5146021467#polycard&position=2',
      'MLB5146021467',
    ],
    // A slug whose FIRST token is numeric — the digit run must stop at the hyphen.
    ['https://produto.mercadolivre.com.br/MLB-5146021467-2-unidades-camiseta-_JM', 'MLB5146021467'],
    // `MLB` appearing again inside the tracking fragment must not win.
    ['https://produto.mercadolivre.com.br/MLB-5146021467-x-_JM#tracking_id=MLB99', 'MLB5146021467'],
  ];

  it.each(permalinks)('reads the id out of %j', (raw, expected) => {
    expect(maskMlbItemId(raw)).toBe(expected);
    expect(isValidMlbItemId(maskMlbItemId(raw))).toBe(true);
  });

  it('is idempotent', () => {
    for (const [raw] of [...cases, ...permalinks]) {
      const once = maskMlbItemId(raw);
      expect(maskMlbItemId(once)).toBe(once);
    }
  });

  // ⚠️ Another site's id must NOT survive as an id — this backend serves MLB only,
  // and an MLU listing would half-import with a link doc stamped `MLB`.
  it('strips a non-MLB site prefix so it cannot validate', () => {
    expect(maskMlbItemId('MLU5146021467')).toBe('5146021467');
    expect(isValidMlbItemId(maskMlbItemId('MLU5146021467'))).toBe(false);
    expect(isValidMlbItemId(maskMlbItemId('MLA-5146021467'))).toBe(false);
    // Not an MLB id either: `MLB` must be followed by the digits, not by a letter.
    expect(maskMlbItemId('MLBU5146021467')).toBe('5146021467');
    expect(isValidMlbItemId(maskMlbItemId('MLBU5146021467'))).toBe(false);
  });
});

describe('isValidMlbItemId', () => {
  it('accepts a realistic id', () => {
    expect(isValidMlbItemId('MLB5146021467')).toBe(true);
    expect(isValidMlbItemId('MLB123456')).toBe(true);
  });

  it('rejects partials, bare digits and anything unnormalised', () => {
    expect(isValidMlbItemId('')).toBe(false);
    expect(isValidMlbItemId('MLB')).toBe(false);
    expect(isValidMlbItemId('MLB12345')).toBe(false);
    expect(isValidMlbItemId('5146021467')).toBe(false);
    expect(isValidMlbItemId('mlb5146021467')).toBe(false);
    expect(isValidMlbItemId('MLB-5146021467')).toBe(false);
  });
});

describe('isPartialMlbItemId', () => {
  it('stays true for every prefix of a valid id, so typing never flags an error', () => {
    const alvo = 'MLB5146021467';
    for (let i = 1; i < alvo.length; i += 1) {
      expect(isPartialMlbItemId(alvo.slice(0, i))).toBe(true);
    }
  });

  it('is false once the value can never become an MLB id', () => {
    expect(isPartialMlbItemId('5146021467')).toBe(false);
    expect(isPartialMlbItemId('MLBX')).toBe(false);
  });
});
