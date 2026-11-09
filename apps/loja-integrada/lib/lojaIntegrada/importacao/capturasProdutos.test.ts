/**
 * Capture C10 — the owner's read-only PRODUCT captures (step 9) — replayed through the reads the
 * product import runs: the package's `lerPaginaProdutosLi` and `buscarProdutoLi` over the REAL
 * client, then the shared readers `lerProdutoLi` and `lerDetalheProdutoLi`, the schemas the job
 * stores their views under (`paginaListagemLiSchema`, `detalheProdutoLiSchema`), the family
 * assembly's own index (`indexarSnapshotLi`, `orfaosAExplicarLi`) and the import's one unit
 * conversion (`medidasErpDoDetalheLi`). Two captures are requests the import never makes, so they
 * go through the package's generic page reader `lerPaginaLi` with the package's own row schema:
 * the unfiltered first page and the refused page size.
 *
 * The captures, `c10-<store>-<what>.json`: both stores' first live page (`removido=false`,
 * `limit=50`) and trash list (`removido=true`); the larger store's second and last live pages,
 * its unfiltered first page, its first page at `limit=100` and the `limit=200` refusal; one
 * parent's detail, the detail of one of its variations, a trashed parent's detail, and an id the
 * store does not have.
 *
 * What this file pins, each on the captures themselves:
 *
 *  - (a) every request the package builds is a captured one, up to the two differences
 *    {@link consultaComparavel} names, and every capture a case replays is consumed;
 *  - (b) every row and every detail parses through the package and reads through the shared
 *    readers: no row without an id, no unreadable URI, no unknown `tipo`, and every view parses
 *    as the job stores it;
 *  - (c) `limit=50` and `limit=100` are honoured (`meta.limit`), the import asks for the page size
 *    measured to work, and `limit=200` answers a 400 whose body is the API gateway's
 *    `{Code, OperationId, Message}` — an `LiHttpError` that is not transient and not a 404;
 *  - (d) the next offsets the package returns walk the captured pages, and the last page ends
 *    at `total_count`;
 *  - (e) the trash lists hold parents only (`atributo`, one `normal`), all `removido: true`, and
 *    the variations those parents claim are claimed by no listed parent and are not trash rows:
 *    the live rows the assembly places "na lixeira" without a detail read;
 *  - (f) a parent's detail carries `filhos`, `grades`, images and a brand; a variation's carries
 *    its own `peso` (a decimal STRING) and integer dimensions, its `pai` and its two-id
 *    `variacoes`, and no images or categories; a trashed parent's detail says so; an unknown id
 *    is a 404 with an empty body;
 *  - (g) `total_count`: the filtered list plus the trash is the unfiltered list;
 *  - (h) one product is one SKU in every capture, and distinct products carry distinct SKUs;
 *  - (i) the product captures share the step-10 catalogue captures' pseudonym key: every
 *    category, grade, option and brand a product names is a row of the SAME store's C9 lists.
 *
 * Facts of the whole catalogue (page counts, rows per `tipo` over every page) come from the
 * owner's counts-only pass, not from a capture, and are not pinned here.
 *
 * ⚠️ Every assertion is a boolean or a count, labelled with the fixture name, so a failure never
 * prints a body value (the `wireCorpus.test.ts` convention). Fixtures are read only through the
 * corpus loader. The ids and SKUs are the sanitizer's pseudonyms; nothing here names one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAMINHO_PRODUTOS_LI,
  LiAuthError,
  LiConfigError,
  LiHttpError,
  LiNotFoundError,
  MAX_LIMITE_PAGINA_PRODUTOS_LI,
  type PaginaUnicaLi,
  type ProdutoLinhaLi,
  buscarProdutoLi,
  criarClienteLeituraLi,
  lerPaginaLi,
  lerPaginaProdutosLi,
  liProdutoLinhaSchema,
} from '@delfrance/integrations-loja-integrada';
import {
  ESTADO_DETALHE_IMPORTACAO_LI,
  LIMITE_PAGINA_PRODUTOS_LI,
  type ProdutoLiDetalhado,
  type ProdutoLiLido,
  RECURSO_URI_LI,
  TIPO_PAGINA_IMPORTACAO_LI,
  TIPO_PRODUTO_LI,
  detalheProdutoLiSchema,
  idDoRecursoLi,
  lerDetalheProdutoLi,
  lerProdutoLi,
  medidaPositivaLi,
  paginaListagemLiSchema,
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
import { medidasErpDoDetalheLi } from './completar';
import { indexarSnapshotLi, orfaosAExplicarLi } from './familias';
import { linhaPertenceALista } from './listagem';

/* -------------------------------------------------------------------------- */
/*                                 The corpus                                  */
/* -------------------------------------------------------------------------- */

/** A capture's file name: `c<round>-<store>-<what>.json`. */
const NOME_DE_CAPTURA = /^(c\d+)-(loja\d+)-([a-z0-9-]+)\.json$/;

/** Every product capture, per store, by what it is. A capture that disappears fails here. */
const CAPTURAS_C10: Readonly<Record<string, readonly string[]>> = {
  loja1: [
    'limite-100',
    'limite-200',
    'produto-filho',
    'produto-inexistente',
    'produto-lixeira',
    'produto-pai',
    'produtos',
    'produtos-lixeira',
    'produtos-p162',
    'produtos-p2',
    'produtos-sem-filtro',
  ],
  loja2: ['produtos', 'produtos-lixeira'],
};

/** The live-list pages (`removido=false`): the import's listing. */
const PAGINAS_VIVAS = ['produtos', 'produtos-p2', 'produtos-p162', 'limite-100'] as const;

/** A credential for the replay platform below; it never leaves this file. */
const CREDENCIAL_DE_TESTE = { token: 'token-de-teste-produtos', ref: 'conta-de-teste' } as const;

/** Any fixed stamp: the stored schemas need one, its value is not under test. */
const LIDA_EM_MS = Date.UTC(2026, 10, 3);

interface Captura {
  readonly nome: string;
  readonly rodada: string;
  readonly loja: string;
  readonly tipo: string;
  readonly envelope: EnvelopeFixtureLi;
}

/** Every capture of rounds C9 and C10, through the corpus loader. */
function capturas(): Captura[] {
  return listarArquivosDoCorpusLi()
    .filter((nome) => nome.startsWith('c9-') || nome.startsWith('c10-'))
    .map((nome) => {
      const partes = NOME_DE_CAPTURA.exec(nome);
      if (partes === null) throw new Error(`${nome}: not a c<round>-<store>-<what> name`);
      const leitura = lerFixtureLi(readFileSync(join(DIRETORIO_WIRE_LI, nome), 'utf8'));
      // ⚠️ Never print a failed reading: its `nao-json` arm carries the raw text.
      if (!leitura.ok) throw new Error(`${nome}: not a valid fixture envelope`);
      return {
        nome,
        rodada: partes[1] ?? '',
        loja: partes[2] ?? '',
        tipo: partes[3] ?? '',
        envelope: leitura.data,
      };
    });
}

const TODAS = capturas();
const C10 = TODAS.filter((c) => c.rodada === 'c10');
const LOJAS = Object.keys(CAPTURAS_C10).sort();

function captura(loja: string, tipo: string, rodada = 'c10'): Captura {
  const c = TODAS.find((x) => x.rodada === rodada && x.loja === loja && x.tipo === tipo);
  if (c === undefined) throw new Error(`${loja}: no ${rodada} ${tipo} capture`);
  return c;
}

/** The live pages a store has among {@link PAGINAS_VIVAS}. */
function paginasVivas(loja: string): Captura[] {
  return PAGINAS_VIVAS.flatMap((tipo) =>
    CAPTURAS_C10[loja]?.includes(tipo) ? [captura(loja, tipo)] : [],
  );
}

/* -------------------------------------------------------------------------- */
/*                                 The replay                                  */
/* -------------------------------------------------------------------------- */

const DETALHE_DE_PRODUTO = /^\/v1\/produto\/(\d+)\/$/;

/**
 * The query a request is compared on, as `chave=valor` in order. Exactly two differences between
 * the package's request and a captured one are the SAME request:
 *
 *  - `offset=0`: the package sends an offset on every page; the owner's first-page captures left
 *    it out, and the store's own `meta.offset` is 0 on each such page (pinned below);
 *  - `descricao_completa=1` on a product DETAIL: the variation's detail was captured with the
 *    flag, which the package never sends (the plain and flagged answers were byte-identical in
 *    the same capture round, `produtos.ts`).
 *
 * Anything else still differs: another offset, another value of the flag, the flag on a list.
 */
function consultaComparavel(
  caminho: string,
  query: readonly (readonly [string, string])[],
): string[] {
  return query
    .filter(([k, v]) => !(k === 'offset' && v === '0'))
    .filter(
      ([k, v]) => !(k === 'descricao_completa' && v === '1' && DETALHE_DE_PRODUTO.test(caminho)),
    )
    .map(([k, v]) => `${k}=${v}`);
}

/** Two requests are the same when their paths are and their comparable queries are, in order. */
function mesmaRequisicao(
  caminho: string,
  query: readonly (readonly [string, string])[],
  e: EnvelopeFixtureLi,
): boolean {
  if (caminho !== e.requisicao.caminho) return false;
  const a = consultaComparavel(caminho, query);
  const b = consultaComparavel(e.requisicao.caminho, e.requisicao.query);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The captured answer, as the store sent it: a JSON body, or none. */
function respostaDe(c: Captura): Response {
  const { status, forma, corpo } = c.envelope.resposta;
  if (forma === 'vazio') return new Response(null, { status });
  if (forma !== 'json') throw new Error(`${c.nome}: no product capture has a text body`);
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The package's reads over the REAL client, against a platform answering ONLY a request that is
 * one of `fixtures` (a 500 otherwise). Returns which fixtures were consumed, how many requests were
 * sent and how many matched none.
 */
function replay(fixtures: readonly Captura[]) {
  const consumidas = new Set<string>();
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
    consumidas.add(c.nome);
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

/** The parts of a list body this file reads before any package schema touches it. */
const listaBruta = z
  .object({
    meta: z
      .object({
        limit: z.number(),
        offset: z.number(),
        total_count: z.number(),
        next: z.string().nullable(),
      })
      .passthrough(),
    objects: z.array(z.object({ id: z.number() }).passthrough()),
  })
  .passthrough();

function listaDe(c: Captura): z.infer<typeof listaBruta> {
  const r = listaBruta.safeParse(c.envelope.resposta.corpo);
  if (!r.success) throw new Error(`${c.nome}: not a list body`);
  return r.data;
}

/** A query value of the captured request (`undefined` when it has none). */
function parametro(c: Captura, chave: string): string | undefined {
  return c.envelope.requisicao.query.find(([k]) => k === chave)?.[1];
}

/** The id a detail capture asked for, from its path. */
function idPedido(c: Captura): number {
  const id = DETALHE_DE_PRODUTO.exec(c.envelope.requisicao.caminho)?.[1];
  if (id === undefined) throw new Error(`${c.nome}: not a product detail path`);
  return Number(id);
}

interface PaginaLida {
  readonly pagina: PaginaUnicaLi<ProdutoLinhaLi>;
  readonly vistas: readonly (ProdutoLiLido | null)[];
  readonly offset: number;
  readonly limite: number;
  readonly removido: boolean;
  readonly consumidas: number;
  readonly semCaptura: number;
}

/** One live or trash page, asked exactly as its capture was, through the package and the reader. */
async function lerPagina(c: Captura): Promise<PaginaLida> {
  const offset = Number(parametro(c, 'offset') ?? '0');
  const limite = Number(parametro(c, 'limit'));
  const removido = parametro(c, 'removido') === 'true';
  const r = replay([c]);
  const pagina = await lerPaginaProdutosLi(r.cliente, { offset, limite, removido });
  return {
    pagina,
    vistas: pagina.linhas.map(lerProdutoLi),
    offset,
    limite,
    removido,
    consumidas: r.consumidas.size,
    semCaptura: r.semCaptura(),
  };
}

const ehVista = (v: ProdutoLiLido | null): v is ProdutoLiLido => v !== null;

/** The views of a store's pages, the unreadable ones dropped (they are pinned at zero below). */
async function vistasDe(fixtures: readonly Captura[]): Promise<ProdutoLiLido[]> {
  const vistas: ProdutoLiLido[] = [];
  for (const c of fixtures) vistas.push(...(await lerPagina(c)).vistas.filter(ehVista));
  return vistas;
}

/** One detail, through the package and the shared reader. */
async function lerDetalhe(c: Captura): Promise<{
  readonly vista: ProdutoLiDetalhado | null;
  readonly consumidas: number;
  readonly semCaptura: number;
}> {
  const r = replay([c]);
  const lida = await buscarProdutoLi(r.cliente, idPedido(c));
  return {
    vista: lerDetalheProdutoLi(lida.dados),
    consumidas: r.consumidas.size,
    semCaptura: r.semCaptura(),
  };
}

async function detalheLido(c: Captura): Promise<ProdutoLiDetalhado> {
  const { vista } = await lerDetalhe(c);
  if (vista === null) throw new Error(`${c.nome}: the detail has no usable id`);
  return vista;
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

const semIlegiveis = (v: ProdutoLiLido) =>
  v.ilegiveis.filhos === 0 && v.ilegiveis.categorias === 0 && v.ilegiveis.opcoes === 0;

const mesmoConjunto = (a: Iterable<number>, b: Iterable<number>) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((i) => y.has(i));
};

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
    throw new Error('the C10 replay never calls the global fetch');
  });
  vi.stubGlobal('fetch', fetchGlobal);
});

afterEach(() => {
  expect(fetchGlobal).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('C10 — the corpus', () => {
  it('holds the 13 product captures of two stores, every one a GET under a Personal Token on the catalogue class', () => {
    const esperadas = LOJAS.flatMap((loja) =>
      (CAPTURAS_C10[loja] ?? []).map((t) => `${loja} ${t}`),
    );
    expect(C10.map((c) => `${c.loja} ${c.tipo}`).sort()).toEqual(esperadas.sort());
    expect(C10).toHaveLength(13);
    for (const c of C10) {
      expect(c.envelope.requisicao.metodo === 'GET', c.nome).toBe(true);
      expect(c.envelope.credencial === 'personal-token', c.nome).toBe(true);
      expect(c.envelope.resposta.politica === 'catalogo', c.nome).toBe(true);
      const { caminho } = c.envelope.requisicao;
      expect(caminho === CAMINHO_PRODUTOS_LI || DETALHE_DE_PRODUTO.test(caminho), c.nome).toBe(
        true,
      );
    }
  });

  it('every capture answered 200, except the refused page size (400) and the unknown id (404)', () => {
    const status = (loja: string, tipo: string) => captura(loja, tipo).envelope.resposta.status;
    expect(status('loja1', 'limite-200')).toBe(400);
    expect(status('loja1', 'produto-inexistente')).toBe(404);
    const outras = C10.filter((c) => c.tipo !== 'limite-200' && c.tipo !== 'produto-inexistente');
    expect(outras).toHaveLength(11);
    for (const c of outras) expect(c.envelope.resposta.status === 200, c.nome).toBe(true);
  });
});

describe('the replay: which differences are one request', () => {
  const pagina1 = captura('loja1', 'produtos');

  it('EQUAL: the package’s explicit offset=0 is the first-page capture with none', () => {
    expect(
      mesmaRequisicao(
        CAMINHO_PRODUTOS_LI,
        [
          ['limit', '50'],
          ['removido', 'false'],
          ['offset', '0'],
        ],
        pagina1.envelope,
      ),
    ).toBe(true);
  });

  it('NEAR-MISS: another offset, another filter or another limit is another request', () => {
    const outra = (query: readonly (readonly [string, string])[]) =>
      mesmaRequisicao(CAMINHO_PRODUTOS_LI, query, pagina1.envelope);
    expect(
      outra([
        ['limit', '50'],
        ['removido', 'false'],
        ['offset', '50'],
      ]),
    ).toBe(false);
    expect(
      outra([
        ['limit', '50'],
        ['removido', 'true'],
        ['offset', '0'],
      ]),
    ).toBe(false);
    expect(
      outra([
        ['limit', '50'],
        ['offset', '0'],
      ]),
    ).toBe(false);
    expect(
      outra([
        ['limit', '100'],
        ['removido', 'false'],
        ['offset', '0'],
      ]),
    ).toBe(false);
    // The order of the keys is part of the request.
    expect(
      outra([
        ['removido', 'false'],
        ['limit', '50'],
        ['offset', '0'],
      ]),
    ).toBe(false);
  });

  it('EQUAL: a detail asked with no query is the detail captured with descricao_completa=1', () => {
    const filho = captura('loja1', 'produto-filho');
    expect(mesmaRequisicao(filho.envelope.requisicao.caminho, [], filho.envelope)).toBe(true);
  });

  it('NEAR-MISS: the flag with another value, or on a list, still differs', () => {
    const filho = captura('loja1', 'produto-filho');
    const caminho = filho.envelope.requisicao.caminho;
    expect(mesmaRequisicao(caminho, [['descricao_completa', '0']], filho.envelope)).toBe(false);
    expect(
      consultaComparavel(CAMINHO_PRODUTOS_LI, [
        ['limit', '50'],
        ['descricao_completa', '1'],
      ]),
    ).toEqual(['limit=50', 'descricao_completa=1']);
  });
});

describe('C10 — (a)(b) the product lists, through the package and the shared reader', () => {
  const LISTAS = C10.filter(
    (c) =>
      c.envelope.resposta.status === 200 &&
      c.envelope.requisicao.caminho === CAMINHO_PRODUTOS_LI &&
      c.tipo !== 'produtos-sem-filtro',
  );

  it('seven pages the import asks for: five live, two trash', () => {
    expect(LISTAS).toHaveLength(7);
    expect(LISTAS.filter((c) => parametro(c, 'removido') === 'false')).toHaveLength(5);
    expect(LISTAS.filter((c) => parametro(c, 'removido') === 'true')).toHaveLength(2);
  });

  it.each(LISTAS.map((c) => [c.nome, c] as const))(
    '%s: the captured request, every row read and in its list, meta.limit honoured, the page stored as the job stores it',
    async (nome, c) => {
      const lida = await lerPagina(c);
      const bruta = listaDe(c);

      // (a) the package asked exactly the captured request.
      expect(lida.semCaptura, nome).toBe(0);
      expect(lida.consumidas, nome).toBe(1);
      // (b) every row came through the package, and every row reads.
      expect(lida.pagina.linhas.length === bruta.objects.length, nome).toBe(true);
      expect(lida.vistas.every(ehVista), nome).toBe(true);
      const vistas = lida.vistas.filter(ehVista);
      expect(vistas.every(semIlegiveis), nome).toBe(true);
      expect(
        vistas.every((v) => v.tipo !== TIPO_PRODUTO_LI.desconhecido),
        nome,
      ).toBe(true);
      expect(
        vistas.every((v) => v.sku !== null),
        `${nome}: every row has a SKU`,
      ).toBe(true);
      // Every row says what its list's filter says (the import re-checks each one).
      const tipo = lida.removido
        ? TIPO_PAGINA_IMPORTACAO_LI.lixeira
        : TIPO_PAGINA_IMPORTACAO_LI.listagem;
      expect(
        vistas.every((v) => linhaPertenceALista(tipo, v)),
        nome,
      ).toBe(true);
      // (c) the size asked is the size applied, and no page holds more.
      expect(lida.pagina.meta.limit === lida.limite, nome).toBe(true);
      expect(lida.pagina.linhas.length <= lida.limite, nome).toBe(true);
      // The page as `listagem.ts` writes it.
      expect(
        paginaListagemLiSchema.safeParse({
          tipo,
          offset: lida.offset,
          linhas: vistas,
          linhasSemId: 0,
          limiteLido: lida.pagina.meta.limit,
          totalLi: lida.pagina.meta.total_count ?? null,
          lidaEmMs: LIDA_EM_MS,
        }).success,
        nome,
      ).toBe(true);
    },
  );
});

describe('C10 — (c) the page size', () => {
  it('limit=50 is honoured: a full page of 50 on every page but the last of its list', async () => {
    const de50 = C10.filter(
      (c) => parametro(c, 'limit') === '50' && c.envelope.resposta.status === 200,
    );
    expect(de50).toHaveLength(7);
    for (const c of de50) {
      const lida = await metaDaLista(c);
      expect(lida.limit === 50, c.nome).toBe(true);
      const ultima = lida.next === null;
      expect(ultima ? lida.linhas <= 50 && lida.linhas > 0 : lida.linhas === 50, c.nome).toBe(true);
    }
  });

  it('limit=100 is honoured, and it is the page size the import asks for: one page of 100 is the first two pages of 50', async () => {
    expect(LIMITE_PAGINA_PRODUTOS_LI).toBe(MAX_LIMITE_PAGINA_PRODUTOS_LI);
    const de100 = await lerPagina(captura('loja1', 'limite-100'));
    expect(de100.limite).toBe(LIMITE_PAGINA_PRODUTOS_LI);
    expect(de100.pagina.meta.limit).toBe(LIMITE_PAGINA_PRODUTOS_LI);
    expect(de100.pagina.linhas).toHaveLength(LIMITE_PAGINA_PRODUTOS_LI);
    expect(de100.pagina.proximoOffset).toBe(LIMITE_PAGINA_PRODUTOS_LI);

    const ids = (p: PaginaLida) => p.pagina.linhas.map((l) => l.id);
    const p1 = await lerPagina(captura('loja1', 'produtos'));
    const p2 = await lerPagina(captura('loja1', 'produtos-p2'));
    // EQUAL: the 100 rows are the rows of pages 1 and 2 at 50 — none skipped, none added.
    expect(mesmoConjunto(ids(de100), [...ids(p1), ...ids(p2)])).toBe(true);
    // NEAR-MISS: page 1 alone is not.
    expect(mesmoConjunto(ids(de100), ids(p1))).toBe(false);
  });

  it('limit=200 is refused before anything is fetched: above the package’s ceiling', async () => {
    const c = captura('loja1', 'limite-200');
    const limite = Number(parametro(c, 'limit'));
    expect(limite > MAX_LIMITE_PAGINA_PRODUTOS_LI).toBe(true);
    const r = replay([c]);
    const erro = await rejeicaoDe(
      lerPaginaProdutosLi(r.cliente, { offset: 0, limite, removido: false }),
    );
    expect(erro instanceof LiConfigError).toBe(true);
    expect(r.enviadas()).toBe(0);
  });

  it('limit=200, sent anyway: a 400 whose body is the gateway’s {Code, OperationId, Message} — an LiHttpError, not transient, not a 404, not an auth failure', async () => {
    const c = captura('loja1', 'limite-200');
    const r = replay([c]);
    const erro = await rejeicaoDe(
      lerPaginaLi(r.cliente, {
        operacao: 'c10-limite-200',
        caminho: CAMINHO_PRODUTOS_LI,
        esquema: liProdutoLinhaSchema,
        offset: 0,
        limite: Number(parametro(c, 'limit')),
        query: { removido: false },
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
  });
});

/** A list capture's `meta.limit`, `meta.next` and row count, as the package read them. */
async function metaDaLista(c: Captura): Promise<{
  readonly limit: number;
  readonly next: string | null;
  readonly linhas: number;
}> {
  if (c.tipo === 'produtos-sem-filtro') {
    const p = await lerSemFiltro(c);
    return { limit: p.pagina.meta.limit, next: p.pagina.meta.next, linhas: p.pagina.linhas.length };
  }
  const p = await lerPagina(c);
  return { limit: p.pagina.meta.limit, next: p.pagina.meta.next, linhas: p.pagina.linhas.length };
}

/**
 * The unfiltered first page: the import never asks for it (it always sends `removido`), so it is
 * read through the package's generic page reader with the package's own row schema.
 */
async function lerSemFiltro(c: Captura) {
  const r = replay([c]);
  const pagina = await lerPaginaLi(r.cliente, {
    operacao: 'c10-sem-filtro',
    caminho: CAMINHO_PRODUTOS_LI,
    esquema: liProdutoLinhaSchema,
    offset: 0,
    limite: Number(parametro(c, 'limit')),
  });
  return { pagina, consumidas: r.consumidas.size, semCaptura: r.semCaptura() };
}

describe('C10 — (d) paging', () => {
  it('the first pages say offset 0, the replay’s one offset rule', () => {
    for (const c of C10.filter(
      (x) =>
        x.envelope.resposta.status === 200 && x.envelope.requisicao.caminho === CAMINHO_PRODUTOS_LI,
    )) {
      if (parametro(c, 'offset') !== undefined) continue;
      expect(listaDe(c).meta.offset === 0, c.nome).toBe(true);
    }
  });

  it('the larger store: page 1 points at page 2, page 2 past it, and the last page ends at total_count', async () => {
    const p1 = await lerPagina(captura('loja1', 'produtos'));
    const p2 = await lerPagina(captura('loja1', 'produtos-p2'));
    const ultima = await lerPagina(captura('loja1', 'produtos-p162'));

    expect(p1.pagina.proximoOffset).toBe(p2.offset);
    expect(p2.pagina.proximoOffset).toBe(p2.offset + p2.limite);
    expect(ultima.pagina.proximoOffset).toBe(null);
    const total = p1.pagina.meta.total_count;
    expect(ultima.offset + ultima.pagina.linhas.length === total).toBe(true);
    expect(ultima.offset < (total ?? 0)).toBe(true);
    // Every live page of the store announces the same total.
    for (const c of paginasVivas('loja1')) {
      expect((await lerPagina(c)).pagina.meta.total_count === total, c.nome).toBe(true);
    }
  });

  it.each(LOJAS)('%s: the trash list is one page, ending at its total_count', async (loja) => {
    const lixeira = await lerPagina(captura(loja, 'produtos-lixeira'));
    expect(lixeira.pagina.proximoOffset).toBe(null);
    expect(lixeira.pagina.linhas.length === lixeira.pagina.meta.total_count).toBe(true);
  });
});

/** Rows per `tipo` in each trash list, as captured. */
const TIPOS_NA_LIXEIRA: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  loja1: { atributo: 34, normal: 1 },
  loja2: { atributo: 40 },
};

/**
 * The variations each store's trash list claims. They equal the counts of live variation rows no
 * listed parent claims that the owner's counts-only pass reported over each WHOLE catalogue —
 * matched row for row in the larger store; in the other, the counts agree. None of those rows sits
 * on a committed page, so the pin here is the count and the disjointness, not the membership.
 */
const REIVINDICADOS_NA_LIXEIRA: Readonly<Record<string, number>> = { loja1: 157, loja2: 171 };

/** The live variation rows of the committed pages that no committed parent claims (cross-page). */
const ORFAOS_NAS_PAGINAS: Readonly<Record<string, number>> = { loja1: 9, loja2: 1 };

describe('C10 — (e) the trash lists, through the assembly’s own index', () => {
  it.each(LOJAS)(
    '%s: parents only, all removido; what they claim is claimed by no listed parent and is no trash row',
    async (loja) => {
      const lixeira = await vistasDe([captura(loja, 'produtos-lixeira')]);
      const vivas = await vistasDe(paginasVivas(loja));

      // Parents and simple products only, every one trashed.
      const porTipo: Record<string, number> = {};
      for (const v of lixeira) porTipo[v.tipo] = (porTipo[v.tipo] ?? 0) + 1;
      expect(porTipo).toEqual(TIPOS_NA_LIXEIRA[loja]);
      expect(lixeira.every((v) => v.removido === true)).toBe(true);

      const indice = indexarSnapshotLi({ listagem: vivas, lixeira });
      expect(indice.lixeira.size).toBe(lixeira.length);
      // No product is in both lists: the live index lost no row to the trash.
      expect(indice.ativos.size).toBe(new Set(vivas.map((v) => v.id)).size);

      const naLixeira = indice.reivindicadosNaLixeira;
      expect(naLixeira.size).toBe(REIVINDICADOS_NA_LIXEIRA[loja]);
      const reivindicadosVivos = new Set(indice.reivindicacoes.keys());
      expect(reivindicadosVivos.size > 0).toBe(true);
      // Disjoint from every listed parent's claims, and never a trash row itself.
      expect([...naLixeira].some((id) => reivindicadosVivos.has(id))).toBe(false);
      expect([...naLixeira].some((id) => indice.lixeira.has(id))).toBe(false);
      // Each live claim belongs to exactly one listed parent.
      expect([...indice.reivindicacoes.values()].every((pais) => pais.length === 1)).toBe(true);

      // NEAR-MISS: a live variation no committed parent claims and the trash does NOT claim stays an
      // orphan to explain by its detail — the trash explains only what it claims.
      const orfaos = orfaosAExplicarLi(indice);
      expect(orfaos).toHaveLength(ORFAOS_NAS_PAGINAS[loja] ?? -1);
      expect(orfaos.some((id) => naLixeira.has(id))).toBe(false);
      expect(
        orfaos.every((id) => indice.ativos.get(id)?.tipo === TIPO_PRODUTO_LI.atributoOpcao),
      ).toBe(true);
    },
  );
});

describe('C10 — (f) the details, through the package and the shared reader', () => {
  it('every detail is the product its path names, and parses as the job stores it', async () => {
    for (const tipo of ['produto-pai', 'produto-filho', 'produto-lixeira']) {
      const c = captura('loja1', tipo);
      const { vista, consumidas, semCaptura } = await lerDetalhe(c);
      expect(semCaptura, c.nome).toBe(0);
      expect(consumidas, c.nome).toBe(1);
      expect(vista?.id === idPedido(c), c.nome).toBe(true);
      expect(vista !== null && semIlegiveis(vista), c.nome).toBe(true);
      expect(vista?.paiIlegivel === false, c.nome).toBe(true);
      expect(vista?.imagensDescartadas === 0, c.nome).toBe(true);
      expect(
        detalheProdutoLiSchema.safeParse({
          liId: idPedido(c),
          estado: ESTADO_DETALHE_IMPORTACAO_LI.lido,
          detalhe: vista,
          lidoEmMs: LIDA_EM_MS,
        }).success,
        c.nome,
      ).toBe(true);
    }
  });

  it('a parent: its variations, its grades, its images (the principal first), its brand and no parent', async () => {
    const pai = await detalheLido(captura('loja1', 'produto-pai'));
    expect(pai.tipo).toBe(TIPO_PRODUTO_LI.atributo);
    expect(pai.removido).toBe(false);
    expect(pai.filhoIds).toHaveLength(24);
    expect(pai.grades).toHaveLength(2);
    expect(pai.imagens).toHaveLength(12);
    expect(pai.imagens[0]?.principal).toBe(true);
    expect(pai.imagens.filter((i) => i.principal)).toHaveLength(1);
    expect(pai.marcaId !== null).toBe(true);
    expect(pai.paiId).toBe(null);
    expect(pai.categoriaIds.length > 0).toBe(true);
    expect(pai.descricao !== null && !pai.descricaoLonga).toBe(true);
    expect(pai.opcoes).toHaveLength(0);
  });

  it('EQUAL: the parent’s list row claims the same variations and carries the same SKU as its detail; every variation is a live row of the committed pages', async () => {
    const pai = await detalheLido(captura('loja1', 'produto-pai'));
    const vivas = await vistasDe(paginasVivas('loja1'));
    const linha = vivas.find((v) => v.id === pai.id);
    expect(linha !== undefined).toBe(true);
    expect(mesmoConjunto(linha?.filhoIds ?? [], pai.filhoIds)).toBe(true);
    expect(linha?.sku === pai.sku).toBe(true);
    const ids = new Set(vivas.map((v) => v.id));
    expect(pai.filhoIds.every((id) => ids.has(id))).toBe(true);
  });

  it('a variation: its own peso (a decimal STRING) and integer dimensions on the wire, its pai, two options of its parent’s grades, no images, no categories', async () => {
    const c = captura('loja1', 'produto-filho');
    const corpo = corpoObjeto(c);
    const filho = await detalheLido(c);
    const pai = await detalheLido(captura('loja1', 'produto-pai'));

    // The wire forms.
    const { peso } = corpo;
    expect(typeof peso === 'string' && /^[0-9]+\.[0-9]+$/.test(peso)).toBe(true);
    for (const chave of ['altura', 'largura', 'profundidade']) {
      expect(Number.isInteger(corpo[chave]), chave).toBe(true);
    }
    // A variation's detail carries no `filhos` and no `grades` at all.
    expect('filhos' in corpo || 'grades' in corpo).toBe(false);
    expect(Array.isArray(corpo.imagens) && corpo.imagens.length === 0).toBe(true);
    expect(corpo.imagem_principal).toBe(null);

    // The view.
    expect(filho.tipo).toBe(TIPO_PRODUTO_LI.atributoOpcao);
    expect(filho.pesoKg === Number(peso)).toBe(true);
    expect(
      [filho.alturaCm, filho.larguraCm, filho.profundidadeCm].every((d) => Number.isInteger(d)),
    ).toBe(true);
    expect(filho.paiId === pai.id).toBe(true);
    expect(pai.filhoIds.includes(filho.id)).toBe(true);
    expect(filho.imagens).toHaveLength(0);
    expect(filho.categoriaIds).toHaveLength(0);
    expect(filho.filhoIds).toHaveLength(0);
    // Two-id options, one per grade, each a grade of its parent.
    expect(filho.variacoes).toHaveLength(2);
    expect(filho.opcoes).toHaveLength(2);
    const gradesDoPai = new Set(pai.grades.map((g) => idDoRecursoLi(g, RECURSO_URI_LI.grades)));
    expect(new Set(filho.opcoes.map((o) => o.gradeId)).size).toBe(2);
    expect(filho.opcoes.every((o) => gradesDoPai.has(o.gradeId))).toBe(true);
  });

  it('a variation’s measures reach the ERP as the store wrote them: kilograms and centimetres, no conversion', async () => {
    const c = captura('loja1', 'produto-filho');
    const filho = await detalheLido(c);
    const medidas = medidasErpDoDetalheLi(filho);
    expect(medidas.pesoKg !== null && medidas.pesoKg === filho.pesoKg).toBe(true);
    expect(medidas.alturaCm === filho.alturaCm).toBe(true);
    expect(medidas.larguraCm === filho.larguraCm).toBe(true);
    expect(medidas.profundidadeCm === filho.profundidadeCm).toBe(true);
    // The variation carries all three of its own, so it never inherits its parent's.
    expect(
      [medidas.alturaCm, medidas.larguraCm, medidas.profundidadeCm].every((d) => d !== null),
    ).toBe(true);
    // NEAR-MISS: the captured weight with a decimal COMMA is no measure at all.
    const { peso } = corpoObjeto(c);
    expect(typeof peso === 'string' && medidaPositivaLi(peso.replace('.', ',')) === null).toBe(
      true,
    );
  });

  it('a trashed parent: its detail says removido and hidden, it is a row of the trash list, and what it claims is what its row claims', async () => {
    const lixo = await detalheLido(captura('loja1', 'produto-lixeira'));
    expect(lixo.tipo).toBe(TIPO_PRODUTO_LI.atributo);
    expect(lixo.removido).toBe(true);
    expect(lixo.ativo).toBe(false);
    const lixeira = await vistasDe([captura('loja1', 'produtos-lixeira')]);
    const linha = lixeira.find((v) => v.id === lixo.id);
    expect(linha !== undefined).toBe(true);
    expect(lixo.filhoIds.length > 0).toBe(true);
    expect(mesmoConjunto(linha?.filhoIds ?? [], lixo.filhoIds)).toBe(true);
    const indice = indexarSnapshotLi({ listagem: [], lixeira });
    expect(lixo.filhoIds.every((id) => indice.reivindicadosNaLixeira.has(id))).toBe(true);
  });

  it('an unknown id: a 404 with an empty body, which the package reads as LiNotFoundError', async () => {
    const c = captura('loja1', 'produto-inexistente');
    expect(c.envelope.resposta.forma).toBe('vazio');
    expect(c.envelope.resposta.bytes).toBe(0);
    expect(c.envelope.resposta.corpo).toBe(null);
    const r = replay([c]);
    const erro = await rejeicaoDe(buscarProdutoLi(r.cliente, idPedido(c)));
    expect(r.semCaptura()).toBe(0);
    expect(r.consumidas.size).toBe(1);
    expect(erro instanceof LiNotFoundError).toBe(true);
    expect(erro instanceof LiNotFoundError && erro.status === 404).toBe(true);
  });
});

describe('C10 — (g) total_count against the unfiltered list', () => {
  it('the unfiltered page parses through the package’s row schema and reads through the shared reader', async () => {
    const c = captura('loja1', 'produtos-sem-filtro');
    const { pagina, consumidas, semCaptura } = await lerSemFiltro(c);
    expect(semCaptura).toBe(0);
    expect(consumidas).toBe(1);
    expect(pagina.linhas.length === listaDe(c).objects.length).toBe(true);
    const vistas = pagina.linhas.map(lerProdutoLi);
    expect(vistas.every(ehVista)).toBe(true);
    expect(vistas.filter(ehVista).every(semIlegiveis)).toBe(true);
  });

  it('EQUAL: filtered + trash = unfiltered; NEAR-MISS: the filtered total alone is not (the filter works)', () => {
    const filtrada = listaDe(captura('loja1', 'produtos')).meta.total_count;
    const lixeira = listaDe(captura('loja1', 'produtos-lixeira')).meta.total_count;
    const semFiltro = listaDe(captura('loja1', 'produtos-sem-filtro')).meta.total_count;
    expect(filtrada + lixeira === semFiltro).toBe(true);
    expect(lixeira > 0).toBe(true);
    expect(filtrada === semFiltro).toBe(false);
  });
});

describe('C10 — (h) one product, one SKU', () => {
  it.each(LOJAS)(
    '%s: the same product carries the same SKU in every capture, and distinct products distinct SKUs',
    async (loja) => {
      const fixtures = C10.filter((c) => c.loja === loja && c.envelope.resposta.status === 200);
      const skuPorId = new Map<number, string | null>();
      let repetidas = 0;
      let divergentes = 0;
      const registrar = (v: ProdutoLiLido) => {
        if (!skuPorId.has(v.id)) {
          skuPorId.set(v.id, v.sku);
          return;
        }
        repetidas += 1;
        if (skuPorId.get(v.id) !== v.sku) divergentes += 1;
      };
      for (const c of fixtures) {
        if (DETALHE_DE_PRODUTO.test(c.envelope.requisicao.caminho)) registrar(await detalheLido(c));
        else if (c.tipo === 'produtos-sem-filtro') {
          for (const l of (await lerSemFiltro(c)).pagina.linhas) {
            const v = lerProdutoLi(l);
            if (v !== null) registrar(v);
          }
        } else for (const v of (await lerPagina(c)).vistas.filter(ehVista)) registrar(v);
      }
      expect(divergentes).toBe(0);
      const skus = [...skuPorId.values()];
      expect(skus.every((s) => s !== null)).toBe(true);
      expect(new Set(skus).size).toBe(skus.length);
      // Non-vacuous where a store has more than one capture of a product (pages that overlap).
      if (loja === 'loja1') expect(repetidas > 0).toBe(true);
    },
  );
});

/** The ids of a C9 list capture's rows (raw: the C9 suite pins their parse). */
function idsDaListaC9(loja: string, tipo: string): number[] {
  const r = z
    .object({ objects: z.array(z.object({ id: z.number() }).passthrough()) })
    .passthrough()
    .safeParse(captura(loja, tipo, 'c9').envelope.resposta.corpo);
  if (!r.success) throw new Error(`${loja}: c9 ${tipo} is not a list body`);
  return r.data.objects.map((o) => o.id);
}

/** Option id → grade id, over a store's two C9 grade details. */
function opcoesDetalhadasC9(loja: string): Map<number, number> {
  const opcoes = new Map<number, number>();
  for (const tipo of ['grade-propria', 'grade-sistema']) {
    const r = z
      .object({
        id: z.number(),
        variacoes: z.array(z.object({ id: z.number() }).passthrough()),
      })
      .passthrough()
      .safeParse(captura(loja, tipo, 'c9').envelope.resposta.corpo);
    if (!r.success) throw new Error(`${loja}: c9 ${tipo} is not a grade body`);
    for (const o of r.data.variacoes) opcoes.set(o.id, r.data.id);
  }
  return opcoes;
}

function categoriasC9(loja: string): Set<number> {
  const paginas = TODAS.filter(
    (c) => c.rodada === 'c9' && c.loja === loja && c.tipo.startsWith('categorias'),
  );
  return new Set(paginas.flatMap((c) => idsDaListaC9(loja, c.tipo)));
}

describe('C10 — (i) the product captures share the step-10 catalogue captures’ pseudonym key', () => {
  /** Every view of a store's product captures: the rows and the details. */
  async function vistasDaLoja(loja: string): Promise<{
    readonly linhas: readonly ProdutoLiLido[];
    readonly detalhes: readonly ProdutoLiDetalhado[];
  }> {
    const linhas = await vistasDe([...paginasVivas(loja), captura(loja, 'produtos-lixeira')]);
    const detalhes: ProdutoLiDetalhado[] = [];
    for (const tipo of ['produto-pai', 'produto-filho', 'produto-lixeira']) {
      if (CAPTURAS_C10[loja]?.includes(tipo)) detalhes.push(await detalheLido(captura(loja, tipo)));
    }
    return { linhas, detalhes };
  }

  it.each(LOJAS)(
    '%s: every category, grade, option grade and brand a product names is a row of the same store’s C9 lists; a detailed option names its own grade',
    async (loja) => {
      const { linhas, detalhes } = await vistasDaLoja(loja);
      const todas = [...linhas, ...detalhes];
      const categorias = categoriasC9(loja);
      const grades = new Set(idsDaListaC9(loja, 'grades'));
      const marcas = new Set(idsDaListaC9(loja, 'marcas'));
      const opcoesDetalhadas = opcoesDetalhadasC9(loja);

      const categoriasNomeadas = todas.flatMap((v) => v.categoriaIds);
      const gradesNomeadas = todas.flatMap((v) =>
        v.grades.map((g) => idDoRecursoLi(g, RECURSO_URI_LI.grades)),
      );
      const opcoes = todas.flatMap((v) => v.opcoes);
      const marcasNomeadas = detalhes.flatMap((d) => (d.marcaId === null ? [] : [d.marcaId]));

      expect(categoriasNomeadas.length > 0, `${loja}: categories`).toBe(true);
      expect(gradesNomeadas.length > 0, `${loja}: grades`).toBe(true);
      expect(opcoes.length > 0, `${loja}: options`).toBe(true);
      expect(
        categoriasNomeadas.every((id) => categorias.has(id)),
        `${loja}: categories`,
      ).toBe(true);
      expect(
        gradesNomeadas.every((id) => id !== null && grades.has(id)),
        `${loja}: grades`,
      ).toBe(true);
      expect(
        opcoes.every((o) => grades.has(o.gradeId)),
        `${loja}: option grades`,
      ).toBe(true);
      expect(
        marcasNomeadas.every((id) => marcas.has(id)),
        `${loja}: brands`,
      ).toBe(true);

      // An option of a grade the store's C9 detail lists names THAT grade.
      const detalhadas = opcoes.filter((o) => opcoesDetalhadas.has(o.opcaoId));
      expect(detalhadas.length > 0, `${loja}: detailed options`).toBe(true);
      expect(
        detalhadas.every((o) => opcoesDetalhadas.get(o.opcaoId) === o.gradeId),
        `${loja}: detailed options`,
      ).toBe(true);
    },
  );

  it('NEAR-MISS: the other store’s category list holds none of a store’s product categories', async () => {
    const [a, b] = LOJAS;
    if (a === undefined || b === undefined) throw new Error('two stores');
    const deA = (await vistasDaLoja(a)).linhas.flatMap((v) => v.categoriaIds);
    const deB = (await vistasDaLoja(b)).linhas.flatMap((v) => v.categoriaIds);
    expect(deA.some((id) => categoriasC9(b).has(id))).toBe(false);
    expect(deB.some((id) => categoriasC9(a).has(id))).toBe(false);
  });
});
