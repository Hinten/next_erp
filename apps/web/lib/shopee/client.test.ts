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

/* ---------------------------------------------------------------------------
 * etiqueta() — the label flow's ONE call (#1523, step 15)
 * ------------------------------------------------------------------------- */

const ETIQUETA_URL = 'http://localhost:3009/api/marketplace/shopee/etiqueta';

/** A PDF head with bytes ≥ 0x80 — what a text decode would corrupt. */
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0xff, 0x80]);

/** The route's 200, as `respostaEtiqueta.ts` builds it. */
function etiqueta200(
  bytes: Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {
    'content-type': 'application/pdf',
    'content-disposition': 'attachment; filename="etiqueta-shopee-260910KJBHUJDM.pdf"',
  },
): Response {
  return new Response(bytes, { status: 200, headers });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The 202 `aguardar` literal of the backend's `route.test.ts` (`AGUARDAR`). */
const AGUARDAR = {
  acao: 'aguardar',
  fase: 'aguardando-rastreio',
  tentarEmMs: 5_000,
  mensagem: 'Envio organizado; aguardando o código de rastreio da transportadora.',
  progresso: { total: 1, organizados: 1, comRastreio: 0, prontos: 0 },
};

/** The 409 of a refusal, exactly as `respostaEtiqueta.ts` builds it. */
function recusa409(motivo: string, mensagem: string, extra: Record<string, unknown> = {}) {
  return json(409, {
    error: mensagem,
    code: 'SHOPEE_ETIQUETA_RECUSADA',
    motivo,
    mensagem,
    ...extra,
  });
}

/** Capture the one request `etiqueta()` makes. */
function capturando(resposta: () => Response) {
  const visto: { url: string; init: RequestInit | undefined } = { url: '', init: undefined };
  const c = client(async (u, init) => {
    visto.url = String(u);
    visto.init = init;
    return resposta();
  });
  return { c, visto, corpo: () => JSON.parse(String(visto.init?.body)) as Record<string, unknown> };
}

describe('etiqueta — the request', () => {
  it('POSTs JSON with the Bearer token to the label route', async () => {
    const { c, visto } = capturando(() => json(202, AGUARDAR));

    await c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' });

    expect(visto.url).toBe(ETIQUETA_URL);
    expect(visto.init?.method).toBe('POST');
    const headers = (visto.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('⭐ OMITS the absent keys — exactly `{ pedidoId, formato }`, nothing null-filled', async () => {
    const { c, corpo } = capturando(() => json(202, AGUARDAR));

    await c.etiqueta({ pedidoId: 'ped-1', formato: 'zpl2' });

    expect(corpo()).toStrictEqual({ pedidoId: 'ped-1', formato: 'zpl2' });
  });

  it('sends `pacote` and a pickup `envio` when given — `horarioId: null` IS sent (a zero-slot address)', async () => {
    // The near miss of the omission rule: `null` is a value the route reads
    // ("a Shopee agenda"), and dropping it would be a 400 — the pickup shape
    // requires the key.
    const { c, corpo } = capturando(() => json(202, AGUARDAR));

    await c.etiqueta({
      pedidoId: 'ped-1',
      formato: 'pdf',
      pacote: 'OFG000000000002',
      envio: { pacote: 'OFG000000000001', modo: 'pickup', enderecoId: '2001', horarioId: null },
    });

    expect(corpo()).toStrictEqual({
      pedidoId: 'ped-1',
      formato: 'pdf',
      pacote: 'OFG000000000002',
      envio: { pacote: 'OFG000000000001', modo: 'pickup', enderecoId: '2001', horarioId: null },
    });
  });

  it('⚠️ rebuilds `envio` BY NAME — a caller object with one more field never reaches the strict route', async () => {
    // The route judges each `envio` shape by its EXACT key set; a dialog result
    // spread into the call would otherwise turn a valid answer into a 400.
    const { c, corpo } = capturando(() => json(202, AGUARDAR));
    const postagem = { pacote: 'OFG000000000001', modo: 'dropoff' as const, rotulo: 'Agência' };
    const coleta = {
      pacote: 'OFG000000000001',
      modo: 'pickup' as const,
      enderecoId: '2001',
      horarioId: 'slot-1',
      recomendado: true,
    };

    await c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf', envio: postagem });
    expect(corpo().envio).toStrictEqual({ pacote: 'OFG000000000001', modo: 'dropoff' });

    await c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf', envio: coleta });
    expect(corpo().envio).toStrictEqual({
      pacote: 'OFG000000000001',
      modo: 'pickup',
      enderecoId: '2001',
      horarioId: 'slot-1',
    });
  });

  it('⚠️ rebuilds the TOP level by name too — a stray key on the call never reaches the route', async () => {
    // The route refuses any key outside `{pedidoId, formato, pacote, envio}` —
    // `confirmacoes` above all, the removed 1-hour confirm (Appendix A).
    const { c, corpo } = capturando(() => json(202, AGUARDAR));
    const pedido = { pedidoId: 'ped-1', formato: 'pdf' as const, confirmacoes: ['janela-1h'] };

    await c.etiqueta(pedido);

    expect(corpo()).toStrictEqual({ pedidoId: 'ped-1', formato: 'pdf' });
  });

  it('the dropoff shape carries exactly `{ pacote, modo }`', async () => {
    const { c, corpo } = capturando(() => json(202, AGUARDAR));

    await c.etiqueta({
      pedidoId: 'ped-1',
      formato: 'pdf',
      envio: { pacote: 'OFG000000000001', modo: 'dropoff' },
    });

    expect(corpo().envio).toStrictEqual({ pacote: 'OFG000000000001', modo: 'dropoff' });
  });

  it('forwards the caller’s AbortSignal — and sends none when given none', async () => {
    const { c, visto } = capturando(() => json(202, AGUARDAR));
    const ctrl = new AbortController();

    await c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' }, { signal: ctrl.signal });
    expect(visto.init?.signal).toBe(ctrl.signal);

    await c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' });
    expect(visto.init !== undefined && 'signal' in visto.init).toBe(false);
  });

  it('an abort in flight is a NetworkError whose cause is the AbortError (the ML convention)', async () => {
    const c = client(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });

    const err = await c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientNetworkError);
    expect((err as ShopeeClientNetworkError).cause).toBeInstanceOf(DOMException);
  });
});

describe('etiqueta — 200: the label bytes', () => {
  it('⭐ returns the bytes BYTE-EQUAL, the server filename and the Content-Type', async () => {
    const c = client(async () => etiqueta200(PDF_BYTES));

    const r = await c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' });

    expect(r.tipo).toBe('arquivo');
    if (r.tipo !== 'arquivo') return;
    expect(new Uint8Array(await r.blob.arrayBuffer())).toStrictEqual(PDF_BYTES);
    expect(r.filename).toBe('etiqueta-shopee-260910KJBHUJDM.pdf');
    expect(r.contentType).toBe('application/pdf');
  });

  it('⚠️ hands the Content-Type over VERBATIM — a charset a proxy appended is the caller’s to judge', async () => {
    // Round-trip check 2: the route sends a BARE `text/plain` for ZPL, and the
    // print agent compares strings. Whether a suffixed one may go to the agent
    // is the provider's decision (W13); the transport must not quietly
    // normalise it and hide the case from that decision.
    const c = client(async () =>
      etiqueta200(new TextEncoder().encode('^XA^XZ'), {
        'content-type': 'text/plain; charset=utf-8',
      }),
    );

    const r = await c.etiqueta({ pedidoId: 'ped-1', formato: 'zpl2' });

    expect(r.tipo === 'arquivo' ? r.contentType : null).toBe('text/plain; charset=utf-8');
  });

  it('⭐ Q1-3: a HIDDEN disposition names the file by the RESPONSE type — a PDF answered to a zpl2 request is `.pdf`', async () => {
    // A backend whose proxy predates `Access-Control-Expose-Headers` answers
    // the bytes with the disposition invisible to the browser, while the
    // CORS-safelisted Content-Type stays readable. Shopee may substitute a PDF
    // for a zpl2 request (R-u): naming it by the REQUEST saved a PDF as `.zip`
    // (ML #1680's defect, reachable whenever the print agent is down).
    const c = client(async () => etiqueta200(PDF_BYTES, { 'content-type': 'application/pdf' }));

    const pdf = await c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' });
    const zpl = await c.etiqueta({ pedidoId: 'ped-1', formato: 'zpl2' });

    expect(pdf.tipo === 'arquivo' ? pdf.filename : null).toBe('etiqueta-ped-1.pdf');
    expect(zpl.tipo === 'arquivo' ? zpl.filename : null).toBe('etiqueta-ped-1.pdf');
  });

  it.each([
    ['application/zip', 'etiqueta-ped-1.zip'],
    ['text/plain', 'etiqueta-ped-1.txt'],
    ['text/plain; charset=utf-8', 'etiqueta-ped-1.txt'],
    ['Application/PDF', 'etiqueta-ped-1.pdf'],
  ])(
    'the three types the route serves each name their own extension — %s ⇒ %s, whatever was requested',
    async (contentType, nome) => {
      const c = client(async () => etiqueta200(PDF_BYTES, { 'content-type': contentType }));

      for (const formato of ['pdf', 'zpl2'] as const) {
        const r = await c.etiqueta({ pedidoId: 'ped-1', formato });

        expect(r.tipo === 'arquivo' ? r.filename : null).toBe(nome);
      }
    },
  );

  it('⚠️ NEAR MISS — a VISIBLE disposition still wins over the type-derived fallback', async () => {
    // The fallback is a fallback: the route's own name (`-p1de2.zip`, the
    // order number) is never replaced by the generic one.
    const c = client(async () =>
      etiqueta200(PDF_BYTES, {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="etiqueta-shopee-260910KJBHUJDM-p1de2.zip"',
      }),
    );

    const r = await c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' });

    expect(r.tipo === 'arquivo' ? r.filename : null).toBe(
      'etiqueta-shopee-260910KJBHUJDM-p1de2.zip',
    );
  });

  it('a missing Content-Type falls back by formato — the only case the request decides', async () => {
    // A `Uint8Array` body sets no Content-Type of its own.
    const c = client(async () => etiqueta200(PDF_BYTES, {}));

    const pdf = await c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' });
    const zpl = await c.etiqueta({ pedidoId: 'ped-1', formato: 'zpl2' });

    expect(pdf.tipo === 'arquivo' ? [pdf.contentType, pdf.filename] : null).toEqual([
      'application/pdf',
      'etiqueta-ped-1.pdf',
    ]);
    expect(zpl.tipo === 'arquivo' ? [zpl.contentType, zpl.filename] : null).toEqual([
      'application/zip',
      'etiqueta-ped-1.zip',
    ]);
  });

  it('a type the route never serves falls back by formato too — and `constructor` is not a type', async () => {
    // The extension table is a `Map`: an object literal would resolve an
    // essence of `constructor` to `Object.prototype.constructor`.
    for (const contentType of ['application/octet-stream', 'constructor']) {
      const c = client(async () => etiqueta200(PDF_BYTES, { 'content-type': contentType }));

      const r = await c.etiqueta({ pedidoId: 'ped-1', formato: 'zpl2' });

      expect(r.tipo === 'arquivo' ? r.filename : null).toBe('etiqueta-ped-1.zip');
    }
  });

  it('⭐ W16: a 200 `application/json` is a RespostaInvalida, never a label to print', async () => {
    // The route answers JSON only on a 202. The body is NOT logged: it would be
    // a question carrying the seller's addresses, or something newer than us.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const contentType of ['application/json', 'application/json; charset=utf-8']) {
      const c = client(
        async () =>
          new Response(JSON.stringify(AGUARDAR), {
            status: 200,
            headers: { 'content-type': contentType },
          }),
      );

      const err = await c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
      expect((err as ShopeeClientRespostaInvalidaError).status).toBe(200);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('⚠️ NEAR MISS — the SAME bytes under `application/pdf` are a label', async () => {
    // The control on W16: a guard that refused every 200 would pass it too.
    const c = client(async () =>
      etiqueta200(new TextEncoder().encode(JSON.stringify(AGUARDAR)), {
        'content-type': 'application/pdf',
      }),
    );

    await expect(c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' })).resolves.toMatchObject({
      tipo: 'arquivo',
    });
  });

  it('⭐ a 200 `text/html` is a RespostaInvalida — and the page is logged, capped', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(
      async () =>
        new Response(NEXT_404, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    );

    const err = (await c
      .etiqueta({ pedidoId: 'ped-1', formato: 'pdf' })
      .catch((e: unknown) => e)) as ShopeeClientRespostaInvalidaError;

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect(err.message).not.toContain('<!DOCTYPE');
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[1])).toContain('404: This page could not be found.');
  });

  it('⭐ an EMPTY 200 is a failed label, never a blank print', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => etiqueta200(new Uint8Array(0)));

    await expect(c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' })).rejects.toBeInstanceOf(
      ShopeeClientRespostaInvalidaError,
    );
  });

  it('⭐ W16: any OTHER 2xx is a RespostaInvalida carrying its real status', async () => {
    for (const status of [201, 204, 206]) {
      const c = client(
        async () =>
          new Response(status === 204 ? null : PDF_BYTES, {
            status,
            headers: { 'content-type': 'application/pdf' },
          }),
      );

      const err = await c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
      expect((err as ShopeeClientRespostaInvalidaError).status).toBe(status);
    }
  });
});

describe('etiqueta — 202: a wait or a question', () => {
  it('⭐ parses the backend’s `aguardar` into a `pendente`', async () => {
    const c = client(async () => json(202, AGUARDAR));

    await expect(c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' })).resolves.toStrictEqual({
      tipo: 'pendente',
      ...AGUARDAR,
    });
  });

  it('parses the backend’s `escolher-envio`, defaulting an absent `escolhaInvalida`', async () => {
    const c = client(async () =>
      json(202, {
        acao: 'escolher-envio',
        fase: 'programando',
        pacote: 'OFG000000000001',
        pacoteRotulo: null,
        mensagem: 'm',
        enderecos: [],
        permiteDropoff: true,
        progresso: { total: 1, organizados: 0, comRastreio: 0, prontos: 0 },
      }),
    );

    const r = await c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' });

    expect(r).toMatchObject({ tipo: 'pendente', acao: 'escolher-envio', escolhaInvalida: false });
  });

  it('a `tipo` key a newer backend might add never overrides the discriminant', async () => {
    const c = client(async () => json(202, { ...AGUARDAR, tipo: 'arquivo' }));

    const r = await c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' });

    expect(r.tipo).toBe('pendente');
  });

  it('⭐ W17: an UNKNOWN acao is a RespostaInvalida naming `acao` — never a wait', async () => {
    const c = client(async () =>
      json(202, { ...AGUARDAR, acao: 'confirmar', pergunta: 'menos-de-uma-hora' }),
    );

    const err = (await c
      .etiqueta({ pedidoId: 'ped-1', formato: 'pdf' })
      .catch((e: unknown) => e)) as ShopeeClientRespostaInvalidaError;

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect(err.status).toBe(202);
    expect(err.campos).toContain('acao');
    expect(err.message).toContain('apps/shopee');
  });

  it('an EMPTY 202 is not blamed on a deploy (the `call` wording, shared)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => new Response('', { status: 202 }));

    const err = (await c
      .etiqueta({ pedidoId: 'ped-1', formato: 'pdf' })
      .catch((e: unknown) => e)) as ShopeeClientRespostaInvalidaError;

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect(err.message).toContain('não chegou à rota esperada');
    expect(err.message).not.toContain('deploy');
  });
});

describe('etiqueta — non-2xx: the backend’s own sentence', () => {
  const SEM_HORARIO = 'mensagem da recusa sem-horario-ou-agencia';

  it('⭐ a 409 refusal throws an HttpError whose message IS the body’s `error` (= `mensagem`)', async () => {
    const c = client(async () => recusa409('sem-horario-ou-agencia', SEM_HORARIO));

    const err = (await c
      .etiqueta({ pedidoId: 'ped-1', formato: 'pdf' })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err).toBeInstanceOf(ShopeeClientHttpError);
    expect(err).not.toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('SHOPEE_ETIQUETA_RECUSADA');
    expect(err.message).toBe(SEM_HORARIO);
  });

  it('⚠️ a `motivo` this build never heard of is still the backend’s sentence — motivo is a FREE string', async () => {
    // `apps/web` calls the DEPLOYED backend: a new server motivo must reach
    // the operator as its sentence, never as a parse failure.
    const c = client(async () => recusa409('motivo-do-futuro', 'uma frase nova'));

    const err = (await c
      .etiqueta({ pedidoId: 'ped-1', formato: 'pdf' })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err.message).toBe('uma frase nova');
    expect(err.code).toBe('SHOPEE_ETIQUETA_RECUSADA');
  });

  it('PAIR: a `recusa-desconhecida` WITH and WITHOUT `shopeeCode` yields the SAME error', async () => {
    // The optional key is tolerated and changes nothing the operator sees; the
    // backend already logged it (`[shopee/etiqueta] recusa-desconhecida`).
    const frase = 'confira o pedido na Central do Vendedor';
    const com = client(async () =>
      recusa409('recusa-desconhecida', frase, { shopeeCode: 'some_new_code' }),
    );
    const sem = client(async () => recusa409('recusa-desconhecida', frase));

    const a = (await com
      .etiqueta({ pedidoId: 'ped-1', formato: 'pdf' })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;
    const b = (await sem
      .etiqueta({ pedidoId: 'ped-1', formato: 'pdf' })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect([a.message, a.status, a.code]).toEqual([frase, 409, 'SHOPEE_ETIQUETA_RECUSADA']);
    expect([b.message, b.status, b.code]).toEqual([a.message, a.status, a.code]);
  });

  it('Q1-6: the `shopeeCode` rides on the error for support — and ONLY there, never in the message', async () => {
    const frase = 'confira o pedido na Central do Vendedor';
    const com = client(async () =>
      recusa409('recusa-desconhecida', frase, { shopeeCode: 'some_new_code' }),
    );
    const sem = client(async () => recusa409('recusa-desconhecida', frase));

    const a = (await com
      .etiqueta({ pedidoId: 'ped-1', formato: 'pdf' })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;
    const b = (await sem
      .etiqueta({ pedidoId: 'ped-1', formato: 'pdf' })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(a.shopeeCode).toBe('some_new_code');
    expect(a.message).toBe(frase);
    expect(b.shopeeCode).toBeNull();
  });

  it('⚠️ NEAR MISS — a non-string or empty `shopeeCode` is null, never coerced', async () => {
    for (const shopeeCode of [42, '', { a: 1 }, null]) {
      const c = client(async () => recusa409('recusa-desconhecida', 'frase', { shopeeCode }));

      const err = (await c
        .etiqueta({ pedidoId: 'ped-1', formato: 'pdf' })
        .catch((e: unknown) => e)) as ShopeeClientHttpError;

      expect(err.shopeeCode).toBeNull();
    }
  });

  it('a 409 carrying the NF-e outcome and `tentarApos` still reads as its sentence', async () => {
    const c = client(async () =>
      recusa409('nfe-pendente', 'frase da nf-e', {
        nfe: { desfecho: 'enfileirado', atrasoSegundos: 0 },
        tentarApos: 1_790_000_000_000,
      }),
    );

    const err = (await c
      .etiqueta({ pedidoId: 'ped-1', formato: 'pdf' })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect([err.message, err.status]).toEqual(['frase da nf-e', 409]);
  });

  it('the 403 "may print, may not arrange" carries its sentence and code', async () => {
    const c = client(async () =>
      json(403, {
        error: 'frase do 403',
        code: 'SHOPEE_ETIQUETA_SEM_PERMISSAO',
        motivo: 'programar-envio',
        mensagem: 'frase do 403',
      }),
    );

    const err = (await c
      .etiqueta({ pedidoId: 'ped-1', formato: 'pdf' })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect([err.message, err.status, err.code]).toEqual([
      'frase do 403',
      403,
      'SHOPEE_ETIQUETA_SEM_PERMISSAO',
    ]);
  });

  it('a non-JSON 404 (the route not deployed yet) gets the fallback, never the HTML', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const c = client(async () => new Response(NEXT_404, { status: 404 }));

    const err = (await c
      .etiqueta({ pedidoId: 'ped-1', formato: 'pdf' })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err.message).toBe(shopeeHttpFallbackMessage(404));
    expect(err.message).not.toContain('<!DOCTYPE');
  });
});

/**
 * The headers arrived and the socket died while the BODY streamed: `text()` /
 * `blob()` reject with a bare `TypeError` ("terminated" in Node, "network error"
 * in Chrome). Wrapping only `fetch` let that escape every handler in the label
 * loop (#1748 review), so every body read goes through `lerCorpo`.
 */
class RespostaQueCaiNoCorpo extends Response {
  constructor(
    status: number,
    headers: Record<string, string>,
    private readonly erro: unknown = new TypeError('terminated'),
  ) {
    super(null, { status, headers });
  }
  override text(): Promise<string> {
    return Promise.reject(this.erro);
  }
  override blob(): Promise<Blob> {
    return Promise.reject(this.erro);
  }
}

describe('a connection that drops while the BODY is read (#1748 review)', () => {
  const PDF = { 'content-type': 'application/pdf' };
  const JSON_CT = { 'content-type': 'application/json' };

  it.each([
    ['a 202 (the JSON wait)', 202, JSON_CT],
    ['a 200 (the label bytes)', 200, PDF],
    ['a 409 (the refusal)', 409, JSON_CT],
    ['a 200 HTML page (logged before refusing)', 200, { 'content-type': 'text/html' }],
  ])('%s ⇒ ShopeeClientNetworkError carrying the TypeError', async (_rotulo, status, headers) => {
    const queda = new TypeError('terminated');
    const c = client(async () => new RespostaQueCaiNoCorpo(status, headers, queda));

    const err = await c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientNetworkError);
    expect((err as ShopeeClientNetworkError).cause).toBe(queda);
  });

  it('the GET path (`conta`) wraps a dropped body the same way', async () => {
    const c = client(async () => new RespostaQueCaiNoCorpo(200, JSON_CT));

    const err = await c.conta('int-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientNetworkError);
  });

  it('near-miss — a body read that rejects after OUR abort rethrows untouched (the caller reads `signal.aborted`)', async () => {
    const ctrl = new AbortController();
    const abortado = new DOMException('The operation was aborted.', 'AbortError');
    const c = client(async () => {
      ctrl.abort();
      return new RespostaQueCaiNoCorpo(202, JSON_CT, abortado);
    });

    const err = await c
      .etiqueta({ pedidoId: 'ped-1', formato: 'pdf' }, { signal: ctrl.signal })
      .catch((e: unknown) => e);

    expect(err).toBe(abortado);
    expect(err).not.toBeInstanceOf(ShopeeClientNetworkError);
  });

  it('near-miss — a rejection that is not a TypeError is not a transport failure and rethrows untouched', async () => {
    const outro = new RangeError('não é uma queda de rede');
    const c = client(async () => new RespostaQueCaiNoCorpo(202, JSON_CT, outro));

    const err = await c.etiqueta({ pedidoId: 'ped-1', formato: 'pdf' }).catch((e: unknown) => e);

    expect(err).toBe(outro);
  });
});
