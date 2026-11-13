import { FirebaseError } from 'firebase/app';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CAMPO_RASCUNHO_SHOPEE,
  CODIGO_RASCUNHO_SHOPEE,
  MSG_ITEM_NAME_EM_BRANCO_RASCUNHO_SHOPEE,
  projetarTabelaShopee,
  respostaAtributosShopeeSchema,
  respostaVariacoesShopeeSchema,
} from '@delfrance/schemas';

import { shopeeClientFalso } from '@/lib/testing/shopeeClientFalso';

import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
  createShopeeClient,
  shopeeHttpFallbackMessage,
  type CamposDoCorpoRascunhoShopee,
  type ShopeeClient,
} from './client';
import {
  ACAO_RECLAMACAO_SHOPEE,
  DETALHES_ERRO_SHOPEE_VAZIOS,
  SOLUCAO_DEVOLUCAO_SHOPEE,
  type ShopeeContaStatus,
} from './wire';

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

/* ---------------------------------------------------------------------------
 * Returns (#1525, step 17) — `reclamacaoEstado` (GET) and `reclamacaoAcao` (POST)
 * ------------------------------------------------------------------------- */

/** Fixture ids only — an ALPHANUMERIC return_sn, like every Shopee sample. */
const RETURN_SN = '260910ABCDE0001';
const ALVO = { integracaoId: 'int-1', pedidoId: 'pedido-1', returnSn: RETURN_SN };

const ESTADO_DEVOLUCAO = {
  returnSn: RETURN_SN,
  orderSn: '260910KJBHUJDM',
  pedidoId: 'pedido-1',
  status: 'REQUESTED',
  terminal: false,
  solucao: 'REFUND',
  motivo: 'ITEM_DAMAGED',
  motivoReavaliado: null,
  valorReembolso: 89.9,
  valorAntesDesconto: null,
  moeda: 'BRL',
  tipoRequisicao: 0,
  tipoValidacao: 'seller_validation',
  negociacao: null,
  prova: null,
  compensacao: null,
  prazos: [{ tipo: 'resposta-vendedor', prazoMs: 1_790_000_000_000, reembolsoAutomatico: true }],
  solucoes: [],
  acoesDisponiveis: ['confirmar'],
  motivoSemAcao: null,
  pendenciasForaDoErp: [],
};

const ACAO_OK = { ok: true, acao: 'confirmar', returnSn: RETURN_SN, atualizacao: 'enfileirada' };

/** Records every request; answers `resposta` (a body string) with `status`. */
function gravador(resposta: string, status = 200) {
  const pedidos: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
    pedidos.push({ url: String(u), init });
    return new Response(resposta, { status, headers: { 'content-type': 'application/json' } });
  });
  return { c: client(fetchImpl), pedidos, fetchImpl };
}

const corpoEnviado = (init: RequestInit | undefined): unknown =>
  JSON.parse(String(init?.body)) as unknown;

describe('reclamacaoEstado — the GET', () => {
  it('⭐ GETs the estado route with BOTH params percent-encoded, and no body', async () => {
    const { c, pedidos } = gravador(JSON.stringify(ESTADO_DEVOLUCAO));

    await c.reclamacaoEstado({ integracaoId: 'int/1 2&x', returnSn: 'A&B=C' });

    expect(pedidos[0]?.url).toBe(
      'http://localhost:3009/api/marketplace/shopee/reclamacao/estado' +
        '?integracaoId=int%2F1%202%26x&returnSn=A%26B%3DC',
    );
    expect(pedidos[0]?.init?.method).toBe('GET');
    expect(pedidos[0]?.init?.body).toBeUndefined();
    expect(pedidos[0]?.init?.headers).not.toHaveProperty('Content-Type');
  });

  it('parses the estado straight through — the control', async () => {
    const { c } = gravador(JSON.stringify(ESTADO_DEVOLUCAO));

    await expect(
      c.reclamacaoEstado({ integracaoId: 'int-1', returnSn: RETURN_SN }),
    ).resolves.toEqual(ESTADO_DEVOLUCAO);
  });

  it('⭐ a 2xx WITHOUT `acoesDisponiveis` is a RespostaInvalida naming it — never "no actions"', async () => {
    const { acoesDisponiveis: _semAcoes, ...semAcoes } = ESTADO_DEVOLUCAO;
    const { c } = gravador(JSON.stringify(semAcoes));

    const err = await c
      .reclamacaoEstado({ integracaoId: 'int-1', returnSn: RETURN_SN })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect((err as ShopeeClientRespostaInvalidaError).campos).toContain('acoesDisponiveis');
  });

  it('a 404 envelope is an HttpError carrying the backend’s sentence and code', async () => {
    const { c } = gravador(
      JSON.stringify({ error: 'Devolução não encontrada.', code: 'SHOPEE_RECLAMACAO_INEXISTENTE' }),
      404,
    );

    const err = (await c
      .reclamacaoEstado({ integracaoId: 'int-1', returnSn: RETURN_SN })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err).toBeInstanceOf(ShopeeClientHttpError);
    expect(err.status).toBe(404);
    expect(err.message).toBe('Devolução não encontrada.');
    expect(err.code).toBe('SHOPEE_RECLAMACAO_INEXISTENTE');
  });

  it('a body that drops mid-read is a NetworkError (the shared `lerCorpo`)', async () => {
    const c = client(
      async () => new RespostaQueCaiNoCorpo(200, { 'content-type': 'application/json' }),
    );

    const err = await c
      .reclamacaoEstado({ integracaoId: 'int-1', returnSn: RETURN_SN })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientNetworkError);
  });
});

describe('reclamacaoAcao — the POST body, rebuilt BY NAME per action', () => {
  it('⭐ POSTs JSON with the Bearer token, the Content-Type and an Accept header', async () => {
    const { c, pedidos } = gravador(JSON.stringify(ACAO_OK));

    await c.reclamacaoAcao({
      ...ALVO,
      acao: ACAO_RECLAMACAO_SHOPEE.confirmar,
      valorExibidoMinor: 8990,
    });

    expect(pedidos[0]?.url).toBe('http://localhost:3009/api/marketplace/shopee/reclamacao/acao');
    expect(pedidos[0]?.init?.method).toBe('POST');
    expect(pedidos[0]?.init?.headers).toEqual({
      Authorization: 'Bearer token',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
  });

  it('⭐ confirmar sends EXACTLY {integracaoId, pedidoId, returnSn, acao, valorExibidoMinor}', async () => {
    const { c, pedidos } = gravador(JSON.stringify(ACAO_OK));

    await c.reclamacaoAcao({
      ...ALVO,
      acao: ACAO_RECLAMACAO_SHOPEE.confirmar,
      valorExibidoMinor: 8990,
    });

    expect(corpoEnviado(pedidos[0]?.init)).toEqual({
      ...ALVO,
      acao: 'confirmar',
      valorExibidoMinor: 8990,
    });
  });

  it('confirmar keeps a `null` echo as null — never dropped, never 0', async () => {
    const { c, pedidos } = gravador(JSON.stringify(ACAO_OK));

    await c.reclamacaoAcao({
      ...ALVO,
      acao: ACAO_RECLAMACAO_SHOPEE.confirmar,
      valorExibidoMinor: null,
    });

    expect(corpoEnviado(pedidos[0]?.init)).toEqual({
      ...ALVO,
      acao: 'confirmar',
      valorExibidoMinor: null,
    });
  });

  it('⭐ ofertar WITHOUT an amount OMITS the key — never `null`, never 0', async () => {
    const { c, pedidos } = gravador(JSON.stringify({ ...ACAO_OK, acao: 'ofertar' }));

    await c.reclamacaoAcao({
      ...ALVO,
      acao: ACAO_RECLAMACAO_SHOPEE.ofertar,
      solucao: SOLUCAO_DEVOLUCAO_SHOPEE.devolucaoEReembolso,
    });

    const corpo = corpoEnviado(pedidos[0]?.init);
    expect(corpo).toEqual({ ...ALVO, acao: 'ofertar', solucao: 'RETURN_REFUND' });
    expect(corpo).not.toHaveProperty('valorReembolsoMinor');
  });

  it('ofertar WITH an amount sends it as the integer centavos it was given', async () => {
    const { c, pedidos } = gravador(JSON.stringify({ ...ACAO_OK, acao: 'ofertar' }));

    await c.reclamacaoAcao({
      ...ALVO,
      acao: ACAO_RECLAMACAO_SHOPEE.ofertar,
      solucao: SOLUCAO_DEVOLUCAO_SHOPEE.soReembolso,
      valorReembolsoMinor: 1234,
    });

    expect(corpoEnviado(pedidos[0]?.init)).toEqual({
      ...ALVO,
      acao: 'ofertar',
      solucao: 'REFUND',
      valorReembolsoMinor: 1234,
    });
  });

  it('aceitar-oferta sends BOTH echoes — the amount and the solução the panel showed', async () => {
    const { c, pedidos } = gravador(JSON.stringify({ ...ACAO_OK, acao: 'aceitar-oferta' }));

    await c.reclamacaoAcao({
      ...ALVO,
      acao: ACAO_RECLAMACAO_SHOPEE.aceitarOferta,
      valorExibidoMinor: 5000,
      solucaoExibida: SOLUCAO_DEVOLUCAO_SHOPEE.devolucaoEReembolso,
    });

    expect(corpoEnviado(pedidos[0]?.init)).toEqual({
      ...ALVO,
      acao: 'aceitar-oferta',
      valorExibidoMinor: 5000,
      solucaoExibida: 'RETURN_REFUND',
    });
  });

  it('⚠️ a stray key on the call — even one ANOTHER action carries — never reaches the strict route', async () => {
    const { c, pedidos } = gravador(JSON.stringify(ACAO_OK));
    const comSobras = {
      ...ALVO,
      acao: ACAO_RECLAMACAO_SHOPEE.confirmar,
      valorExibidoMinor: 8990,
      solucao: SOLUCAO_DEVOLUCAO_SHOPEE.soReembolso,
      valorReembolsoMinor: 1,
      solucaoExibida: null,
      campoNovo: 'x',
    };

    await c.reclamacaoAcao(comSobras);

    expect(Object.keys(corpoEnviado(pedidos[0]?.init) as object).sort()).toEqual(
      ['acao', 'integracaoId', 'pedidoId', 'returnSn', 'valorExibidoMinor'].sort(),
    );
  });

  it('resolves the backend’s answer', async () => {
    const { c } = gravador(JSON.stringify(ACAO_OK));

    await expect(
      c.reclamacaoAcao({ ...ALVO, acao: ACAO_RECLAMACAO_SHOPEE.confirmar, valorExibidoMinor: 1 }),
    ).resolves.toEqual(ACAO_OK);
  });
});

describe('reclamacaoAcao — the answers an operator must read correctly', () => {
  it('⭐ a 409 refusal is an HttpError whose message IS the backend’s sentence, with its code', async () => {
    const { c } = gravador(
      JSON.stringify({
        error: 'O valor da devolução mudou — confira e tente de novo.',
        code: 'SHOPEE_RECLAMACAO_ACAO_RECUSADA',
        motivo: 'valor-mudou',
        acoesDisponiveis: ['confirmar'],
      }),
      409,
    );

    const err = (await c
      .reclamacaoAcao({ ...ALVO, acao: ACAO_RECLAMACAO_SHOPEE.confirmar, valorExibidoMinor: 1 })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err).toBeInstanceOf(ShopeeClientHttpError);
    expect(err).not.toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect(err.status).toBe(409);
    expect(err.message).toBe('O valor da devolução mudou — confira e tente de novo.');
    expect(err.code).toBe('SHOPEE_RECLAMACAO_ACAO_RECUSADA');
  });

  it('⭐ a 200 that does not say `ok: true` is a RespostaInvalida — never a success to toast', async () => {
    const { c } = gravador(JSON.stringify({ ...ACAO_OK, ok: false }));

    const err = await c
      .reclamacaoAcao({ ...ALVO, acao: ACAO_RECLAMACAO_SHOPEE.confirmar, valorExibidoMinor: 1 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
  });

  it('⭐ a fetch rejection is a NetworkError — and the client sends the POST exactly ONCE', async () => {
    // A gateway timeout reaches the browser as a network error: the action may
    // have run. Retrying here would be a second refund attempt.
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const c = client(fetchImpl);

    const err = await c
      .reclamacaoAcao({ ...ALVO, acao: ACAO_RECLAMACAO_SHOPEE.confirmar, valorExibidoMinor: 1 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientNetworkError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a body that drops mid-read on the POST is a NetworkError too', async () => {
    const c = client(
      async () => new RespostaQueCaiNoCorpo(200, { 'content-type': 'application/json' }),
    );

    const err = await c
      .reclamacaoAcao({ ...ALVO, acao: ACAO_RECLAMACAO_SHOPEE.confirmar, valorExibidoMinor: 1 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientNetworkError);
  });

  it('⚠️ a token failure surfaces AS ITSELF — not relabelled a network error, and nothing is sent', async () => {
    // `getAuthToken()` stays outside the try: the panel narrows `FirebaseError`
    // on its own, so a failed refresh after an irreversible confirm is shown,
    // never swallowed as "a resposta não chegou".
    const tokenFalhou = new FirebaseError(
      'auth/network-request-failed',
      'Falha ao renovar o token',
    );
    const fetchImpl = vi.fn();
    const c = createShopeeClient({
      baseUrl: 'http://localhost:3009',
      getAuthToken: () => Promise.reject(tokenFalhou),
      fetch: fetchImpl,
    });

    const err = await c
      .reclamacaoAcao({ ...ALVO, acao: ACAO_RECLAMACAO_SHOPEE.confirmar, valorExibidoMinor: 1 })
      .catch((e: unknown) => e);

    expect(err).toBe(tokenFalhou);
    expect(err).not.toBeInstanceOf(ShopeeClientNetworkError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('W18 regression — only a call WITH a body is a POST', () => {
  it.each([
    ['conta', (c: ReturnType<typeof client>) => c.conta('int-1'), CONTA],
    [
      'oauthStart',
      (c: ReturnType<typeof client>) => c.oauthStart('int-1'),
      { authorizeUrl: 'https://shopee.test/auth' },
    ],
  ] as const)('%s still GETs with no body and no Content-Type', async (_nome, chamar, resposta) => {
    const { c, pedidos } = gravador(JSON.stringify(resposta));

    await chamar(c);

    expect(pedidos[0]?.init?.method).toBe('GET');
    expect(pedidos[0]?.init).not.toHaveProperty('body');
    expect(pedidos[0]?.init?.headers).toEqual({
      Authorization: 'Bearer token',
      Accept: 'application/json',
    });
  });
});

/* ---------------------------------------------------------------------------
 * Size charts (#1526, step 18) — four GETs for the `/medidas` Shopee tab
 * ------------------------------------------------------------------------- */

const RAIZES = {
  raizes: [{ categoryId: 100017, name: 'Moda', originalName: null, isLeaf: false }],
  no: null,
};
const LIMITES = {
  scope: 'category',
  categoryId: 100087,
  limites: {
    sizeChartLimit: {
      sizeChartMandatory: null,
      supportImageSizeChart: null,
      supportTemplateSizeChart: true,
    },
  },
};
const LISTA_TABELAS = {
  leaf: true,
  categoryId: 400055,
  tabelas: [{ sizeChartId: 700024641, sizeChartName: 'Tabela Básica', legivel: true }],
  totalCount: 1,
  truncado: false,
  removidas: 0,
  idsIlegiveis: 0,
};
/** A real projection (one numeric column, one row), so the body is what the route builds. */
const TABELA = projetarTabelaShopee(700024641, {
  size_chart_id: 700024641,
  size_chart_name: 'Tabela Básica',
  size_chart_table: {
    column_list: [
      {
        measurement: { display_name: 'Busto', input_type: 'Input Single Number', unit: 'cm' },
        measurement_value_list: [{ option: null, value: 90, min_value: null, max_value: null }],
      },
    ],
  },
});

describe('size charts — the four GETs', () => {
  it.each([
    [
      'categorias (roots)',
      (c: ReturnType<typeof client>) =>
        c.categorias({ integracaoId: 'int/1 2&x', categoryId: null }),
      RAIZES,
      '/api/marketplace/shopee/taxonomia/categorias?integracaoId=int%2F1%202%26x',
    ],
    [
      'categorias (one node)',
      (c: ReturnType<typeof client>) =>
        c.categorias({ integracaoId: 'int/1 2&x', categoryId: 100087 }),
      RAIZES,
      '/api/marketplace/shopee/taxonomia/categorias?integracaoId=int%2F1%202%26x&categoryId=100087',
    ],
    [
      'limites',
      (c: ReturnType<typeof client>) =>
        c.limites({ integracaoId: 'int/1 2&x', categoryId: 100087 }),
      LIMITES,
      '/api/marketplace/shopee/taxonomia/limites?integracaoId=int%2F1%202%26x&categoryId=100087',
    ],
    [
      'tabelaMedidasLista',
      (c: ReturnType<typeof client>) =>
        c.tabelaMedidasLista({ integracaoId: 'int/1 2&x', categoryId: 400055 }),
      LISTA_TABELAS,
      '/api/marketplace/shopee/tabela-medidas/lista?integracaoId=int%2F1%202%26x&categoryId=400055',
    ],
    [
      'tabelaMedidasDetalhe',
      (c: ReturnType<typeof client>) =>
        c.tabelaMedidasDetalhe({ integracaoId: 'int/1 2&x', sizeChartId: 700024641 }),
      { tabela: TABELA },
      '/api/marketplace/shopee/tabela-medidas/detalhe?integracaoId=int%2F1%202%26x&sizeChartId=700024641',
    ],
  ] as const)(
    '⭐ %s: the exact path + query, a GET, no body, no Content-Type, the body parsed',
    async (_nome, chamar, resposta, caminho) => {
      const { c, pedidos } = gravador(JSON.stringify(resposta));

      await expect(chamar(c)).resolves.toEqual(resposta);

      expect(pedidos).toHaveLength(1);
      expect(pedidos[0]?.url).toBe(`http://localhost:3009${caminho}`);
      expect(pedidos[0]?.init?.method).toBe('GET');
      expect(pedidos[0]?.init).not.toHaveProperty('body');
      expect(pedidos[0]?.init?.headers).toEqual({
        Authorization: 'Bearer token',
        Accept: 'application/json',
      });
    },
  );

  it('⚠️ NEAR-MISS: `categoryId: 0` is NOT the roots — it is SENT (the route refuses it), never dropped like `null`', async () => {
    const { c, pedidos } = gravador(JSON.stringify(RAIZES));

    await c.categorias({ integracaoId: 'int-1', categoryId: 0 });

    expect(pedidos[0]?.url).toContain('?integracaoId=int-1&categoryId=0');
  });

  it('⭐ a 2xx list WITHOUT `truncado` is a RespostaInvalida naming it — never "the list is complete"', async () => {
    const { truncado: _t, ...semTruncado } = LISTA_TABELAS;
    const { c } = gravador(JSON.stringify(semTruncado));

    const err = await c
      .tabelaMedidasLista({ integracaoId: 'int-1', categoryId: 400055 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect((err as ShopeeClientRespostaInvalidaError).campos).toContain('truncado');
  });

  it('the stale-template 404 carries its code and sentence; the extra `sizeChartId` is tolerated', async () => {
    const { c } = gravador(
      JSON.stringify({
        error:
          'A tabela de medidas 700024641 não existe mais nesta loja da Shopee — escolha outra.',
        code: 'SHOPEE_TABELA_MEDIDAS_INEXISTENTE',
        sizeChartId: 700024641,
      }),
      404,
    );

    const err = (await c
      .tabelaMedidasDetalhe({ integracaoId: 'int-1', sizeChartId: 700024641 })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err).toBeInstanceOf(ShopeeClientHttpError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('SHOPEE_TABELA_MEDIDAS_INEXISTENTE');
    expect(err.message).toContain('escolha outra');
    expect(err.kind).toBeNull();
  });

  it('⭐ the client retries NOTHING — a 503 and a 502 each cost exactly one request', async () => {
    for (const status of [503, 502]) {
      const { c, fetchImpl } = gravador(JSON.stringify({ error: 'x', code: 'X' }), status);

      await expect(c.limites({ integracaoId: 'int-1', categoryId: 1 })).rejects.toBeInstanceOf(
        ShopeeClientHttpError,
      );
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });
});

describe('categorias — `isLeaf` is read STRICTLY (the leaf gate is the backend’s)', () => {
  const NO = {
    categoryId: 100017,
    name: 'Moda',
    originalName: null,
    isLeaf: false,
    parentId: 0,
    pathFromRoot: [{ categoryId: 100017, name: 'Moda', originalName: null, isLeaf: false }],
    children: [{ categoryId: 100087, name: 'Camisetas', originalName: null, isLeaf: true }],
  };

  it('EQUAL: a real boolean parses, on a root row, on the node and on a child', async () => {
    const { c } = gravador(JSON.stringify({ raizes: null, no: NO }));

    const r = await c.categorias({ integracaoId: 'int-1', categoryId: 100017 });

    expect(r.no?.isLeaf).toBe(false);
    expect(r.no?.children[0]?.isLeaf).toBe(true);
  });

  it.each([
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['null', null],
  ])(
    'NEAR-MISS: %s as `isLeaf` is a RespostaInvalida ("faça o deploy") — never read as "not a leaf"',
    async (_n, isLeaf) => {
      const corpos = [
        { raizes: [{ ...RAIZES.raizes[0], isLeaf }], no: null },
        { raizes: null, no: { ...NO, isLeaf } },
        { raizes: null, no: { ...NO, children: [{ ...NO.children[0], isLeaf }] } },
      ];
      for (const corpo of corpos) {
        const { c } = gravador(JSON.stringify(corpo));
        const err = await c
          .categorias({ integracaoId: 'int-1', categoryId: null })
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
      }
    },
  );
});

describe('`kind` on ShopeeClientHttpError (R-c)', () => {
  const CORPO_502 = {
    error: 'Shopee: error_busy',
    code: 'SHOPEE_HTTP_ERROR',
    upstreamStatus: 200,
    shopeeCode: 'error_busy',
  };

  it('⭐ M68: the 502 body’s `kind` rides on the error, beside `shopeeCode`, the message untouched', async () => {
    const { c } = gravador(JSON.stringify({ ...CORPO_502, kind: 'burst' }), 502);

    const err = (await c
      .tabelaMedidasLista({ integracaoId: 'int-1', categoryId: 400055 })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err.kind).toBe('burst');
    expect(err.shopeeCode).toBe('error_busy');
    expect(err.code).toBe('SHOPEE_HTTP_ERROR');
    expect(err.message).toBe('Shopee: error_busy');
  });

  it('a kind this build never heard of is carried verbatim — a FREE string', async () => {
    const { c } = gravador(JSON.stringify({ ...CORPO_502, kind: 'kind-novo' }), 502);

    const err = (await c.conta('int-1').catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err.kind).toBe('kind-novo');
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['a number', 42],
    ['null', null],
  ])('NEAR-MISS: a `kind` that is %s reads as null, never coerced', async (_n, kind) => {
    const { c } = gravador(JSON.stringify({ ...CORPO_502, kind }), 502);

    const err = (await c.conta('int-1').catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err.kind).toBeNull();
    expect(err.shopeeCode).toBe('error_busy');
  });

  it('the constructor defaults `kind` to null — the RespostaInvalida subclass included', () => {
    expect(new ShopeeClientHttpError('m', 500, null).kind).toBeNull();
    expect(new ShopeeClientRespostaInvalidaError('m', 200, []).kind).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * Step 21 (#1529, sub-step 21-1) — the thirteen new methods
 * ------------------------------------------------------------------------- */

// Fixture ids only: integração `int-1`, produtos `prod-1`/`prod-2`, link `link-1`,
// item 1000001, job `job-1`. Each 2xx below carries every key its route sends BY
// NAME (`apps/shopee/app/api/marketplace/shopee/<route>/route.ts`), the stripped
// ones included, so the parse is exercised against the real envelope.

const ESTOQUE_200 = {
  canal: 'shopee',
  integracaoId: 'int-1',
  contaNome: 'Conta Teste',
  solicitados: 1,
  familias: 1,
  resumo: { enviados: 1, pulados: 0, falhas: 0, naoTentados: 0 },
  listings: [
    {
      produtoId: 'prod-1',
      produtoNome: 'Camiseta',
      variacaoProdutoId: null,
      anuncioId: '1000001',
      linkDocId: 'link-1',
      outcome: 'enviado',
      motivo: null,
      mensagem: 'Estoque enviado.',
      quantidade: 5,
      variacoes: [],
      modelosRecusados: 0,
      clampados: 0,
      rearme: null,
    },
  ],
  produtosSemEnvio: [],
  pausadoAte: null,
};

const PRECOS_200 = {
  canal: 'shopee',
  integracaoId: 'int-1',
  contaNome: 'Conta Teste',
  solicitados: 1,
  familias: 1,
  resumo: { enviados: 1, pulados: 0, falhas: 0, naoTentados: 0 },
  listings: [
    {
      produtoId: 'prod-1',
      produtoNome: 'Camiseta',
      variacaoProdutoId: null,
      anuncioId: '1000001',
      linkDocId: 'link-1',
      outcome: 'enviado',
      motivo: null,
      mensagem: 'Preço enviado.',
      preco: 99.9,
      precoAnterior: 89.9,
      variacoes: null,
      codigo: null,
    },
  ],
  produtosSemEnvio: [],
  pausadoAte: null,
};

const STATUS_200 = {
  canal: 'shopee',
  integracaoId: 'int-1',
  acao: 'pausar',
  solicitados: 1,
  familias: 1,
  resumo: { aplicados: 1, pulados: 0, falhas: 0, naoTentados: 0 },
  listings: [
    {
      produtoId: 'prod-1',
      produtoNome: 'Camiseta',
      anuncioId: '1000001',
      linkDocId: 'link-1',
      outcome: 'enviado',
      motivo: null,
      mensagem: 'Anúncio pausado.',
      statusFinal: 'UNLIST',
      estadoAnuncio: 'pausado',
      membros: null,
    },
  ],
  produtosSemAnuncio: [],
  pausadoAte: null,
};

const PUBLICAR_ITEM_200 = {
  itemId: 1000001,
  estadoAnuncio: 'ativo',
  itemStatus: 'NORMAL',
  modelos: { total: 0, criados: 0, atualizados: 0, semFilho: 0 },
  fotos: { reutilizadas: 2, enviadas: 0, falhas: 0 },
  avisoShopee: null,
  taxInfoOmitido: null,
  tabelaDeMedidas: {
    sizeChartId: null,
    fonte: 'nenhuma',
    motivo: 'sem-tabela',
    fotoOmitida: null,
    avisoObrigatoria: false,
  },
};

const REVERIFICAR_200 = {
  acao: 'atualizado',
  estadoAnuncio: 'ativo',
  itemStatus: 'NORMAL',
  deboost: false,
  violacoes: [],
  violacoesLidas: true,
  modelos: null,
  avisoResolvido: false,
  avisoReceitaKit: null,
  chamadasShopee: 2,
};

const MASS_STATUS_200 = {
  status: 'running',
  scanned: 10,
  imported: 4,
  created: 2,
  skipped: 1,
  kits: 0,
  failureCount: 0,
  failures: [],
  restante: 5,
  varreduraExaurida: false,
  startedAt: 1_790_000_000_000,
  updatedAt: 1_790_000_060_000,
  finishedAt: null,
  erro: null,
};

const CONTADORES_PRECO = {
  status: 'running',
  baixarPreco: false,
  planejados: 3,
  enviados: 1,
  pulados: 0,
  falhas: 0,
  pausas: 0,
  parques: 0,
  retomarEm: null,
  filaRestante: 2,
  relatorioCompleto: false,
  relatorioShards: 1,
  startedAt: 1_790_000_000_000,
  updatedAt: 1_790_000_060_000,
  finishedAt: null,
  erro: null,
};
const PRICE_STATUS_200 = { jobId: 'job-1', ...CONTADORES_PRECO, skips: [], failures: [] };
const HISTORICO_200 = { envios: [{ jobId: 'job-1', integracaoId: 'int-1', ...CONTADORES_PRECO }] };
const RELATORIO_200 = {
  linhas: [],
  proximoDepois: null,
  status: 'completed',
  relatorioCompleto: true,
  filaRestante: 0,
};

const BASE = 'http://localhost:3009/api/marketplace/shopee';

describe('step 21 — each method: its route, its verb, its body BY NAME (C1)', () => {
  it.each([
    [
      'enviarEstoque',
      (c: ReturnType<typeof client>) =>
        c.enviarEstoque({ integracaoId: 'int-1', produtoIds: ['prod-1', 'prod-2'] }),
      ESTOQUE_200,
      `${BASE}/enviar-estoque`,
      { integracaoId: 'int-1', produtoIds: ['prod-1', 'prod-2'], reenviarComErro: false },
    ],
    [
      'enviarPrecos',
      (c: ReturnType<typeof client>) =>
        c.enviarPrecos({ integracaoId: 'int-1', produtoIds: ['prod-1'], baixarPreco: true }),
      PRECOS_200,
      `${BASE}/enviar-precos`,
      { integracaoId: 'int-1', produtoIds: ['prod-1'], baixarPreco: true },
    ],
    [
      'definirStatusAnuncios',
      (c: ReturnType<typeof client>) =>
        c.definirStatusAnuncios({ integracaoId: 'int-1', produtoIds: ['prod-1'], acao: 'pausar' }),
      STATUS_200,
      `${BASE}/anuncio-status`,
      { integracaoId: 'int-1', produtoIds: ['prod-1'], acao: 'pausar' },
    ],
    [
      'publicar',
      (c: ReturnType<typeof client>) => c.publicar({ integracaoId: 'int-1', produtoId: 'prod-1' }),
      PUBLICAR_ITEM_200,
      `${BASE}/publicar`,
      { integracaoId: 'int-1', produtoId: 'prod-1' },
    ],
    [
      'reverificarAnuncio',
      (c: ReturnType<typeof client>) =>
        c.reverificarAnuncio({ integracaoId: 'int-1', produtoId: 'prod-1', linkDocId: 'link-1' }),
      REVERIFICAR_200,
      `${BASE}/reverificar-anuncio`,
      { integracaoId: 'int-1', produtoId: 'prod-1', linkDocId: 'link-1' },
    ],
    [
      'startMassImport',
      (c: ReturnType<typeof client>) => c.startMassImport({ integracaoId: 'int-1' }),
      { jobId: 'job-1' },
      `${BASE}/importar-todos`,
      { integracaoId: 'int-1' },
    ],
    [
      'massImportStatus',
      (c: ReturnType<typeof client>) =>
        c.massImportStatus({ integracaoId: 'int/1 2&x', jobId: 'job&1' }),
      MASS_STATUS_200,
      `${BASE}/importar-todos/status?integracaoId=int%2F1%202%26x&jobId=job%261`,
      undefined,
    ],
    [
      'cancelMassImport',
      (c: ReturnType<typeof client>) =>
        c.cancelMassImport({ integracaoId: 'int-1', jobId: 'job-1' }),
      { status: 'cancelled' },
      `${BASE}/importar-todos/cancelar`,
      { integracaoId: 'int-1', jobId: 'job-1' },
    ],
    [
      'startPriceSync',
      (c: ReturnType<typeof client>) => c.startPriceSync({ integracaoId: 'int-1' }),
      { jobId: 'job-1' },
      `${BASE}/atualizar-precos`,
      { integracaoId: 'int-1', baixarPreco: false },
    ],
    [
      'priceSyncStatus',
      (c: ReturnType<typeof client>) =>
        c.priceSyncStatus({ integracaoId: 'int/1 2&x', jobId: 'job&1' }),
      PRICE_STATUS_200,
      `${BASE}/atualizar-precos/status?integracaoId=int%2F1%202%26x&jobId=job%261`,
      undefined,
    ],
    [
      'cancelPriceSync',
      (c: ReturnType<typeof client>) =>
        c.cancelPriceSync({ integracaoId: 'int-1', jobId: 'job-1' }),
      { status: 'cancelled' },
      `${BASE}/atualizar-precos/cancelar`,
      { integracaoId: 'int-1', jobId: 'job-1' },
    ],
    [
      'priceSyncHistorico',
      (c: ReturnType<typeof client>) => c.priceSyncHistorico({ integracaoId: 'int-1' }),
      HISTORICO_200,
      `${BASE}/atualizar-precos/historico?integracaoId=int-1`,
      undefined,
    ],
    [
      'priceSyncRelatorio',
      (c: ReturnType<typeof client>) =>
        c.priceSyncRelatorio({ integracaoId: 'int-1', jobId: 'job-1', depois: null }),
      RELATORIO_200,
      `${BASE}/atualizar-precos/relatorio?integracaoId=int-1&jobId=job-1`,
      undefined,
    ],
  ] as const)('⭐ %s', async (_nome, chamar, resposta, url, corpo) => {
    const { c, pedidos } = gravador(JSON.stringify(resposta));

    await chamar(c);

    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]?.url).toBe(url);
    if (corpo === undefined) {
      expect(pedidos[0]?.init?.method).toBe('GET');
      expect(pedidos[0]?.init).not.toHaveProperty('body');
    } else {
      expect(pedidos[0]?.init?.method).toBe('POST');
      expect(pedidos[0]?.init?.headers).toEqual({
        Authorization: 'Bearer token',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      });
      // `toStrictEqual` on the parsed body: the key SET is exact, nothing
      // `undefined`-valued or `null`-filled rides along.
      expect(corpoEnviado(pedidos[0]?.init)).toStrictEqual(corpo);
    }
  });

  it('⚠️ a stray key on the caller’s object never reaches a route — every body is rebuilt by name', async () => {
    // Not a fresh literal, so TypeScript lets the extra keys through — exactly
    // what a component spreading its own state into the call would do.
    const entradaEstoque = { integracaoId: 'int-1', produtoIds: ['prod-1'], extra: 1 };
    const entradaJob = { integracaoId: 'int-1', jobId: 'job-1', extra: 1 };
    const { c, pedidos } = gravador(JSON.stringify(ESTOQUE_200));
    await c.enviarEstoque(entradaEstoque);
    const job = gravador(JSON.stringify({ status: 'cancelled' }));
    await job.c.cancelPriceSync(entradaJob);

    expect(corpoEnviado(pedidos[0]?.init)).not.toHaveProperty('extra');
    expect(corpoEnviado(job.pedidos[0]?.init)).not.toHaveProperty('extra');
  });

  it('the optional keys go out when given: `reenviarComErro`, `linkDocId`, `options`, `limite`, `depois`', async () => {
    const estoque = gravador(JSON.stringify(ESTOQUE_200));
    await estoque.c.enviarEstoque({
      integracaoId: 'int-1',
      produtoIds: ['prod-1'],
      reenviarComErro: true,
    });
    expect(corpoEnviado(estoque.pedidos[0]?.init)).toMatchObject({ reenviarComErro: true });

    const status = gravador(JSON.stringify(STATUS_200));
    await status.c.definirStatusAnuncios({
      integracaoId: 'int-1',
      produtoIds: ['prod-1'],
      acao: 'reativar',
      linkDocId: 'link-1',
    });
    expect(corpoEnviado(status.pedidos[0]?.init)).toStrictEqual({
      integracaoId: 'int-1',
      produtoIds: ['prod-1'],
      acao: 'reativar',
      linkDocId: 'link-1',
    });

    const reverificar = gravador(JSON.stringify(REVERIFICAR_200));
    await reverificar.c.reverificarAnuncio({ integracaoId: 'int-1', produtoId: 'prod-1' });
    expect(corpoEnviado(reverificar.pedidos[0]?.init)).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
    });

    const importacao = gravador(JSON.stringify({ jobId: 'job-1' }));
    await importacao.c.startMassImport({
      integracaoId: 'int-1',
      options: { importarFotos: false },
    });
    expect(corpoEnviado(importacao.pedidos[0]?.init)).toStrictEqual({
      integracaoId: 'int-1',
      options: { importarFotos: false },
    });

    const historico = gravador(JSON.stringify(HISTORICO_200));
    await historico.c.priceSyncHistorico({ integracaoId: 'int-1', limite: 20 });
    expect(historico.pedidos[0]?.url).toBe(
      `${BASE}/atualizar-precos/historico?integracaoId=int-1&limite=20`,
    );

    const relatorio = gravador(JSON.stringify(RELATORIO_200));
    await relatorio.c.priceSyncRelatorio({ integracaoId: 'int-1', jobId: 'job-1', depois: '0004' });
    expect(relatorio.pedidos[0]?.url).toBe(
      `${BASE}/atualizar-precos/relatorio?integracaoId=int-1&jobId=job-1&depois=0004`,
    );
  });
});

describe('step 21 — publicar sends exactly what the caller chose (C2)', () => {
  it('⭐ only `{ integracaoId, produtoId }` → exactly those two keys, nothing null-filled', async () => {
    const { c, pedidos } = gravador(JSON.stringify(PUBLICAR_ITEM_200));

    await c.publicar({ integracaoId: 'int-1', produtoId: 'prod-1' });

    expect(Object.keys(corpoEnviado(pedidos[0]?.init) as object).sort()).toEqual([
      'integracaoId',
      'produtoId',
    ]);
  });

  it('every optional key goes out when given — and `categoryId: 0` is SENT (the route judges it), never dropped', async () => {
    const { c, pedidos } = gravador(JSON.stringify(PUBLICAR_ITEM_200));

    await c.publicar({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'link-1',
      status: 'UNLIST',
      categoryId: 0,
      principal: 'prod-2',
      recriar: true,
    });

    expect(corpoEnviado(pedidos[0]?.init)).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'link-1',
      status: 'UNLIST',
      categoryId: 0,
      principal: 'prod-2',
      recriar: true,
    });
  });

  it('`converterEmKit` goes out on its own', async () => {
    const { c, pedidos } = gravador(JSON.stringify(PUBLICAR_ITEM_200));

    await c.publicar({ integracaoId: 'int-1', produtoId: 'prod-1', converterEmKit: true });

    expect(corpoEnviado(pedidos[0]?.init)).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      converterEmKit: true,
    });
  });

  it('#1911 P11: a DRAFT’s publish sends its link and each confirmation flag only when given', async () => {
    const ambos = gravador(JSON.stringify(PUBLICAR_ITEM_200));
    await ambos.c.publicar({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'AbCdEfGhIj0123456789',
      status: 'UNLIST',
      confirmarSegundoAnuncio: true,
      confirmarCriacaoIncerta: true,
    });
    expect(corpoEnviado(ambos.pedidos[0]?.init)).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'AbCdEfGhIj0123456789',
      status: 'UNLIST',
      confirmarSegundoAnuncio: true,
      confirmarCriacaoIncerta: true,
    });

    // Each flag on its own — the other is OMITTED, never `false` or `null`.
    const segundo = gravador(JSON.stringify(PUBLICAR_ITEM_200));
    await segundo.c.publicar({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'R1',
      confirmarSegundoAnuncio: true,
    });
    expect(corpoEnviado(segundo.pedidos[0]?.init)).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'R1',
      confirmarSegundoAnuncio: true,
    });
    const atestado = gravador(JSON.stringify(PUBLICAR_ITEM_200));
    await atestado.c.publicar({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'R1',
      confirmarCriacaoIncerta: true,
    });
    expect(corpoEnviado(atestado.pedidos[0]?.init)).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'R1',
      confirmarCriacaoIncerta: true,
    });
  });

  it('NEAR-MISS: with neither flag the body names neither key — what every publish before #1911 sent', async () => {
    const { c, pedidos } = gravador(JSON.stringify(PUBLICAR_ITEM_200));

    await c.publicar({ integracaoId: 'int-1', produtoId: 'prod-1', linkDocId: 'R1' });

    const corpo = corpoEnviado(pedidos[0]?.init) as Record<string, unknown>;
    expect(corpo).not.toHaveProperty('confirmarSegundoAnuncio');
    expect(corpo).not.toHaveProperty('confirmarCriacaoIncerta');
    expect(Object.keys(corpo).sort()).toEqual(['integracaoId', 'linkDocId', 'produtoId']);
  });

  it('§I1 (#1911 P11 review): `criacaoIncertaAdota` rides WITH the attestation flag — the adopted id(s), and `[]` (a deliberate create) is SENT, never dropped', async () => {
    const adota = gravador(JSON.stringify(PUBLICAR_ITEM_200));
    await adota.c.publicar({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'R1',
      confirmarCriacaoIncerta: true,
      criacaoIncertaAdota: [1000011],
    });
    expect(corpoEnviado(adota.pedidos[0]?.init)).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'R1',
      confirmarCriacaoIncerta: true,
      criacaoIncertaAdota: [1000011],
    });

    const cria = gravador(JSON.stringify(PUBLICAR_ITEM_200));
    await cria.c.publicar({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'R1',
      confirmarCriacaoIncerta: true,
      criacaoIncertaAdota: [],
    });
    expect(corpoEnviado(cria.pedidos[0]?.init)).toStrictEqual({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'R1',
      confirmarCriacaoIncerta: true,
      criacaoIncertaAdota: [],
    });
  });

  it('§I1 NEAR-MISS: an expectation WITHOUT the attestation flag never reaches the route; the flag alone keeps the CLI’s meaning (no expectation key)', async () => {
    const semFlag = gravador(JSON.stringify(PUBLICAR_ITEM_200));
    await semFlag.c.publicar({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'R1',
      criacaoIncertaAdota: [1000011],
    });
    const corpo = corpoEnviado(semFlag.pedidos[0]?.init) as Record<string, unknown>;
    expect(corpo).not.toHaveProperty('criacaoIncertaAdota');
    expect(Object.keys(corpo).sort()).toEqual(['integracaoId', 'linkDocId', 'produtoId']);

    const soFlag = gravador(JSON.stringify(PUBLICAR_ITEM_200));
    await soFlag.c.publicar({
      integracaoId: 'int-1',
      produtoId: 'prod-1',
      linkDocId: 'R1',
      confirmarCriacaoIncerta: true,
    });
    expect(corpoEnviado(soFlag.pedidos[0]?.init)).not.toHaveProperty('criacaoIncertaAdota');
  });

  it('⭐ the item 202 resolves (any 2xx is an answer) as `tipo: item-incerto` — never a thrown failure', async () => {
    const { c } = gravador(
      JSON.stringify({
        arma: 'item',
        desfecho: 'incerto',
        linkDocId: 'R1',
        aguardarMs: 240_000,
        reenvioVerificaSku: false,
        recusa: null,
        mensagem: 'a Shopee pode ter criado o anúncio (--confirmar-criacao-incerta)',
      }),
      202,
    );

    const r = await c.publicar({ integracaoId: 'int-1', produtoId: 'prod-1', linkDocId: 'R1' });

    expect(r).toEqual({
      tipo: 'item-incerto',
      arma: 'item',
      desfecho: 'incerto',
      linkDocId: 'R1',
      aguardarMs: 240_000,
      reenvioVerificaSku: false,
      recusa: null,
    });
  });
});

describe('step 21 — enviarPrecos is NOT Mercado Livre’s (C3)', () => {
  it('⭐ an absent `baixarPreco` is `false`, and `incluirNaoPublicados` is never sent', async () => {
    const { c, pedidos } = gravador(JSON.stringify(PRECOS_200));

    await c.enviarPrecos({ integracaoId: 'int-1', produtoIds: ['prod-1'] });

    expect(corpoEnviado(pedidos[0]?.init)).toStrictEqual({
      integracaoId: 'int-1',
      produtoIds: ['prod-1'],
      baixarPreco: false,
    });
  });

  it('⚠️ NEAR MISS: a caller object CARRYING `incluirNaoPublicados` (ML’s shape) still does not forward it', async () => {
    const comoNoMercadoLivre = {
      integracaoId: 'int-1',
      produtoIds: ['prod-1'],
      incluirNaoPublicados: true,
    };
    const { c, pedidos } = gravador(JSON.stringify(PRECOS_200));

    await c.enviarPrecos(comoNoMercadoLivre);

    expect(corpoEnviado(pedidos[0]?.init)).not.toHaveProperty('incluirNaoPublicados');
  });
});

describe('step 21 — the three pushes forward the signal, and only them (C4, C5)', () => {
  const PUSHES = [
    [
      'enviarEstoque',
      (c: ReturnType<typeof client>, signal?: AbortSignal) =>
        c.enviarEstoque({ integracaoId: 'int-1', produtoIds: ['prod-1'], signal }),
      ESTOQUE_200,
    ],
    [
      'enviarPrecos',
      (c: ReturnType<typeof client>, signal?: AbortSignal) =>
        c.enviarPrecos({ integracaoId: 'int-1', produtoIds: ['prod-1'], signal }),
      PRECOS_200,
    ],
    [
      'definirStatusAnuncios',
      (c: ReturnType<typeof client>, signal?: AbortSignal) =>
        c.definirStatusAnuncios({
          integracaoId: 'int-1',
          produtoIds: ['prod-1'],
          acao: 'pausar',
          signal,
        }),
      STATUS_200,
    ],
  ] as const;

  it.each(PUSHES)(
    '⭐ %s hands `init.signal === signal` — and sends no signal key, nor a body key, when given none',
    async (_nome, chamar, resposta) => {
      const ctrl = new AbortController();
      const { c, pedidos } = gravador(JSON.stringify(resposta));

      await chamar(c, ctrl.signal);
      await chamar(c);

      expect(pedidos[0]?.init?.signal).toBe(ctrl.signal);
      expect(pedidos[1]?.init !== undefined && 'signal' in pedidos[1].init).toBe(false);
      // The signal is a transport option, never a field of the request body.
      expect(corpoEnviado(pedidos[0]?.init)).not.toHaveProperty('signal');
    },
  );

  it.each(PUSHES)(
    '⭐ %s: an ALREADY-aborted signal rejects a NetworkError whose cause is the AbortError (the pinned convention)',
    async (_nome, chamar, resposta) => {
      // A fetch that honours the signal, as the browser's does.
      const c = client(async (_u, init) => {
        if (init?.signal?.aborted === true) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        return ok(JSON.stringify(resposta));
      });
      const ctrl = new AbortController();
      ctrl.abort();

      const err = await chamar(c, ctrl.signal).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ShopeeClientNetworkError);
      const causa = (err as ShopeeClientNetworkError).cause;
      expect(causa).toBeInstanceOf(DOMException);
      expect((causa as DOMException).name).toBe('AbortError');
    },
  );

  it('near-miss — an abort during the BODY read rethrows the DOMException itself', async () => {
    const ctrl = new AbortController();
    const abortado = new DOMException('The operation was aborted.', 'AbortError');
    const c = client(async () => {
      ctrl.abort();
      return new RespostaQueCaiNoCorpo(200, { 'content-type': 'application/json' }, abortado);
    });

    const err = await c
      .enviarEstoque({ integracaoId: 'int-1', produtoIds: ['prod-1'], signal: ctrl.signal })
      .catch((e: unknown) => e);

    expect(err).toBe(abortado);
  });

  it('`publicar` takes no signal — the request carries none', async () => {
    const { c, pedidos } = gravador(JSON.stringify(PUBLICAR_ITEM_200));

    await c.publicar({ integracaoId: 'int-1', produtoId: 'prod-1' });

    expect(pedidos[0]?.init !== undefined && 'signal' in pedidos[0].init).toBe(false);
  });
});

describe('step 21 — an error body’s extras ride on `detalhes` (C6, C7, C16)', () => {
  async function erroDe(corpo: unknown, status: number): Promise<ShopeeClientHttpError> {
    const { c } = gravador(JSON.stringify(corpo), status);
    const err = await c
      .enviarEstoque({ integracaoId: 'int-1', produtoIds: ['prod-1'] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopeeClientHttpError);
    return err as ShopeeClientHttpError;
  }

  it('⭐ a 409 SHOPEE_CONTA_PAUSADA carries `pausadoAte`, the message and code untouched', async () => {
    const err = await erroDe(
      {
        error: 'Conta pausada pela cota diária da Shopee.',
        code: 'SHOPEE_CONTA_PAUSADA',
        pausadoAte: '2026-10-15T16:00:00.000Z',
      },
      409,
    );

    expect(err.detalhes.pausadoAte).toBe('2026-10-15T16:00:00.000Z');
    expect(err.code).toBe('SHOPEE_CONTA_PAUSADA');
    expect(err.message).toBe('Conta pausada pela cota diária da Shopee.');
  });

  it('a 400 SHOPEE_SELECAO_EXCEDE_LIMITE carries `limite` and `solicitados`', async () => {
    const err = await erroDe(
      {
        error: 'Selecione no máximo 50 produtos para enviar o estoque.',
        code: 'SHOPEE_SELECAO_EXCEDE_LIMITE',
        limite: 50,
        solicitados: 51,
      },
      400,
    );

    expect(err.detalhes).toMatchObject({ limite: 50, solicitados: 51 });
  });

  it('a 422 SHOPEE_PRECO_CONTA_RECUSADA carries `motivo` and `regiao`', async () => {
    const err = await erroDe(
      {
        error: 'A conta não aceita envio de preço.',
        code: 'SHOPEE_PRECO_CONTA_RECUSADA',
        motivo: 'regiao-nao-suportada',
        regiao: 'SG',
      },
      422,
    );

    expect(err.detalhes).toMatchObject({ motivo: 'regiao-nao-suportada', regiao: 'SG' });
  });

  it('⭐ a 422 SHOPEE_PUBLISH_BLOCKED carries its `problemas`, each with its `acao`', async () => {
    const { c } = gravador(
      JSON.stringify({
        error: 'Publicação bloqueada.',
        code: 'SHOPEE_PUBLISH_BLOCKED',
        motivo: 'kit-invalido',
        produtoId: 'prod-1',
        itemId: null,
        problemas: [
          {
            campo: null,
            motivo: 'listagem-removida',
            mensagem: 'O kit foi removido da Shopee.',
            acao: { tipo: 'recriar', linkDocId: 'link-1' },
          },
          { campo: 'attribute_list', motivo: 'atributo-obrigatorio', mensagem: 'Falta a marca.' },
        ],
      }),
      422,
    );

    const err = (await c
      .publicar({ integracaoId: 'int-1', produtoId: 'prod-1' })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err.detalhes.problemas).toHaveLength(2);
    expect(err.detalhes.problemas?.[0]?.acao).toEqual({ tipo: 'recriar', linkDocId: 'link-1' });
    // An older backend's row with no `acao` reads as "no next step".
    expect(err.detalhes.problemas?.[1]?.acao).toBeNull();
    expect(err.detalhes.motivo).toBe('kit-invalido');
  });

  it('a 409 SHOPEE_ANUNCIO_NAO_PUBLICADO carries the `linkDocId` to publish', async () => {
    const { c } = gravador(
      JSON.stringify({
        error: 'O vínculo link-1 do produto prod-1 ainda não foi publicado na Shopee.',
        code: 'SHOPEE_ANUNCIO_NAO_PUBLICADO',
        linkDocId: 'link-1',
      }),
      409,
    );

    const err = (await c
      .reverificarAnuncio({ integracaoId: 'int-1', produtoId: 'prod-1' })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err.detalhes.linkDocId).toBe('link-1');
  });

  it('⚠️ NEAR MISS (C7): one malformed extra nulls ONLY itself — its sibling and the message survive', async () => {
    const err = await erroDe(
      {
        error: 'Selecione no máximo 50 produtos para enviar o estoque.',
        code: 'SHOPEE_SELECAO_EXCEDE_LIMITE',
        pausadoAte: 42,
        limite: 50,
      },
      400,
    );

    expect(err.detalhes.pausadoAte).toBeNull();
    expect(err.detalhes.limite).toBe(50);
    expect(err.message).toBe('Selecione no máximo 50 produtos para enviar o estoque.');
  });

  it('⭐ (C16) a 409 SHOPEE_MASS_IMPORT_RUNNING with `jobId` exposes it to attach to', async () => {
    const { c } = gravador(
      JSON.stringify({
        error: 'Já existe uma importação em massa em andamento para esta conta.',
        code: 'SHOPEE_MASS_IMPORT_RUNNING',
        jobId: 'job-vivo',
      }),
      409,
    );

    const err = (await c
      .startMassImport({ integracaoId: 'int-1' })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err.code).toBe('SHOPEE_MASS_IMPORT_RUNNING');
    expect(err.detalhes.jobId).toBe('job-vivo');
  });

  it('⚠️ NEAR MISS (C16): the SAME 409 from an older backend, without `jobId`, still constructs — `null`, message intact', async () => {
    const { c } = gravador(
      JSON.stringify({
        error: 'Já existe uma importação em massa em andamento para esta conta.',
        code: 'SHOPEE_MASS_IMPORT_RUNNING',
      }),
      409,
    );

    const err = (await c
      .startMassImport({ integracaoId: 'int-1' })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err).toBeInstanceOf(ShopeeClientHttpError);
    expect(err.detalhes.jobId).toBeNull();
    expect(err.message).toBe('Já existe uma importação em massa em andamento para esta conta.');
  });

  it.each([
    ['a non-JSON page', NEXT_404],
    ['an empty body', ''],
    ['a JSON array', '[1,2]'],
  ])('a body that is not an object (%s) reads every extra as absent', async (_n, corpo) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { c } = gravador(corpo, 502);

    const err = (await c
      .startPriceSync({ integracaoId: 'int-1' })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err.detalhes).toEqual(DETALHES_ERRO_SHOPEE_VAZIOS);
  });

  it('every existing construction compiles unchanged and defaults `detalhes` to all-absent', () => {
    expect(new ShopeeClientHttpError('m', 500, null).detalhes).toEqual(DETALHES_ERRO_SHOPEE_VAZIOS);
    expect(new ShopeeClientRespostaInvalidaError('m', 200, []).detalhes).toEqual(
      DETALHES_ERRO_SHOPEE_VAZIOS,
    );
  });
});

describe('step 21 — `canal` is a literal: another channel’s envelope is not Shopee’s (C8)', () => {
  it('⭐ a stock envelope saying `mercado-livre` is a RespostaInvalida naming `canal`', async () => {
    const { c } = gravador(JSON.stringify({ ...ESTOQUE_200, canal: 'mercado-livre' }));

    const err = await c
      .enviarEstoque({ integracaoId: 'int-1', produtoIds: ['prod-1'] })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect((err as ShopeeClientRespostaInvalidaError).campos).toContain('canal');
  });

  it('the control: the same envelope saying `shopee` resolves', async () => {
    const { c } = gravador(JSON.stringify(ESTOQUE_200));

    await expect(
      c.enviarEstoque({ integracaoId: 'int-1', produtoIds: ['prod-1'] }),
    ).resolves.toMatchObject({ canal: 'shopee' });
  });
});

describe('step 21 — shopeeClientFalso, the ONE test client literal (C14)', () => {
  it('⭐ every method it was not given REJECTS, naming itself — none resolves silently', async () => {
    const falso = shopeeClientFalso();
    const nomes = Object.keys(falso) as (keyof ShopeeClient)[];

    // EXACTLY the real client's methods — re-derived from the client itself,
    // never a literal count to bump: a method added to one and not the other
    // is named by the diff.
    const reais = Object.keys(client(async () => ok('{}')));
    expect([...nomes].sort()).toEqual([...reais].sort());
    for (const nome of nomes) {
      const metodo = falso[nome] as () => Promise<unknown>;
      await expect(metodo()).rejects.toThrow(`ShopeeClient.${nome} não era esperado neste teste`);
    }
  });

  it('a method the test supplies WINS, and the rest still reject', async () => {
    const conta = vi.fn(async () => ({ ...CONTA, connected: false }) as ShopeeContaStatus);
    const falso = shopeeClientFalso({ conta });

    await expect(falso.conta('int-1')).resolves.toMatchObject({ connected: false });
    expect(conta).toHaveBeenCalledWith('int-1');
    await expect(falso.oauthStart('int-1')).rejects.toThrow('ShopeeClient.oauthStart');
  });
});

/* ---------------------------------------------------------------------------
 * #1911 (P8) — the three draft routes and the two taxonomy reads they add
 * ------------------------------------------------------------------------- */

// Fixture ids only: integração `int-1`, produto `prod-1`, draft id
// `AbCdEfGhIjKlMnOpQrSt` (the create's 20-character shape), a legacy draft id
// `rascunho-legado-1` (edits and discards take any id).
const RASCUNHO_ID = 'AbCdEfGhIjKlMnOpQrSt';

/** Every draft field, as a create without attributes names them (`attributes: null`). */
const CAMPOS: CamposDoCorpoRascunhoShopee = {
  item_name: 'Camiseta básica',
  description: null,
  category_id: 100087,
  marca: { brand_id: 3001, original_brand_name: 'Marca Exemplo' },
  attributes: null,
};

/** Two attributes in the REQUEST shape — a custom value, a listed one, a value with a unit. */
const MATERIAL = {
  attribute_id: 100001,
  attribute_value_list: [{ value_id: 0, original_value_name: 'Algodão' }, { value_id: 7 }],
};
const COMPRIMENTO = {
  attribute_id: 100002,
  attribute_value_list: [{ value_id: 0, original_value_name: '30', value_unit: 'cm' }],
};
const ATRIBUTOS = [MATERIAL, COMPRIMENTO];

const ALVO_RASCUNHO = { integracaoId: 'int-1', produtoId: 'prod-1' };

/** A whole `taxonomia/limites` 200, every band present. */
const LIMITES_DO_ITEM_200 = {
  scope: 'category',
  categoryId: 100087,
  limites: {
    priceLimit: { min: 0.5, max: 100_000 },
    wholesalePriceThresholdPercentage: null,
    stockLimit: { min: 0, max: 999_999 },
    itemNameLengthLimit: { min: 1, max: 120 },
    itemImageCountLimit: { min: 1, max: 9 },
    itemDescriptionLengthLimit: { min: 20, max: 3000 },
    tierVariationNameLengthLimit: { min: 1, max: 14 },
    tierVariationOptionLengthLimit: { min: 1, max: 30 },
    itemCountLimit: null,
    extendedDescriptionLimit: null,
    dtsLimit: { daysToShipLimit: { min: -1, max: 30 }, nonPreOrderDaysToShip: 2 },
    weightLimit: { weightMandatory: true },
    dimensionLimit: { dimensionMandatory: false },
    sizeChartLimit: {
      sizeChartMandatory: null,
      supportImageSizeChart: null,
      supportTemplateSizeChart: true,
    },
  },
  gtinLimit: null,
  supportsPreOrder: true,
};

const RECOMENDACAO_200 = {
  recomendacoes: [
    {
      position: 1,
      categoryId: 100087,
      name: 'Camisetas',
      isLeaf: true,
      pathFromRoot: [{ categoryId: 100017, name: 'Moda', originalName: null, isLeaf: false }],
    },
  ],
  unresolved: 0,
  applied: false,
};

describe('#1911 — each draft and taxonomy method: its route, its verb, its body BY NAME', () => {
  it.each([
    [
      'criarRascunho',
      (c: ReturnType<typeof client>) =>
        c.criarRascunho({ ...ALVO_RASCUNHO, linkDocId: RASCUNHO_ID, conteudo: CAMPOS }),
      { linkDocId: RASCUNHO_ID, criado: true },
      `${BASE}/rascunho`,
      { ...ALVO_RASCUNHO, linkDocId: RASCUNHO_ID, conteudo: CAMPOS },
    ],
    [
      'atualizarRascunho',
      (c: ReturnType<typeof client>) =>
        c.atualizarRascunho({
          ...ALVO_RASCUNHO,
          linkDocId: 'rascunho-legado-1',
          base: { item_name: 'Camiseta' },
          patch: { item_name: 'Camiseta básica' },
        }),
      { linkDocId: 'rascunho-legado-1', gravados: [CAMPO_RASCUNHO_SHOPEE.itemName] },
      `${BASE}/rascunho/atualizar`,
      {
        ...ALVO_RASCUNHO,
        linkDocId: 'rascunho-legado-1',
        base: { item_name: 'Camiseta' },
        patch: { item_name: 'Camiseta básica' },
      },
    ],
    [
      'descartarRascunho',
      (c: ReturnType<typeof client>) =>
        c.descartarRascunho({ ...ALVO_RASCUNHO, linkDocId: 'rascunho-legado-1', base: CAMPOS }),
      { linkDocId: 'rascunho-legado-1', descartado: true, criacaoIncerta: false },
      `${BASE}/rascunho/descartar`,
      { ...ALVO_RASCUNHO, linkDocId: 'rascunho-legado-1', base: CAMPOS },
    ],
    [
      'recomendacaoCategoria',
      (c: ReturnType<typeof client>) =>
        c.recomendacaoCategoria({ integracaoId: 'int/1 2&x', nome: 'Camiseta & Cia/branca' }),
      RECOMENDACAO_200,
      `${BASE}/taxonomia/recomendacao-categoria?integracaoId=int%2F1%202%26x&nome=Camiseta%20%26%20Cia%2Fbranca`,
      undefined,
    ],
    [
      'limitesDoItem (one category)',
      (c: ReturnType<typeof client>) =>
        c.limitesDoItem({ integracaoId: 'int/1 2&x', categoryId: 100087 }),
      LIMITES_DO_ITEM_200,
      `${BASE}/taxonomia/limites?integracaoId=int%2F1%202%26x&categoryId=100087`,
      undefined,
    ],
    [
      'limitesDoItem (shop-wide: the key OMITTED)',
      (c: ReturnType<typeof client>) =>
        c.limitesDoItem({ integracaoId: 'int-1', categoryId: null }),
      { ...LIMITES_DO_ITEM_200, scope: 'shop', categoryId: null },
      `${BASE}/taxonomia/limites?integracaoId=int-1`,
      undefined,
    ],
  ] as const)('⭐ %s', async (_nome, chamar, resposta, url, corpo) => {
    const { c, pedidos } = gravador(JSON.stringify(resposta));

    await expect(chamar(c)).resolves.toEqual(resposta);

    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]?.url).toBe(url);
    // No `signal` on any of them: the draft writes are not the three pushes.
    expect(pedidos[0]?.init !== undefined && 'signal' in pedidos[0].init).toBe(false);
    if (corpo === undefined) {
      expect(pedidos[0]?.init?.method).toBe('GET');
      expect(pedidos[0]?.init).not.toHaveProperty('body');
    } else {
      expect(pedidos[0]?.init?.method).toBe('POST');
      expect(pedidos[0]?.init?.headers).toEqual({
        Authorization: 'Bearer token',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      });
      expect(corpoEnviado(pedidos[0]?.init)).toStrictEqual(corpo);
    }
  });

  it('`limitesDoItem` with `categoryId: 0` SENDS it (the route refuses it) — only `null` is omitted', async () => {
    const { c, pedidos } = gravador(JSON.stringify(LIMITES_DO_ITEM_200));

    await c.limitesDoItem({ integracaoId: 'int-1', categoryId: 0 });

    expect(pedidos[0]?.url).toBe(`${BASE}/taxonomia/limites?integracaoId=int-1&categoryId=0`);
  });
});

describe('#1911 — the draft bodies are rebuilt BY NAME, down to each attribute value', () => {
  it('⭐ a caller’s `conteudo` carrying `item_id` / `logistic_info` never puts them on the wire', async () => {
    // Not a fresh literal: TypeScript lets the extra keys through, exactly as a
    // component spreading a stored link into the call would.
    const doLink = { ...CAMPOS, item_id: 1000001, logistic_info: [], estadoAnuncio: 'ativo' };
    const { c, pedidos } = gravador(JSON.stringify({ linkDocId: RASCUNHO_ID, criado: true }));

    await c.criarRascunho({ ...ALVO_RASCUNHO, linkDocId: RASCUNHO_ID, conteudo: doLink });

    const conteudo = (corpoEnviado(pedidos[0]?.init) as { conteudo: Record<string, unknown> })
      .conteudo;
    expect(conteudo).not.toHaveProperty('item_id');
    expect(conteudo).not.toHaveProperty('logistic_info');
    expect(conteudo).not.toHaveProperty('estadoAnuncio');
  });

  it('NEAR-MISS: the same object WITHOUT the stray keys produces the IDENTICAL body', async () => {
    const comLixo = gravador(JSON.stringify({ linkDocId: RASCUNHO_ID, criado: true }));
    const limpo = gravador(JSON.stringify({ linkDocId: RASCUNHO_ID, criado: true }));

    await comLixo.c.criarRascunho({
      ...ALVO_RASCUNHO,
      linkDocId: RASCUNHO_ID,
      conteudo: { ...CAMPOS, item_id: 1000001 } as CamposDoCorpoRascunhoShopee,
    });
    await limpo.c.criarRascunho({ ...ALVO_RASCUNHO, linkDocId: RASCUNHO_ID, conteudo: CAMPOS });

    expect(comLixo.pedidos[0]?.init?.body).toBe(limpo.pedidos[0]?.init?.body);
  });

  it('⭐ an edit’s `base` AND `patch` drop a stray `item_id` / `logistic_info` too — both are rebuilt', async () => {
    const { c, pedidos } = gravador(
      JSON.stringify({ linkDocId: 'rascunho-legado-1', gravados: [] }),
    );

    await c.atualizarRascunho({
      ...ALVO_RASCUNHO,
      linkDocId: 'rascunho-legado-1',
      base: {
        item_name: 'Camiseta',
        item_id: null,
        logistic_info: [],
      } as Partial<CamposDoCorpoRascunhoShopee>,
      patch: {
        item_name: 'Camiseta básica',
        item_id: 1000001,
      } as Partial<CamposDoCorpoRascunhoShopee>,
    });

    expect(corpoEnviado(pedidos[0]?.init)).toStrictEqual({
      ...ALVO_RASCUNHO,
      linkDocId: 'rascunho-legado-1',
      base: { item_name: 'Camiseta' },
      patch: { item_name: 'Camiseta básica' },
    });
  });

  it('a stray key inside `marca`, an attribute or a value is not forwarded either; the values ride VERBATIM', async () => {
    const sujo = {
      ...CAMPOS,
      marca: { brand_id: 0, original_brand_name: null, displayBrandName: 'No Brand' },
      attributes: [
        {
          ...MATERIAL,
          nome: 'Material',
          attribute_value_list: [
            { value_id: 0, original_value_name: 'Algodão', origem: 'requisicao' },
            { value_id: 7 },
          ],
        },
        COMPRIMENTO,
      ],
    } as CamposDoCorpoRascunhoShopee;
    const { c, pedidos } = gravador(
      JSON.stringify({ linkDocId: 'rascunho-legado-1', descartado: true, criacaoIncerta: false }),
    );

    await c.descartarRascunho({ ...ALVO_RASCUNHO, linkDocId: 'rascunho-legado-1', base: sujo });

    expect((corpoEnviado(pedidos[0]?.init) as { base: unknown }).base).toStrictEqual({
      ...CAMPOS,
      marca: { brand_id: 0, original_brand_name: null },
      attributes: ATRIBUTOS,
    });
  });

  it('⭐ nothing is normalised on the way: an untrimmed title and an EMPTY description travel as typed', async () => {
    // A `base` is compared byte for byte against the stored projection — a
    // client that trimmed or blank⇒null'd it would turn a legacy draft's every
    // save into a conflict.
    const legado = { ...CAMPOS, item_name: ' Camiseta ', description: '' };
    const { c, pedidos } = gravador(
      JSON.stringify({ linkDocId: 'rascunho-legado-1', descartado: true, criacaoIncerta: false }),
    );

    await c.descartarRascunho({ ...ALVO_RASCUNHO, linkDocId: 'rascunho-legado-1', base: legado });

    expect((corpoEnviado(pedidos[0]?.init) as { base: unknown }).base).toStrictEqual(legado);
  });

  it('⭐ an edit sends EXACTLY the keys it was given: `null` is a value and is sent, `undefined` is "not named" and is not', async () => {
    const { c, pedidos } = gravador(
      JSON.stringify({ linkDocId: 'rascunho-legado-1', gravados: [] }),
    );

    await c.atualizarRascunho({
      ...ALVO_RASCUNHO,
      linkDocId: 'rascunho-legado-1',
      base: { category_id: 100087, attributes: ATRIBUTOS, description: undefined },
      patch: { category_id: null, marca: undefined },
    });

    const corpo = corpoEnviado(pedidos[0]?.init) as { base: object; patch: object };
    expect(corpo.base).toStrictEqual({ category_id: 100087, attributes: ATRIBUTOS });
    expect(corpo.patch).toStrictEqual({ category_id: null });
  });

  // The row above pins `null` for `category_id` alone, so the other four keys of
  // the same builder could read `null` as "not named" and nothing would say so.
  // Each `null` here is a real edit: a legacy draft stored with no title, the
  // description handed back to the produto's own, the brand cleared, the
  // attributes cleared. Dropped, the patch names nothing (a 400) or the base no
  // longer names the patch's field (a 400) — the operator's edit never lands.
  it.each<[string, Partial<CamposDoCorpoRascunhoShopee>, Partial<CamposDoCorpoRascunhoShopee>]>([
    ['item_name (a `base` with no stored title)', { item_name: null }, { item_name: 'Camiseta' }],
    [
      'description (the produto’s own again)',
      { description: 'Algodão penteado' },
      { description: null },
    ],
    [
      'category_id (`base` carrying the attributes it clears)',
      { category_id: 100087, attributes: null },
      { category_id: null },
    ],
    ['marca (cleared)', { marca: CAMPOS.marca }, { marca: null }],
    [
      'attributes (cleared; `base` carrying the category the list was built for)',
      { category_id: 100087, attributes: ATRIBUTOS },
      { attributes: null },
    ],
  ])(
    '⭐ NEAR-MISS: an edit’s `null` %s is SENT — `null` is a value for every field, never "not named"',
    async (_campo, base, patch) => {
      const { c, pedidos } = gravador(
        JSON.stringify({ linkDocId: 'rascunho-legado-1', gravados: [] }),
      );

      await c.atualizarRascunho({ ...ALVO_RASCUNHO, linkDocId: 'rascunho-legado-1', base, patch });

      const corpo = corpoEnviado(pedidos[0]?.init) as { base: object; patch: object };
      expect(corpo.base).toStrictEqual(base);
      expect(corpo.patch).toStrictEqual(patch);
    },
  );

  it('the edit’s `base` is never re-derived here — the key set the caller chose is the key set sent (the route judges it)', async () => {
    const { c, pedidos } = gravador(
      JSON.stringify({ linkDocId: 'rascunho-legado-1', gravados: [] }),
    );

    await c.atualizarRascunho({
      ...ALVO_RASCUNHO,
      linkDocId: 'rascunho-legado-1',
      base: { category_id: 100087 },
      patch: { category_id: 100088 },
    });

    expect((corpoEnviado(pedidos[0]?.init) as { base: object }).base).toStrictEqual({
      category_id: 100087,
    });
  });

  it.each([
    [
      'confirmarSegundoAnuncio on the create',
      (c: ReturnType<typeof client>, flag?: true) =>
        c.criarRascunho({
          ...ALVO_RASCUNHO,
          linkDocId: RASCUNHO_ID,
          conteudo: CAMPOS,
          confirmarSegundoAnuncio: flag,
        }),
      'confirmarSegundoAnuncio',
      { linkDocId: RASCUNHO_ID, criado: true },
    ],
    [
      'confirmarCriacaoIncerta on the discard',
      (c: ReturnType<typeof client>, flag?: true) =>
        c.descartarRascunho({
          ...ALVO_RASCUNHO,
          linkDocId: 'rascunho-legado-1',
          base: CAMPOS,
          confirmarCriacaoIncerta: flag,
        }),
      'confirmarCriacaoIncerta',
      { linkDocId: 'rascunho-legado-1', descartado: true, criacaoIncerta: true },
    ],
  ] as const)(
    '%s: sent as `true` when given, OMITTED when absent — never `false`, never `null`',
    async (_n, chamar, chave, resposta) => {
      const { c, pedidos } = gravador(JSON.stringify(resposta));

      await chamar(c, true);
      await chamar(c);

      expect(corpoEnviado(pedidos[0]?.init)).toHaveProperty(chave, true);
      expect(corpoEnviado(pedidos[1]?.init)).not.toHaveProperty(chave);
    },
  );
});

describe('#1911 — the draft answers an operator must read correctly', () => {
  it.each([
    [201, true],
    [200, false],
  ] as const)(
    '⭐ the create’s %i (`criado: %s`) RESOLVES — a double click is a success, never an error',
    async (status, criado) => {
      const { c } = gravador(JSON.stringify({ linkDocId: RASCUNHO_ID, criado }), status);

      await expect(
        c.criarRascunho({ ...ALVO_RASCUNHO, linkDocId: RASCUNHO_ID, conteudo: CAMPOS }),
      ).resolves.toEqual({ linkDocId: RASCUNHO_ID, criado });
    },
  );

  it('NEAR-MISS: a 2xx that is not the create’s answer is a RespostaInvalida — never a draft that "exists"', async () => {
    const { c } = gravador(JSON.stringify({ linkDocId: RASCUNHO_ID }), 201);

    const err = await c
      .criarRascunho({ ...ALVO_RASCUNHO, linkDocId: RASCUNHO_ID, conteudo: CAMPOS })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect((err as ShopeeClientRespostaInvalidaError).campos).toContain('criado');
  });

  it('⭐ a 409 CONFLITO off the wire: its code, its `linkDocId` and its `conflitos` ride on the error', async () => {
    const conflitos = [{ campo: CAMPO_RASCUNHO_SHOPEE.itemName, atual: 'Camiseta' }];
    const { c } = gravador(
      JSON.stringify({
        error: 'o rascunho r-1 mudou desde que foi aberto (item_name). Recarregue.',
        code: CODIGO_RASCUNHO_SHOPEE.conflito,
        linkDocId: 'rascunho-legado-1',
        conflitos,
      }),
      409,
    );

    const err = (await c
      .atualizarRascunho({
        ...ALVO_RASCUNHO,
        linkDocId: 'rascunho-legado-1',
        base: { item_name: 'Camisa' },
        patch: { item_name: 'Camiseta básica' },
      })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err).toBeInstanceOf(ShopeeClientHttpError);
    expect(err.status).toBe(409);
    expect(err.code).toBe(CODIGO_RASCUNHO_SHOPEE.conflito);
    expect(err.detalhes).toMatchObject({ linkDocId: 'rascunho-legado-1', conflitos });
  });

  it('a 409 EM_ANDAMENTO held by a SIBLING carries `aguardarMs` and `vinculos`', async () => {
    const vinculos = [{ linkDocId: 'link-2', itemId: null, rascunho: true }];
    const { c } = gravador(
      JSON.stringify({
        error: 'outro vínculo deste produto nesta conta está sendo publicado (link-2 (rascunho)).',
        code: CODIGO_RASCUNHO_SHOPEE.publicacaoEmAndamento,
        linkDocId: 'rascunho-legado-1',
        aguardarMs: 120_000,
        vinculos,
      }),
      409,
    );

    const err = (await c
      .descartarRascunho({ ...ALVO_RASCUNHO, linkDocId: 'rascunho-legado-1', base: CAMPOS })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err.detalhes).toMatchObject({ aguardarMs: 120_000, vinculos });
  });

  it('⭐ a CODELESS 400 (a refused body) keeps the route’s sentence and `code: null` — never a draft code', async () => {
    const { c } = gravador(
      JSON.stringify({
        error: MSG_ITEM_NAME_EM_BRANCO_RASCUNHO_SHOPEE,
        linkDocId: RASCUNHO_ID,
      }),
      400,
    );

    const err = (await c
      .criarRascunho({
        ...ALVO_RASCUNHO,
        linkDocId: RASCUNHO_ID,
        conteudo: { ...CAMPOS, item_name: '   ' },
      })
      .catch((e: unknown) => e)) as ShopeeClientHttpError;

    expect(err).toBeInstanceOf(ShopeeClientHttpError);
    expect(err.code).toBeNull();
    expect(err.message).toBe(MSG_ITEM_NAME_EM_BRANCO_RASCUNHO_SHOPEE);
    expect(err.detalhes.linkDocId).toBe(RASCUNHO_ID);
  });
});

describe('#1911 — the two taxonomy reads: the whole bands and the suggestion', () => {
  it('⭐ `limitesDoItem` REFUSES a malformed band that `limites` (the slice) tolerates — on the SAME body', async () => {
    const corpo = JSON.stringify({
      ...LIMITES_DO_ITEM_200,
      limites: { ...LIMITES_DO_ITEM_200.limites, stockLimit: 'quebrado' },
    });

    const inteiro = gravador(corpo);
    const err = await inteiro.c
      .limitesDoItem({ integracaoId: 'int-1', categoryId: 100087 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect((err as ShopeeClientRespostaInvalidaError).campos).toContain('limites.stockLimit');

    const fatia = gravador(corpo);
    await expect(
      fatia.c.limites({ integracaoId: 'int-1', categoryId: 100087 }),
    ).resolves.toMatchObject({
      limites: { sizeChartLimit: LIMITES_DO_ITEM_200.limites.sizeChartLimit },
    });
  });

  it('`limitesDoItem` keeps every band; `limites` on the same body keeps ONLY the size-chart slice', async () => {
    const inteiro = gravador(JSON.stringify(LIMITES_DO_ITEM_200));
    const fatia = gravador(JSON.stringify(LIMITES_DO_ITEM_200));

    const todos = await inteiro.c.limitesDoItem({ integracaoId: 'int-1', categoryId: 100087 });
    const so = await fatia.c.limites({ integracaoId: 'int-1', categoryId: 100087 });

    expect(todos.limites.itemNameLengthLimit).toEqual({ min: 1, max: 120 });
    expect(todos.supportsPreOrder).toBe(true);
    expect(so.limites).toStrictEqual({
      sizeChartLimit: LIMITES_DO_ITEM_200.limites.sizeChartLimit,
    });
  });

  it('⭐ a suggestion claiming `applied: true` is a RespostaInvalida — never offered as if chosen', async () => {
    const { c } = gravador(JSON.stringify({ ...RECOMENDACAO_200, applied: true }));

    const err = await c
      .recomendacaoCategoria({ integracaoId: 'int-1', nome: 'Camiseta' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect((err as ShopeeClientRespostaInvalidaError).campos).toContain('applied');
  });

  it('the suggestion GET never sends `imagemCapa` — the browser holds no Shopee image id', async () => {
    const { c, pedidos } = gravador(JSON.stringify(RECOMENDACAO_200));

    await c.recomendacaoCategoria({ integracaoId: 'int-1', nome: 'Camiseta' });

    expect(pedidos[0]?.url).not.toContain('imagemCapa');
  });
});

/* ---------------------------------------------------------------------------
 * #1911 (P9) — `marcas`: one page of a category's brands, for the Marcas section
 * ------------------------------------------------------------------------- */

/** A `taxonomia/marcas` 200: one leaf page, «No Brand» included, more pages to come. */
const MARCAS_200 = {
  leaf: true,
  categoryId: 100087,
  status: 1,
  offset: 0,
  pageSize: 100,
  marcas: [
    { brandId: 0, originalBrandName: 'No Brand', displayBrandName: null },
    { brandId: 3001, originalBrandName: 'Marca Exemplo', displayBrandName: 'Marca Exemplo BR' },
  ],
  hasNextPage: true,
  nextOffset: 37,
  isMandatory: false,
  inputType: 'DROP_DOWN',
};

describe('#1911 — `marcas`: one page of a category’s brands', () => {
  it('⭐ a GET with EVERY parameter percent-encoded, no body, no signal — parsed whole', async () => {
    const { c, pedidos } = gravador(JSON.stringify(MARCAS_200));

    await expect(
      c.marcas({
        integracaoId: 'int/1 2&x',
        categoryId: 100087,
        offset: 37,
        pageSize: 50,
        status: 2,
      }),
    ).resolves.toEqual(MARCAS_200);

    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]?.url).toBe(
      `${BASE}/taxonomia/marcas?integracaoId=int%2F1%202%26x&categoryId=100087&offset=37&pageSize=50&status=2`,
    );
    expect(pedidos[0]?.init?.method).toBe('GET');
    expect(pedidos[0]?.init).not.toHaveProperty('body');
    expect(pedidos[0]?.init !== undefined && 'signal' in pedidos[0].init).toBe(false);
  });

  it('each optional key OMITTED when absent — the route’s defaults apply', async () => {
    const { c, pedidos } = gravador(JSON.stringify(MARCAS_200));

    await c.marcas({ integracaoId: 'int-1', categoryId: 100087 });

    expect(pedidos[0]?.url).toBe(`${BASE}/taxonomia/marcas?integracaoId=int-1&categoryId=100087`);
  });

  it('NEAR-MISS: `offset: 0` is SENT — only an absent key is omitted', async () => {
    const { c, pedidos } = gravador(JSON.stringify(MARCAS_200));

    await c.marcas({ integracaoId: 'int-1', categoryId: 100087, offset: 0 });

    expect(pedidos[0]?.url).toBe(
      `${BASE}/taxonomia/marcas?integracaoId=int-1&categoryId=100087&offset=0`,
    );
  });

  it('⭐ `nextOffset` is Shopee’s cursor VERBATIM — never recomputed as offset + pageSize', async () => {
    const { c } = gravador(JSON.stringify(MARCAS_200));

    const pagina = await c.marcas({ integracaoId: 'int-1', categoryId: 100087 });

    expect(pagina.nextOffset).toBe(37);
    expect(pagina.nextOffset).not.toBe(pagina.offset + pagina.pageSize);
    // «No Brand» is a row of the page, a value — the picker decides, not the client.
    expect(pagina.marcas[0]?.brandId).toBe(0);
  });

  it('a non-leaf answers the same shape, empty — and parses', async () => {
    const vazia = {
      ...MARCAS_200,
      leaf: false,
      marcas: [],
      hasNextPage: false,
      nextOffset: null,
      isMandatory: null,
      inputType: null,
    };
    const { c } = gravador(JSON.stringify(vazia));

    await expect(c.marcas({ integracaoId: 'int-1', categoryId: 100017 })).resolves.toEqual(vazia);
  });

  it.each([
    ['a quoted brandId (our serialisation, strict)', { brandId: '3001' }, 'marcas[].brandId'],
    [
      'a missing displayBrandName (every key required)',
      { displayBrandName: undefined },
      'marcas[].displayBrandName',
    ],
  ])('⭐ NEAR-MISS: %s is a RespostaInvalida, never a page', async (_n, estrago, campo) => {
    const corpo = {
      ...MARCAS_200,
      marcas: [{ ...MARCAS_200.marcas[1], ...estrago }],
    };
    const { c } = gravador(JSON.stringify(corpo));

    const err = await c
      .marcas({ integracaoId: 'int-1', categoryId: 100087 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect((err as ShopeeClientRespostaInvalidaError).campos).toContain(campo);
  });

  it('an unknown key STRIPS — a newer route never costs an older browser', async () => {
    const { c } = gravador(JSON.stringify({ ...MARCAS_200, campoDoFuturo: 1 }));

    const pagina = await c.marcas({ integracaoId: 'int-1', categoryId: 100087 });

    expect('campoDoFuturo' in pagina).toBe(false);
  });

  it('an unknown category is the 404 with its code — the backend’s sentence', async () => {
    const { c } = gravador(
      JSON.stringify({
        error: 'Categoria 999 não existe na árvore desta conta.',
        code: 'SHOPEE_CATEGORIA_DESCONHECIDA',
      }),
      404,
    );

    const err = await c.marcas({ integracaoId: 'int-1', categoryId: 999 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientHttpError);
    expect((err as ShopeeClientHttpError).status).toBe(404);
    expect((err as ShopeeClientHttpError).code).toBe('SHOPEE_CATEGORIA_DESCONHECIDA');
    expect((err as ShopeeClientHttpError).message).toBe(
      'Categoria 999 não existe na árvore desta conta.',
    );
  });
});

/**
 * The tree as `GET …/taxonomia/variacoes` projects it: hand-written in the shape
 * of the public `get_variation_tree.br-*` captures, because a web test cannot
 * import `apps/shopee`'s fixtures. What the tree MEANS is `./variacoes.test.ts`.
 */
const VARIACOES_200 = {
  leaf: true,
  categoryId: 100244,
  standardiseVariationList: [
    {
      variationId: 101056,
      variationName: 'Tamanho',
      variationGroupList: [
        {
          variationGroupId: 841350766059029,
          variationGroupName: 'Tamanho (INT)',
          variationOptionList: [{ variationOptionId: 6270, variationOptionName: 'M' }],
        },
        {
          variationGroupId: 844758844060204,
          variationGroupName: 'Tamanho (BR)',
          variationOptionList: [{ variationOptionId: 6933, variationOptionName: 'M' }],
        },
      ],
    },
    {
      variationId: 900001,
      variationName: ' Estampa',
      variationGroupList: [
        {
          variationGroupId: 0,
          variationGroupName: '',
          variationOptionList: [{ variationOptionId: 900101, variationOptionName: ' Azul ' }],
        },
      ],
    },
    { variationId: 103236, variationName: 'Estilo', variationGroupList: [] },
  ],
  pathUsed: '/api/v2/product/get_variation_tree',
};

/** The route's 502 when Shopee answers its 404: `respond.ts`'s body, by name. */
const VARIACOES_502_NAO_ENCONTRADO = {
  error: 'Shopee: error_not_found',
  code: 'SHOPEE_HTTP_ERROR',
  upstreamStatus: 404,
  shopeeCode: 'error_not_found',
  kind: 'other',
};

describe('#1911 (P14) — `variacoes`: a árvore de variações de uma categoria folha', () => {
  it('⭐ um GET com as DUAS chaves codificadas, sem corpo e sem signal', async () => {
    const { c, pedidos } = gravador(JSON.stringify(VARIACOES_200));

    await c.variacoes({ integracaoId: 'int/1 2&x', categoryId: 100244 });

    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]?.url).toBe(
      `${BASE}/taxonomia/variacoes?integracaoId=int%2F1%202%26x&categoryId=100244`,
    );
    expect(pedidos[0]?.init?.method).toBe('GET');
    expect(pedidos[0]?.init).not.toHaveProperty('body');
    expect(pedidos[0]?.init !== undefined && 'signal' in pedidos[0].init).toBe(false);
  });

  it('⭐ um 200 é lido pelo schema compartilhado, e os nomes e ids chegam intactos', async () => {
    const { c } = gravador(JSON.stringify(VARIACOES_200));

    const lida = await c.variacoes({ integracaoId: 'int-1', categoryId: 100244 });

    expect(lida).toEqual(respostaVariacoesShopeeSchema.parse(VARIACOES_200));
    expect(lida).toEqual(VARIACOES_200);
    const [tamanho, estampa] = lida.standardiseVariationList;
    expect(tamanho?.variationGroupList[1]?.variationGroupId).toBe(844758844060204);
    expect(estampa?.variationName).toBe(' Estampa');
    expect(estampa?.variationGroupList[0]?.variationOptionList[0]?.variationOptionName).toBe(
      ' Azul ',
    );
  });

  it('uma chave desconhecida é descartada: uma rota mais nova não custa um navegador mais velho', async () => {
    const { c } = gravador(JSON.stringify({ ...VARIACOES_200, campoDoFuturo: 1 }));

    const lida = await c.variacoes({ integracaoId: 'int-1', categoryId: 100244 });

    expect('campoDoFuturo' in lida).toBe(false);
  });

  it('uma categoria que não é folha responde o mesmo formato, vazio, e é lida', async () => {
    const vazia = { ...VARIACOES_200, leaf: false, standardiseVariationList: [] };
    const { c } = gravador(JSON.stringify(vazia));

    await expect(c.variacoes({ integracaoId: 'int-1', categoryId: 100017 })).resolves.toEqual(
      vazia,
    );
  });

  it('⭐ um corpo sem `pathUsed` é RespostaInvalida, nunca uma árvore', async () => {
    const { pathUsed: _semPath, ...semPath } = VARIACOES_200;
    const { c } = gravador(JSON.stringify(semPath));

    const err = await c
      .variacoes({ integracaoId: 'int-1', categoryId: 100244 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect((err as ShopeeClientRespostaInvalidaError).campos).toEqual(['pathUsed']);
  });

  it.each([
    [
      'um id de variação entre aspas',
      { variationId: '101056', variationName: 'Tamanho', variationGroupList: [] },
      'standardiseVariationList[].variationId',
    ],
    [
      'uma variação sem a lista de grupos',
      { variationId: 101056, variationName: 'Tamanho' },
      'standardiseVariationList[].variationGroupList',
    ],
  ])('NEAR-MISS: %s é RespostaInvalida', async (_n, variacao, campo) => {
    const { c } = gravador(
      JSON.stringify({ ...VARIACOES_200, standardiseVariationList: [variacao] }),
    );

    const err = await c
      .variacoes({ integracaoId: 'int-1', categoryId: 100244 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect((err as ShopeeClientRespostaInvalidaError).campos).toContain(campo);
  });

  it('⭐ o 502 `error_not_found` chega como ShopeeClientHttpError, com esse `shopeeCode`', async () => {
    const { c } = gravador(JSON.stringify(VARIACOES_502_NAO_ENCONTRADO), 502);

    const err = await c
      .variacoes({ integracaoId: 'int-1', categoryId: 100244 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientHttpError);
    expect(err).not.toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    const http = err as ShopeeClientHttpError;
    expect(http.status).toBe(502);
    expect(http.code).toBe('SHOPEE_HTTP_ERROR');
    expect(http.shopeeCode).toBe('error_not_found');
    expect(http.kind).toBe('other');
    expect(http.message).toBe('Shopee: error_not_found');
  });

  it('NEAR-MISS: a categoria desconhecida é um 404 com o código dela, sem `shopeeCode`', async () => {
    const { c } = gravador(
      JSON.stringify({
        error: 'Categoria 999 não existe na árvore desta conta.',
        code: 'SHOPEE_CATEGORIA_DESCONHECIDA',
      }),
      404,
    );

    const err = await c
      .variacoes({ integracaoId: 'int-1', categoryId: 999 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientHttpError);
    expect((err as ShopeeClientHttpError).status).toBe(404);
    expect((err as ShopeeClientHttpError).code).toBe('SHOPEE_CATEGORIA_DESCONHECIDA');
    expect((err as ShopeeClientHttpError).shopeeCode).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * #1911 (P13) — `atributos`: a leaf category's attribute tree, for a draft's
 * «Atributos» section and its publish gate
 * ------------------------------------------------------------------------- */

/** One attribute's editor metadata as `GET …/taxonomia/atributos` projects it (every key present). */
const INFO_ATRIBUTO = {
  inputType: 1,
  inputValidationType: 0,
  formatType: 1,
  dateFormatType: null,
  attributeUnitList: null,
  maxValueCount: null,
  introduction: null,
  isOem: false,
  supportSearchValue: false,
};

/**
 * The tree as the route projects it: hand-written in the shape of the public
 * `get_attribute_tree.br-*` captures (Shopee's own taxonomy ids and names),
 * because a web test cannot import `apps/shopee`'s fixtures. A mandatory
 * attribute whose second value unlocks a mandatory child, and a typed decimal
 * with its own unit list.
 */
const ATRIBUTOS_200 = {
  leaf: true,
  categoryId: 100087,
  warning: null,
  truncated: false,
  atributos: [
    {
      attributeId: 100408,
      mandatory: true,
      name: 'Tipo de Conexão',
      attributeInfo: INFO_ATRIBUTO,
      attributeValueList: [
        {
          valueId: 2498,
          name: 'Com fio, Sem conexão ou Outros',
          valueUnit: null,
          childAttributeList: [],
        },
        {
          valueId: 2530,
          name: 'Sem fio (Bluetooth, Wifi, Radiofrequência)',
          valueUnit: null,
          childAttributeList: [
            {
              attributeId: 101237,
              mandatory: true,
              name: 'Fabricante',
              attributeInfo: {
                ...INFO_ATRIBUTO,
                inputType: 2,
                inputValidationType: 2,
                supportSearchValue: true,
              },
              attributeValueList: [],
            },
          ],
        },
      ],
    },
    {
      attributeId: 101029,
      mandatory: false,
      name: 'Tamanho Do Pacote',
      attributeInfo: {
        ...INFO_ATRIBUTO,
        inputType: 3,
        inputValidationType: 3,
        formatType: 2,
        attributeUnitList: [
          'ML',
          'L',
          'MG',
          'G/GR',
          'KG',
          'CM',
          'M',
          'Dozen',
          'Piece',
          'Pack',
          'Set',
          'Box',
        ],
      },
      attributeValueList: [],
    },
  ],
};

describe('#1911 (P13) — `atributos`: a árvore de atributos de uma categoria folha', () => {
  it('⭐ um GET com as DUAS chaves codificadas, sem corpo, sem Content-Type e sem signal', async () => {
    const { c, pedidos } = gravador(JSON.stringify(ATRIBUTOS_200));

    await c.atributos({ integracaoId: 'int/1 2&x', categoryId: 100087 });

    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]?.url).toBe(
      `${BASE}/taxonomia/atributos?integracaoId=int%2F1%202%26x&categoryId=100087`,
    );
    expect(pedidos[0]?.init?.method).toBe('GET');
    expect(pedidos[0]?.init).not.toHaveProperty('body');
    expect(pedidos[0]?.init?.headers).toEqual({
      Authorization: 'Bearer token',
      Accept: 'application/json',
    });
    expect(pedidos[0]?.init !== undefined && 'signal' in pedidos[0].init).toBe(false);
  });

  it('NEAR-MISS: é a rota dos ATRIBUTOS — nem a dos limites, nem a das variações, com a mesma consulta', async () => {
    const { c, pedidos } = gravador(JSON.stringify(ATRIBUTOS_200));

    await c.atributos({ integracaoId: 'int-1', categoryId: 100087 });

    expect(pedidos[0]?.url).toBe(
      `${BASE}/taxonomia/atributos?integracaoId=int-1&categoryId=100087`,
    );
    expect(pedidos[0]?.url).not.toContain('/taxonomia/limites');
    expect(pedidos[0]?.url).not.toContain('/taxonomia/variacoes');
  });

  it('⭐ um 200 é lido pelo schema compartilhado: o filho sob o valor, os ids e as unidades chegam intactos', async () => {
    const { c } = gravador(JSON.stringify(ATRIBUTOS_200));

    const lida = await c.atributos({ integracaoId: 'int-1', categoryId: 100087 });

    expect(lida).toEqual(respostaAtributosShopeeSchema.parse(ATRIBUTOS_200));
    expect(lida).toEqual(ATRIBUTOS_200);
    const [conexao, pacote] = lida.atributos;
    expect(conexao?.attributeValueList[1]?.childAttributeList[0]?.attributeId).toBe(101237);
    // NEAR-MISS: the OTHER value unlocks nothing — the tree, not the client, says where a child hangs.
    expect(conexao?.attributeValueList[0]?.childAttributeList).toEqual([]);
    // Shopee's unit list verbatim: its order and its case (`ML`, never folded to `ml`).
    expect(pacote?.attributeInfo?.attributeUnitList?.slice(0, 3)).toEqual(['ML', 'L', 'MG']);
    expect(pacote?.attributeInfo?.attributeUnitList).not.toContain('ml');
  });

  it('`truncated: true` e o valor `0` são valores: a árvore incompleta é lida, não recusada', async () => {
    const corpo = {
      ...ATRIBUTOS_200,
      truncated: true,
      atributos: [
        {
          attributeId: 100999,
          mandatory: false,
          name: null,
          attributeInfo: null,
          attributeValueList: [{ valueId: 0, name: null, valueUnit: '', childAttributeList: [] }],
        },
      ],
    };
    const { c } = gravador(JSON.stringify(corpo));

    await expect(c.atributos({ integracaoId: 'int-1', categoryId: 100087 })).resolves.toEqual(
      corpo,
    );
  });

  it('uma chave desconhecida é descartada, também dentro da árvore: uma rota mais nova não custa um navegador mais velho', async () => {
    const corpo = {
      ...ATRIBUTOS_200,
      campoDoFuturo: 1,
      atributos: [{ ...ATRIBUTOS_200.atributos[1], campoDoFuturo: 2 }],
    };
    const { c } = gravador(JSON.stringify(corpo));

    const lida = await c.atributos({ integracaoId: 'int-1', categoryId: 100087 });

    expect('campoDoFuturo' in lida).toBe(false);
    expect(lida.atributos[0] !== undefined && 'campoDoFuturo' in lida.atributos[0]).toBe(false);
  });

  it('uma categoria que não é folha responde o mesmo formato, vazio, e é lida', async () => {
    const vazia = { ...ATRIBUTOS_200, leaf: false, atributos: [] };
    const { c } = gravador(JSON.stringify(vazia));

    await expect(c.atributos({ integracaoId: 'int-1', categoryId: 100017 })).resolves.toEqual(
      vazia,
    );
  });

  it('⭐ um corpo sem `truncated` é RespostaInvalida, nunca uma árvore completa', async () => {
    const { truncated: _semTruncated, ...semTruncated } = ATRIBUTOS_200;
    const { c } = gravador(JSON.stringify(semTruncated));

    const err = await c
      .atributos({ integracaoId: 'int-1', categoryId: 100087 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect((err as ShopeeClientRespostaInvalidaError).campos).toEqual(['truncated']);
  });

  it.each([
    [
      'um id de atributo entre aspas',
      [{ ...ATRIBUTOS_200.atributos[1], attributeId: '101029' }],
      'atributos[].attributeId',
    ],
    [
      'um FILHO com o id entre aspas (a recursão é lida)',
      [
        {
          ...ATRIBUTOS_200.atributos[0],
          attributeValueList: [
            {
              valueId: 2530,
              name: 'Sem fio',
              valueUnit: null,
              childAttributeList: [
                {
                  attributeId: '101237',
                  mandatory: true,
                  name: 'Fabricante',
                  attributeInfo: null,
                  attributeValueList: [],
                },
              ],
            },
          ],
        },
      ],
      'atributos[].attributeValueList[].childAttributeList[].attributeId',
    ],
    [
      'uma lista de unidades que não é de textos',
      [
        {
          ...ATRIBUTOS_200.atributos[1],
          attributeInfo: { ...INFO_ATRIBUTO, formatType: 2, attributeUnitList: [1] },
        },
      ],
      'atributos[].attributeInfo.attributeUnitList[]',
    ],
  ])('NEAR-MISS: %s é RespostaInvalida', async (_n, atributos, campo) => {
    const { c } = gravador(JSON.stringify({ ...ATRIBUTOS_200, atributos }));

    const err = await c
      .atributos({ integracaoId: 'int-1', categoryId: 100087 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect((err as ShopeeClientRespostaInvalidaError).campos).toContain(campo);
  });

  it('a categoria desconhecida é o 404 com o código dela — a frase do backend', async () => {
    const { c } = gravador(
      JSON.stringify({
        error: 'Categoria 999 não existe na árvore desta conta.',
        code: 'SHOPEE_CATEGORIA_DESCONHECIDA',
      }),
      404,
    );

    const err = await c
      .atributos({ integracaoId: 'int-1', categoryId: 999 })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ShopeeClientHttpError);
    expect(err).not.toBeInstanceOf(ShopeeClientRespostaInvalidaError);
    expect((err as ShopeeClientHttpError).status).toBe(404);
    expect((err as ShopeeClientHttpError).code).toBe('SHOPEE_CATEGORIA_DESCONHECIDA');
    expect((err as ShopeeClientHttpError).message).toBe(
      'Categoria 999 não existe na árvore desta conta.',
    );
  });
});
