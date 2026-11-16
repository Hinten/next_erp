/**
 * The owner's read-only stock captures (step 12) replayed through the package's stock reads —
 * `lerPaginaEstoqueLi`, `buscarEstoqueProdutoLi` and `produtoIdDoEstoqueLi` over the REAL client —
 * and through the stock plan's pure decisions (`planoEstoqueLi.ts`, `quantidadeEstoqueLi.ts`).
 * One capture is a request the package refuses to make, the `limit=200` page, so it goes through
 * the package's generic page reader `lerPaginaLi` with the package's own row schema.
 *
 * The captures, `c11-<store>-estoque-<what>.json`, both stores read on the same day:
 *
 *  - the smaller store's WHOLE stock list, five pages of 100 (`estoque`, `-p2` … `-p5`), and its
 *    third page re-read minutes later (`-repete-meio`);
 *  - the larger store's first, third, 71st and last pages (`estoque`, `-p3`, `-p71`, `-p82`);
 *  - per store: the list at `limit=20` with and without a trailing slash, at `limit=50`, the
 *    `limit=200` refusal and a page past the end; one variation's detail with and without the
 *    slash, a parent's detail and a trashed parent's (the larger store also its one trashed
 *    simple product); an id that is no product, and a stock row's OWN id as the detail path.
 *
 * What this file pins, each on the captures themselves:
 *
 *  - (a) every request the package builds is a captured one, up to the one difference
 *    {@link consultaComparavel} names, and every capture a case replays is consumed;
 *  - (b) the path form, for GET only: the list and the detail answer the same with and without a
 *    trailing slash, with no redirect, and the package sends the no-slash form. These are GET-only
 *    captures, so the stock PUT's path form is NOT covered here;
 *  - (c) `limit` 20, 50 and 100 are honoured exactly, `meta.next` is `/api/v1/produto_estoque?…`
 *    (the `/api` prefix, no slash before `?`), and `limit=200` answers the API gateway's 400;
 *  - (d) the package's own next offsets walk the smaller store's whole list: every row read, the
 *    last page ends at `total_count`, every produto and every row id distinct; a page past the end
 *    is empty; a page re-read minutes later holds the same rows in the same positions;
 *  - (e) every row and every detail has exactly the nine leaves, every integer a JSON number,
 *    `quantidade_disponivel = quantidade − quantidade_reservada`, and a `resource_uri` naming the
 *    PRODUTO's id while the row's own `id` is another number;
 *  - (f) a detail is its list row, leaf for leaf, and the detail path id IS the produto id: a
 *    row's own id answers 404, the same as an id that is no product;
 *  - (g) the list holds a row for every product of the product captures — live parents, their
 *    variations and the trash — which also pins that both rounds share one pseudonym key;
 *  - (h) the stock plan's decisions on real rows: what already shows the four-field body, what a
 *    reservation adds, and what is always a candidate.
 *
 * Row ORDER is not pinned: the stores' rows follow neither id order, and the pseudonyms do not
 * keep order anyway, so any order assertion here would be vacuous. That fact stays in prose.
 *
 * ⚠️ Every assertion is a boolean or a count, labelled with the fixture name, so a failure never
 * prints a body value (the `wireCorpus.test.ts` convention). Fixtures are read only through the
 * corpus loader. The ids are the sanitizer's pseudonyms; nothing here names one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAMINHO_ESTOQUE_LI,
  ESTOQUE_FIXO_ESCRITA_LI,
  LiAuthError,
  LiConfigError,
  LiHttpError,
  LiNotFoundError,
  MAX_LIMITE_PAGINA_ESTOQUE_LI,
  type PaginaEstoqueLi,
  buscarEstoqueProdutoLi,
  criarClienteLeituraLi,
  lerPaginaEstoqueLi,
  lerPaginaLi,
  liEstoqueProdutoLinhaSchema,
  produtoIdDoEstoqueLi,
  quantidadeDeEstoqueValidaLi,
} from '@delfrance/integrations-loja-integrada';
import {
  type EntradaSnapshotEstoqueLi,
  FLAG_ENTRADA_ESTOQUE_LI,
  MAX_LIMITE_PAGINA_ESTOQUE_LI as MAX_LIMITE_DO_CURSOR,
  RECURSO_URI_LI,
  TIPO_PRODUTO_LI,
  idDoRecursoLi,
  reconcileContaEstoqueLiSchema,
} from '@delfrance/schemas';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ValorJsonLi } from '../core/redacao';
import {
  DIRETORIO_WIRE_LI,
  type EnvelopeFixtureLi,
  lerFixtureLi,
  listarArquivosDoCorpusLi,
} from '../fixtures/wireCorpus';
import {
  DELTA_SEM_LIMITE_LI,
  decidirEnvioEstoqueLi,
  diffLinhaEstoqueLi,
  refletidoLi,
} from './planoEstoqueLi';
import { alvoEstoqueLi } from './quantidadeEstoqueLi';

/* -------------------------------------------------------------------------- */
/*                                 The corpus                                  */
/* -------------------------------------------------------------------------- */

/** A capture's file name: `c<round>-<store>-<what>.json`. */
const NOME_DE_CAPTURA = /^(c\d+)-(loja\d+)-([a-z0-9-]+)\.json$/;

/** The stock captures' file-name prefix (a capture batch name, as `c10-` is the products'). */
const PREFIXO_ESTOQUE = 'c11-';
/** The product captures' prefix, read for the membership checks (g). */
const PREFIXO_PRODUTOS = 'c10-';

/** Every stock capture, per store, by what it is. A capture that disappears fails here. */
const CAPTURAS_ESTOQUE: Readonly<Record<string, readonly string[]>> = {
  loja1: [
    'estoque',
    'estoque-alem-do-fim',
    'estoque-barra-limite-20',
    'estoque-filho',
    'estoque-filho-barra',
    'estoque-id-da-linha',
    'estoque-inexistente',
    'estoque-limite-20',
    'estoque-limite-200',
    'estoque-limite-50',
    'estoque-lixeira',
    'estoque-lixeira-normal',
    'estoque-p3',
    'estoque-p71',
    'estoque-p82',
    'estoque-pai',
  ],
  loja2: [
    'estoque',
    'estoque-alem-do-fim',
    'estoque-barra-limite-20',
    'estoque-filho',
    'estoque-filho-barra',
    'estoque-id-da-linha',
    'estoque-inexistente',
    'estoque-limite-20',
    'estoque-limite-200',
    'estoque-limite-50',
    'estoque-lixeira',
    'estoque-p2',
    'estoque-p3',
    'estoque-p4',
    'estoque-p5',
    'estoque-pai',
    'estoque-repete-meio',
  ],
};

/** The smaller store's whole list, in walk order. `-repete-meio` is NOT here: it is `-p3`'s request. */
const PASSEIO_LOJA2 = ['estoque', 'estoque-p2', 'estoque-p3', 'estoque-p4', 'estoque-p5'] as const;

/** The larger store's committed pages, each with the offset it was asked at. */
const PAGINAS_LOJA1 = ['estoque', 'estoque-p3', 'estoque-p71', 'estoque-p82'] as const;

/** The page size of the walks: the package's ceiling, which the walks were captured at. */
const PAGINA = 100;

/** Each store's `total_count`, as every one of its pages announced it. */
const TOTAL: Readonly<Record<string, number>> = { loja1: 8118, loja2: 499 };

/** The detail captures that answered 200 (the `-barra` ones are their twin's request plus `/`). */
const DETALHES: Readonly<Record<string, readonly string[]>> = {
  loja1: [
    'estoque-filho',
    'estoque-filho-barra',
    'estoque-pai',
    'estoque-lixeira',
    'estoque-lixeira-normal',
  ],
  loja2: ['estoque-filho', 'estoque-filho-barra', 'estoque-pai', 'estoque-lixeira'],
};

/** A credential for the replay platform below; it never leaves this file. */
const CREDENCIAL_DE_TESTE = { token: 'token-de-teste-estoque', ref: 'conta-de-teste' } as const;

/** The base `meta.next` is resolved against: a host that cannot resolve. */
const BASE_INVALIDA = 'https://base.invalid';

/** The nine leaves of every stock row and detail, sorted. */
const NOVE_FOLHAS = [
  'gerenciado',
  'id',
  'produto',
  'quantidade',
  'quantidade_disponivel',
  'quantidade_reservada',
  'resource_uri',
  'situacao_em_estoque',
  'situacao_sem_estoque',
] as const;

interface Captura {
  readonly nome: string;
  readonly rodada: string;
  readonly loja: string;
  readonly tipo: string;
  readonly envelope: EnvelopeFixtureLi;
}

/** Every stock and product capture, through the corpus loader. */
function capturas(): Captura[] {
  return listarArquivosDoCorpusLi()
    .filter((nome) => nome.startsWith(PREFIXO_ESTOQUE) || nome.startsWith(PREFIXO_PRODUTOS))
    .map((nome) => {
      const partes = NOME_DE_CAPTURA.exec(nome);
      if (partes === null) throw new Error(`${nome}: not a c<round>-<store>-<what> name`);
      const leitura = lerFixtureLi(readFileSync(join(DIRETORIO_WIRE_LI, nome), 'utf8'));
      // ⚠️ Never print a failed reading: its `nao-json` arm carries the raw text.
      if (!leitura.ok) throw new Error(`${nome}: not a valid fixture envelope`);
      return {
        nome,
        rodada: `${partes[1] ?? ''}-`,
        loja: partes[2] ?? '',
        tipo: partes[3] ?? '',
        envelope: leitura.data,
      };
    });
}

const TODAS = capturas();
const ESTOQUE = TODAS.filter((c) => c.rodada === PREFIXO_ESTOQUE);
const LOJAS = Object.keys(CAPTURAS_ESTOQUE).sort();

function captura(loja: string, tipo: string, rodada = PREFIXO_ESTOQUE): Captura {
  const c = TODAS.find((x) => x.rodada === rodada && x.loja === loja && x.tipo === tipo);
  if (c === undefined) throw new Error(`${loja}: no ${rodada}${tipo} capture`);
  return c;
}

/* -------------------------------------------------------------------------- */
/*                                 The replay                                  */
/* -------------------------------------------------------------------------- */

/** A detail path, with or without the trailing slash. */
const DETALHE_DE_ESTOQUE = /^\/v1\/produto_estoque\/(\d+)\/?$/;

/**
 * The query a request is compared on, as `chave=valor` in order. Exactly ONE difference between
 * the package's request and a captured one is the same request: `offset=0`. The package sends an
 * offset on every page; the owner's first-page captures left it out, and the store's own
 * `meta.offset` is 0 on each such page (pinned below). Anything else still differs: another
 * offset, another limit, another key order, and the path is compared exactly (a trailing slash is
 * another request).
 */
function consultaComparavel(query: readonly (readonly [string, string])[]): string[] {
  return query.filter(([k, v]) => !(k === 'offset' && v === '0')).map(([k, v]) => `${k}=${v}`);
}

/** Two requests are the same when their paths are and their comparable queries are, in order. */
function mesmaRequisicao(
  caminho: string,
  query: readonly (readonly [string, string])[],
  e: EnvelopeFixtureLi,
): boolean {
  if (caminho !== e.requisicao.caminho) return false;
  const a = consultaComparavel(query);
  const b = consultaComparavel(e.requisicao.query);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The captured answer, as the store sent it: a JSON body, or none. */
function respostaDe(c: Captura): Response {
  const { status, forma, corpo } = c.envelope.resposta;
  if (forma === 'vazio') return new Response(null, { status });
  if (forma !== 'json') throw new Error(`${c.nome}: no stock capture has a text body`);
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The package's reads over the REAL client, against a platform answering ONLY a request that is
 * one of `fixtures` (a 500 otherwise). Counts the fixtures consumed (and how often), the requests
 * sent and the ones that matched none.
 */
function replay(fixtures: readonly Captura[]) {
  const consumidas = new Map<string, number>();
  let enviadas = 0;
  let semCaptura = 0;
  const fetch: typeof globalThis.fetch = (input) => {
    enviadas += 1;
    const url = new URL(String(input));
    const c = fixtures.find((f) =>
      mesmaRequisicao(url.pathname, [...url.searchParams], f.envelope),
    );
    if (c === undefined) {
      semCaptura += 1;
      return Promise.resolve(new Response('{}', { status: 500 }));
    }
    consumidas.set(c.nome, (consumidas.get(c.nome) ?? 0) + 1);
    return Promise.resolve(respostaDe(c));
  };
  const cliente = criarClienteLeituraLi({ obterCredencial: () => CREDENCIAL_DE_TESTE, fetch });
  return { cliente, consumidas, enviadas: () => enviadas, semCaptura: () => semCaptura };
}

/** A promise's rejection, or `null` when it resolved — never a catch clause. */
function rejeicaoDe(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (err: unknown) => err,
  );
}

/* -------------------------------------------------------------------------- */
/*                             Reading the captures                            */
/* -------------------------------------------------------------------------- */

/** A stock row exactly as the wire carries it: the nine leaves, numbers as JSON numbers. */
const linhaCrua = z.strictObject({
  gerenciado: z.boolean(),
  id: z.number(),
  produto: z.string(),
  quantidade: z.number(),
  quantidade_disponivel: z.number(),
  quantidade_reservada: z.number(),
  resource_uri: z.string(),
  situacao_em_estoque: z.number(),
  situacao_sem_estoque: z.number(),
});
type LinhaCrua = z.infer<typeof linhaCrua>;

const metaCrua = z
  .object({
    limit: z.number(),
    offset: z.number(),
    total_count: z.number(),
    next: z.string().nullable(),
    previous: z.string().nullable(),
  })
  .passthrough();

const listaCrua = z.object({ meta: metaCrua, objects: z.array(z.unknown()) }).passthrough();

function listaDe(c: Captura): z.infer<typeof listaCrua> {
  const r = listaCrua.safeParse(c.envelope.resposta.corpo);
  if (!r.success) throw new Error(`${c.nome}: not a list body`);
  return r.data;
}

/** A list capture's rows, each read strictly (a row that is not one throws, by position only). */
function linhasDe(c: Captura): LinhaCrua[] {
  return listaDe(c).objects.map((o, i) => {
    const r = linhaCrua.safeParse(o);
    if (!r.success) throw new Error(`${c.nome}: objects[${String(i)}] is not a stock row`);
    return r.data;
  });
}

type ObjetoJsonLi = { readonly [chave: string]: ValorJsonLi };

const ehObjetoJson = (v: ValorJsonLi): v is ObjetoJsonLi =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A capture's raw object body, for the leaves whose WIRE form is pinned. */
function corpoObjeto(c: Captura): ObjetoJsonLi {
  const corpo = c.envelope.resposta.corpo;
  if (!ehObjetoJson(corpo)) throw new Error(`${c.nome}: not an object body`);
  return corpo;
}

/** A detail capture's body, read strictly. */
function detalheDe(c: Captura): LinhaCrua {
  const r = linhaCrua.safeParse(c.envelope.resposta.corpo);
  if (!r.success) throw new Error(`${c.nome}: not a stock detail body`);
  return r.data;
}

/** A query value of the captured request (`undefined` when it has none). */
function parametro(c: Captura, chave: string): string | undefined {
  return c.envelope.requisicao.query.find(([k]) => k === chave)?.[1];
}

/** The offset a page capture was asked at (0 when it sent none). */
const offsetDe = (c: Captura) => Number(parametro(c, 'offset') ?? '0');

/** The produto id a detail capture asked for, from its path. */
function idDoCaminho(c: Captura): number {
  const id = DETALHE_DE_ESTOQUE.exec(c.envelope.requisicao.caminho)?.[1];
  if (id === undefined) throw new Error(`${c.nome}: not a stock detail path`);
  return Number(id);
}

/** The produto a row names, through the package's reader; throws (name only) when it names none. */
function produtoDe(l: { readonly produto: unknown }, onde: string): number {
  const id = produtoIdDoEstoqueLi(l.produto);
  if (id === null) throw new Error(`${onde}: the row names no produto`);
  return id;
}

/** The last id of a resource URI (`/api/v1/produto_estoque/<n>` → n). */
const ultimoId = (uri: string) => Number(/\/(\d+)\/?$/.exec(uri)?.[1] ?? Number.NaN);

/** One page, asked exactly as its capture was, through the package (its own replay). */
async function lerPagina(c: Captura): Promise<{
  readonly pagina: PaginaEstoqueLi;
  readonly offset: number;
  readonly limite: number;
  readonly consumidas: number;
  readonly semCaptura: number;
}> {
  const offset = offsetDe(c);
  const limite = Number(parametro(c, 'limit'));
  const r = replay([c]);
  const pagina = await lerPaginaEstoqueLi(r.cliente, { offset, limite });
  return { pagina, offset, limite, consumidas: r.consumidas.size, semCaptura: r.semCaptura() };
}

const json = (v: unknown) => JSON.stringify(v);

/** The smaller store's whole list, as captured (raw rows, walk order). */
const linhasDoPasseio = () => PASSEIO_LOJA2.flatMap((t) => linhasDe(captura('loja2', t)));

/** The larger store's committed pages, as captured. */
const linhasDaLoja1 = () => PAGINAS_LOJA1.flatMap((t) => linhasDe(captura('loja1', t)));

/** Every distinct list row the captures hold: the smaller store's walk and the larger's pages. */
const linhasDistintas = () => [...linhasDoPasseio(), ...linhasDaLoja1()];

/* -------------------------------------------------------------------------- */
/*                                  The tests                                  */
/* -------------------------------------------------------------------------- */

/**
 * The replay reaches the store ONLY through the fetch it injects into the client: the global one
 * throws, and every case asserts it was never called (D17, on top of the setup's kill-switch).
 */
let fetchGlobal: Mock<typeof globalThis.fetch>;

beforeEach(() => {
  fetchGlobal = vi.fn<typeof globalThis.fetch>(() => {
    throw new Error('the stock replay never calls the global fetch');
  });
  vi.stubGlobal('fetch', fetchGlobal);
});

afterEach(() => {
  expect(fetchGlobal).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('the stock captures — the corpus', () => {
  it('holds the 33 stock captures of two stores, every one a GET under a Personal Token on the catalogue class, at a stock path', () => {
    const esperadas = LOJAS.flatMap((loja) =>
      (CAPTURAS_ESTOQUE[loja] ?? []).map((t) => `${loja} ${t}`),
    );
    expect(ESTOQUE.map((c) => `${c.loja} ${c.tipo}`).sort()).toEqual(esperadas.sort());
    expect(ESTOQUE.length).toBe(33);
    for (const c of ESTOQUE) {
      expect(c.envelope.requisicao.metodo === 'GET', c.nome).toBe(true);
      expect(c.envelope.credencial === 'personal-token', c.nome).toBe(true);
      expect(c.envelope.resposta.politica === 'catalogo', c.nome).toBe(true);
      const { caminho } = c.envelope.requisicao;
      expect(
        caminho === CAMINHO_ESTOQUE_LI ||
          caminho === `${CAMINHO_ESTOQUE_LI}/` ||
          DETALHE_DE_ESTOQUE.test(caminho),
        c.nome,
      ).toBe(true);
    }
  });

  it('every capture answered 200, except the refused page size (400) and the two ids that are no product (404, empty)', () => {
    for (const loja of LOJAS) {
      const r400 = captura(loja, 'estoque-limite-200').envelope.resposta;
      expect(r400.status === 400 && r400.forma === 'json', loja).toBe(true);
      for (const tipo of ['estoque-inexistente', 'estoque-id-da-linha']) {
        const r = captura(loja, tipo).envelope.resposta;
        expect(r.status, `${loja} ${tipo}`).toBe(404);
        expect(r.forma === 'vazio' && r.bytes === 0 && r.corpo === null, `${loja} ${tipo}`).toBe(
          true,
        );
      }
    }
    const outras = ESTOQUE.filter(
      (c) => !['estoque-limite-200', 'estoque-inexistente', 'estoque-id-da-linha'].includes(c.tipo),
    );
    expect(outras.length).toBe(27);
    for (const c of outras) expect(c.envelope.resposta.status === 200, c.nome).toBe(true);
  });
});

describe('the replay: which differences are one request', () => {
  const pagina1 = captura('loja2', 'estoque');
  const outra = (caminho: string, query: readonly (readonly [string, string])[]) =>
    mesmaRequisicao(caminho, query, pagina1.envelope);

  const pagina2 = captura('loja2', 'estoque-p2');
  const daPagina2 = (query: readonly (readonly [string, string])[]) =>
    mesmaRequisicao(CAMINHO_ESTOQUE_LI, query, pagina2.envelope);

  it('EQUAL: the package’s explicit offset=0 is the first-page capture with none; a later page is its exact query', () => {
    expect(
      outra(CAMINHO_ESTOQUE_LI, [
        ['limit', String(PAGINA)],
        ['offset', '0'],
      ]),
    ).toBe(true);
    expect(
      daPagina2([
        ['limit', String(PAGINA)],
        ['offset', String(PAGINA)],
      ]),
    ).toBe(true);
  });

  it('NEAR-MISS: another offset, another limit, another key order or the slash path is another request', () => {
    expect(
      outra(CAMINHO_ESTOQUE_LI, [
        ['limit', String(PAGINA)],
        ['offset', String(PAGINA)],
      ]),
    ).toBe(false);
    expect(
      outra(CAMINHO_ESTOQUE_LI, [
        ['limit', '50'],
        ['offset', '0'],
      ]),
    ).toBe(false);
    // The order of the keys is part of the request.
    expect(
      daPagina2([
        ['offset', String(PAGINA)],
        ['limit', String(PAGINA)],
      ]),
    ).toBe(false);
    expect(
      outra(`${CAMINHO_ESTOQUE_LI}/`, [
        ['limit', String(PAGINA)],
        ['offset', '0'],
      ]),
    ).toBe(false);
  });
});

describe('(b) the path form, GET only — these captures hold no PUT, so the stock write’s path form stays unproven', () => {
  it.each(LOJAS)(
    '%s: the list answers the same with and without the trailing slash, 200 both, no redirect; the package asks the no-slash form',
    async (loja) => {
      const sem = captura(loja, 'estoque-limite-20');
      const com = captura(loja, 'estoque-barra-limite-20');
      expect(sem.envelope.requisicao.caminho).toBe(CAMINHO_ESTOQUE_LI);
      expect(com.envelope.requisicao.caminho).toBe(`${CAMINHO_ESTOQUE_LI}/`);
      expect(sem.envelope.resposta.status === 200 && com.envelope.resposta.status === 200).toBe(
        true,
      );
      const a = listaDe(sem);
      const b = listaDe(com);
      expect(json(a.objects) === json(b.objects), `${loja}: same rows, same order`).toBe(true);
      expect(
        a.meta.total_count === b.meta.total_count &&
          a.meta.limit === b.meta.limit &&
          a.meta.offset === b.meta.offset,
        loja,
      ).toBe(true);

      // The package's request is the no-slash capture, never the slash one.
      const ambas = replay([com, sem]);
      const lida = await lerPaginaEstoqueLi(ambas.cliente, { offset: 0, limite: 20 });
      expect(ambas.semCaptura()).toBe(0);
      expect([...ambas.consumidas.keys()]).toEqual([sem.nome]);
      expect(lida.linhas.length).toBe(20);
      // NEAR-MISS: offered only the slash capture, the package's request matches nothing.
      const soBarra = replay([com]);
      const erro = await rejeicaoDe(lerPaginaEstoqueLi(soBarra.cliente, { offset: 0, limite: 20 }));
      expect(soBarra.semCaptura()).toBe(1);
      expect(erro instanceof LiHttpError).toBe(true);
    },
  );

  it.each(LOJAS)(
    '%s: the detail answers the same body with and without the trailing slash; the package asks the no-slash form and parses it strict',
    async (loja) => {
      const sem = captura(loja, 'estoque-filho');
      const com = captura(loja, 'estoque-filho-barra');
      const id = idDoCaminho(sem);
      expect(sem.envelope.requisicao.caminho).toBe(`${CAMINHO_ESTOQUE_LI}/${String(id)}`);
      expect(com.envelope.requisicao.caminho).toBe(`${CAMINHO_ESTOQUE_LI}/${String(id)}/`);
      expect(json(sem.envelope.resposta.corpo) === json(com.envelope.resposta.corpo), loja).toBe(
        true,
      );

      const ambas = replay([com, sem]);
      const lida = await buscarEstoqueProdutoLi(ambas.cliente, id);
      expect(ambas.semCaptura()).toBe(0);
      expect([...ambas.consumidas.keys()]).toEqual([sem.nome]);
      expect(produtoIdDoEstoqueLi(lida.dados.produto) === id).toBe(true);
      // NEAR-MISS: offered only the slash capture, the package's request matches nothing.
      const soBarra = replay([com]);
      expect(await rejeicaoDe(buscarEstoqueProdutoLi(soBarra.cliente, id))).not.toBe(null);
      expect(soBarra.semCaptura()).toBe(1);
    },
  );
});

describe('(c) the page size', () => {
  const CASOS = LOJAS.flatMap((loja) =>
    (
      [
        ['estoque-limite-20', 20],
        ['estoque-limite-50', 50],
        ['estoque', PAGINA],
      ] as const
    ).map(([tipo, limite]) => [`${loja} ${tipo}`, captura(loja, tipo), limite] as const),
  );

  it.each(CASOS)(
    '%s: honoured exactly — meta.limit, a full page, every row read, the next offset one page on',
    async (nome, c, limite) => {
      expect(parametro(c, 'limit')).toBe(String(limite));
      expect(parametro(c, 'offset')).toBe(undefined);
      const lida = await lerPagina(c);
      expect(lida.semCaptura, nome).toBe(0);
      expect(lida.consumidas, nome).toBe(1);
      expect(lida.pagina.meta.limit === limite, nome).toBe(true);
      expect(lida.pagina.meta.offset === 0, nome).toBe(true);
      expect(lida.pagina.linhas.length === limite, nome).toBe(true);
      expect(lida.pagina.ilegiveis.length === 0, nome).toBe(true);
      expect(lida.pagina.proximoOffset === limite, nome).toBe(true);
      // `next`: the `/api` prefix, no slash before `?`, the same limit, offset + limit.
      const next = lida.pagina.meta.next;
      expect(typeof next === 'string', nome).toBe(true);
      const url = new URL(next ?? '', BASE_INVALIDA);
      expect(url.pathname === `/api${CAMINHO_ESTOQUE_LI}`, nome).toBe(true);
      expect(url.searchParams.get('limit') === String(limite), nome).toBe(true);
      expect(url.searchParams.get('offset') === String(limite), nome).toBe(true);
    },
  );

  it.each(LOJAS)(
    '%s: EQUAL — the pages at 20 and 50 are the first 20 and 50 rows of the page at 100, leaf for leaf, in order',
    (loja) => {
      const p1 = linhasDe(captura(loja, 'estoque'));
      for (const tipo of ['estoque-limite-20', 'estoque-limite-50']) {
        const menor = linhasDe(captura(loja, tipo));
        expect(menor.length > 0 && menor.length < p1.length, `${loja} ${tipo}`).toBe(true);
        expect(json(menor) === json(p1.slice(0, menor.length)), `${loja} ${tipo}`).toBe(true);
        // NEAR-MISS: the same rows one position on are not.
        expect(json(menor) === json(p1.slice(1, menor.length + 1)), `${loja} ${tipo}`).toBe(false);
      }
    },
  );

  it('100 is the ceiling the package and the reconcile cursor hold, one binding: 100 is accepted, 200 refused', () => {
    expect(MAX_LIMITE_PAGINA_ESTOQUE_LI).toBe(PAGINA);
    expect(MAX_LIMITE_PAGINA_ESTOQUE_LI).toBe(MAX_LIMITE_DO_CURSOR);
    const cursor = (limite: number) =>
      reconcileContaEstoqueLiSchema.safeParse({ offset: 0, limite, iniciadoEmMs: 0 }).success;
    expect(cursor(PAGINA)).toBe(true);
    expect(cursor(Number(parametro(captura('loja1', 'estoque-limite-200'), 'limit')))).toBe(false);
  });

  it.each(LOJAS)('%s: limit=200 is refused before anything is fetched', async (loja) => {
    const c = captura(loja, 'estoque-limite-200');
    const limite = Number(parametro(c, 'limit'));
    expect(limite > MAX_LIMITE_PAGINA_ESTOQUE_LI).toBe(true);
    const r = replay([c]);
    const erro = await rejeicaoDe(lerPaginaEstoqueLi(r.cliente, { offset: 0, limite }));
    expect(erro instanceof LiConfigError).toBe(true);
    expect(erro instanceof LiConfigError && erro.motivo === 'limite').toBe(true);
    expect(r.enviadas()).toBe(0);
  });

  it.each(LOJAS)(
    '%s: limit=200, sent anyway — a 400 whose body is the gateway’s {Code, OperationId, Message}: an LiHttpError, not transient, not a 404, not an auth failure',
    async (loja) => {
      const c = captura(loja, 'estoque-limite-200');
      const r = replay([c]);
      const erro = await rejeicaoDe(
        lerPaginaLi(r.cliente, {
          operacao: 'estoque-limite-200',
          caminho: CAMINHO_ESTOQUE_LI,
          esquema: liEstoqueProdutoLinhaSchema,
          offset: 0,
          limite: Number(parametro(c, 'limit')),
        }),
      );
      expect(r.semCaptura()).toBe(0);
      expect(r.consumidas.size).toBe(1);
      expect(erro instanceof LiHttpError).toBe(true);
      expect(erro instanceof LiNotFoundError).toBe(false);
      expect(erro instanceof LiAuthError).toBe(false);
      if (!(erro instanceof LiHttpError)) return;
      expect(erro.status).toBe(400);
      expect(erro.transitorio).toBe(false);

      // The body's shape is the gateway's, not a Tastypie error.
      const corpo = corpoObjeto(c);
      expect(Object.keys(corpo).sort()).toEqual(['Code', 'Message', 'OperationId']);
      expect(corpo.Code === String(c.envelope.resposta.status)).toBe(true);
    },
  );
});

describe('(d) paging', () => {
  it('the first pages say offset 0 and no previous page, the replay’s one offset rule', () => {
    const primeiras = ESTOQUE.filter(
      (c) =>
        c.envelope.resposta.status === 200 &&
        !DETALHE_DE_ESTOQUE.test(c.envelope.requisicao.caminho) &&
        parametro(c, 'offset') === undefined,
    );
    expect(primeiras.length).toBe(8);
    for (const c of primeiras) {
      const { meta } = listaDe(c);
      expect(meta.offset === 0 && meta.previous === null, c.nome).toBe(true);
    }
  });

  it('the smaller store, walked by the package’s own next offset: every captured page once, every row, the last page at total_count', async () => {
    const paginas = PASSEIO_LOJA2.map((t) => captura('loja2', t));
    const r = replay(paginas);
    const offsets: number[] = [];
    const produtos: number[] = [];
    const ids: unknown[] = [];
    let offset: number | null = 0;
    let ultima: PaginaEstoqueLi | null = null;
    while (offset !== null && offsets.length <= paginas.length) {
      const pagina: PaginaEstoqueLi = await lerPaginaEstoqueLi(r.cliente, {
        offset,
        limite: PAGINA,
      });
      expect(pagina.meta.offset === offset, `offset ${String(offset)}`).toBe(true);
      expect(pagina.ilegiveis.length === 0, `offset ${String(offset)}`).toBe(true);
      offsets.push(offset);
      for (const [i, l] of pagina.linhas.entries()) {
        produtos.push(produtoDe(l, `offset ${String(offset)} row ${String(i)}`));
        ids.push(l.id);
      }
      ultima = pagina;
      offset = pagina.proximoOffset;
    }
    // Every request matched a capture, each capture exactly once, in walk order.
    expect(r.semCaptura()).toBe(0);
    expect(r.enviadas()).toBe(PASSEIO_LOJA2.length);
    expect([...r.consumidas.entries()]).toEqual(paginas.map((c) => [c.nome, 1]));
    expect(offsets).toEqual(paginas.map(offsetDe));
    // The end: no next page, and the rows read are total_count.
    expect(ultima?.meta.next === null).toBe(true);
    const total = ultima?.meta.total_count;
    expect(total === TOTAL.loja2).toBe(true);
    expect((offsets.at(-1) ?? -1) + (ultima?.linhas.length ?? 0) === total).toBe(true);
    expect(produtos.length === total).toBe(true);
    // No row twice: distinct produtos, distinct row ids, and no row id is a produto id.
    expect(new Set(produtos).size === produtos.length).toBe(true);
    expect(ids.every((id) => typeof id === 'number')).toBe(true);
    expect(new Set(ids).size === ids.length).toBe(true);
    const produtosSet = new Set(produtos);
    expect(ids.some((id) => typeof id === 'number' && produtosSet.has(id))).toBe(false);
  });

  it('the larger store: each committed page at its own offset, one page on to the next, the last at total_count', async () => {
    const produtos: number[] = [];
    for (const tipo of PAGINAS_LOJA1) {
      const c = captura('loja1', tipo);
      const lida = await lerPagina(c);
      expect(lida.semCaptura, c.nome).toBe(0);
      expect(lida.consumidas, c.nome).toBe(1);
      expect(lida.limite === PAGINA, c.nome).toBe(true);
      expect(lida.pagina.meta.offset === lida.offset, c.nome).toBe(true);
      expect(lida.pagina.meta.total_count === TOTAL.loja1, c.nome).toBe(true);
      expect(lida.pagina.ilegiveis.length === 0, c.nome).toBe(true);
      const ultima = tipo === 'estoque-p82';
      expect(lida.pagina.proximoOffset === (ultima ? null : lida.offset + PAGINA), c.nome).toBe(
        true,
      );
      if (ultima) {
        expect(lida.offset + lida.pagina.linhas.length === TOTAL.loja1, c.nome).toBe(true);
        expect(lida.pagina.linhas.length < PAGINA, c.nome).toBe(true);
      } else {
        expect(lida.pagina.linhas.length === PAGINA, c.nome).toBe(true);
      }
      produtos.push(
        ...lida.pagina.linhas.map((l, i) => produtoDe(l, `${c.nome} row ${String(i)}`)),
      );
    }
    expect(new Set(produtos).size === produtos.length).toBe(true);
  });

  it.each(LOJAS)(
    '%s: a page past the end answers 200 with no row, no next page and the same total_count',
    async (loja) => {
      const c = captura(loja, 'estoque-alem-do-fim');
      const lida = await lerPagina(c);
      expect(lida.semCaptura).toBe(0);
      expect(lida.consumidas).toBe(1);
      expect(lida.offset >= (TOTAL[loja] ?? Number.POSITIVE_INFINITY)).toBe(true);
      expect(lida.pagina.linhas.length === 0).toBe(true);
      expect(lida.pagina.ilegiveis.length === 0).toBe(true);
      expect(lida.pagina.proximoOffset).toBe(null);
      expect(lida.pagina.meta.next === null).toBe(true);
      expect(lida.pagina.meta.offset === lida.offset).toBe(true);
      expect(lida.pagina.meta.total_count === TOTAL[loja]).toBe(true);
    },
  );

  it('a page re-read minutes later holds the same rows in the same positions, under the same meta', async () => {
    const original = captura('loja2', 'estoque-p3');
    const relida = captura('loja2', 'estoque-repete-meio');
    expect(
      mesmaRequisicao(
        original.envelope.requisicao.caminho,
        original.envelope.requisicao.query,
        relida.envelope,
      ),
    ).toBe(true);
    const a = await lerPagina(original);
    const b = await lerPagina(relida);
    expect(a.consumidas === 1 && b.consumidas === 1).toBe(true);
    expect(a.pagina.linhas.length === PAGINA).toBe(true);
    expect(json(a.pagina.linhas) === json(b.pagina.linhas)).toBe(true);
    expect(
      a.pagina.meta.limit === b.pagina.meta.limit &&
        a.pagina.meta.offset === b.pagina.meta.offset &&
        a.pagina.meta.total_count === b.pagina.meta.total_count,
    ).toBe(true);
    // NEAR-MISS: the neighbouring page is not the same rows.
    const p2 = await lerPagina(captura('loja2', 'estoque-p2'));
    expect(json(a.pagina.linhas) === json(p2.pagina.linhas)).toBe(false);
  });
});

describe('(e) the shape of every row and every detail', () => {
  /** Every list row (each list capture, every row) and every 200 detail, labelled. */
  function todasAsLinhas(): { readonly onde: string; readonly linha: unknown }[] {
    const linhas: { readonly onde: string; readonly linha: unknown }[] = [];
    for (const c of ESTOQUE) {
      if (c.envelope.resposta.status !== 200) continue;
      if (DETALHE_DE_ESTOQUE.test(c.envelope.requisicao.caminho)) {
        linhas.push({ onde: `${c.nome} (raiz)`, linha: c.envelope.resposta.corpo });
      } else {
        for (const [i, o] of listaDe(c).objects.entries()) {
          linhas.push({ onde: `${c.nome} objects[${String(i)}]`, linha: o });
        }
      }
    }
    return linhas;
  }

  /** 1097 list rows (the walk with its re-read page: 599; the larger store's pages: 318; 20 + 20 + 50 per store) and 9 details. */
  const MINIMO_DE_LINHAS = 1106;

  it('exactly the nine leaves, every integer a JSON number, the produto and resource_uri naming one produto that is not the row’s own id, disponivel = quantidade − reservada', () => {
    const linhas = todasAsLinhas();
    expect(linhas.length).toBe(MINIMO_DE_LINHAS);
    for (const { onde, linha } of linhas) {
      const objeto =
        typeof linha === 'object' && linha !== null && !Array.isArray(linha) ? linha : {};
      expect(Object.keys(objeto).sort(), onde).toEqual([...NOVE_FOLHAS]);
      const r = linhaCrua.safeParse(linha);
      expect(r.success, onde).toBe(true);
      if (!r.success) continue;
      const l = r.data;
      expect(
        [
          l.id,
          l.quantidade,
          l.quantidade_disponivel,
          l.quantidade_reservada,
          l.situacao_em_estoque,
          l.situacao_sem_estoque,
        ].every((n) => Number.isSafeInteger(n)),
        onde,
      ).toBe(true);
      const produto = produtoIdDoEstoqueLi(l.produto);
      expect(produto !== null, onde).toBe(true);
      expect(l.produto === `/api/v1/produto/${String(produto)}`, onde).toBe(true);
      expect(l.resource_uri === `/api/v1/produto_estoque/${String(produto)}`, onde).toBe(true);
      expect(l.id !== produto, onde).toBe(true);
      expect(l.quantidade_disponivel === l.quantidade - l.quantidade_reservada, onde).toBe(true);
      expect(l.quantidade_reservada >= 0, onde).toBe(true);
      expect(liEstoqueProdutoLinhaSchema.safeParse(linha).success, onde).toBe(true);
    }
  });

  it('NEAR-MISS: the package’s row schema refuses a row whose quantity arrives as a fraction, and the produto reader names no produto from the row’s own resource_uri', () => {
    const [linha] = linhasDe(captura('loja2', 'estoque'));
    if (linha === undefined) throw new Error('page 1 has no row');
    expect(liEstoqueProdutoLinhaSchema.safeParse({ ...linha, quantidade: 1.5 }).success).toBe(
      false,
    );
    expect(produtoIdDoEstoqueLi(linha.resource_uri) === null).toBe(true);
  });

  it('the package hands every row and every detail on exactly as captured: the nine leaves, leaf for leaf, nothing coerced or moved', async () => {
    /** Keys sorted, so the comparison is leaf for leaf whatever order a schema emits them in. */
    const canonico = (o: object) =>
      json(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
    let linhas = 0;
    for (const c of ESTOQUE) {
      if (c.envelope.resposta.status !== 200) continue;
      const { caminho } = c.envelope.requisicao;
      if (caminho === `${CAMINHO_ESTOQUE_LI}/`) continue; // the package never asks the slash form
      if (DETALHE_DE_ESTOQUE.test(caminho)) {
        if (caminho.endsWith('/')) continue;
        const r = replay([c]);
        const lida = await buscarEstoqueProdutoLi(r.cliente, idDoCaminho(c));
        expect(canonico(lida.dados) === canonico(corpoObjeto(c)), c.nome).toBe(true);
        linhas += 1;
        continue;
      }
      const brutas = listaDe(c).objects;
      const { pagina } = await lerPagina(c);
      expect(pagina.linhas.length === brutas.length, c.nome).toBe(true);
      for (const [i, l] of pagina.linhas.entries()) {
        const bruta = brutas[i];
        const igual =
          typeof bruta === 'object' && bruta !== null && canonico(l) === canonico(bruta);
        expect(igual, `${c.nome} objects[${String(i)}]`).toBe(true);
        linhas += 1;
      }
    }
    // Every list row but the two slash-form pages' 40, and the seven no-slash details.
    expect(linhas).toBe(1097 - 40 + 7);
  });
});

describe('(e) the values the stores hold, counted on the captures', () => {
  it('the smaller store: some negative quantities (all managed), no reservation, and lead times the stock write overwrites', () => {
    const linhas = linhasDoPasseio();
    expect(linhas.length).toBe(TOTAL.loja2 ?? -1);
    const negativas = linhas.filter((l) => l.quantidade < 0);
    expect(negativas.length).toBe(4);
    expect(negativas.every((l) => l.gerenciado)).toBe(true);
    expect(linhas.filter((l) => l.quantidade_reservada > 0).length).toBe(0);
    expect(linhas.filter((l) => l.situacao_em_estoque > 0).length).toBe(23);
    expect(linhas.filter((l) => l.situacao_sem_estoque > 0).length).toBe(20);
    expect(linhas.filter((l) => !l.gerenciado).length).toBe(114);
  });

  it('the larger store’s committed pages: every managed row carries exactly the stock write’s two situações, every unmanaged row zeros', () => {
    const linhas = linhasDaLoja1();
    const geridas = linhas.filter((l) => l.gerenciado);
    const naoGeridas = linhas.filter((l) => !l.gerenciado);
    expect([geridas.length, naoGeridas.length]).toEqual([271, 47]);
    expect(
      geridas.every(
        (l) =>
          l.situacao_em_estoque === ESTOQUE_FIXO_ESCRITA_LI.situacao_em_estoque &&
          l.situacao_sem_estoque === ESTOQUE_FIXO_ESCRITA_LI.situacao_sem_estoque,
      ),
    ).toBe(true);
    expect(
      naoGeridas.every((l) => l.situacao_em_estoque === 0 && l.situacao_sem_estoque === 0),
    ).toBe(true);
  });

  it('the larger store: the third page holds a negative managed row, the 71st a managed row with a reservation', () => {
    const p3 = linhasDe(captura('loja1', 'estoque-p3'));
    expect(p3.filter((l) => l.quantidade < 0 && l.gerenciado).length).toBe(1);
    const p71 = linhasDe(captura('loja1', 'estoque-p71'));
    const reservadas = p71.filter((l) => l.quantidade_reservada > 0);
    expect(reservadas.length).toBe(1);
    expect(reservadas.every((l) => l.gerenciado && l.quantidade >= l.quantidade_reservada)).toBe(
      true,
    );
  });
});

describe('(f) the details, and the key the detail path takes', () => {
  /** Every 200 detail asked without the slash: the request the package makes. */
  const SEM_BARRA = LOJAS.flatMap((loja) =>
    (DETALHES[loja] ?? [])
      .filter((t) => !t.endsWith('-barra'))
      .map((t) => [`${loja} ${t}`, captura(loja, t)] as const),
  );

  it('seven details asked the package’s way, two more with the slash', () => {
    expect(SEM_BARRA.length).toBe(7);
    expect(LOJAS.flatMap((l) => DETALHES[l] ?? []).length).toBe(9);
  });

  it.each(SEM_BARRA)(
    '%s: the package asks the captured path, parses it strict, and its produto is the path id; the row’s own id is not',
    async (nome, c) => {
      const id = idDoCaminho(c);
      const r = replay([c]);
      const lida = await buscarEstoqueProdutoLi(r.cliente, id);
      expect(r.semCaptura(), nome).toBe(0);
      expect(r.consumidas.size, nome).toBe(1);
      expect(produtoIdDoEstoqueLi(lida.dados.produto) === id, nome).toBe(true);
      const bruto = detalheDe(c);
      expect(ultimoId(bruto.resource_uri) === id, nome).toBe(true);
      expect(bruto.id !== id, nome).toBe(true);
    },
  );

  it('the smaller store: each detail is, leaf for leaf, the walk’s row for the same produto', () => {
    const porProduto = new Map(linhasDoPasseio().map((l) => [produtoDe(l, 'loja2 walk'), l]));
    for (const tipo of DETALHES.loja2 ?? []) {
      const c = captura('loja2', tipo);
      const linha = porProduto.get(idDoCaminho(c));
      expect(linha !== undefined, c.nome).toBe(true);
      // Both read through the same strict nine-leaf schema, so the comparison is leaf for leaf.
      expect(json(linha) === json(detalheDe(c)), c.nome).toBe(true);
    }
  });

  it('the larger store: the trashed simple product’s detail is its row on a committed page, leaf for leaf', () => {
    const c = captura('loja1', 'estoque-lixeira-normal');
    const linha = linhasDaLoja1().find((l) => produtoDe(l, 'loja1 pages') === idDoCaminho(c));
    expect(linha !== undefined).toBe(true);
    expect(json(linha) === json(detalheDe(c))).toBe(true);
  });

  it.each([
    ['loja2', linhasDoPasseio],
    ['loja1', () => linhasDe(captura('loja1', 'estoque'))],
  ] as const)(
    '%s: a stock row’s own id as the detail path is a 404, the same as an id that is no product — the detail key is the PRODUTO id',
    async (loja, linhas) => {
      const c = captura(loja, 'estoque-id-da-linha');
      const id = idDoCaminho(c);
      const rows = linhas();
      // The id IS one row's own id, and no row's produto.
      expect(rows.filter((l) => l.id === id).length).toBe(1);
      expect(rows.some((l) => produtoDe(l, loja) === id)).toBe(false);
      const r = replay([c]);
      const erro = await rejeicaoDe(buscarEstoqueProdutoLi(r.cliente, id));
      expect(r.semCaptura()).toBe(0);
      expect(r.consumidas.size).toBe(1);
      expect(erro instanceof LiNotFoundError && erro.status === 404).toBe(true);
    },
  );

  it.each(LOJAS)(
    '%s: an id that is no product is a 404 with an empty body, which the package reads as LiNotFoundError',
    async (loja) => {
      const c = captura(loja, 'estoque-inexistente');
      const id = idDoCaminho(c);
      // The smaller store's walk is complete: no product of it carries the id.
      expect(linhasDoPasseio().some((l) => produtoDe(l, 'loja2 walk') === id)).toBe(false);
      const r = replay([c]);
      const erro = await rejeicaoDe(buscarEstoqueProdutoLi(r.cliente, id));
      expect(r.semCaptura()).toBe(0);
      expect(r.consumidas.size).toBe(1);
      expect(erro instanceof LiNotFoundError && erro.status === 404).toBe(true);
    },
  );
});

/** A product capture's rows, raw (the product-capture suite pins their parse). */
const linhaDeProduto = z
  .object({
    id: z.number(),
    tipo: z.string(),
    removido: z.boolean(),
    filhos: z.array(z.unknown()).nullable().optional(),
  })
  .passthrough();

function produtosDe(loja: string, tipo: string): z.infer<typeof linhaDeProduto>[] {
  const r = z
    .object({ objects: z.array(linhaDeProduto) })
    .passthrough()
    .safeParse(captura(loja, tipo, PREFIXO_PRODUTOS).envelope.resposta.corpo);
  if (!r.success) throw new Error(`${loja}: ${PREFIXO_PRODUTOS}${tipo} is not a product list`);
  return r.data.objects;
}

/** The produto ids a product row names in `filhos`, through the shared reader the import uses. */
const filhosDe = (p: z.infer<typeof linhaDeProduto>) =>
  (p.filhos ?? []).map((u) => idDoRecursoLi(u, RECURSO_URI_LI.produto));

describe('(g) every product has a stock row — and both capture rounds share one pseudonym key', () => {
  it('the smaller store: every product of its product captures — live parents, their variations, the trash and what it claims — is the produto of exactly ONE row of the walk', () => {
    const vivos = produtosDe('loja2', 'produtos');
    const lixeira = produtosDe('loja2', 'produtos-lixeira');
    const filhos = [...vivos, ...lixeira].flatMap(filhosDe);
    expect(filhos.every((id) => id !== null)).toBe(true);
    const todos = new Set([...vivos.map((p) => p.id), ...lixeira.map((p) => p.id), ...filhos]);
    expect(todos.size).toBe(261);
    // Every kind is among them.
    expect(vivos.some((p) => p.tipo === TIPO_PRODUTO_LI.atributo)).toBe(true);
    expect(vivos.some((p) => p.tipo === TIPO_PRODUTO_LI.atributoOpcao)).toBe(true);
    expect(lixeira.length > 0 && lixeira.every((p) => p.removido)).toBe(true);

    const linhasPorProduto = new Map<number, number>();
    for (const l of linhasDoPasseio()) {
      const p = produtoDe(l, 'loja2 walk');
      linhasPorProduto.set(p, (linhasPorProduto.get(p) ?? 0) + 1);
    }
    expect([...todos].filter((id) => id !== null && linhasPorProduto.get(id) === 1).length).toBe(
      todos.size,
    );
  });

  it('the smaller store: a parent’s row is unmanaged and zero, whatever its variations hold — its quantidade is not their sum', () => {
    const porProduto = new Map(linhasDoPasseio().map((l) => [produtoDe(l, 'loja2 walk'), l]));
    const pais = [
      ...produtosDe('loja2', 'produtos'),
      ...produtosDe('loja2', 'produtos-lixeira'),
    ].filter((p) => filhosDe(p).length > 0);
    expect(pais.length).toBe(49);
    const linhas = pais.map((p) => porProduto.get(p.id));
    expect(linhas.every((l) => l !== undefined && !l.gerenciado && l.quantidade === 0)).toBe(true);
    const somaDosFilhos = (p: z.infer<typeof linhaDeProduto>) =>
      filhosDe(p).reduce<number>((s, id) => s + (porProduto.get(id ?? -1)?.quantidade ?? 0), 0);
    expect(pais.filter((p) => somaDosFilhos(p) !== 0).length).toBe(31);
    // Some variations are unmanaged too.
    const filhos = new Set(pais.flatMap(filhosDe));
    expect([...filhos].filter((id) => porProduto.get(id ?? -1)?.gerenciado === false).length).toBe(
      10,
    );
  });

  it('the trashed parents’ details name a trashed parent of the product captures; the trashed simple product its one `normal` row', () => {
    for (const loja of LOJAS) {
      const lixeira = produtosDe(loja, 'produtos-lixeira');
      const d = detalheDe(captura(loja, 'estoque-lixeira'));
      const p = lixeira.find((x) => x.id === produtoDe(d, loja));
      expect(p?.tipo === TIPO_PRODUTO_LI.atributo && p.removido, loja).toBe(true);
      expect(!d.gerenciado && d.quantidade === 0, loja).toBe(true);
    }
    const lixeira1 = produtosDe('loja1', 'produtos-lixeira');
    const normal = detalheDe(captura('loja1', 'estoque-lixeira-normal'));
    const p = lixeira1.find((x) => x.id === produtoDe(normal, 'loja1'));
    expect(p?.tipo === TIPO_PRODUTO_LI.normal && p.removido).toBe(true);
    expect(lixeira1.filter((x) => x.tipo === TIPO_PRODUTO_LI.normal).length).toBe(1);
    expect(normal.gerenciado && normal.quantidade === 0).toBe(true);
  });

  it('the larger store: the parent’s detail names a live parent of the product captures, the variation’s a variation one of them claims', () => {
    const vivos = ['produtos', 'produtos-p2', 'produtos-p162'].flatMap((t) =>
      produtosDe('loja1', t),
    );
    const pai = vivos.find(
      (x) => x.id === produtoDe(detalheDe(captura('loja1', 'estoque-pai')), 'loja1'),
    );
    expect(pai?.tipo === TIPO_PRODUTO_LI.atributo && !pai.removido).toBe(true);
    const filho = produtoDe(detalheDe(captura('loja1', 'estoque-filho')), 'loja1');
    const linhaDoFilho = vivos.find((x) => x.id === filho);
    expect(linhaDoFilho?.tipo === TIPO_PRODUTO_LI.atributoOpcao).toBe(true);
    expect(vivos.some((x) => filhosDe(x).includes(filho))).toBe(true);
  });

  it('NEAR-MISS: no product of the larger store’s product captures has a row in the smaller store’s whole list', () => {
    const doOutro = new Set(linhasDoPasseio().map((l) => produtoDe(l, 'loja2 walk')));
    const loja1 = ['produtos', 'produtos-p2', 'produtos-p162', 'produtos-lixeira'].flatMap((t) =>
      produtosDe('loja1', t),
    );
    const ids = [...loja1.map((p) => p.id), ...loja1.flatMap(filhosDe)];
    expect(ids.length > 0).toBe(true);
    expect(ids.some((id) => id !== null && doOutro.has(id))).toBe(false);
  });
});

describe('(h) the stock plan’s decisions on real rows', () => {
  /** A valid snapshot entry with S; the ERP produto id is a placeholder, never read by the decision. */
  const entrada = (s: number): EntradaSnapshotEstoqueLi => ({
    p: 'produto-de-teste',
    s,
    f: FLAG_ENTRADA_ESTOQUE_LI.valido,
  });
  const diff = (l: LinhaCrua, s: number) =>
    diffLinhaEstoqueLi({
      idLi: String(produtoDe(l, 'row')),
      linha: l,
      entrada: entrada(s),
      cap: Number.POSITIVE_INFINITY,
    });
  const decidir = (l: LinhaCrua, S: number) =>
    decidirEnvioEstoqueLi({ S, cap: Number.POSITIVE_INFINITY, linha: l });

  /** A managed row already showing the four-field body's situações, with a sendable S. */
  const jaNoCorpo = (l: LinhaCrua) =>
    l.gerenciado &&
    l.situacao_em_estoque === ESTOQUE_FIXO_ESCRITA_LI.situacao_em_estoque &&
    l.situacao_sem_estoque === ESTOQUE_FIXO_ESCRITA_LI.situacao_sem_estoque &&
    l.quantidade >= Math.max(0, l.quantidade_reservada);

  it('every managed row at the body’s situações is REFLECTED for S = quantidade − reservada, and in sync for the reconcile', () => {
    const linhas = linhasDistintas().filter(jaNoCorpo);
    expect(linhas.length).toBe(639);
    for (const [i, l] of linhas.entries()) {
      const S = l.quantidade - Math.max(0, l.quantidade_reservada);
      const d = decidir(l, S);
      expect(d.tipo === 'refletido' && d.quantidade === l.quantidade, `row ${String(i)}`).toBe(
        true,
      );
      expect(diff(l, S).tipo === 'em-dia', `row ${String(i)}`).toBe(true);
    }
  });

  it('a reserved row: model A’s target for S = quantidade − R is the store’s quantidade; NEAR-MISS: S = quantidade (R ignored) writes R units too many, and the store’s disponivel is not the reflected quantity', () => {
    const [l] = linhasDe(captura('loja1', 'estoque-p71')).filter((x) => x.quantidade_reservada > 0);
    if (l === undefined) throw new Error('the 71st page has no reserved row');
    const R = l.quantidade_reservada;
    expect(alvoEstoqueLi(l.quantidade - R, R) === l.quantidade).toBe(true);
    const errado = decidir(l, l.quantidade);
    expect(errado.tipo === 'escrever' && errado.corpo.quantidade === l.quantidade + R).toBe(true);
    expect(refletidoLi(l, l.quantidade_disponivel)).toBe(false);
    expect(refletidoLi(l, l.quantidade)).toBe(true);
  });

  it('no captured row is refused for its reservation: every one is readable', () => {
    const linhas = linhasDistintas();
    expect(linhas.length > 0).toBe(true);
    expect(linhas.filter((l) => decidir(l, 0).tipo === 'recusa').length).toBe(0);
  });

  it('every unmanaged row is never reflected — not even at its own quantity — and always an unbounded candidate', () => {
    const linhas = linhasDistintas().filter((l) => !l.gerenciado);
    expect(linhas.length).toBe(161);
    for (const [i, l] of linhas.entries()) {
      expect(refletidoLi(l, l.quantidade), `row ${String(i)}`).toBe(false);
      const d = diff(l, Math.max(0, l.quantidade));
      expect(d.tipo === 'candidato' && d.delta === DELTA_SEM_LIMITE_LI, `row ${String(i)}`).toBe(
        true,
      );
    }
  });

  it('every negative managed row at S = 0 is written a sendable quantity, and is a reconcile candidate', () => {
    const linhas = linhasDistintas().filter((l) => l.gerenciado && l.quantidade < 0);
    expect(linhas.length).toBe(6);
    for (const [i, l] of linhas.entries()) {
      const d = decidir(l, 0);
      expect(
        d.tipo === 'escrever' && quantidadeDeEstoqueValidaLi(d.corpo.quantidade),
        `row ${String(i)}`,
      ).toBe(true);
      expect(diff(l, 0).tipo === 'candidato', `row ${String(i)}`).toBe(true);
    }
  });

  it('every smaller-store row still purchasable past zero (situacao_sem_estoque ≠ −1) is an unbounded candidate, and a managed one with a lead time is never reflected', () => {
    const linhas = linhasDoPasseio().filter(
      (l) => l.situacao_sem_estoque !== ESTOQUE_FIXO_ESCRITA_LI.situacao_sem_estoque,
    );
    expect(linhas.length).toBe(123);
    for (const [i, l] of linhas.entries()) {
      const d = diff(l, Math.max(0, l.quantidade));
      expect(d.tipo === 'candidato' && d.delta === DELTA_SEM_LIMITE_LI, `row ${String(i)}`).toBe(
        true,
      );
    }
    const comPrazo = linhasDoPasseio().filter(
      (l) => l.gerenciado && (l.situacao_em_estoque > 0 || l.situacao_sem_estoque > 0),
    );
    expect(comPrazo.length).toBe(12);
    expect(comPrazo.some((l) => refletidoLi(l, l.quantidade))).toBe(false);
  });
});
