import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  type ChamadaAmazon,
  criarClienteSpApi,
  type CredencialSpApi,
  MARKETPLACE_ID_BR,
  MAX_REF_CREDENCIAL,
  MAX_USER_AGENT,
  type OpcoesClienteSpApi,
  type ResultadoChamadaAmazon,
  type SpApiLeituraClient,
  TOKEN_REMOVIDO,
  URL_BASE_SP_API,
} from '../src/client';
import {
  AmazonAuthError,
  AmazonConfigError,
  AmazonError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonThrottleError,
  AmazonTimeoutError,
} from '../src/errors';
import { PRAZO_AMAZON_MS } from '../src/prazos';
import {
  corpo422ComDadosPessoais,
  CPF_FALSO,
  EMAIL_FALSO,
  erro400CodigoComEspaco,
  erro400InvalidInput,
  erro400InvalidInputComDetails,
  erro400Vazio,
  erro403Forbidden,
  erro409Duplicado,
  erro429RateLimited,
  erro500InternalFailure,
  erro503ServiceUnavailable,
  paginaHtmlDeProxy,
  participacoes200,
} from './_fixtures/sandbox';
import {
  ACCESS_TOKEN,
  ACCESS_TOKEN_2,
  falha,
  fetchQueNuncaResponde,
  fetchQueTravaNoCorpo,
  json,
  mensagensDaCadeia,
  mockFetch,
  observar,
  requisicao,
  texto,
  textosDoErro,
  USER_AGENT,
  verificarFormaDasRequisicoes,
} from './_helpers/mockFetch';
import { MENSAGEM_SEM_REDE } from './_setup/semRede';

afterEach(verificarFormaDasRequisicoes);

const CAMINHO = '/sellers/v1/marketplaceParticipations';

/** Test-local: the Sellers schema arrives with its first consumer step, not here. */
const schema = z
  .object({
    payload: z.array(
      z.object({ marketplace: z.object({ id: z.string() }).passthrough() }).passthrough(),
    ),
  })
  .passthrough();

function pedido(
  extra: { sinal?: AbortSignal; query?: Record<string, string | number | boolean> } = {},
) {
  return {
    operacao: 'getMarketplaceParticipations',
    caminho: CAMINHO,
    query: extra.query ?? { marketplaceIds: MARKETPLACE_ID_BR },
    schema,
    sinal: extra.sinal,
  };
}

/** A client with every ambient input injected: no network, no clock, no randomness. */
function cliente(
  fetch: typeof globalThis.fetch,
  extra: Partial<OpcoesClienteSpApi> = {},
): { c: SpApiLeituraClient; eventos: ChamadaAmazon[] } {
  let n = 0;
  const eventos: ChamadaAmazon[] = [];
  const c = criarClienteSpApi({
    obterCredencial: () => ({ accessToken: ACCESS_TOKEN, ref: 'ref-A' }),
    userAgent: USER_AGENT,
    fetch,
    gerarCorrelationId: () => {
      n += 1;
      return `corr-${String(n)}`;
    },
    agora: () => 1_000,
    onChamada: (e) => eventos.push(e),
    ...extra,
  });
  return { c, eventos };
}

/** `!` through `~`: every visible ASCII character, once. */
const ASCII_VISIVEL = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) =>
  String.fromCharCode(0x21 + i),
).join('');

const ok = (headers: Record<string, string> = {}) =>
  mockFetch(() => json(participacoes200, 200, headers));

describe('headers', () => {
  it('sends exactly x-amz-access-token, user-agent and accept — no Authorization, no SigV4', async () => {
    const f = ok();
    await cliente(f).c.get(pedido());
    const { headers } = requisicao(f);
    expect([...headers.keys()].sort()).toEqual(['accept', 'user-agent', 'x-amz-access-token']);
    expect(headers.get('x-amz-access-token')).toBe(ACCESS_TOKEN);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('content-type')).toBe(false);
    expect(headers.has('x-amz-date')).toBe(false);
  });

  it("sends the caller's user-agent verbatim", async () => {
    const f = ok();
    const ua = 'App/1.0 (Language=TypeScript; Platform=Node)';
    await cliente(f, { userAgent: ua }).c.get(pedido());
    expect(requisicao(f).headers.get('user-agent')).toBe(ua);
  });

  it('never puts the token in the URL', async () => {
    const f = ok();
    await cliente(f).c.get(pedido());
    const { url } = requisicao(f);
    expect(url.href).not.toContain(ACCESS_TOKEN);
    expect(url.href).toBe(`${URL_BASE_SP_API}${CAMINHO}?marketplaceIds=${MARKETPLACE_ID_BR}`);
  });

  it('returns a fresh correlation id per call — and never sends it', async () => {
    const f = ok();
    const { c } = cliente(f);
    const r1 = await c.get(pedido());
    const r2 = await c.get(pedido());
    expect(r1.correlationId).toBe('corr-1');
    expect(r2.correlationId).toBe('corr-2');
    for (const i of [0, 1]) {
      const { headers } = requisicao(f, i);
      for (const [, valor] of headers) expect(valor).not.toMatch(/corr-/);
    }
  });

  it('puts the correlation id on every error', async () => {
    const err = await falha(cliente(mockFetch(() => texto('', 500))).c.get(pedido()));
    expect((err as AmazonHttpError).correlationId).toBe('corr-1');

    const rede = await falha(
      cliente(
        mockFetch(() => {
          throw new TypeError('fetch failed');
        }),
      ).c.get(pedido()),
    );
    expect((rede as AmazonNetworkError).correlationId).toBe('corr-1');

    const schemaErr = await falha(cliente(mockFetch(() => texto('', 200))).c.get(pedido()));
    expect((schemaErr as AmazonSchemaError).correlationId).toBe('corr-1');
  });
});

describe('the user-agent — mandatory, the caller’s', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['a leading space', ` ${USER_AGENT}`],
    ['a trailing space', `${USER_AGENT} `],
    ['a line break', `${USER_AGENT}\n`],
    ['a tab', `App/1.0\t(Language=TypeScript)`],
    ['a NUL', `${USER_AGENT}\u0000`],
    ['a DEL', `${USER_AGENT}\u007f`],
    ['é', `Aplicação/1.0 (Language=TypeScript)`],
    ['501 characters', 'A'.repeat(MAX_USER_AGENT + 1)],
  ])('%s → AmazonConfigError("user-agent") at construction', (_caso, userAgent) => {
    const f = ok();
    let err: unknown;
    try {
      criarClienteSpApi({
        obterCredencial: () => ({ accessToken: ACCESS_TOKEN, ref: 'ref-A' }),
        // The "missing" row is the JS caller that skipped a required option.
        userAgent: userAgent as string,
        fetch: f,
      });
    } catch (e) {
      if (!(e instanceof AmazonConfigError)) throw e;
      err = e;
    }
    expect(err).toBeInstanceOf(AmazonConfigError);
    expect((err as AmazonConfigError).motivo).toBe('user-agent');
    expect((err as AmazonConfigError).refCredencial).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('a user-agent containing the token → AmazonConfigError("user-agent"), nothing sent', async () => {
    const f = ok();
    const { c, eventos } = cliente(f, { userAgent: `App/1.0 (${ACCESS_TOKEN})` });
    const err = await falha(c.get(pedido()));
    expect(err).toBeInstanceOf(AmazonConfigError);
    expect((err as AmazonConfigError).motivo).toBe('user-agent');
    for (const t of textosDoErro(err)) expect(t).not.toContain(ACCESS_TOKEN);
    expect(f).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
  });

  it.each([
    ['500 characters', 'A'.repeat(MAX_USER_AGENT)],
    [
      "the docs' recommended form",
      'MySellingTool/2.0 (Language=Java/1.8.0.221; Platform=Windows/10)',
    ],
    ['every printable ASCII character, inner spaces included', `A ${ASCII_VISIVEL} Z`],
  ])('near-miss: %s is accepted and sent verbatim', async (_caso, userAgent) => {
    const f = ok();
    await cliente(f, { userAgent }).c.get(pedido());
    expect(requisicao(f).headers.get('user-agent')).toBe(userAgent);
  });
});

describe('the credential getter', () => {
  it('is called on EVERY request — what it returns now is what the next request sends', async () => {
    const f = ok();
    const credenciais: CredencialSpApi[] = [
      { accessToken: ACCESS_TOKEN, ref: 'ref-A' },
      { accessToken: ACCESS_TOKEN_2, ref: 'ref-B' },
    ];
    let i = 0;
    const obterCredencial = vi.fn(() => {
      const cred = credenciais[i];
      i += 1;
      if (cred === undefined) throw new RangeError('chamado demais');
      return cred;
    });
    const { c } = cliente(f, { obterCredencial });
    await c.get(pedido());
    await c.get(pedido());
    expect(obterCredencial).toHaveBeenCalledTimes(2);
    expect(requisicao(f, 0).headers.get('x-amz-access-token')).toBe(ACCESS_TOKEN);
    expect(requisicao(f, 1).headers.get('x-amz-access-token')).toBe(ACCESS_TOKEN_2);
  });

  it('accepts an async getter', async () => {
    const f = ok();
    const { c } = cliente(f, {
      obterCredencial: async () => ({ accessToken: ACCESS_TOKEN_2, ref: 'ref-B' }),
    });
    const r = await c.get(pedido());
    expect(r.refCredencial).toBe('ref-B');
  });

  it('near-miss: the 403 reports the ref of ITS request, never an earlier one', async () => {
    let n = 0;
    const f = mockFetch(() => {
      n += 1;
      return n === 1 ? json(participacoes200) : json(erro403Forbidden, 403);
    });
    const refs = ['ref-A', 'ref-B'];
    let i = 0;
    const { c, eventos } = cliente(f, {
      obterCredencial: () => {
        const ref = refs[i] ?? 'ref-?';
        i += 1;
        return { accessToken: i === 1 ? ACCESS_TOKEN : ACCESS_TOKEN_2, ref };
      },
    });
    const r = await c.get(pedido());
    expect(r.refCredencial).toBe('ref-A');
    const err = await falha(c.get(pedido()));
    expect(err).toBeInstanceOf(AmazonAuthError);
    expect((err as AmazonAuthError).refCredencial).toBe('ref-B');
    expect(eventos.map((e) => e.refCredencial)).toEqual(['ref-A', 'ref-B']);
  });

  it('a getter that throws propagates as itself; nothing is sent or observed', async () => {
    const f = ok();
    const propria = new RangeError('cofre indisponível');
    const { c, eventos } = cliente(f, {
      obterCredencial: () => {
        throw propria;
      },
    });
    await expect(c.get(pedido())).rejects.toBe(propria);
    expect(f).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
  });
});

describe('config errors — nothing is sent', () => {
  // Each one an accident a paste can produce, or a byte Node's `Headers` would
  // reject with a TypeError QUOTING the header value.
  it.each([
    ['empty', ''],
    ['an inner space', 'tok en-sintetico'],
    ['a tab', `${ACCESS_TOKEN}\t`],
    ['a trailing \\n', `${ACCESS_TOKEN}\n`],
    ['a trailing \\r', `${ACCESS_TOKEN}\r`],
    ['a NUL', `${ACCESS_TOKEN}\u0000`],
    ['a DEL', `${ACCESS_TOKEN}\u007f`],
    ['é', `${ACCESS_TOKEN}é`],
    ['a leading space', ` ${ACCESS_TOKEN}`],
  ])('a token with %s → AmazonConfigError("token")', async (_caso, accessToken) => {
    const f = ok();
    const { c, eventos } = cliente(f, { obterCredencial: () => ({ accessToken, ref: 'ref-A' }) });
    const err = await falha(c.get(pedido()));
    expect(err).toBeInstanceOf(AmazonConfigError);
    expect((err as AmazonConfigError).motivo).toBe('token');
    // A refused token never carries its ref, even an innocent one.
    expect((err as AmazonConfigError).refCredencial).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
    for (const t of textosDoErro(err)) expect(t).not.toContain(ACCESS_TOKEN.slice(0, 20));
  });

  it('near-miss: every visible-ASCII character is accepted and sent verbatim', async () => {
    const f = ok();
    await cliente(f, {
      obterCredencial: () => ({ accessToken: ASCII_VISIVEL, ref: 'ref-A' }),
    }).c.get(pedido());
    expect(requisicao(f).headers.get('x-amz-access-token')).toBe(ASCII_VISIVEL);
  });

  it('the strict check runs BEFORE headers are built: real `Headers` never sees a NUL', async () => {
    const f = mockFetch((_input, init) => {
      const enviados = new Headers(init?.headers);
      return json({ ...participacoes200, eco: enviados.has('x-amz-access-token') });
    });
    const err = await falha(
      cliente(f, {
        obterCredencial: () => ({ accessToken: `${ACCESS_TOKEN}\u0000`, ref: 'r' }),
      }).c.get(pedido()),
    );
    expect(err).toBeInstanceOf(AmazonConfigError);
    expect(f).not.toHaveBeenCalled();
    for (const m of mensagensDaCadeia(err)) expect(m).not.toContain(ACCESS_TOKEN);
  });

  it.each([
    ['empty', ''],
    ['longer than 64 characters', 'r'.repeat(MAX_REF_CREDENCIAL + 1)],
    ['containing the token', `fp:${ACCESS_TOKEN}`],
  ])('a ref %s → AmazonConfigError("ref"), never echoed', async (_caso, ref) => {
    const f = ok();
    const { c, eventos } = cliente(f, {
      obterCredencial: () => ({ accessToken: ACCESS_TOKEN, ref }),
    });
    const err = await falha(c.get(pedido()));
    expect(err).toBeInstanceOf(AmazonConfigError);
    expect((err as AmazonConfigError).motivo).toBe('ref');
    expect((err as AmazonConfigError).refCredencial).toBeNull();
    for (const t of textosDoErro(err)) expect(t).not.toContain(ACCESS_TOKEN);
    expect(f).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
  });

  it.each([
    ['a trailing \\n', `${ACCESS_TOKEN}\n`],
    ['a leading space', ` ${ACCESS_TOKEN}`],
  ])('a bad token (%s) never echoes a ref holding the CLEAN token', async (_caso, accessToken) => {
    const f = ok();
    const err = await falha(
      cliente(f, { obterCredencial: () => ({ accessToken, ref: ACCESS_TOKEN }) }).c.get(pedido()),
    );
    expect((err as AmazonConfigError).motivo).toBe('token');
    expect((err as AmazonConfigError).refCredencial).toBeNull();
    for (const t of textosDoErro(err)) expect(t).not.toContain(ACCESS_TOKEN.slice(0, 20));
  });

  it('near-miss: a 64-character ref is accepted', async () => {
    const f = ok();
    const ref = 'r'.repeat(MAX_REF_CREDENCIAL);
    const r = await cliente(f, {
      obterCredencial: () => ({ accessToken: ACCESS_TOKEN, ref }),
    }).c.get(pedido());
    expect(r.refCredencial).toBe(ref);
  });

  it.each([
    'sellers/v1/marketplaceParticipations',
    '/Sellers/v1/marketplaceParticipations',
    '/1sellers/v1/x',
    '/sellers',
    '/sellers/v1/marketplaceParticipations?marketplaceIds=1',
    '/sellers/v1/marketplaceParticipations#x',
    '/sellers/https://evil.example/',
    '/sellers/../tokens/2021-03-01/restrictedDataToken',
    // What the WHATWG parser `fetch` uses would rewrite into a parent segment.
    '/sellers/%2e%2e/admin',
    '/sellers/%2E%2E/admin',
    '/sellers/.%2E/admin',
    '/sellers/.\t./admin',
    '/sellers/.\n./admin',
    // Encoded separators a server could still decode, and anything else the
    // parser would rewrite.
    '/sellers/%2e%2e%5cadmin',
    // An encoded backslash ALONE: the WHATWG parser leaves `%5c` untouched, so
    // only the literal check stands between it and a server that decodes it.
    '/sellers/v1%5cadmin',
    '/sellers/v1%5Cadmin',
    '/sellers/v1%2Fadmin',
    '/sellers/./v1/x',
    '/sellers/v1/x\n',
    '/sellers/v1/x y',
    '',
  ])('a bad path %j → AmazonConfigError("caminho"), before the getter', async (caminho) => {
    const f = ok();
    const obterCredencial = vi.fn(() => ({ accessToken: ACCESS_TOKEN, ref: 'ref-A' }));
    const { c, eventos } = cliente(f, { obterCredencial });
    const err = await falha(c.get({ ...pedido(), caminho }));
    expect(err).toBeInstanceOf(AmazonConfigError);
    expect((err as AmazonConfigError).motivo).toBe('caminho');
    expect((err as AmazonConfigError).refCredencial).toBeNull();
    expect(obterCredencial).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
    // The message never echoes a path that may carry a query.
    if (caminho.includes('?')) expect((err as Error).message).not.toContain('marketplaceIds=1');
  });

  it.each([
    '/sellers/v1/marketplaceParticipations',
    '/orders/2026-01-01/orders/171-9876543-2109876',
    '/externalFulfillment/2024-09-11/returns',
    '/listings/2021-08-01/items/SELLER-TESTE/SKU-TESTE-1',
  ])('near-miss: a plain path %j reaches the server exactly as written', async (caminho) => {
    const f = ok();
    await cliente(f).c.get({ ...pedido(), caminho });
    expect(f).toHaveBeenCalledTimes(1);
    expect(requisicao(f).url.pathname).toBe(caminho);
  });
});

describe('the token never rides the URL', () => {
  it.each<[string, string, Record<string, string | number>]>([
    ['the path', `/sellers/v1/${ACCESS_TOKEN}`, {}],
    ['a query value', CAMINHO, { marketplaceIds: MARKETPLACE_ID_BR, chave: ACCESS_TOKEN }],
    ['a query key', CAMINHO, { [ACCESS_TOKEN]: 1 }],
    ['a query value, wrapped', CAMINHO, { busca: `x${ACCESS_TOKEN}y` }],
  ])(
    'a token in %s → AmazonConfigError("token-na-url"), nothing sent',
    async (_caso, caminho, query) => {
      const f = ok();
      const { c, eventos } = cliente(f);
      const err = await falha(c.get({ ...pedido({ query }), caminho }));
      expect(err).toBeInstanceOf(AmazonConfigError);
      expect((err as AmazonConfigError).motivo).toBe('token-na-url');
      // Refused AFTER the credential was validated, so its ref is safe to echo.
      expect((err as AmazonConfigError).refCredencial).toBe('ref-A');
      expect(f).not.toHaveBeenCalled();
      expect(eventos).toEqual([]);
      for (const t of textosDoErro(err)) expect(t).not.toContain(ACCESS_TOKEN);
    },
  );

  it('a token the query encoding would disguise is still caught as given', async () => {
    // `|` is percent-encoded in the query string, so the raw token never
    // appears in the final URL — only the per-entry check sees it.
    const f = ok();
    const { c } = cliente(f);
    const err = await falha(c.get(pedido({ query: { chave: ACCESS_TOKEN } })));
    expect((err as AmazonConfigError).motivo).toBe('token-na-url');
    expect(f).not.toHaveBeenCalled();
  });

  it('near-miss: a fragment of the token in the query is sent', async () => {
    const f = ok();
    const trecho = ACCESS_TOKEN.slice(4, 20);
    await cliente(f).c.get(pedido({ query: { busca: trecho } }));
    expect(f).toHaveBeenCalledTimes(1);
    expect(requisicao(f).url.searchParams.get('busca')).toBe(trecho);
  });
});

describe('request shape', () => {
  it('is a GET with `redirect: "manual"`, no body, and the deadline signal', async () => {
    const f = ok();
    await cliente(f).c.get(pedido());
    const { init, url } = requisicao(f);
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(url.origin).toBe(URL_BASE_SP_API);
  });

  it('encodes the query, and omits the `?` when there is none', async () => {
    const f = ok();
    const { c } = cliente(f);
    await c.get(
      pedido({
        query: {
          marketplaceIds: MARKETPLACE_ID_BR,
          createdAfter: '2026-10-07T10:00:00Z',
          maxResultsPerPage: 50,
          includeDetails: true,
        },
      }),
    );
    await c.get({ ...pedido(), query: {} });
    const p = requisicao(f, 0).url.searchParams;
    expect(p.get('marketplaceIds')).toBe(MARKETPLACE_ID_BR);
    expect(p.get('createdAfter')).toBe('2026-10-07T10:00:00Z');
    expect(p.get('maxResultsPerPage')).toBe('50');
    expect(p.get('includeDetails')).toBe('true');
    expect(requisicao(f, 1).url.href).toBe(`${URL_BASE_SP_API}${CAMINHO}`);
  });
});

describe('redirects are never followed', () => {
  it.each([301, 302, 307, 308])(
    '%i with a foreign Location → non-transient AmazonHttpError, fetch called once',
    async (status) => {
      const f = mockFetch(() =>
        texto('', status, { location: 'https://outro-host.example/sellers/v1/x' }),
      );
      const { c, eventos } = cliente(f);
      const err = await falha(c.get(pedido()));
      expect(err).toBeInstanceOf(AmazonHttpError);
      expect(err).not.toBeInstanceOf(AmazonAuthError);
      expect((err as AmazonHttpError).status).toBe(status);
      expect((err as AmazonHttpError).transitorio).toBe(false);
      expect(f).toHaveBeenCalledTimes(1);
      expect(eventos.map((e) => e.resultado)).toEqual(['http']);
    },
  );
});

describe('the status table', () => {
  it.each<[number, unknown, (new (...a: never[]) => AmazonError) | null, boolean | null, string[]]>(
    [
      [200, participacoes200, null, null, []],
      [301, '', AmazonHttpError, false, []],
      [400, erro400InvalidInput, AmazonHttpError, false, ['InvalidInput']],
      [400, erro400Vazio, AmazonHttpError, false, []],
      [401, '', AmazonAuthError, false, []],
      [403, erro403Forbidden, AmazonAuthError, false, ['Forbidden']],
      [404, '', AmazonNotFoundError, false, []],
      [409, erro409Duplicado, AmazonHttpError, false, ['DuplicateRequest']],
      [413, '', AmazonHttpError, false, []],
      [415, '', AmazonHttpError, false, []],
      [429, erro429RateLimited, AmazonThrottleError, true, ['RateLimited']],
      [500, erro500InternalFailure, AmazonHttpError, true, ['InternalFailure']],
      [503, erro503ServiceUnavailable, AmazonHttpError, true, ['ServiceUnavailable']],
    ],
  )('HTTP %i', async (status, corpo, classe, transitorio, codigos) => {
    const f = mockFetch(() =>
      typeof corpo === 'string' ? texto(corpo, status) : json(corpo, status),
    );
    const { c, eventos } = cliente(f);
    const p = c.get(pedido());
    if (classe === null) {
      const r = await p;
      expect(r.status).toBe(200);
      expect(r.dados.payload).toHaveLength(1);
      return;
    }
    const err = await falha(p);
    expect(err).toBeInstanceOf(classe);
    expect((err as AmazonHttpError).status).toBe(status);
    expect((err as AmazonHttpError).transitorio).toBe(transitorio);
    expect((err as AmazonHttpError).destino).toBe('sp-api');
    expect(eventos[0]?.codigosErro).toEqual(codigos);
  });

  it('exact classes: 400, 409, 413 and 415 are plain AmazonHttpError, never auth or throttle', async () => {
    for (const status of [400, 409, 413, 415]) {
      const err = await falha(
        cliente(mockFetch(() => json(erro400InvalidInput, status))).c.get(pedido()),
      );
      expect(err).not.toBeInstanceOf(AmazonAuthError);
      expect(err).not.toBeInstanceOf(AmazonNotFoundError);
      expect(err).not.toBeInstanceOf(AmazonThrottleError);
    }
  });

  it('a 401/403 is an AmazonAuthError with no LWA code', async () => {
    for (const status of [401, 403]) {
      const err = await falha(
        cliente(mockFetch(() => json(erro403Forbidden, status))).c.get(pedido()),
      );
      expect(err).toMatchObject({ destino: 'sp-api', codigoLwa: null, refCredencial: 'ref-A' });
    }
  });

  it('a 429 WITH x-amzn-RateLimit-Limit carries it', async () => {
    const f = mockFetch(() =>
      json(erro429RateLimited, 429, { 'x-amzn-RateLimit-Limit': '0.0167' }),
    );
    const { c, eventos } = cliente(f);
    const err = await falha(c.get(pedido()));
    expect(err).toBeInstanceOf(AmazonThrottleError);
    expect(err).toMatchObject({ limiteTaxa: 0.0167, transitorio: true });
    expect(eventos[0]?.limiteTaxa).toBe(0.0167);
  });

  it('a 429 WITHOUT the header (the normal case) → limiteTaxa null', async () => {
    const err = await falha(
      cliente(mockFetch(() => json(erro429RateLimited, 429))).c.get(pedido()),
    );
    expect(err).toBeInstanceOf(AmazonThrottleError);
    expect((err as AmazonThrottleError).limiteTaxa).toBeNull();
  });

  it.each(['1,5', 'abc', '0', '-2', '1e3', ''])(
    'near-miss: a 429 whose header is %j → limiteTaxa null',
    async (valor) => {
      const err = await falha(
        cliente(
          mockFetch(() => json(erro429RateLimited, 429, { 'x-amzn-RateLimit-Limit': valor })),
        ).c.get(pedido()),
      );
      expect((err as AmazonThrottleError).limiteTaxa).toBeNull();
    },
  );

  it('the rate limit is read from a 200 too — the case where Amazon actually sends it', async () => {
    const { c, eventos } = cliente(ok({ 'x-amzn-RateLimit-Limit': '2.0' }));
    const r = await c.get(pedido());
    expect(r.limiteTaxa).toBe(2);
    expect(eventos[0]?.limiteTaxa).toBe(2);
  });

  it('a 400 whose body is free text is still a plain AmazonHttpError with no codes', async () => {
    const { c, eventos } = cliente(mockFetch(() => texto(paginaHtmlDeProxy, 400)));
    const err = await falha(c.get(pedido()));
    expect(err).toBeInstanceOf(AmazonHttpError);
    expect(eventos[0]?.codigosErro).toEqual([]);
  });
});

describe('2xx bodies', () => {
  it('a body that fails the schema → AmazonSchemaError("formato"), naming paths, not values', async () => {
    const marcador = 'MARCADOR-INJETADO-NO-CORPO';
    const corpo = { payload: [{ marketplace: { id: 7 }, eco: marcador }] };
    const err = await falha(cliente(mockFetch(() => json(corpo))).c.get(pedido()));
    expect(err).toBeInstanceOf(AmazonSchemaError);
    const e = err as AmazonSchemaError;
    expect(e.motivo).toBe('formato');
    expect(e.campos).toEqual(['payload[].marketplace.id']);
    expect(e.message).toContain('payload[].marketplace.id');
    for (const t of textosDoErro(e)) expect(t).not.toContain(marcador);
  });

  it("a proxy's HTML page → AmazonSchemaError('nao-json'), the page dropped", async () => {
    const err = await falha(
      cliente(mockFetch(() => texto(paginaHtmlDeProxy, 200))).c.get(pedido()),
    );
    expect(err).toBeInstanceOf(AmazonSchemaError);
    expect((err as AmazonSchemaError).motivo).toBe('nao-json');
    for (const t of textosDoErro(err)) {
      expect(t).not.toContain('MARCADOR-HTML');
      expect(t).not.toContain('<html>');
    }
  });

  it('an empty body → AmazonSchemaError("vazio")', async () => {
    const err = await falha(cliente(mockFetch(() => texto('', 200))).c.get(pedido()));
    expect(err).toBeInstanceOf(AmazonSchemaError);
    expect((err as AmazonSchemaError).motivo).toBe('vazio');
  });

  it('an AmazonSchemaError is NOT an AmazonHttpError', async () => {
    const err = await falha(cliente(mockFetch(() => texto('', 200))).c.get(pedido()));
    expect(err).not.toBeInstanceOf(AmazonHttpError);
  });

  it('returns the parsed data, the status, the request id and the ref', async () => {
    const f = ok({ 'x-amzn-RequestId': 'b3a8f2c1-1111-2222-3333-444455556666' });
    const r = await cliente(f).c.get(pedido());
    expect(r).toMatchObject({
      status: 200,
      correlationId: 'corr-1',
      requestIdAmazon: 'b3a8f2c1-1111-2222-3333-444455556666',
      limiteTaxa: null,
      refCredencial: 'ref-A',
    });
    expect(r.dados.payload[0]?.marketplace.id).toBe('ATVPDKIKX0DER');
  });
});

describe('x-amzn-RequestId', () => {
  it('rides every HTTP error', async () => {
    const err = await falha(
      cliente(
        mockFetch(() => json(erro400InvalidInput, 400, { 'x-amzn-RequestId': 'req-1' })),
      ).c.get(pedido()),
    );
    expect((err as AmazonHttpError).requestIdAmazon).toBe('req-1');
  });

  it.each([
    ['a space', 'req 1'],
    ['longer than 128', 'r'.repeat(129)],
    ['the token', 'tokTESTEsinteticonaoreal99'],
  ])('near-miss: a request id with %s is dropped (null)', async (_caso, valor) => {
    const token = 'tokTESTEsinteticonaoreal99';
    const f = mockFetch(() => json(erro400InvalidInput, 400, { 'x-amzn-RequestId': valor }));
    const err = await falha(
      cliente(f, { obterCredencial: () => ({ accessToken: token, ref: 'ref-A' }) }).c.get(pedido()),
    );
    expect((err as AmazonHttpError).requestIdAmazon).toBeNull();
    expect(JSON.stringify(err)).not.toContain(token);
  });
});

describe('transport failures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a TypeError from fetch → AmazonNetworkError, its text kept out of the message', async () => {
    const causa = new TypeError('MARCADOR-DA-CAUSA fetch failed');
    const f = mockFetch(() => {
      throw causa;
    });
    const { c, eventos } = cliente(f);
    const err = await falha(c.get(pedido()));
    expect(err).toBeInstanceOf(AmazonNetworkError);
    expect(err).not.toBeInstanceOf(AmazonTimeoutError);
    expect((err as AmazonNetworkError).cause).toBe(causa);
    expect((err as AmazonNetworkError).requestIdAmazon).toBeNull();
    expect((err as Error).message).not.toContain('MARCADOR-DA-CAUSA');
    expect(eventos[0]).toMatchObject({ resultado: 'rede', status: null, corpo: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a TypeError from text() (a connection dropped mid-body) → AmazonNetworkError', async () => {
    const f = mockFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new TypeError('terminated'));
            },
          }),
          {
            status: 200,
            headers: { 'x-amzn-RequestId': 'req-meio', 'x-amzn-RateLimit-Limit': '2.0' },
          },
        ),
    );
    const { c, eventos } = cliente(f);
    const err = await falha(c.get(pedido()));
    expect(err).toBeInstanceOf(AmazonNetworkError);
    expect(err).not.toBeInstanceOf(AmazonTimeoutError);
    // The headers DID arrive: the error keeps their id, the event their status
    // and their rate limit (read on every response, a failed one too).
    expect((err as AmazonNetworkError).requestIdAmazon).toBe('req-meio');
    expect(eventos[0]).toMatchObject({
      resultado: 'rede',
      status: 200,
      limiteTaxa: 2,
      corpo: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is still pending at budget−1 and times out at the budget with prazoMs', async () => {
    const { c, eventos } = cliente(fetchQueNuncaResponde());
    const { estado, pronto } = observar(c.get(pedido()));

    await vi.advanceTimersByTimeAsync(PRAZO_AMAZON_MS.leitura - 1);
    expect(estado.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pronto;
    expect(estado.valor).toBeInstanceOf(AmazonTimeoutError);
    expect(estado.valor).toBeInstanceOf(AmazonNetworkError);
    expect((estado.valor as AmazonTimeoutError).prazoMs).toBe(PRAZO_AMAZON_MS.leitura);
    expect(eventos.map((e) => e.resultado)).toEqual(['tempo-esgotado']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a stall AFTER the headers times out too — the body is read inside the window', async () => {
    const { c } = cliente(fetchQueTravaNoCorpo());
    const { estado, pronto } = observar(c.get(pedido()));
    await vi.advanceTimersByTimeAsync(PRAZO_AMAZON_MS.leitura);
    await pronto;
    expect(estado.settled).toBe(true);
    expect(estado.valor).toBeInstanceOf(AmazonTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a caller abort is rethrown as-is — never a timeout, never wrapped', async () => {
    const controller = new AbortController();
    const { c, eventos } = cliente(fetchQueNuncaResponde());
    const { estado, pronto } = observar(c.get(pedido({ sinal: controller.signal })));
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await pronto;
    expect(estado.valor).toBe(controller.signal.reason);
    expect(estado.valor).not.toBeInstanceOf(AmazonError);
    expect(eventos.map((e) => e.resultado)).toEqual(['cancelado']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a caller signal already aborted: nothing is sent, its reason comes back', async () => {
    const controller = new AbortController();
    controller.abort(new RangeError('motivo do chamador'));
    const f = ok();
    const { c, eventos } = cliente(f);
    await expect(c.get(pedido({ sinal: controller.signal }))).rejects.toBe(
      controller.signal.reason,
    );
    expect(f).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
  });

  it('a RangeError from fetch is rethrown as itself', async () => {
    const propria = new RangeError('init inválido');
    const { c, eventos } = cliente(
      mockFetch(() => {
        throw propria;
      }),
    );
    await expect(c.get(pedido())).rejects.toBe(propria);
    expect(eventos.map((e) => e.resultado)).toEqual(['inesperado']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer pending after a success or an HTTP failure', async () => {
    await cliente(ok()).c.get(pedido());
    expect(vi.getTimerCount()).toBe(0);
    await falha(cliente(mockFetch(() => texto('', 503))).c.get(pedido()));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('calls the credential getter OUTSIDE the deadline — a slow getter does not eat the budget', async () => {
    // Rejects on an already-aborted signal, as real `fetch` does: a window opened
    // BEFORE the getter would have fired by now, and this would fail.
    const f = mockFetch((_input, init) => {
      if (init?.signal?.aborted === true) throw init.signal.reason;
      return json(participacoes200);
    });
    const lento = () =>
      new Promise<CredencialSpApi>((resolve) => {
        setTimeout(
          () => resolve({ accessToken: ACCESS_TOKEN, ref: 'ref-A' }),
          PRAZO_AMAZON_MS.leitura + 5_000,
        );
      });
    const { estado, pronto } = observar(cliente(f, { obterCredencial: lento }).c.get(pedido()));
    await vi.advanceTimersByTimeAsync(PRAZO_AMAZON_MS.leitura + 5_000);
    await pronto;
    expect(estado.valor).not.toBeInstanceOf(AmazonError);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('no token and no body on errors', () => {
  const MARCADOR = 'MARCADOR-DO-CORPO-SP-API';
  const ecoaToken = (status: number) =>
    mockFetch(() =>
      texto(
        JSON.stringify({
          errors: [{ code: 'Unauthorized', message: `token ${ACCESS_TOKEN} ${MARCADOR}` }],
        }),
        status,
      ),
    );

  it.each([400, 401, 403, 404, 429, 500])(
    'HTTP %i echoing the token: nowhere on the error, scrubbed for the observer',
    async (status) => {
      const { c, eventos } = cliente(ecoaToken(status));
      const err = await falha(c.get(pedido()));
      expect(err).toBeInstanceOf(AmazonHttpError);
      for (const t of textosDoErro(err)) {
        expect(t).not.toContain(ACCESS_TOKEN);
        expect(t).not.toContain(MARCADOR);
        expect(t).not.toContain('Unauthorized');
      }
      expect(eventos).toHaveLength(1);
      expect(JSON.stringify(eventos[0])).not.toContain(ACCESS_TOKEN);
      expect(eventos[0]?.corpo).toContain(TOKEN_REMOVIDO);
      expect(eventos[0]?.corpo).toContain(MARCADOR);
    },
  );

  it('a 2xx echoing the token is scrubbed for the observer, and the data is the raw parse', async () => {
    const corpo = { ...participacoes200, eco: ACCESS_TOKEN };
    const { c, eventos } = cliente(mockFetch(() => json(corpo)));
    const r = await c.get(pedido());
    expect(JSON.stringify(eventos[0])).not.toContain(ACCESS_TOKEN);
    // The scrub feeds the observer only; it never rewrites what the caller reads.
    expect((r.dados as Record<string, unknown>).eco).toBe(ACCESS_TOKEN);
  });

  it('near-miss: the exact token is scrubbed, a substring or a lookalike is not', async () => {
    const parcial = ACCESS_TOKEN.slice(0, 20);
    const parecido = `${ACCESS_TOKEN.slice(0, -1)}9`;
    const corpo = `a=${ACCESS_TOKEN} b=${parcial} c=${parecido}`;
    const { c, eventos } = cliente(mockFetch(() => texto(corpo, 500)));
    await falha(c.get(pedido()));
    expect(eventos[0]?.corpo).toBe(`a=${TOKEN_REMOVIDO} b=${parcial} c=${parecido}`);
  });

  it('a 4xx carrying personal data: none of it reaches the error', async () => {
    const err = await falha(
      cliente(mockFetch(() => texto(corpo422ComDadosPessoais, 422))).c.get(pedido()),
    );
    expect(err).toBeInstanceOf(AmazonHttpError);
    for (const dado of [EMAIL_FALSO, CPF_FALSO]) {
      for (const t of textosDoErro(err)) expect(t).not.toContain(dado);
    }
  });

  it('a query value never reaches an error message', async () => {
    const marcador = 'VALOR-DE-FILTRO-SECRETO';
    const err = await falha(
      cliente(mockFetch(() => texto('', 500))).c.get(pedido({ query: { busca: marcador } })),
    );
    for (const t of textosDoErro(err)) expect(t).not.toContain(marcador);
  });

  it('a code carrying the token never reaches the observer codes', async () => {
    const corpo = { errors: [{ code: `X${ACCESS_TOKEN}`, message: 'm' }, { code: 'Ok' }] };
    const { c, eventos } = cliente(mockFetch(() => json(corpo, 400)));
    await falha(c.get(pedido()));
    expect(eventos[0]?.codigosErro).toEqual(['Ok']);
  });
});

describe('the observer', () => {
  it('is called once per request, with the documented fields', async () => {
    let t = 1_000;
    const f = ok({ 'x-amzn-RequestId': 'req-ok', 'x-amzn-RateLimit-Limit': '0.0167' });
    const { c, eventos } = cliente(f, {
      agora: () => {
        const v = t;
        t += 37;
        return v;
      },
    });
    await c.get(pedido());
    expect(eventos).toEqual([
      {
        destino: 'sp-api',
        operacao: 'getMarketplaceParticipations',
        metodo: 'GET',
        caminho: CAMINHO,
        query: [['marketplaceIds', MARKETPLACE_ID_BR]],
        correlationId: 'corr-1',
        requestIdAmazon: 'req-ok',
        refCredencial: 'ref-A',
        status: 200,
        latenciaMs: 37,
        resultado: 'ok',
        limiteTaxa: 0.0167,
        codigosErro: [],
        codigoLwa: null,
        corpo: JSON.stringify(participacoes200),
      } satisfies ChamadaAmazon,
    ]);
  });

  it('reads the errors[] codes: deduplicated, a code with a space kept, `{}` → [], at most 10', async () => {
    const casos: [unknown, string[]][] = [
      [erro400InvalidInputComDetails, ['InvalidInput']],
      [erro400CodigoComEspaco, ['Invalid Input']],
      [erro400Vazio, []],
      [{ errors: [{ code: 'A' }, { code: 'A' }, { code: 'B' }] }, ['A', 'B']],
      [{ errors: [{ code: 'x'.repeat(65) }, { code: 'Linha\nquebrada' }] }, []],
      // The cap: twelve distinct codes, the first ten kept, in order.
      [
        { errors: Array.from({ length: 12 }, (_, i) => ({ code: `C${String(i)}` })) },
        Array.from({ length: 10 }, (_, i) => `C${String(i)}`),
      ],
    ];
    for (const [corpo, codigos] of casos) {
      const { c, eventos } = cliente(mockFetch(() => json(corpo, 400)));
      await falha(c.get(pedido()));
      expect(eventos[0]?.codigosErro).toEqual(codigos);
    }
  });

  it.each<[number, ResultadoChamadaAmazon]>([
    [301, 'http'],
    [400, 'http'],
    [401, 'auth'],
    [403, 'auth'],
    [404, 'nao-encontrado'],
    [429, 'limite'],
    [503, 'http'],
  ])('HTTP %i → resultado %s, exactly once', async (status, resultado) => {
    const { c, eventos } = cliente(mockFetch(() => texto('', status)));
    await falha(c.get(pedido()));
    expect(eventos.map((e) => e.resultado)).toEqual([resultado]);
  });

  it('a schema failure → resultado "schema", once', async () => {
    const { c, eventos } = cliente(mockFetch(() => texto('<html/>', 200)));
    await falha(c.get(pedido()));
    expect(eventos.map((e) => e.resultado)).toEqual(['schema']);
  });

  it('never carries a request header or the user-agent', async () => {
    const { c, eventos } = cliente(ok());
    await c.get(pedido());
    const evento = eventos[0];
    expect(evento).toBeDefined();
    const chaves = Object.keys(evento ?? {});
    expect(chaves).not.toContain('headers');
    expect(JSON.stringify(evento)).not.toMatch(/x-amz-access-token|user-agent/i);
    expect(JSON.stringify(evento)).not.toContain(USER_AGENT);
  });

  it('a throwing observer propagates', async () => {
    const propria = new RangeError('logger quebrado');
    const { c } = cliente(ok(), {
      onChamada: () => {
        throw propria;
      },
    });
    await expect(c.get(pedido())).rejects.toBe(propria);
  });
});

describe('the default fetch', () => {
  it('is resolved at call time from globalThis', async () => {
    const f = ok();
    const c = criarClienteSpApi({
      obterCredencial: () => ({ accessToken: ACCESS_TOKEN, ref: 'r' }),
      userAgent: USER_AGENT,
    });
    vi.stubGlobal('fetch', f);
    try {
      await c.get({ ...pedido(), schema: z.unknown() });
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('D11: an un-injected fetch fails instead of reaching the network', async () => {
    const c = criarClienteSpApi({
      obterCredencial: () => ({ accessToken: ACCESS_TOKEN, ref: 'r' }),
      userAgent: USER_AGENT,
    });
    await expect(c.get({ ...pedido(), schema: z.unknown() })).rejects.toThrow(MENSAGEM_SEM_REDE);
  });
});
