import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
  createShopeeClient,
  shopeeHttpFallbackMessage,
} from './client';

/**
 * The regressions these pin are the ones both sibling clients paid for before
 * this one existed:
 *
 *  1. `return parsed as T` — a 2xx of ANY shape reported as a success. For this
 *     channel that is `connected === undefined`, which is falsy, so the panel
 *     would tell the operator to reconnect a perfectly live conta and spend an
 *     OAuth round trip fixing nothing.
 *  2. `parsed = { error: text }` on a non-JSON body, so a proxy's whole HTML
 *     document became `err.message` verbatim and buried the real cause.
 *  3. An empty body diagnosed as version skew, sending someone to deploy a
 *     backend that was never the problem.
 */

function client(fetchImpl: typeof globalThis.fetch) {
  return createShopeeClient({
    baseUrl: 'http://localhost:3009',
    getAuthToken: async () => 'token',
    fetch: fetchImpl,
  });
}

function ok(body: string, contentType = 'application/json'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

const NEXT_404 = `<!DOCTYPE html><html lang="en"><head><title>404: This page could not be found.</title></head><body><h1>404</h1></body></html>`;

const CONTA = {
  connected: true,
  shopId: 123,
  mainAccountId: null,
  authTime: 1_756_000_000_000,
  expireTime: 1_787_536_000_000,
  diasParaExpirar: 365,
  loja: { shopName: 'Loja Teste', region: 'BR', status: 'NORMAL' },
  credencial: { expiraEm: 1_756_014_400_000, expirada: false, renovacaoFalhou: false },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the request', () => {
  it('sends a GET with the Bearer token and an Accept header', async () => {
    let url = '';
    let method: string | undefined;
    let headers: Record<string, string> = {};
    const c = client(async (u, init) => {
      url = String(u);
      method = init?.method;
      headers = (init?.headers ?? {}) as Record<string, string>;
      return ok(JSON.stringify(CONTA));
    });

    await c.conta('int-1');

    expect(url).toBe('http://localhost:3009/api/marketplace/shopee/conta?integracaoId=int-1');
    expect(method).toBe('GET');
    expect(headers.Authorization).toBe('Bearer token');
    expect(headers.Accept).toBe('application/json');
  });

  it('⚠️ percent-encodes the integracaoId instead of splicing it into the query', async () => {
    // A Firestore id is opaque. An unencoded `/` or `&` would silently change
    // WHICH parameter the backend reads, and the route would answer 400 about a
    // missing id that was right there.
    let url = '';
    const c = client(async (u) => {
      url = String(u);
      return ok(JSON.stringify({ authorizeUrl: 'https://shopee.test/auth' }));
    });

    await c.oauthStart('int/1 2&x');

    expect(url).toContain('integracaoId=int%2F1%202%26x');
  });

  it('hits the oauth/start route for oauthStart', async () => {
    let url = '';
    const c = client(async (u) => {
      url = String(u);
      return ok(JSON.stringify({ authorizeUrl: 'https://shopee.test/auth' }));
    });

    await c.oauthStart('int-1');

    expect(url).toContain('/api/marketplace/shopee/oauth/start?integracaoId=int-1');
  });
});

describe('a 2xx whose body IS what we claimed', () => {
  it('parses a connected conta straight through', async () => {
    // The control. A client that only ever throws is indistinguishable from a
    // backend that is down, and every assertion below would still pass.
    const c = client(async () => ok(JSON.stringify(CONTA)));

    await expect(c.conta('int-1')).resolves.toEqual(CONTA);
  });

  it('resolves when the backend sends a field this build never heard of', async () => {
    // `apps/web` calls the DEPLOYED backend. A forward deploy of `apps/shopee`
    // must not take this screen down, so unknown keys are stripped, not fatal.
    const c = client(async () => ok(JSON.stringify({ ...CONTA, campoNovo: { a: 1 } })));

    const conta = await c.conta('int-1');

    expect(conta.connected).toBe(true);
    expect('campoNovo' in conta).toBe(false);
  });
});

describe('a 2xx whose body is NOT what we claimed', () => {
  it('⭐ throws instead of reporting a disconnected conta for a wrong-shaped body', async () => {
    const c = client(async () => ok('{}'));

    const err = await c.conta('int-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect((err as ShopeeClientRespostaInvalidaError).campos).toContain('connected');
  });

  it('names the deploy for a WRONG SHAPE, because that is what actually fixes it', async () => {
    const c = client(async () => ok('{}'));

    const err = (await c.conta('int-1').catch((e: unknown) => e)) as Error;

    expect(err.message).toContain('deploy');
    expect(err.message).toContain('apps/shopee');
  });

  it('⚠️ never puts the offending VALUE in the message — paths only', async () => {
    // A Shopee OAuth body is a live credential often enough that this cannot be
    // left to the call site (#1015). `campos` is field PATHS, and the message is
    // built from those.
    const segredo = 'access-token-ao-vivo-nao-vaze';
    const c = client(async () =>
      ok(JSON.stringify({ ...CONTA, connected: 'sim', accessToken: segredo })),
    );

    const err = (await c.conta('int-1').catch((e: unknown) => e)) as Error;

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect(err.message).not.toContain(segredo);
    expect(err.message).toContain('connected');
  });

  it('⭐ does NOT blame a deploy for an EMPTY body — and logs it', async () => {
    // An empty body is not version skew: it is the HTML case without the HTML,
    // and the request simply never reached a route that answers JSON.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => ok(''));

    const err = (await c
      .conta('int-1')
      .catch((e: unknown) => e)) as ShopeeClientRespostaInvalidaError;

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect(err.campos).toEqual([]);
    expect(err.message).toContain('não chegou à rota esperada');
    expect(err.message).not.toContain('deploy');
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[1])).toContain('corpo vazio');
  });

  it('⭐ throws AND logs when a 200 carries HTML', async () => {
    // The quietest of the three when uncaught: it used to return `null as T`
    // and log nothing, anywhere.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => ok(NEXT_404, 'text/html'));

    const err = (await c
      .conta('int-1')
      .catch((e: unknown) => e)) as ShopeeClientRespostaInvalidaError;

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect(err.message).not.toContain('deploy');
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[1])).toContain('404: This page could not be found.');
  });

  it('caps the logged body on the 2xx path too', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => ok('x'.repeat(50_000), 'text/html'));

    await c.conta('int-1').catch(() => undefined);

    expect(String(spy.mock.calls[0]?.[1]).length).toBeLessThanOrEqual(500);
  });

  it('⭐ refuses an EMPTY authorizeUrl, which would silently reload the page', async () => {
    // `window.location.assign('')` does not fail — it reloads. The operator
    // clicks "Conectar conta" and lands back where they started.
    const c = client(async () => ok(JSON.stringify({ authorizeUrl: '' })));

    await expect(c.oauthStart('int-1')).rejects.toBeInstanceOf(ShopeeClientRespostaInvalidaError);
  });

  it('carries the REAL 2xx it arrived on, not a hardcoded 200', async () => {
    const c = client(async () => new Response('{}', { status: 202 }));

    const err = (await c.conta('int-1').catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err.status).toBe(202);
  });

  it('⭐ is caught by call sites narrowing to ShopeeClientHttpError', async () => {
    // ⚠️ THE reason this class is a SUBCLASS rather than a sibling. Catch sites
    // `throw err` for anything else, and an imperative handler with no TanStack
    // error state would then land as an unhandled rejection: spinner stops, no
    // alert, the operator clicks again.
    const c = client(async () => ok('{}'));

    const err = await c.conta('int-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientHttpError);
    expect((err as ShopeeClientHttpError).code).toBe('RESPOSTA_INVALIDA');
  });
});

describe('non-2xx bodies', () => {
  it('⭐ never leaks an HTML 404 page into the error message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => new Response(NEXT_404, { status: 404 }));

    const err = (await c.conta('int-1').catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err).toBeInstanceOf(ShopeeClientHttpError);
    expect(err.status).toBe(404);
    expect(err.message).not.toContain('<!DOCTYPE');
    expect(err.message).toBe(shopeeHttpFallbackMessage(404));
  });

  it('keeps the discarded body reachable on the console, capped', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => new Response('y'.repeat(50_000), { status: 502 }));

    await c.conta('int-1').catch(() => undefined);

    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[1]).length).toBeLessThanOrEqual(500);
  });

  it('prefers OUR envelope, with its machine code, when the backend sent one', async () => {
    // `respond.ts` answers 503 + `SHOPEE_NETWORK_ERROR` when it could not reach
    // Shopee at all — the panel keys its retryable verdict on that code.
    const c = client(
      async () =>
        new Response(
          JSON.stringify({
            error: 'Falha de rede ao falar com a Shopee.',
            code: 'SHOPEE_NETWORK_ERROR',
          }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        ),
    );

    const err = (await c.conta('int-1').catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err.message).toBe('Falha de rede ao falar com a Shopee.');
    expect(err.code).toBe('SHOPEE_NETWORK_ERROR');
  });

  it('a JSON body that is an ARRAY is not mistaken for the envelope', async () => {
    // ⚠️ Deliberately NOT labelled "the array guard works": at this level it
    // cannot see that guard — the per-field `typeof` checks in `envelopeDeErro`
    // already reduce an array to an empty envelope. What this pins is the
    // behaviour the operator sees.
    const c = client(
      async () =>
        new Response('[1,2,3]', { status: 500, headers: { 'content-type': 'application/json' } }),
    );

    const err = (await c.conta('int-1').catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err.message).toBe(shopeeHttpFallbackMessage(500));
    expect(err.code).toBeNull();
  });

  it('a genuine network failure is a NetworkError, not an HTTP one', async () => {
    // The two need different words in front of an operator, and the panel's
    // retryable verdict differs between them.
    const c = client(async () => {
      throw new TypeError('Failed to fetch');
    });

    const err = await c.conta('int-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientNetworkError);
    expect(err).not.toBeInstanceOf(ShopeeClientHttpError);
  });
});

describe('shopeeHttpFallbackMessage', () => {
  it('tells the operator what to DO, and carries the status for support', () => {
    const message = shopeeHttpFallbackMessage(404);

    expect(message).toMatch(/Atualize a página/);
    expect(message).toMatch(/HTTP 404/);
  });

  it('separates permission, server and everything-else', () => {
    expect(shopeeHttpFallbackMessage(401)).toMatch(/Sem permissão/);
    expect(shopeeHttpFallbackMessage(403)).toMatch(/Sem permissão/);
    expect(shopeeHttpFallbackMessage(502)).toMatch(/falhou/);
    expect(shopeeHttpFallbackMessage(503)).toMatch(/falhou/);
    expect(shopeeHttpFallbackMessage(400)).toMatch(/HTTP 400/);
  });

  it('never returns an empty message for any status the backend emits', () => {
    for (const status of [400, 401, 403, 404, 500, 502, 503]) {
      expect(shopeeHttpFallbackMessage(status).length).toBeGreaterThan(10);
    }
  });
});
