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
  shopeePushCallbackUrl,
  shopeeRedirectUri,
  shopeeSandbox,
  shopeeStateSecret,
  shopeeVariationsPath,
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
  vi.stubEnv('SHOPEE_VARIATIONS_PATH', '');
  vi.stubEnv('WEB_APP_URL', '');
  vi.stubEnv('SHOPEE_PUSH_CALLBACK_URL', '');
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

describe('shopeeVariationsPath', () => {
  it('is null when the variable is not set at all', () => {
    vi.stubEnv('SHOPEE_VARIATIONS_PATH', undefined);
    expect(shopeeVariationsPath()).toBeNull();
  });

  it('is null for a blank value, so the package keeps its default path', () => {
    // A `??` here would pass '' to the client as an override, and the path sits
    // INSIDE the HMAC base string — the symptom would be `error_sign` on every
    // `get_variations` call, reading exactly like a bad partner key.
    vi.stubEnv('SHOPEE_VARIATIONS_PATH', '   ');
    expect(shopeeVariationsPath()).toBeNull();
  });

  it('passes a configured path through untouched, shape and all', () => {
    vi.stubEnv('SHOPEE_VARIATIONS_PATH', '  /api/v2/product/get_variation_tree  ');
    expect(shopeeVariationsPath()).toBe('/api/v2/product/get_variation_tree');
  });

  it.each(['api/v2/product/get_variations', 'https://partner.shopeemobile.com/api/v2/x', '/x?a=1'])(
    "does NOT validate the shape of %j — that is the package's job",
    (raw) => {
      // The near miss: every one of these is REJECTED downstream by
      // `normalizeApiPath`, which raises a ShopeeConfigError naming this
      // variable. Re-checking them here would be a second copy of that rule,
      // drifting, and only for callers who came through apps/shopee.
      vi.stubEnv('SHOPEE_VARIATIONS_PATH', raw);
      expect(shopeeVariationsPath()).toBe(raw);
    },
  );
});

describe('shopeeConfig', () => {
  it('parses a valid partner id and carries the resolved hosts', () => {
    const config = shopeeConfig();
    expect(config.partnerId).toBe(1234567);
    expect(config.partnerKey).toBe('chave-de-teste');
    expect(config.sandbox).toBe(false);
    expect(config.hosts.apiHost).toBe(SHOPEE_PROD_API_HOST);
    expect(config.redirectUri).toBe('http://localhost:3009/api/oauth/shopee/callback');
    expect(config.variationsPath).toBeNull();
  });

  it('carries the variations path override when one is configured', () => {
    // The pair for the line above: `null` is the default, not the only value —
    // an assertion that only ever saw `null` could not tell a wired-up field
    // from one nobody fills.
    vi.stubEnv('SHOPEE_VARIATIONS_PATH', '/api/v2/product/get_variation_tree');
    expect(shopeeConfig().variationsPath).toBe('/api/v2/product/get_variation_tree');
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

describe('shopeePushCallbackUrl — a URL do HMAC do push, sem normalização', () => {
  it('devolve null quando a variável está ausente', () => {
    expect(shopeePushCallbackUrl()).toBeNull();
  });

  it('devolve null quando a variável está em branco', () => {
    vi.stubEnv('SHOPEE_PUSH_CALLBACK_URL', '   ');
    expect(shopeePushCallbackUrl()).toBeNull();
  });

  it('devolve o valor configurado com o espaço em volta aparado', () => {
    vi.stubEnv('SHOPEE_PUSH_CALLBACK_URL', '  https://erp.example/api/webhooks/shopee  ');
    expect(shopeePushCallbackUrl()).toBe('https://erp.example/api/webhooks/shopee');
  });

  // ⚠️ O par que importa: a barra final PERMANECE. Ela está dentro da base
  // string do HMAC, então removê-la aqui mudaria todo dígito computado e faria
  // todo push legítimo falhar a verificação. `shopeeRedirectUri` faz o
  // OPOSTO — e é por isso que os dois não compartilham o mesmo reader.
  it('PRESERVA a barra final (ao contrário de shopeeRedirectUri)', () => {
    vi.stubEnv('SHOPEE_PUSH_CALLBACK_URL', 'https://erp.example/api/webhooks/shopee/');
    expect(shopeePushCallbackUrl()).toBe('https://erp.example/api/webhooks/shopee/');

    vi.stubEnv('SHOPEE_PUBLIC_URL', 'https://erp.example/');
    expect(shopeeRedirectUri()).toBe('https://erp.example/api/oauth/shopee/callback');
  });

  it('não mexe no esquema nem na porta', () => {
    vi.stubEnv('SHOPEE_PUSH_CALLBACK_URL', 'http://localhost:3009/api/webhooks/shopee');
    expect(shopeePushCallbackUrl()).toBe('http://localhost:3009/api/webhooks/shopee');
  });
});
