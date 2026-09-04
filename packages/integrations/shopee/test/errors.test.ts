import { describe, expect, it } from 'vitest';

import {
  SHOPEE_AMBIGUOUS_AUTH_CODE,
  SHOPEE_ERROR_KIND,
  SHOPEE_SURFACE,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeHttpError,
  ShopeeNetworkError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  ShopeeSchemaError,
  classifyShopeeError,
  shopeeErrorFromEnvelope,
} from '../src/errors';

const envelope = (error: string, extra: Partial<{ message: string | null }> = {}) => ({
  error,
  message: extra.message ?? null,
  request_id: 'req-abc',
  warning: null,
});

describe('the class hierarchy', () => {
  it('roots every class at ShopeeError and sets a distinct name', () => {
    const cases: [ShopeeError, string][] = [
      [new ShopeeError('x'), 'ShopeeError'],
      [new ShopeeConfigError('x'), 'ShopeeConfigError'],
      [new ShopeeNetworkError('x'), 'ShopeeNetworkError'],
      [new ShopeeHttpError('x', { httpStatus: 502, path: '/p' }), 'ShopeeHttpError'],
      [new ShopeeSchemaError('x', { httpStatus: 200, path: '/p' }), 'ShopeeSchemaError'],
    ];
    for (const [err, name] of cases) {
      expect(err).toBeInstanceOf(ShopeeError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
    }
  });

  it('keeps the schema and network errors OUT of the ShopeeApiError branch', () => {
    // ⚠️ The callback route maps `ShopeeApiError` to "Shopee rejected it" and the
    // schema/network classes to different reasons. If either extended
    // `ShopeeApiError`, that `instanceof` chain would collapse them all into one.
    expect(new ShopeeSchemaError('x', { httpStatus: 200, path: '/p' })).not.toBeInstanceOf(
      ShopeeApiError,
    );
    expect(new ShopeeNetworkError('x')).not.toBeInstanceOf(ShopeeApiError);
    expect(new ShopeeHttpError('x', { httpStatus: 403, path: '/p' })).not.toBeInstanceOf(
      ShopeeApiError,
    );
  });

  it('keeps the narrowed `kind` on a rate-limit error (the `declare` regression)', () => {
    // ⚠️ Without `declare` on the subclass field, ES2022 class-field semantics
    // DEFINE `kind` as undefined after `super()` assigned it. This reads back the
    // value, which is the only way that regression is visible.
    const err = new ShopeeRateLimitError('x', {
      code: 'error_limit',
      kind: SHOPEE_ERROR_KIND.daily,
      httpStatus: 200,
      path: '/p',
      retryAfterSeconds: 30,
    });
    expect(err.kind).toBe('daily');
    expect(err.retryAfterSeconds).toBe(30);
    expect(err).toBeInstanceOf(ShopeeApiError);
  });

  it('defaults the optional carriers to null rather than undefined', () => {
    const err = new ShopeeApiError('x', {
      code: 'error_param',
      kind: SHOPEE_ERROR_KIND.other,
      httpStatus: 200,
      path: '/p',
    });
    expect(err.requestId).toBeNull();
    expect(err.warning).toBeNull();
    expect(
      new ShopeeRateLimitError('x', {
        code: 'error_rate_limit',
        kind: SHOPEE_ERROR_KIND.burst,
        httpStatus: 429,
        path: '/p',
      }).retryAfterSeconds,
    ).toBeNull();
  });

  it('copies `campos` instead of aliasing the caller array', () => {
    const campos = ['access_token'];
    const err = new ShopeeSchemaError('x', { campos, httpStatus: 200, path: '/p' });
    campos.push('mutated');
    expect(err.campos).toEqual(['access_token']);
  });
});

describe('classifyShopeeError', () => {
  it.each([
    'refresh_token_expired',
    'shop_access_expired',
    'shop_no_linked',
    'shop_banned',
    'error_shop_refresh_token',
  ])('classifies %s as reauth on both surfaces', (code) => {
    expect(classifyShopeeError(code, SHOPEE_SURFACE.auth)).toBe('reauth');
    expect(classifyShopeeError(code, SHOPEE_SURFACE.business)).toBe('reauth');
  });

  it('splits error_auth by surface', () => {
    // The one code whose meaning depends on the endpoint family.
    expect(classifyShopeeError(SHOPEE_AMBIGUOUS_AUTH_CODE, SHOPEE_SURFACE.auth)).toBe('reauth');
    expect(classifyShopeeError(SHOPEE_AMBIGUOUS_AUTH_CODE, SHOPEE_SURFACE.business)).toBe('other');
  });

  it('keeps the two rate-limit codes on DIFFERENT kinds', () => {
    // NEAR-MISS pair: same family, opposite retry advice. `error_rate_limit` may
    // be retried with backoff; `error_limit` must not be retried until 00:00 UTC+8.
    expect(classifyShopeeError('error_rate_limit', SHOPEE_SURFACE.business)).toBe('burst');
    expect(classifyShopeeError('error_limit', SHOPEE_SURFACE.business)).toBe('daily');
  });

  it('classifies the transient pair and the our-fault pair', () => {
    expect(classifyShopeeError('error_server', SHOPEE_SURFACE.business)).toBe('transient');
    expect(classifyShopeeError('error_network', SHOPEE_SURFACE.business)).toBe('transient');
    expect(classifyShopeeError('error_sign', SHOPEE_SURFACE.business)).toBe('other');
    expect(classifyShopeeError('error_param', SHOPEE_SURFACE.business)).toBe('other');
  });

  it('knows Shopee’s misspelling and NOT the corrected spelling', () => {
    // NEAR-MISS: `invalid_main_acount_id` is the wire value. The corrected
    // spelling is a code Shopee never sends, so it must fall through to 'other'
    // as an unknown — and the table must not quietly accept both.
    expect(classifyShopeeError('invalid_main_acount_id', SHOPEE_SURFACE.auth)).toBe('other');
    expect(classifyShopeeError('invalid_main_account_id', SHOPEE_SURFACE.auth)).toBe('other');
    expect(classifyShopeeError('invalid_code', SHOPEE_SURFACE.auth)).toBe('other');
    expect(classifyShopeeError('invalid_shop_id', SHOPEE_SURFACE.auth)).toBe('other');
  });

  it('maps an unknown code to other rather than guessing', () => {
    expect(classifyShopeeError('some_code_shopee_added_tomorrow', SHOPEE_SURFACE.business)).toBe(
      'other',
    );
    expect(classifyShopeeError('', SHOPEE_SURFACE.business)).toBe('other');
  });

  it('does not inherit Object.prototype keys through the lookup table', () => {
    // A plain-object table would answer `constructor` with a function; the kind
    // must still be a verdict.
    expect(classifyShopeeError('constructor', SHOPEE_SURFACE.business)).toBe('other');
    expect(classifyShopeeError('toString', SHOPEE_SURFACE.business)).toBe('other');
  });
});

describe('shopeeErrorFromEnvelope', () => {
  it('returns the reauth subclass and preserves the code', () => {
    const err = shopeeErrorFromEnvelope(envelope('refresh_token_expired'), {
      path: '/api/v2/auth/access_token/get',
      httpStatus: 200,
      surface: SHOPEE_SURFACE.auth,
    });
    expect(err).toBeInstanceOf(ShopeeReauthRequiredError);
    expect(err.code).toBe('refresh_token_expired');
    expect(err.kind).toBe('reauth');
    expect(err.requestId).toBe('req-abc');
    expect(err.httpStatus).toBe(200);
  });

  it('returns the rate-limit subclass carrying retryAfterSeconds', () => {
    const err = shopeeErrorFromEnvelope(envelope('error_rate_limit'), {
      path: '/api/v2/shop/get_shop_info',
      httpStatus: 429,
      surface: SHOPEE_SURFACE.business,
      retryAfterSeconds: 12,
    });
    expect(err).toBeInstanceOf(ShopeeRateLimitError);
    expect((err as ShopeeRateLimitError).retryAfterSeconds).toBe(12);
    expect(err.kind).toBe('burst');
  });

  it('returns the plain ApiError for everything else', () => {
    const err = shopeeErrorFromEnvelope(
      envelope('error_param', { message: 'shop_id is required' }),
      {
        path: '/api/v2/shop/get_shop_info',
        httpStatus: 200,
        surface: SHOPEE_SURFACE.business,
      },
    );
    expect(err).toBeInstanceOf(ShopeeApiError);
    expect(err).not.toBeInstanceOf(ShopeeReauthRequiredError);
    expect(err).not.toBeInstanceOf(ShopeeRateLimitError);
    expect(err.message).toContain('error_param');
    expect(err.message).toContain('shop_id is required');
    expect(err.message).toContain('/api/v2/shop/get_shop_info');
  });

  it('omits the dash when Shopee sent no message', () => {
    const err = shopeeErrorFromEnvelope(envelope('error_server'), {
      path: '/p',
      httpStatus: 500,
      surface: SHOPEE_SURFACE.business,
    });
    expect(err.message).not.toContain('—');
    expect(err.kind).toBe('transient');
  });
});
