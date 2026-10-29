/**
 * Capture C9 — the owner's read-only catalogue captures (step 10): both stores' category, brand
 * and grade lists and two grade details per store — replayed through the package's OWN reads and
 * the contract's projections, exactly as the catalogue core runs them.
 *
 * The package's paths and row schemas, and the projections' URI reader, were written from the
 * public document; these captures are what confirm them, and this file is what keeps them
 * confirmed:
 *
 *  - (a) every request the package builds — path, trailing slash and query, `limit=50` on the
 *    lists and nothing on a detail — is byte for byte a captured request: the replay platform
 *    answers ONLY a request equal to a fixture's, and every fixture is consumed;
 *  - (b) every row of every captured body parses through the package's schema;
 *  - (c) the provider honoured `limit=50` on every page;
 *  - (d) the one list longer than a page (a store's categories) is read as two pages, page 2 at
 *    exactly `limit=50&offset=50` (the captured second page), every row of `total_count` kept,
 *    and the list ends there;
 *  - (e) each detail is the grade its path names, and each of its options names that grade
 *    through the one URI reader;
 *  - the projections read every row: no unreadable parent, no option of another grade or with
 *    an unreadable grade, no row without an id — and what they read is NOT vacuous (children
 *    exist, every parent is a category of the same list, every detailed grade is in its list).
 *
 * ⚠️ Every assertion is a boolean or a count, labelled with the fixture name, so a failure never
 * prints a body value (the `wireCorpus.test.ts` convention). Fixtures are read only through the
 * corpus loader. The ids are the sanitizer's pseudonyms; nothing here names one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAMINHO_CATEGORIAS_LI,
  CAMINHO_GRADES_LI,
  CAMINHO_MARCAS_LI,
  type ListaCatalogoLi,
  buscarGradeLi,
  criarClienteLeituraLi,
  listarCategoriasLi,
  listarGradesLi,
  listarMarcasLi,
} from '@delfrance/integrations-loja-integrada';
import {
  LIMITE_PAGINA_CATALOGO_LI,
  MAX_PAGINAS_CATALOGO_LI,
  RECURSO_URI_LI,
  TIPO_PAI_CATEGORIA_LI,
  idDoRecursoLi,
  mesmaGradeLi,
  projetarCategoriasLi,
  projetarGradeLi,
  projetarGradesLi,
  projetarMarcasLi,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  DIRETORIO_WIRE_LI,
  type EnvelopeFixtureLi,
  lerFixtureLi,
  listarArquivosDoCorpusLi,
} from '../fixtures/wireCorpus';

/** The catalogue captures: `c9-<store>-<what>.json`. */
const NOME_C9 = /^c9-(loja\d+)-(categorias-p2|categorias|marcas|grades|grade-[a-z]+)\.json$/;

/** The count committed by 10-r: a capture that disappears fails here. */
const FIXTURES_C9 = 11;

/** A credential for the replay platform below; it never leaves this file. */
const CREDENCIAL_DE_TESTE = { token: 'token-de-teste-catalogo', ref: 'conta-de-teste' } as const;

/** The parts of a body this file reads before any package schema touches it. */
const listaBruta = z
  .object({
    meta: z.object({ total_count: z.number(), next: z.unknown() }).passthrough(),
    objects: z.array(z.unknown()),
  })
  .passthrough();
const detalheBruto = z.object({ variacoes: z.array(z.unknown()) }).passthrough();

interface Captura {
  readonly nome: string;
  readonly loja: string;
  readonly tipo: string;
  readonly envelope: EnvelopeFixtureLi;
}

/** Every C9 capture, through the corpus loader. */
function capturas(): Captura[] {
  return listarArquivosDoCorpusLi()
    .filter((nome) => nome.startsWith('c9-'))
    .map((nome) => {
      const partes = NOME_C9.exec(nome);
      if (partes === null) throw new Error(`${nome}: not a c9-<store>-<what> name`);
      const leitura = lerFixtureLi(readFileSync(join(DIRETORIO_WIRE_LI, nome), 'utf8'));
      // ⚠️ Never print a failed reading: its `nao-json` arm carries the raw text.
      if (!leitura.ok) throw new Error(`${nome}: not a valid fixture envelope`);
      return { nome, loja: partes[1] ?? '', tipo: partes[2] ?? '', envelope: leitura.data };
    });
}

const TODAS = capturas();
const LOJAS = [...new Set(TODAS.map((c) => c.loja))].sort();

function daLoja(loja: string, tipo: string): Captura {
  const c = TODAS.find((x) => x.loja === loja && x.tipo === tipo);
  if (c === undefined) throw new Error(`${loja}: no ${tipo} capture`);
  return c;
}

function detalhesDaLoja(loja: string): Captura[] {
  return TODAS.filter((c) => c.loja === loja && c.tipo.startsWith('grade-'));
}

/** Two requests are the same when their path and their query pairs (in order) are. */
function mesmaRequisicao(url: URL, e: EnvelopeFixtureLi): boolean {
  const query = [...url.searchParams];
  return (
    url.pathname === e.requisicao.caminho &&
    query.length === e.requisicao.query.length &&
    query.every(([k, v], i) => {
      const [kk, vv] = e.requisicao.query[i] ?? [];
      return k === kk && v === vv;
    })
  );
}

/**
 * The package's reads over the REAL client, against a platform answering ONLY a request equal to
 * one of `fixtures` (a 500 otherwise). Returns which fixtures were consumed, and how many requests
 * matched none.
 */
function replay(fixtures: readonly Captura[]) {
  const consumidas = new Set<string>();
  let semCaptura = 0;
  const fetch: typeof globalThis.fetch = (input) => {
    const url = new URL(String(input));
    const c = fixtures.find((f) => mesmaRequisicao(url, f.envelope));
    if (c === undefined) {
      semCaptura += 1;
      return Promise.resolve(new Response('{}', { status: 500 }));
    }
    consumidas.add(c.nome);
    return Promise.resolve(
      new Response(JSON.stringify(c.envelope.resposta.corpo), {
        status: c.envelope.resposta.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  const cliente = criarClienteLeituraLi({ obterCredencial: () => CREDENCIAL_DE_TESTE, fetch });
  return { cliente, consumidas, semCaptura: () => semCaptura };
}

const OPCOES_DA_LISTA = {
  limite: LIMITE_PAGINA_CATALOGO_LI,
  maxPaginas: MAX_PAGINAS_CATALOGO_LI,
} as const;

/** The captured rows of a list body (before any package schema). */
function linhasBrutas(c: Captura): number {
  const r = listaBruta.safeParse(c.envelope.resposta.corpo);
  if (!r.success) throw new Error(`${c.nome}: not a list body`);
  return r.data.objects.length;
}

function totalDe(c: Captura): number {
  const r = listaBruta.safeParse(c.envelope.resposta.corpo);
  if (!r.success) throw new Error(`${c.nome}: not a list body`);
  return r.data.meta.total_count;
}

function proximoDe(c: Captura): unknown {
  const r = listaBruta.safeParse(c.envelope.resposta.corpo);
  if (!r.success) throw new Error(`${c.nome}: not a list body`);
  return r.data.meta.next;
}

/** `limites` is one `limit=50` per page, `paginas` of them. */
function limitesHonrados(lista: ListaCatalogoLi<unknown>, paginas: number): boolean {
  return (
    lista.limites.length === paginas && lista.limites.every((l) => l === LIMITE_PAGINA_CATALOGO_LI)
  );
}

describe('C9 — the corpus', () => {
  it(`holds the ${String(FIXTURES_C9)} catalogue captures, two stores, every one a 200 GET under a Personal Token`, () => {
    expect(TODAS).toHaveLength(FIXTURES_C9);
    expect(LOJAS).toHaveLength(2);
    for (const c of TODAS) {
      expect(c.envelope.requisicao.metodo === 'GET', c.nome).toBe(true);
      expect(c.envelope.resposta.status === 200, c.nome).toBe(true);
      expect(c.envelope.credencial === 'personal-token', c.nome).toBe(true);
      expect(c.envelope.resposta.politica === 'catalogo', c.nome).toBe(true);
    }
    for (const loja of LOJAS) {
      for (const tipo of ['categorias', 'marcas', 'grades']) daLoja(loja, tipo);
      expect(detalhesDaLoja(loja).length, loja).toBe(2);
    }
  });
});

describe('C9 — the lists, through the package and the projections', () => {
  it.each(LOJAS)(
    '%s: categories — (a) the requests are the captured ones, (b) every row parses, (c)/(d) limit 50 on every page',
    async (loja) => {
      const pagina1 = daLoja(loja, 'categorias');
      const p2 = TODAS.find((c) => c.loja === loja && c.tipo === 'categorias-p2');
      const fixtures = p2 === undefined ? [pagina1] : [pagina1, p2];
      const r = replay(fixtures);

      const lista = await listarCategoriasLi(r.cliente, OPCOES_DA_LISTA);

      expect(r.semCaptura(), loja).toBe(0);
      expect(r.consumidas.size, loja).toBe(fixtures.length);
      // (a) page 1 is exactly `/v1/categoria/?limit=50`.
      expect(pagina1.envelope.requisicao.caminho === CAMINHO_CATEGORIAS_LI, loja).toBe(true);
      expect(pagina1.envelope.requisicao.query.length, loja).toBe(1);
      expect(
        pagina1.envelope.requisicao.query[0]?.[0] === 'limit' &&
          pagina1.envelope.requisicao.query[0][1] === String(LIMITE_PAGINA_CATALOGO_LI),
        loja,
      ).toBe(true);
      // (b) every captured row came through the row schema; (c) the limit was honoured.
      const brutas = fixtures.reduce((n, f) => n + linhasBrutas(f), 0);
      expect(lista.linhas.length === brutas, loja).toBe(true);
      expect(lista.linhas.length === totalDe(pagina1), loja).toBe(true);
      expect(limitesHonrados(lista, fixtures.length), loja).toBe(true);

      const projecao = projetarCategoriasLi(lista.linhas);
      expect(projecao.paisIlegiveis, loja).toBe(0);
      expect(projecao.linhasSemId, loja).toBe(0);
      expect(projecao.categorias.length === lista.linhas.length, loja).toBe(true);
      // Every parent is a category of the same list: the pseudonyms kept the relation.
      const ids = new Set(projecao.categorias.map((c) => c.id));
      const filhas = projecao.categorias.filter((c) => c.pai.tipo === TIPO_PAI_CATEGORIA_LI.id);
      expect(
        filhas.every((c) => c.pai.tipo === TIPO_PAI_CATEGORIA_LI.id && ids.has(c.pai.id)),
        loja,
      ).toBe(true);
      expect(ids.size === projecao.categorias.length, `${loja}: ids distinct`).toBe(true);
    },
  );

  it('(d) the store with more categories than a page: page 2 at limit=50&offset=50, two limits of 50, every row of total_count, and the list ends', async () => {
    const segundas = TODAS.filter((c) => c.tipo === 'categorias-p2');
    expect(segundas).toHaveLength(1);
    const p2 = segundas[0];
    if (p2 === undefined) throw new Error('no second page');
    const pagina1 = daLoja(p2.loja, 'categorias');

    expect(p2.envelope.requisicao.caminho === CAMINHO_CATEGORIAS_LI).toBe(true);
    const query = p2.envelope.requisicao.query;
    expect(query.length).toBe(2);
    expect(
      query[0]?.[0] === 'limit' &&
        query[0][1] === String(LIMITE_PAGINA_CATALOGO_LI) &&
        query[1]?.[0] === 'offset' &&
        query[1][1] === String(LIMITE_PAGINA_CATALOGO_LI),
    ).toBe(true);
    // More rows than one page, all of them on two pages, and the second page ends the list.
    expect(totalDe(pagina1) > LIMITE_PAGINA_CATALOGO_LI).toBe(true);
    expect(totalDe(pagina1) <= 2 * LIMITE_PAGINA_CATALOGO_LI).toBe(true);
    expect(linhasBrutas(pagina1)).toBe(LIMITE_PAGINA_CATALOGO_LI);
    expect(linhasBrutas(pagina1) + linhasBrutas(p2) === totalDe(pagina1)).toBe(true);
    expect(proximoDe(pagina1) !== null).toBe(true);
    expect(proximoDe(p2) === null).toBe(true);

    const r = replay([pagina1, p2]);
    const lista = await listarCategoriasLi(r.cliente, OPCOES_DA_LISTA);
    expect(lista.limites).toEqual([LIMITE_PAGINA_CATALOGO_LI, LIMITE_PAGINA_CATALOGO_LI]);
    expect(lista.linhas.length === totalDe(pagina1)).toBe(true);
    expect(r.consumidas.size).toBe(2);
    expect(r.semCaptura()).toBe(0);
  });

  it('the captures are not vacuous: at least one store has child categories', async () => {
    let filhas = 0;
    for (const loja of LOJAS) {
      const pagina1 = daLoja(loja, 'categorias');
      const p2 = TODAS.find((c) => c.loja === loja && c.tipo === 'categorias-p2');
      const r = replay(p2 === undefined ? [pagina1] : [pagina1, p2]);
      const lista = await listarCategoriasLi(r.cliente, OPCOES_DA_LISTA);
      filhas += projetarCategoriasLi(lista.linhas).categorias.filter(
        (c) => c.pai.tipo === TIPO_PAI_CATEGORIA_LI.id,
      ).length;
    }
    expect(filhas > 0).toBe(true);
  });

  it.each(LOJAS)(
    '%s: brands — the captured request, every row parsed and projected, `ativo` a boolean on each',
    async (loja) => {
      const c = daLoja(loja, 'marcas');
      const r = replay([c]);

      const lista = await listarMarcasLi(r.cliente, OPCOES_DA_LISTA);

      expect(r.semCaptura(), loja).toBe(0);
      expect(r.consumidas.size, loja).toBe(1);
      expect(c.envelope.requisicao.caminho === CAMINHO_MARCAS_LI, loja).toBe(true);
      expect(lista.linhas.length === linhasBrutas(c), loja).toBe(true);
      expect(lista.linhas.length === totalDe(c), loja).toBe(true);
      expect(limitesHonrados(lista, 1), loja).toBe(true);
      const projecao = projetarMarcasLi(lista.linhas);
      expect(projecao.linhasSemId, loja).toBe(0);
      expect(projecao.marcas.length > 0, loja).toBe(true);
      expect(projecao.marcas.length === lista.linhas.length, loja).toBe(true);
      expect(
        projecao.marcas.every((m) => typeof m.ativo === 'boolean'),
        loja,
      ).toBe(true);
    },
  );

  it.each(LOJAS)(
    '%s: grades — the captured request, every row parsed and projected',
    async (loja) => {
      const c = daLoja(loja, 'grades');
      const r = replay([c]);

      const lista = await listarGradesLi(r.cliente, OPCOES_DA_LISTA);

      expect(r.semCaptura(), loja).toBe(0);
      expect(r.consumidas.size, loja).toBe(1);
      expect(c.envelope.requisicao.caminho === CAMINHO_GRADES_LI, loja).toBe(true);
      expect(lista.linhas.length === linhasBrutas(c), loja).toBe(true);
      expect(lista.linhas.length === totalDe(c), loja).toBe(true);
      expect(limitesHonrados(lista, 1), loja).toBe(true);
      const projecao = projetarGradesLi(lista.linhas);
      expect(projecao.linhasSemId, loja).toBe(0);
      expect(projecao.grades.length > 0, loja).toBe(true);
      expect(projecao.grades.length === lista.linhas.length, loja).toBe(true);
    },
  );
});

describe('C9 — the grade details, through the package and the projection', () => {
  const DETALHES = TODAS.filter((c) => c.tipo.startsWith('grade-'));

  it('four details, two per store', () => {
    expect(DETALHES).toHaveLength(4);
  });

  it.each(DETALHES.map((c) => [c.nome, c] as const))(
    '%s: (a) the path the package builds, no query; (e) the detail and every option name the grade; nothing dropped',
    async (nome, c) => {
      const caminho = c.envelope.requisicao.caminho;
      const id = new RegExp(`^${CAMINHO_GRADES_LI}(\\d+)/$`).exec(caminho)?.[1];
      expect(id !== undefined, nome).toBe(true);
      if (id === undefined) return;
      expect(c.envelope.requisicao.query.length, nome).toBe(0);

      const r = replay([c]);
      const lida = await buscarGradeLi(r.cliente, id);

      expect(r.semCaptura(), nome).toBe(0);
      expect(r.consumidas.size, nome).toBe(1);
      // (e) the detail IS the grade its path names.
      expect(mesmaGradeLi(lida.dados.id, id), nome).toBe(true);
      const brutas = detalheBruto.safeParse(c.envelope.resposta.corpo);
      expect(brutas.success, nome).toBe(true);
      expect(lida.dados.variacoes.length === (brutas.data?.variacoes.length ?? -1), nome).toBe(
        true,
      );
      expect(lida.dados.variacoes.length > 0, nome).toBe(true);
      expect(
        lida.dados.variacoes.every(
          (o) => String(idDoRecursoLi(o.grade, RECURSO_URI_LI.grades)) === id,
        ),
        nome,
      ).toBe(true);

      const projecao = projetarGradeLi(lida.dados);
      expect(projecao !== null, nome).toBe(true);
      expect(projecao?.opcoesDeOutraGrade, nome).toBe(0);
      expect(projecao?.opcoesComGradeIlegivel, nome).toBe(0);
      expect(projecao?.linhasSemId, nome).toBe(0);
      expect(projecao?.opcoes.length === lida.dados.variacoes.length, nome).toBe(true);
      expect(
        new Set(projecao?.opcoes.map((o) => o.id)).size === projecao?.opcoes.length,
        `${nome}: option ids distinct`,
      ).toBe(true);
    },
  );

  it.each(LOJAS)('%s: every detailed grade is one of its store’s listed grades', async (loja) => {
    const r = replay([daLoja(loja, 'grades')]);
    const lista = await listarGradesLi(r.cliente, OPCOES_DA_LISTA);
    const listadas = new Set(projetarGradesLi(lista.linhas).grades.map((g) => String(g.id)));
    for (const c of detalhesDaLoja(loja)) {
      const id = new RegExp(`^${CAMINHO_GRADES_LI}(\\d+)/$`).exec(
        c.envelope.requisicao.caminho,
      )?.[1];
      expect(id !== undefined && listadas.has(id), c.nome).toBe(true);
    }
  });
});
