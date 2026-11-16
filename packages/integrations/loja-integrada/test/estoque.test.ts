import * as schemas from '@delfrance/schemas';
import { idDoRecursoLi, RECURSO_URI_LI } from '@delfrance/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { criarClienteLeituraLi, type LiLeituraClient, URL_BASE_LI } from '../src/client';
import {
  LiConfigError,
  LiHttpError,
  LiNotFoundError,
  LiPaginacaoError,
  LiSchemaError,
} from '../src/errors';
import {
  buscarEstoqueProdutoLi,
  CAMINHO_ESTOQUE_LI,
  lerPaginaEstoqueLi,
  MAX_LIMITE_PAGINA_ESTOQUE_LI,
  type OpcoesPaginaEstoqueLi,
  produtoIdDoEstoqueLi,
} from '../src/estoque';
import * as barril from '../src/index';
import {
  liEcoEstoqueProdutoSchema,
  liEstoqueProdutoDetalheSchema,
  liEstoqueProdutoLinhaSchema,
} from '../src/types';
import {
  estoqueDetalheExemplo,
  estoqueEcoExemplo,
  estoquePaginaExemplo,
} from './_fixtures/especificacao';
import { json, mockFetch, requisicao, TOKEN, texto, verificarSoGet } from './_helpers/mockFetch';

/**
 * The stock reads (`estoque.ts`) and the stock row schemas (`types.ts`).
 *
 * Two kinds of row. The public document's own stock examples
 * (`_fixtures/especificacao.ts`: every leaf verbatim, the ids replaced) pin
 * that the schemas read what the document shows. Every other row is INVENTED,
 * shaped like them, with small synthetic ids (`1001`, `5001`) that are no real
 * store's: the owner's stock captures are not in yet. Nothing here reaches Loja
 * Integrada — every client gets a stub `fetch`, the global one throws for the
 * whole file, and the `afterEach` asserts every request was a `GET` with no
 * body.
 */

const fetchGlobal = vi.fn(() => {
  throw new Error('fetch global chamado num teste do estoque');
});

beforeEach(() => {
  fetchGlobal.mockClear();
  vi.stubGlobal('fetch', fetchGlobal);
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(fetchGlobal).not.toHaveBeenCalled();
  verificarSoGet();
});

function cliente(fetch: typeof globalThis.fetch): {
  c: LiLeituraClient;
  credenciais: () => number;
} {
  let n = 0;
  let pedidas = 0;
  const c = criarClienteLeituraLi({
    obterCredencial: () => {
      pedidas += 1;
      return { token: TOKEN, ref: 'ref-A' };
    },
    fetch,
    gerarCorrelationId: () => {
      n += 1;
      return `corr-${String(n)}`;
    },
    agora: () => 0,
  });
  return { c, credenciais: () => pedidas };
}

async function falha(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('esperava uma rejeição');
    },
    (e: unknown) => e,
  );
}

/** One stock row, shaped like the document's examples; ids invented. */
function linha(produtoId: number, extra: Record<string, unknown> = {}) {
  return {
    gerenciado: true,
    id: produtoId + 4000,
    produto: `/api/v1/produto/${String(produtoId)}`,
    quantidade: 7,
    quantidade_disponivel: 7,
    quantidade_reservada: 0,
    resource_uri: `/api/v1/produto_estoque/${String(produtoId)}`,
    situacao_em_estoque: 0,
    situacao_sem_estoque: -1,
    ...extra,
  };
}

/** A stock page: `meta` in the document's shape, `next` as the document writes it. */
function pagina(
  offset: number,
  next: string | null,
  objects: readonly unknown[] = [linha(1001), linha(1002)],
  limit = 50,
) {
  return { meta: { limit, next, offset, previous: null, total_count: 120 }, objects };
}

function umaPagina(f: typeof globalThis.fetch, extra: Partial<OpcoesPaginaEstoqueLi> = {}) {
  return lerPaginaEstoqueLi(cliente(f).c, { offset: 0, limite: 50, ...extra });
}

const ok = (corpo: unknown) => mockFetch(() => json(corpo));

/* -------------------------------------------------------------------------- */

describe('the stock row schema — tolerant integers, a boolean, passthrough', () => {
  it('parses a document-shaped row and keeps every undeclared leaf as received', () => {
    const r = liEstoqueProdutoLinhaSchema.parse({ ...linha(1001), novo: { x: 1 } });
    expect(r).toEqual({ ...linha(1001), novo: { x: 1 } });
  });

  it.each(['quantidade', 'quantidade_reservada', 'situacao_em_estoque', 'situacao_sem_estoque'])(
    'EQUAL: %s as `5` and as `"5"` both read 5',
    (campo) => {
      const numero = liEstoqueProdutoLinhaSchema.parse(linha(1001, { [campo]: 5 }));
      const textual = liEstoqueProdutoLinhaSchema.parse(linha(1001, { [campo]: '5' }));
      expect(numero[campo as keyof typeof numero]).toBe(5);
      expect(textual[campo as keyof typeof textual]).toBe(5);
    },
  );

  it('a negative quantity parses — the document shows `-2` — as a number or its text', () => {
    expect(liEstoqueProdutoLinhaSchema.parse(linha(1001, { quantidade: -2 })).quantidade).toBe(-2);
    expect(liEstoqueProdutoLinhaSchema.parse(linha(1001, { quantidade: '-2' })).quantidade).toBe(
      -2,
    );
    expect(
      liEstoqueProdutoLinhaSchema.parse(linha(1001, { quantidade_reservada: -3 }))
        .quantidade_reservada,
    ).toBe(-3);
  });

  it.each(['quantidade', 'quantidade_reservada', 'situacao_em_estoque', 'situacao_sem_estoque'])(
    'EQUAL: %s as -1 and as "-1" both read -1 — any sign, on every integer leaf',
    (campo) => {
      const numero = liEstoqueProdutoLinhaSchema.parse(linha(1001, { [campo]: -1 }));
      const textual = liEstoqueProdutoLinhaSchema.parse(linha(1001, { [campo]: '-1' }));
      expect(numero[campo as keyof typeof numero]).toBe(-1);
      expect(textual[campo as keyof typeof textual]).toBe(-1);
    },
  );

  it.each(['quantidade', 'quantidade_reservada', 'situacao_em_estoque', 'situacao_sem_estoque'])(
    'NEAR-MISS: %s as 1.5 and as "1.5" refuses the row — never a fraction, on every integer leaf',
    (campo) => {
      expect(liEstoqueProdutoLinhaSchema.safeParse(linha(1001, { [campo]: 1.5 })).success).toBe(
        false,
      );
      expect(liEstoqueProdutoLinhaSchema.safeParse(linha(1001, { [campo]: '1.5' })).success).toBe(
        false,
      );
    },
  );

  it('an UNMANAGED row whose four leaves are all zero parses as it came', () => {
    const r = liEstoqueProdutoLinhaSchema.parse(
      linha(1001, {
        gerenciado: false,
        quantidade: 0,
        quantidade_disponivel: 0,
        quantidade_reservada: 0,
        situacao_em_estoque: 0,
        situacao_sem_estoque: 0,
      }),
    );
    expect(r).toMatchObject({
      gerenciado: false,
      quantidade: 0,
      quantidade_reservada: 0,
      situacao_em_estoque: 0,
      situacao_sem_estoque: 0,
    });
  });

  it.each<[string, unknown]>([
    ['a fraction', 1.5],
    ['a fractional text', '1.5'],
    ['a non-numeric text', 'abc'],
    ['an empty text', ''],
    ['a pt-BR decimal', '1,0'],
    ['null', null],
    ['a boolean', true],
    ['an unsafe integer', 2 ** 53],
  ])('NEAR-MISS: quantidade as %s refuses the row', (_caso, valor) => {
    expect(liEstoqueProdutoLinhaSchema.safeParse(linha(1001, { quantidade: valor })).success).toBe(
      false,
    );
  });

  it.each(['quantidade', 'quantidade_reservada', 'situacao_em_estoque', 'situacao_sem_estoque'])(
    'NEAR-MISS: a row without %s refuses — it cannot be judged',
    (campo) => {
      const semCampo = Object.fromEntries(Object.entries(linha(1001)).filter(([k]) => k !== campo));
      expect(Object.keys(semCampo)).not.toContain(campo);
      expect(liEstoqueProdutoLinhaSchema.safeParse(semCampo).success).toBe(false);
    },
  );

  it.each<[string, unknown]>([
    ['the text "true"', 'true'],
    ['the number 1', 1],
    ['null', null],
    ['absent', undefined],
  ])('NEAR-MISS: gerenciado as %s refuses — it is a boolean', (_caso, valor) => {
    expect(liEstoqueProdutoLinhaSchema.safeParse(linha(1001, { gerenciado: valor })).success).toBe(
      false,
    );
  });

  it.each<[string, unknown]>([
    ['a number', 1001],
    ['null', null],
    ['absent', undefined],
  ])('NEAR-MISS: produto as %s refuses — the row names no produto', (_caso, valor) => {
    expect(liEstoqueProdutoLinhaSchema.safeParse(linha(1001, { produto: valor })).success).toBe(
      false,
    );
  });

  it('the undeclared leaves are never judged: an odd `id` or `quantidade_disponivel` still parses', () => {
    const r = liEstoqueProdutoLinhaSchema.parse(
      linha(1001, { id: 'x', quantidade_disponivel: '1,5', resource_uri: null }),
    );
    expect(r).toMatchObject({ id: 'x', quantidade_disponivel: '1,5', resource_uri: null });
  });

  it('the detail is the row schema under its own name', () => {
    expect(liEstoqueProdutoDetalheSchema).toBe(liEstoqueProdutoLinhaSchema);
  });

  it('the write echo: every field optional, a quoted quantity read, unknown keys kept', () => {
    expect(liEcoEstoqueProdutoSchema.parse({})).toEqual({});
    expect(liEcoEstoqueProdutoSchema.parse({ quantidade: '6', gerenciado: 'x' })).toEqual({
      quantidade: 6,
      gerenciado: 'x',
    });
    expect(liEcoEstoqueProdutoSchema.parse({ quantidade: '' }).quantidade).toBeNull();
    // Near-miss: a quantity that is not one still fails its own leaf.
    expect(liEcoEstoqueProdutoSchema.safeParse({ quantidade: 'abc' }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('the public document’s own stock examples', () => {
  it('every one of the 20 list rows parses, as it came — unmanaged rows, negative quantities and lead times included', () => {
    const { objects } = estoquePaginaExemplo;
    expect(objects).toHaveLength(20);
    // Anti-vacuity: the example does hold the shapes a stricter schema would refuse.
    expect(objects.some((r) => !r.gerenciado)).toBe(true);
    expect(objects.map((r) => r.quantidade).filter((q) => q < 0)).toEqual([-2, -4, -1]);
    expect(
      objects.filter((r) => r.situacao_em_estoque !== 0 || r.situacao_sem_estoque !== -1),
    ).toHaveLength(7);
    for (const r of objects) expect(liEstoqueProdutoLinhaSchema.parse(r)).toEqual(r);
  });

  it('the whole list example reads as ONE page: every row, its meta, the next offset 20', async () => {
    const f = ok(estoquePaginaExemplo);
    const r = await umaPagina(f, { offset: 0, limite: 20 });
    expect(r.ilegiveis).toEqual([]);
    expect(r.linhas).toEqual(estoquePaginaExemplo.objects);
    expect(r.meta).toEqual(estoquePaginaExemplo.meta);
    expect(r.proximoOffset).toBe(20);
  });

  it('every list row names its produto by `produto`, never by its own `id`', () => {
    for (const r of estoquePaginaExemplo.objects) {
      const produtoId = produtoIdDoEstoqueLi(r.produto);
      expect(produtoId).not.toBeNull();
      expect(produtoId).not.toBe(r.id);
      expect(r.resource_uri).toBe(`/api/v1/produto_estoque/${String(produtoId)}`);
    }
  });

  it('the detail example parses with the detail schema, as it came', async () => {
    expect(liEstoqueProdutoDetalheSchema.parse(estoqueDetalheExemplo)).toEqual(
      estoqueDetalheExemplo,
    );
    const r = await buscarEstoqueProdutoLi(cliente(ok(estoqueDetalheExemplo)).c, 2101);
    expect(r.dados).toEqual(estoqueDetalheExemplo);
    expect(produtoIdDoEstoqueLi(r.dados.produto)).toBe(2101);
  });

  it('the PUT echo example parses with the echo schema, its other lead times kept as received', () => {
    expect(liEcoEstoqueProdutoSchema.parse(estoqueEcoExemplo)).toEqual(estoqueEcoExemplo);
  });
});

/* -------------------------------------------------------------------------- */

describe('produtoIdDoEstoqueLi — the produto a stock row names', () => {
  it.each(['/api/v1/produto/123', '/api/v1/produto/123/', '/v1/produto/123', '/v1/produto/123/'])(
    'EQUAL: %j ⇒ 123',
    (uri) => {
      expect(produtoIdDoEstoqueLi(uri)).toBe(123);
    },
  );

  it.each<unknown>([
    '/api/v1/produto/0123',
    '/api/v1/produto/12/3',
    '/api/v1/produto/123x',
    '/api/v1/produto/123//',
    '/api/v1/produto/123?id_externo=1',
    '/api/v1/produto/123#x',
    '/api/v1/produto/ 123',
    '/api/v1/produto/123 ',
    '/api/v1/produto/+123',
    '/api/v1/produto/1e3',
    '/api/v1/produto/123.0',
    '/api/v1/produto/0',
    '/api/v1/produto/-1',
    '/api/v1/produto/9007199254740992',
    '/api/v1/produto/',
    '/api/v1/produto_estoque/123',
    '/api/v1/produtos/123',
    '/api/v2/produto/123',
    'https://loja.invalid/api/v1/produto/123',
    '/api/v1/produto/None',
    '0123',
    '123',
    '',
    123,
    null,
    undefined,
    { resource_uri: '/api/v1/produto/123' },
  ])('NEAR-MISS: %j ⇒ null', (uri) => {
    expect(produtoIdDoEstoqueLi(uri)).toBeNull();
  });

  it('keeps no rule of its own: it answers exactly what the shared reader answers for `produto`', () => {
    for (const uri of ['/api/v1/produto/987654321', '/v1/produto/42/', '/api/v1/produto/07', 7]) {
      expect(produtoIdDoEstoqueLi(uri)).toBe(idDoRecursoLi(uri, RECURSO_URI_LI.produto));
    }
  });

  it('reads the produto from `produto`, never from the row’s own `id`', () => {
    const r = liEstoqueProdutoLinhaSchema.parse(linha(1001));
    expect(r.id).toBe(5001);
    expect(produtoIdDoEstoqueLi(r.produto)).toBe(1001);
  });
});

/* -------------------------------------------------------------------------- */

describe('lerPaginaEstoqueLi — ONE page of the stock list', () => {
  it('GETs /v1/produto_estoque with exactly `limit` and `offset` as given, and returns rows, meta and the next offset', async () => {
    const f = ok(pagina(100, '/api/v1/produto_estoque?limit=50&offset=150'));
    const r = await umaPagina(f, { offset: 100, limite: 50 });
    const { url, init } = requisicao(f);
    expect(init.method).toBe('GET');
    expect(url.origin).toBe(URL_BASE_LI);
    expect(url.pathname).toBe('/v1/produto_estoque');
    expect([...url.searchParams]).toEqual([
      ['limit', '50'],
      ['offset', '100'],
    ]);
    expect(r.linhas.map((l) => produtoIdDoEstoqueLi(l.produto))).toEqual([1001, 1002]);
    expect(r.meta).toEqual({
      limit: 50,
      next: '/api/v1/produto_estoque?limit=50&offset=150',
      offset: 100,
      previous: null,
      total_count: 120,
    });
    expect(r.proximoOffset).toBe(150);
    expect(r.correlationId).toBe('corr-1');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('`meta.limit` is read back as answered, never assumed equal to the one asked', async () => {
    const f = ok(pagina(0, '/api/v1/produto_estoque?limit=20&offset=20', [linha(1001)], 20));
    const r = await umaPagina(f, { limite: 100 });
    expect(Object.fromEntries(requisicao(f).url.searchParams)).toEqual({
      limit: '100',
      offset: '0',
    });
    expect(r.meta.limit).toBe(20);
    expect(r.proximoOffset).toBe(20);
  });

  it('a quoted meta and quoted row integers read as numbers', async () => {
    const corpo = {
      meta: { limit: '50', next: null, offset: '0', previous: null, total_count: '1' },
      objects: [linha(1001, { quantidade: '-2', quantidade_reservada: '3' })],
    };
    const r = await umaPagina(ok(corpo));
    expect(r.meta).toMatchObject({ limit: 50, offset: 0, total_count: 1 });
    expect(r.linhas[0]).toMatchObject({ quantidade: -2, quantidade_reservada: 3 });
  });

  it('`next: null` is the end: proximoOffset null', async () => {
    const r = await umaPagina(ok(pagina(0, null)));
    expect(r.proximoOffset).toBeNull();
  });

  it('rows come back in the order received, never sorted or de-duplicated', async () => {
    const r = await umaPagina(ok(pagina(0, null, [linha(1003), linha(1001), linha(1003)])));
    expect(r.linhas.map((l) => l.produto)).toEqual([
      '/api/v1/produto/1003',
      '/api/v1/produto/1001',
      '/api/v1/produto/1003',
    ]);
  });

  it('a `next` that does not move past the page is LiPaginacaoError, never a loop', async () => {
    const err = await falha(
      umaPagina(ok(pagina(50, '/api/v1/produto_estoque?limit=50&offset=50')), { offset: 50 }),
    );
    expect(err).toBeInstanceOf(LiPaginacaoError);
  });

  it('a `next` with a key nobody sent is read for its offset only, and the page asked at that offset carries exactly limit and offset', async () => {
    const f = mockFetch((input) => {
      const href =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const offset = new URL(href).searchParams.get('offset');
      return json(
        offset === '0'
          ? pagina(0, '/api/v1/produto_estoque?limit=50&offset=50&order_by=-id')
          : pagina(50, null),
      );
    });
    const { c } = cliente(f);
    const r = await lerPaginaEstoqueLi(c, { offset: 0, limite: 50 });
    expect(r.proximoOffset).toBe(50);
    const proxima = await lerPaginaEstoqueLi(c, { offset: r.proximoOffset ?? -1, limite: 50 });
    expect(proxima.proximoOffset).toBeNull();
    expect(f).toHaveBeenCalledTimes(2);
    expect([...requisicao(f, 1).url.searchParams]).toEqual([
      ['limit', '50'],
      ['offset', '50'],
    ]);
    expect(requisicao(f, 1).url.pathname).toBe('/v1/produto_estoque');
  });

  it('ONE odd row is REPORTED with its position, its produto and its field path, and never costs the rows beside it', async () => {
    const r = await umaPagina(
      ok(pagina(0, null, [linha(1001), linha(1002, { quantidade: 1.5 }), linha(1003)])),
    );
    expect(r.linhas.map((l) => produtoIdDoEstoqueLi(l.produto))).toEqual([1001, 1003]);
    expect(r.ilegiveis).toEqual([{ indice: 1, produtoId: 1002, campos: ['quantidade'] }]);
    expect(r.proximoOffset).toBeNull();
  });

  it('every row read ⇒ `ilegiveis` is empty', async () => {
    const r = await umaPagina(ok(pagina(0, null)));
    expect(r.ilegiveis).toEqual([]);
    expect(r.linhas).toHaveLength(2);
  });

  it.each<[string, unknown, number | null, string[]]>([
    ['without gerenciado', { ...linha(1002), gerenciado: undefined }, 1002, ['gerenciado']],
    ['with gerenciado as text', linha(1002, { gerenciado: 'true' }), 1002, ['gerenciado']],
    ['with a null produto', linha(1002, { produto: null }), null, ['produto']],
    ['without produto', { ...linha(1002), produto: undefined }, null, ['produto']],
    [
      'with two odd leaves',
      linha(1002, { quantidade_reservada: null, situacao_em_estoque: 'x' }),
      1002,
      ['quantidade_reservada', 'situacao_em_estoque'],
    ],
    ['that is null', null, null, ['(raiz)']],
    ['that is a text', '/api/v1/produto/1002', null, ['(raiz)']],
    ['that is an array', [linha(1002)], null, ['(raiz)']],
  ])('a row %s is reported, and the rows beside it read', async (_caso, odd, produtoId, campos) => {
    const r = await umaPagina(ok(pagina(0, null, [linha(1001), odd, linha(1003)])));
    expect(r.linhas.map((l) => produtoIdDoEstoqueLi(l.produto))).toEqual([1001, 1003]);
    expect(r.ilegiveis).toEqual([{ indice: 1, produtoId, campos }]);
  });

  it('near-miss: a `produto` TEXT that names another resource is no unreadable row — the URI is the caller’s to place', async () => {
    const r = await umaPagina(
      ok(pagina(0, null, [linha(1001, { produto: '/api/v1/marca/1001' })])),
    );
    expect(r.ilegiveis).toEqual([]);
    expect(r.linhas).toHaveLength(1);
    expect(produtoIdDoEstoqueLi(r.linhas[0]?.produto)).toBeNull();
  });

  it('an unreadable row reports field PATHS, never the values it carried', async () => {
    const r = await umaPagina(
      ok(pagina(0, null, [linha(1001, { quantidade: 'VALOR-QUE-NAO-PODE-SAIR' })])),
    );
    expect(r.ilegiveis).toEqual([{ indice: 0, produtoId: 1001, campos: ['quantidade'] }]);
    expect(JSON.stringify(r.ilegiveis)).not.toContain('VALOR-QUE-NAO-PODE-SAIR');
  });

  it.each<[string, unknown]>([
    ['`objects` that is not an array', { ...pagina(0, null), objects: { 0: linha(1001) } }],
    ['`objects` missing', { meta: pagina(0, null).meta }],
    ['`meta` missing', { objects: [linha(1001)] }],
    [
      '`meta.offset` a fraction',
      { ...pagina(0, null), meta: { ...pagina(0, null).meta, offset: 0.5 } },
    ],
  ])('NEAR-MISS: a malformed ENVELOPE (%s) still refuses the page', async (_caso, corpo) => {
    const err = await falha(umaPagina(ok(corpo)));
    expect(err).toBeInstanceOf(LiSchemaError);
    expect(err).toMatchObject({ motivo: 'formato', status: 200, operacao: 'lerPaginaEstoque' });
  });

  it('pins the page bound: the schemas binding the reconcile cursor is held to', () => {
    expect(MAX_LIMITE_PAGINA_ESTOQUE_LI).toBe(100);
    expect(MAX_LIMITE_PAGINA_ESTOQUE_LI).toBe(schemas.MAX_LIMITE_PAGINA_ESTOQUE_LI);
    // The cursor refuses a stored size this reader would refuse.
    const cursor = (limite: number) =>
      schemas.reconcileContaEstoqueLiSchema.safeParse({ offset: 0, limite, iniciadoEmMs: 0 })
        .success;
    expect(cursor(MAX_LIMITE_PAGINA_ESTOQUE_LI)).toBe(true);
    expect(cursor(MAX_LIMITE_PAGINA_ESTOQUE_LI + 1)).toBe(false);
    expect(CAMINHO_ESTOQUE_LI).toBe('/v1/produto_estoque');
  });

  it.each([1, MAX_LIMITE_PAGINA_ESTOQUE_LI])(
    'near-miss: limite %j IS sent, as given',
    async (n) => {
      const f = ok(pagina(0, null));
      await umaPagina(f, { limite: n });
      expect(requisicao(f).url.searchParams.get('limit')).toBe(String(n));
    },
  );

  it.each([0, -1, 1.5, Number.NaN, MAX_LIMITE_PAGINA_ESTOQUE_LI + 1, 1000])(
    'a limite of %j → LiConfigError("limite"); nothing fetched, no credential read',
    async (limite) => {
      const f = ok(pagina(0, null));
      const { c, credenciais } = cliente(f);
      const err = await falha(lerPaginaEstoqueLi(c, { offset: 0, limite }));
      expect(err).toBeInstanceOf(LiConfigError);
      // The operation names the call in the app's log: it is the stock page's own.
      expect(err).toMatchObject({ motivo: 'limite', operacao: 'lerPaginaEstoque' });
      expect(f).not.toHaveBeenCalled();
      expect(credenciais()).toBe(0);
    },
  );

  it.each([-1, 1.5, Number.NaN, 2 ** 53])(
    'an offset of %j → LiConfigError("offset"); nothing fetched',
    async (offset) => {
      const f = ok(pagina(0, null));
      const err = await falha(umaPagina(f, { offset }));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('offset');
      expect(f).not.toHaveBeenCalled();
    },
  );

  it('forwards the caller signal: already aborted ⇒ nothing sent, its reason comes back', async () => {
    const controller = new AbortController();
    controller.abort(new RangeError('motivo do chamador'));
    const f = ok(pagina(0, null));
    await expect(umaPagina(f, { sinal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(f).not.toHaveBeenCalled();
  });

  it('a wrong path form fails VISIBLY: a 3xx is a LiHttpError, never followed', async () => {
    const f = mockFetch(() =>
      texto('', 301, { location: '/v1/produto_estoque/?limit=50&offset=0' }),
    );
    const err = await falha(umaPagina(f));
    expect(err).toBeInstanceOf(LiHttpError);
    expect((err as LiHttpError).status).toBe(301);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */

describe('buscarEstoqueProdutoLi — one product’s stock', () => {
  const IDS_INVALIDOS: readonly (number | string)[] = [
    0,
    -1,
    1.5,
    Number.NaN,
    2 ** 53,
    '',
    '0',
    '-1',
    '+1001',
    '01001',
    ' 1001',
    '1001 ',
    '1/2',
    '1e3',
    '1001.0',
    '../1001',
  ];

  it('GETs /v1/produto_estoque/<produto id> with NO trailing slash and no query', async () => {
    const f = ok(linha(1001));
    const r = await buscarEstoqueProdutoLi(cliente(f).c, 1001);
    const { url, init } = requisicao(f);
    expect(init.method).toBe('GET');
    expect(url.href).toBe(`${URL_BASE_LI}/v1/produto_estoque/1001`);
    expect(url.search).toBe('');
    expect(r.dados).toMatchObject({ produto: '/api/v1/produto/1001', quantidade: 7 });
    expect(r).toMatchObject({ status: 200, correlationId: 'corr-1', refCredencial: 'ref-A' });
  });

  it('a number and its canonical decimal text name the same product', async () => {
    const f = ok(linha(1001));
    const { c } = cliente(f);
    await buscarEstoqueProdutoLi(c, 1001);
    await buscarEstoqueProdutoLi(c, '1001');
    expect(requisicao(f, 0).url.pathname).toBe('/v1/produto_estoque/1001');
    expect(requisicao(f, 1).url.pathname).toBe('/v1/produto_estoque/1001');
  });

  it.each(IDS_INVALIDOS)(
    'a produto id of %j → LiConfigError("caminho"); nothing fetched, no credential read',
    async (id) => {
      const f = ok(linha(1001));
      const { c, credenciais } = cliente(f);
      const err = await falha(buscarEstoqueProdutoLi(c, id));
      expect(err).toBeInstanceOf(LiConfigError);
      expect(err).toMatchObject({ motivo: 'caminho', operacao: 'buscarEstoqueProduto' });
      expect(f).not.toHaveBeenCalled();
      expect(credenciais()).toBe(0);
    },
  );

  it('a quoted integer in the detail reads as the number; a fraction refuses the read', async () => {
    const r = await buscarEstoqueProdutoLi(
      cliente(ok(linha(1001, { quantidade: '9', quantidade_reservada: '-1' }))).c,
      1001,
    );
    expect(r.dados).toMatchObject({ quantidade: 9, quantidade_reservada: -1 });
    const err = await falha(
      buscarEstoqueProdutoLi(cliente(ok(linha(1001, { quantidade: '9.5' }))).c, 1001),
    );
    expect(err).toBeInstanceOf(LiSchemaError);
  });

  it.each(['gerenciado', 'produto', 'quantidade', 'quantidade_reservada', 'situacao_sem_estoque'])(
    'NEAR-MISS: a detail without %s refuses the WHOLE read — a write decides on it, so it is never reported row-style',
    async (campo) => {
      const corpo = Object.fromEntries(Object.entries(linha(1001)).filter(([k]) => k !== campo));
      const err = await falha(buscarEstoqueProdutoLi(cliente(ok(corpo)).c, 1001));
      expect(err).toBeInstanceOf(LiSchemaError);
      expect(err).toMatchObject({
        motivo: 'formato',
        campos: [campo],
        operacao: 'buscarEstoqueProduto',
      });
    },
  );

  it('a 404 is the client’s LiNotFoundError, rethrown as-is', async () => {
    const err = await falha(
      buscarEstoqueProdutoLi(cliente(mockFetch(() => texto('', 404))).c, 1001),
    );
    expect(err).toBeInstanceOf(LiNotFoundError);
  });

  it('the answer is not checked against the id asked: the caller compares `produto`', async () => {
    const r = await buscarEstoqueProdutoLi(cliente(ok(linha(1002))).c, 1001);
    expect(produtoIdDoEstoqueLi(r.dados.produto)).toBe(1002);
  });

  it('forwards the caller signal: already aborted ⇒ nothing sent, its reason comes back', async () => {
    const controller = new AbortController();
    controller.abort(new RangeError('motivo do chamador'));
    const f = ok(linha(1001));
    await expect(
      buscarEstoqueProdutoLi(cliente(f).c, 1001, { sinal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('the barrel', () => {
  it('exports the stock reads and the row schemas', () => {
    expect(barril.lerPaginaEstoqueLi).toBe(lerPaginaEstoqueLi);
    expect(barril.buscarEstoqueProdutoLi).toBe(buscarEstoqueProdutoLi);
    expect(barril.produtoIdDoEstoqueLi).toBe(produtoIdDoEstoqueLi);
    expect(barril.CAMINHO_ESTOQUE_LI).toBe(CAMINHO_ESTOQUE_LI);
    expect(barril.MAX_LIMITE_PAGINA_ESTOQUE_LI).toBe(MAX_LIMITE_PAGINA_ESTOQUE_LI);
    expect(barril.liEstoqueProdutoLinhaSchema).toBe(liEstoqueProdutoLinhaSchema);
    expect(barril.liEstoqueProdutoDetalheSchema).toBe(liEstoqueProdutoDetalheSchema);
    expect(barril.liEcoEstoqueProdutoSchema).toBe(liEcoEstoqueProdutoSchema);
  });
});
