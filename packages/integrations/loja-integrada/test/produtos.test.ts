import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import { CAMINHO_CATEGORIAS_LI, CAMINHO_GRADES_LI, CAMINHO_MARCAS_LI } from '../src/catalogo';
import { criarClienteLeituraLi, type LiLeituraClient, URL_BASE_LI } from '../src/client';
import {
  LiAuthError,
  LiConfigError,
  LiHttpError,
  LiNotFoundError,
  LiPaginacaoError,
  LiSchemaError,
} from '../src/errors';
import { paginarLi } from '../src/paginacao';
import {
  buscarProdutoLi,
  CAMINHO_PRODUTOS_LI,
  IMAGEM_PRODUTO_CAMPOS_LI,
  lerPaginaLi,
  lerPaginaProdutosLi,
  MAX_LIMITE_PAGINA_PRODUTOS_LI,
  type OpcoesPaginaProdutosLi,
  PRODUTO_DETALHE_CAMPOS_LI,
  PRODUTO_LINHA_CAMPOS_LI,
} from '../src/produtos';
import {
  liCategoriaSchema,
  liGradeSchema,
  liMarcaSchema,
  liProdutoDetalheSchema,
  liProdutoLinhaSchema,
} from '../src/types';
import {
  categoriaPagina1,
  corpo400Gateway,
  gradesPaginaExemplo,
  marcaPaginaExemplo,
  produtoDetalheExemplo,
  produtoFiltroDataExemplo,
  produtoFiltroSkuExemplo,
  produtoFilhoCriadoExemplo,
  produtoPaginaExemplo,
} from './_fixtures/especificacao';
import { json, mockFetch, requisicao, TOKEN, texto, verificarSoGet } from './_helpers/mockFetch';

/**
 * The product import's reads. Every body is the public document's own example
 * (names, slugs, storefront URLs and CDN paths replaced, `especificacao.ts`) or
 * a hand-made variation of one: no captured value. The 400 body is synthetic,
 * shaped like the gateway answer the owner's capture C10 recorded.
 */

afterEach(verificarSoGet);

function cliente(fetch: typeof globalThis.fetch, obterCredencial = credencial): LiLeituraClient {
  let n = 0;
  return criarClienteLeituraLi({
    obterCredencial,
    fetch,
    gerarCorrelationId: () => {
      n += 1;
      return `corr-${String(n)}`;
    },
    agora: () => 0,
  });
}

function credencial() {
  return { token: TOKEN, ref: 'ref-A' };
}

/** Serves the responses in order; a request past the last one is a test failure. */
function sequencia(...respostas: readonly Response[]) {
  let i = 0;
  return mockFetch(() => {
    const r = respostas[i];
    i += 1;
    if (r === undefined) throw new RangeError('fetch além da última resposta');
    return r;
  });
}

async function falha(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('esperava uma rejeição');
    },
    (e: unknown) => e,
  );
}

const LINHAS = produtoPaginaExemplo.objects;

/** A produto page: the document's rows under a `meta` of the test's own. */
function paginaProdutos(
  offset: number,
  next: string | null,
  objects: readonly unknown[] = LINHAS.slice(0, 2),
) {
  return { meta: { limit: 100, next, offset, previous: null, total_count: 8000 }, objects };
}

/** One page of the produto list at `offset`, with `removido: false` and a page of 100. */
function produtos(f: typeof globalThis.fetch, extra: Partial<OpcoesPaginaProdutosLi> = {}) {
  return lerPaginaProdutosLi(cliente(f), { offset: 0, limite: 100, removido: false, ...extra });
}

/** `lerPaginaLi` over the produto path with the produto row schema and `{ removido }`. */
function umaPagina(
  f: typeof globalThis.fetch,
  extra: {
    offset?: number;
    limite?: number;
    query?: Record<string, string | number | boolean>;
    sinal?: AbortSignal;
  } = {},
) {
  return lerPaginaLi(cliente(f), {
    operacao: 'lerPaginaProdutos',
    caminho: CAMINHO_PRODUTOS_LI,
    esquema: liProdutoLinhaSchema,
    offset: extra.offset ?? 0,
    limite: extra.limite ?? 100,
    query: extra.query ?? { removido: false },
    sinal: extra.sinal,
  });
}

/* -------------------------------------------------------------------------- */

describe('lerPaginaLi: ONE page, and the next offset validated', () => {
  it('GETs the caller path with `limit`, the caller keys and `offset`, and returns rows, meta and the next offset', async () => {
    const f = sequencia(json(produtoPaginaExemplo));
    const r = await umaPagina(f, { limite: 20 });
    const { url } = requisicao(f);
    expect(url.origin).toBe(URL_BASE_LI);
    expect(url.pathname).toBe('/v1/produto/');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '20',
      removido: 'false',
      offset: '0',
    });
    expect(r.linhas).toHaveLength(20);
    expect(r.meta.limit).toBe(20);
    expect(r.meta.total_count).toBe(1382);
    expect(r.proximoOffset).toBe(20);
    expect(r.correlationId).toBe('corr-1');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('`next: null` is the end: proximoOffset null, after one request', async () => {
    const f = sequencia(json(produtoFiltroSkuExemplo));
    const r = await umaPagina(f);
    expect(r.proximoOffset).toBeNull();
    expect(r.linhas.map((l) => l.id)).toEqual([166737177]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('the offset is read from `next` ALONE: a next that drops every caller key still yields it', async () => {
    const f = sequencia(json(paginaProdutos(0, '/api/v1/produto?offset=100')));
    expect((await umaPagina(f)).proximoOffset).toBe(100);
  });

  it.each([
    'https://evil.example/api/v1/produto?limit=100&offset=100',
    '//evil.example/api/v1/produto?offset=100',
    'http://api.awsli.com.br.evil.example/v1/produto/?offset=100',
  ])(
    'a host in `next` (%s) is ignored: its offset is read, and no request goes anywhere',
    async (next) => {
      const f = sequencia(json(paginaProdutos(0, next)));
      const r = await umaPagina(f);
      expect(r.proximoOffset).toBe(100);
      expect(f).toHaveBeenCalledTimes(1);
      expect(requisicao(f).url.origin).toBe(URL_BASE_LI);
    },
  );

  it('a key in `next` the caller did not send is ignored, even repeated or carrying a token-shaped value', async () => {
    const f = sequencia(
      json(paginaProdutos(0, `/api/v1/produto?offset=100&an=a&an=${TOKEN}&order_by=-id`)),
    );
    expect((await umaPagina(f)).proximoOffset).toBe(100);
  });

  it('near-miss: a REPEATED caller key in `next` is refused as ambiguous', async () => {
    const f = sequencia(
      json(paginaProdutos(0, '/api/v1/produto?offset=100&removido=true&removido=false')),
    );
    const err = await falha(umaPagina(f));
    expect(err).toBeInstanceOf(LiSchemaError);
    expect(err).toMatchObject({ motivo: 'formato', campos: ['meta.next'], status: 200 });
  });

  it.each([
    ['without an offset', '/api/v1/produto?limit=100&removido=false'],
    ['empty', ''],
    ['a non-numeric offset', '/api/v1/produto?offset=cem'],
    ['a negative offset', '/api/v1/produto?offset=-100'],
    ['a fractional offset', '/api/v1/produto?offset=100.5'],
    ['an offset beyond the safe-integer range', '/api/v1/produto?offset=99999999999999999999'],
    ['an empty offset', '/api/v1/produto?offset='],
    ['a repeated offset', '/api/v1/produto?offset=100&offset=200'],
    ['an unparseable URL', 'http://['],
  ])('a `next` %s is LiSchemaError at meta.next', async (_caso, next) => {
    const f = sequencia(json(paginaProdutos(0, next)));
    const err = await falha(umaPagina(f));
    expect(err).toBeInstanceOf(LiSchemaError);
    expect(err).toMatchObject({ motivo: 'formato', campos: ['meta.next'] });
  });

  it('a `next` without an offset is refused even when the caller SENT one: the caller’s never stands in', async () => {
    const f = sequencia(json(paginaProdutos(100, '/api/v1/produto?limit=100')));
    const err = await falha(umaPagina(f, { offset: 100 }));
    expect(err).toBeInstanceOf(LiSchemaError);
    expect(err).toMatchObject({ campos: ['meta.next'] });
  });

  // Strictly past BOTH the page's own meta.offset and the offset sent.
  it.each([
    ['one page further', 100, 100, 200, 200],
    ['near-miss: one row further is still further', 100, 100, 101, 101],
    ['a stale meta.offset (0) with a next past the offset sent', 100, 0, 200, 200],
  ])('%s ⇒ the offset', async (_caso, enviado, metaOffset, proximo, esperado) => {
    const f = sequencia(
      json(paginaProdutos(metaOffset, `/api/v1/produto?offset=${String(proximo)}`)),
    );
    expect((await umaPagina(f, { offset: enviado })).proximoOffset).toBe(esperado);
  });

  it.each([
    ['equal to both', 100, 100, 100],
    ['behind both', 100, 100, 50],
    ['a stale meta.offset (0) hiding a next equal to the offset sent', 100, 0, 100],
    ["past the offset sent, but not past the page's own meta.offset", 0, 40, 20],
    ["equal to the page's own meta.offset, past the offset sent", 0, 20, 20],
  ])(
    'a next %s ⇒ LiPaginacaoError("offset-nao-avanca")',
    async (_caso, enviado, metaOffset, proximo) => {
      const f = sequencia(
        json(paginaProdutos(metaOffset, `/api/v1/produto?offset=${String(proximo)}`)),
      );
      const err = await falha(umaPagina(f, { offset: enviado }));
      expect(err).toBeInstanceOf(LiPaginacaoError);
      expect(err).toMatchObject({
        motivo: 'offset-nao-avanca',
        paginas: 1,
        correlationId: 'corr-1',
      });
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'refuses limite %j with LiConfigError("limite") and fetches nothing',
    async (limite) => {
      const f = sequencia(json(produtoPaginaExemplo));
      const err = await falha(umaPagina(f, { limite }));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('limite');
      expect(f).not.toHaveBeenCalled();
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'refuses offset %j with LiConfigError("offset") and fetches nothing',
    async (offset) => {
      const f = sequencia(json(produtoPaginaExemplo));
      const err = await falha(umaPagina(f, { offset }));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('offset');
      expect(f).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['limit', 'limite'],
    ['offset', 'offset'],
  ])(
    'a `%s` key in the extra query is refused (%s), never sent beside the option',
    async (chave, motivo) => {
      const f = sequencia(json(produtoPaginaExemplo));
      const err = await falha(umaPagina(f, { query: { removido: false, [chave]: 5 } }));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe(motivo);
      expect(f).not.toHaveBeenCalled();
    },
  );

  it('an already-aborted caller gets its own abort back: nothing fetched, the credential never read', async () => {
    const controller = new AbortController();
    const motivo = new DOMException('saiu', 'AbortError');
    controller.abort(motivo);
    const f = sequencia(json(produtoPaginaExemplo));
    const obterCredencial = vi.fn(credencial);
    const err = await falha(
      lerPaginaLi(cliente(f, obterCredencial), {
        operacao: 'lerPaginaProdutos',
        caminho: CAMINHO_PRODUTOS_LI,
        esquema: liProdutoLinhaSchema,
        offset: 0,
        limite: 100,
        sinal: controller.signal,
      }),
    );
    expect(err).toBe(motivo);
    expect(obterCredencial).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });
});

describe('lerPaginaLi and paginarLi judge `next` by ONE copy of the rules', () => {
  /** What paginarLi makes of `next` on page 1: the offset page 2 is requested at, or the error. */
  async function doPaginar(meta: { offset: number; next: string }, offsetEnviado: number) {
    const f = sequencia(
      json(paginaProdutos(meta.offset, meta.next)),
      json(paginaProdutos(9999, null)),
    );
    const gen = paginarLi(cliente(f), {
      operacao: 'lerPaginaProdutos',
      caminho: CAMINHO_PRODUTOS_LI,
      query: { limit: 100, removido: false, offset: offsetEnviado },
      schemaLinha: liProdutoLinhaSchema,
    });
    await gen.next();
    return gen
      .next()
      .then(() => `offset ${requisicao(f, 1).url.searchParams.get('offset') ?? '?'}`, veredito);
  }

  async function doLerPagina(meta: { offset: number; next: string }, offsetEnviado: number) {
    const f = sequencia(json(paginaProdutos(meta.offset, meta.next)));
    return umaPagina(f, { offset: offsetEnviado }).then(
      (r) => `offset ${String(r.proximoOffset)}`,
      veredito,
    );
  }

  function veredito(e: unknown): string {
    if (e instanceof LiSchemaError) return `schema ${e.campos.join()}`;
    if (e instanceof LiPaginacaoError) return `paginacao ${e.motivo}`;
    throw e;
  }

  it.each([
    ['/api/v1/produto?limit=100&offset=200', 100, 100, 'offset 200'],
    ['/api/v1/produto?offset=200', 100, 100, 'offset 200'],
    ['https://evil.example/api/v1/produto?offset=200&an=x', 100, 100, 'offset 200'],
    ['/api/v1/produto?offset=100', 100, 100, 'paginacao offset-nao-avanca'],
    ['/api/v1/produto?offset=100', 100, 0, 'paginacao offset-nao-avanca'],
    ['/api/v1/produto?offset=20', 0, 40, 'paginacao offset-nao-avanca'],
    ['/api/v1/produto?limit=100', 100, 100, 'schema meta.next'],
    ['/api/v1/produto?offset=200&removido=true&removido=false', 100, 100, 'schema meta.next'],
    ['/api/v1/produto?offset=200&offset=300', 100, 100, 'schema meta.next'],
  ])(
    'next %j (sent %d, meta.offset %d) ⇒ %s, from both',
    async (next, enviado, metaOffset, esperado) => {
      const meta = { offset: metaOffset, next };
      expect(await doPaginar(meta, enviado)).toBe(esperado);
      expect(await doLerPagina(meta, enviado)).toBe(esperado);
    },
  );
});

/**
 * Step 10's catalogue lists read one page at a time through `lerPaginaLi`, with
 * step 10's own paths and row schemas. Its page size,
 * `LIMITE_PAGINA_CATALOGO_LI`, is declared in `@delfrance/schemas`, which this
 * package does not depend on, so its value (50) is written here.
 */
describe.each([
  ['categorias', CAMINHO_CATEGORIAS_LI, liCategoriaSchema, categoriaPagina1, [7645875, 7645904]],
  ['marcas', CAMINHO_MARCAS_LI, liMarcaSchema, marcaPaginaExemplo, [2875259, 2875261]],
  ['grades', CAMINHO_GRADES_LI, liGradeSchema, gradesPaginaExemplo, [32769, 8945]],
] as const)('lerPaginaLi over the %s list', (nome, caminho, esquema, corpo, primeiros) => {
  const LIMITE_DO_CATALOGO = 50;

  function catalogo(f: typeof globalThis.fetch, offset: number) {
    return lerPaginaLi(cliente(f), {
      operacao: `lerPagina-${nome}`,
      caminho,
      esquema: esquema as z.ZodType<{ readonly id: number }>,
      offset,
      limite: LIMITE_DO_CATALOGO,
    });
  }

  it('GETs the step-10 path with exactly `limit` and `offset`, rows through the step-10 schema', async () => {
    const f = sequencia(json(corpo));
    const r = await catalogo(f, 0);
    const { url } = requisicao(f);
    expect(url.pathname).toBe(caminho);
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '50', offset: '0' });
    expect(r.linhas.slice(0, 2).map((l) => l.id)).toEqual(primeiros);
    expect(r.meta.limit).toBe(20);
    expect(r.proximoOffset).toBe(20);
  });

  it('the next call, at that offset, asks for the next page', async () => {
    const ultima = { ...corpo, meta: { ...corpo.meta, offset: 20, next: null } };
    const f = sequencia(json(ultima));
    const r = await catalogo(f, 20);
    expect(Object.fromEntries(requisicao(f).url.searchParams)).toEqual({
      limit: '50',
      offset: '20',
    });
    expect(r.proximoOffset).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('lerPaginaProdutosLi', () => {
  it('GETs the SLASH path with exactly `limit`, `removido` and `offset`, and nothing else', async () => {
    const f = sequencia(json(produtoPaginaExemplo));
    await produtos(f);
    const { url, init } = requisicao(f);
    expect(CAMINHO_PRODUTOS_LI).toBe('/v1/produto/');
    expect(url.href).toBe(`${URL_BASE_LI}/v1/produto/?limit=100&removido=false&offset=0`);
    expect(init.method).toBe('GET');
    for (const chave of [
      'id_externo',
      'sku',
      'ativo',
      'data_modificacao__gte',
      'data_modificacao__lte',
      'description_html',
      'descricao_completa',
    ]) {
      expect(url.searchParams.has(chave)).toBe(false);
    }
  });

  it('the trash is the SAME list read with `removido=true`', async () => {
    const f = sequencia(json(produtoPaginaExemplo));
    await produtos(f, { removido: true });
    expect(Object.fromEntries(requisicao(f).url.searchParams)).toEqual({
      limit: '100',
      removido: 'true',
      offset: '0',
    });
  });

  it('the next page: `removido` and `limit` are sent again although `next` dropped them', async () => {
    const f = sequencia(
      json(paginaProdutos(0, '/api/v1/produto?offset=100')),
      json(paginaProdutos(100, null)),
    );
    const primeira = await produtos(f, { removido: true });
    expect(primeira.proximoOffset).toBe(100);
    await produtos(f, { removido: true, offset: primeira.proximoOffset ?? -1 });
    expect(Object.fromEntries(requisicao(f, 1).url.searchParams)).toEqual({
      limit: '100',
      removido: 'true',
      offset: '100',
    });
  });

  it('`meta.limit` is READ BACK: asked 100, the document’s page answered 20', async () => {
    const f = sequencia(json(produtoPaginaExemplo));
    const r = await produtos(f);
    expect(requisicao(f).url.searchParams.get('limit')).toBe('100');
    expect(r.meta.limit).toBe(20);
    expect(r.proximoOffset).toBe(20);
  });

  it(`asks for up to ${String(MAX_LIMITE_PAGINA_PRODUTOS_LI)} rows a page`, async () => {
    expect(MAX_LIMITE_PAGINA_PRODUTOS_LI).toBe(100);
    const f = sequencia(json(produtoPaginaExemplo), json(produtoPaginaExemplo));
    await produtos(f, { limite: 100 });
    await produtos(f, { limite: 1 });
    expect(requisicao(f, 0).url.searchParams.get('limit')).toBe('100');
    expect(requisicao(f, 1).url.searchParams.get('limit')).toBe('1');
  });

  it.each([101, 200, 500, 1000, 0, -1, 1.5, Number.NaN])(
    'refuses limite %j with LiConfigError("limite") before any fetch (the API answers 400 from 200 up)',
    async (limite) => {
      const f = sequencia(json(produtoPaginaExemplo));
      const err = await falha(produtos(f, { limite }));
      expect(err).toBeInstanceOf(LiConfigError);
      expect(err).toMatchObject({ motivo: 'limite', operacao: 'lerPaginaProdutos' });
      expect(f).not.toHaveBeenCalled();
    },
  );

  it.each([-100, 0.5, Number.NaN])('refuses offset %j before any fetch', async (offset) => {
    const f = sequencia(json(produtoPaginaExemplo));
    const err = await falha(produtos(f, { offset }));
    expect((err as LiConfigError).motivo).toBe('offset');
    expect(f).not.toHaveBeenCalled();
  });

  it('a 400 with the gateway JSON body is a plain LiHttpError(400): not transient, not a schema error, no body text', async () => {
    const f = sequencia(texto(corpo400Gateway, 400, { 'content-type': 'application/json' }));
    const err = await falha(produtos(f));
    expect(err).toBeInstanceOf(LiHttpError);
    expect(err).not.toBeInstanceOf(LiNotFoundError);
    expect(err).not.toBeInstanceOf(LiAuthError);
    expect(err).toMatchObject({ status: 400, transitorio: false, caminho: '/v1/produto/' });
    const { message } = err as LiHttpError;
    expect(message).toContain('400');
    expect(message).not.toContain('sintetico');
    expect(message).not.toContain('OperationId');
  });

  it('the document’s page parses whole: variations are rows, a child carries no `filhos` and no `grades`', async () => {
    const f = sequencia(json(produtoPaginaExemplo));
    const { linhas } = await produtos(f);
    expect(linhas).toHaveLength(20);
    expect(linhas.filter((l) => l.tipo === 'atributo_opcao')).toHaveLength(10);
    const filho = linhas[1];
    expect(filho).toMatchObject({
      id: 198399269,
      tipo: 'atributo_opcao',
      sku: 'Q65VXE4BB-abacaxi',
      nome: null,
      gtin: null,
      filhos: [],
      grades: [],
      variacoes: ['/api/v1/grade/2218954/variacao/7336938'],
    });
    const pai = linhas[2];
    expect(pai).toMatchObject({
      id: 198399254,
      tipo: 'atributo',
      sku: 'Q65VXE4BB',
      filhos: ['/api/v1/produto/198399269'],
      grades: ['/api/v1/grades/2218954'],
      variacoes: [],
    });
    expect(linhas[0]).toMatchObject({
      tipo: 'normal',
      ativo: false,
      bloqueado: false,
      removido: false,
      categorias: ['/api/v1/categoria/15246059'],
    });
  });

  it("text is kept VERBATIM: a leading space stays, only the exact `''` reads as null", async () => {
    const f = sequencia(json(produtoPaginaExemplo));
    const { linhas } = await produtos(f);
    const comEspaco = linhas.find((l) => l.id === 187959333);
    expect(comEspaco?.nome).toBe(' Produto Exemplo 14');
    expect(linhas.find((l) => l.id === 198219152)?.gtin).toBeNull();
  });

  it('the filtered examples parse too (this package never sends either filter)', async () => {
    const f = sequencia(json(produtoFiltroSkuExemplo), json(produtoFiltroDataExemplo));
    const porSku = await produtos(f);
    expect(porSku.linhas[0]).toMatchObject({
      sku: '3025',
      grades: [],
      filhos: ['/api/v1/produto/166737213', '/api/v1/produto/166737211'],
    });
    const porData = await produtos(f);
    expect(porData.linhas.map((l) => l.variacoes.length)).toEqual([2, 2]);
  });

  it('a quoted id parses (`wireInt()`); near-miss: a fractional one refuses the page', async () => {
    const [primeira] = LINHAS;
    const f = sequencia(
      json(paginaProdutos(0, null, [{ ...primeira, id: '202591789' }])),
      json(paginaProdutos(0, null, [{ ...primeira, id: '202591789.5' }])),
    );
    expect((await produtos(f)).linhas[0]?.id).toBe(202591789);
    const err = await falha(produtos(f));
    expect(err).toBeInstanceOf(LiSchemaError);
    expect((err as LiSchemaError).campos).toEqual(['objects[].id']);
  });

  it('a `tipo` this package does not know still parses: the importer decides, never a refused page', async () => {
    const [primeira] = LINHAS;
    const f = sequencia(json(paginaProdutos(0, null, [{ ...primeira, tipo: 'kit' }])));
    expect((await produtos(f)).linhas[0]?.tipo).toBe('kit');
  });

  it('a flag that is not a boolean is carried raw, never folded, never a refused page', async () => {
    const [primeira] = LINHAS;
    const f = sequencia(json(paginaProdutos(0, null, [{ ...primeira, ativo: 'false' }])));
    expect((await produtos(f)).linhas[0]?.ativo).toBe('false');
  });

  it.each([
    ['absent', undefined, []],
    ['null', null, []],
    ["''", '', []],
  ])('a URI list %s reads as []', async (_caso, filhos, esperado) => {
    const [, , pai] = LINHAS;
    const f = sequencia(json(paginaProdutos(0, null, [{ ...pai, filhos }])));
    expect((await produtos(f)).linhas[0]?.filhos).toEqual(esperado);
  });

  it('near-miss: a URI list element that is not a string refuses the page', async () => {
    const [, , pai] = LINHAS;
    const f = sequencia(json(paginaProdutos(0, null, [{ ...pai, filhos: [198399269] }])));
    expect(await falha(produtos(f))).toBeInstanceOf(LiSchemaError);
  });

  it('every row is PROJECTED: exactly the row leaves, no `seo`, `url`, `tags`, slug or description', async () => {
    const [primeira] = LINHAS;
    const f = sequencia(
      json(paginaProdutos(0, null, [{ ...primeira, tags: [], preco_cheio: 10 }])),
    );
    const [linha] = (await produtos(f)).linhas;
    expect(Object.keys(linha ?? {}).sort()).toEqual(
      [
        'ativo',
        'bloqueado',
        'categorias',
        'filhos',
        'grades',
        'gtin',
        'id',
        'nome',
        'removido',
        'sku',
        'tipo',
        'variacoes',
      ].sort(),
    );
    expect([...PRODUTO_LINHA_CAMPOS_LI].sort()).toEqual(Object.keys(linha ?? {}).sort());
    // Each projected value is the parse's own, untouched.
    const lida = liProdutoLinhaSchema.parse(primeira);
    for (const campo of PRODUTO_LINHA_CAMPOS_LI) expect(linha?.[campo]).toEqual(lida[campo]);
  });
});

/* -------------------------------------------------------------------------- */

const ID_DETALHE = 238281213;

describe('buscarProdutoLi', () => {
  it('GETs the PLAIN slash path `/v1/produto/{id}/`, with no query at all', async () => {
    const f = sequencia(json(produtoDetalheExemplo));
    const r = await buscarProdutoLi(cliente(f), ID_DETALHE);
    const { url, init } = requisicao(f);
    expect(url.href).toBe(`${URL_BASE_LI}/v1/produto/238281213/`);
    expect(url.search).toBe('');
    expect(init.method).toBe('GET');
    expect(r.dados.id).toBe(ID_DETALHE);
    expect(r.status).toBe(200);
    expect(r.correlationId).toBe('corr-1');
    expect(r.refCredencial).toBe('ref-A');
  });

  it('takes the id as its plain decimal text too', async () => {
    const f = sequencia(json(produtoDetalheExemplo));
    await buscarProdutoLi(cliente(f), '238281213');
    expect(requisicao(f).url.pathname).toBe('/v1/produto/238281213/');
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    2 ** 53,
    '0',
    '0123',
    '+123',
    ' 123',
    '123 ',
    '123.0',
    '1e3',
    '1/2',
    '../123',
    '123?id_externo=1',
    'abc',
    '',
  ])('refuses id %j with LiConfigError("caminho") and fetches nothing', async (id) => {
    const f = sequencia(json(produtoDetalheExemplo));
    const err = await falha(buscarProdutoLi(cliente(f), id));
    expect(err).toBeInstanceOf(LiConfigError);
    expect(err).toMatchObject({ motivo: 'caminho', operacao: 'buscarProduto' });
    expect(f).not.toHaveBeenCalled();
  });

  it('returns a PROJECTION: exactly the detail leaves — no price, stock, `seo`, `tags` or `url`', async () => {
    const f = sequencia(json(produtoDetalheExemplo));
    const { dados } = await buscarProdutoLi(cliente(f), ID_DETALHE);
    const chaves = Object.keys(dados);
    expect(chaves.sort()).toEqual(
      [
        'altura',
        'ativo',
        'bloqueado',
        'categorias',
        'descricao_completa',
        'destaque',
        'filhos',
        'grades',
        'gtin',
        'id',
        'imagem_principal',
        'imagens',
        'largura',
        'marca',
        'nome',
        'pai',
        'peso',
        'profundidade',
        'removido',
        'sku',
        'tipo',
        'usado',
        'variacoes',
      ].sort(),
    );
    expect([...PRODUTO_DETALHE_CAMPOS_LI].sort()).toEqual(chaves.sort());
    expect(chaves.filter((c) => /^(preco_|estoque_)/.test(c))).toEqual([]);
    for (const c of ['seo', 'tags', 'url', 'apelido', 'data_modificacao', 'id_externo']) {
      expect(chaves).not.toContain(c);
    }
    // The fixture does carry them: the projection is what removed them.
    expect(Object.keys(produtoDetalheExemplo)).toEqual(
      expect.arrayContaining(['preco_cheio', 'estoque_quantidade', 'seo', 'tags', 'url']),
    );
  });

  it('every projected leaf is the parse’s own value, untouched', async () => {
    const f = sequencia(json(produtoDetalheExemplo));
    const { dados } = await buscarProdutoLi(cliente(f), ID_DETALHE);
    const lido = liProdutoDetalheSchema.parse(produtoDetalheExemplo);
    for (const campo of PRODUTO_DETALHE_CAMPOS_LI) {
      if (campo === 'imagem_principal' || campo === 'imagens') continue;
      expect(dados[campo]).toEqual(lido[campo]);
    }
    expect(dados).toMatchObject({
      tipo: 'normal',
      sku: '16167',
      pai: null,
      marca: '/api/v1/marca/20507618',
      peso: '0.500',
      altura: 15,
      largura: 15,
      profundidade: 15,
      descricao_completa: null,
      destaque: false,
      usado: false,
    });
  });

  it('images keep only `id`, `caminho`, `principal`, `posicao` and `mime`: never an absolute URL', async () => {
    const f = sequencia(json(produtoDetalheExemplo));
    const { dados } = await buscarProdutoLi(cliente(f), ID_DETALHE);
    const esperadas = [...IMAGEM_PRODUTO_CAMPOS_LI].sort();
    expect(esperadas).toEqual(['caminho', 'id', 'mime', 'posicao', 'principal']);
    expect(Object.keys(dados.imagem_principal ?? {}).sort()).toEqual(esperadas);
    for (const imagem of dados.imagens) expect(Object.keys(imagem).sort()).toEqual(esperadas);
    expect(dados.imagem_principal).toEqual({
      id: 143127013,
      caminho: '1000/1000001/produto/imagem-exemplo-1.jpg',
      principal: true,
      posicao: '0',
      mime: 'image/jpeg',
    });
    // The document's second image: `posicao` and `mime` both null.
    expect(dados.imagens[1]).toEqual({
      id: 138518698,
      caminho: '1000/1000001/produto/imagem-exemplo-2.png',
      principal: false,
      posicao: null,
      mime: null,
    });
    expect(JSON.stringify(dados)).not.toContain('https://');
  });

  it.each([
    ['a decimal string', '0.200', '0.200'],
    [
      'a string with float noise',
      '0.450000000000000011102230246251565404236316680908203125',
      '0.450000000000000011102230246251565404236316680908203125',
    ],
    ['a number', 0.45, 0.45],
    ['a quoted integer', '2', '2'],
    ["''", '', null],
    ['null', null, null],
  ])('`peso` as %s parses and is kept as sent', async (_caso, peso, esperado) => {
    const f = sequencia(json({ ...produtoDetalheExemplo, peso }));
    expect((await buscarProdutoLi(cliente(f), ID_DETALHE)).dados.peso).toStrictEqual(esperado);
  });

  it.each([
    ['a boolean', true],
    ['an object', { kg: 1 }],
  ])('near-miss: `peso` as %s refuses the detail at `peso`', async (_caso, peso) => {
    const f = sequencia(json({ ...produtoDetalheExemplo, peso }));
    const err = await falha(buscarProdutoLi(cliente(f), ID_DETALHE));
    expect(err).toBeInstanceOf(LiSchemaError);
    expect((err as LiSchemaError).campos).toEqual(['peso']);
  });

  it("sizes: integers, a quoted one, and `''` as null; near-miss: a non-number refuses the detail", async () => {
    const f = sequencia(
      json({ ...produtoDetalheExemplo, altura: '15', largura: 12.5, profundidade: '' }),
      json({ ...produtoDetalheExemplo, altura: 'quinze' }),
    );
    const { dados } = await buscarProdutoLi(cliente(f), ID_DETALHE);
    expect([dados.altura, dados.largura, dados.profundidade]).toEqual([15, 12.5, null]);
    const err = await falha(buscarProdutoLi(cliente(f), ID_DETALHE));
    expect((err as LiSchemaError).campos).toEqual(['altura']);
  });

  it('a numeric `posicao` is kept a number; an image without `id` or `caminho` still parses', async () => {
    const [primeira, segunda] = produtoDetalheExemplo.imagens;
    const { id: _id, ...semId } = segunda;
    const f = sequencia(
      json({
        ...produtoDetalheExemplo,
        imagens: [{ ...primeira, posicao: 3 }, semId, { ...segunda, caminho: '' }],
      }),
    );
    const { dados } = await buscarProdutoLi(cliente(f), ID_DETALHE);
    expect(dados.imagens.map((i) => [i.id, i.caminho, i.posicao])).toEqual([
      [143127013, '1000/1000001/produto/imagem-exemplo-1.jpg', 3],
      [undefined, '1000/1000001/produto/imagem-exemplo-2.png', null],
      [138518698, null, null],
    ]);
  });

  it('a CHILD (the document’s created variation): its `pai`, its options, its own weight and sizes, no image or category', async () => {
    const f = sequencia(json(produtoFilhoCriadoExemplo));
    const { dados } = await buscarProdutoLi(cliente(f), 182905567);
    expect(dados).toMatchObject({
      id: 182905567,
      tipo: 'atributo_opcao',
      pai: '/api/v1/produto/182904918',
      variacoes: ['/api/v1/grade/8945/variacao/37078', '/api/v1/grade/8950/variacao/38417'],
      peso: '0.450',
      altura: 2,
      largura: 12,
      profundidade: 6,
      marca: null,
      descricao_completa: null,
      imagem_principal: null,
      imagens: [],
      categorias: [],
      filhos: [],
      grades: [],
    });
  });

  it('`nome: null`, `seo: "/api/v1/seo/None"` and an empty description all parse', async () => {
    const f = sequencia(
      json({
        ...produtoDetalheExemplo,
        nome: null,
        seo: '/api/v1/seo/None',
        descricao_completa: '',
      }),
    );
    const { dados } = await buscarProdutoLi(cliente(f), ID_DETALHE);
    expect(dados.nome).toBeNull();
    expect(dados.descricao_completa).toBeNull();
  });

  it('a 404 (an unknown id answers it with an empty body) is the client’s LiNotFoundError, rethrown as-is', async () => {
    const f = sequencia(texto('', 404));
    await expect(buscarProdutoLi(cliente(f), ID_DETALHE)).rejects.toBeInstanceOf(LiNotFoundError);
  });

  it('a body without an `id` is LiSchemaError: no detail is returned half-read', async () => {
    const { id: _id, ...semId } = produtoDetalheExemplo;
    const f = sequencia(json(semId));
    const err = await falha(buscarProdutoLi(cliente(f), ID_DETALHE));
    expect(err).toBeInstanceOf(LiSchemaError);
    expect((err as LiSchemaError).campos).toEqual(['id']);
  });

  it('passes the caller’s signal: an already-aborted caller gets its abort, nothing is fetched', async () => {
    const controller = new AbortController();
    const motivo = new DOMException('saiu', 'AbortError');
    controller.abort(motivo);
    const f = sequencia(json(produtoDetalheExemplo));
    const err = await falha(buscarProdutoLi(cliente(f), ID_DETALHE, { sinal: controller.signal }));
    expect(err).toBe(motivo);
    expect(f).not.toHaveBeenCalled();
  });
});
