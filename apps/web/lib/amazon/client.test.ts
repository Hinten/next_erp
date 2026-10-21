import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { CODIGO_ERRO_AMAZON, type StatusContaAmazon } from '@delfrance/schemas';

/**
 * The browser client for `apps/amazon`'s conta routes.
 *
 * Pinned here, each with its near miss:
 *
 *  1. the WIRE — method, path, percent-encoded id, the ID-token header, no body
 *     — against the routes PR b shipped;
 *  2. EVERY answer is read against the shared contract (`@delfrance/schemas`,
 *     `contaAmazon.ts`), the error envelope included — nothing is cast, so an
 *     HTML body is a typed error and never a truthy object;
 *  3. the fail-closed rule: an `https:` page never gets a client for an `http:`
 *     backend, keyed on the PAGE protocol, not on `NODE_ENV`.
 */

const h = vi.hoisted(() => ({
  user: null as null | { getIdToken: () => Promise<string> },
}));

vi.mock('@/lib/auth/useAuth', () => ({ useAuth: () => ({ user: h.user }) }));

const {
  DEFAULT_AMAZON_URL,
  criarClienteAmazon,
  resolverBackendAmazon,
  useAmazonClient,
  useBackendAmazon,
} = await import('./client');
const { AmazonBackendError, AmazonRedeError, AmazonRespostaInvalidaError } =
  await import('./erros');

const BASE = 'https://amazon.backend.test';

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
  const c = criarClienteAmazon(`${BASE}/`, async () => 'id-token-firebase', fetchImpl);
  return { c, chamadas };
}

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function html(status: number): Response {
  return new Response('<!doctype html><html><body>Proxy error</body></html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

const STATUS: StatusContaAmazon = {
  connected: true,
  credencialInvalida: false,
  autorizadoEm: '2026-03-10',
  reautorizarAte: '2027-03-10',
  diasParaReautorizar: 146,
  reconexaoPendente: null,
  chamadasLigadas: false,
};

const CONSENTIMENTO = 'https://consentimento.test/apps/authorize/consent?state=s';

/** Swallow the console line a non-JSON body logs, so the run stays quiet. */
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function falhaDe(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('esperava uma falha');
    },
    (err: unknown) => err,
  );
}

describe('the wire, route by route', () => {
  it('conta(id) is a GET on …/conta/{id}, with the ID token and no body', async () => {
    const { c, chamadas } = cliente(() => json(200, STATUS));

    await c.conta('conta-1');

    expect(chamadas).toHaveLength(1);
    const [ch] = chamadas;
    expect(ch?.url).toBe(`${BASE}/api/marketplace/amazon/conta/conta-1`);
    expect(ch?.init.method).toBe('GET');
    expect(ch?.init.body).toBeUndefined();
    expect(ch?.init.headers).toEqual({
      Authorization: 'Bearer id-token-firebase',
      Accept: 'application/json',
    });
  });

  it('oauthStart(id) is a POST on …/conta/{id}/oauth/start, with no body', async () => {
    const { c, chamadas } = cliente(() => json(200, { authorizeUrl: CONSENTIMENTO }));

    await expect(c.oauthStart('conta-1')).resolves.toEqual({ authorizeUrl: CONSENTIMENTO });

    const [ch] = chamadas;
    expect(ch?.url).toBe(`${BASE}/api/marketplace/amazon/conta/conta-1/oauth/start`);
    expect(ch?.init.method).toBe('POST');
    // Minting the state is a write on the backend; nothing travels in a body.
    expect(ch?.init.body).toBeUndefined();
    expect(ch?.init.headers).toEqual({
      Authorization: 'Bearer id-token-firebase',
      Accept: 'application/json',
    });
  });

  it('percent-encodes the id as ONE path segment', async () => {
    const { c, chamadas } = cliente(() => json(200, STATUS));

    await c.conta('a/b?c#d');

    expect(chamadas[0]?.url).toBe(`${BASE}/api/marketplace/amazon/conta/a%2Fb%3Fc%23d`);
  });

  it('reads the ID token per call, so a refreshed token propagates', async () => {
    const tokens = ['t1', 't2'];
    const fetchImpl = vi.fn(async () => json(200, STATUS));
    const c = criarClienteAmazon(BASE, async () => tokens.shift() ?? 'fim', fetchImpl);

    await c.conta('x');
    await c.conta('x');

    const auth = fetchImpl.mock.calls.map(
      (args: unknown[]) => (args[1] as { headers: Record<string, string> }).headers.Authorization,
    );
    expect(auth).toEqual(['Bearer t1', 'Bearer t2']);
  });
});

describe('every 2xx is read against the shared schema', () => {
  it('returns the status the schema parsed — unknown keys stripped, never refused', async () => {
    const { c } = cliente(() => json(200, { ...STATUS, campoDeUmPassoFuturo: 1 }));

    await expect(c.conta('conta-1')).resolves.toEqual(STATUS);
  });

  it('⭐ an HTML 200 is a typed error, NOT a truthy object whose `connected` is undefined', async () => {
    const { c } = cliente(() => html(200));

    const err = await falhaDe(c.conta('conta-1'));

    expect(err).toBeInstanceOf(AmazonRespostaInvalidaError);
    const e = err as InstanceType<typeof AmazonRespostaInvalidaError>;
    expect(e.status).toBe(200);
    expect(e.codigo).toBeNull();
    // The page stays on the console, never in the message.
    expect(e.message).not.toContain('Proxy error');
    expect(e.message).toContain('sem um corpo JSON');
  });

  it('an EMPTY 200 is the same "never reached the route" error, not version skew', async () => {
    const { c } = cliente(() => new Response('', { status: 200 }));

    const err = await falhaDe(c.conta('conta-1'));

    expect(err).toBeInstanceOf(AmazonRespostaInvalidaError);
    expect((err as Error).message).not.toContain('deploy');
  });

  it('a wrong shape names the field PATHS and says what to do', async () => {
    const { c } = cliente(() =>
      json(200, { ...STATUS, connected: 'sim', autorizadoEm: '10/03/2026' }),
    );

    const err = await falhaDe(c.conta('conta-1'));

    expect(err).toBeInstanceOf(AmazonRespostaInvalidaError);
    const e = err as InstanceType<typeof AmazonRespostaInvalidaError>;
    expect([...e.campos].sort()).toEqual(['autorizadoEm', 'connected']);
    expect(e.message).toContain('connected');
    // Paths only — the offending VALUE never reaches the message.
    expect(e.message).not.toContain('10/03/2026');
  });

  it('a start answer without a URL is refused', async () => {
    const { c } = cliente(() => json(200, { authorizeUrl: 'não é url' }));

    const err = await falhaDe(c.oauthStart('conta-1'));

    expect(err).toBeInstanceOf(AmazonRespostaInvalidaError);
    expect((err as InstanceType<typeof AmazonRespostaInvalidaError>).campos).toEqual([
      'authorizeUrl',
    ]);
  });

  it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>'])(
    '⭐ a schema-valid start URL with the scheme %j is never handed to the navigation',
    async (authorizeUrl) => {
      const { c } = cliente(() => json(200, { authorizeUrl }));

      const err = await falhaDe(c.oauthStart('conta-1'));

      expect(err).toBeInstanceOf(AmazonRespostaInvalidaError);
      expect((err as InstanceType<typeof AmazonRespostaInvalidaError>).campos).toEqual([
        'authorizeUrl',
      ]);
    },
  );

  it('the near miss: an http: start URL (a local stub) is accepted', async () => {
    const local = 'http://localhost:3000/__e2e__/consentimento-amazon';
    const { c } = cliente(() => json(200, { authorizeUrl: local }));

    await expect(c.oauthStart('conta-1')).resolves.toEqual({ authorizeUrl: local });
  });
});

describe('the error envelope', () => {
  it('a coded envelope becomes an AmazonBackendError carrying the code and status', async () => {
    const { c } = cliente(() =>
      json(503, {
        error: 'As chamadas à Amazon estão desligadas neste backend.',
        code: CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS,
      }),
    );

    const err = await falhaDe(c.oauthStart('conta-1'));

    expect(err).toBeInstanceOf(AmazonBackendError);
    expect(err).not.toBeInstanceOf(AmazonRespostaInvalidaError);
    const e = err as InstanceType<typeof AmazonBackendError>;
    expect(e.status).toBe(503);
    expect(e.codigo).toBe(CODIGO_ERRO_AMAZON.CHAMADAS_DESLIGADAS);
    expect(e.message).toBe('As chamadas à Amazon estão desligadas neste backend.');
  });

  it('keeps `issues` as field paths', async () => {
    const { c } = cliente(() =>
      json(500, {
        error: 'Configuração ausente.',
        code: CODIGO_ERRO_AMAZON.CONFIG_AUSENTE,
        issues: ['AMAZON_APPLICATION_ID'],
      }),
    );

    const err = (await falhaDe(c.oauthStart('conta-1'))) as InstanceType<typeof AmazonBackendError>;

    expect(err.campos).toEqual(['AMAZON_APPLICATION_ID']);
  });

  it("verifyCaller's CODED 401 (a Firebase Auth code) keeps its code", async () => {
    const { c } = cliente(() =>
      json(401, {
        error: 'Token inválido ou expirado (auth/id-token-expired).',
        code: 'auth/id-token-expired',
      }),
    );

    const err = (await falhaDe(c.conta('conta-1'))) as InstanceType<typeof AmazonBackendError>;

    expect(err.codigo).toBe('auth/id-token-expired');
    expect(err.status).toBe(401);
  });

  it("verifyCaller's CODELESS 403 is not the envelope: no code, copy from the status", async () => {
    const { c } = cliente(() => json(403, { error: 'Sem permissão para esta operação.' }));

    const err = (await falhaDe(c.conta('conta-1'))) as InstanceType<typeof AmazonBackendError>;

    expect(err).toBeInstanceOf(AmazonBackendError);
    expect(err.codigo).toBeNull();
    expect(err.status).toBe(403);
    expect(err.message).toContain('permissão');
  });

  it('a proxy HTML 502 is an AmazonBackendError with no code, the page kept off the message', async () => {
    const { c } = cliente(() => html(502));

    const err = (await falhaDe(c.conta('conta-1'))) as InstanceType<typeof AmazonBackendError>;

    expect(err).toBeInstanceOf(AmazonBackendError);
    expect(err).not.toBeInstanceOf(AmazonRespostaInvalidaError);
    expect(err.codigo).toBeNull();
    expect(err.status).toBe(502);
    expect(err.message).not.toContain('Proxy error');
    expect(err.message).toContain('HTTP 502');
  });

  it('a JSON array on a 4xx is not read as the envelope', async () => {
    const { c } = cliente(() => json(400, ['error', 'code']));

    const err = (await falhaDe(c.conta('conta-1'))) as InstanceType<typeof AmazonBackendError>;

    expect(err.codigo).toBeNull();
    expect(err.status).toBe(400);
  });
});

describe('transport failures', () => {
  it('a rejected fetch is an AmazonRedeError with a FIXED message, the cause kept', async () => {
    const causa = new TypeError('Failed to fetch');
    const { c } = cliente(() => Promise.reject(causa));

    const err = (await falhaDe(c.conta('conta-1'))) as InstanceType<typeof AmazonRedeError>;

    expect(err).toBeInstanceOf(AmazonRedeError);
    expect(err.message).toBe('Falha de rede ao contatar o backend da Amazon.');
    expect(err.cause).toBe(causa);
  });

  it('a body that drops MID-READ is an AmazonRedeError, never a bare TypeError', async () => {
    const quebrado = new Response('x', { status: 200 });
    vi.spyOn(quebrado, 'text').mockRejectedValue(new TypeError('terminated'));
    const { c } = cliente(() => quebrado);

    await expect(c.conta('conta-1')).rejects.toBeInstanceOf(AmazonRedeError);
  });

  it('a body read failing with anything else propagates as itself', async () => {
    const quebrado = new Response('x', { status: 200 });
    const outro = new RangeError('outra coisa');
    vi.spyOn(quebrado, 'text').mockRejectedValue(outro);
    const { c } = cliente(() => quebrado);

    await expect(c.conta('conta-1')).rejects.toBe(outro);
  });

  it('an ID-token failure is NOT relabelled a network error, and nothing is sent', async () => {
    const falhaDeSessao = new Error('auth/network-request-failed');
    const fetchImpl = vi.fn();
    const c = criarClienteAmazon(BASE, () => Promise.reject(falhaDeSessao), fetchImpl);

    await expect(c.oauthStart('conta-1')).rejects.toBe(falhaDeSessao);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('resolverBackendAmazon — fail closed from an https page', () => {
  it('⭐ refuses an http: backend from an https: page', () => {
    expect(resolverBackendAmazon('https:', 'http://amazon.backend.test')).toEqual({
      ok: false,
      motivo: 'inseguro',
    });
  });

  it('⭐ refuses the localhost FALLBACK from an https: page (a build missing the variable)', () => {
    expect(resolverBackendAmazon('https:', undefined)).toEqual({ ok: false, motivo: 'inseguro' });
    expect(resolverBackendAmazon('https:', '   ')).toEqual({ ok: false, motivo: 'inseguro' });
  });

  it('the near miss: an https: page with an https: backend is allowed', () => {
    expect(resolverBackendAmazon('https:', 'https://amazon.backend.test')).toEqual({
      ok: true,
      baseUrl: 'https://amazon.backend.test',
    });
  });

  it('an http: page may use the http: fallback (local dev, the CI e2e build)', () => {
    expect(resolverBackendAmazon('http:', undefined)).toEqual({
      ok: true,
      baseUrl: DEFAULT_AMAZON_URL,
    });
    expect(DEFAULT_AMAZON_URL).toBe('http://localhost:3011');
  });

  it.each(['não é url', 'ftp://amazon.backend.test', 'javascript:alert(1)'])(
    'refuses %j as url-invalida, from either page protocol',
    (valor) => {
      expect(resolverBackendAmazon('http:', valor)).toEqual({ ok: false, motivo: 'url-invalida' });
      expect(resolverBackendAmazon('https:', valor)).toEqual({
        ok: false,
        motivo: 'url-invalida',
      });
    },
  );
});

describe('useAmazonClient — the hook applies the rule to the real page', () => {
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
    jsdom.reconfigure({ url: 'https://erp.test/canais/amazon/c1' });
    vi.stubEnv('NEXT_PUBLIC_AMAZON_URL', 'http://amazon.backend.test');

    expect(renderHook(() => useAmazonClient()).result.current).toBeNull();
    expect(renderHook(() => useBackendAmazon()).result.current.indisponivel).toBe('inseguro');
  });

  it('the near miss: returns a client on an http: page with the same base URL', () => {
    jsdom.reconfigure({ url: 'http://localhost:3000/canais/amazon/c1' });
    vi.stubEnv('NEXT_PUBLIC_AMAZON_URL', 'http://amazon.backend.test');

    const { result } = renderHook(() => useBackendAmazon());

    expect(result.current.client).not.toBeNull();
    expect(result.current.indisponivel).toBeNull();
  });

  it('returns null with NO reason while logged out — still signing in, not misconfiguration', () => {
    h.user = null;
    jsdom.reconfigure({ url: 'https://erp.test/' });
    vi.stubEnv('NEXT_PUBLIC_AMAZON_URL', 'http://amazon.backend.test');

    expect(renderHook(() => useBackendAmazon()).result.current).toEqual({
      client: null,
      indisponivel: null,
    });
  });
});
