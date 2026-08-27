import { describe, expect, it } from 'vitest';

import { isValidMlbItemId, maskMlbItemId } from './itemId';

describe('maskMlbItemId', () => {
  const cases: Array<[string, string]> = [
    ['MLB-5146021467', 'MLB5146021467'],
    ['mlb5146021467', 'MLB5146021467'],
    ['  MLB 5146021467  ', 'MLB5146021467'],
    ['MLB5146021467', 'MLB5146021467'],
    ['https://produto.mercadolivre.com.br/MLB-5146021467', 'MLB5146021467'],
    ['https://www.mercadolivre.com.br/p/MLB5146021467', 'MLB5146021467'],
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

  it('is idempotent', () => {
    for (const [raw] of cases) {
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
