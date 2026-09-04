import { describe, expect, it } from 'vitest';

import { ShopeeConfigError } from '../src/errors';
import {
  SHOPEE_PROD_API_HOST,
  SHOPEE_PROD_AUTH_HOST,
  SHOPEE_SANDBOX_API_HOST,
  SHOPEE_SANDBOX_AUTH_HOST,
  resolveShopeeHosts,
} from '../src/hosts';

describe('resolveShopeeHosts', () => {
  it('defaults to production', () => {
    const hosts = resolveShopeeHosts();
    expect(hosts.apiHost).toBe(SHOPEE_PROD_API_HOST);
    expect(hosts.authHost).toBe(SHOPEE_PROD_AUTH_HOST);
    expect(hosts.authorizeUrlBase).toBe('https://open.shopee.com.br/auth');
  });

  it('selects the sandbox pair on the flag', () => {
    const hosts = resolveShopeeHosts({ sandbox: true });
    expect(hosts.apiHost).toBe(SHOPEE_SANDBOX_API_HOST);
    expect(hosts.authHost).toBe(SHOPEE_SANDBOX_AUTH_HOST);
  });

  it('builds cancel_auth as a SIBLING of auth', () => {
    // NEAR-MISS: `/auth/cancel_auth` is a plausible-looking path that 404s.
    const hosts = resolveShopeeHosts();
    expect(hosts.cancelAuthUrlBase).toBe('https://open.shopee.com.br/cancel_auth');
    expect(hosts.cancelAuthUrlBase).not.toContain('/auth/cancel_auth');
  });

  it('lets each override win independently of the other and of the flag', () => {
    const hosts = resolveShopeeHosts({
      sandbox: true,
      apiHost: 'https://proxy.interno.example',
    });
    expect(hosts.apiHost).toBe('https://proxy.interno.example');
    // The consent host is untouched — the shape a proxied API egress needs.
    expect(hosts.authHost).toBe(SHOPEE_SANDBOX_AUTH_HOST);

    const onlyAuth = resolveShopeeHosts({ authHost: 'https://open.sandbox.example' });
    expect(onlyAuth.apiHost).toBe(SHOPEE_PROD_API_HOST);
    expect(onlyAuth.authorizeUrlBase).toBe('https://open.sandbox.example/auth');
  });

  it('strips trailing slashes from an override', () => {
    expect(resolveShopeeHosts({ apiHost: 'https://api.example///' }).apiHost).toBe(
      'https://api.example',
    );
    expect(resolveShopeeHosts({ authHost: 'https://open.example/  ' }).authorizeUrlBase).toBe(
      'https://open.example/auth',
    );
  });

  it('keeps an explicit port', () => {
    expect(resolveShopeeHosts({ apiHost: 'http://localhost:8081' }).apiHost).toBe(
      'http://localhost:8081',
    );
  });

  it('refuses a scheme-less override', () => {
    expect(() => resolveShopeeHosts({ apiHost: 'openplatform.shopee.com.br' })).toThrow(
      ShopeeConfigError,
    );
    expect(() => resolveShopeeHosts({ authHost: '//open.shopee.com.br' })).toThrow(
      ShopeeConfigError,
    );
  });

  it('refuses an override that carries a path, a query or a fragment', () => {
    // ⚠️ Rejected rather than trimmed: the signature covers the API PATH, so a
    // host with a path segment signs one string and requests another, and every
    // call comes back `error_sign` with nothing pointing here.
    for (const bad of [
      'https://api.example/api/v2',
      'https://api.example/?x=1',
      'https://api.example/#frag',
    ]) {
      expect(() => resolveShopeeHosts({ apiHost: bad }), bad).toThrow(ShopeeConfigError);
    }
  });

  it('names the offending environment variable in the message', () => {
    expect(() => resolveShopeeHosts({ authHost: 'open.shopee.com.br' })).toThrow(
      /SHOPEE_AUTH_HOST/,
    );
    expect(() => resolveShopeeHosts({ apiHost: 'openplatform.shopee.com.br' })).toThrow(
      /SHOPEE_API_HOST/,
    );
  });
});
