import { centavosDeReais } from '@delfrance/core/money';
import {
  type EnvioPrecoLi,
  FORMA_PROMO_LIMPA_LI,
  type FormaPromoLimpaLi,
  promocionalLimpoNaFormaLi,
  valorPrecoLi,
} from '@delfrance/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { criarClienteLeituraLi, type OpcoesClienteLi, URL_BASE_LI } from '../src/client';
import { criarClienteEscritaLi, type LiEscritaClient, type PedidoPutLi } from '../src/escrita';
import { LiConfigError, LiHttpError } from '../src/errors';
import * as barril from '../src/index';
import {
  atualizarPrecoProdutoLi,
  type CorpoPrecoProdutoLi,
  corpoPrecoProdutoLi,
  corpoPrecoProdutoValidoLi,
  custoEcoavelLi,
  type EntradaPrecoProdutoLi,
  precoDeEscritaValidoLi,
} from '../src/precoEscrita';
import * as rotas from '../src/rotasEscrita';
import { liEcoPrecoProdutoSchema } from '../src/types';
import {
  precoEcoExemplo,
  precoPutCorpoExemplo,
  precoPutCorpoSemSobConsultaExemplo,
} from './_fixtures/especificacao';
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
 * The price write (`precoEscrita.ts`) and its write route (`rotasEscrita.ts`),
 * over `mockFetch` only. Every id is a small synthetic one (`1001`), no real
 * store's; the echo is the public document's `PUT` example, its ids replaced.
 * Nothing here reaches Loja Integrada — every client gets a stub `fetch`, the
 * global one throws for the whole file, and the `afterEach` asserts the exact
 * shape of every request made.
 */

const fetchGlobal = vi.fn(() => {
  throw new Error('fetch global chamado num teste da escrita de preço');
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
const CAMINHO = '/v1/produto_preco/1001';

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

const ok = () => mockFetch(() => json(precoEcoExemplo));
const semCorpo = () => mockFetch(() => texto('', 204));

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

/** A body the route sends: no custo, the clear as `null`. */
const SEM_CUSTO = { cheio: 10, promocional: null, sob_consulta: false } as const;
/** A body the route sends, with the store's custo echoed. */
const COM_CUSTO = { cheio: 10, custo: 4.5, promocional: 9.99, sob_consulta: false } as const;

/** The two strict shapes of the price route, which every leaf rule below runs over. */
const FORMAS_DO_CORPO = [
  ['without custo', SEM_CUSTO],
  ['beside a custo', COM_CUSTO],
] as const;

/** A leaf value that means "the key is absent". */
const AUSENTE = Symbol('ausente');

/** `base` with `folhas` laid over it; a leaf set to {@link AUSENTE} drops the key. */
function com(base: object, folhas: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({ ...base, ...folhas }).filter(([, v]) => v !== AUSENTE),
  );
}

/** The operation's inputs for the clear under the default forma, no custo: `SEM_CUSTO` once built. */
const ENTRADA: EntradaPrecoProdutoLi = {
  alvo: { cheioCentavos: 1000, promo: 'limpar' },
  formaPromoLimpa: FORMA_PROMO_LIMPA_LI.nulo,
  custo: null,
  sobConsulta: false,
};

const FORMAS: readonly FormaPromoLimpaLi[] = [
  FORMA_PROMO_LIMPA_LI.nulo,
  FORMA_PROMO_LIMPA_LI.zero,
  FORMA_PROMO_LIMPA_LI.igualCheio,
];

/** A seeded PRNG (mulberry32): the same cases on every run. */
function prng(semente: number): () => number {
  let a = semente;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -------------------------------------------------------------------------- */

describe('atualizarPrecoProdutoLi — PUT /v1/produto_preco/{produto id}', () => {
  it('sends exactly the full body to the produto path, NO trailing slash, every number unquoted', async () => {
    const f = ok();
    const r = await atualizarPrecoProdutoLi(cliente(f).c, PRODUTO, {
      ...ENTRADA,
      alvo: { cheioCentavos: 27442, promo: 'limpar' },
    });
    const { url, init, headers } = requisicao(f);
    expect(init.method).toBe('PUT');
    expect(url.href).toBe(`${URL_BASE_LI}${CAMINHO}`);
    expect(url.pathname.endsWith('/')).toBe(false);
    expect(headers.get('content-type')).toBe('application/json');
    expect(init.body).toBe('{"cheio":274.42,"promocional":null,"sob_consulta":false}');
    expect(r).toMatchObject({ status: 200, aplicada: 'sim', leituraEco: 'ok' });
  });

  it('with the store’s custo: the four leaves in the document’s order, cheio, custo, promocional, sob_consulta', async () => {
    const f = ok();
    await atualizarPrecoProdutoLi(cliente(f).c, PRODUTO, {
      ...ENTRADA,
      alvo: { cheioCentavos: 27442, promo: { centavos: 19990 } },
      custo: 10.5,
    });
    expect(requisicao(f).init.body).toBe(
      '{"cheio":274.42,"custo":10.5,"promocional":199.9,"sob_consulta":false}',
    );
  });

  it.each<[FormaPromoLimpaLi, string]>([
    [FORMA_PROMO_LIMPA_LI.nulo, 'null'],
    [FORMA_PROMO_LIMPA_LI.zero, '0'],
    [FORMA_PROMO_LIMPA_LI.igualCheio, '274.42'],
  ])('the clear SENT under %j is that forma’s, and no other’s', async (forma, promocional) => {
    const f = semCorpo();
    await atualizarPrecoProdutoLi(cliente(f).c, PRODUTO, {
      ...ENTRADA,
      alvo: { cheioCentavos: 27442, promo: 'limpar' },
      formaPromoLimpa: forma,
      custo: 4.5,
    });
    expect(requisicao(f).init.body).toBe(
      `{"cheio":274.42,"custo":4.5,"promocional":${promocional},"sob_consulta":false}`,
    );
  });

  it('takes the builder’s INPUTS, never a body: a hand-built body with an unconfigured clear does not compile, and is refused at run time', async () => {
    const f = ok();
    const { c, credenciais } = cliente(f);
    // The default forma is `nulo`; this body clears with 0, built by hand.
    const aMao: CorpoPrecoProdutoLi = { cheio: 10, promocional: 0, sob_consulta: false };
    // Anti-vacuity: the route itself WOULD send it, so only the signature keeps it out.
    expect(corpoPrecoProdutoValidoLi(aMao)).toBe(true);
    // @ts-expect-error — a body is not the operation's inputs
    const err = await falha(atualizarPrecoProdutoLi(c, PRODUTO, aMao));
    expect(err).toBeInstanceOf(TypeError);
    expect(f).not.toHaveBeenCalled();
    expect(credenciais()).toBe(0);
  });

  it('a number and its canonical decimal text name the same product', async () => {
    const f = semCorpo();
    const { c } = cliente(f);
    await atualizarPrecoProdutoLi(c, PRODUTO, ENTRADA);
    await atualizarPrecoProdutoLi(c, '1001', ENTRADA);
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
    '1/2',
    '1e3',
    '1001.0',
  ])(
    'a produto id of %j → LiConfigError("caminho"); nothing fetched, no credential read',
    async (id) => {
      const f = ok();
      const { c, credenciais } = cliente(f);
      const err = await falha(atualizarPrecoProdutoLi(c, id, ENTRADA));
      expect(err).toBeInstanceOf(LiConfigError);
      expect(err).toMatchObject({ motivo: 'caminho', operacao: 'atualizarPrecoProduto' });
      expect(f).not.toHaveBeenCalled();
      expect(credenciais()).toBe(0);
    },
  );

  it('a body the route refuses names the price write as its operation (a sob_consulta cast past the type)', async () => {
    const f = ok();
    const { c, credenciais } = cliente(f);
    const naoNarrado = 'false' as unknown as boolean;
    const err = await falha(
      atualizarPrecoProdutoLi(c, PRODUTO, { ...ENTRADA, sobConsulta: naoNarrado }),
    );
    expect(err).toBeInstanceOf(LiConfigError);
    expect(err).toMatchObject({ motivo: 'corpo', operacao: 'atualizarPrecoProduto' });
    expect(f).not.toHaveBeenCalled();
    expect(credenciais()).toBe(0);
  });

  it.each([0, -1, 1.5])(
    'a target of %j full-price centavos is the builder’s RangeError; nothing fetched, no credential read',
    async (cheioCentavos) => {
      const f = ok();
      const { c, credenciais } = cliente(f);
      const err = await falha(
        atualizarPrecoProdutoLi(c, PRODUTO, {
          ...ENTRADA,
          alvo: { cheioCentavos, promo: 'limpar' },
        }),
      );
      expect(err).toBeInstanceOf(RangeError);
      expect(f).not.toHaveBeenCalled();
      expect(credenciais()).toBe(0);
    },
  );

  it('a 3xx fails VISIBLY: a LiHttpError, never followed', async () => {
    const f = mockFetch(() => texto('', 301, { location: `${CAMINHO}/` }));
    const err = await falha(atualizarPrecoProdutoLi(cliente(f).c, PRODUTO, ENTRADA));
    expect(err).toBeInstanceOf(LiHttpError);
    expect((err as LiHttpError).status).toBe(301);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a 202 is reported pending, never applied', async () => {
    const r = await atualizarPrecoProdutoLi(
      cliente(mockFetch(() => texto('', 202))).c,
      PRODUTO,
      ENTRADA,
    );
    expect(r).toMatchObject({ status: 202, aplicada: 'pendente', eco: null, leituraEco: 'vazio' });
  });

  it('the public document’s echo reads whole, its amounts as text', async () => {
    const r = await atualizarPrecoProdutoLi(cliente(ok()).c, 2301, ENTRADA);
    expect(r).toMatchObject({ aplicada: 'sim', leituraEco: 'ok' });
    expect(r.eco).toEqual(precoEcoExemplo);
    expect(r.eco?.cheio).toBe('32.84');
  });

  it('an echo with no leaf still reads; an unreadable one is REPORTED, never thrown', async () => {
    const vazio = await atualizarPrecoProdutoLi(
      cliente(mockFetch(() => json({ id: 7201 }))).c,
      PRODUTO,
      ENTRADA,
    );
    expect(vazio).toMatchObject({ leituraEco: 'ok', eco: { id: 7201 } });
    const lista = await atualizarPrecoProdutoLi(
      cliente(mockFetch(() => json([1]))).c,
      PRODUTO,
      ENTRADA,
    );
    expect(lista).toMatchObject({ status: 200, aplicada: 'sim', eco: null, leituraEco: 'formato' });
    const html = await atualizarPrecoProdutoLi(
      cliente(mockFetch(() => texto('<html>ok</html>', 200))).c,
      PRODUTO,
      ENTRADA,
    );
    expect(html).toMatchObject({ aplicada: 'sim', eco: null, leituraEco: 'nao-json' });
  });

  it('forwards the caller signal: already aborted ⇒ nothing sent, its reason comes back', async () => {
    const controller = new AbortController();
    controller.abort(new RangeError('motivo do chamador'));
    const f = ok();
    await expect(
      atualizarPrecoProdutoLi(cliente(f).c, PRODUTO, ENTRADA, { sinal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
    expect(f).not.toHaveBeenCalled();
  });

  it('takes the WRITE client only (compile-time)', () => {
    const leitura = criarClienteLeituraLi({ obterCredencial: () => ({ token: TOKEN, ref: 'r' }) });
    // Never invoked: the point is that it does not compile.
    const naoCompila = () =>
      // @ts-expect-error — a read client cannot write
      atualizarPrecoProdutoLi(leitura, PRODUTO, ENTRADA);
    expect(typeof naoCompila).toBe('function');
  });
});

/* -------------------------------------------------------------------------- */

describe('the price route — what ANY holder of a write client can send', () => {
  /** Leaf values the route SENDS, on BOTH strict shapes. */
  const FOLHAS_ENVIADAS: readonly [string, Readonly<Record<string, unknown>>][] = [
    ['the clear as null (the default)', { promocional: null }],
    ['the clear as 0', { promocional: 0 }],
    ['a positive promotion', { promocional: 9.99 }],
    ['a promotion equal to the full price', { promocional: 10 }],
    ['a promotion above the full price (sent literally)', { promocional: 11 }],
    ['the smallest full price', { cheio: 0.01 }],
    ['sob_consulta true', { sob_consulta: true }],
  ];

  /** Leaf values the route REFUSES, on BOTH strict shapes ({@link AUSENTE}: the key dropped). */
  const FOLHAS_RECUSADAS: readonly [string, Readonly<Record<string, unknown>>][] = [
    ['cheio 0', { cheio: 0 }],
    ['cheio -0', { cheio: -0 }],
    ['cheio -1', { cheio: -1 }],
    ['cheio 274.425 (a third decimal place)', { cheio: 274.425 }],
    ['cheio 0.1 + 0.2 (float residue)', { cheio: 0.1 + 0.2 }],
    ['cheio quoted', { cheio: '274.42' }],
    ['cheio NaN', { cheio: Number.NaN }],
    ['cheio Infinity', { cheio: Number.POSITIVE_INFINITY }],
    ['cheio null', { cheio: null }],
    ['no cheio', { cheio: AUSENTE }],
    ['cheio whose centavos are past a safe integer', { cheio: 1e14 }],
    ['cheio the largest safe integer of reais', { cheio: Number.MAX_SAFE_INTEGER }],
    ['promocional -1', { promocional: -1 }],
    ['promocional -0.01', { promocional: -0.01 }],
    ['promocional 0.001', { promocional: 0.001 }],
    ['promocional 19.999', { promocional: 19.999 }],
    ['promocional "0"', { promocional: '0' }],
    ['promocional "0.00"', { promocional: '0.00' }],
    ['promocional "0.0000"', { promocional: '0.0000' }],
    ['promocional false', { promocional: false }],
    ['promocional NaN', { promocional: Number.NaN }],
    ['no promocional', { promocional: AUSENTE }],
    ['no sob_consulta', { sob_consulta: AUSENTE }],
    ['sob_consulta "false"', { sob_consulta: 'false' }],
    ['sob_consulta 0', { sob_consulta: 0 }],
    ['sob_consulta null', { sob_consulta: null }],
    ['an extra preco_cheio', { preco_cheio: 10 }],
    ['an extra id', { id: 7201 }],
    ['an extra produto', { produto: '/api/v1/produto/1001' }],
    ['an extra numeric key', { 1: 1 }],
    ['an extra key', { extra: 'x' }],
  ];

  it.each<[string, unknown]>([
    ...FORMAS_DO_CORPO.map(([forma, base]): [string, unknown] => [`the body ${forma}`, base]),
    ...FORMAS_DO_CORPO.flatMap(([forma, base]) =>
      FOLHAS_ENVIADAS.map(([caso, folhas]): [string, unknown] => [
        `${caso}, ${forma}`,
        com(base, folhas),
      ]),
    ),
    ['a custo of 0', { ...COM_CUSTO, custo: 0 }],
    [
      'a custo with four decimals (the two-decimal rule binds only the prices)',
      { ...COM_CUSTO, custo: 12.3456 },
    ],
    ['the public document’s request example', precoPutCorpoExemplo],
  ])('EQUAL side: %s IS sent', async (_caso, corpo) => {
    const f = semCorpo();
    await cliente(f).c.enviarEscritaLi(put(CAMINHO, corpo));
    expect(f).toHaveBeenCalledTimes(1);
    expect(JSON.parse(requisicao(f).init.body as string)).toEqual(corpo);
  });

  it.each<[string, unknown]>([
    ...FORMAS_DO_CORPO.flatMap(([forma, base]) =>
      FOLHAS_RECUSADAS.map(([caso, folhas]): [string, unknown] => [
        `${caso}, ${forma}`,
        com(base, folhas),
      ]),
    ),
    ['custo null', { ...COM_CUSTO, custo: null }],
    ['custo quoted', { ...COM_CUSTO, custo: '10.50' }],
    ['custo the store’s zero text', { ...COM_CUSTO, custo: '0.0000' }],
    ['custo -0.01', { ...COM_CUSTO, custo: -0.01 }],
    ['custo NaN', { ...COM_CUSTO, custo: Number.NaN }],
    ['an extra preco_custo beside a custo', { ...COM_CUSTO, preco_custo: 4.5 }],
    [
      'the document’s id_externo example (no sob_consulta: every price write is full)',
      precoPutCorpoSemSobConsultaExemplo,
    ],
    [
      'the stock body',
      { gerenciado: true, quantidade: 5, situacao_em_estoque: 0, situacao_sem_estoque: -1 },
    ],
    ['the envio body', { objeto: 'AB123' }],
    ['the situação body', { codigo: 'pedido_enviado' }],
    ['an empty object', {}],
    ['null', null],
  ])(
    '%s on the price route → LiConfigError("corpo"); nothing fetched, no credential read',
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

  it('a price body on the STOCK route → LiConfigError("corpo"); nothing fetched', async () => {
    const f = ok();
    const err = await falha(
      cliente(f).c.enviarEscritaLi(put('/v1/produto_estoque/1001', SEM_CUSTO)),
    );
    expect((err as LiConfigError).motivo).toBe('corpo');
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    ['a trailing slash', `${CAMINHO}/`],
    ['a leading-zero id', '/v1/produto_preco/01001'],
    ['a zero id', '/v1/produto_preco/0'],
    ['the by-id read’s path', '/v1/produto_preco/set/1001'],
    ['the list path', '/v1/produto_preco'],
    ['the list path with a slash', '/v1/produto_preco/'],
    ['two ids', '/v1/produto_preco/1001;1002'],
    ['an exponent id', '/v1/produto_preco/1e3'],
    ['trailing junk on the id', '/v1/produto_preco/1001x'],
    ['a fractional id', '/v1/produto_preco/1001.0'],
    ['the produto detail', '/v1/produto/1001/'],
    ['a path that only ENDS like the route', '/v1/pedido/1/v1/produto_preco/1001'],
  ])(
    '%s → LiConfigError("rota-nao-permitida"); nothing fetched, no credential read',
    async (_caso, caminho) => {
      const f = ok();
      const { c, credenciais } = cliente(f);
      const err = await falha(c.enviarEscritaLi(put(caminho, SEM_CUSTO)));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('rota-nao-permitida');
      expect(f).not.toHaveBeenCalled();
      expect(credenciais()).toBe(0);
    },
  );

  it('the body is the route schema’s OUTPUT: its key order, never the caller’s', async () => {
    const f = semCorpo();
    const embaralhado = { sob_consulta: false, promocional: 199.9, custo: 10.5, cheio: 274.42 };
    const esperado = '{"cheio":274.42,"custo":10.5,"promocional":199.9,"sob_consulta":false}';
    // Anti-vacuity: serialising the caller's object would give another text.
    expect(JSON.stringify(embaralhado)).not.toBe(esperado);
    await cliente(f).c.enviarEscritaLi(put(CAMINHO, embaralhado));
    expect(requisicao(f).init.body).toBe(esperado);
  });

  it('…and never the caller’s own toJSON', async () => {
    const f = semCorpo();
    const corpo = { ...SEM_CUSTO };
    Object.defineProperty(corpo, 'toJSON', {
      value: () => ({ ...SEM_CUSTO, cheio: '10', extra: 'CHAVE-QUE-NAO-PODE-IR' }),
      enumerable: false,
    });
    // Anti-vacuity: serialising the caller's object WOULD quote the price and carry the key.
    expect(JSON.stringify(corpo)).toContain('CHAVE-QUE-NAO-PODE-IR');
    await cliente(f).c.enviarEscritaLi(put(CAMINHO, corpo));
    expect(requisicao(f).init.body).toBe('{"cheio":10,"promocional":null,"sob_consulta":false}');
  });

  it('a negative-zero promotion goes out as 0', async () => {
    const f = semCorpo();
    await cliente(f).c.enviarEscritaLi(put(CAMINHO, { ...SEM_CUSTO, promocional: -0 }));
    expect(requisicao(f).init.body).toBe('{"cheio":10,"promocional":0,"sob_consulta":false}');
  });
});

/* -------------------------------------------------------------------------- */

describe('the predicates read the route’s own schemas', () => {
  it.each([0.01, 1, 10, 274.42, 199.9, 1e13])('EQUAL side: %j is a sendable price', (v) => {
    expect(precoDeEscritaValidoLi(v)).toBe(true);
  });

  it.each<unknown>([
    0,
    -0,
    -1,
    274.425,
    0.1 + 0.2,
    1e14,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '10',
    null,
  ])('NEAR-MISS side: %j is NOT a sendable price', (v) => {
    expect(precoDeEscritaValidoLi(v)).toBe(false);
  });

  it.each([0, 4.5, 12.3456])('EQUAL side: %j is an echoable custo', (v) => {
    expect(custoEcoavelLi(v)).toBe(true);
  });

  it.each<unknown>([null, undefined, '10.50', '0.0000', 'REDACTED', -0.01, Number.NaN])(
    'NEAR-MISS side: %j is NOT an echoable custo',
    (v) => {
      expect(custoEcoavelLi(v)).toBe(false);
    },
  );

  it('a body is valid exactly when the route would send it', () => {
    expect(corpoPrecoProdutoValidoLi(SEM_CUSTO)).toBe(true);
    expect(corpoPrecoProdutoValidoLi(COM_CUSTO)).toBe(true);
    expect(corpoPrecoProdutoValidoLi({ ...COM_CUSTO, promocional: null })).toBe(true);
    expect(corpoPrecoProdutoValidoLi({ ...COM_CUSTO, custo: null })).toBe(false);
    expect(corpoPrecoProdutoValidoLi(precoPutCorpoSemSobConsultaExemplo)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('the token never rides a price body either', () => {
  // A token of digits is the one kind a price body can carry: a price.
  const TOKEN_DE_DIGITOS = '424242';

  it('a full price whose JSON text is the token → LiConfigError("token-no-corpo"), nothing sent', async () => {
    const f = ok();
    const { c } = cliente(f, {
      obterCredencial: () => ({ token: TOKEN_DE_DIGITOS, ref: 'ref-A' }),
    });
    const err = await falha(
      atualizarPrecoProdutoLi(c, PRODUTO, {
        ...ENTRADA,
        alvo: { cheioCentavos: 42_424_200, promo: 'limpar' },
      }),
    );
    expect(err).toBeInstanceOf(LiConfigError);
    expect((err as LiConfigError).motivo).toBe('token-no-corpo');
    for (const m of mensagensDaCadeia(err)) expect(m).not.toContain(TOKEN_DE_DIGITOS);
    expect(f).not.toHaveBeenCalled();
  });

  it('near-miss: a full price that only shares digits with the token IS sent', async () => {
    const f = semCorpo();
    const { c } = cliente(f, {
      obterCredencial: () => ({ token: TOKEN_DE_DIGITOS, ref: 'ref-A' }),
    });
    await atualizarPrecoProdutoLi(c, PRODUTO, {
      ...ENTRADA,
      alvo: { cheioCentavos: 424_242, promo: 'limpar' },
    });
    expect(requisicao(f).init.body).toBe(
      '{"cheio":4242.42,"promocional":null,"sob_consulta":false}',
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('corpoPrecoProdutoLi — the body of one price write', () => {
  const LIMPAR: EnvioPrecoLi = { cheioCentavos: 27442, promo: 'limpar' };
  const PROMO: EnvioPrecoLi = { cheioCentavos: 27442, promo: { centavos: 19990 } };

  function montar(
    alvo: EnvioPrecoLi,
    formaPromoLimpa: FormaPromoLimpaLi,
    custo: unknown = null,
    sobConsulta = false,
  ) {
    return corpoPrecoProdutoLi({ alvo, formaPromoLimpa, custo, sobConsulta });
  }

  it.each<[FormaPromoLimpaLi, number | null]>([
    [FORMA_PROMO_LIMPA_LI.nulo, null],
    [FORMA_PROMO_LIMPA_LI.zero, 0],
    [FORMA_PROMO_LIMPA_LI.igualCheio, 274.42],
  ])('the clear under %j is %j — and nothing else', (forma, esperado) => {
    const { corpo } = montar(LIMPAR, forma);
    expect(corpo).toEqual({ cheio: 274.42, promocional: esperado, sob_consulta: false });
    // No forma ever emits another's clear.
    const outros = FORMAS.filter((f) => f !== forma).map(
      (f) => montar(LIMPAR, f).corpo.promocional,
    );
    expect(outros).not.toContain(esperado);
  });

  it('a positive promotion is the same under every forma', () => {
    for (const forma of FORMAS) {
      expect(montar(PROMO, forma).corpo, forma).toEqual({
        cheio: 274.42,
        promocional: 199.9,
        sob_consulta: false,
      });
    }
  });

  it('custo null ⇒ the key is OMITTED (`omitido-nulo`), never sent as null', () => {
    const r = montar(PROMO, FORMA_PROMO_LIMPA_LI.nulo, null);
    expect(r.custo).toBe('omitido-nulo');
    expect(Object.keys(r.corpo)).not.toContain('custo');
    expect(corpoPrecoProdutoValidoLi(r.corpo)).toBe(true);
  });

  it.each([0, 10.5, 12.3456])('custo %j is echoed (`enviado`) — 0 is a custo, kept', (custo) => {
    const r = montar(PROMO, FORMA_PROMO_LIMPA_LI.nulo, custo);
    expect(r.custo).toBe('enviado');
    expect(r.corpo).toEqual({ cheio: 274.42, custo, promocional: 199.9, sob_consulta: false });
  });

  it.each<unknown>(['0.0000', '10.50', 'REDACTED', -1, Number.NaN, undefined, {}])(
    'custo %j cannot be sent: the key is OMITTED (`omitido-ilegivel`), the price still built',
    (custo) => {
      // Called directly: the helper's default would turn an `undefined` custo into `null`.
      const r = corpoPrecoProdutoLi({
        alvo: PROMO,
        formaPromoLimpa: FORMA_PROMO_LIMPA_LI.nulo,
        custo,
        sobConsulta: false,
      });
      expect(r.custo).toBe('omitido-ilegivel');
      expect(Object.keys(r.corpo)).not.toContain('custo');
      expect(corpoPrecoProdutoValidoLi(r.corpo)).toBe(true);
    },
  );

  it('sob_consulta passes through as the caller narrowed it', () => {
    expect(montar(PROMO, FORMA_PROMO_LIMPA_LI.nulo, null, true).corpo.sob_consulta).toBe(true);
    expect(montar(PROMO, FORMA_PROMO_LIMPA_LI.nulo, null, false).corpo.sob_consulta).toBe(false);
  });

  it('the operation sends exactly the body the builder builds from the same inputs', async () => {
    const f = semCorpo();
    const { c } = cliente(f);
    let n = 0;
    for (const forma of FORMAS) {
      for (const alvo of [LIMPAR, PROMO]) {
        for (const custo of [null, 0, 10.5, 'REDACTED']) {
          for (const sobConsulta of [false, true]) {
            const entrada = { alvo, formaPromoLimpa: forma, custo, sobConsulta };
            await atualizarPrecoProdutoLi(c, PRODUTO, entrada);
            const rotulo = JSON.stringify(entrada);
            expect(requisicao(f, n).init.body, rotulo).toBe(
              JSON.stringify(corpoPrecoProdutoLi(entrada).corpo),
            );
            n += 1;
          }
        }
      }
    }
    expect(f).toHaveBeenCalledTimes(48);
    // Anti-vacuity: one fixed case, spelled out.
    expect(requisicao(f, 4).init.body).toBe(
      '{"cheio":274.42,"custo":10.5,"promocional":null,"sob_consulta":false}',
    );
  });

  // Two values past the exact round trip, found by sampling; each fails ONE of the two checks.
  const CENTAVOS_TEXTO_INEXATO = 7985715389251709;
  const CENTAVOS_LEITURA_INEXATA = 3991788387298584;

  it('anti-vacuity: each value past the round trip fails exactly the check it is here for', () => {
    expect(String(CENTAVOS_TEXTO_INEXATO / 100)).not.toBe('79857153892517.09');
    expect(centavosDeReais(CENTAVOS_TEXTO_INEXATO / 100)).toBe(CENTAVOS_TEXTO_INEXATO);
    expect(String(CENTAVOS_LEITURA_INEXATA / 100)).toBe('39917883872985.84');
    expect(centavosDeReais(CENTAVOS_LEITURA_INEXATA / 100)).not.toBe(CENTAVOS_LEITURA_INEXATA);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 53,
    CENTAVOS_TEXTO_INEXATO,
    CENTAVOS_LEITURA_INEXATA,
  ])('full-price centavos %j → RangeError (a target no send may carry)', (cheioCentavos) => {
    for (const forma of FORMAS) {
      expect(() => montar({ cheioCentavos, promo: 'limpar' }, forma)).toThrow(RangeError);
    }
  });

  it.each([0, -5, 1.5, Number.NaN, CENTAVOS_TEXTO_INEXATO])(
    'promotion centavos %j → RangeError',
    (centavos) => {
      expect(() =>
        montar({ cheioCentavos: 27442, promo: { centavos } }, FORMA_PROMO_LIMPA_LI.nulo),
      ).toThrow(RangeError);
    },
  );

  it.each([1, 99, 100, 1_000_000_000_000_000, 999_999_999_999_999])(
    'near-miss: centavos %j are sent exactly',
    (cheioCentavos) => {
      const { corpo } = montar({ cheioCentavos, promo: 'limpar' }, FORMA_PROMO_LIMPA_LI.nulo);
      expect(valorPrecoLi(corpo.cheio)).toEqual({ centavos: cheioCentavos });
    },
  );

  // 6,000 sends through the whole write client: about 2 s alone, but 10.6 s on a
  // loaded CI runner (`CI test`, every workspace testing at once), past the 5 s
  // default. The bound is raised instead of the sweep trimmed, so every case stays.
  it(
    'property: 2,000 targets up to 1e15 centavos × clear or promotion × a drawn custo × every forma round-trip exactly, and are SENT',
    { timeout: 60_000 },
    async () => {
      const aleatorio = prng(27_442);
      /** Log-uniform in [1, 1e15], so every magnitude is sampled. */
      const centavos = () => Math.max(1, Math.floor(10 ** (aleatorio() * 15)));
      /** The store's custo: none (the common case), 0, or a number with up to four decimals. */
      const custoDaLoja = (): number | null => {
        const r = aleatorio();
        if (r < 1 / 3) return null;
        if (r < 2 / 3) return 0;
        return Math.round(aleatorio() * 1e8) / 1e4;
      };
      const f = semCorpo();
      const { c } = cliente(f);
      let enviados = 0;
      for (let caso = 0; caso < 2000; caso++) {
        const cheioCentavos = centavos();
        const promo: EnvioPrecoLi['promo'] =
          aleatorio() < 0.5 ? 'limpar' : { centavos: centavos() };
        const custo = custoDaLoja();
        for (const forma of FORMAS) {
          const { corpo, custo: doCusto } = montar({ cheioCentavos, promo }, forma, custo);
          const rotulo = `${String(cheioCentavos)} ${JSON.stringify(promo)} ${String(custo)} ${forma}`;
          expect(corpoPrecoProdutoValidoLi(corpo), rotulo).toBe(true);
          expect(doCusto, rotulo).toBe(custo === null ? 'omitido-nulo' : 'enviado');
          // The body goes out through the price route, as built.
          await atualizarPrecoProdutoLi(c, PRODUTO, {
            alvo: { cheioCentavos, promo },
            formaPromoLimpa: forma,
            custo,
            sobConsulta: false,
          });
          expect(requisicao(f, enviados).init.body, rotulo).toBe(JSON.stringify(corpo));
          enviados += 1;
          // At most two decimal places on each PRICE sent (the custo goes back as the store holds it).
          for (const preco of [corpo.cheio, corpo.promocional]) {
            const n = String(preco);
            expect(n.split('.')[1]?.length ?? 0, rotulo).toBeLessThanOrEqual(2);
          }
          expect(valorPrecoLi(corpo.cheio), rotulo).toEqual({ centavos: cheioCentavos });
          // The text sent names the same centavos when the store parses it.
          expect(valorPrecoLi(String(corpo.cheio)), rotulo).toEqual({ centavos: cheioCentavos });
          if (promo === 'limpar') {
            expect(
              promocionalLimpoNaFormaLi({
                forma,
                cheio: corpo.cheio,
                promocional: corpo.promocional,
              }),
              rotulo,
            ).toBe(true);
          } else {
            expect(valorPrecoLi(corpo.promocional), rotulo).toEqual({ centavos: promo.centavos });
            expect(valorPrecoLi(String(corpo.promocional)), rotulo).toEqual({
              centavos: promo.centavos,
            });
          }
        }
      }
    },
  );

  it('⚠️ NEAR-MISS: the igual-cheio clear, read under nulo or zero, is NOT a clear', () => {
    const { corpo } = montar(LIMPAR, FORMA_PROMO_LIMPA_LI.igualCheio);
    expect(
      promocionalLimpoNaFormaLi({
        forma: FORMA_PROMO_LIMPA_LI.igualCheio,
        cheio: corpo.cheio,
        promocional: corpo.promocional,
      }),
    ).toBe(true);
    for (const forma of [FORMA_PROMO_LIMPA_LI.nulo, FORMA_PROMO_LIMPA_LI.zero]) {
      expect(
        promocionalLimpoNaFormaLi({ forma, cheio: corpo.cheio, promocional: corpo.promocional }),
        forma,
      ).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('the barrel', () => {
  it('exports the price write, the builder and the predicates, but never the route table', () => {
    expect(barril.atualizarPrecoProdutoLi).toBe(atualizarPrecoProdutoLi);
    expect(barril.corpoPrecoProdutoLi).toBe(corpoPrecoProdutoLi);
    expect(barril.corpoPrecoProdutoValidoLi).toBe(rotas.corpoPrecoProdutoValidoLi);
    expect(barril.custoEcoavelLi).toBe(rotas.custoEcoavelLi);
    expect(barril.precoDeEscritaValidoLi).toBe(rotas.precoDeEscritaValidoLi);
    expect(barril.liEcoPrecoProdutoSchema).toBe(liEcoPrecoProdutoSchema);
    expect(Object.keys(barril)).not.toContain('rotaDeEscritaLi');
    // Anti-vacuity: the route table's reader is real, and finds the price route.
    expect(rotas.rotaDeEscritaLi(CAMINHO)).not.toBeNull();
    expect(rotas.rotaDeEscritaLi(`${CAMINHO}/`)).toBeNull();
    const tipado: CorpoPrecoProdutoLi = SEM_CUSTO;
    expect(corpoPrecoProdutoValidoLi(tipado)).toBe(true);
    const entrada: barril.EntradaPrecoProdutoLi = ENTRADA;
    expect(barril.corpoPrecoProdutoLi(entrada).corpo).toEqual(SEM_CUSTO);
  });
});
