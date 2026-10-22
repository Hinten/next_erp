import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAMINHO_RECEPTOR_AMAZON } from '@delfrance/schemas';

import nextConfig from './next.config';
import { config, proxy } from './proxy';

/**
 * The CORS middleware for `/api/marketplace/*`. `allowedOrigins()` is private,
 * so the origin tests go through the preflight, the surface that decides.
 * `packages/config-eslint/rules/cors-proxy-covers-routes.test.js` also pins
 * this proxy against the routes under its matcher.
 */
const ENDPOINT = 'http://localhost:3011/api/marketplace/amazon/conta/c1';

function preflight(origin: string, extra: Record<string, string> = {}): Response {
  return proxy(
    new NextRequest(ENDPOINT, { method: 'OPTIONS', headers: { origin, ...extra } }),
  ) as unknown as Response;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the matcher', () => {
  it('covers the marketplace routes only — the public OAuth callback stays OUT', () => {
    expect(config.matcher).toEqual(['/api/marketplace/:path*']);
  });

  it('the push receiver (a server-to-server POST from the relay) stays OUT too', () => {
    const prefixos = config.matcher.map((m) => m.replace(/:path\*$/, ''));
    expect(CAMINHO_RECEPTOR_AMAZON).toBe('/api/webhooks/amazon');
    for (const prefixo of prefixos) {
      expect(CAMINHO_RECEPTOR_AMAZON.startsWith(prefixo)).toBe(false);
    }
  });
});

describe('CORS allow-list', () => {
  it('allows the dev origin outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOWED_ADMIN_ORIGINS', '');
    expect(preflight('http://localhost:3000').headers.get('access-control-allow-origin')).toBe(
      'http://localhost:3000',
    );
  });

  it('does NOT allow the dev origin in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOWED_ADMIN_ORIGINS', 'https://app.example.com');
    expect(
      preflight('http://localhost:3000').headers.get('access-control-allow-origin'),
    ).toBeNull();
  });

  it('allows every configured origin in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOWED_ADMIN_ORIGINS', 'https://app.example.com, https://outro.example.com');
    expect(preflight('https://app.example.com').headers.get('access-control-allow-origin')).toBe(
      'https://app.example.com',
    );
    expect(preflight('https://outro.example.com').headers.get('access-control-allow-origin')).toBe(
      'https://outro.example.com',
    );
  });

  it('allows nothing in production when ALLOWED_ADMIN_ORIGINS is unset', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOWED_ADMIN_ORIGINS', '');
    expect(
      preflight('https://app.example.com').headers.get('access-control-allow-origin'),
    ).toBeNull();
  });

  it('a disallowed origin gets a BARE 204: no ACAO, no allow-list — but still no-referrer and no-store', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOWED_ADMIN_ORIGINS', 'https://app.example.com');
    const res = preflight('https://evil.example.com');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-methods')).toBeNull();
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const simples = proxy(
      new NextRequest(ENDPOINT, {
        method: 'POST',
        headers: { origin: 'https://evil.example.com' },
      }),
    ) as unknown as Response;
    expect(simples.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('echoes an allowed origin on a plain request, with Vary: Origin and no-referrer', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOWED_ADMIN_ORIGINS', 'https://app.example.com');
    const res = proxy(
      new NextRequest(ENDPOINT, { method: 'GET', headers: { origin: 'https://app.example.com' } }),
    ) as unknown as Response;
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(res.headers.get('vary')).toBe('Origin');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('CORS methods and headers', () => {
  it('lists exactly GET, POST and OPTIONS (status and OAuth start), headers and max-age', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOWED_ADMIN_ORIGINS', 'https://app.example.com');
    const res = preflight('https://app.example.com', {
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
    expect(res.headers.get('access-control-max-age')).toBe('86400');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('next.config.ts', () => {
  it('sets Referrer-Policy: no-referrer site-wide', async () => {
    expect(await nextConfig.headers?.()).toEqual([
      { source: '/:path*', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
    ]);
  });

  it('transpiles every workspace package the app imports, and externalizes nothing', () => {
    expect(nextConfig.transpilePackages).toEqual([
      '@delfrance/auth',
      '@delfrance/core',
      '@delfrance/data',
      '@delfrance/schemas',
      '@delfrance/integrations-amazon-sp-api',
    ]);
    expect(nextConfig.serverExternalPackages).toBeUndefined();
  });
});
