import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { proxy } from './proxy';

/**
 * The CORS middleware for `/api/marketplace/*`. `allowedOrigins()` is private,
 * so the origin tests go through the preflight, which is the surface that
 * actually decides.
 *
 * ⚠️ `packages/config-eslint/rules/cors-proxy-covers-routes.test.js` also reads
 * this app's proxy, but it needs at least one route under the matcher and this
 * app has none until the credential routes land (the next PRs of master-plan
 * step 2). Until then that guard fails for this proxy alone, by design: it is
 * the signal that the routes' verbs must be listed in the proxy.
 */
const ENDPOINT = 'http://localhost:3010/api/marketplace/loja-integrada/conta/c1';

function preflight(origin: string, extra: Record<string, string> = {}): Response {
  return proxy(
    new NextRequest(ENDPOINT, { method: 'OPTIONS', headers: { origin, ...extra } }),
  ) as unknown as Response;
}

afterEach(() => {
  vi.unstubAllEnvs();
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

  it('allows a configured origin in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOWED_ADMIN_ORIGINS', 'https://app.example.com, https://outro.example.com');

    expect(preflight('https://app.example.com').headers.get('access-control-allow-origin')).toBe(
      'https://app.example.com',
    );
    expect(preflight('https://outro.example.com').headers.get('access-control-allow-origin')).toBe(
      'https://outro.example.com',
    );
  });

  it('allows localhost in production when it is EXPLICITLY listed', () => {
    // The e2e lanes serve a production build to a browser on localhost:3000 and
    // declare that origin the way a real deploy declares its own.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOWED_ADMIN_ORIGINS', 'http://localhost:3000');

    expect(preflight('http://localhost:3000').headers.get('access-control-allow-origin')).toBe(
      'http://localhost:3000',
    );
  });

  it('allows nothing in production when ALLOWED_ADMIN_ORIGINS is unset', () => {
    // The deploy-ordering hazard, pinned: the variable is load-bearing, so a
    // backend deployed without it serves no origin at all.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOWED_ADMIN_ORIGINS', '');

    expect(
      preflight('http://localhost:3000').headers.get('access-control-allow-origin'),
    ).toBeNull();
    expect(
      preflight('https://app.example.com').headers.get('access-control-allow-origin'),
    ).toBeNull();
  });

  it('never echoes an unlisted origin, on a preflight or on a plain request', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOWED_ADMIN_ORIGINS', 'https://app.example.com');

    const pre = preflight('https://evil.example.com');
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    // A refused preflight carries no allow-list at all, so nothing leaks to it.
    expect(pre.headers.get('access-control-allow-methods')).toBeNull();

    const plain = proxy(
      new NextRequest(ENDPOINT, { method: 'PUT', headers: { origin: 'https://evil.example.com' } }),
    ) as unknown as Response;
    expect(plain.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('echoes an allowed origin on a plain (non-preflight) request, with Vary: Origin', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOWED_ADMIN_ORIGINS', 'https://app.example.com');

    const res = proxy(
      new NextRequest(ENDPOINT, { method: 'GET', headers: { origin: 'https://app.example.com' } }),
    ) as unknown as Response;
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(res.headers.get('vary')).toBe('Origin');
  });
});

describe('CORS methods and headers', () => {
  function listar(valor: string | null): string[] {
    return (valor ?? '').split(',').map((v) => v.trim());
  }

  it('lists exactly GET, PUT, DELETE and OPTIONS — the credential routes need a PUT and a DELETE preflight', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOWED_ADMIN_ORIGINS', 'https://app.example.com');

    const res = preflight('https://app.example.com', {
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'authorization, content-type',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, PUT, DELETE, OPTIONS');
    // POST is CORS-safelisted and no route here uses it; PATCH is not a verb of this app.
    expect(listar(res.headers.get('access-control-allow-methods'))).not.toContain('PATCH');
  });

  it('admits the Authorization and Content-Type headers the browser client sends', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOWED_ADMIN_ORIGINS', 'https://app.example.com');

    const res = preflight('https://app.example.com');
    const cabecalhos = listar(res.headers.get('access-control-allow-headers')).map((h) =>
      h.toLowerCase(),
    );
    expect(cabecalhos).toEqual(expect.arrayContaining(['authorization', 'content-type']));
    expect(res.headers.get('access-control-max-age')).toBe('86400');
  });
});
