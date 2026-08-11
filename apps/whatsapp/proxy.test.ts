import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { proxy } from './proxy';

/**
 * #821/T5 — `http://localhost:3000` used to sit unconditionally in the CORS
 * allow-list, so a page served from a developer machine could make credentialed
 * cross-origin calls to the PRODUCTION backend. These are the first tests this
 * middleware has ever had; `allowedOrigins()` is private, so they go through the
 * preflight, which is the surface that actually decides.
 */
const ENDPOINT = 'http://localhost:3008/api/whatsapp/conta';

function preflight(origin: string): Response {
  return proxy(
    new NextRequest(ENDPOINT, { method: 'OPTIONS', headers: { origin } }),
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

    // No echoed origin at all — the browser blocks the request.
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

  it('allows nothing in production when ALLOWED_ADMIN_ORIGINS is unset', () => {
    // The deploy-ordering hazard, pinned: dropping the dev origin makes the
    // variable load-bearing, so a backend deployed without it serves no origin.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ALLOWED_ADMIN_ORIGINS', '');

    expect(
      preflight('http://localhost:3000').headers.get('access-control-allow-origin'),
    ).toBeNull();
    expect(
      preflight('https://app.example.com').headers.get('access-control-allow-origin'),
    ).toBeNull();
  });

  it('never echoes an unlisted origin', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOWED_ADMIN_ORIGINS', 'https://app.example.com');

    expect(
      preflight('https://evil.example.com').headers.get('access-control-allow-origin'),
    ).toBeNull();
  });
});
