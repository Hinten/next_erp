import { afterEach, describe, expect, it, vi } from 'vitest';

import { criarClienteLeituraLi, type LiLeituraClient, URL_BASE_LI } from '../src/client';
import { LiConfigError, LiPaginacaoError, LiSchemaError } from '../src/errors';
import { MAX_PAGINAS_PADRAO, type PaginaLi, paginarLi } from '../src/paginacao';
import { type CategoriaLi, liCategoriaSchema } from '../src/types';
import { categoriaPagina1, categoriaUltimaPagina, metaLimite15 } from './_fixtures/especificacao';
import {
  type FetchArgs,
  json,
  mockFetch,
  requisicao,
  TOKEN,
  verificarSoGet,
} from './_helpers/mockFetch';

afterEach(verificarSoGet);

const CAMINHO = '/v1/categoria/';

function linha(id: number) {
  return {
    id,
    nome: `Categoria ${String(id)}`,
    categoria_pai: null,
    resource_uri: `/api/v1/categoria/${String(id)}`,
  };
}

function pagina(offset: number, next: string | null, ids: readonly number[], limit = 20) {
  return {
    meta: { limit, next, offset, previous: null, total_count: 99 },
    objects: ids.map(linha),
  };
}

/** Serves the bodies in order; a request past the last one is a test failure. */
function sequencia(...corpos: readonly unknown[]) {
  let i = 0;
  return mockFetch(() => {
    const corpo = corpos[i];
    i += 1;
    if (corpo === undefined) throw new RangeError('fetch além da última página');
    return json(corpo);
  });
}

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

async function coletar<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const p of gen) out.push(p);
  return out;
}

function categorias(
  fetch: typeof globalThis.fetch,
  extra: {
    query?: Record<string, string | number | boolean>;
    maxPaginas?: number;
    sinal?: AbortSignal;
  } = {},
): AsyncGenerator<PaginaLi<CategoriaLi>> {
  return paginarLi(cliente(fetch), {
    operacao: 'listarCategorias',
    caminho: CAMINHO,
    query: extra.query ?? { limit: 20 },
    schemaLinha: liCategoriaSchema,
    maxPaginas: extra.maxPaginas,
    sinal: extra.sinal,
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

describe('building the next request from meta.next', () => {
  it("requests next's query against the CALLER's path — never next's `/api/v1` path", async () => {
    const f = sequencia(categoriaPagina1, categoriaUltimaPagina);
    const paginas = await coletar(categorias(f));
    expect(paginas).toHaveLength(2);
    expect(requisicao(f, 0).url.href).toBe(`${URL_BASE_LI}${CAMINHO}?limit=20`);
    expect(requisicao(f, 1).url.href).toBe(
      'https://api.awsli.com.br/v1/categoria/?limit=20&offset=20',
    );
  });

  it.each([
    'https://evil.example/api/v1/categoria?limit=20&offset=20',
    '//evil.example/api/v1/categoria?limit=20&offset=20',
    'http://api.awsli.com.br.evil.example/v1/categoria/?limit=20&offset=20',
  ])('a next on a foreign host (%s) still requests api.awsli.com.br', async (next) => {
    const f = sequencia(pagina(0, next, [1]), pagina(20, null, [2]));
    await coletar(categorias(f));
    expect(f).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) {
      const { url, headers } = requisicao(f, i);
      expect(url.origin).toBe(URL_BASE_LI);
      expect(url.pathname).toBe(CAMINHO);
      expect(headers.get('authorization')).toBe(`Basic ${TOKEN}`);
    }
  });

  it('near-miss: an original key missing from next is added back', async () => {
    const f = sequencia(
      pagina(0, '/api/v1/categoria?limit=20&offset=20', [1]),
      pagina(20, null, [2]),
    );
    await coletar(
      categorias(f, {
        query: { limit: 20, removido: false, since_atualizado: '2026-10-01T00:00:00' },
      }),
    );
    const segunda = requisicao(f, 1).url.searchParams;
    expect(segunda.get('removido')).toBe('false');
    expect(segunda.get('since_atualizado')).toBe('2026-10-01T00:00:00');
    expect(segunda.get('offset')).toBe('20');
    expect(segunda.get('limit')).toBe('20');
  });

  it("near-miss: a key present in next keeps next's value", async () => {
    const f = sequencia(
      pagina(0, '/api/v1/categoria?limit=15&offset=15&removido=true', [1]),
      pagina(15, null, [2], 15),
    );
    await coletar(categorias(f, { query: { limit: 20, removido: false } }));
    const segunda = requisicao(f, 1).url.searchParams;
    expect(segunda.get('limit')).toBe('15');
    expect(segunda.get('removido')).toBe('true');
    expect(segunda.getAll('limit')).toHaveLength(1);
  });

  it('every page requests the caller path, under its own deadline signal', async () => {
    const f = sequencia(pagina(0, '/api/v1/categoria?offset=20', [1]), pagina(20, null, [2]));
    await coletar(categorias(f));
    expect(requisicao(f, 1).url.pathname).toBe(CAMINHO);
    expect(requisicao(f, 1).init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('what the pages carry', () => {
  it('fetches exactly one request per page, up to next === null, in order', async () => {
    const f = sequencia(
      pagina(0, '/api/v1/categoria?limit=20&offset=20', [1, 2]),
      pagina(20, '/api/v1/categoria?limit=20&offset=40', [3]),
      pagina(40, null, [4, 5]),
    );
    const paginas = await coletar(categorias(f));
    expect(f).toHaveBeenCalledTimes(3);
    expect(paginas.map((p) => p.numero)).toEqual([1, 2, 3]);
    expect(paginas.map((p) => p.correlationId)).toEqual(['corr-1', 'corr-2', 'corr-3']);
    expect(paginas.flatMap((p) => p.objetos.map((o) => o.id))).toEqual([1, 2, 3, 4, 5]);
  });

  it('exposes meta.limit as answered (15), never the limit requested (20)', async () => {
    const f = sequencia({ meta: metaLimite15, objects: [linha(1)] });
    const [primeira] = await coletar(categorias(f, { query: { limit: 20 } }));
    expect(requisicao(f).url.searchParams.get('limit')).toBe('20');
    expect(primeira?.meta.limit).toBe(15);
  });

  it('parses the document example rows', async () => {
    const f = sequencia({ ...categoriaPagina1, meta: { ...categoriaPagina1.meta, next: null } });
    const [primeira] = await coletar(categorias(f));
    expect(primeira?.objetos.map((o) => o.id)).toEqual([7645875, 7645904, 7645906]);
    expect(primeira?.objetos[1]?.categoria_pai).toBe('/api/v1/categoria/7645875');
  });
});

describe('malformed meta.next → LiSchemaError', () => {
  it.each([
    ['without an offset', '/api/v1/categoria?limit=20'],
    ['empty', ''],
    ['a non-numeric offset', '/api/v1/categoria?offset=vinte'],
    ['a negative offset', '/api/v1/categoria?offset=-20'],
    ['a fractional offset', '/api/v1/categoria?offset=20.5'],
    ['an offset beyond the safe-integer range', '/api/v1/categoria?offset=99999999999999999999'],
    ['an empty offset', '/api/v1/categoria?offset='],
    ['a repeated key', '/api/v1/categoria?offset=20&offset=40'],
    ['an unparseable URL', 'http://['],
  ])('%s', async (_caso, next) => {
    const f = sequencia(pagina(0, next, [1]), pagina(20, null, [2]));
    const gen = categorias(f);
    const primeira = await gen.next();
    expect(primeira.done).toBe(false);
    const err = await falha(gen.next());
    expect(err).toBeInstanceOf(LiSchemaError);
    expect(err).toMatchObject({ motivo: 'formato', campos: ['meta.next'], status: 200 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  // The offset is read from `next` ALONE: merged in first, the caller's own
  // starting offset would fill the gap — read as offset-nao-avanca at best, and
  // at worst (meta.offset below the caller's) silently followed.
  it.each([
    ['offset 0', 0, 0],
    ['offset 100, with meta.offset 0 below it', 100, 0],
  ])(
    'a next without an offset is LiSchemaError even when the caller query carries %s',
    async (_caso, offsetDoChamador, metaOffset) => {
      const f = sequencia(
        pagina(metaOffset, '/api/v1/categoria?limit=20', [1]),
        pagina(120, null, [2]),
      );
      const gen = categorias(f, { query: { limit: 20, offset: offsetDoChamador } });
      expect((await gen.next()).done).toBe(false);
      const err = await falha(gen.next());
      expect(err).toBeInstanceOf(LiSchemaError);
      expect(err).toMatchObject({ motivo: 'formato', campos: ['meta.next'] });
      expect(f).toHaveBeenCalledTimes(1);
    },
  );

  it("near-miss: the caller's offset is replaced by next's, never kept beside it", async () => {
    const f = sequencia(
      pagina(100, '/api/v1/categoria?limit=20&offset=120', [1]),
      pagina(120, null, [2]),
    );
    await coletar(categorias(f, { query: { limit: 20, offset: 100 } }));
    expect(requisicao(f, 0).url.searchParams.get('offset')).toBe('100');
    expect(requisicao(f, 1).url.searchParams.getAll('offset')).toEqual(['120']);
  });
});

describe('the offset must advance', () => {
  it('near-miss: offset=20 after meta.offset=0 passes', async () => {
    const f = sequencia(pagina(0, '/api/v1/categoria?offset=20', [1]), pagina(20, null, [2]));
    expect(await coletar(categorias(f))).toHaveLength(2);
  });

  it.each([
    ['equal', 20, '/api/v1/categoria?offset=20'],
    ['lower', 40, '/api/v1/categoria?offset=20'],
  ])('an %s offset fails with offset-nao-avanca', async (_caso, atual, next) => {
    const f = sequencia(pagina(0, '/api/v1/categoria?offset=20', [1]), pagina(atual, next, [2]));
    const err = await falha(coletar(categorias(f)));
    expect(err).toBeInstanceOf(LiPaginacaoError);
    expect(err).toMatchObject({ motivo: 'offset-nao-avanca', paginas: 2, correlationId: 'corr-2' });
    expect(f).toHaveBeenCalledTimes(2);
  });

  // A provider answering a STALE meta.offset (always 0) while next keeps
  // pointing at the same offset passes a meta.offset-only check on every page:
  // one page re-fetched and re-yielded until maxPaginas. The offset we SENT is
  // compared too.
  it('a stale meta.offset cannot hide a next that repeats the offset just requested', async () => {
    const f = sequencia(
      pagina(0, '/api/v1/categoria?offset=20', [1]),
      pagina(0, '/api/v1/categoria?offset=20', [2]),
      pagina(0, null, [3]),
    );
    const err = await falha(coletar(categorias(f, { maxPaginas: 50 })));
    expect(err).toBeInstanceOf(LiPaginacaoError);
    expect(err).toMatchObject({ motivo: 'offset-nao-avanca', paginas: 2 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('near-miss: a stale meta.offset with a next past the offset sent still passes', async () => {
    const f = sequencia(
      pagina(0, '/api/v1/categoria?offset=20', [1]),
      pagina(0, '/api/v1/categoria?offset=40', [2]),
      pagina(0, null, [3]),
    );
    expect(await coletar(categorias(f))).toHaveLength(3);
    expect(requisicao(f, 2).url.searchParams.get('offset')).toBe('40');
  });

  it("page 1 compares against the CALLER's starting offset, not only meta.offset", async () => {
    const f = sequencia(pagina(0, '/api/v1/categoria?offset=20', [1]), pagina(20, null, [2]));
    const err = await falha(coletar(categorias(f, { query: { limit: 20, offset: 40 } })));
    expect(err).toBeInstanceOf(LiPaginacaoError);
    expect(err).toMatchObject({ motivo: 'offset-nao-avanca', paginas: 1 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  // The mirror of the test above: past the offset SENT is not enough either. A
  // next behind the page's own meta.offset would re-read rows already yielded.
  it("page 1 compares against the page's own meta.offset, not only the offset sent", async () => {
    const f = sequencia(pagina(40, '/api/v1/categoria?offset=20', [1]), pagina(20, null, [2]));
    const err = await falha(coletar(categorias(f)));
    expect(err).toBeInstanceOf(LiPaginacaoError);
    expect(err).toMatchObject({ motivo: 'offset-nao-avanca', paginas: 1 });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('the page cap', () => {
  const tres = () =>
    sequencia(
      pagina(0, '/api/v1/categoria?offset=20', [1]),
      pagina(20, '/api/v1/categoria?offset=40', [2]),
      pagina(40, null, [3]),
    );

  it('near-miss: exactly maxPaginas pages, the last with next: null, passes', async () => {
    const f = tres();
    expect(await coletar(categorias(f, { maxPaginas: 3 }))).toHaveLength(3);
  });

  it('one page more throws limite-de-paginas — never a silent truncation', async () => {
    const f = tres();
    const lidas: number[] = [];
    const err = await falha(
      (async () => {
        for await (const p of categorias(f, { maxPaginas: 2 })) lidas.push(p.numero);
      })(),
    );
    expect(err).toBeInstanceOf(LiPaginacaoError);
    expect(err).toMatchObject({ motivo: 'limite-de-paginas', paginas: 2 });
    expect(lidas).toEqual([1, 2]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it(`defaults to ${String(MAX_PAGINAS_PADRAO)} pages`, async () => {
    expect(MAX_PAGINAS_PADRAO).toBe(200);
    let offset = 0;
    const f = mockFetch(() => {
      const corpo = pagina(offset, `/api/v1/categoria?offset=${String(offset + 20)}`, [offset]);
      offset += 20;
      return json(corpo);
    });
    const err = await falha(coletar(categorias(f)));
    expect(err).toMatchObject({ motivo: 'limite-de-paginas', paginas: MAX_PAGINAS_PADRAO });
    expect(f).toHaveBeenCalledTimes(MAX_PAGINAS_PADRAO);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'maxPaginas %s → LiConfigError("maxPaginas"), nothing fetched',
    async (maxPaginas) => {
      const f = tres();
      const err = await falha(coletar(categorias(f, { maxPaginas })));
      expect(err).toBeInstanceOf(LiConfigError);
      expect((err as LiConfigError).motivo).toBe('maxPaginas');
      expect(f).not.toHaveBeenCalled();
    },
  );
});

describe('cancellation', () => {
  it("aborting after page 1 rethrows the caller's own abort and fetches nothing more", async () => {
    const controller = new AbortController();
    const f = sequencia(pagina(0, '/api/v1/categoria?offset=20', [1]), pagina(20, null, [2]));
    const gen = categorias(f, { sinal: controller.signal });
    const primeira = await gen.next();
    expect(primeira.done).toBe(false);
    controller.abort();
    await expect(gen.next()).rejects.toBe(controller.signal.reason);
    expect(f).toHaveBeenCalledTimes(1);
  });

  // The client's own pre-send check would still stop the FETCH; the page loop's
  // check is what stops the next request from being built at all — the
  // credential getter (a store read in the app) is not called again.
  it('aborting after page 1 does not even ask for the credential again', async () => {
    const controller = new AbortController();
    const f = sequencia(pagina(0, '/api/v1/categoria?offset=20', [1]), pagina(20, null, [2]));
    const obterCredencial = vi.fn(() => ({ token: TOKEN, ref: 'ref-A' }));
    const gen = paginarLi(criarClienteLeituraLi({ obterCredencial, fetch: f }), {
      operacao: 'listarCategorias',
      caminho: CAMINHO,
      schemaLinha: liCategoriaSchema,
      sinal: controller.signal,
    });
    expect((await gen.next()).done).toBe(false);
    controller.abort();
    await expect(gen.next()).rejects.toBe(controller.signal.reason);
    expect(obterCredencial).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('an abort DURING a page request reaches that request', async () => {
    const controller = new AbortController();
    let n = 0;
    const f = vi.fn((...[, init]: FetchArgs) => {
      n += 1;
      if (n === 1) return Promise.resolve(json(pagina(0, '/api/v1/categoria?offset=20', [1])));
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        controller.abort();
      });
    });
    const err = await falha(coletar(categorias(f, { sinal: controller.signal })));
    expect(err).toBe(controller.signal.reason);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
