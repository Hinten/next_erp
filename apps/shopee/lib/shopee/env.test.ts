import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SHOPEE_PROD_API_HOST,
  SHOPEE_PROD_AUTH_HOST,
  SHOPEE_SANDBOX_API_HOST,
  SHOPEE_SANDBOX_AUTH_HOST,
  ShopeeConfigError,
} from '@delfrance/integrations-shopee';

import {
  shopeeConfig,
  shopeeHosts,
  shopeeRedirectUri,
  shopeeSandbox,
  shopeeStateSecret,
  webBase,
} from './env';

beforeEach(() => {
  vi.stubEnv('SHOPEE_PARTNER_ID', '1234567');
  vi.stubEnv('SHOPEE_PARTNER_KEY', 'chave-de-teste');
  vi.stubEnv('SHOPEE_STATE_SECRET', 'segredo-de-teste');
  vi.stubEnv('SHOPEE_SANDBOX', '');
  vi.stubEnv('SHOPEE_PUBLIC_URL', '');
  vi.stubEnv('SHOPEE_API_HOST', '');
  vi.stubEnv('SHOPEE_AUTH_HOST', '');
  vi.stubEnv('WEB_APP_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('shopeeSandbox — opt-in, exactly "1"', () => {
  // ⚠️ The polarity is INVERTED relative to MELHOR_ENVIO_SANDBOX. Production
  // reuses the live legacy Shopee application, so anything that is not the
  // literal '1' must resolve to PRODUCTION — including plausible-looking
  // truthy spellings an operator might reach for.
  it.each([
    ['1', true],
    ['true', false],
    ['TRUE', false],
    ['yes', false],
    ['0', false],
    ['', false],
    [' 1 ', false],
  ])('SHOPEE_SANDBOX=%j → %s', (value, expected) => {
    vi.stubEnv('SHOPEE_SANDBOX', value);
    expect(shopeeSandbox()).toBe(expected);
  });

  it('is production when the variable is not set at all', () => {
    vi.stubEnv('SHOPEE_SANDBOX', undefined);
    expect(shopeeSandbox()).toBe(false);
  });
});

describe('shopeeHosts', () => {
  it('uses the production defaults when the flag is off', () => {
    const hosts = shopeeHosts();
    expect(hosts.apiHost).toBe(SHOPEE_PROD_API_HOST);
    expect(hosts.authHost).toBe(SHOPEE_PROD_AUTH_HOST);
    expect(hosts.authorizeUrlBase).toBe(`${SHOPEE_PROD_AUTH_HOST}/auth`);
  });

  it('uses the sandbox defaults when SHOPEE_SANDBOX=1', () => {
    vi.stubEnv('SHOPEE_SANDBOX', '1');
    const hosts = shopeeHosts();
    expect(hosts.apiHost).toBe(SHOPEE_SANDBOX_API_HOST);
    expect(hosts.authHost).toBe(SHOPEE_SANDBOX_AUTH_HOST);
  });

  it('lets an explicit override win over the flag, independently per host', () => {
    vi.stubEnv('SHOPEE_SANDBOX', '1');
    vi.stubEnv('SHOPEE_API_HOST', 'https://proxy.example.com');
    const hosts = shopeeHosts();
    expect(hosts.apiHost).toBe('https://proxy.example.com');
    // The consent host is untouched — that is the shape a proxied API egress needs.
    expect(hosts.authHost).toBe(SHOPEE_SANDBOX_AUTH_HOST);
  });

  it('treats a BLANK override as unset rather than as an empty host', () => {
    // The near miss: `??` would pass '' straight into resolveShopeeHosts, which
    // rejects it — turning a blank line in .env.local into a hard config error
    // instead of the documented default.
    vi.stubEnv('SHOPEE_API_HOST', '   ');
    expect(shopeeHosts().apiHost).toBe(SHOPEE_PROD_API_HOST);
  });
});

describe('shopeeRedirectUri', () => {
  it('falls back to an ABSOLUTE localhost URL when SHOPEE_PUBLIC_URL is blank', () => {
    // Blank must behave exactly like unset. A `??` here would produce the
    // RELATIVE '/api/oauth/shopee/callback', which Shopee rejects as a
    // redirect-domain mismatch with nothing in our logs.
    expect(shopeeRedirectUri()).toBe('http://localhost:3009/api/oauth/shopee/callback');
  });

  it('strips a trailing slash from the configured public URL', () => {
    vi.stubEnv('SHOPEE_PUBLIC_URL', 'https://shopee.example.com/');
    expect(shopeeRedirectUri()).toBe('https://shopee.example.com/api/oauth/shopee/callback');
  });
});

describe('webBase', () => {
  it('falls back to localhost:3000 when WEB_APP_URL is blank', () => {
    expect(webBase()).toBe('http://localhost:3000');
  });

  it('strips a trailing slash', () => {
    vi.stubEnv('WEB_APP_URL', 'https://erp.example.com/');
    expect(webBase()).toBe('https://erp.example.com');
  });
});

describe('shopeeStateSecret', () => {
  it('returns the trimmed secret', () => {
    vi.stubEnv('SHOPEE_STATE_SECRET', '  s3gr3d0  ');
    expect(shopeeStateSecret()).toBe('s3gr3d0');
  });

  it('is null for a blank value, so callers can answer 500 / reason=config', () => {
    vi.stubEnv('SHOPEE_STATE_SECRET', '   ');
    expect(shopeeStateSecret()).toBeNull();
  });
});

describe('shopeeConfig', () => {
  it('parses a valid partner id and carries the resolved hosts', () => {
    const config = shopeeConfig();
    expect(config.partnerId).toBe(1234567);
    expect(config.partnerKey).toBe('chave-de-teste');
    expect(config.sandbox).toBe(false);
    expect(config.hosts.apiHost).toBe(SHOPEE_PROD_API_HOST);
    expect(config.redirectUri).toBe('http://localhost:3009/api/oauth/shopee/callback');
  });

  it.each([
    ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_ID'],
    ['SHOPEE_PARTNER_KEY', 'SHOPEE_PARTNER_KEY'],
  ])('throws naming %s when it is blank', (envVar, named) => {
    vi.stubEnv(envVar, '   ');
    expect(() => shopeeConfig()).toThrow(ShopeeConfigError);
    expect(() => shopeeConfig()).toThrow(named);
  });

  it.each(['123abc', '  ', '12.5', '-1', '1e3', '0'])(
    'rejects the partner id %j instead of silently truncating it',
    (raw) => {
      // `parseInt('123abc')` answers 123 and signs cleanly; the only symptom
      // would be `error_sign` on every call, pointing nowhere near this var.
      vi.stubEnv('SHOPEE_PARTNER_ID', raw);
      expect(() => shopeeConfig()).toThrow(ShopeeConfigError);
    },
  );

  it('never puts the partner key in the error message', () => {
    vi.stubEnv('SHOPEE_PARTNER_ID', 'nope');
    try {
      shopeeConfig();
      expect.unreachable('shopeeConfig deveria ter lançado');
    } catch (err) {
      if (!(err instanceof ShopeeConfigError)) throw err;
      expect(err.message).not.toContain('chave-de-teste');
    }
  });
});
