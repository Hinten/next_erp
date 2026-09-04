import { describe, expect, it } from 'vitest';

import {
  SHOPEE_INVOICE_ISSUER,
  SHOPEE_SHOP_STATUS,
  flatOp,
  shopeeEnvelopeSchema,
  shopeeProfileSchema,
  shopeeShopInfoSchema,
  shopeeShopStatusSchema,
  shopeeShopsByPartnerSchema,
  shopeeTokenResponseSchema,
  wrappedOp,
} from '../src/types';
import { z } from 'zod';

const SHOP_INFO = {
  error: '',
  request_id: 'req-1',
  shop_name: 'Loja de teste',
  region: 'BR',
  status: 'NORMAL',
  is_cb: false,
  auth_time: 1655714431,
  expire_time: 1687250431,
};

describe('the envelope', () => {
  it('REFUSES a body with no `error` field', () => {
    // ⚠️ The single most load-bearing assertion in this file. `error === ''` is
    // the success signal, so defaulting it would read an unknown body as a
    // successful call.
    const parsed = shopeeEnvelopeSchema.safeParse({ request_id: 'x' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.join('.'))).toContain('error');
  });

  it('defaults the other three to null and keeps unknown keys', () => {
    const parsed = shopeeEnvelopeSchema.parse({ error: '', campo_novo: 42 });
    expect(parsed.request_id).toBeNull();
    expect(parsed.message).toBeNull();
    expect(parsed.warning).toBeNull();
    expect((parsed as Record<string, unknown>).campo_novo).toBe(42);
  });

  it('treats `error: ""` and `error: " "` as DIFFERENT values', () => {
    // NEAR-MISS: both parse, and only one of them means success. The equality is
    // `api.ts`'s job; this pins that the schema does not trim them together.
    expect(shopeeEnvelopeSchema.parse({ error: '' }).error).toBe('');
    expect(shopeeEnvelopeSchema.parse({ error: ' ' }).error).toBe(' ');
    expect(shopeeEnvelopeSchema.parse({ error: '' }).error).not.toBe(
      shopeeEnvelopeSchema.parse({ error: ' ' }).error,
    );
  });
});

describe('flatOp / wrappedOp', () => {
  it('flatOp puts the operation fields beside the envelope', () => {
    const schema = flatOp({ campo: z.string() });
    const parsed = schema.parse({ error: '', campo: 'v' });
    expect(parsed.campo).toBe('v');
    expect(parsed.error).toBe('');
  });

  it('wrappedOp REQUIRES the response wrapper', () => {
    const schema = wrappedOp(z.object({ campo: z.string() }));
    expect(schema.safeParse({ error: '', campo: 'v' }).success).toBe(false);
    expect(schema.parse({ error: '', response: { campo: 'v' } }).response.campo).toBe('v');
  });
});

describe('the number fields tolerate a quoted number', () => {
  it('reads a stringified shop_id as a number', () => {
    const parsed = shopeeShopsByPartnerSchema.parse({
      error: '',
      more: false,
      authed_shop_list: [{ shop_id: '14701711', auth_time: '1655714431', expire_time: 1687250431 }],
    });
    expect(parsed.authed_shop_list[0]?.shop_id).toBe(14701711);
    expect(parsed.authed_shop_list[0]?.auth_time).toBe(1655714431);
    expect(parsed.authed_shop_list[0]?.region).toBeNull();
  });

  it('still REFUSES a value that is not unambiguously one number', () => {
    // NEAR-MISS to the one above: tolerance must not become coercion. `'0x1F'`
    // and `''` are the two shapes `z.coerce.number()` would silently invent a
    // value for (31 and 0).
    for (const bad of ['0x1F', '', '1 000', 'muitos']) {
      expect(
        shopeeShopsByPartnerSchema.safeParse({
          error: '',
          more: false,
          authed_shop_list: [{ shop_id: bad, auth_time: 1, expire_time: 2 }],
        }).success,
        `shop_id ${JSON.stringify(bad)} must not parse`,
      ).toBe(false);
    }
  });

  it('reads a quoted expire_in on the token response', () => {
    const parsed = shopeeTokenResponseSchema.parse({
      error: '',
      access_token: 'at',
      refresh_token: 'rt',
      expire_in: '14400',
    });
    expect(parsed.expire_in).toBe(14400);
    expect(parsed.shop_id_list).toBeNull();
    expect(parsed.merchant_id_list).toBeNull();
  });
});

describe('the enums', () => {
  it('rejects a lowercase status', () => {
    // NEAR-MISS: Shopee sends SHOUTING constants. A case-folded match would let a
    // typo'd value through as a real state.
    expect(shopeeShopStatusSchema.safeParse('NORMAL').success).toBe(true);
    expect(shopeeShopStatusSchema.safeParse('normal').success).toBe(false);
    expect(shopeeShopStatusSchema.safeParse('Normal').success).toBe(false);
  });

  it('keeps every companion member in step with the schema options', () => {
    expect([...Object.values(SHOPEE_SHOP_STATUS)].sort()).toEqual(
      [...shopeeShopStatusSchema.options].sort(),
    );
    expect([...Object.values(SHOPEE_INVOICE_ISSUER)].sort()).toEqual(['Other', 'Shopee']);
  });

  it('fails a shop-info body whose status is unknown', () => {
    expect(shopeeShopInfoSchema.safeParse({ ...SHOP_INFO, status: 'SUSPENDED' }).success).toBe(
      false,
    );
  });
});

describe('flat vs wrapped, per operation', () => {
  it('get_shop_info is FLAT', () => {
    const parsed = shopeeShopInfoSchema.parse(SHOP_INFO);
    expect(parsed.shop_name).toBe('Loja de teste');
    expect(parsed.status).toBe(SHOPEE_SHOP_STATUS.normal);
    expect(parsed.merchant_id).toBeNull();
  });

  it('get_profile is WRAPPED', () => {
    expect(
      shopeeProfileSchema.safeParse({ error: '', shop_name: 'Loja', description: null }).success,
    ).toBe(false);
    const parsed = shopeeProfileSchema.parse({
      error: '',
      response: { shop_name: 'Loja', invoice_issuer: 'Shopee' },
    });
    expect(parsed.response.shop_name).toBe('Loja');
    expect(parsed.response.invoice_issuer).toBe(SHOPEE_INVOICE_ISSUER.shopee);
    expect(parsed.response.shop_logo).toBeNull();
  });
});
