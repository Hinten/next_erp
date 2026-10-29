import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { type ValorJsonLi, decodificarValorDaQueryLi, passaPredicadoLi } from '../core/redacao';
import { PSEUDONIMO_MAXIMO_LI, PSEUDONIMO_MINIMO_LI } from '../sanitizacao/pseudonimo';
import { formatarAchadosLi, piiScan } from './piiScan';
import {
  DIRETORIO_WIRE_LI,
  type EnvelopeFixtureLi,
  LEIAME_WIRE_LI,
  NOME_DE_CAPTURA_LI,
  lerFixtureLi,
  listarArquivosDoCorpusLi,
  serializarFixtureLi,
} from './wireCorpus';

/**
 * The floor that keeps the assertions below non-vacuous: the number of committed
 * fixtures — the Mercado Livre corpus test is the precedent. 29 since step 10:
 * 18 from the owner's first captures (step 3) plus the 11 catalogue captures
 * (`c9-*`: categories, brands, grades and two grade details per store, plus the
 * larger store's second category page, `c9-loja1-categorias-p2`). The
 * step-3 captures held 19 pairs; `pedido-enviado` was a byte-identical duplicate
 * of `pedido-boleto` (the same order requested twice) and is not committed
 * (`__wire__/README.md`).
 *
 * ⚠️ It equals the count on purpose, and the first test asserts the equality:
 * a fixture that disappears fails there instead of silently shrinking what the
 * scan below covers, and so does a fixture added without moving it (a floor left
 * below the count would let the next one disappear unnoticed). A change that
 * adds fixtures raises it, and one that deliberately removes a fixture lowers
 * it, in the same commit. Below it, "every fixture is valid and clean" holds of
 * fewer files than were reviewed.
 */
const MINIMO_DE_FIXTURES = 29;

/**
 * The two body classes whose redaction tables KEEP a row's Loja Integrada `id`.
 * The `estrutural` class fakes an order's `id` (its identity is the `numero`),
 * so an order row cannot key a resource.
 */
const CLASSES_QUE_MANTEM_O_ID: ReadonlySet<EnvelopeFixtureLi['resposta']['politica']> = new Set([
  'catalogo',
  'configuracao',
]);

const ehObjetoJsonLi = (
  v: ValorJsonLi | undefined,
): v is { readonly [chave: string]: ValorJsonLi } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A detail path: the collection path (`/v1/grades/`), then one id segment. */
const CAMINHO_DE_DETALHE = /^(\/(?:[a-z0-9_]+\/)+)\d+\/?$/;

interface RecursoNoCorpoLi {
  /** `<collection path>#<id>`: one Loja Integrada resource, whichever fixture holds it. */
  readonly chave: string;
  readonly uri: string;
  /** The body class and where the row sits in the body, for the failure line (never a value). */
  readonly onde: string;
}

/**
 * Every row of a list body (`objects.*`) and the root of a detail body that carries
 * a numeric `id` and a string `resource_uri`, keyed by the resource it names.
 */
function recursosDoEnvelopeLi(envelope: EnvelopeFixtureLi): RecursoNoCorpoLi[] {
  const { politica } = envelope.resposta;
  if (!CLASSES_QUE_MANTEM_O_ID.has(politica)) return [];
  const corpo = envelope.resposta.corpo;
  if (!ehObjetoJsonLi(corpo)) return [];
  const recurso = (colecao: string, onde: string, linha: ValorJsonLi): RecursoNoCorpoLi[] => {
    if (!ehObjetoJsonLi(linha)) return [];
    const { id, resource_uri: uri } = linha;
    return typeof id === 'number' && typeof uri === 'string'
      ? [{ chave: `${colecao}#${String(id)}`, uri, onde: `${politica} ${onde}` }]
      : [];
  };
  const { caminho } = envelope.requisicao;
  const objetos = corpo.objects;
  if (Array.isArray(objetos)) return objetos.flatMap((o) => recurso(caminho, 'objects.*', o));
  const detalhe = CAMINHO_DE_DETALHE.exec(caminho);
  return detalhe === null ? [] : recurso(detalhe[1] ?? caminho, '(raiz)', corpo);
}

/**
 * Compares every resource the fixtures hold more than once. `divergencias` names
 * each pair whose `resource_uri` differs (file names and row kinds, never a
 * value); `comparados` lists the row kinds that took part in a comparison, so a
 * caller can prove the check was not vacuous.
 */
function compararUrisDoCorpusLi(fixtures: readonly (readonly [string, EnvelopeFixtureLi])[]): {
  divergencias: string[];
  comparados: string[];
} {
  const vistos = new Map<string, { readonly arquivo: string } & RecursoNoCorpoLi>();
  const divergencias: string[] = [];
  const comparados = new Set<string>();
  for (const [arquivo, envelope] of fixtures) {
    for (const atual of recursosDoEnvelopeLi(envelope)) {
      const anterior = vistos.get(atual.chave);
      if (anterior === undefined) {
        vistos.set(atual.chave, { arquivo, ...atual });
        continue;
      }
      comparados.add(anterior.onde).add(atual.onde);
      if (anterior.uri !== atual.uri) {
        divergencias.push(
          `${anterior.arquivo} ${anterior.onde} / ${arquivo} ${atual.onde} :: resource_uri`,
        );
      }
    }
  }
  return { divergencias, comparados: [...comparados].sort() };
}

/* ------------------------- catalogue ids: their function ------------------------- */

/*
 * The catalogue fixtures' ids are keyed pseudonyms (`sanitizacao/pseudonimo.ts`),
 * never the stores' real ids. What a test needs from them is their FUNCTION: a row's
 * id and its URI agree, a `categoria_pai` names a category of the same store, a
 * grade detail is one grade throughout and a row of its store's grade list. These
 * checks pin that function without naming any id, so they hold for whichever key
 * wrote the corpus. Failures print file names, row kinds and kinds, never a value.
 */

type FixturesLi = readonly (readonly [string, EnvelopeFixtureLi])[];

/** The ids in the `/`-segments of a URI or a path: a digit-only one, or each of a `41;42` list. */
const segmentosDeId = (texto: string) =>
  texto.split('/').flatMap((s) => (/^\d+(?:;\d+)*$/.test(s) ? s.split(';') : []));
/** A kept resource URI (what the profile's `uriRecurso` predicate accepts). */
const ehUriDeRecurso = (v: ValorJsonLi | undefined): v is string =>
  typeof v === 'string' && passaPredicadoLi('uriRecurso', v);
const ultimoId = (uri: string) => segmentosDeId(uri).at(-1);

/** The store a catalogue fixture belongs to (`c9-loja1-…` → `loja1`); `null` for the others. */
const lojaDe = (arquivo: string) => /^c9-(loja\d+)-/.exec(arquivo)?.[1] ?? null;

/** Every object of a body, at any depth, with where it sits (`objects.*`, `variacoes.*`). */
function objetosDe(
  v: ValorJsonLi,
  onde = '(raiz)',
): { readonly onde: string; readonly objeto: { readonly [k: string]: ValorJsonLi } }[] {
  if (Array.isArray(v)) return v.flatMap((x: ValorJsonLi) => objetosDe(x, `${onde}.*`));
  if (!ehObjetoJsonLi(v)) return [];
  return [
    { onde, objeto: v },
    ...Object.entries(v).flatMap(([k, filho]) =>
      objetosDe(filho, onde === '(raiz)' ? k : `${onde}.${k}`),
    ),
  ];
}

const doCatalogo = (fixtures: FixturesLi) =>
  fixtures.filter(([, e]) => e.resposta.politica === 'catalogo');

/** Every object holding a numeric `id` and a kept `resource_uri`: the URI's last id is that id. */
function urisQueDivergemDoId(fixtures: FixturesLi): { divergencias: string[]; linhas: number } {
  const divergencias: string[] = [];
  let linhas = 0;
  for (const [arquivo, envelope] of doCatalogo(fixtures)) {
    for (const { onde, objeto } of objetosDe(envelope.resposta.corpo)) {
      const { id, resource_uri: uri } = objeto;
      if (typeof id !== 'number' || !ehUriDeRecurso(uri)) continue;
      linhas += 1;
      if (ultimoId(uri) !== String(id)) divergencias.push(`${arquivo} ${onde} :: resource_uri`);
    }
  }
  return { divergencias, linhas };
}

/** The ids of the rows of every list fixture of `colecao` (`/v1/categoria/`), per store. */
function idsDasListas(fixtures: FixturesLi, colecao: string): Map<string, Set<string>> {
  const porLoja = new Map<string, Set<string>>();
  for (const [arquivo, envelope] of fixtures) {
    const loja = lojaDe(arquivo);
    const corpo = envelope.resposta.corpo;
    if (loja === null || envelope.requisicao.caminho !== colecao || !ehObjetoJsonLi(corpo)) {
      continue;
    }
    const ids = porLoja.get(loja) ?? new Set<string>();
    for (const linha of Array.isArray(corpo.objects) ? corpo.objects : []) {
      if (ehObjetoJsonLi(linha) && typeof linha.id === 'number') ids.add(String(linha.id));
    }
    porLoja.set(loja, ids);
  }
  return porLoja;
}

/** Every non-null `categoria_pai` names a category row of the same store (any of its pages). */
function paisForaDaLoja(fixtures: FixturesLi): { orfaos: string[]; pais: number } {
  const categorias = idsDasListas(fixtures, '/v1/categoria/');
  const orfaos: string[] = [];
  let pais = 0;
  for (const [arquivo, envelope] of fixtures) {
    const loja = lojaDe(arquivo);
    if (loja === null) continue;
    for (const { onde, objeto } of objetosDe(envelope.resposta.corpo)) {
      const pai = objeto.categoria_pai;
      if (pai === undefined || pai === null) continue;
      pais += 1;
      const id = ehUriDeRecurso(pai) ? ultimoId(pai) : undefined;
      if (id === undefined || categorias.get(loja)?.has(id) !== true) {
        orfaos.push(`${arquivo} ${onde} :: categoria_pai`);
      }
    }
  }
  return { orfaos, pais };
}

const CAMINHO_DE_GRADE = /^\/v1\/grades\/(\d+)\/?$/;
/** `/api/v1/grade/<g>/variacao/<v>` (or `/v1/…`): the option's own URI. */
const URI_DE_OPCAO = /^(?:\/api)?\/v1\/grade\/(\d+)\/variacao\/\d+\/?$/;

/**
 * Each grade detail is ONE grade: its request path id is its root `id`, every
 * option's `grade` URI and the grade segment of every option's own URI; and that
 * id is a row of the same store's grade list.
 */
function gradesIncoerentes(fixtures: FixturesLi): {
  problemas: string[];
  detalhes: number;
  opcoes: number;
} {
  const listas = idsDasListas(fixtures, '/v1/grades/');
  const problemas: string[] = [];
  let detalhes = 0;
  let opcoes = 0;
  for (const [arquivo, envelope] of fixtures) {
    const loja = lojaDe(arquivo);
    const caminho = CAMINHO_DE_GRADE.exec(envelope.requisicao.caminho);
    const corpo = envelope.resposta.corpo;
    if (loja === null || caminho === null || !ehObjetoJsonLi(corpo)) continue;
    detalhes += 1;
    // The root id is the reference; a root without a numeric id matches nothing.
    const g = typeof corpo.id === 'number' ? String(corpo.id) : '<sem-id>';
    if (caminho[1] !== g) problemas.push(`${arquivo} requisicao.caminho :: id`);
    if (listas.get(loja)?.has(g) !== true) problemas.push(`${arquivo} (raiz) :: fora-da-lista`);
    for (const opcao of Array.isArray(corpo.variacoes) ? corpo.variacoes : []) {
      if (!ehObjetoJsonLi(opcao)) continue;
      opcoes += 1;
      const plural = opcao.grade;
      if (!ehUriDeRecurso(plural) || ultimoId(plural) !== g) {
        problemas.push(`${arquivo} variacoes.* :: grade`);
      }
      const propria = typeof opcao.resource_uri === 'string' ? opcao.resource_uri : '';
      if (URI_DE_OPCAO.exec(propria)?.[1] !== g) {
        problemas.push(`${arquivo} variacoes.* :: resource_uri`);
      }
    }
  }
  return { problemas, detalhes, opcoes };
}

/** The collections whose list rows must carry distinct ids, per store (all pages together). */
const COLECOES_DO_CATALOGO = new Set(['/v1/categoria/', '/v1/grades/', '/v1/marca/']);

/**
 * Within each store, the category rows (every page), the grade-list rows and the
 * brand rows, and within each grade detail its options, carry pairwise-distinct
 * ids: a mapping that folded two ids into one would still pass every relation
 * check above (equal ids carry equal URIs), while a test keying a row by its id
 * would read the wrong row.
 */
function idsRepetidos(fixtures: FixturesLi): { repetidos: string[]; linhas: number } {
  const grupos = new Map<string, number[]>();
  const somar = (grupo: string, linhas: readonly ValorJsonLi[]) => {
    const ids = grupos.get(grupo) ?? [];
    for (const linha of linhas) {
      if (ehObjetoJsonLi(linha) && typeof linha.id === 'number') ids.push(linha.id);
    }
    grupos.set(grupo, ids);
  };
  for (const [arquivo, envelope] of fixtures) {
    const loja = lojaDe(arquivo);
    const corpo = envelope.resposta.corpo;
    if (loja === null || !ehObjetoJsonLi(corpo)) continue;
    const caminho = envelope.requisicao.caminho;
    if (COLECOES_DO_CATALOGO.has(caminho) && Array.isArray(corpo.objects)) {
      somar(`${loja} ${caminho}`, corpo.objects);
    } else if (CAMINHO_DE_GRADE.test(caminho) && Array.isArray(corpo.variacoes)) {
      somar(`${arquivo} variacoes.*`, corpo.variacoes);
    }
  }
  const repetidos: string[] = [];
  let linhas = 0;
  for (const [grupo, ids] of grupos) {
    linhas += ids.length;
    const repetidas = ids.length - new Set(ids).size;
    if (repetidas > 0) repetidos.push(`${grupo} :: ${String(repetidas)} repeated id(s)`);
  }
  return { repetidos, linhas };
}

/** The query keys whose value is a catalogue id (`/v1/produto_imagem/?produto=<id>`). */
const CHAVES_DE_ID_NA_QUERY = new Set(['produto']);

/** The ids of a URL-shaped text (`meta.next`): its path's id segments and its `produto=` values. */
function idsDaUrl(texto: string): number[] {
  const interrogacao = texto.indexOf('?');
  const caminho = interrogacao === -1 ? texto : texto.slice(0, interrogacao);
  const query = interrogacao === -1 ? '' : texto.slice(interrogacao + 1);
  const valores = query
    .split('&')
    .map((par) => par.split('=') as [string, string | undefined])
    .filter(([k]) => CHAVES_DE_ID_NA_QUERY.has(k))
    .map(([, v]) => decodificarValorDaQueryLi(v ?? ''))
    .filter((v) => /^\d+$/.test(v));
  return [...segmentosDeId(caminho), ...valores].map(Number);
}

/**
 * Every catalogue id — a number under a key named `id` or ending in `_id`, an id
 * segment of a kept resource URI, an id segment of the request path, a `produto`
 * query value, and the path ids and `produto=` values of `meta.next` and
 * `meta.previous` — outside the pseudonym range
 * `[PSEUDONIMO_MINIMO_LI, PSEUDONIMO_MAXIMO_LI]`, counted per file.
 */
function idsForaDaFaixa(fixtures: FixturesLi): { foraDaFaixa: string[]; ids: number } {
  const naFaixa = (n: number) => n >= PSEUDONIMO_MINIMO_LI && n <= PSEUDONIMO_MAXIMO_LI;
  const foraDaFaixa: string[] = [];
  let ids = 0;
  for (const [arquivo, envelope] of doCatalogo(fixtures)) {
    const { caminho, query } = envelope.requisicao;
    const valores: number[] = [
      ...segmentosDeId(caminho).map(Number),
      // Decoded as the redactor tests it: `%35%35` is the id 55.
      ...query
        .filter(([k]) => CHAVES_DE_ID_NA_QUERY.has(k))
        .map(([, v]) => decodificarValorDaQueryLi(v))
        .filter((v) => /^\d+$/.test(v))
        .map(Number),
    ];
    for (const { onde, objeto } of objetosDe(envelope.resposta.corpo)) {
      for (const [k, v] of Object.entries(objeto)) {
        // `0` is the profile's fake for a number it refused (an unlisted `*_id`): no id.
        if ((k === 'id' || k.endsWith('_id')) && typeof v === 'number' && v !== 0) {
          valores.push(v);
        }
        if (ehUriDeRecurso(v)) valores.push(...segmentosDeId(v).map(Number));
        if (onde === 'meta' && (k === 'next' || k === 'previous') && typeof v === 'string') {
          valores.push(...idsDaUrl(v));
        }
      }
    }
    ids += valores.length;
    const fora = valores.filter((n) => !naFaixa(n)).length;
    if (fora > 0)
      foraDaFaixa.push(`${arquivo} :: ${String(fora)} id(s) outside the pseudonym range`);
  }
  return { foraDaFaixa, ids };
}

describe('__wire__ corpus', () => {
  const arquivos = listarArquivosDoCorpusLi();

  it(`holds exactly ${String(MINIMO_DE_FIXTURES)} fixture(s), the committed count`, () => {
    expect(arquivos.length).toBe(MINIMO_DE_FIXTURES);
  });

  it('every file is `<nome>.json`', () => {
    for (const arquivo of arquivos) {
      expect(
        arquivo.endsWith('.json') && NOME_DE_CAPTURA_LI.test(arquivo.slice(0, -5)),
        arquivo,
      ).toBe(true);
    }
  });

  // ⚠️ Only booleans and finding lists are asserted: a failure prints paths and
  // kinds, never a body value (`toEqual` on a body would print the body).
  it('every file is a valid envelope, serialised the one way, and passes both scanner layers', () => {
    const problemas: string[] = [];
    for (const arquivo of arquivos) {
      const texto = readFileSync(join(DIRETORIO_WIRE_LI, arquivo), 'utf8');
      const leitura = lerFixtureLi(texto);
      if (!leitura.ok) {
        problemas.push(`${arquivo} :: envelope-invalido`);
        continue;
      }
      if (serializarFixtureLi(leitura.data) !== texto) problemas.push(`${arquivo} :: serializacao`);
      problemas.push(...formatarAchadosLi(arquivo, piiScan(leitura.data)));
    }
    expect(problemas).toEqual([]);
  });

  // ⚠️ A change to the redactor reaches only the pairs the sanitizer is re-run
  // over. Two treatments of one resource's `resource_uri` (kept in one fixture,
  // faked in another) mean one of them was written by an older redactor: re-run
  // the dry run over every pair (`__wire__/README.md`). Only file names and paths
  // are printed, never a value.
  it('a resource two fixtures hold carries one resource_uri in both', () => {
    const fixtures: (readonly [string, EnvelopeFixtureLi])[] = [];
    for (const arquivo of arquivos) {
      const leitura = lerFixtureLi(readFileSync(join(DIRETORIO_WIRE_LI, arquivo), 'utf8'));
      if (leitura.ok) fixtures.push([arquivo, leitura.data]); // else reported above
    }
    const { divergencias, comparados } = compararUrisDoCorpusLi(fixtures);
    expect(divergencias).toEqual([]);
    // Non-vacuous, on every kind of row: the two stores share platform grades,
    // payment methods and statuses; a grade detail's root is also a row of its
    // store's grade list; and the step-3 category capture shares its row with
    // step 10's category list.
    expect(comparados).toEqual(['catalogo (raiz)', 'catalogo objects.*', 'configuracao objects.*']);
  });

  it('the README is there and states the provenance', () => {
    const leiame = readFileSync(join(DIRETORIO_WIRE_LI, LEIAME_WIRE_LI), 'utf8');
    for (const trecho of [
      'captured by the store owner',
      'scripts/sanitizar.ts',
      'are fakes',
      'SKUs, order numeros, dates, quantities and prices are real',
      'MINIMO_DE_FIXTURES',
    ]) {
      expect(leiame, trecho).toContain(trecho);
    }
  });
});

describe('one resource, one resource_uri: what the corpus check compares', () => {
  const envelope = (
    politica: EnvelopeFixtureLi['resposta']['politica'],
    caminho: string,
    corpo: ValorJsonLi,
  ): EnvelopeFixtureLi => ({
    versao: 1,
    perfil: 'fixture',
    credencial: 'personal-token',
    capturadoEm: '2026-10-28',
    requisicao: { metodo: 'GET', caminho, query: [] },
    resposta: { status: 200, politica, forma: 'json', bytes: 2, corpo },
  });
  const lista = (
    caminho: string,
    linhas: readonly ValorJsonLi[],
    politica: EnvelopeFixtureLi['resposta']['politica'] = 'catalogo',
  ) => envelope(politica, caminho, { meta: { next: null }, objects: linhas });
  const MANTIDA = '/v1/categoria/7';
  const FALSA = 'REDACTED';

  it('EQUAL: the same row kept the same way in two lists is one resource, with no divergence', () => {
    expect(
      compararUrisDoCorpusLi([
        ['a.json', lista('/v1/categoria/', [{ id: 7, resource_uri: MANTIDA }])],
        ['b.json', lista('/v1/categoria/', [{ id: 7, resource_uri: MANTIDA }])],
      ]),
    ).toEqual({ divergencias: [], comparados: ['catalogo objects.*'] });
  });

  it('NEAR-MISS: the same row kept in one fixture and faked in the other is a divergence', () => {
    expect(
      compararUrisDoCorpusLi([
        ['a.json', lista('/v1/categoria/', [{ id: 7, resource_uri: FALSA }])],
        ['b.json', lista('/v1/categoria/', [{ id: 7, resource_uri: MANTIDA }])],
      ]).divergencias,
    ).toEqual(['a.json catalogo objects.* / b.json catalogo objects.* :: resource_uri']);
  });

  it("NEAR-MISS: a detail's root and the same grade's row in the list are one resource", () => {
    expect(
      compararUrisDoCorpusLi([
        ['a.json', envelope('catalogo', '/v1/grades/6062/', { id: 6062, resource_uri: FALSA })],
        ['b.json', lista('/v1/grades/', [{ id: 6062, resource_uri: '/api/v1/grades/6062' }])],
      ]),
    ).toEqual({
      divergencias: ['a.json catalogo (raiz) / b.json catalogo objects.* :: resource_uri'],
      comparados: ['catalogo (raiz)', 'catalogo objects.*'],
    });
  });

  it('not one resource: the same id in another collection, or another id in the same one', () => {
    expect(
      compararUrisDoCorpusLi([
        ['a.json', lista('/v1/categoria/', [{ id: 7, resource_uri: MANTIDA }])],
        ['b.json', lista('/v1/marca/', [{ id: 7, resource_uri: FALSA }])],
        ['c.json', lista('/v1/categoria/', [{ id: 8, resource_uri: FALSA }])],
      ]),
    ).toEqual({ divergencias: [], comparados: [] });
  });

  it('never compared: an estrutural row, whose id the redactor fakes', () => {
    expect(
      compararUrisDoCorpusLi([
        [
          'a.json',
          lista('/v1/pedido/search/', [{ id: 0, resource_uri: '/api/v1/pedido/1' }], 'estrutural'),
        ],
        [
          'b.json',
          lista('/v1/pedido/search/', [{ id: 0, resource_uri: '/api/v1/pedido/2' }], 'estrutural'),
        ],
      ]),
    ).toEqual({ divergencias: [], comparados: [] });
  });

  it('never compared: a row with no numeric id, or with no string resource_uri', () => {
    expect(
      compararUrisDoCorpusLi([
        [
          'a.json',
          lista('/v1/categoria/', [{ resource_uri: MANTIDA }, { id: '7', resource_uri: MANTIDA }]),
        ],
        [
          'b.json',
          lista('/v1/categoria/', [{ resource_uri: FALSA }, { id: '7', resource_uri: FALSA }]),
        ],
        ['c.json', lista('/v1/categoria/', [{ id: 9, resource_uri: null }])],
        ['d.json', lista('/v1/categoria/', [{ id: 9, resource_uri: MANTIDA }])],
      ]),
    ).toEqual({ divergencias: [], comparados: [] });
  });
});

/*
 * Catalogue fixtures carry keyed pseudonyms, never the stores' real ids (the
 * sanitizer's `.chave-fixtures`, `scripts/README.md`). These tests pin what the
 * ids must still do (each row's URI names its own id, a parent names a row of
 * the same store, a grade detail matches its list row and its options, ids stay
 * distinct) and that every one of them is a pseudonym.
 */
describe('__wire__ corpus — catalogue ids keep their function without a real id', () => {
  const fixtures: (readonly [string, EnvelopeFixtureLi])[] = [];
  for (const arquivo of listarArquivosDoCorpusLi()) {
    const leitura = lerFixtureLi(readFileSync(join(DIRETORIO_WIRE_LI, arquivo), 'utf8'));
    if (leitura.ok) fixtures.push([arquivo, leitura.data]); // else reported by the corpus test
  }

  it("every catalogue row's resource_uri ends in its own id", () => {
    const { divergencias, linhas } = urisQueDivergemDoId(fixtures);
    expect(divergencias).toEqual([]);
    // Non-vacuous: every category, brand and grade row, both grade roots per store, and
    // every grade option (67 + 15 + 1 categories, 3 brands, 21 grade rows, 4 roots, 74 options).
    expect(linhas).toBe(185);
  });

  it('every categoria_pai names a category row of the same store (across its pages)', () => {
    const { orfaos, pais } = paisForaDaLoja(fixtures);
    expect(orfaos).toEqual([]);
    expect(pais).toBe(55); // 38 on the larger store's first page, 17 on its second
  });

  it('each grade detail is one grade throughout, and a row of its store grade list', () => {
    const { problemas, detalhes, opcoes } = gradesIncoerentes(fixtures);
    expect(problemas).toEqual([]);
    expect({ detalhes, opcoes }).toEqual({ detalhes: 4, opcoes: 74 });
  });

  it("each store's category, grade and brand rows, and each grade's options, have distinct ids", () => {
    const { repetidos, linhas } = idsRepetidos(fixtures);
    expect(repetidos).toEqual([]);
    // Non-vacuous: 67 + 15 categories, 21 grade rows, 3 brands, 74 options.
    expect(linhas).toBe(180);
  });

  // This pins "pseudonymized", not merely "consistent": every pseudonym has exactly
  // 9 digits, while every real Loja Integrada id seen so far (categories, brands,
  // grades, options, in both stores) has 4 to 8, so a real id cannot pass today. A
  // future real id of 9 digits could; the relation tests above would still hold.
  it('every catalogue id is in the pseudonym range', () => {
    const { foraDaFaixa, ids } = idsForaDaFaixa(fixtures);
    expect(foraDaFaixa).toEqual([]);
    // Non-vacuous: every id of the 12 catalogue fixtures (bodies, URIs, request paths).
    expect(ids).toBe(577);
  });
});

describe('catalogue id relations: what the corpus checks compare', () => {
  const envelope = (
    caminho: string,
    corpo: ValorJsonLi,
    politica: EnvelopeFixtureLi['resposta']['politica'] = 'catalogo',
  ): EnvelopeFixtureLi => ({
    versao: 1,
    perfil: 'fixture',
    credencial: 'personal-token',
    capturadoEm: '2026-10-28',
    requisicao: { metodo: 'GET', caminho, query: [] },
    resposta: { status: 200, politica, forma: 'json', bytes: 2, corpo },
  });
  const categorias = (...linhas: ValorJsonLi[]) =>
    envelope('/v1/categoria/', { meta: { next: null }, objects: linhas });
  const grade = (g: number, opcoes: ValorJsonLi[]) =>
    envelope(`/v1/grades/${String(g)}/`, {
      id: g,
      resource_uri: `/api/v1/grades/${String(g)}`,
      variacoes: opcoes,
    });
  const opcao = (g: number, v: number) => ({
    grade: `/api/v1/grades/${String(g)}`,
    id: v,
    resource_uri: `/api/v1/grade/${String(g)}/variacao/${String(v)}`,
  });
  const listaDeGrades = (...ids: number[]) =>
    envelope('/v1/grades/', {
      objects: ids.map((id) => ({ id, resource_uri: `/api/v1/grades/${String(id)}` })),
    });

  it('EQUAL / NEAR-MISS: a row whose URI ends in its id, and one whose URI names another id', () => {
    expect(
      urisQueDivergemDoId([
        ['c9-loja1-x.json', categorias({ id: 5, resource_uri: '/v1/categoria/5' })],
      ]),
    ).toEqual({ divergencias: [], linhas: 1 });
    expect(
      urisQueDivergemDoId([
        ['c9-loja1-x.json', categorias({ id: 5, resource_uri: '/v1/categoria/50' })],
      ]).divergencias,
    ).toEqual(['c9-loja1-x.json objects.* :: resource_uri']);
  });

  it('never compared: a configuracao row, or a faked URI', () => {
    expect(
      urisQueDivergemDoId([
        [
          'situacao.json',
          envelope(
            '/v1/situacao/',
            { objects: [{ id: 5, resource_uri: '/api/v1/situacao/6' }] },
            'configuracao',
          ),
        ],
        ['c9-loja1-x.json', categorias({ id: 5, resource_uri: 'REDACTED' })],
      ]),
    ).toEqual({ divergencias: [], linhas: 0 });
  });

  it("EQUAL: a parent on the store's other page; NEAR-MISS: a parent only the OTHER store has", () => {
    const pai = { id: 1, categoria_pai: null, resource_uri: '/v1/categoria/1' };
    const filho = { id: 2, categoria_pai: '/v1/categoria/1', resource_uri: '/v1/categoria/2' };
    expect(
      paisForaDaLoja([
        ['c9-loja1-categorias.json', categorias(pai)],
        ['c9-loja1-categorias-p2.json', categorias(filho)],
      ]),
    ).toEqual({ orfaos: [], pais: 1 });
    expect(
      paisForaDaLoja([
        ['c9-loja2-categorias.json', categorias(pai)],
        ['c9-loja1-categorias-p2.json', categorias(filho)],
      ]).orfaos,
    ).toEqual(['c9-loja1-categorias-p2.json objects.* :: categoria_pai']);
  });

  it('EQUAL: a coherent grade detail listed by its store', () => {
    expect(
      gradesIncoerentes([
        ['c9-loja1-grades.json', listaDeGrades(7, 8)],
        ['c9-loja1-grade-propria.json', grade(7, [opcao(7, 70), opcao(7, 71)])],
      ]),
    ).toEqual({ problemas: [], detalhes: 1, opcoes: 2 });
  });

  it('NEAR-MISS: a grade whose path, option URIs or store list disagree', () => {
    const errada = envelope('/v1/grades/9/', {
      id: 7,
      variacoes: [
        { grade: '/api/v1/grades/8', id: 70, resource_uri: '/api/v1/grade/7/variacao/70' },
        { grade: '/api/v1/grades/7', id: 71, resource_uri: '/api/v1/grade/8/variacao/71' },
      ],
    });
    expect(
      gradesIncoerentes([
        ['c9-loja1-grades.json', listaDeGrades(8, 9)],
        ['c9-loja2-grades.json', listaDeGrades(7)],
        ['c9-loja1-grade-propria.json', errada],
      ]).problemas,
    ).toEqual([
      'c9-loja1-grade-propria.json requisicao.caminho :: id',
      'c9-loja1-grade-propria.json (raiz) :: fora-da-lista',
      'c9-loja1-grade-propria.json variacoes.* :: grade',
      'c9-loja1-grade-propria.json variacoes.* :: resource_uri',
    ]);
  });

  it('the range: a 9-digit pseudonym passes; a real-sized id fails, in a body, a URI or the path', () => {
    const p = PSEUDONIMO_MINIMO_LI + 12_345;
    expect(
      idsForaDaFaixa([['c9-loja1-g.json', grade(p, [opcao(p, PSEUDONIMO_MAXIMO_LI)])]]),
    ).toEqual({ foraDaFaixa: [], ids: 7 });
    expect(
      idsForaDaFaixa([
        ['a.json', categorias({ id: 4101, resource_uri: `/v1/categoria/${String(p)}` })],
        ['b.json', categorias({ id: p, resource_uri: '/v1/categoria/4101' })],
        ['c.json', envelope('/v1/grades/6062/', { id: p })],
        ['e.json', envelope(`/v1/categoria/set/${String(p)};4101/`, { objects: [] })],
        ['d.json', categorias({ id: PSEUDONIMO_MAXIMO_LI + 1, resource_uri: 'REDACTED' })],
      ]).foraDaFaixa,
    ).toEqual([
      'a.json :: 1 id(s) outside the pseudonym range',
      'b.json :: 1 id(s) outside the pseudonym range',
      'c.json :: 1 id(s) outside the pseudonym range',
      'e.json :: 1 id(s) outside the pseudonym range',
      'd.json :: 1 id(s) outside the pseudonym range',
    ]);
  });

  it('the range ignores what is not an id: meta numbers, meta.next and a configuracao id', () => {
    expect(
      idsForaDaFaixa([
        [
          'a.json',
          envelope('/v1/categoria/', {
            meta: { limit: 50, offset: 50, total_count: 67, next: '/api/v1/categoria?offset=50' },
            objects: [],
          }),
        ],
        ['s.json', envelope('/v1/situacao/', { objects: [{ id: 4 }] }, 'configuracao')],
      ]),
    ).toEqual({ foraDaFaixa: [], ids: 0 });
  });

  it('the range also covers `_id` keys, a `produto` query value and the ids of meta.next/previous', () => {
    const p = PSEUDONIMO_MINIMO_LI + 54_321;
    const comQuery = (q: readonly (readonly [string, string])[]): EnvelopeFixtureLi => {
      const e = envelope('/v1/produto_imagem/', { objects: [] });
      return { ...e, requisicao: { ...e.requisicao, query: q } };
    };
    const meta = (next: string) =>
      envelope('/v1/produto_imagem/', { meta: { limit: 1, offset: 1, next }, objects: [] });
    expect(
      idsForaDaFaixa([
        ['a.json', envelope('/v1/produto_imagem/', { objects: [{ imagem_id: 4444 }] })],
        ['b.json', comQuery([['produto', '5555']])],
        ['c.json', meta('/api/v1/produto_imagem/?limit=1&offset=1&produto=5555')],
        // A percent-encoded spelling is the same id (the redactor kept it decoded-tested).
        ['b2.json', comQuery([['produto', '%35%35%35%35']])],
        ['c2.json', meta('/api/v1/produto_imagem/?limit=1&offset=1&produto=55%355')],
        ['d.json', meta('/api/v1/categoria/set/3333;2222/?limit=1&offset=1')],
        [
          'e.json',
          envelope('/v1/produto_imagem/', {
            meta: {
              limit: 1,
              offset: 1,
              next: null,
              previous: '/api/v1/produto_imagem/?limit=1&offset=0&produto=7',
            },
            objects: [],
          }),
        ],
      ]).foraDaFaixa,
    ).toEqual([
      'a.json :: 1 id(s) outside the pseudonym range',
      'b.json :: 1 id(s) outside the pseudonym range',
      'c.json :: 1 id(s) outside the pseudonym range',
      'b2.json :: 1 id(s) outside the pseudonym range',
      'c2.json :: 1 id(s) outside the pseudonym range',
      'd.json :: 2 id(s) outside the pseudonym range',
      'e.json :: 1 id(s) outside the pseudonym range',
    ]);
    // EQUAL: the same positions holding pseudonyms pass; NEAR-MISS: limit, offset and
    // another query key's digits are not ids.
    expect(
      idsForaDaFaixa([
        [
          'a.json',
          envelope('/v1/produto_imagem/', {
            objects: [{ imagem_id: p, posicao: 1, especificacao_id: 0 }],
          }),
        ],
        [
          'b.json',
          comQuery([
            ['produto', String(p)],
            ['limit', '5'],
            ['numero', '5555'],
          ]),
        ],
        [
          'c.json',
          meta(`/api/v1/produto_imagem/?limit=1&offset=1&numero=5555&produto=${String(p)}`),
        ],
      ]),
    ).toEqual({ foraDaFaixa: [], ids: 3 });
  });

  it('NEAR-MISS: the range reads `next`/`previous` only under `meta`, and a redacted `produto` is no id', () => {
    const e = envelope('/v1/produto_imagem/', {
      meta: { limit: 1, offset: 0, next: '/api/v1/produto_imagem/?limit=1&produto=<redacted>' },
      objects: [{ next: '/api/v1/produto_imagem/?produto=5', previous: '/api/v1/x/?produto=6' }],
    });
    expect(
      idsForaDaFaixa([
        ['a.json', { ...e, requisicao: { ...e.requisicao, query: [['produto', '<redacted>']] } }],
      ]),
    ).toEqual({ foraDaFaixa: [], ids: 0 });
  });

  it('EQUAL / NEAR-MISS: distinct ids per store collection and per grade detail', () => {
    const marcas = (...ids: number[]) =>
      envelope('/v1/marca/', { objects: ids.map((id) => ({ id })) });
    expect(
      idsRepetidos([
        ['c9-loja1-categorias.json', categorias({ id: 1 }, { id: 2 })],
        ['c9-loja1-categorias-p2.json', categorias({ id: 3 })],
        ['c9-loja2-categorias.json', categorias({ id: 1 })],
        ['c9-loja1-marcas.json', marcas(1, 2)],
        ['c9-loja1-grades.json', listaDeGrades(7)],
        ['c9-loja1-grade-propria.json', grade(7, [opcao(7, 70), opcao(7, 71)])],
      ]),
    ).toEqual({ repetidos: [], linhas: 9 });
    expect(
      idsRepetidos([
        ['c9-loja1-categorias.json', categorias({ id: 1 }, { id: 2 })],
        ['c9-loja1-categorias-p2.json', categorias({ id: 2 })],
        ['c9-loja1-marcas.json', marcas(4, 4)],
        ['c9-loja1-grades.json', listaDeGrades(7, 7)],
        ['c9-loja1-grade-propria.json', grade(7, [opcao(7, 70), opcao(7, 70)])],
        ['outro.json', categorias({ id: 1 }, { id: 1 })],
      ]).repetidos,
    ).toEqual([
      'loja1 /v1/categoria/ :: 1 repeated id(s)',
      'loja1 /v1/marca/ :: 1 repeated id(s)',
      'loja1 /v1/grades/ :: 1 repeated id(s)',
      'c9-loja1-grade-propria.json variacoes.* :: 1 repeated id(s)',
    ]);
  });
});

describe('the envelope schema', () => {
  const VALIDO: EnvelopeFixtureLi = {
    versao: 1,
    perfil: 'fixture',
    credencial: 'personal-token',
    capturadoEm: '2026-10-07',
    requisicao: { metodo: 'GET', caminho: '/v1/situacao/', query: [['limit', '20']] },
    resposta: { status: 200, politica: 'configuracao', forma: 'json', bytes: 2, corpo: {} },
  };
  const texto = (v: unknown) => JSON.stringify(v);

  it('accepts a valid envelope, and keeps an own `__proto__` key in the body', () => {
    expect(lerFixtureLi(texto(VALIDO)).ok).toBe(true);
    const comProto = texto(VALIDO).replace('"corpo":{}', '"corpo":{"__proto__":{"x":1}}');
    const leitura = lerFixtureLi(comProto);
    expect(leitura.ok).toBe(true);
    if (leitura.ok) expect(Object.keys(leitura.data.resposta.corpo ?? {})).toEqual(['__proto__']);
  });

  it.each([
    ['an unknown credential', { ...VALIDO, credencial: 'outra' }],
    ['an extra top-level key', { ...VALIDO, alias: 'x' }],
    ['a time of day', { ...VALIDO, capturadoEm: '2026-10-07T10:00:00Z' }],
    ['the webhook class', { ...VALIDO, resposta: { ...VALIDO.resposta, politica: 'webhook' } }],
    ['an unparsed form', { ...VALIDO, resposta: { ...VALIDO.resposta, forma: 'nao-analisado' } }],
    ['a header', { ...VALIDO, requisicao: { ...VALIDO.requisicao, cabecalhos: {} } }],
  ])('refuses %s', (_caso, valor) => {
    expect(lerFixtureLi(texto(valor)).ok).toBe(false);
  });
});
