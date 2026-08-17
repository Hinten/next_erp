import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  createMercadoLivreClient,
  mercadoLivreHttpFallbackMessage,
} from './client';

/**
 * The regression these pin: a non-2xx response whose body is NOT our JSON
 * `{error}` envelope must NEVER put that body in `err.message`.
 *
 * It used to. When the apps/mercado-livre backend answered with its Next.js 404
 * page, the whole HTML document became the error message and the size-chart
 * editor rendered it verbatim in an alert — burying the real cause (the backend
 * was not serving that route) under a wall of markup.
 */

function client(fetchImpl: typeof globalThis.fetch) {
  return createMercadoLivreClient({
    baseUrl: 'http://localhost:3006',
    getAuthToken: async () => 'token',
    fetch: fetchImpl,
  });
}

function response(body: string, init: { status: number; contentType?: string }): Response {
  return new Response(body, {
    status: init.status,
    headers: { 'content-type': init.contentType ?? 'text/html' },
  });
}

const NEXT_404 = `<!DOCTYPE html><html lang="en"><head><title>404: This page could not be found.</title></head><body><h1>404</h1><h2>This page could not be found.</h2></body></html>`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('non-JSON error bodies', () => {
  it('never leaks an HTML 404 page into the error message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => response(NEXT_404, { status: 404 }));

    const err = await c.sizeChartDomains('int-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MercadoLivreClientHttpError);
    const httpErr = err as MercadoLivreClientHttpError;
    expect(httpErr.status).toBe(404);
    expect(httpErr.message).not.toContain('<!DOCTYPE');
    expect(httpErr.message).not.toContain('<html');
    expect(httpErr.message).toBe(mercadoLivreHttpFallbackMessage(404));
  });

  it('keeps the discarded body reachable on the console for debugging', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => response(NEXT_404, { status: 502 }));

    await c.sizeChartDomains('int-1').catch(() => undefined);

    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[1])).toContain('404: This page could not be found.');
  });

  it('caps the logged body so a huge page cannot flood the console', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => response('x'.repeat(50_000), { status: 500 }));

    await c.sizeChartDomains('int-1').catch(() => undefined);

    expect(String(spy.mock.calls[0]?.[1]).length).toBeLessThanOrEqual(500);
  });

  it('still uses OUR message when the backend sent its JSON envelope', async () => {
    const c = client(
      async () =>
        new Response(
          JSON.stringify({ error: 'Conta não conectada.', code: 'ML_REAUTH_REQUIRED' }),
          {
            status: 409,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );

    const err = (await c
      .sizeChartDomains('int-1')
      .catch((e: unknown) => e)) as MercadoLivreClientHttpError;

    expect(err.message).toBe('Conta não conectada.');
    expect(err.code).toBe('ML_REAUTH_REQUIRED');
  });

  it('a JSON body that is an ARRAY is not mistaken for the envelope', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(
      async () =>
        new Response('[1,2,3]', { status: 500, headers: { 'content-type': 'application/json' } }),
    );

    const err = (await c
      .sizeChartDomains('int-1')
      .catch((e: unknown) => e)) as MercadoLivreClientHttpError;

    expect(err.message).toBe(mercadoLivreHttpFallbackMessage(500));
  });

  it('a genuine network failure is still a network error, not an HTTP one', async () => {
    const c = client(async () => {
      throw new TypeError('Failed to fetch');
    });

    const err = await c.sizeChartDomains('int-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MercadoLivreClientNetworkError);
  });
});

describe('mercadoLivreHttpFallbackMessage', () => {
  it('tells the operator what to DO, and carries the status for support', () => {
    // Every route in apps/mercado-livre answers JSON, so a non-JSON 404 means
    // the request never reached one — but an operator cannot inspect that.
    const message = mercadoLivreHttpFallbackMessage(404);
    expect(message).toMatch(/Atualize a página/);
    expect(message).toMatch(/HTTP 404/);
  });

  it('separates permission, server and everything-else', () => {
    expect(mercadoLivreHttpFallbackMessage(403)).toMatch(/Sem permissão/);
    expect(mercadoLivreHttpFallbackMessage(500)).toMatch(/falhou/);
    expect(mercadoLivreHttpFallbackMessage(418)).toMatch(/HTTP 418/);
  });

  it('never returns an empty message', () => {
    for (const status of [400, 401, 403, 404, 409, 418, 500, 502, 503]) {
      expect(mercadoLivreHttpFallbackMessage(status).length).toBeGreaterThan(10);
    }
  });
});

describe('sugerirMedidas — the body', () => {
  /** Captures the JSON body of the single request the call makes. */
  async function bodyOf(input: Parameters<ReturnType<typeof client>['sugerirMedidas']>[0]) {
    let sent: Record<string, unknown> = {};
    const c = client(async (_url, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await c.sugerirMedidas(input);
    return sent;
  }

  const grid = { tabMediId: 'tm1', rows: [{ key: 'k', size: 'P' }], columns: [] };

  it('renames `fatos` to `facts` on the wire', async () => {
    // The browser-facing API is Portuguese like the rest of this client; the
    // route's vocabulary is English. A mismatch here is silent — the route
    // simply ignores an unknown key and reads the stale stored document, which
    // is the exact bug `fatos` exists to fix.
    const sent = await bodyOf({ ...grid, fatos: { descricao: 'recém digitada' } });
    expect(sent.facts).toEqual({ descricao: 'recém digitada' });
    expect(sent.fatos).toBeUndefined();
  });

  it('omits `facts` entirely when the caller has none', async () => {
    // Not `facts: undefined`: the route falls back per field only when the key
    // is absent, and `JSON.stringify` would drop it anyway — pinning it keeps
    // that accident from becoming load-bearing silently.
    const sent = await bodyOf(grid);
    expect('facts' in sent).toBe(false);
    expect(sent.tabMediId).toBe('tm1');
  });
});
