import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { criarClienteLeituraLi, type OpcoesClienteLi, URL_BASE_LI } from '../src/client';
import { criarClienteEscritaLi, type LiEscritaClient, type PedidoPutLi } from '../src/escrita';
import { LiConfigError, LiHttpError } from '../src/errors';
import {
  atualizarEstoqueProdutoLi,
  ESTOQUE_FIXO_ESCRITA_LI,
  quantidadeDeEstoqueValidaLi,
} from '../src/estoqueEscrita';
import * as barril from '../src/index';
import * as rotas from '../src/rotasEscrita';
import { liEcoEstoqueProdutoSchema } from '../src/types';
import {
  json,
  mensagensDaCadeia,
  mockFetch,
  requisicao,
  TOKEN,
  texto,
  verificarMetodos,
} from './_helpers/mockFetch';

/**
 * The stock write (`estoqueEscrita.ts`) and its write route (`rotasEscrita.ts`),
 * over `mockFetch` only. Every id is a small synthetic one (`1001`), no real
 * store's; the echo is shaped like the public document's `PUT` example. Nothing
 * here reaches Loja Integrada — every client gets a stub `fetch`, the global
 * one throws for the whole file, and the `afterEach` asserts the exact shape of
 * every request made.
 */

const fetchGlobal = vi.fn(() => {
  throw new Error('fetch global chamado num teste da escrita de estoque');
});

beforeEach(() => {
  fetchGlobal.mockClear();
  vi.stubGlobal('fetch', fetchGlobal);
});

const verificarForma = verificarMetodos(['PUT']);

afterEach(() => {
  vi.unstubAllGlobals();
  expect(fetchGlobal).not.toHaveBeenCalled();
  verificarForma();
});

const PRODUTO = 1001;
const CAMINHO = '/v1/produto_estoque/1001';

/** The exact text of a valid stock body for `quantidade`, in the route schema's key order. */
function corpoEsperado(quantidade: number): string {
  return `{"gerenciado":true,"quantidade":${String(quantidade)},"situacao_em_estoque":0,"situacao_sem_estoque":-1}`;
}

/** The echo, shaped like the document's `PUT /v1/produto_estoque/{produto_id}` example. */
function eco(quantidade: number) {
  return {
    gerenciado: true,
    id: 5001,
    produto: '/api/v1/produto/1001',
    quantidade,
    quantidade_disponivel: quantidade,
    quantidade_reservada: 0,
    resource_uri: '/api/v1/produto_estoque/1001',
    situacao_em_estoque: 0,
    situacao_sem_estoque: -1,
  };
}

function cliente(
  fetch: typeof globalThis.fetch,
  extra: Partial<OpcoesClienteLi> = {},
): { c: LiEscritaClient; credenciais: () => number } {
  let pedidas = 0;
  const c = criarClienteEscritaLi({
    obterCredencial: () => {
      pedidas += 1;
      return { token: TOKEN, ref: 'ref-A' };
    },
    fetch,
    gerarCorrelationId: () => 'corr-1',
    agora: () => 0,
    ...extra,
  });
  return { c, credenciais: () => pedidas };
}

const ok = (quantidade = 5) => mockFetch(() => json(eco(quantidade)));

async function falha(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('esperava uma rejeição');
    },
    (e: unknown) => e,
  );
}

const ecoSchema = z.object({}).passthrough();

/** A direct write through the client, past the operation: what the route alone allows. */
function put(caminho: string, corpo: unknown): PedidoPutLi<typeof ecoSchema> {
  return { operacao: 'direto', caminho, corpo, ecoSchema };
}

const CORPO_VALIDO = { ...ESTOQUE_FIXO_ESCRITA_LI, quantidade: 5 };

/* -------------------------------------------------------------------------- */

describe('the fixed leaves and the quantity predicate', () => {
  it('pins the three fixed leaves', () => {
    expect(ESTOQUE_FIXO_ESCRITA_LI).toEqual({
      gerenciado: true,
      situacao_em_estoque: 0,
      situacao_sem_estoque: -1,
    });
  });

  it.each([0, 1, 5, 1_000_000, Number.MAX_SAFE_INTEGER])(
    'EQUAL side: %j is a sendable quantity',
    (valor) => {
      expect(quantidadeDeEstoqueValidaLi(valor)).toBe(true);
    },
  );

  it.each<unknown>([
    -1,
    -2,
    1.5,
    0.1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    '3',
    '0',
    '',
    null,
    undefined,
    true,
    [3],
  ])('NEAR-MISS side: %j is NOT a sendable quantity', (valor) => {
    expect(quantidadeDeEstoqueValidaLi(valor)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('atualizarEstoqueProdutoLi — PUT /v1/produto_estoque/{produto id}', () => {
  it('sends exactly the four leaves to the produto path, NO trailing slash, numbers and the boolean unquoted', async () => {
    const f = ok();
    const r = await atualizarEstoqueProdutoLi(cliente(f).c, PRODUTO, 5);
    const { url, init, headers } = requisicao(f);
    expect(init.method).toBe('PUT');
    expect(url.href).toBe(`${URL_BASE_LI}${CAMINHO}`);
    expect(url.pathname.endsWith('/')).toBe(false);
    expect(headers.get('content-type')).toBe('application/json');
    expect(init.body).toBe(corpoEsperado(5));
    const enviado = JSON.parse(init.body as string) as unknown;
    expect(enviado).toEqual({
      gerenciado: true,
      quantidade: 5,
      situacao_em_estoque: 0,
      situacao_sem_estoque: -1,
    });
    // Unquoted: each leaf travels as its own JSON type, never as text.
    expect((init.body as string).includes('"5"')).toBe(false);
    expect((init.body as string).includes('"-1"')).toBe(false);
    expect((init.body as string).includes('"true"')).toBe(false);
    expect(r).toMatchObject({ status: 200, aplicada: 'sim', leituraEco: 'ok' });
    expect(r.eco).toMatchObject({ quantidade: 5 });
  });

  it.each([0, 1, Number.MAX_SAFE_INTEGER])(
    'near-miss: the boundary quantity %j IS sent, as given',
    async (quantidade) => {
      const f = mockFetch(() => texto('', 204));
      await atualizarEstoqueProdutoLi(cliente(f).c, PRODUTO, quantidade);
      expect(requisicao(f).init.body).toBe(corpoEsperado(quantidade));
    },
  );

  it.each<[string, unknown]>([
    ['-1', -1],
    ['1.5', 1.5],
    ['the text "3"', '3'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['null', null],
  ])(
    'a quantity of %s → LiConfigError("corpo"); nothing fetched, no credential read',
    async (_caso, quantidade) => {
      const f = ok();
      const { c, credenciais } = cliente(f);
      const err = await falha(atualizarEstoqueProdutoLi(c, PRODUTO, quantidade as number));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('corpo');
      expect(f).not.toHaveBeenCalled();
      expect(credenciais()).toBe(0);
    },
  );

  it('a number and its canonical decimal text name the same product', async () => {
    const f = mockFetch(() => texto('', 204));
    const { c } = cliente(f);
    await atualizarEstoqueProdutoLi(c, PRODUTO, 3);
    await atualizarEstoqueProdutoLi(c, '1001', 3);
    expect(requisicao(f, 0).url.pathname).toBe(CAMINHO);
    expect(requisicao(f, 1).url.pathname).toBe(CAMINHO);
  });

  it.each<number | string>([
    0,
    -1,
    1.5,
    Number.NaN,
    2 ** 53,
    '',
    '0',
    '01001',
    '+1001',
    ' 1001',
    '1001 ',
    '1/2',
    '1e3',
    '1001.0',
    '../1001',
  ])('a produto id of %j → LiConfigError("caminho"); nothing fetched', async (id) => {
    const f = ok();
    const { c, credenciais } = cliente(f);
    const err = await falha(atualizarEstoqueProdutoLi(c, id, 5));
    expect(err).toBeInstanceOf(LiConfigError);
    expect((err as LiConfigError).motivo).toBe('caminho');
    expect(f).not.toHaveBeenCalled();
    expect(credenciais()).toBe(0);
  });

  it('a wrong path form fails VISIBLY: a 3xx is a LiHttpError, never followed', async () => {
    const f = mockFetch(() => texto('', 301, { location: `${CAMINHO}/` }));
    const err = await falha(atualizarEstoqueProdutoLi(cliente(f).c, PRODUTO, 5));
    expect(err).toBeInstanceOf(LiHttpError);
    expect((err as LiHttpError).status).toBe(301);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a 202 is reported pending, never applied', async () => {
    const r = await atualizarEstoqueProdutoLi(
      cliente(mockFetch(() => texto('', 202))).c,
      PRODUTO,
      5,
    );
    expect(r).toMatchObject({ status: 202, aplicada: 'pendente', eco: null, leituraEco: 'vazio' });
  });

  it('the echo reads a quoted quantity; an unreadable one is REPORTED, never thrown', async () => {
    const lido = await atualizarEstoqueProdutoLi(
      cliente(mockFetch(() => json({ ...eco(5), quantidade: '5' }))).c,
      PRODUTO,
      5,
    );
    expect(lido.eco).toMatchObject({ quantidade: 5, gerenciado: true });
    const torto = await atualizarEstoqueProdutoLi(
      cliente(mockFetch(() => json({ quantidade: 'cinco' }))).c,
      PRODUTO,
      5,
    );
    expect(torto).toMatchObject({ status: 200, aplicada: 'sim', eco: null, leituraEco: 'formato' });
  });

  it('forwards the caller signal: already aborted ⇒ nothing sent, its reason comes back', async () => {
    const controller = new AbortController();
    controller.abort(new RangeError('motivo do chamador'));
    const f = ok();
    await expect(
      atualizarEstoqueProdutoLi(cliente(f).c, PRODUTO, 5, { sinal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
    expect(f).not.toHaveBeenCalled();
  });

  it('takes the WRITE client only (compile-time)', () => {
    const leitura = criarClienteLeituraLi({ obterCredencial: () => ({ token: TOKEN, ref: 'r' }) });
    // Never invoked: the point is that it does not compile.
    const naoCompila = () =>
      // @ts-expect-error — a read client cannot write
      atualizarEstoqueProdutoLi(leitura, PRODUTO, 5);
    expect(typeof naoCompila).toBe('function');
  });
});

/* -------------------------------------------------------------------------- */

describe('the stock route — what ANY holder of a write client can send', () => {
  it.each([
    ['a trailing slash', `${CAMINHO}/`],
    ['a leading-zero id', '/v1/produto_estoque/01001'],
    ['a zero id', '/v1/produto_estoque/0'],
    ['the list path', '/v1/produto_estoque'],
    ['the list path with a slash', '/v1/produto_estoque/'],
    ['a longer path under the route', `${CAMINHO}/extra`],
    ['a non-numeric id', '/v1/produto_estoque/abc'],
    ['the produto resource', '/v1/produto/1001'],
    ['the price resource', '/v1/produto_preco/1001'],
  ])(
    '%s → LiConfigError("rota-nao-permitida"); nothing fetched, no credential read',
    async (_caso, caminho) => {
      const f = ok();
      const { c, credenciais } = cliente(f);
      const err = await falha(c.enviarEscritaLi(put(caminho, CORPO_VALIDO)));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('rota-nao-permitida');
      expect(f).not.toHaveBeenCalled();
      expect(credenciais()).toBe(0);
    },
  );

  it.each<[string, unknown]>([
    ['quantidade -1', { ...CORPO_VALIDO, quantidade: -1 }],
    ['quantidade 1.5', { ...CORPO_VALIDO, quantidade: 1.5 }],
    ['quantidade "3"', { ...CORPO_VALIDO, quantidade: '3' }],
    ['quantidade NaN', { ...CORPO_VALIDO, quantidade: Number.NaN }],
    ['quantidade null', { ...CORPO_VALIDO, quantidade: null }],
    ['gerenciado false', { ...CORPO_VALIDO, gerenciado: false }],
    ['gerenciado "true"', { ...CORPO_VALIDO, gerenciado: 'true' }],
    ['situacao_sem_estoque 0', { ...CORPO_VALIDO, situacao_sem_estoque: 0 }],
    ['situacao_sem_estoque "-1"', { ...CORPO_VALIDO, situacao_sem_estoque: '-1' }],
    ['situacao_sem_estoque 15', { ...CORPO_VALIDO, situacao_sem_estoque: 15 }],
    ['situacao_em_estoque 5', { ...CORPO_VALIDO, situacao_em_estoque: 5 }],
    ['situacao_em_estoque -1', { ...CORPO_VALIDO, situacao_em_estoque: -1 }],
    ['an extra key', { ...CORPO_VALIDO, extra: 'x' }],
    ['an extra numeric key', { ...CORPO_VALIDO, quantidade_reservada: 0 }],
    ['no quantidade', { ...ESTOQUE_FIXO_ESCRITA_LI }],
    ['no gerenciado', { quantidade: 5, situacao_em_estoque: 0, situacao_sem_estoque: -1 }],
    ['no situacao_em_estoque', { gerenciado: true, quantidade: 5, situacao_sem_estoque: -1 }],
    ['no situacao_sem_estoque', { gerenciado: true, quantidade: 5, situacao_em_estoque: 0 }],
    ['the envio body', { objeto: 'AB123' }],
    ['the situação body', { codigo: 'pedido_enviado' }],
    ['an empty object', {}],
    ['null', null],
    ['a string body', corpoEsperado(5)],
  ])(
    '%s on the stock route → LiConfigError("corpo"); nothing fetched, no credential read',
    async (_caso, corpo) => {
      const f = ok();
      const { c, credenciais } = cliente(f);
      const err = await falha(c.enviarEscritaLi(put(CAMINHO, corpo)));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('corpo');
      expect(f).not.toHaveBeenCalled();
      expect(credenciais()).toBe(0);
    },
  );

  it('near-miss: the valid body IS sent, unquoted', async () => {
    const f = mockFetch(() => texto('', 204));
    await cliente(f).c.enviarEscritaLi(put(CAMINHO, CORPO_VALIDO));
    expect(f).toHaveBeenCalledTimes(1);
    expect(requisicao(f).url.pathname).toBe(CAMINHO);
    expect(requisicao(f).init.body).toBe(corpoEsperado(5));
  });

  it('the body is the route schema’s OUTPUT: its key order, never the caller’s', async () => {
    const f = mockFetch(() => texto('', 204));
    const embaralhado = {
      situacao_sem_estoque: -1,
      quantidade: 5,
      situacao_em_estoque: 0,
      gerenciado: true,
    };
    // Anti-vacuity: serialising the caller's object would give another text.
    expect(JSON.stringify(embaralhado)).not.toBe(corpoEsperado(5));
    await cliente(f).c.enviarEscritaLi(put(CAMINHO, embaralhado));
    expect(requisicao(f).init.body).toBe(corpoEsperado(5));
  });

  it('…and never the caller’s own toJSON', async () => {
    const f = mockFetch(() => texto('', 204));
    const corpo = { ...CORPO_VALIDO };
    Object.defineProperty(corpo, 'toJSON', {
      value: () => ({ ...CORPO_VALIDO, quantidade: '5', extra: 'CHAVE-QUE-NAO-PODE-IR' }),
      enumerable: false,
    });
    // Anti-vacuity: serialising the caller's object WOULD quote the number and carry the key.
    expect(JSON.stringify(corpo)).toContain('CHAVE-QUE-NAO-PODE-IR');
    await cliente(f).c.enviarEscritaLi(put(CAMINHO, corpo));
    expect(requisicao(f).init.body).toBe(corpoEsperado(5));
  });

  it('a negative zero goes out as 0', async () => {
    const f = mockFetch(() => texto('', 204));
    await cliente(f).c.enviarEscritaLi(put(CAMINHO, { ...CORPO_VALIDO, quantidade: -0 }));
    expect(requisicao(f).init.body).toBe(corpoEsperado(0));
  });
});

/* -------------------------------------------------------------------------- */

describe('the token never rides a stock body either', () => {
  // A token of digits is the one kind a stock body can carry: the quantity.
  const TOKEN_DE_DIGITOS = '424242';

  it('a quantity equal to the token → LiConfigError("token-no-corpo"), nothing sent', async () => {
    const f = ok();
    const { c } = cliente(f, {
      obterCredencial: () => ({ token: TOKEN_DE_DIGITOS, ref: 'ref-A' }),
    });
    // Anti-vacuity: the body that would be sent does carry the token.
    expect(corpoEsperado(424242)).toContain(TOKEN_DE_DIGITOS);
    const err = await falha(atualizarEstoqueProdutoLi(c, PRODUTO, 424242));
    expect(err).toBeInstanceOf(LiConfigError);
    expect((err as LiConfigError).motivo).toBe('token-no-corpo');
    expect((err as LiConfigError).refCredencial).toBe('ref-A');
    for (const m of mensagensDaCadeia(err)) expect(m).not.toContain(TOKEN_DE_DIGITOS);
    expect(f).not.toHaveBeenCalled();
  });

  it('near-miss: a quantity that only shares digits with the token IS sent', async () => {
    const f = mockFetch(() => texto('', 204));
    const { c } = cliente(f, {
      obterCredencial: () => ({ token: TOKEN_DE_DIGITOS, ref: 'ref-A' }),
    });
    await atualizarEstoqueProdutoLi(c, PRODUTO, 4242);
    expect(requisicao(f).init.body).toBe(corpoEsperado(4242));
  });

  it('the string routes still refuse the token in their body, after the widening', async () => {
    const f = ok();
    const err = await falha(
      cliente(f).c.enviarEscritaLi(put('/v1/pedido_envio/1001', { objeto: TOKEN })),
    );
    expect((err as LiConfigError).motivo).toBe('token-no-corpo');
    expect(f).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */

describe('every existing route serialises exactly as before', () => {
  it.each<[string, unknown, string]>([
    ['/v1/pedido_envio/1001', { objeto: 'AB123' }, '{"objeto":"AB123"}'],
    ['/v1/situacao/pedido/1001', { codigo: 'pedido_enviado' }, '{"codigo":"pedido_enviado"}'],
    ['/v1/situacao/pedido/1001', { codigo: 'pedido_entregue' }, '{"codigo":"pedido_entregue"}'],
    [
      '/v1/situacao/pedido/1001',
      { codigo: 'pronto_para_retirada' },
      '{"codigo":"pronto_para_retirada"}',
    ],
  ])('%s with %j sends %s', async (caminho, corpo, esperado) => {
    const f = mockFetch(() => texto('', 204));
    await cliente(f).c.enviarEscritaLi(put(caminho, corpo));
    expect(requisicao(f).init.body).toBe(esperado);
  });

  it('a quantity-like value on a string route is still refused: no route coerces', async () => {
    const f = ok();
    const err = await falha(
      cliente(f).c.enviarEscritaLi(put('/v1/pedido_envio/1001', { objeto: 5 })),
    );
    expect((err as LiConfigError).motivo).toBe('corpo');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('the barrel', () => {
  it('exports the stock write, its fixed leaves and its predicate, but never the route table', () => {
    expect(barril.atualizarEstoqueProdutoLi).toBe(atualizarEstoqueProdutoLi);
    expect(barril.ESTOQUE_FIXO_ESCRITA_LI).toBe(rotas.ESTOQUE_FIXO_ESCRITA_LI);
    expect(barril.quantidadeDeEstoqueValidaLi).toBe(rotas.quantidadeDeEstoqueValidaLi);
    expect(barril.liEcoEstoqueProdutoSchema).toBe(liEcoEstoqueProdutoSchema);
    expect(Object.keys(barril)).not.toContain('rotaDeEscritaLi');
    // Anti-vacuity: the route table's reader is real, and finds the stock route.
    expect(rotas.rotaDeEscritaLi(CAMINHO)).not.toBeNull();
    expect(rotas.rotaDeEscritaLi(`${CAMINHO}/`)).toBeNull();
  });
});
