import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  type ChamadaLi,
  criarClienteLeituraLi,
  type CredencialLi,
  type LiLeituraClient,
  type OpcoesClienteLi,
  type ResultadoChamadaLi,
  TOKEN_REMOVIDO,
  URL_BASE_LI,
} from '../src/client';
import {
  criarClienteEscritaLi,
  type LeituraEcoLi,
  type LiEscritaClient,
  type PedidoPutLi,
} from '../src/escrita';
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
import * as cliente_ from '../src/client';
import * as ids from '../src/idsDeCaminho';
import * as barril from '../src/index';
import { PRAZO_LI_MS } from '../src/prazos';
import * as rotas from '../src/rotasEscrita';
import { corpo401Json, corpo403Html, corpo429Loja, corpo500Html } from './_fixtures/especificacao';
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
  verificarMetodos,
} from './_helpers/mockFetch';

/**
 * The write client (`escrita.ts`): its two methods, over `mockFetch` only.
 * Nothing here reaches Loja Integrada — every request is a stub, and the
 * `afterEach` below asserts the exact shape of EVERY one of them.
 *
 * The ids and the code are the public document's own examples (envio
 * `69291055`, objeto `PJ258408772BR`, numero `165`), never a captured value.
 */

afterEach(verificarMetodos(['GET', 'PUT']));

const CAMINHO_PUT = '/v1/pedido_envio/69291055';
const CAMINHO_SITUACAO = '/v1/situacao/pedido/165';
const CAMINHO_GET = '/v1/pedido/165/';
const OBJETO = 'PJ258408772BR';

const ecoSchema = z.object({ objeto: z.string().nullable().optional() }).passthrough();

function put(extra: Partial<PedidoPutLi<typeof ecoSchema>> = {}): PedidoPutLi<typeof ecoSchema> {
  return {
    operacao: 'atualizarObjetoEnvio',
    caminho: CAMINHO_PUT,
    corpo: { objeto: OBJETO },
    ecoSchema,
    ...extra,
  };
}

const pedidoSchema = z
  .object({ numero: z.number(), situacao: z.object({ codigo: z.string() }) })
  .passthrough();

function get(extra: { sinal?: AbortSignal } = {}) {
  return { operacao: 'buscarPedido', caminho: CAMINHO_GET, schema: pedidoSchema, ...extra };
}

/** A client with every ambient input injected: no network, no clock, no randomness. */
function cliente(
  fetch: typeof globalThis.fetch,
  extra: Partial<OpcoesClienteLi> = {},
): { c: LiEscritaClient; eventos: ChamadaLi[]; credenciais: () => number } {
  let n = 0;
  let pedidas = 0;
  const eventos: ChamadaLi[] = [];
  const c = criarClienteEscritaLi({
    obterCredencial: () => {
      pedidas += 1;
      return { token: TOKEN, ref: 'ref-A' };
    },
    fetch,
    gerarCorrelationId: () => {
      n += 1;
      return `corr-${String(n)}`;
    },
    agora: () => 1_000,
    onChamada: (e) => eventos.push(e),
    ...extra,
  });
  return { c, eventos, credenciais: () => pedidas };
}

const ECO_ENVIO = {
  data_criacao: '2022-10-31T12:28:05.722569',
  data_modificacao: '2023-02-10T10:48:36.747270',
  id: 69291055,
  objeto: OBJETO,
  prazo: 7,
  valor: '21.38',
};

const ok = (status = 200) => mockFetch(() => json(ECO_ENVIO, status));

async function falha(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('esperava uma rejeição');
    },
    (e: unknown) => e,
  );
}

/** A 2xx whose body stream fails with `erro` after the headers arrived. */
function corpoQueQuebra(status: number, erro: unknown) {
  return mockFetch(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(erro);
          },
        }),
        { status },
      ),
  );
}

/** 2xx headers, then a stall mid-body, with the status chosen. */
function travaNoCorpo(status: number) {
  return mockFetch((_input, init) => {
    const signal = init?.signal;
    const corpo = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(corpo, { status });
  });
}

describe('the client shapes — two separate clients, each with its own surface', () => {
  it('the write client has exactly its two methods, and no `get`', () => {
    const { c } = cliente(ok());
    expect(Object.keys(c)).toEqual(['lerAntesDeEscreverLi', 'enviarEscritaLi']);
    expect('get' in c).toBe(false);
  });

  it('the read client still has `get` alone — no write method reaches it', () => {
    const leitura = criarClienteLeituraLi({ obterCredencial: () => ({ token: TOKEN, ref: 'r' }) });
    expect(Object.keys(leitura)).toEqual(['get']);
    expect('enviarEscritaLi' in leitura).toBe(false);
  });

  it('neither client type stands for the other (compile-time)', () => {
    const leitura: LiLeituraClient = criarClienteLeituraLi({
      obterCredencial: () => ({ token: TOKEN, ref: 'r' }),
    });
    const { c } = cliente(ok());
    // @ts-expect-error — a read client has no write method
    const comoEscrita: LiEscritaClient = leitura;
    // @ts-expect-error — the write client has no plain `get`
    const comoLeitura: LiLeituraClient = c;
    expect([comoEscrita, comoLeitura]).toHaveLength(2);
  });

  it('the barrel exports the write client but never the shared request core', () => {
    expect(typeof barril.criarClienteEscritaLi).toBe('function');
    expect(typeof barril.criarClienteLeituraLi).toBe('function');
    expect(typeof barril.atualizarObjetoEnvioLi).toBe('function');
    expect(typeof barril.alterarSituacaoPedidoLi).toBe('function');
    for (const interno of ['executarLi', 'lerComSchemaLi', 'idOuRecusa', 'rotaDeEscritaLi']) {
      expect(Object.keys(barril)).not.toContain(interno);
    }
    // Anti-vacuity: the names above are real — the internal modules DO export them.
    expect(typeof cliente_.executarLi).toBe('function');
    expect(typeof cliente_.lerComSchemaLi).toBe('function');
    expect(typeof ids.idOuRecusa).toBe('function');
    expect(typeof rotas.rotaDeEscritaLi).toBe('function');
    // The public constants the routes are built from still reach the barrel.
    expect(barril.CODIGOS_SITUACAO_ESCRITA_LI).toBe(rotas.CODIGOS_SITUACAO_ESCRITA_LI);
    expect(barril.objetoDeEnvioValidoLi).toBe(rotas.objetoDeEnvioValidoLi);
    expect(barril.MAX_OBJETO_ENVIO_LI).toBe(200);
  });

  it('a direct PUT through the core itself still reaches only the write routes', async () => {
    // The core is the one function every request passes: the route table is
    // enforced THERE, so not even a module of this package can send around it.
    const f = ok();
    const corte2xx = () => 'cortado';
    const ler2xx = () => ({ resultado: 'ok' as const, valor: 'ok' });
    const opcoes = { obterCredencial: () => ({ token: TOKEN, ref: 'ref-A' }), fetch: f };
    for (const [caminho, corpo, motivo] of [
      ['/v1/produto/1', { objeto: OBJETO }, 'rota-nao-permitida'],
      [CAMINHO_SITUACAO, { codigo: 'pedido_cancelado' }, 'corpo'],
      [CAMINHO_PUT, { objeto: '' }, 'corpo'],
    ] as const) {
      const err = await falha(
        cliente_.executarLi(opcoes, {
          metodo: 'PUT',
          operacao: 'direto',
          caminho,
          corpo,
          corte2xx,
          ler2xx,
        }),
      );
      expect((err as LiConfigError).motivo).toBe(motivo);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('the manifest exports the root alone: no deep import reaches the core', () => {
    const manifesto = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as unknown;
    expect(manifesto).toMatchObject({
      exports: { '.': './src/index.ts', './package.json': './package.json' },
    });
    expect(Object.keys((manifesto as { exports: object }).exports)).toEqual([
      '.',
      './package.json',
    ]);
    // Resolved the way Node resolves the package by its own name.
    const resolver = createRequire(import.meta.url);
    // Positive control: the root resolves (a self-reference needs `exports`).
    expect(resolver.resolve('@delfrance/integrations-loja-integrada')).toMatch(
      /[\\/]src[\\/]index\.ts$/,
    );
    for (const profundo of [
      '@delfrance/integrations-loja-integrada/src/client.ts',
      '@delfrance/integrations-loja-integrada/src/client',
      '@delfrance/integrations-loja-integrada/src/escrita.ts',
    ]) {
      expect(() => resolver.resolve(profundo), profundo).toThrow(
        expect.objectContaining({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }),
      );
    }
  });
});

describe('enviarEscritaLi — request shape', () => {
  it('is a PUT of the exact JSON body, `redirect: "manual"`, with the deadline signal', async () => {
    const f = ok();
    await cliente(f).c.enviarEscritaLi(put());
    const { url, init } = requisicao(f);
    expect(init.method).toBe('PUT');
    expect(init.redirect).toBe('manual');
    expect(init.body).toBe('{"objeto":"PJ258408772BR"}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(url.href).toBe(`${URL_BASE_LI}${CAMINHO_PUT}`);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('sends exactly Authorization, Accept, Content-Type and x-correlation-id', async () => {
    const f = ok();
    await cliente(f).c.enviarEscritaLi(put());
    const { headers } = requisicao(f);
    expect([...headers.keys()].sort()).toEqual([
      'accept',
      'authorization',
      'content-type',
      'x-correlation-id',
    ]);
    expect(headers.get('authorization')).toBe(`Basic ${TOKEN}`);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-correlation-id')).toBe('corr-1');
  });

  it('sends the route schema’s OUTPUT, never the caller object — not even through its own toJSON', async () => {
    const f = ok();
    const corpo = { objeto: OBJETO };
    // Not enumerable, so the schema never sees it; `JSON.stringify` would call it.
    Object.defineProperty(corpo, 'toJSON', {
      value: () => ({ objeto: OBJETO, extra: 'CHAVE-QUE-NAO-PODE-IR' }),
      enumerable: false,
    });
    // Anti-vacuity: serialising the caller's object WOULD carry the extra key.
    expect(JSON.stringify(corpo)).toContain('CHAVE-QUE-NAO-PODE-IR');
    await cliente(f).c.enviarEscritaLi(put({ corpo }));
    expect(requisicao(f).init.body).toBe('{"objeto":"PJ258408772BR"}');
  });

  it('the body schema belongs to the route, never to the caller (compile-time)', () => {
    const naoCompila = (c: LiEscritaClient) =>
      c.enviarEscritaLi({
        ...put(),
        // @ts-expect-error — a caller cannot bring its own (looser) body schema
        corpoSchema: z.object({ objeto: z.string() }),
      });
    expect(typeof naoCompila).toBe('function');
  });

  it('a body its strict schema refuses → LiConfigError("corpo"); nothing is fetched, no credential read', async () => {
    const f = ok();
    const { c, eventos, credenciais } = cliente(f);
    for (const corpo of [
      { objeto: OBJETO, extra: 'X' },
      { objeto: 123 },
      {},
      null,
      'objeto=PJ258408772BR',
    ]) {
      const err = await falha(c.enviarEscritaLi(put({ corpo })));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('corpo');
    }
    expect(f).not.toHaveBeenCalled();
    expect(credenciais()).toBe(0);
    expect(eventos).toEqual([]);
  });

  it('a refused body never echoes a value or an unrecognised key in the error', async () => {
    const marcador = 'MARCADOR-NO-CORPO';
    const err = await falha(
      cliente(ok()).c.enviarEscritaLi(put({ corpo: { objeto: 7, [marcador]: marcador } })),
    );
    expect(err).toBeInstanceOf(LiConfigError);
    expect((err as Error).message).not.toContain(marcador);
    expect(JSON.stringify(err)).not.toContain(marcador);
  });

  it('a caller signal already aborted: nothing is sent, its reason comes back', async () => {
    const controller = new AbortController();
    controller.abort(new RangeError('motivo do chamador'));
    const f = ok();
    const { c, eventos } = cliente(f);
    await expect(c.enviarEscritaLi(put({ sinal: controller.signal }))).rejects.toBe(
      controller.signal.reason,
    );
    expect(f).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
  });

  it('calls the credential getter on EVERY write — a re-saved token is the next write’s', async () => {
    const f = ok();
    let atual: CredencialLi = { token: TOKEN, ref: 'ref-A' };
    const { c } = cliente(f, { obterCredencial: () => atual });
    await c.enviarEscritaLi(put());
    atual = { token: TOKEN_2, ref: 'ref-B' };
    const r = await c.enviarEscritaLi(put());
    expect(requisicao(f, 1).headers.get('authorization')).toBe(`Basic ${TOKEN_2}`);
    expect(r.refCredencial).toBe('ref-B');
  });

  it('omits x-correlation-id with `enviarCorrelationId: false`, and still returns the id', async () => {
    const f = ok();
    const r = await cliente(f, { enviarCorrelationId: false }).c.enviarEscritaLi(put());
    expect(requisicao(f).headers.has('x-correlation-id')).toBe(false);
    expect(r.correlationId).toBe('corr-1');
  });
});

describe('enviarEscritaLi — config errors: nothing is sent', () => {
  it.each([
    ['not under /v1/', '/v2/pedido_envio/1'],
    ['a query', '/v1/pedido_envio/1?x=1'],
    ['a fragment', '/v1/pedido_envio/1#x'],
    ['a parent segment', '/v1/../v1/pedido_envio/1'],
    ['an encoded separator', '/v1/pedido_envio/1%2F2'],
    ['a scheme', '/v1/http://outro/1'],
  ])('a path with %s → LiConfigError("caminho")', async (_rotulo, caminho) => {
    const f = ok();
    const { c, credenciais } = cliente(f);
    const err = await falha(c.enviarEscritaLi(put({ caminho })));
    expect(err).toBeInstanceOf(LiConfigError);
    expect((err as LiConfigError).motivo).toBe('caminho');
    expect(f).not.toHaveBeenCalled();
    expect(credenciais()).toBe(0);
  });

  it('a malformed token or ref → LiConfigError, nothing sent', async () => {
    const f = ok();
    for (const [credencial, motivo] of [
      [{ token: `${TOKEN}\n`, ref: 'ref-A' }, 'token'],
      [{ token: '', ref: 'ref-A' }, 'token'],
      [{ token: TOKEN, ref: '' }, 'ref'],
      [{ token: TOKEN, ref: `x${TOKEN}` }, 'ref'],
    ] as const) {
      const err = await falha(
        cliente(f, { obterCredencial: () => credencial }).c.enviarEscritaLi(put()),
      );
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe(motivo);
      expect((err as LiConfigError).refCredencial).toBeNull();
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('the token in the PATH → LiConfigError("token-na-url"), nothing sent', async () => {
    // A token of digits only is the one kind a write route's id can hold, so
    // the path reaches the URL check instead of failing the route table first.
    const tokenDeDigitos = '98765432109876543210';
    const f = ok();
    const err = await falha(
      cliente(f, {
        obterCredencial: () => ({ token: tokenDeDigitos, ref: 'ref-A' }),
      }).c.enviarEscritaLi(put({ caminho: `/v1/pedido_envio/${tokenDeDigitos}` })),
    );
    expect(err).toBeInstanceOf(LiConfigError);
    expect((err as LiConfigError).motivo).toBe('token-na-url');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('enviarEscritaLi — only the write routes, each with its OWN body', () => {
  it.each([
    ['another resource', '/v1/produto/1'],
    ['a read path', '/v1/pedido/165'],
    ['the envio route with a trailing slash', `${CAMINHO_PUT}/`],
    ['the situação route with a trailing slash', `${CAMINHO_SITUACAO}/`],
    ['an id with a leading zero', '/v1/pedido_envio/069291055'],
    ['a non-numeric id', '/v1/situacao/pedido/abc'],
    ['no id', '/v1/pedido_envio'],
    ['a longer path under a route', `${CAMINHO_SITUACAO}/extra`],
  ])(
    '%s → LiConfigError("rota-nao-permitida"); nothing fetched, no credential read',
    async (_r, caminho) => {
      const f = ok();
      const { c, eventos, credenciais } = cliente(f);
      const err = await falha(c.enviarEscritaLi(put({ caminho })));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('rota-nao-permitida');
      expect((err as Error).message).not.toContain(caminho);
      expect(f).not.toHaveBeenCalled();
      expect(credenciais()).toBe(0);
      expect(eventos).toEqual([]);
    },
  );

  it.each<[string, string, unknown]>([
    ['a cancellation', CAMINHO_SITUACAO, { codigo: 'pedido_cancelado' }],
    ['a paid codigo', CAMINHO_SITUACAO, { codigo: 'pedido_pago' }],
    ['faturado', CAMINHO_SITUACAO, { codigo: 'faturado' }],
    ['a cancellation request', CAMINHO_SITUACAO, { codigo: 'cancelamento_solicitado' }],
    ['a case variant', CAMINHO_SITUACAO, { codigo: 'Pedido_Enviado' }],
    ['an empty codigo', CAMINHO_SITUACAO, { codigo: '' }],
    ['an extra key', CAMINHO_SITUACAO, { codigo: 'pedido_enviado', extra: 'x' }],
    ['the envio body', CAMINHO_SITUACAO, { objeto: OBJETO }],
    ['a CLEARED code', CAMINHO_PUT, { objeto: '' }],
    ['a blank code', CAMINHO_PUT, { objeto: ' ' }],
    ['a null code', CAMINHO_PUT, { objeto: null }],
    ['a code over 200 characters', CAMINHO_PUT, { objeto: 'A'.repeat(201) }],
    ['the situação body', CAMINHO_PUT, { codigo: 'pedido_enviado' }],
  ])(
    '%s on its route → LiConfigError("corpo"); nothing fetched, no credential read',
    async (_r, caminho, corpo) => {
      const f = ok();
      const { c, credenciais } = cliente(f);
      const err = await falha(c.enviarEscritaLi(put({ caminho, corpo })));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('corpo');
      expect(f).not.toHaveBeenCalled();
      expect(credenciais()).toBe(0);
    },
  );

  it.each<[string, unknown]>([
    [CAMINHO_PUT, { objeto: OBJETO }],
    [CAMINHO_SITUACAO, { codigo: 'pedido_enviado' }],
    [CAMINHO_SITUACAO, { codigo: 'pedido_entregue' }],
    [CAMINHO_SITUACAO, { codigo: 'pronto_para_retirada' }],
  ])('near-miss: %s with its own valid body IS sent, as given', async (caminho, corpo) => {
    const f = mockFetch(() => texto('', 204));
    await cliente(f).c.enviarEscritaLi(put({ caminho, corpo }));
    expect(f).toHaveBeenCalledTimes(1);
    expect(requisicao(f).url.pathname).toBe(caminho);
    expect(requisicao(f).init.body).toBe(JSON.stringify(corpo));
  });
});

describe('enviarEscritaLi — the token never rides the BODY', () => {
  it.each([
    ['the whole value', TOKEN],
    ['inside a longer value', `PJ${TOKEN}BR`],
  ])('the token as %s → LiConfigError("token-no-corpo"), nothing sent', async (_r, objeto) => {
    const f = ok();
    const { c, eventos } = cliente(f);
    const err = await falha(c.enviarEscritaLi(put({ corpo: { objeto } })));
    expect(err).toBeInstanceOf(LiConfigError);
    expect((err as LiConfigError).motivo).toBe('token-no-corpo');
    // The credential WAS read (the check needs it), so its ref is safe to name.
    expect((err as LiConfigError).refCredencial).toBe('ref-A');
    for (const m of mensagensDaCadeia(err)) expect(m).not.toContain(TOKEN);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
    expect(f).not.toHaveBeenCalled();
    expect(eventos).toEqual([]);
  });

  it('a token JSON must escape (`"`, `\\`) is still caught in its escaped form', async () => {
    const tokenEscapado = 'tok-"aspas"-e-\\barra\\-sintetico-0000';
    const f = ok();
    const { c } = cliente(f, { obterCredencial: () => ({ token: tokenEscapado, ref: 'ref-A' }) });
    // Anti-vacuity: the serialised body does NOT contain the raw token.
    expect(JSON.stringify({ objeto: tokenEscapado })).not.toContain(tokenEscapado);
    const err = await falha(c.enviarEscritaLi(put({ corpo: { objeto: tokenEscapado } })));
    expect(err).toBeInstanceOf(LiConfigError);
    expect((err as LiConfigError).motivo).toBe('token-no-corpo');
    expect(f).not.toHaveBeenCalled();
  });

  it('near-miss: a fragment of the token in the body IS sent', async () => {
    const f = ok();
    const trecho = TOKEN.slice(0, 20);
    await cliente(f).c.enviarEscritaLi(put({ corpo: { objeto: trecho } }));
    expect(f).toHaveBeenCalledTimes(1);
    expect(requisicao(f).init.body).toBe(JSON.stringify({ objeto: trecho }));
  });
});

describe('enviarEscritaLi — ANY 2xx resolves: the write landed', () => {
  it.each<[number, () => Response, 'sim' | 'pendente', LeituraEcoLi, boolean]>([
    [200, () => json(ECO_ENVIO, 200), 'sim', 'ok', true],
    [201, () => json(ECO_ENVIO, 201), 'sim', 'ok', true],
    [204, () => texto('', 204), 'sim', 'vazio', false],
    [200, () => texto('', 200), 'sim', 'vazio', false],
    [202, () => texto('', 202), 'pendente', 'vazio', false],
    [202, () => json(ECO_ENVIO, 202), 'pendente', 'ok', true],
    [
      202,
      () => texto('<html><body>Accepted</body></html>', 202, { 'content-type': 'text/html' }),
      'pendente',
      'nao-json',
      false,
    ],
    [
      200,
      () => texto('<html>ok</html>', 200, { 'content-type': 'text/html' }),
      'sim',
      'nao-json',
      false,
    ],
    [200, () => json({ objeto: 123 }), 'sim', 'formato', false],
    [200, () => json([1, 2]), 'sim', 'formato', false],
  ])(
    'HTTP %i → aplicada and leituraEco',
    async (status, resposta, aplicada, leituraEco, comEco) => {
      const f = mockFetch(resposta);
      const { c, eventos } = cliente(f);
      const r = await c.enviarEscritaLi(put());
      expect(r.status).toBe(status);
      expect(r.aplicada).toBe(aplicada);
      expect(r.leituraEco).toBe(leituraEco);
      if (comEco) expect(r.eco).toMatchObject({ objeto: OBJETO });
      else expect(r.eco).toBeNull();
      expect(r.correlationId).toBe('corr-1');
      expect(r.refCredencial).toBe('ref-A');
      // The call succeeded: one `ok` event, whatever the echo looked like.
      expect(eventos.map((e) => e.resultado)).toEqual(['ok']);
      expect(f).toHaveBeenCalledTimes(1);
    },
  );

  it('near-miss: 202 is the ONLY pending status — 200, 201, 203, 204 and 206 are applied', async () => {
    for (const status of [200, 201, 203, 204, 206]) {
      const r = await cliente(mockFetch(() => texto('', status))).c.enviarEscritaLi(put());
      expect(r.aplicada, `HTTP ${String(status)}`).toBe('sim');
    }
    const r = await cliente(mockFetch(() => texto('', 202))).c.enviarEscritaLi(put());
    expect(r.aplicada).toBe('pendente');
  });

  it('the echo is the OUTPUT of its schema, not the raw JSON — extra keys kept by passthrough', async () => {
    const eco = z.object({ objeto: z.string().transform((s) => s.toLowerCase()) }).passthrough();
    const r = await cliente(mockFetch(() => json(ECO_ENVIO))).c.enviarEscritaLi({
      ...put(),
      ecoSchema: eco,
    });
    expect(r.eco).toMatchObject({ objeto: 'pj258408772br', valor: '21.38', id: 69291055 });
  });

  it('an echo carrying the token: scrubbed for the observer, the echo is the raw parse', async () => {
    const { c, eventos } = cliente(mockFetch(() => json({ ...ECO_ENVIO, eco: TOKEN })));
    const r = await c.enviarEscritaLi(put());
    expect(JSON.stringify(eventos[0])).not.toContain(TOKEN);
    expect(eventos[0]?.corpo).toContain(TOKEN_REMOVIDO);
    expect((r.eco as Record<string, unknown>).eco).toBe(TOKEN);
  });
});

describe('enviarEscritaLi — a 2xx whose BODY read is cut still resolves', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a connection dropped mid-body (TypeError "terminated") → leituraEco "falhou", event "rede"', async () => {
    const { c, eventos } = cliente(corpoQueQuebra(200, new TypeError('terminated')));
    const r = await c.enviarEscritaLi(put());
    expect(r).toMatchObject({ status: 200, aplicada: 'sim', eco: null, leituraEco: 'falhou' });
    expect(eventos).toHaveLength(1);
    expect(eventos[0]).toMatchObject({ resultado: 'rede', status: 200, corpo: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a 202 cut mid-body stays pending', async () => {
    const r = await cliente(corpoQueQuebra(202, new TypeError('terminated'))).c.enviarEscritaLi(
      put(),
    );
    expect(r).toMatchObject({ status: 202, aplicada: 'pendente', leituraEco: 'falhou' });
  });

  it('a stall mid-body: still pending at budget−1, resolved "falhou" at the WRITE budget', async () => {
    const { c, eventos } = cliente(travaNoCorpo(200));
    const { estado, pronto } = observar(c.enviarEscritaLi(put()));
    await vi.advanceTimersByTimeAsync(PRAZO_LI_MS.escrita - 1);
    expect(estado.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pronto;
    expect(estado.valor).toMatchObject({ status: 200, aplicada: 'sim', leituraEco: 'falhou' });
    expect(eventos.map((e) => e.resultado)).toEqual(['tempo-esgotado']);
    expect(eventos[0]?.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a caller abort mid-body is still rethrown as itself — never resolved, never wrapped', async () => {
    const controller = new AbortController();
    const { c, eventos } = cliente(travaNoCorpo(200));
    const { estado, pronto } = observar(c.enviarEscritaLi(put({ sinal: controller.signal })));
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await pronto;
    expect(estado.valor).toBe(controller.signal.reason);
    expect(estado.valor).not.toBeInstanceOf(LiError);
    expect(eventos.map((e) => e.resultado)).toEqual(['cancelado']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a body read failing with anything else is rethrown as itself', async () => {
    const propria = new RangeError('leitor quebrado');
    const { c, eventos } = cliente(corpoQueQuebra(200, propria));
    await expect(c.enviarEscritaLi(put())).rejects.toBe(propria);
    expect(eventos.map((e) => e.resultado)).toEqual(['inesperado']);
  });

  it('near-miss: a NON-2xx cut mid-body is thrown, exactly as for a GET', async () => {
    const err = await falha(
      cliente(corpoQueQuebra(500, new TypeError('terminated'))).c.enviarEscritaLi(put()),
    );
    expect(err).toBeInstanceOf(LiNetworkError);
    expect(err).not.toBeInstanceOf(LiTimeoutError);
    expect((err as Error).message).toContain('(PUT /v1/pedido_envio/69291055)');
  });

  it('near-miss: a stall mid-body on a NON-2xx times out (LiTimeoutError)', async () => {
    const { c } = cliente(travaNoCorpo(503));
    const { estado, pronto } = observar(c.enviarEscritaLi(put()));
    await vi.advanceTimersByTimeAsync(PRAZO_LI_MS.escrita);
    await pronto;
    expect(estado.valor).toBeInstanceOf(LiTimeoutError);
    expect((estado.valor as LiTimeoutError).prazoMs).toBe(PRAZO_LI_MS.escrita);
  });
});

describe('enviarEscritaLi — no response at all: classified as for a GET', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a TypeError from fetch → LiNetworkError naming the PUT, its text kept out', async () => {
    const causa = new TypeError('MARCADOR-DA-CAUSA fetch failed');
    const { c, eventos } = cliente(
      mockFetch(() => {
        throw causa;
      }),
    );
    const err = await falha(c.enviarEscritaLi(put()));
    expect(err).toBeInstanceOf(LiNetworkError);
    expect(err).not.toBeInstanceOf(LiTimeoutError);
    expect((err as LiNetworkError).cause).toBe(causa);
    expect((err as Error).message).toContain('PUT /v1/pedido_envio/69291055');
    expect((err as Error).message).not.toContain('MARCADOR-DA-CAUSA');
    expect(eventos[0]).toMatchObject({ resultado: 'rede', status: null, corpo: null });
  });

  it('no answer within the write budget → LiTimeoutError with prazoMs = PRAZO_LI_MS.escrita', async () => {
    const { c, eventos } = cliente(fetchQueNuncaResponde());
    const { estado, pronto } = observar(c.enviarEscritaLi(put()));
    await vi.advanceTimersByTimeAsync(PRAZO_LI_MS.escrita - 1);
    expect(estado.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pronto;
    expect(estado.valor).toBeInstanceOf(LiTimeoutError);
    expect((estado.valor as LiTimeoutError).prazoMs).toBe(PRAZO_LI_MS.escrita);
    expect((estado.valor as Error).message).toContain('(PUT /v1/pedido_envio/69291055)');
    expect(eventos.map((e) => e.resultado)).toEqual(['tempo-esgotado']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a caller abort before any response is rethrown as-is', async () => {
    const controller = new AbortController();
    const { c, eventos } = cliente(fetchQueNuncaResponde());
    const { estado, pronto } = observar(c.enviarEscritaLi(put({ sinal: controller.signal })));
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await pronto;
    expect(estado.valor).toBe(controller.signal.reason);
    expect(eventos.map((e) => e.resultado)).toEqual(['cancelado']);
  });

  it('a RangeError from fetch is rethrown as itself', async () => {
    const propria = new RangeError('init inválido');
    const { c, eventos } = cliente(
      mockFetch(() => {
        throw propria;
      }),
    );
    await expect(c.enviarEscritaLi(put())).rejects.toBe(propria);
    expect(eventos.map((e) => e.resultado)).toEqual(['inesperado']);
  });
});

describe('enviarEscritaLi — a non-2xx classifies exactly as a GET', () => {
  it.each<[number, string, new (...a: never[]) => LiError, boolean, ResultadoChamadaLi]>([
    [301, '', LiHttpError, false, 'http'],
    [302, '', LiHttpError, false, 'http'],
    [307, '', LiHttpError, false, 'http'],
    [400, '{"erro": "objeto inválido"}', LiHttpError, false, 'http'],
    [401, corpo401Json, LiAuthError, false, 'auth'],
    [403, corpo403Html, LiAuthError, false, 'auth'],
    [404, '', LiNotFoundError, false, 'nao-encontrado'],
    [409, '', LiHttpError, false, 'http'],
    [422, '', LiHttpError, false, 'http'],
    [429, corpo429Loja, LiThrottleError, true, 'limite'],
    [500, corpo500Html, LiHttpError, true, 'http'],
    [503, 'Service Unavailable', LiHttpError, true, 'http'],
  ])('HTTP %i', async (status, corpo, classe, transitorio, resultado) => {
    const f = mockFetch(() =>
      texto(corpo, status, status < 400 ? { location: 'https://outro.example/v1/x' } : {}),
    );
    const { c, eventos } = cliente(f);
    const err = await falha(c.enviarEscritaLi(put()));
    expect(err).toBeInstanceOf(classe);
    expect((err as LiHttpError).status).toBe(status);
    expect((err as LiHttpError).transitorio).toBe(transitorio);
    expect((err as Error).message).toContain('PUT /v1/pedido_envio/69291055');
    expect((err as Error).message).not.toContain('GET');
    expect(eventos.map((e) => e.resultado)).toEqual([resultado]);
    // Never followed: one request, and it asked not to follow.
    expect(f).toHaveBeenCalledTimes(1);
    expect(requisicao(f).init.redirect).toBe('manual');
  });

  it('exact classes: a 400 and a 409 are plain LiHttpError, never auth, not-found or throttle', async () => {
    for (const status of [400, 409]) {
      const err = await falha(cliente(mockFetch(() => texto('', status))).c.enviarEscritaLi(put()));
      expect(err).not.toBeInstanceOf(LiAuthError);
      expect(err).not.toBeInstanceOf(LiNotFoundError);
      expect(err).not.toBeInstanceOf(LiThrottleError);
    }
  });

  it('a 429 carries its scope, codes and Retry-After', async () => {
    const f = mockFetch(() => texto(corpo429Loja, 429, { 'retry-after': '30' }));
    const err = await falha(cliente(f).c.enviarEscritaLi(put()));
    expect(err).toMatchObject({
      escopo: 'loja',
      codigosEncontrados: [633],
      retryAfterS: 30,
      transitorio: true,
    });
  });

  it.each([400, 401, 403, 404, 429, 500])(
    'HTTP %i echoing the token: nowhere on the error, scrubbed for the observer',
    async (status) => {
      const { c, eventos } = cliente(
        mockFetch(() => texto(`{"detail": "token ${TOKEN} recusado"}`, status)),
      );
      const err = await falha(c.enviarEscritaLi(put()));
      for (const m of mensagensDaCadeia(err)) expect(m).not.toContain(TOKEN);
      expect(JSON.stringify(err)).not.toContain(TOKEN);
      expect(eventos[0]?.corpo).toBe(`{"detail": "token ${TOKEN_REMOVIDO} recusado"}`);
    },
  );
});

describe('enviarEscritaLi — the observer', () => {
  it('is called once per write, with the documented fields and metodo PUT', async () => {
    let t = 1_000;
    const { c, eventos } = cliente(ok(), {
      agora: () => {
        const v = t;
        t += 41;
        return v;
      },
    });
    await c.enviarEscritaLi(put());
    expect(eventos).toEqual([
      {
        operacao: 'atualizarObjetoEnvio',
        metodo: 'PUT',
        caminho: CAMINHO_PUT,
        query: [],
        correlationId: 'corr-1',
        enviouCorrelationId: true,
        refCredencial: 'ref-A',
        status: 200,
        latenciaMs: 41,
        resultado: 'ok',
        codigoLimite: null,
        retryAfterS: null,
        corpo: JSON.stringify(ECO_ENVIO),
      } satisfies ChamadaLi,
    ]);
  });

  it('never carries a request header or the request body', async () => {
    const { c, eventos } = cliente(mockFetch(() => texto('', 204)));
    await c.enviarEscritaLi(put());
    const evento = JSON.stringify(eventos[0]);
    expect(evento).not.toMatch(/authorization|Basic |content-type/i);
    expect(evento).not.toContain(OBJETO);
  });

  it('⚠️ an observer that throws rejects even a write that LANDED — the documented exception', async () => {
    // No generic catch may swallow it (rule 6), so a write client's observer
    // must be total: the app's write engine is to pin that of its own.
    const doObservador = new RangeError('observador quebrado');
    const f = ok();
    const { c } = cliente(f, {
      onChamada: () => {
        throw doObservador;
      },
    });
    await expect(c.enviarEscritaLi(put())).rejects.toBe(doObservador);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('lerAntesDeEscreverLi — the GET a write decides on', () => {
  const PEDIDO = { numero: 165, situacao: { codigo: 'pedido_pago' }, cliente: { nome: 'X' } };

  it('is a GET with no body, no Content-Type, `redirect: "manual"`', async () => {
    const f = mockFetch(() => json(PEDIDO));
    await cliente(f).c.lerAntesDeEscreverLi(get());
    const { url, init, headers } = requisicao(f);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe('manual');
    expect(headers.has('content-type')).toBe(false);
    expect(url.href).toBe(`${URL_BASE_LI}${CAMINHO_GET}`);
  });

  it('returns the parsed data AND the body text with the token scrubbed', async () => {
    const corpo = { ...PEDIDO, eco: TOKEN };
    const { c, eventos } = cliente(mockFetch(() => json(corpo)));
    const r = await c.lerAntesDeEscreverLi(get());
    expect(r.status).toBe(200);
    expect(r.correlationId).toBe('corr-1');
    expect(r.refCredencial).toBe('ref-A');
    expect(r.texto).toBe(JSON.stringify(corpo).replaceAll(TOKEN, TOKEN_REMOVIDO));
    expect(r.texto).not.toContain(TOKEN);
    // The scrub never rewrites the data the caller decides on.
    expect((r.dados as Record<string, unknown>).eco).toBe(TOKEN);
    expect(eventos.map((e) => [e.metodo, e.resultado])).toEqual([['GET', 'ok']]);
  });

  it('a body that fails its schema THROWS (a write must not decide on it), naming GET', async () => {
    const err = await falha(
      cliente(mockFetch(() => json({ numero: 'x' }))).c.lerAntesDeEscreverLi(get()),
    );
    expect(err).toBeInstanceOf(LiSchemaError);
    expect((err as Error).message).toContain('(GET /v1/pedido/165/)');
  });

  it.each<[number, new (...a: never[]) => LiError]>([
    [302, LiHttpError],
    [401, LiAuthError],
    [403, LiAuthError],
    [404, LiNotFoundError],
    [429, LiThrottleError],
    [503, LiHttpError],
  ])('HTTP %i classifies as any GET', async (status, classe) => {
    const err = await falha(
      cliente(mockFetch(() => texto('', status))).c.lerAntesDeEscreverLi(get()),
    );
    expect(err).toBeInstanceOf(classe);
    expect((err as Error).message).toContain('GET /v1/pedido/165/');
  });

  it('a 2xx cut mid-body is a LiNetworkError — a read is never "resolved" without its data', async () => {
    const err = await falha(
      cliente(corpoQueQuebra(200, new TypeError('terminated'))).c.lerAntesDeEscreverLi(get()),
    );
    expect(err).toBeInstanceOf(LiNetworkError);
  });

  describe('its deadline', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('is the READ budget', async () => {
      const { c } = cliente(fetchQueTravaNoCorpo());
      const { estado, pronto } = observar(c.lerAntesDeEscreverLi(get()));
      await vi.advanceTimersByTimeAsync(PRAZO_LI_MS.leitura);
      await pronto;
      expect(estado.valor).toBeInstanceOf(LiTimeoutError);
      expect((estado.valor as LiTimeoutError).prazoMs).toBe(PRAZO_LI_MS.leitura);
    });
  });
});

describe('each verb waits on ITS class’s budget — a PUT the write one, a GET the read one', () => {
  // Both budgets are 20 s today, so a core that used the wrong class would pass
  // every other deadline test. Here they are set apart for the duration of each
  // test, and restored.
  const ORIGINAL = { ...PRAZO_LI_MS };
  const mutavel = PRAZO_LI_MS as { leitura: number; escrita: number };

  beforeEach(() => {
    vi.useFakeTimers();
    mutavel.leitura = 9_000;
    mutavel.escrita = 4_000;
  });
  afterEach(() => {
    mutavel.leitura = ORIGINAL.leitura;
    mutavel.escrita = ORIGINAL.escrita;
    vi.useRealTimers();
  });

  it('a PUT times out at PRAZO_LI_MS.escrita, never at the read budget', async () => {
    const { c } = cliente(fetchQueNuncaResponde());
    const { estado, pronto } = observar(c.enviarEscritaLi(put()));
    await vi.advanceTimersByTimeAsync(3_999);
    expect(estado.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pronto;
    expect(estado.valor).toBeInstanceOf(LiTimeoutError);
    expect((estado.valor as LiTimeoutError).prazoMs).toBe(4_000);
  });

  it('a 2xx PUT whose body stalls resolves "falhou" at the write budget', async () => {
    const { c } = cliente(travaNoCorpo(200));
    const { estado, pronto } = observar(c.enviarEscritaLi(put()));
    await vi.advanceTimersByTimeAsync(3_999);
    expect(estado.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pronto;
    expect(estado.valor).toMatchObject({ status: 200, leituraEco: 'falhou' });
  });

  it('the write client’s GET times out at PRAZO_LI_MS.leitura, never at the write budget', async () => {
    const { c } = cliente(fetchQueNuncaResponde());
    const { estado, pronto } = observar(c.lerAntesDeEscreverLi(get()));
    await vi.advanceTimersByTimeAsync(8_999);
    expect(estado.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pronto;
    expect(estado.valor).toBeInstanceOf(LiTimeoutError);
    expect((estado.valor as LiTimeoutError).prazoMs).toBe(9_000);
  });

  it('the read client’s GET times out at PRAZO_LI_MS.leitura too', async () => {
    const leitura = criarClienteLeituraLi({
      obterCredencial: () => ({ token: TOKEN, ref: 'r' }),
      fetch: fetchQueNuncaResponde(),
    });
    const { estado, pronto } = observar(leitura.get(get()));
    await vi.advanceTimersByTimeAsync(9_000);
    await pronto;
    expect((estado.valor as LiTimeoutError).prazoMs).toBe(9_000);
  });
});

describe('the default fetch', () => {
  it('is resolved at call time from globalThis', async () => {
    const f = ok();
    vi.stubGlobal('fetch', f);
    try {
      await criarClienteEscritaLi({
        obterCredencial: () => ({ token: TOKEN, ref: 'r' }),
      }).enviarEscritaLi(put());
      expect(f).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('verificarMetodos — the shape guard of this file is not vacuous', () => {
  it.each<[string, RequestInit]>([
    ['a GET with a body', { method: 'GET', body: '{}', redirect: 'manual' }],
    [
      'a GET with a Content-Type',
      { method: 'GET', redirect: 'manual', headers: { 'content-type': 'application/json' } },
    ],
    ['a PUT without Content-Type', { method: 'PUT', body: '{}', redirect: 'manual' }],
    [
      'a PUT that follows redirects',
      {
        method: 'PUT',
        body: '{}',
        redirect: 'follow',
        headers: { 'content-type': 'application/json' },
      },
    ],
    [
      'a PUT whose body is not one JSON object',
      {
        method: 'PUT',
        body: '[1]',
        redirect: 'manual',
        headers: { 'content-type': 'application/json' },
      },
    ],
    ['a DELETE', { method: 'DELETE', redirect: 'manual' }],
  ])('refuses %s', async (_rotulo, init) => {
    await mockFetch(() => texto('', 204))(URL_BASE_LI, init);
    expect(verificarMetodos(['GET', 'PUT'])).toThrow();
  });

  it('refuses a PUT where only GET is allowed', async () => {
    await mockFetch(() => texto('', 204))(URL_BASE_LI, {
      method: 'PUT',
      body: '{}',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
    });
    expect(verificarMetodos(['GET'])).toThrow();
  });

  it('accepts the two shapes this package sends', async () => {
    await mockFetch(() => texto('', 204))(URL_BASE_LI, { method: 'GET', redirect: 'manual' });
    await mockFetch(() => texto('', 204))(URL_BASE_LI, {
      method: 'PUT',
      body: '{"objeto":"x"}',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
    });
    expect(verificarMetodos(['GET', 'PUT'])).not.toThrow();
  });
});
