import { afterEach, describe, expect, it } from 'vitest';

import { CAMINHO_VALIDACAO } from '../src/api';
import {
  buscarGradeLi,
  CAMINHO_CATEGORIAS_LI,
  CAMINHO_GRADES_LI,
  CAMINHO_MARCAS_LI,
  type ListaCatalogoLi,
  listarCategoriasLi,
  listarGradesLi,
  listarMarcasLi,
  type OpcoesListaCatalogoLi,
} from '../src/catalogo';
import { criarClienteLeituraLi, type LiLeituraClient, URL_BASE_LI } from '../src/client';
import {
  LiAuthError,
  LiConfigError,
  LiNotFoundError,
  LiPaginacaoError,
  LiSchemaError,
} from '../src/errors';
import {
  gradeDetalheSintetica,
  gradesSinteticas,
  marcasSinteticas,
  paginaCategoriasSintetica,
} from './_fixtures/catalogoSintetico';
import {
  categoriaPagina1,
  categoriaUltimaPagina,
  gradeDetalheExemplo,
  gradesPaginaExemplo,
  marcaPaginaExemplo,
} from './_fixtures/especificacao';
import { json, mockFetch, requisicao, TOKEN, texto, verificarSoGet } from './_helpers/mockFetch';

/**
 * The request shapes of the four catalogue reads. Every body is either the
 * public document's own example (trimmed, names replaced, `especificacao.ts`)
 * or an invented one shaped like the owner's catalogue capture
 * (`catalogoSintetico.ts`): no captured value.
 */

afterEach(verificarSoGet);

function cliente(fetch: typeof globalThis.fetch): LiLeituraClient {
  let n = 0;
  return criarClienteLeituraLi({
    obterCredencial: () => ({ token: TOKEN, ref: 'ref-A' }),
    fetch,
    gerarCorrelationId: () => {
      n += 1;
      return `corr-${String(n)}`;
    },
    agora: () => 0,
  });
}

/** Serves the bodies in order; a request past the last one is a test failure. */
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

type Lista = (
  c: LiLeituraClient,
  opts: OpcoesListaCatalogoLi,
) => Promise<ListaCatalogoLi<{ readonly id: number }>>;

/** The three lists, each with its slash path and a one-page body its row schema reads. */
const LISTAS: readonly (readonly [string, Lista, string, unknown])[] = [
  ['listarCategoriasLi', listarCategoriasLi, '/v1/categoria/', categoriaUltimaPagina],
  [
    'listarMarcasLi',
    listarMarcasLi,
    '/v1/marca/',
    { ...marcaPaginaExemplo, meta: { ...marcaPaginaExemplo.meta, next: null } },
  ],
  [
    'listarGradesLi',
    listarGradesLi,
    '/v1/grades/',
    { ...gradesPaginaExemplo, meta: { ...gradesPaginaExemplo.meta, next: null } },
  ],
];

/** An endless list for `caminho`: every page points at the next one. */
function semFim(prefixoNext: string) {
  let offset = 0;
  return mockFetch(() => {
    const corpo = {
      meta: {
        limit: 20,
        next: `${prefixoNext}?limit=20&offset=${String(offset + 20)}`,
        offset,
        previous: null,
        total_count: 9999,
      },
      objects: [],
    };
    offset += 20;
    return json(corpo);
  });
}

describe('the paths', () => {
  it('are the SLASH forms, each a fixed constant', () => {
    expect(CAMINHO_CATEGORIAS_LI).toBe('/v1/categoria/');
    expect(CAMINHO_MARCAS_LI).toBe('/v1/marca/');
    expect(CAMINHO_GRADES_LI).toBe('/v1/grades/');
  });

  it('the category list reads the very path the token check uses', () => {
    // Why a 403 on the category list can mean "this token", and on the others
    // only "this resource": the validating GET is this same request.
    expect(CAMINHO_CATEGORIAS_LI).toBe(CAMINHO_VALIDACAO);
  });
});

describe.each(LISTAS)('%s', (_nome, listar, caminho, umaPagina) => {
  it('GETs the slash path with EXACTLY `limit` as given — no id_externo, no other key', async () => {
    const f = sequencia(json(umaPagina));
    await listar(cliente(f), { limite: 50, maxPaginas: 10 });
    const { url, init } = requisicao(f);
    expect(url.origin).toBe(URL_BASE_LI);
    expect(url.pathname).toBe(caminho);
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '50' });
    expect(url.searchParams.has('id_externo')).toBe(false);
    expect(init.method).toBe('GET');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('sends the limit it is GIVEN — it invents none', async () => {
    const f = sequencia(json(umaPagina));
    await listar(cliente(f), { limite: 7, maxPaginas: 10 });
    expect(requisicao(f).url.searchParams.get('limit')).toBe('7');
  });

  it('`next: null` on the first page ends the list after one request', async () => {
    const f = sequencia(json(umaPagina));
    const r = await listar(cliente(f), { limite: 20, maxPaginas: 10 });
    expect(r.correlationIds).toEqual(['corr-1']);
    expect(r.limites).toEqual([20]);
    expect(r.linhas.length).toBeGreaterThan(0);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'refuses limite %j with LiConfigError("limite") and fetches nothing',
    async (limite) => {
      const f = sequencia(json(umaPagina));
      const err = await falha(listar(cliente(f), { limite, maxPaginas: 10 }));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('limite');
      expect(f).not.toHaveBeenCalled();
    },
  );

  it('refuses a limite that is not a number at all (a string from an untyped caller)', async () => {
    const f = sequencia(json(umaPagina));
    const opts = { limite: '20', maxPaginas: 10 } as unknown as OpcoesListaCatalogoLi;
    const err = await falha(listar(cliente(f), opts));
    expect((err as LiConfigError).motivo).toBe('limite');
    expect(f).not.toHaveBeenCalled();
  });

  it.each([0, -1, 2.5, Number.NaN])(
    'refuses maxPaginas %j with LiConfigError("maxPaginas") and fetches nothing',
    async (maxPaginas) => {
      const f = sequencia(json(umaPagina));
      const err = await falha(listar(cliente(f), { limite: 20, maxPaginas }));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('maxPaginas');
      expect(f).not.toHaveBeenCalled();
    },
  );

  it('an ABSENT maxPaginas is refused, never defaulted to some ceiling of its own', async () => {
    const f = sequencia(json(umaPagina));
    const opts = { limite: 20 } as unknown as OpcoesListaCatalogoLi;
    const err = await falha(listar(cliente(f), opts));
    expect((err as LiConfigError).motivo).toBe('maxPaginas');
    expect(f).not.toHaveBeenCalled();
  });

  it('stops at maxPaginas with `next` still set: LiPaginacaoError, never a silent truncation', async () => {
    const f = semFim(`/api${caminho.replace(/\/$/, '')}`);
    const err = await falha(listar(cliente(f), { limite: 20, maxPaginas: 3 }));
    expect(err).toBeInstanceOf(LiPaginacaoError);
    expect(err).toMatchObject({ motivo: 'limite-de-paginas', paginas: 3 });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('a 403 is the client’s LiAuthError, rethrown as-is (what it means is the caller’s)', async () => {
    const f = sequencia(texto('Forbidden', 403));
    await expect(listar(cliente(f), { limite: 20, maxPaginas: 10 })).rejects.toBeInstanceOf(
      LiAuthError,
    );
  });

  it('a page that is not an envelope is LiSchemaError: no row is returned half-read', async () => {
    const f = sequencia(json({ objects: [] }));
    await expect(listar(cliente(f), { limite: 20, maxPaginas: 10 })).rejects.toBeInstanceOf(
      LiSchemaError,
    );
  });

  it('an already-aborted caller gets its own abort back, and nothing is fetched', async () => {
    const controller = new AbortController();
    const motivo = new DOMException('saiu', 'AbortError');
    controller.abort(motivo);
    const f = sequencia(json(umaPagina));
    const err = await falha(
      listar(cliente(f), { limite: 20, maxPaginas: 10, sinal: controller.signal }),
    );
    expect(err).toBe(motivo);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('listarCategoriasLi over several pages', () => {
  it('reads EVERY page and returns the rows in the order received', async () => {
    const f = sequencia(json(categoriaPagina1), json(categoriaUltimaPagina));
    const r = await listarCategoriasLi(cliente(f), { limite: 20, maxPaginas: 10 });
    expect(r.linhas.map((l) => l.id)).toEqual([7645875, 7645904, 7645906, 11214945, 11214946]);
    expect(r.correlationIds).toEqual(['corr-1', 'corr-2']);
    const segunda = requisicao(f, 1).url;
    expect(segunda.pathname).toBe('/v1/categoria/');
    expect(Object.fromEntries(segunda.searchParams)).toEqual({ limit: '20', offset: '20' });
  });

  it('a capture-shaped store over one page: 50 rows, then the rest, the parents carried verbatim', async () => {
    const f = sequencia(
      json(paginaCategoriasSintetica(0, '/api/v1/categoria?limit=50&offset=50', 5001, 50)),
      json(paginaCategoriasSintetica(50, null, 5051, 7)),
    );
    const r = await listarCategoriasLi(cliente(f), { limite: 50, maxPaginas: 10 });
    expect(r.linhas).toHaveLength(57);
    expect(r.linhas[0]?.categoria_pai).toBeNull();
    expect(r.linhas[1]?.categoria_pai).toBe('/api/v1/categoria/5001');
    expect(r.limites).toEqual([50, 50]);
    expect(Object.fromEntries(requisicao(f, 1).url.searchParams)).toEqual({
      limit: '50',
      offset: '50',
    });
  });

  it('`meta.limit` is READ BACK, never assumed: asked 50, answered 20, every page still followed', async () => {
    const f = sequencia(json(categoriaPagina1), json(categoriaUltimaPagina));
    const r = await listarCategoriasLi(cliente(f), { limite: 50, maxPaginas: 10 });
    expect(r.limites).toEqual([20, 20]);
    expect(r.linhas).toHaveLength(5);
    // The pager's rule (`paginacao.ts`): a key we sent keeps `next`'s value when
    // `next` carries it, so page 2 asks at the size the provider applied.
    expect(Object.fromEntries(requisicao(f, 1).url.searchParams)).toEqual({
      limit: '20',
      offset: '20',
    });
  });

  it('a quoted id parses; `categoria_pai` empty is a root, absent is a root too', async () => {
    const [raiz, filha] = categoriaPagina1.objects;
    const { categoria_pai: _pai, ...semPai } = filha;
    const f = sequencia(
      json({
        ...categoriaUltimaPagina,
        objects: [
          { ...raiz, id: '7645875', categoria_pai: '' },
          { ...semPai, resource_uri: undefined },
        ],
      }),
    );
    const r = await listarCategoriasLi(cliente(f), { limite: 20, maxPaginas: 10 });
    expect(r.linhas.map((l) => l.id)).toEqual([7645875, 7645904]);
    expect(r.linhas[0]?.categoria_pai).toBeNull();
    expect(r.linhas[1]?.categoria_pai).toBeUndefined();
  });
});

describe('listarMarcasLi', () => {
  it("the document's page parses, its descricao 'null' (a string) included", async () => {
    const f = sequencia(
      json({ ...marcaPaginaExemplo, meta: { ...marcaPaginaExemplo.meta, next: null } }),
    );
    const r = await listarMarcasLi(cliente(f), { limite: 20, maxPaginas: 10 });
    expect(r.linhas.map((m) => m.id)).toEqual([2875259, 2875261, 3012488]);
    expect(r.linhas[0]?.descricao).toBe('null');
  });

  it('a capture-shaped page parses: inactive brands are kept and marked', async () => {
    const f = sequencia(json(marcasSinteticas));
    const r = await listarMarcasLi(cliente(f), { limite: 50, maxPaginas: 10 });
    expect(r.linhas.map((m) => [m.id, m.ativo])).toEqual([
      [7001, true],
      [7002, false],
    ]);
  });
});

describe('listarGradesLi', () => {
  it('a capture-shaped page parses, the platform’s grades and the store’s alike', async () => {
    const f = sequencia(json(gradesSinteticas));
    const r = await listarGradesLi(cliente(f), { limite: 50, maxPaginas: 10 });
    expect(r.linhas.map((g) => g.id)).toEqual([900001, 900002, 8001]);
    expect(r.linhas.map((g) => g.nome_visivel)).toEqual(['Visível um', null, 'Visível plataforma']);
  });
});

describe('buscarGradeLi', () => {
  it('GETs `/v1/grades/{id}/` with NO query (no id_externo) and parses the options', async () => {
    const f = sequencia(json(gradeDetalheExemplo));
    const r = await buscarGradeLi(cliente(f), 8946);
    const { url, init } = requisicao(f);
    expect(url.href).toBe(`${URL_BASE_LI}/v1/grades/8946/`);
    expect(url.search).toBe('');
    expect(init.method).toBe('GET');
    expect(r.dados.id).toBe(8946);
    expect(r.dados.variacoes.map((v) => v.id)).toEqual([37097, 37098, 37099]);
    expect(r.correlationId).toBe('corr-1');
    expect(r.refCredencial).toBe('ref-A');
  });

  it('takes the id as its plain decimal text too (a route segment is a string)', async () => {
    const f = sequencia(json(gradeDetalheExemplo));
    await buscarGradeLi(cliente(f), '8946');
    expect(requisicao(f).url.pathname).toBe('/v1/grades/8946/');
  });

  it('a capture-shaped detail parses, every option kept', async () => {
    const f = sequencia(json(gradeDetalheSintetica(900001, 33)));
    const r = await buscarGradeLi(cliente(f), 900001);
    expect(r.dados.variacoes).toHaveLength(33);
  });

  it('a grade with no options parses', async () => {
    const f = sequencia(json({ ...gradeDetalheExemplo, variacoes: [] }));
    const r = await buscarGradeLi(cliente(f), 8946);
    expect(r.dados.variacoes).toEqual([]);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    2 ** 53,
    '0',
    '08946',
    '+8946',
    ' 8946',
    '8946 ',
    '8946.0',
    '1e3',
    '1/2',
    '../8946',
    'abc',
    '',
  ])('refuses grade id %j with LiConfigError("caminho") and fetches nothing', async (id) => {
    const f = sequencia(json(gradeDetalheExemplo));
    const err = await falha(buscarGradeLi(cliente(f), id));
    expect(err).toBeInstanceOf(LiConfigError);
    expect((err as LiConfigError).motivo).toBe('caminho');
    expect(f).not.toHaveBeenCalled();
  });

  it('a 404 is the client’s LiNotFoundError, rethrown as-is', async () => {
    const f = sequencia(texto('', 404));
    await expect(buscarGradeLi(cliente(f), 8946)).rejects.toBeInstanceOf(LiNotFoundError);
  });

  it('a 403 is LiAuthError, rethrown as-is', async () => {
    const f = sequencia(texto('Forbidden', 403));
    await expect(buscarGradeLi(cliente(f), 8946)).rejects.toBeInstanceOf(LiAuthError);
  });

  it('a body without `variacoes` is LiSchemaError', async () => {
    const { variacoes: _v, ...semVariacoes } = gradeDetalheExemplo;
    const f = sequencia(json(semVariacoes));
    await expect(buscarGradeLi(cliente(f), 8946)).rejects.toBeInstanceOf(LiSchemaError);
  });

  it('passes the caller’s signal: an already-aborted caller gets its abort, nothing is fetched', async () => {
    const controller = new AbortController();
    const motivo = new DOMException('saiu', 'AbortError');
    controller.abort(motivo);
    const f = sequencia(json(gradeDetalheExemplo));
    const err = await falha(buscarGradeLi(cliente(f), 8946, { sinal: controller.signal }));
    expect(err).toBe(motivo);
    expect(f).not.toHaveBeenCalled();
  });
});
