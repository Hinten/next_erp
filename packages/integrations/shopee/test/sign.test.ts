import { describe, expect, it } from 'vitest';

import {
  SHOPEE_SIGN_WINDOW_SECONDS,
  merchantBaseString,
  publicBaseString,
  shopBaseString,
  shopeeTimestamp,
  signBaseString,
  signedQuery,
} from '../src/sign';

/**
 * ⚠️ Invented. Not a Shopee credential, and nothing in this file may be replaced
 * with a real partner key.
 */
const TEST_PARTNER_KEY = 'chave-de-teste-nao-e-credencial';

/**
 * Shopee's own PUBLISHED documentation sample (`guide 16`). The partner id,
 * timestamp, access token and shop id below are the values printed in that
 * public example — they authorise nothing and there is no key in it.
 */
const DOC_PARTNER_ID = 2001887;
const DOC_TIMESTAMP = 1655714431;
const DOC_ACCESS_TOKEN = '59777174636562737266615546704c6d';
const DOC_SHOP_ID = 14701711;

const SHOP_INFO_PATH = '/api/v2/shop/get_shop_info';
const SHOPS_BY_PARTNER_PATH = '/api/v2/public/get_shops_by_partner';

describe('the base strings', () => {
  it('matches the published PUBLIC vector', () => {
    expect(
      publicBaseString({
        partnerId: DOC_PARTNER_ID,
        path: SHOPS_BY_PARTNER_PATH,
        timestamp: DOC_TIMESTAMP,
      }),
    ).toBe('2001887/api/v2/public/get_shops_by_partner1655714431');
  });

  it('matches the published SHOP vector', () => {
    expect(
      shopBaseString({
        partnerId: DOC_PARTNER_ID,
        path: SHOP_INFO_PATH,
        timestamp: DOC_TIMESTAMP,
        accessToken: DOC_ACCESS_TOKEN,
        shopId: DOC_SHOP_ID,
      }),
    ).toBe('2001887/api/v2/shop/get_shop_info165571443159777174636562737266615546704c6d14701711');
  });

  it('uses NO separator between the parts', () => {
    // NEAR-MISS: the two spellings a reader would guess. Both produce a
    // well-formed signature that Shopee answers with `error_sign`.
    const parts = [String(DOC_PARTNER_ID), SHOP_INFO_PATH, String(DOC_TIMESTAMP)];
    const real = publicBaseString({
      partnerId: DOC_PARTNER_ID,
      path: SHOP_INFO_PATH,
      timestamp: DOC_TIMESTAMP,
    });
    expect(real).not.toBe(parts.join('|'));
    expect(real).not.toBe(parts.join('&'));
    expect(real).toBe(parts.join(''));
  });

  it('keeps the shop and merchant base strings distinct', () => {
    // NEAR-MISS: same partner, path, timestamp, token and numeric id — only the
    // id CLASS differs, and the two strings are byte-identical if the caller
    // picks the wrong builder. They must still be told apart by which id the
    // caller meant, which is what the union in `SignedCall` enforces.
    const common = { partnerId: DOC_PARTNER_ID, path: SHOP_INFO_PATH, timestamp: DOC_TIMESTAMP };
    expect(shopBaseString({ ...common, accessToken: 'tok', shopId: 1 })).toBe(
      merchantBaseString({ ...common, accessToken: 'tok', merchantId: 1 }),
    );
    expect(shopBaseString({ ...common, accessToken: 'tok', shopId: 1 })).not.toBe(
      merchantBaseString({ ...common, accessToken: 'tok', merchantId: 2 }),
    );
  });
});

describe('signBaseString', () => {
  it('reproduces RFC 4231 HMAC-SHA256 test case 2', () => {
    // A known-answer test for the primitive itself, so a wrong digest algorithm
    // or encoding cannot hide behind our own fixtures.
    expect(signBaseString('what do ya want for nothing?', 'Jefe')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('is lowercase hex, 64 characters', () => {
    const sign = signBaseString('qualquer coisa', TEST_PARTNER_KEY);
    expect(sign).toMatch(/^[0-9a-f]{64}$/);
    expect(sign).toBe(sign.toLowerCase());
  });
});

describe('shopeeTimestamp', () => {
  it('is Unix seconds, floored', () => {
    expect(shopeeTimestamp(1_655_714_431_000)).toBe(DOC_TIMESTAMP);
    expect(shopeeTimestamp(1_655_714_431_999)).toBe(DOC_TIMESTAMP);
    expect(shopeeTimestamp(1_655_714_432_000)).toBe(DOC_TIMESTAMP + 1);
  });

  it('documents the accepted window', () => {
    expect(SHOPEE_SIGN_WINDOW_SECONDS).toBe(300);
  });
});

describe('signedQuery', () => {
  const base = {
    partnerId: DOC_PARTNER_ID,
    partnerKey: TEST_PARTNER_KEY,
    nowMs: 1_655_714_431_000,
  };

  it('puts exactly the three common params on a PUBLIC call', () => {
    const qs = signedQuery({ ...base, path: SHOPS_BY_PARTNER_PATH, call: { class: 'public' } });
    expect([...qs.keys()].sort()).toEqual(['partner_id', 'sign', 'timestamp']);
    expect(qs.get('partner_id')).toBe('2001887');
    expect(qs.get('timestamp')).toBe('1655714431');
    expect(qs.get('access_token')).toBeNull();
    expect(qs.get('shop_id')).toBeNull();
  });

  it('adds access_token and shop_id on a SHOP call', () => {
    const qs = signedQuery({
      ...base,
      path: SHOP_INFO_PATH,
      call: { class: 'shop', accessToken: DOC_ACCESS_TOKEN, shopId: DOC_SHOP_ID },
    });
    expect([...qs.keys()].sort()).toEqual([
      'access_token',
      'partner_id',
      'shop_id',
      'sign',
      'timestamp',
    ]);
    expect(qs.get('access_token')).toBe(DOC_ACCESS_TOKEN);
    expect(qs.get('shop_id')).toBe('14701711');
    expect(qs.get('sign')).toBe(
      signBaseString(
        shopBaseString({
          partnerId: DOC_PARTNER_ID,
          path: SHOP_INFO_PATH,
          timestamp: DOC_TIMESTAMP,
          accessToken: DOC_ACCESS_TOKEN,
          shopId: DOC_SHOP_ID,
        }),
        TEST_PARTNER_KEY,
      ),
    );
  });

  it('adds merchant_id, not shop_id, on a MERCHANT call', () => {
    const qs = signedQuery({
      ...base,
      path: SHOP_INFO_PATH,
      call: { class: 'merchant', accessToken: DOC_ACCESS_TOKEN, merchantId: 987 },
    });
    expect(qs.get('merchant_id')).toBe('987');
    expect(qs.get('shop_id')).toBeNull();
  });

  it('carries extras and drops undefined ones, without changing the sign', () => {
    // ⚠️ The signature covers neither the other query params nor a body. Two
    // calls that differ only in their extras have the SAME sign, and a future
    // reader must not "fix" that.
    const plain = signedQuery({
      ...base,
      path: SHOPS_BY_PARTNER_PATH,
      call: { class: 'public' },
    });
    const withExtras = signedQuery({
      ...base,
      path: SHOPS_BY_PARTNER_PATH,
      call: { class: 'public' },
      extra: { page_size: 100, page_no: 1, ausente: undefined },
    });
    expect(withExtras.get('page_size')).toBe('100');
    expect(withExtras.get('page_no')).toBe('1');
    expect(withExtras.has('ausente')).toBe(false);
    expect(withExtras.get('sign')).toBe(plain.get('sign'));
  });

  it('changes the sign when the clock moves by one second', () => {
    const a = signedQuery({ ...base, path: SHOP_INFO_PATH, call: { class: 'public' } });
    const b = signedQuery({
      ...base,
      nowMs: base.nowMs + 1000,
      path: SHOP_INFO_PATH,
      call: { class: 'public' },
    });
    expect(a.get('sign')).not.toBe(b.get('sign'));
  });

  it('changes the sign when the access token changes', () => {
    const call = (accessToken: string) =>
      signedQuery({
        ...base,
        path: SHOP_INFO_PATH,
        call: { class: 'shop', accessToken, shopId: DOC_SHOP_ID },
      }).get('sign');
    expect(call('token-a')).not.toBe(call('token-b'));
  });

  it('never puts the partner key in the query', () => {
    const qs = signedQuery({
      ...base,
      path: SHOP_INFO_PATH,
      call: { class: 'shop', accessToken: DOC_ACCESS_TOKEN, shopId: DOC_SHOP_ID },
      extra: { page_size: 50 },
    });
    for (const value of qs.values()) expect(value).not.toContain(TEST_PARTNER_KEY);
    expect(qs.toString()).not.toContain(TEST_PARTNER_KEY);
  });
});
