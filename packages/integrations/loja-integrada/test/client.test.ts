import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  type ChamadaLi,
  criarClienteLeituraLi,
  type CredencialLi,
  type LiLeituraClient,
  MAX_REF_CREDENCIAL,
  type OpcoesClienteLi,
  type ResultadoChamadaLi,
  TOKEN_REMOVIDO,
  URL_BASE_LI,
} from '../src/client';
import {
  LiAuthError,
  LiConfigError,
  LiError,
  LiHttpError,
  LiNetworkError,
  LiNotFoundError,
  LiSchemaError,
  LiThrottleError,
  LiTimeoutError,
} from '../src/errors';
import { PRAZO_LI_MS } from '../src/prazos';
import { liCategoriaSchema, liEnvelopeSchema } from '../src/types';
import {
  categoriaPagina1,
  corpo401Json,
  corpo403Html,
  corpo409Bruto,
  corpo422ComDadosPessoais,
  corpo429Loja,
  corpo500Html,
  CPF_FALSO,
  EMAIL_FALSO,
} from './_fixtures/especificacao';
import {
  fetchQueNuncaResponde,
  fetchQueTravaNoCorpo,
  json,
  mensagensDaCadeia,
  mockFetch,
  observar,
  requisicao,
  texto,
  TOKEN,
  TOKEN_2,
  verificarSoGet,
} from './_helpers/mockFetch';

afterEach(verificarSoGet);

const CAMINHO = '/v1/categoria/';
const schema = liEnvelopeSchema(liCategoriaSchema);

function pedido(extra: { sinal?: AbortSignal; query?: Record<string, string | number> } = {}) {
  return {
    operacao: 'listarCategorias',
    caminho: CAMINHO,
    query: extra.query ?? { limit: 20 },
    schema,
    sinal: extra.sinal,
  };
}

/** A client with every ambient input injected: no network, no clock, no randomness. */
function cliente(
  fetch: typeof globalThis.fetch,
  extra: Partial<OpcoesClienteLi> = {},
): { c: LiLeituraClient; eventos: ChamadaLi[] } {
  let n = 0;
  const eventos: ChamadaLi[] = [];
  const c = criarClienteLeituraLi({
    obterCredencial: () => ({ token: TOKEN, ref: 'ref-A' }),
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

const ok = () => mockFetch(() => json(categoriaPagina1));

async function falha(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('esperava uma rejeição');
    },
    (e: unknown) => e,
  );
}

describe('headers', () => {
  it('sends `Authorization: Basic <raw token>` — not base64, not Bearer', async () => {
    const f = ok();
    await cliente(f).c.get(pedido());
    const { headers } = requisicao(f);
    expect(headers.get('authorization')).toBe(`Basic ${TOKEN}`);
    expect(headers.get('authorization')).not.toContain(btoa(TOKEN));
    expect(headers.get('authorization')).not.toMatch(/^Bearer/i);
  });

  it('never puts the token in the URL', async () => {
    const f = ok();
    await cliente(f).c.get(pedido());
    const { url } = requisicao(f);
    expect(url.href).not.toContain(TOKEN);
    expect(url.href).toBe(`${URL_BASE_LI}${CAMINHO}?limit=20`);
  });

  it('sends exactly Authorization, Accept and x-correlation-id — no Content-Type', async () => {
    const f = ok();
    await cliente(f).c.get(pedido());
    const { headers } = requisicao(f);
    expect([...headers.keys()].sort()).toEqual(['accept', 'authorization', 'x-correlation-id']);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.has('content-type')).toBe(false);
  });

  it('sends a fresh x-correlation-id per call and returns it', async () => {
    const f = ok();
    const { c } = cliente(f);
    const r1 = await c.get(pedido());
    const r2 = await c.get(pedido());
    expect(requisicao(f, 0).headers.get('x-correlation-id')).toBe('corr-1');
    expect(requisicao(f, 1).headers.get('x-correlation-id')).toBe('corr-2');
    expect(r1.correlationId).toBe('corr-1');
    expect(r2.correlationId).toBe('corr-2');
  });

  it('defaults the header ON, and omits it with `enviarCorrelationId: false`', async () => {
    const semOpcao = ok();
    await criarClienteLeituraLi({
      obterCredencial: () => ({ token: TOKEN, ref: 'r' }),
      fetch: semOpcao,
    }).get(pedido());
    expect(requisicao(semOpcao).headers.has('x-correlation-id')).toBe(true);

    const desligado = ok();
    const { c, eventos } = cliente(desligado, { enviarCorrelationId: false });
    const r = await c.get(pedido());
    expect(requisicao(desligado).headers.has('x-correlation-id')).toBe(false);
    // Still generated and returned, so the app's logs correlate.
    expect(r.correlationId).toBe('corr-1');
    expect(eventos[0]?.enviouCorrelationId).toBe(false);
    expect(eventos[0]?.correlationId).toBe('corr-1');
  });

  it('puts the correlation id on every error', async () => {
    const err = await falha(cliente(mockFetch(() => texto('', 500))).c.get(pedido()));
    expect(err).toBeInstanceOf(LiHttpError);
    expect((err as LiHttpError).correlationId).toBe('corr-1');

    const rede = await falha(
      cliente(
        mockFetch(() => {
          throw new TypeError('fetch failed');
        }),
      ).c.get(pedido()),
    );
    expect((rede as LiNetworkError).correlationId).toBe('corr-1');

    const schemaErr = await falha(cliente(mockFetch(() => texto('', 200))).c.get(pedido()));
    expect((schemaErr as LiSchemaError).correlationId).toBe('corr-1');
  });
});

describe('the credential getter', () => {
  it('is called on EVERY request — what it returns now is what the next request sends', async () => {
    const f = ok();
    const credenciais: CredencialLi[] = [
      { token: TOKEN, ref: 'ref-A' },
      { token: TOKEN_2, ref: 'ref-B' },
    ];
    let i = 0;
    const obterCredencial = vi.fn(() => {
      const cred = credenciais[i];
      i += 1;
      if (cred === undefined) throw new Error('chamado demais');
      return cred;
    });
    const { c } = cliente(f, { obterCredencial });
    await c.get(pedido());
    await c.get(pedido());
    expect(obterCredencial).toHaveBeenCalledTimes(2);
    expect(requisicao(f, 0).headers.get('authorization')).toBe(`Basic ${TOKEN}`);
    expect(requisicao(f, 1).headers.get('authorization')).toBe(`Basic ${TOKEN_2}`);
  });

  it('accepts an async getter', async () => {
    const f = ok();
    const { c } = cliente(f, { obterCredencial: async () => ({ token: TOKEN_2, ref: 'ref-B' }) });
    const r = await c.get(pedido());
    expect(r.refCredencial).toBe('ref-B');
  });

  it('near-miss: the 401 reports the ref of ITS request, never an earlier one', async () => {
    let n = 0;
    const f = mockFetch(() => {
      n += 1;
      return n === 1 ? json(categoriaPagina1) : texto(corpo401Json, 401);
    });
    const refs = ['ref-A', 'ref-B'];
    let i = 0;
    const { c, eventos } = cliente(f, {
      obterCredencial: () => {
        const ref = refs[i] ?? 'ref-?';
        i += 1;
        return { token: i === 1 ? TOKEN : TOKEN_2, ref };
      },
    });
    const r = await c.get(pedido());
    expect(r.refCredencial).toBe('ref-A');
    const err = await falha(c.get(pedido()));
    expect(err).toBeInstanceOf(LiAuthError);
    expect((err as LiAuthError).refCredencial).toBe('ref-B');
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
  // reject with a TypeError QUOTING the whole Authorization value.
  it.each([
    ['empty', ''],
    ['an inner space', 'tok en-sintetico'],
    ['a tab', `${TOKEN}\t`],
    ['a trailing \\n', `${TOKEN}\n`],
    ['a trailing \\r', `${TOKEN}\r`],
    ['a NUL', `${TOKEN}\u0000`],
    ['a DEL', `${TOKEN}\u007f`],
    ['Ā (U+0100)', `${TOKEN}Ā`],
    ['é', `${TOKEN}é`],
    ['a leading space', ` ${TOKEN}`],
  ])('a token with %s → LiConfigError("token")', async (_caso, token) => {
    const f = ok();
    const { c, eventos } = cliente(f, { obterCredencial: () => ({ token, ref: 'ref-A' }) });
    const err = await falha(c.get(pedido()));
    expect(err).toBeInstanceOf(LiConfigError);
    expect((err as LiConfigError).motivo).toBe('token');
    // A refused token never carries its ref, even an innocent one.
    expect((err as LiConfigError).refCredencial).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
    if (token.length > 0) {
      expect((err as Error).message).not.toContain(token);
      expect(JSON.stringify(err)).not.toContain(token.trim());
      expect((err as Error).message).not.toContain(TOKEN);
      expect(JSON.stringify(err)).not.toContain(TOKEN);
    }
  });

  it('near-miss: a 40-character visible-ASCII token IS sent', async () => {
    expect(TOKEN).toHaveLength(40);
    const f = ok();
    await cliente(f).c.get(pedido());
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('near-miss: every visible-ASCII character is accepted and sent verbatim', async () => {
    let visivel = '';
    for (let cp = 0x21; cp <= 0x7e; cp++) visivel += String.fromCharCode(cp);
    const f = ok();
    await cliente(f, { obterCredencial: () => ({ token: visivel, ref: 'ref-A' }) }).c.get(pedido());
    expect(requisicao(f).headers.get('authorization')).toBe(`Basic ${visivel}`);
  });

  it('the strict check runs BEFORE headers are built: real `Headers` never sees a NUL', async () => {
    // The fake builds `Headers` from the init, exactly as Node's `fetch` does —
    // which would throw a TypeError quoting the header value.
    const f = mockFetch((_input, init) => {
      const enviados = new Headers(init?.headers);
      return json({ ...categoriaPagina1, eco: enviados.has('authorization') });
    });
    const err = await falha(
      cliente(f, { obterCredencial: () => ({ token: `${TOKEN}\u0000`, ref: 'r' }) }).c.get(
        pedido(),
      ),
    );
    expect(err).toBeInstanceOf(LiConfigError);
    expect(f).not.toHaveBeenCalled();
    for (const m of mensagensDaCadeia(err)) expect(m).not.toContain(TOKEN);
  });

  it.each([
    ['empty', ''],
    ['longer than 64 characters', 'r'.repeat(MAX_REF_CREDENCIAL + 1)],
    ['containing the token', `fp:${TOKEN}`],
  ])('a ref %s → LiConfigError("ref"), never echoed', async (_caso, ref) => {
    const f = ok();
    const { c, eventos } = cliente(f, { obterCredencial: () => ({ token: TOKEN, ref }) });
    const err = await falha(c.get(pedido()));
    expect(err).toBeInstanceOf(LiConfigError);
    expect((err as LiConfigError).motivo).toBe('ref');
    expect((err as LiConfigError).refCredencial).toBeNull();
    expect(JSON.stringify(err)).not.toContain(TOKEN);
    expect(f).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
  });

  it('a bad token never echoes a ref that contains it', async () => {
    const f = ok();
    const token = `${TOKEN}\n`;
    const err = await falha(
      cliente(f, { obterCredencial: () => ({ token, ref: `fp:${token}` }) }).c.get(pedido()),
    );
    expect((err as LiConfigError).motivo).toBe('token');
    expect((err as LiConfigError).refCredencial).toBeNull();
  });

  // The paste accident this check exists for: the dirty token is not inside a
  // ref that holds the CLEAN one, so a contains-the-token test cannot see it.
  it.each([
    ['a trailing \\n', `${TOKEN}\n`],
    ['a leading space', ` ${TOKEN}`],
    ['a NUL in the middle', `${TOKEN.slice(0, 20)}\u0000${TOKEN.slice(20)}`],
  ])('a bad token (%s) never echoes a ref holding the CLEAN token', async (_caso, token) => {
    const f = ok();
    const err = await falha(
      cliente(f, { obterCredencial: () => ({ token, ref: TOKEN }) }).c.get(pedido()),
    );
    expect((err as LiConfigError).motivo).toBe('token');
    expect((err as LiConfigError).refCredencial).toBeNull();
    expect(JSON.stringify(err)).not.toContain(TOKEN.slice(0, 20));
    for (const m of mensagensDaCadeia(err)) expect(m).not.toContain(TOKEN.slice(0, 20));
    expect(f).not.toHaveBeenCalled();
  });

  it('near-miss: a 64-character ref is accepted', async () => {
    const f = ok();
    const ref = 'r'.repeat(MAX_REF_CREDENCIAL);
    const r = await cliente(f, { obterCredencial: () => ({ token: TOKEN, ref }) }).c.get(pedido());
    expect(r.refCredencial).toBe(ref);
  });

  it.each([
    'v1/categoria/',
    '/v2/categoria/',
    '/api/v1/categoria/',
    '/v1/categoria/?limit=1',
    '/v1/categoria/#x',
    '/v1/https://evil.example/',
    '/v1/../admin/',
    // What the WHATWG parser `fetch` uses would rewrite into a parent segment.
    '/v1/%2e%2e/admin/',
    '/v1/%2E%2E/admin/',
    '/v1/.%2E/admin/',
    '/v1/.\t./admin/',
    '/v1/.\n./admin/',
    // Encoded separators a server could still decode, and anything else the
    // parser would rewrite.
    '/v1/%2e%2e%5cadmin',
    '/v1/categoria%2Fadmin',
    '/v1/./categoria/',
    '/v1/categoria/\n',
    '/v1/x y/',
    '',
  ])('a bad path %j → LiConfigError("caminho"), before the getter', async (caminho) => {
    const f = ok();
    const obterCredencial = vi.fn(() => ({ token: TOKEN, ref: 'ref-A' }));
    const { c, eventos } = cliente(f, { obterCredencial });
    const err = await falha(c.get({ ...pedido(), caminho }));
    expect(err).toBeInstanceOf(LiConfigError);
    expect((err as LiConfigError).motivo).toBe('caminho');
    expect((err as LiConfigError).refCredencial).toBeNull();
    expect(obterCredencial).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
    // The message never echoes a path that may carry a query.
    if (caminho.includes('?')) expect((err as Error).message).not.toContain('limit=1');
  });

  it.each(['/v1/pedido/search/', '/v1/produto/123', '/v1/categoria/7645875/'])(
    'near-miss: a plain path %j reaches the server exactly as written',
    async (caminho) => {
      const f = ok();
      await cliente(f).c.get({ ...pedido(), caminho });
      expect(f).toHaveBeenCalledTimes(1);
      expect(requisicao(f).url.pathname).toBe(caminho);
    },
  );
});

describe('the token never rides the URL', () => {
  it.each<[string, string, Record<string, string | number>]>([
    ['the path', `/v1/categoria/${TOKEN}/`, { limit: 20 }],
    ['a query value', CAMINHO, { limit: 20, chave: TOKEN }],
    ['a query key', CAMINHO, { [TOKEN]: 1 }],
    ['a query value, wrapped', CAMINHO, { busca: `x${TOKEN}y` }],
  ])(
    'a token in %s → LiConfigError("token-na-url"), nothing sent',
    async (_caso, caminho, query) => {
      const f = ok();
      const { c, eventos } = cliente(f);
      const err = await falha(c.get({ ...pedido({ query }), caminho }));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('token-na-url');
      expect((err as LiConfigError).refCredencial).toBe('ref-A');
      expect(f).not.toHaveBeenCalled();
      expect(eventos).toEqual([]);
      expect(JSON.stringify(err)).not.toContain(TOKEN);
      for (const m of mensagensDaCadeia(err)) expect(m).not.toContain(TOKEN);
    },
  );

  it('a token the query encoding would disguise is still caught as given', async () => {
    // `+`, `/` and `=` are percent-encoded in the query string, so the raw token
    // never appears in the final URL — only the per-entry check sees it.
    const token = 'tok+TESTE/0000=sintetico-1111-naoreal-77';
    const f = ok();
    const { c } = cliente(f, { obterCredencial: () => ({ token, ref: 'ref-A' }) });
    const err = await falha(c.get(pedido({ query: { limit: 20, chave: token } })));
    expect((err as LiConfigError).motivo).toBe('token-na-url');
    expect(f).not.toHaveBeenCalled();
  });

  it('near-miss: a fragment of the token in the path or the query is sent', async () => {
    const f = ok();
    const trecho = TOKEN.slice(4, 20);
    await cliente(f).c.get({
      ...pedido({ query: { limit: 20, busca: trecho } }),
      caminho: `/v1/categoria/${trecho}/`,
    });
    expect(f).toHaveBeenCalledTimes(1);
    expect(requisicao(f).url.searchParams.get('busca')).toBe(trecho);
    expect(requisicao(f).url.pathname).toBe(`/v1/categoria/${trecho}/`);
  });
});

describe('request shape', () => {
  it('is a GET with `redirect: "manual"`, no body, and the deadline signal', async () => {
    const f = ok();
    await cliente(f).c.get(pedido());
    const { init } = requisicao(f);
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('encodes the query, and omits the `?` when there is none', async () => {
    const f = ok();
    const { c } = cliente(f);
    await c.get(pedido({ query: { since_atualizado: '2026-10-07T10:00:00', situacao_id: 4 } }));
    await c.get({ ...pedido(), query: {} });
    expect(requisicao(f, 0).url.searchParams.get('since_atualizado')).toBe('2026-10-07T10:00:00');
    expect(requisicao(f, 0).url.searchParams.get('situacao_id')).toBe('4');
    expect(requisicao(f, 1).url.href).toBe(`${URL_BASE_LI}${CAMINHO}`);
  });

  it('a 3xx is a non-transient LiHttpError — never followed', async () => {
    const f = mockFetch(() =>
      texto('', 301, { location: 'https://outro-host.example/v1/categoria/' }),
    );
    const err = await falha(cliente(f).c.get(pedido()));
    expect(err).toBeInstanceOf(LiHttpError);
    expect((err as LiHttpError).status).toBe(301);
    expect((err as LiHttpError).transitorio).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('the status table', () => {
  it.each<[number, string, (new (...a: never[]) => LiError) | null, boolean | null]>([
    [200, '', null, null],
    [301, '', LiHttpError, false],
    [400, '{"erro": "parâmetro inválido"}', LiHttpError, false],
    [401, corpo401Json, LiAuthError, false],
    [403, corpo403Html, LiAuthError, false],
    [404, '', LiNotFoundError, false],
    [409, corpo409Bruto, LiHttpError, false],
    [429, corpo429Loja, LiThrottleError, true],
    [500, corpo500Html, LiHttpError, true],
    [503, 'Service Unavailable', LiHttpError, true],
    [520, '', LiHttpError, true],
    [418, '', LiHttpError, false],
  ])('HTTP %i', async (status, corpo, classe, transitorio) => {
    const f = mockFetch(() => (status === 200 ? json(categoriaPagina1) : texto(corpo, status)));
    const p = cliente(f).c.get(pedido());
    if (classe === null) {
      const r = await p;
      expect(r.status).toBe(200);
      expect(r.dados.objects).toHaveLength(3);
      return;
    }
    const err = await falha(p);
    expect(err).toBeInstanceOf(classe);
    expect((err as LiHttpError).status).toBe(status);
    expect((err as LiHttpError).transitorio).toBe(transitorio);
  });

  it('exact classes: 400 and 409 are plain LiHttpError, never auth or throttle', async () => {
    for (const status of [400, 409]) {
      const err = await falha(cliente(mockFetch(() => texto('', status))).c.get(pedido()));
      expect(err).not.toBeInstanceOf(LiAuthError);
      expect(err).not.toBeInstanceOf(LiNotFoundError);
      expect(err).not.toBeInstanceOf(LiThrottleError);
    }
  });

  it('a 429 carries its scope, codes and Retry-After', async () => {
    const f = mockFetch(() => texto(corpo429Loja, 429, { 'retry-after': '30' }));
    const err = await falha(cliente(f).c.get(pedido()));
    expect(err).toBeInstanceOf(LiThrottleError);
    expect(err).toMatchObject({
      escopo: 'loja',
      codigosEncontrados: [633],
      retryAfterS: 30,
      transitorio: true,
    });
  });

  it('near-miss: a 400 whose body contains 633 stays a plain LiHttpError', async () => {
    const f = mockFetch(() => texto(corpo429Loja, 400));
    const { c, eventos } = cliente(f);
    const err = await falha(c.get(pedido()));
    expect(err).toBeInstanceOf(LiHttpError);
    expect(err).not.toBeInstanceOf(LiThrottleError);
    expect(eventos[0]?.codigoLimite).toBeNull();
    expect(eventos[0]?.resultado).toBe('http');
  });
});

describe('2xx bodies', () => {
  it('a body that fails the schema → LiSchemaError("formato"), naming paths, not values', async () => {
    const marcador = 'MARCADOR-INJETADO-NO-CORPO';
    const corpo = {
      ...categoriaPagina1,
      objects: [{ ...categoriaPagina1.objects[0], id: marcador }],
    };
    const err = await falha(cliente(mockFetch(() => json(corpo))).c.get(pedido()));
    expect(err).toBeInstanceOf(LiSchemaError);
    const e = err as LiSchemaError;
    expect(e.motivo).toBe('formato');
    expect(e.campos).toEqual(['objects[].id']);
    expect(e.message).toContain('objects[].id');
    expect(e.message).not.toContain(marcador);
    expect(JSON.stringify(e)).not.toContain(marcador);
  });

  it('HTML → LiSchemaError("nao-json")', async () => {
    const err = await falha(
      cliente(mockFetch(() => texto('<html>ok</html>', 200))).c.get(pedido()),
    );
    expect(err).toBeInstanceOf(LiSchemaError);
    expect((err as LiSchemaError).motivo).toBe('nao-json');
    expect(JSON.stringify(err)).not.toContain('<html>');
  });

  it('an empty body → LiSchemaError("vazio")', async () => {
    const err = await falha(cliente(mockFetch(() => texto('', 200))).c.get(pedido()));
    expect(err).toBeInstanceOf(LiSchemaError);
    expect((err as LiSchemaError).motivo).toBe('vazio');
  });

  it('returns the parsed data with the provider number tolerance', async () => {
    const corpo = { ...categoriaPagina1, meta: { ...categoriaPagina1.meta, limit: '20' } };
    const r = await cliente(mockFetch(() => json(corpo))).c.get(pedido());
    expect(r.dados.meta.limit).toBe(20);
  });
});

describe('transport failures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a TypeError from fetch → LiNetworkError, its text kept out of the message', async () => {
    const causa = new TypeError('MARCADOR-DA-CAUSA fetch failed');
    const f = mockFetch(() => {
      throw causa;
    });
    const { c, eventos } = cliente(f);
    const err = await falha(c.get(pedido()));
    expect(err).toBeInstanceOf(LiNetworkError);
    expect(err).not.toBeInstanceOf(LiTimeoutError);
    expect((err as LiNetworkError).cause).toBe(causa);
    expect((err as Error).message).not.toContain('MARCADOR-DA-CAUSA');
    expect(eventos[0]).toMatchObject({ resultado: 'rede', status: null, corpo: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a TypeError from text() (a connection dropped mid-body) → LiNetworkError', async () => {
    const f = mockFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new TypeError('terminated'));
            },
          }),
          { status: 200 },
        ),
    );
    const { c, eventos } = cliente(f);
    const err = await falha(c.get(pedido()));
    expect(err).toBeInstanceOf(LiNetworkError);
    expect(err).not.toBeInstanceOf(LiTimeoutError);
    // The headers DID arrive: the event says which status, and that no body was read.
    expect(eventos[0]).toMatchObject({ resultado: 'rede', status: 200, corpo: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is still pending at budget−1 and times out at the budget with prazoMs', async () => {
    const { c, eventos } = cliente(fetchQueNuncaResponde());
    const { estado, pronto } = observar(c.get(pedido()));

    await vi.advanceTimersByTimeAsync(PRAZO_LI_MS.leitura - 1);
    expect(estado.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pronto;
    expect(estado.valor).toBeInstanceOf(LiTimeoutError);
    expect(estado.valor).toBeInstanceOf(LiNetworkError);
    expect((estado.valor as LiTimeoutError).prazoMs).toBe(PRAZO_LI_MS.leitura);
    expect(eventos.map((e) => e.resultado)).toEqual(['tempo-esgotado']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a stall AFTER the headers times out too — the body is read inside the window', async () => {
    const { c } = cliente(fetchQueTravaNoCorpo());
    const { estado, pronto } = observar(c.get(pedido()));
    await vi.advanceTimersByTimeAsync(PRAZO_LI_MS.leitura);
    await pronto;
    expect(estado.settled).toBe(true);
    expect(estado.valor).toBeInstanceOf(LiTimeoutError);
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
    expect(estado.valor).not.toBeInstanceOf(LiError);
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
      return json(categoriaPagina1);
    });
    const lento = () =>
      new Promise<CredencialLi>((resolve) => {
        setTimeout(() => resolve({ token: TOKEN, ref: 'ref-A' }), PRAZO_LI_MS.leitura + 5_000);
      });
    const { estado, pronto } = observar(cliente(f, { obterCredencial: lento }).c.get(pedido()));
    await vi.advanceTimersByTimeAsync(PRAZO_LI_MS.leitura + 5_000);
    await pronto;
    expect(estado.valor).not.toBeInstanceOf(LiError);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('no token and no body on errors', () => {
  const ecoaToken = (status: number) =>
    mockFetch(() => texto(`{"detail": "token ${TOKEN} recusado"}`, status));

  it.each([400, 401, 403, 404, 429, 500])(
    'HTTP %i echoing the token: nowhere on the error, scrubbed for the observer',
    async (status) => {
      const { c, eventos } = cliente(ecoaToken(status));
      const err = await falha(c.get(pedido()));
      expect(err).toBeInstanceOf(LiHttpError);
      expect((err as Error).message).not.toContain(TOKEN);
      expect(JSON.stringify(err)).not.toContain(TOKEN);
      for (const m of mensagensDaCadeia(err)) expect(m).not.toContain(TOKEN);
      expect(eventos).toHaveLength(1);
      expect(JSON.stringify(eventos[0])).not.toContain(TOKEN);
      expect(eventos[0]?.corpo).toBe(`{"detail": "token ${TOKEN_REMOVIDO} recusado"}`);
    },
  );

  it('a 2xx echoing the token is scrubbed for the observer, and the data is the raw parse', async () => {
    const corpo = { ...categoriaPagina1, eco: TOKEN };
    const { c, eventos } = cliente(mockFetch(() => json(corpo)));
    const r = await c.get(pedido());
    expect(JSON.stringify(eventos[0])).not.toContain(TOKEN);
    // The scrub feeds the observer only; it never rewrites what the caller reads.
    expect((r.dados as Record<string, unknown>).eco).toBe(TOKEN);
  });

  it('near-miss: the exact token is scrubbed, a substring or a lookalike is not', async () => {
    const parcial = TOKEN.slice(0, 20);
    const parecido = `${TOKEN.slice(0, -1)}9`;
    const corpo = `a=${TOKEN} b=${parcial} c=${parecido}`;
    const { c, eventos } = cliente(mockFetch(() => texto(corpo, 500)));
    await falha(c.get(pedido()));
    expect(eventos[0]?.corpo).toBe(`a=${TOKEN_REMOVIDO} b=${parcial} c=${parecido}`);
  });

  it('a 4xx carrying personal data: none of it reaches the error', async () => {
    const err = await falha(
      cliente(mockFetch(() => texto(corpo422ComDadosPessoais, 422))).c.get(pedido()),
    );
    expect(err).toBeInstanceOf(LiHttpError);
    for (const dado of [EMAIL_FALSO, CPF_FALSO]) {
      expect((err as Error).message).not.toContain(dado);
      expect(JSON.stringify(err)).not.toContain(dado);
    }
  });

  it('a query value never reaches an error message', async () => {
    const marcador = 'VALOR-DE-FILTRO-SECRETO';
    const err = await falha(
      cliente(mockFetch(() => texto('', 500))).c.get(pedido({ query: { busca: marcador } })),
    );
    expect((err as Error).message).not.toContain(marcador);
    expect(JSON.stringify(err)).not.toContain(marcador);
  });
});

describe('the observer', () => {
  it('is called once per request, with the documented fields', async () => {
    let t = 1_000;
    const f = ok();
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
        operacao: 'listarCategorias',
        metodo: 'GET',
        caminho: CAMINHO,
        query: [['limit', '20']],
        correlationId: 'corr-1',
        enviouCorrelationId: true,
        refCredencial: 'ref-A',
        status: 200,
        latenciaMs: 37,
        resultado: 'ok',
        codigoLimite: null,
        retryAfterS: null,
        corpo: JSON.stringify(categoriaPagina1),
      } satisfies ChamadaLi,
    ]);
  });

  it('carries the 429 code and Retry-After', async () => {
    const { c, eventos } = cliente(
      mockFetch(() => texto(corpo429Loja, 429, { 'retry-after': '12' })),
    );
    await falha(c.get(pedido()));
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({
      resultado: 'limite',
      status: 429,
      codigoLimite: 633,
      retryAfterS: 12,
      corpo: corpo429Loja,
    });
  });

  it.each<[number, ResultadoChamadaLi]>([
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

  it('never carries a request header', async () => {
    const { c, eventos } = cliente(ok());
    await c.get(pedido());
    const evento = eventos[0];
    expect(evento).toBeDefined();
    const chaves = Object.keys(evento ?? {});
    expect(chaves).not.toContain('headers');
    expect(chaves).not.toContain('Authorization');
    expect(JSON.stringify(evento)).not.toMatch(/authorization|Basic /i);
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
    vi.stubGlobal('fetch', f);
    try {
      await criarClienteLeituraLi({ obterCredencial: () => ({ token: TOKEN, ref: 'r' }) }).get({
        ...pedido(),
        schema: z.unknown(),
      });
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
