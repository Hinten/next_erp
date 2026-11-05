import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as barril from '../src/index';
import * as cliente_ from '../src/client';
import {
  type ChamadaAmazon,
  criarClienteSpApi,
  type OpcoesClienteSpApi,
  type PedidoGetSpApi,
  type SpApiLeituraClient,
  URL_BASE_SP_API,
} from '../src/client';
import {
  AmazonAuthError,
  AmazonConfigError,
  type AmazonError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonNotFoundError,
  AmazonSchemaError,
  AmazonThrottleError,
  AmazonTimeoutError,
} from '../src/errors';
import { criarClienteEscritaSpApi, type SpApiEscritaClient } from '../src/escrita';
import { PRAZO_AMAZON_MS } from '../src/prazos';
import {
  erro400InvalidInput,
  erro403Forbidden,
  erro429RateLimited,
  erro500InternalFailure,
} from './_fixtures/sandbox';
import {
  ACCESS_TOKEN,
  falha,
  fetchQueNuncaResponde,
  json,
  mockFetch,
  observar,
  requisicao,
  texto,
  textosDoErro,
  USER_AGENT,
  verificarFormaDasRequisicoesSpApi,
} from './_helpers/mockFetch';

afterEach(verificarFormaDasRequisicoesSpApi);

const CAMINHO = '/delivery/2022-07-01/invoice';
const CORPO = '{"a":"b"}';

/** Test-local and tolerant: the Delivery schemas are `entrega.ts`'s. */
const schema = z.union([z.null(), z.object({}).passthrough()]);

/** A sentinel no response, header or path carries: only the request body. */
const SENTINELA = 'SENTINELA-DO-CORPO-0000-nunca-no-evento';

function opcoes(fetch: typeof globalThis.fetch, eventos: ChamadaAmazon[]): OpcoesClienteSpApi {
  let n = 0;
  return {
    obterCredencial: () => ({ accessToken: ACCESS_TOKEN, ref: 'ref-A' }),
    userAgent: USER_AGENT,
    fetch,
    gerarCorrelationId: () => {
      n += 1;
      return `corr-${String(n)}`;
    },
    agora: () => 1_000,
    onChamada: (e) => eventos.push(e),
  };
}

/** A write client with every ambient input injected: no network, no clock, no randomness. */
function escritor(
  fetch: typeof globalThis.fetch,
  extra: Partial<OpcoesClienteSpApi> = {},
): { c: SpApiEscritaClient; eventos: ChamadaAmazon[] } {
  const eventos: ChamadaAmazon[] = [];
  return { c: criarClienteEscritaSpApi({ ...opcoes(fetch, eventos), ...extra }), eventos };
}

function leitor(fetch: typeof globalThis.fetch): {
  c: SpApiLeituraClient;
  eventos: ChamadaAmazon[];
} {
  const eventos: ChamadaAmazon[] = [];
  return { c: criarClienteSpApi(opcoes(fetch, eventos)), eventos };
}

function pedidoPost(extra: { corpo?: string; sinal?: AbortSignal; caminho?: string } = {}) {
  return {
    operacao: 'submitInvoice',
    caminho: extra.caminho ?? CAMINHO,
    query: { orderId: '000-0000000-0000000' },
    corpo: extra.corpo ?? CORPO,
    schema,
    sinal: extra.sinal,
  };
}

const ok = () => mockFetch(() => json({}));

describe('two separate clients, each with its own surface', () => {
  it('the write client has exactly `post`, and no `get`', () => {
    const { c } = escritor(ok());
    expect(Object.keys(c)).toEqual(['post']);
    expect('get' in c).toBe(false);
  });

  it('the read client still has `get` alone — no write method reaches it', () => {
    const { c } = leitor(ok());
    expect(Object.keys(c)).toEqual(['get']);
    expect('post' in c).toBe(false);
  });

  it('neither client type stands for the other, and `get` takes no body (compile-time)', () => {
    const { c: l } = leitor(ok());
    const { c: e } = escritor(ok());
    // @ts-expect-error — a read client has no write method
    const comoEscrita: SpApiEscritaClient = l;
    // @ts-expect-error — the write client has no `get`
    const comoLeitura: SpApiLeituraClient = e;
    const semCorpo: PedidoGetSpApi<typeof schema> = {
      operacao: 'x',
      caminho: CAMINHO,
      schema,
      // @ts-expect-error — `get` has no body parameter
      corpo: CORPO,
    };
    expect([comoEscrita, comoLeitura, semCorpo]).toHaveLength(3);
  });

  it('★ a body smuggled into a `get` request never travels: still a GET, no body, no content-type', async () => {
    const f = ok();
    const { c, eventos } = leitor(f);
    await c.get({ ...pedidoPost({ corpo: SENTINELA }), operacao: 'getInvoiceStatus' } as never);
    const { init, headers } = requisicao(f);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(headers.has('content-type')).toBe(false);
    expect(eventos.map((e) => e.metodo)).toEqual(['GET']);
  });

  it('the barrel exports the write client but never the shared request core', () => {
    expect(typeof barril.criarClienteEscritaSpApi).toBe('function');
    expect(typeof barril.criarClienteSpApi).toBe('function');
    for (const interno of ['executarSpApi', 'prepararNucleoSpApi']) {
      expect(Object.keys(barril)).not.toContain(interno);
    }
    // Anti-vacuity: the names are real — `client.ts` DOES export them.
    expect(typeof cliente_.executarSpApi).toBe('function');
    expect(typeof cliente_.prepararNucleoSpApi).toBe('function');
  });

  it('a user-agent the construction refuses names the WRITE factory, nothing sent', () => {
    const f = ok();
    let err: unknown;
    try {
      criarClienteEscritaSpApi({ ...opcoes(f, []), userAgent: ` ${USER_AGENT}` });
    } catch (e) {
      if (!(e instanceof AmazonConfigError)) throw e;
      err = e;
    }
    expect(err).toBeInstanceOf(AmazonConfigError);
    expect(err).toMatchObject({ motivo: 'user-agent', operacao: 'criarClienteEscritaSpApi' });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('headers', () => {
  it('★ the POST sends exactly five: the four of `get` plus content-type: application/json', async () => {
    const f = ok();
    await escritor(f).c.post(pedidoPost());
    const { headers } = requisicao(f);
    expect([...headers.keys()].sort()).toEqual([
      'accept',
      'content-type',
      'user-agent',
      'x-amz-access-token',
      'x-amz-date',
    ]);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('x-amz-access-token')).toBe(ACCESS_TOKEN);
    expect(headers.get('user-agent')).toBe(USER_AGENT);
    expect(headers.has('authorization')).toBe(false);
  });

  it('★ near-miss: the GET client still sends four, and no content-type', async () => {
    const f = ok();
    await leitor(f).c.get({ operacao: 'getInvoiceStatus', caminho: `${CAMINHO}/status`, schema });
    const { headers } = requisicao(f);
    expect([...headers.keys()].sort()).toEqual([
      'accept',
      'user-agent',
      'x-amz-access-token',
      'x-amz-date',
    ]);
    expect(headers.has('content-type')).toBe(false);
  });
});

describe('request shape', () => {
  it('is a POST with the body byte for byte, `redirect: "manual"`, the query and the deadline signal', async () => {
    const f = ok();
    const corpo = '{"invoiceContent":"QUJD","b":[1,2]}';
    await escritor(f).c.post(pedidoPost({ corpo }));
    const { init, url } = requisicao(f);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(corpo);
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(url.href).toBe(`${URL_BASE_SP_API}${CAMINHO}?orderId=000-0000000-0000000`);
  });

  it('returns the parsed data, the status and the ref, like `get`', async () => {
    const r = await escritor(ok()).c.post(pedidoPost());
    expect(r).toMatchObject({
      dados: {},
      status: 200,
      correlationId: 'corr-1',
      refCredencial: 'ref-A',
    });
  });

  it('the path and the token-in-URL checks are the core’s: nothing sent', async () => {
    const f = ok();
    const caminho = await falha(escritor(f).c.post(pedidoPost({ caminho: '/delivery/../x' })));
    expect(caminho).toMatchObject({ motivo: 'caminho' });
    const naUrl = await falha(
      escritor(f).c.post({ ...pedidoPost(), query: { orderId: ACCESS_TOKEN } }),
    );
    expect(naUrl).toMatchObject({ motivo: 'token-na-url' });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('the body never reaches the observer, nor an error', () => {
  it('★ a sentinel in the body is absent from the emitted event (a 2xx)', async () => {
    const f = ok();
    const { c, eventos } = escritor(f);
    await c.post(pedidoPost({ corpo: JSON.stringify({ invoiceContent: SENTINELA }) }));
    expect(requisicao(f).init.body).toContain(SENTINELA);
    expect(eventos).toHaveLength(1);
    expect(JSON.stringify(eventos)).not.toContain(SENTINELA);
    // The event's own fields, and no other: there is no slot a request body could take.
    expect(Object.keys(eventos[0] ?? {}).sort()).toEqual(
      [
        'caminho',
        'codigoLwa',
        'codigosErro',
        'corpo',
        'correlationId',
        'destino',
        'latenciaMs',
        'limiteTaxa',
        'metodo',
        'operacao',
        'query',
        'refCredencial',
        'requestIdAmazon',
        'resultado',
        'status',
      ].sort(),
    );
  });

  it('★ nor from the event or the error of a refusal (a 400)', async () => {
    const { c, eventos } = escritor(mockFetch(() => json(erro400InvalidInput, 400)));
    const err = await falha(c.post(pedidoPost({ corpo: JSON.stringify({ x: SENTINELA }) })));
    expect(err).toBeInstanceOf(AmazonHttpError);
    expect(JSON.stringify(eventos)).not.toContain(SENTINELA);
    for (const t of textosDoErro(err)) expect(t).not.toContain(SENTINELA);
  });

  it('the event names the POST, the sp-api destination and the RESPONSE text', async () => {
    const { c, eventos } = escritor(mockFetch(() => texto('{"resposta":1}', 200)));
    await c.post(pedidoPost());
    expect(eventos[0]).toMatchObject({
      destino: 'sp-api',
      metodo: 'POST',
      operacao: 'submitInvoice',
      caminho: CAMINHO,
      query: [['orderId', '000-0000000-0000000']],
      resultado: 'ok',
      corpo: '{"resposta":1}',
    });
  });
});

describe('no Tokens API response body reaches the observer (the core decides, by path)', () => {
  /** Stands in for a minted credential in the RESPONSE: never on an event. */
  const CREDENCIAL = 'CREDENCIAL-NA-RESPOSTA-0000-nunca-no-evento';
  const resposta = (status = 200) =>
    mockFetch(() => json({ restrictedDataToken: CREDENCIAL }, status));

  it.each([
    ['the mint’s path', '/tokens/2021-03-01/restrictedDataToken'],
    ['another Tokens API version', '/tokens/2099-01-01/outraOperacao'],
    ['the same segment in another case', '/tOKENS/2021-03-01/restrictedDataToken'],
  ])('★ a POST to %s → corpo: null, on a 2xx and on a 4xx', async (_caso, caminho) => {
    const sucesso = escritor(resposta());
    await sucesso.c.post(pedidoPost({ caminho }));
    expect(sucesso.eventos[0]).toMatchObject({ resultado: 'ok', caminho, corpo: null });

    const recusa = escritor(resposta(400));
    await falha(recusa.c.post(pedidoPost({ caminho })));
    expect(recusa.eventos[0]).toMatchObject({ resultado: 'http', status: 400, corpo: null });
    expect(JSON.stringify([...sucesso.eventos, ...recusa.eventos])).not.toContain(CREDENCIAL);
  });

  it('★ the read client too: a GET under /tokens/ → corpo: null', async () => {
    const { c, eventos } = leitor(resposta());
    await c.get({ operacao: 'x', caminho: '/tokens/2021-03-01/restrictedDataToken', schema });
    expect(eventos[0]).toMatchObject({ resultado: 'ok', metodo: 'GET', corpo: null });
  });

  it.each([
    ['a segment that only starts with the name', '/tokensx/2021-03-01/restrictedDataToken'],
    ['the name deeper in the path', '/orders/v0/tokens/restrictedDataToken'],
    ['the name as the last segment', '/delivery/2022-07-01/tokens'],
  ])('near-miss: %s keeps its body on the event', async (_caso, caminho) => {
    const { c, eventos } = escritor(resposta());
    await c.post(pedidoPost({ caminho }));
    expect(eventos[0]?.corpo).toBe(`{"restrictedDataToken":"${CREDENCIAL}"}`);
  });
});

describe('the token never rides the body', () => {
  it('★ a body holding the token is refused before fetch runs: token-no-corpo, nothing observed', async () => {
    const f = ok();
    const { c, eventos } = escritor(f);
    const err = await falha(
      c.post(pedidoPost({ corpo: JSON.stringify({ x: `antes-${ACCESS_TOKEN}-depois` }) })),
    );
    expect(err).toBeInstanceOf(AmazonConfigError);
    expect(err).toMatchObject({
      motivo: 'token-no-corpo',
      operacao: 'submitInvoice',
      refCredencial: 'ref-A',
    });
    expect(f).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
    for (const t of textosDoErro(err)) expect(t).not.toContain(ACCESS_TOKEN);
  });

  it('★ a body that is not text (bytes behind a cast) cannot be checked, so it is refused: nothing sent', async () => {
    const f = ok();
    const { c, eventos } = escritor(f);
    const bytes = new TextEncoder().encode(JSON.stringify({ x: ACCESS_TOKEN }));
    const err = await falha(c.post({ ...pedidoPost(), corpo: bytes as unknown as string }));
    expect(err).toBeInstanceOf(AmazonConfigError);
    expect(err).toMatchObject({
      motivo: 'token-no-corpo',
      operacao: 'submitInvoice',
      refCredencial: 'ref-A',
    });
    expect(f).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
  });

  it('near-miss: a fragment of the token in the body is sent', async () => {
    const f = ok();
    await escritor(f).c.post(
      pedidoPost({ corpo: JSON.stringify({ x: ACCESS_TOKEN.slice(0, 10) }) }),
    );
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('the classification is the GET table, with the codes on the error', () => {
  it.each<[number, unknown, new (...a: never[]) => AmazonError, boolean, string[]]>([
    [400, erro400InvalidInput, AmazonHttpError, false, ['InvalidInput']],
    [401, '', AmazonAuthError, false, []],
    [403, erro403Forbidden, AmazonAuthError, false, ['Forbidden']],
    [404, '', AmazonNotFoundError, false, []],
    [413, [{ code: 'RequestEntityTooLarge', message: 'm' }], AmazonHttpError, false, []],
    [415, '', AmazonHttpError, false, []],
    [429, erro429RateLimited, AmazonThrottleError, true, ['RateLimited']],
    [500, erro500InternalFailure, AmazonHttpError, true, ['InternalFailure']],
    [503, '', AmazonHttpError, true, []],
  ])('HTTP %i', async (status, corpo, classe, transitorio, codigos) => {
    const f = mockFetch(() =>
      typeof corpo === 'string' ? texto(corpo, status) : json(corpo, status),
    );
    const { c, eventos } = escritor(f);
    const err = await falha(c.post(pedidoPost()));
    expect(err).toBeInstanceOf(classe);
    expect(err).toMatchObject({ status, transitorio, destino: 'sp-api', metodo: 'POST' });
    expect((err as AmazonHttpError).codigosErro).toEqual(codigos);
    expect(eventos[0]?.codigosErro).toEqual(codigos);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('★ a 2xx failing the schema is AmazonSchemaError (the write may have landed), never an HttpError', async () => {
    const { c, eventos } = escritor(mockFetch(() => texto('<html>proxy</html>', 200)));
    const err = await falha(c.post(pedidoPost()));
    expect(err).toBeInstanceOf(AmazonSchemaError);
    expect(err).not.toBeInstanceOf(AmazonHttpError);
    expect(eventos.map((e) => e.resultado)).toEqual(['schema']);
  });

  it('a 3xx is never followed', async () => {
    const f = mockFetch(() => texto('', 307, { location: 'https://outro-host.example/x' }));
    const err = await falha(escritor(f).c.post(pedidoPost()));
    expect(err).toMatchObject({ status: 307, transitorio: false });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('the deadline: the write class, not the read one', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('★ PRAZO_AMAZON_MS.escrita bounds the POST: pending past the read budget, cut at its own', async () => {
    expect(PRAZO_AMAZON_MS.escrita).toBeGreaterThan(PRAZO_AMAZON_MS.leitura);
    const f = fetchQueNuncaResponde();
    const { c, eventos } = escritor(f);
    const { estado, pronto } = observar(
      c.post(pedidoPost({ corpo: JSON.stringify({ invoiceContent: SENTINELA }) })),
    );

    await vi.advanceTimersByTimeAsync(PRAZO_AMAZON_MS.leitura);
    expect(estado.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(PRAZO_AMAZON_MS.escrita - PRAZO_AMAZON_MS.leitura - 1);
    expect(estado.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pronto;
    expect(estado.valor).toBeInstanceOf(AmazonTimeoutError);
    expect(estado.valor).toBeInstanceOf(AmazonNetworkError);
    expect((estado.valor as AmazonTimeoutError).prazoMs).toBe(PRAZO_AMAZON_MS.escrita);
    expect(eventos.map((e) => e.resultado)).toEqual(['tempo-esgotado']);
    expect(vi.getTimerCount()).toBe(0);
    // ★ A cut write is the likeliest to carry a whole document: the failure
    // event never takes the REQUEST body (the GET and LWA paths cannot show it).
    expect(requisicao(f).init.body).toContain(SENTINELA);
    expect(eventos[0]?.corpo).toBeNull();
    expect(JSON.stringify(eventos)).not.toContain(SENTINELA);
    for (const t of textosDoErro(estado.valor)) expect(t).not.toContain(SENTINELA);
  });

  it.each<[string, () => { f: typeof globalThis.fetch; abortar?: AbortController }]>([
    [
      'rede',
      () => ({
        f: mockFetch(() => {
          throw new TypeError('terminated');
        }),
      }),
    ],
    ['cancelado', () => ({ f: fetchQueNuncaResponde(), abortar: new AbortController() })],
    [
      'inesperado',
      () => ({
        f: mockFetch(() => {
          throw new RangeError('init inválido');
        }),
      }),
    ],
  ])(
    '★ the %s arm: the event carries no request body, nor does the error',
    async (resultado, montar) => {
      const { f, abortar } = montar();
      const { c, eventos } = escritor(f);
      const { estado, pronto } = observar(
        c.post({
          ...pedidoPost({ corpo: JSON.stringify({ invoiceContent: SENTINELA }) }),
          sinal: abortar?.signal,
        }),
      );
      await vi.advanceTimersByTimeAsync(10);
      abortar?.abort();
      await pronto;
      expect(f).toHaveBeenCalledTimes(1);
      expect(eventos.map((e) => e.resultado)).toEqual([resultado]);
      expect(eventos[0]?.corpo).toBeNull();
      expect(JSON.stringify(eventos)).not.toContain(SENTINELA);
      for (const t of textosDoErro(estado.valor)) expect(t).not.toContain(SENTINELA);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('★ a caller abort in flight is rethrown as itself — never a timeout, never wrapped', async () => {
    const controller = new AbortController();
    const { c } = escritor(fetchQueNuncaResponde());
    const { estado, pronto } = observar(c.post({ ...pedidoPost(), sinal: controller.signal }));
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await pronto;
    expect(estado.valor).toBe(controller.signal.reason);
    expect(estado.valor).not.toBeInstanceOf(AmazonTimeoutError);
  });

  it('★ a caller signal already aborted: its reason comes back, nothing sent, nothing observed', async () => {
    const controller = new AbortController();
    controller.abort(new RangeError('motivo do chamador'));
    const f = ok();
    const { c, eventos } = escritor(f);
    await expect(c.post({ ...pedidoPost(), sinal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
    expect(f).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
  });

  it('★ near-miss: PRAZO_AMAZON_MS.leitura still bounds the GET', async () => {
    const { c } = leitor(fetchQueNuncaResponde());
    const { estado, pronto } = observar(
      c.get({ operacao: 'getInvoiceStatus', caminho: `${CAMINHO}/status`, schema }),
    );
    await vi.advanceTimersByTimeAsync(PRAZO_AMAZON_MS.leitura);
    await pronto;
    expect((estado.valor as AmazonTimeoutError).prazoMs).toBe(PRAZO_AMAZON_MS.leitura);
  });
});
