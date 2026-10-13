import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  CODIGO_ERRO_LI,
  SITUACAO_VALIDADE_TOKEN_LI,
  type StatusContaLojaIntegrada,
} from '@delfrance/schemas';

/**
 * The browser client for `apps/loja-integrada`'s conta routes.
 *
 * Three things are pinned here, each with its near miss:
 *
 *  1. the WIRE — method, path, percent-encoded id, the exact body keys, the ID
 *     token header — against the routes PR b shipped;
 *  2. every answer is READ against the shared contract (`@delfrance/schemas`),
 *     the error envelope included — nothing is cast;
 *  3. the Personal Token reaches no URL, no `err.message`, no `String(err)` and
 *     no console line, across every failure kind — including a proxy that
 *     ECHOES the request back;
 *
 * plus the fail-closed rule: an `https:` page never gets a client for an
 * `http:` backend.
 */

const h = vi.hoisted(() => ({
  user: null as null | { getIdToken: () => Promise<string> },
}));

vi.mock('@/lib/auth/useAuth', () => ({ useAuth: () => ({ user: h.user }) }));

const {
  DEFAULT_LOJA_INTEGRADA_URL,
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
  LojaIntegradaClientRespostaInvalidaError,
  createLojaIntegradaClient,
  resolverBackendLojaIntegrada,
  useBackendLojaIntegrada,
  useLojaIntegradaClient,
} = await import('./client');

const BASE = 'https://li.backend.test';
/** A sentinel no legitimate code path would ever produce on its own. */
const TOKEN = 'li-sentinela-0d9f3c7a1e5b48f2a6c4e8b0d2f4a6c8';

interface Chamada {
  readonly url: string;
  readonly init: RequestInit;
}

function cliente(responder: (c: Chamada) => Promise<Response> | Response) {
  const chamadas: Chamada[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const chamada = { url: String(input), init: init ?? {} };
    chamadas.push(chamada);
    return responder(chamada);
  });
  const c = createLojaIntegradaClient({
    baseUrl: `${BASE}/`,
    getAuthToken: async () => 'id-token-firebase',
    fetch: fetchImpl,
  });
  return { c, chamadas };
}

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const STATUS: StatusContaLojaIntegrada = {
  configurado: true,
  expiraEm: '2026-12-31',
  diasParaExpirar: 84,
  situacaoValidade: SITUACAO_VALIDADE_TOKEN_LI.ok,
  atualizadoEmMs: 1_790_000_000_000,
  versaoCredencialUs: 1_790_000_000_123_456,
  reconexaoPendente: null,
};

const RESPOSTA = { ...STATUS, versaoCredencialUs: 1_790_000_100_000_001, reconexaoResolvida: true };

function corpoEnviado(c: Chamada): unknown {
  return typeof c.init.body === 'string' ? JSON.parse(c.init.body) : undefined;
}

function cabecalhos(c: Chamada): Record<string, string> {
  return { ...(c.init.headers as Record<string, string>) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the wire, route by route', () => {
  it('conta → GET …/conta/<id>, the ID token as Bearer, no body', async () => {
    const { c, chamadas } = cliente(() => json(200, STATUS));

    await expect(c.conta('conta-1')).resolves.toEqual(STATUS);

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe(`${BASE}/api/marketplace/loja-integrada/conta/conta-1`);
    expect(chamadas[0]!.init.method).toBe('GET');
    expect(chamadas[0]!.init.body).toBeUndefined();
    expect(cabecalhos(chamadas[0]!)).toMatchObject({
      Authorization: 'Bearer id-token-firebase',
      Accept: 'application/json',
    });
    expect(cabecalhos(chamadas[0]!)['Content-Type']).toBeUndefined();
  });

  it('percent-encodes the id — a slash or a space can never reach another route', async () => {
    const { c, chamadas } = cliente(() => json(200, STATUS));

    await c.conta('a/b c');

    expect(chamadas[0]!.url).toBe(`${BASE}/api/marketplace/loja-integrada/conta/a%2Fb%20c`);
  });

  it('salvarCredencial → PUT …/credencial with EXACTLY token, expiraEm, versaoEsperada', async () => {
    const { c, chamadas } = cliente(() => json(200, RESPOSTA));
    const corpo = { token: TOKEN, expiraEm: '2026-12-31', versaoEsperada: 42, extra: 'x' };

    await expect(c.salvarCredencial('conta-1', corpo)).resolves.toEqual(RESPOSTA);

    expect(chamadas[0]!.url).toBe(
      `${BASE}/api/marketplace/loja-integrada/conta/conta-1/credencial`,
    );
    expect(chamadas[0]!.init.method).toBe('PUT');
    expect(cabecalhos(chamadas[0]!)['Content-Type']).toBe('application/json');
    // Rebuilt BY NAME: the route's body schema is strict, so the caller's extra
    // key must not ride along (it would be a 400).
    expect(corpoEnviado(chamadas[0]!)).toEqual({
      token: TOKEN,
      expiraEm: '2026-12-31',
      versaoEsperada: 42,
    });
  });

  it('keeps a null versaoEsperada as null — the "I saw no token" create path', async () => {
    const { c, chamadas } = cliente(() => json(200, RESPOSTA));

    await c.salvarCredencial('conta-1', {
      token: TOKEN,
      expiraEm: '2026-12-31',
      versaoEsperada: null,
    });

    expect(corpoEnviado(chamadas[0]!)).toEqual({
      token: TOKEN,
      expiraEm: '2026-12-31',
      versaoEsperada: null,
    });
  });

  it('renovarValidade → PUT …/credencial/validade with EXACTLY expiraEm, versaoEsperada', async () => {
    const { c, chamadas } = cliente(() => json(200, RESPOSTA));
    const corpo = { expiraEm: '2027-01-15', versaoEsperada: 7, token: TOKEN };

    await c.renovarValidade('conta-1', corpo);

    expect(chamadas[0]!.url).toBe(
      `${BASE}/api/marketplace/loja-integrada/conta/conta-1/credencial/validade`,
    );
    expect(chamadas[0]!.init.method).toBe('PUT');
    // The renewal never carries a token, even when a caller hands one over.
    expect(corpoEnviado(chamadas[0]!)).toEqual({ expiraEm: '2027-01-15', versaoEsperada: 7 });
    expect(chamadas[0]!.init.body).not.toContain(TOKEN);
  });

  it('removerCredencial → DELETE …/credencial, no body', async () => {
    const { c, chamadas } = cliente(() => json(200, { ok: true }));

    await expect(c.removerCredencial('conta-1')).resolves.toEqual({ ok: true });

    expect(chamadas[0]!.url).toBe(
      `${BASE}/api/marketplace/loja-integrada/conta/conta-1/credencial`,
    );
    expect(chamadas[0]!.init.method).toBe('DELETE');
    expect(chamadas[0]!.init.body).toBeUndefined();
  });
});

describe('every 2xx is read against the shared schema', () => {
  it('⭐ a status missing its version is RESPOSTA_INVALIDA, never a status with versao undefined', async () => {
    // The version is what every write echoes: a status that silently lacked it
    // would send `versaoEsperada: undefined`, which JSON drops — a 400 at best.
    const { versaoCredencialUs: _sem, ...semVersao } = STATUS;
    const { c } = cliente(() => json(200, semVersao));

    const err = await c.conta('conta-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LojaIntegradaClientRespostaInvalidaError);
    expect((err as InstanceType<typeof LojaIntegradaClientRespostaInvalidaError>).campos).toEqual([
      'versaoCredencialUs',
    ]);
    expect((err as Error).message).toContain('versaoCredencialUs');
  });

  it('tolerates a key a newer backend adds (the status schema is not strict)', async () => {
    const { c } = cliente(() => json(200, { ...STATUS, campoNovo: 1 }));

    await expect(c.conta('conta-1')).resolves.toEqual(STATUS);
  });

  it('a save answer without reconexaoResolvida is RESPOSTA_INVALIDA', async () => {
    const { reconexaoResolvida: _r, ...semFlag } = RESPOSTA;
    const { c } = cliente(() => json(200, semFlag));

    await expect(
      c.salvarCredencial('conta-1', { token: TOKEN, expiraEm: '2026-12-31', versaoEsperada: null }),
    ).rejects.toBeInstanceOf(LojaIntegradaClientRespostaInvalidaError);
  });

  it('an EMPTY 2xx is RESPOSTA_INVALIDA, and says the request never reached the route', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { c } = cliente(() => new Response('', { status: 200 }));

    const err = (await c.removerCredencial('conta-1').catch((e: unknown) => e)) as Error;

    expect(err).toBeInstanceOf(LojaIntegradaClientRespostaInvalidaError);
    expect(err.message).toContain('sem um corpo JSON');
    expect(err.message).not.toContain('deploy');
  });

  it('a removal answering { ok: false } is refused — only the literal true is a removal', async () => {
    const { c } = cliente(() => json(200, { ok: false }));

    await expect(c.removerCredencial('conta-1')).rejects.toBeInstanceOf(
      LojaIntegradaClientRespostaInvalidaError,
    );
  });

  it('RESPOSTA_INVALIDA is a subclass of the HTTP error, so a narrowing on the base still catches it', async () => {
    const { c } = cliente(() => json(200, {}));

    const err = await c.conta('conta-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LojaIntegradaClientHttpError);
    expect((err as InstanceType<typeof LojaIntegradaClientHttpError>).code).toBe(
      'RESPOSTA_INVALIDA',
    );
    expect((err as InstanceType<typeof LojaIntegradaClientHttpError>).status).toBe(200);
  });
});

describe('the error envelope', () => {
  it('carries code, issues, Loja Integrada status and correlation id from the envelope', async () => {
    const { c } = cliente(() =>
      json(422, {
        error: 'A Loja Integrada recusou o token.',
        code: CODIGO_ERRO_LI.tokenRecusado,
        status: 401,
        correlationId: 'corr-1',
      }),
    );

    const err = (await c
      .salvarCredencial('conta-1', { token: TOKEN, expiraEm: '2026-12-31', versaoEsperada: null })
      .catch((e: unknown) => e)) as InstanceType<typeof LojaIntegradaClientHttpError>;

    expect(err).toBeInstanceOf(LojaIntegradaClientHttpError);
    expect(err).not.toBeInstanceOf(LojaIntegradaClientRespostaInvalidaError);
    expect(err.status).toBe(422);
    expect(err.code).toBe('LI_TOKEN_RECUSADO');
    expect(err.statusLi).toBe(401);
    expect(err.correlationId).toBe('corr-1');
    expect(err.message).toBe('A Loja Integrada recusou o token.');
  });

  it('carries the field paths of a refused date', async () => {
    const { c } = cliente(() =>
      json(422, { error: 'passou', code: CODIGO_ERRO_LI.validadePassada, issues: ['expiraEm'] }),
    );

    const err = (await c
      .renovarValidade('conta-1', { expiraEm: '2020-01-01', versaoEsperada: 1 })
      .catch((e: unknown) => e)) as InstanceType<typeof LojaIntegradaClientHttpError>;

    expect(err.code).toBe('LI_VALIDADE_PASSADA');
    expect(err.campos).toEqual(['expiraEm']);
  });

  it('a 499 with an EMPTY body is an HTTP error with no code, not a crash', async () => {
    const { c } = cliente(() => new Response(null, { status: 499 }));

    const err = (await c
      .salvarCredencial('conta-1', { token: TOKEN, expiraEm: '2026-12-31', versaoEsperada: null })
      .catch((e: unknown) => e)) as InstanceType<typeof LojaIntegradaClientHttpError>;

    expect(err).toBeInstanceOf(LojaIntegradaClientHttpError);
    expect(err.status).toBe(499);
    expect(err.code).toBeNull();
  });

  it('an HTML 502 never becomes the message; the body goes to the console on a GET', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const html = '<!DOCTYPE html><html><body>Bad gateway</body></html>';
    const { c } = cliente(
      () => new Response(html, { status: 502, headers: { 'content-type': 'text/html' } }),
    );

    const err = (await c.conta('conta-1').catch((e: unknown) => e)) as InstanceType<
      typeof LojaIntegradaClientHttpError
    >;

    expect(err.code).toBeNull();
    expect(err.message).toContain('HTTP 502');
    expect(err.message).not.toContain('<html>');
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![1])).toContain('Bad gateway');
  });

  it('a JSON body that is not our envelope (no code) falls back to the status sentence', async () => {
    const { c } = cliente(() => json(500, ['não', 'é', 'envelope']));

    const err = (await c.conta('conta-1').catch((e: unknown) => e)) as InstanceType<
      typeof LojaIntegradaClientHttpError
    >;

    expect(err.code).toBeNull();
    expect(err.message).toContain('HTTP 500');
  });
});

describe('transport failures', () => {
  it('a rejected fetch is a NetworkError with a FIXED message, the cause kept', async () => {
    const causa = new TypeError('Failed to fetch');
    const { c } = cliente(() => Promise.reject(causa));

    const err = (await c.conta('conta-1').catch((e: unknown) => e)) as InstanceType<
      typeof LojaIntegradaClientNetworkError
    >;

    expect(err).toBeInstanceOf(LojaIntegradaClientNetworkError);
    expect(err.message).toBe('Falha de rede ao contatar o backend da Loja Integrada.');
    expect(err.cause).toBe(causa);
  });

  it('a body that drops MID-READ is a NetworkError, never a bare TypeError', async () => {
    const quebrado = new Response('x', { status: 200 });
    vi.spyOn(quebrado, 'text').mockRejectedValue(new TypeError('terminated'));
    const { c } = cliente(() => quebrado);

    await expect(c.conta('conta-1')).rejects.toBeInstanceOf(LojaIntegradaClientNetworkError);
  });

  it('a body read failing with anything else propagates as itself', async () => {
    const quebrado = new Response('x', { status: 200 });
    const outro = new RangeError('outra coisa');
    vi.spyOn(quebrado, 'text').mockRejectedValue(outro);
    const { c } = cliente(() => quebrado);

    await expect(c.conta('conta-1')).rejects.toBe(outro);
  });

  it('an ID-token failure is NOT relabelled a network error', async () => {
    const falhaDeSessao = new Error('auth/network-request-failed');
    const c = createLojaIntegradaClient({
      baseUrl: BASE,
      getAuthToken: () => Promise.reject(falhaDeSessao),
      fetch: vi.fn(),
    });

    await expect(c.conta('conta-1')).rejects.toBe(falhaDeSessao);
  });
});

describe('⭐ token hygiene — the Personal Token reaches no URL, message or log line', () => {
  /** Every console channel, captured. */
  function capturarConsole(): () => string {
    const linhas: unknown[][] = [];
    for (const nivel of ['error', 'warn', 'log', 'info', 'debug'] as const) {
      vi.spyOn(console, nivel).mockImplementation((...args: unknown[]) => {
        linhas.push(args);
      });
    }
    return () => JSON.stringify(linhas.map((args) => args.map((a) => String(a))));
  }

  /** A proxy that ECHOES whatever it received — the adversarial case. */
  const ECOS: ReadonlyArray<{
    nome: string;
    responder: (c: Chamada) => Response | Promise<Response>;
  }> = [
    {
      nome: 'a non-JSON 502 echoing the request body',
      responder: (c) =>
        new Response(`<html>${String(c.init.body)}</html>`, {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    },
    {
      nome: 'a non-JSON 200 echoing the request body',
      responder: (c) => new Response(`eco: ${String(c.init.body)}`, { status: 200 }),
    },
    {
      nome: 'a JSON 200 of the wrong shape echoing the request body',
      responder: (c) => json(200, { eco: String(c.init.body), [TOKEN]: TOKEN }),
    },
    {
      nome: 'a JSON 4xx that is not our envelope, echoing the request body',
      responder: (c) => json(400, { mensagem: String(c.init.body) }),
    },
    { nome: 'an empty 200', responder: () => new Response('', { status: 200 }) },
    { nome: 'a 499 with no body', responder: () => new Response(null, { status: 499 }) },
    {
      nome: 'a fetch rejection',
      responder: () => Promise.reject(new TypeError('Failed to fetch')),
    },
  ];

  for (const caso of ECOS) {
    it(`${caso.nome}`, async () => {
      const lido = capturarConsole();
      const { c, chamadas } = cliente(caso.responder);

      const err = await c
        .salvarCredencial('conta-1', { token: TOKEN, expiraEm: '2026-12-31', versaoEsperada: null })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      // The token WAS sent — in the body, the one place it belongs …
      expect(chamadas[0]!.init.body).toContain(TOKEN);
      // … and nowhere else.
      expect(chamadas.map((ch) => ch.url).join(' ')).not.toContain(TOKEN);
      expect((err as Error).message).not.toContain(TOKEN);
      expect(String(err)).not.toContain(TOKEN);
      expect(JSON.stringify(err)).not.toContain(TOKEN);
      expect(lido()).not.toContain(TOKEN);
    });
  }

  it('the control — the same echo on a GET (no token) IS logged, so the omission above is real', async () => {
    // Without this, "nothing was logged at all" would pass the cases above too.
    const lido = capturarConsole();
    const { c } = cliente(
      () =>
        new Response('<html>pagina-do-proxy</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    );

    await c.conta('conta-1').catch((e: unknown) => e);

    expect(lido()).toContain('pagina-do-proxy');
  });
});

describe('resolverBackendLojaIntegrada — fail closed from an https page', () => {
  it('⭐ an https page and an http backend is REFUSED (inseguro)', () => {
    expect(resolverBackendLojaIntegrada('https:', 'http://li.backend.test')).toEqual({
      ok: false,
      motivo: 'inseguro',
    });
  });

  it('⭐ an https page with the variable UNSET is refused too — the localhost fallback is http', () => {
    expect(DEFAULT_LOJA_INTEGRADA_URL).toBe('http://localhost:3010');
    expect(resolverBackendLojaIntegrada('https:', undefined)).toEqual({
      ok: false,
      motivo: 'inseguro',
    });
    expect(resolverBackendLojaIntegrada('https:', '')).toEqual({ ok: false, motivo: 'inseguro' });
  });

  it('the near miss: an https page and an https backend is fine', () => {
    expect(resolverBackendLojaIntegrada('https:', 'https://li.backend.test')).toEqual({
      ok: true,
      baseUrl: 'https://li.backend.test',
    });
  });

  it('an http page may talk to an http backend (local dev, and the CI e2e build)', () => {
    expect(resolverBackendLojaIntegrada('http:', undefined)).toEqual({
      ok: true,
      baseUrl: 'http://localhost:3010',
    });
    expect(resolverBackendLojaIntegrada('http:', 'http://li.backend.test')).toEqual({
      ok: true,
      baseUrl: 'http://li.backend.test',
    });
  });

  it('a value that is not an http(s) URL is url-invalida, on either page', () => {
    expect(resolverBackendLojaIntegrada('http:', 'not a url')).toEqual({
      ok: false,
      motivo: 'url-invalida',
    });
    expect(resolverBackendLojaIntegrada('https:', 'ftp://li.backend.test')).toEqual({
      ok: false,
      motivo: 'url-invalida',
    });
  });
});

describe('useLojaIntegradaClient — the hook applies the rule to the real page', () => {
  const jsdom = (globalThis as unknown as { jsdom: { reconfigure(o: { url: string }): void } })
    .jsdom;
  const URL_ORIGINAL = window.location.href;

  beforeEach(() => {
    h.user = { getIdToken: async () => 'id-token-firebase' };
  });

  afterEach(() => {
    jsdom.reconfigure({ url: URL_ORIGINAL });
    vi.unstubAllEnvs();
    h.user = null;
  });

  it('⭐ returns null on an https: page with an http: base URL, and says why', () => {
    jsdom.reconfigure({ url: 'https://erp.test/canais/loja-integrada/c1' });
    vi.stubEnv('NEXT_PUBLIC_LOJA_INTEGRADA_URL', 'http://li.backend.test');

    expect(renderHook(() => useLojaIntegradaClient()).result.current).toBeNull();
    expect(renderHook(() => useBackendLojaIntegrada()).result.current.indisponivel).toBe(
      'inseguro',
    );
  });

  it('the near miss: returns a client on an http: page with the same base URL', () => {
    jsdom.reconfigure({ url: 'http://localhost:3000/canais/loja-integrada/c1' });
    vi.stubEnv('NEXT_PUBLIC_LOJA_INTEGRADA_URL', 'http://li.backend.test');

    const { result } = renderHook(() => useBackendLojaIntegrada());

    expect(result.current.client).not.toBeNull();
    expect(result.current.indisponivel).toBeNull();
  });

  it('returns null with NO reason while logged out — that is loading, not misconfiguration', () => {
    h.user = null;
    jsdom.reconfigure({ url: 'https://erp.test/' });
    vi.stubEnv('NEXT_PUBLIC_LOJA_INTEGRADA_URL', 'http://li.backend.test');

    expect(renderHook(() => useBackendLojaIntegrada()).result.current).toEqual({
      client: null,
      indisponivel: null,
    });
  });
});
