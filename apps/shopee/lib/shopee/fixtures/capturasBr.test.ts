/**
 * The capture PINS of #1911 (spec C.6): what the 2026-11-04 BR production
 * reads settle, asserted over the COMMITTED bodies in `__wire__/`.
 *
 * ⚠️ **Booleans and counts only.** These bodies are the shop's own listings,
 * pseudonymised, neutralised and redacted (`wireCorpus.ts`, the BR section). A
 * test here may assert that a title reads `REDACTED`, that a SKU has the
 * pseudonym SHAPE, or that a price, a stock count, a listing date or an option
 * name reads one of `neutralizarAnuncio.ts`'s invented constants; it never
 * names a title, a description, a SKU, a listing or model id, a URL, or a
 * captured price, stock figure or date. Ids that appear below are Shopee's PUBLIC taxonomy
 * (category, attribute, attribute value, variation, variation group, logistics
 * channel) or the repo's fixture ids (partner 1000001, shop 987654, `int-1`).
 *
 * ⚠️ **Every replayed Shopee OPERATION goes through a REAL `createShopeeClient`**
 * whose fake `fetch` serves the committed TEXT at the status the file name
 * states (`-http404` ⇒ 404, else 200) — the `clienteDoCorpus` pattern of
 * `wireCorpus.test.ts` — so those pins exercise the package's envelope reader,
 * the operation schema and the request the client actually signs. Two other
 * seams are deliberate, and a client pin is never redundant with them: the
 * facts that must be seen BEFORE any schema (raw `has_children`, display ≠
 * original, the cut's fixpoint, pin 2's raw attribute walks, the raw
 * `dts_limit` and the sibling `gtin_limit`, the absent `variation_group_id`
 * key, the raw channel count, the SKU shape, the URL and image-id census, pin
 * 9's fixpoint and its price/stock census) read the body with `lerFixture`;
 * and a few parse it through a package schema directly, with no envelope
 * reader (`shopeeAttributeTreeSchema` in pin 2, `lerBaseDosItens` in pins 3, 8
 * and 9's listing dates). A raw pin says nothing about what the client keeps or
 * strips.
 *
 * Each `it` names its fixture. A count here was checked against the committed
 * body when the pin was written; if a body and a count disagree, the finding is
 * about the code or about Shopee — never a reason to edit the body
 * (`wireCorpus.ts` header).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  SHOPEE_GET_ATTRIBUTE_TREE_PATH,
  SHOPEE_GET_CATEGORY_PATH,
  SHOPEE_GET_CHANNEL_LIST_PATH,
  SHOPEE_GET_ITEM_BASE_INFO_PATH,
  SHOPEE_GET_ITEM_LIMIT_PATH,
  SHOPEE_GET_MODEL_LIST_PATH,
  SHOPEE_GET_VARIATIONS_PATH,
  ShopeeApiError,
  type ShopeeApiPathOverrides,
  type ShopeeAttribute,
  type ShopeeClient,
  ShopeeSchemaError,
  createShopeeClient,
  resolveShopeeHosts,
  shopeeAttributeTreeSchema,
  shopeeCategoryListSchema,
} from '@delfrance/integrations-shopee';
import {
  type AtributoDto,
  lerAtributosArmazenadosShopee,
  respostaCategoriasShopeeSchema,
  respostaLimitesDoItemShopeeSchema,
  respostaLimitesTabelaMedidasShopeeSchema,
  validarAtributosShopee,
  varianteFakePath,
} from '@delfrance/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lerCanaisDaLoja } from '../anuncios/publicarAnuncio';
import { montarTiers, reconciliarModelos } from '../anuncios/tiersPublicacao';
import { planejarTaxonomia, tiersDoItem } from '../produtos/taxonomiaShopeeCore';
import { type ShopeeTaxonomiaCtx, lerIndiceDeCategorias } from '../taxonomia/cache';
import { construirIndice, ehFolha, raizes } from '../taxonomia/categorias';
import { projetarAtributos, projetarNoDeCategoria } from '../taxonomia/dto';
import { lerLimitesDeItem } from '../taxonomia/limites';
import { cortarArvoreDeCategorias } from './cortarCategorias';
import {
  ATUALIZACAO_NEUTRA,
  CAMPOS_NEUTRALIZADOS,
  CHAVES_DE_PRECO,
  CRIACAO_NEUTRA,
  ESTOQUE_NEUTRO,
  PRECO_NEUTRO,
  neutralizarLeituraDeAnuncio,
} from './neutralizarAnuncio';
import type { WireValue } from './redact';
import {
  CORPOS_BR_1911,
  FIXTURE_ATTRIBUTE_TREE_BR_A_CANECA,
  FIXTURE_ATTRIBUTE_TREE_BR_ANUNCIO_ATRIBUTOS,
  FIXTURE_ATTRIBUTE_TREE_BR_ANUNCIO_LOGISTICA,
  FIXTURE_ATTRIBUTE_TREE_BR_ANUNCIO_VARIACOES,
  FIXTURE_ATTRIBUTE_TREE_BR_B_CAPA,
  FIXTURE_ATTRIBUTE_TREE_BR_C_CAMISETA,
  FIXTURE_ATTRIBUTE_TREE_BR_D_CAFE,
  FIXTURE_ATTRIBUTE_TREE_BR_D_SHAMPOO,
  FIXTURE_CATEGORY_BR_RECORTE,
  FIXTURE_CHANNEL_LIST_BR,
  FIXTURE_ITEM_BASE_INFO_BR_ANUNCIO_ATRIBUTOS,
  FIXTURE_ITEM_BASE_INFO_BR_ANUNCIO_LOGISTICA,
  FIXTURE_ITEM_BASE_INFO_BR_ANUNCIO_VARIACOES,
  FIXTURE_ITEM_LIMIT_BR_ANUNCIO_ATRIBUTOS,
  FIXTURE_ITEM_LIMIT_BR_C_CAMISETA,
  FIXTURE_ITEM_LIMIT_BR_LOJA,
  FIXTURE_MODEL_LIST_BR_ANUNCIO_VARIACOES,
  FIXTURE_VARIATIONS_BR_C_CAMISETA_HTTP404,
  FIXTURE_VARIATION_TREE_BR_A_CANECA,
  FIXTURE_VARIATION_TREE_BR_ANUNCIO_VARIACOES,
  FIXTURE_VARIATION_TREE_BR_C_CAMISETA,
  FOLHAS_CAPTURADAS_BR,
  WIRE_DIR,
  lerBaseDosItens,
  lerFixture,
} from './wireCorpus';

/* -------------------------------------------------------------------------- */
/*                                  The seam                                  */
/* -------------------------------------------------------------------------- */

/** The repo's fixture conta — never a real one. */
const INTEGRACAO = 'int-1';

/**
 * An INVENTED item id for the per-listing reads. The fake transport serves the
 * committed body whatever id is asked for, and the capture's own (pseudonymised)
 * id is a value this file never names.
 */
const ITEM_INVENTADO = 1;

/** A fixed clock for the import planner; nothing below reads it back. */
const AGORA_MS = 1_793_836_800_000;

/** The two-level group of BR Tamanho (BR) — public taxonomy. */
const GRUPO_TAMANHO_BR = 844_758_844_060_204;
/** The two-level group of BR Tamanho (INT) — public taxonomy. */
const GRUPO_TAMANHO_INT = 841_350_766_059_029;
/** Standard variation ids — public taxonomy. */
const VARIACAO_COR = 101_054;
const VARIACAO_TAMANHO = 101_056;

/** The status a committed body is served at: the FILE NAME says it. */
function statusDoArquivo(file: string): number {
  return file.endsWith('-http404.json') ? 404 : 200;
}

/** One request the client made, reduced to what a pin may look at. */
interface Pedido {
  readonly metodo: string | undefined;
  readonly caminho: string;
  readonly query: URLSearchParams;
}

/**
 * A REAL package client whose `fetch` answers `texto` at `status`, recording
 * each request. The text is served verbatim — never re-serialised.
 */
function clienteQueServe(
  texto: string,
  status: number,
  paths?: ShopeeApiPathOverrides,
): { readonly client: ShopeeClient; readonly pedidos: Pedido[] } {
  const pedidos: Pedido[] = [];
  const transporte = vi.fn<typeof globalThis.fetch>((entrada, init) => {
    const url = new URL(
      typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url,
    );
    pedidos.push({ metodo: init?.method, caminho: url.pathname, query: url.searchParams });
    return Promise.resolve(
      new Response(texto, { status, headers: { 'content-type': 'application/json' } }),
    );
  });
  const client = createShopeeClient({
    partnerId: 1000001,
    partnerKey: 'chave-de-teste-nao-e-credencial',
    // The production hosts: these are production reads. The transport is fake,
    // so nothing leaves the process.
    hosts: resolveShopeeHosts(),
    fetch: transporte,
    shopId: 987654,
    getAccessToken: () => Promise.resolve('access-inventado'),
    ...(paths === undefined ? {} : { paths }),
  });
  return { client, pedidos };
}

/** {@link clienteQueServe} over a COMMITTED body, at the status its name states. */
function clienteDoCorpo(
  file: string,
  paths?: ShopeeApiPathOverrides,
): { readonly client: ShopeeClient; readonly pedidos: Pedido[] } {
  return clienteQueServe(readFileSync(join(WIRE_DIR, file), 'utf8'), statusDoArquivo(file), paths);
}

/** The taxonomy context the readers take, over one client. */
function ctxDe(client: ShopeeClient): ShopeeTaxonomiaCtx {
  return { integracaoId: INTEGRACAO, client, variationsPath: SHOPEE_GET_VARIATIONS_PATH };
}

/** Whether a value is a plain JSON object. */
function ehObjeto(v: WireValue | undefined): v is { readonly [k: string]: WireValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

beforeEach(() => {
  __resetAllReadCaches();
});

afterEach(() => {
  __resetAllReadCaches();
});

/* -------------------------------------------------------------------------- */
/*                     Pin 1 — the category cut (`get_category`)             */
/* -------------------------------------------------------------------------- */

/** A raw `get_category` row, as the file holds it. */
interface LinhaCrua {
  readonly category_id: number;
  readonly parent_category_id: number;
  readonly original_category_name: string;
  readonly display_category_name: string;
  readonly has_children: unknown;
}

function linhasCruas(): readonly LinhaCrua[] {
  const corpo = lerFixture(FIXTURE_CATEGORY_BR_RECORTE) as unknown as {
    response: { category_list: LinhaCrua[] };
  };
  return corpo.response.category_list;
}

describe(`pino 1 — ${FIXTURE_CATEGORY_BR_RECORTE}`, () => {
  it(`${FIXTURE_CATEGORY_BR_RECORTE}: todo \`has_children\` CRU é um booleano (46/46), antes de qualquer schema`, () => {
    const linhas = linhasCruas();
    expect(linhas).toHaveLength(46);
    expect(linhas.filter((l) => typeof l.has_children === 'boolean')).toHaveLength(46);
  });

  it(`${FIXTURE_CATEGORY_BR_RECORTE}: o cliente pede \`get_category\` com \`language=pt-br\` e o índice tem 46 nós, 28 raízes, sem ShopeeSchemaError`, async () => {
    const { client, pedidos } = clienteDoCorpo(FIXTURE_CATEGORY_BR_RECORTE);
    const indice = await lerIndiceDeCategorias(ctxDe(client));

    expect(pedidos.map((p) => [p.metodo, p.caminho])).toEqual([['GET', SHOPEE_GET_CATEGORY_PATH]]);
    expect(pedidos[0]?.caminho).toBe('/api/v2/product/get_category');
    expect(pedidos[0]?.query.get('language')).toBe('pt-br');
    expect(indice.lista).toHaveLength(46);
    expect(indice.porId.size).toBe(46);
    expect(raizes(indice)).toHaveLength(28);
  });

  it(`${FIXTURE_CATEGORY_BR_RECORTE}: \`ehFolha\` é \`folha\` exatamente nas 8 folhas capturadas, \`nao-folha\` nas outras 38, \`desconhecida\` fora da árvore`, async () => {
    const { client } = clienteDoCorpo(FIXTURE_CATEGORY_BR_RECORTE);
    const indice = await lerIndiceDeCategorias(ctxDe(client));
    const folhas = new Set<number>(FOLHAS_CAPTURADAS_BR);

    const veredictos = indice.lista.map((no) => [no.category_id, ehFolha(indice, no.category_id)]);
    expect(
      veredictos
        .filter(([, v]) => v === 'folha')
        .map(([id]) => id)
        .sort(),
    ).toEqual([...FOLHAS_CAPTURADAS_BR].sort());
    expect(
      veredictos.filter(([id, v]) => v === 'nao-folha' && !folhas.has(id as number)),
    ).toHaveLength(38);
    const ausente = Math.max(...indice.lista.map((no) => no.category_id)) + 1;
    expect(ehFolha(indice, ausente)).toBe('desconhecida');
  });

  it(`${FIXTURE_CATEGORY_BR_RECORTE}: cada folha projeta um nó que passa por JSON e pelo schema da rota, raiz primeiro e a folha por último`, async () => {
    const { client } = clienteDoCorpo(FIXTURE_CATEGORY_BR_RECORTE);
    const indice = await lerIndiceDeCategorias(ctxDe(client));

    for (const folha of FOLHAS_CAPTURADAS_BR) {
      const row = indice.porId.get(folha);
      expect(row, String(folha)).toBeDefined();
      if (row === undefined) continue;
      const corpo: unknown = JSON.parse(
        JSON.stringify({ raizes: null, no: projetarNoDeCategoria(indice, row) }),
      );
      const { no } = respostaCategoriasShopeeSchema.parse(corpo);
      expect(no?.categoryId).toBe(folha);
      expect(no?.isLeaf).toBe(true);
      const caminho = no?.pathFromRoot ?? [];
      expect(caminho.length, String(folha)).toBeGreaterThan(1);
      expect(
        indice.porId.get(caminho[0]?.categoryId ?? -1)?.parent_category_id,
        String(folha),
      ).toBe(0);
      expect(caminho.at(-1)?.categoryId).toBe(folha);
    }
  });

  it(`${FIXTURE_CATEGORY_BR_RECORTE}: o nome de EXIBIÇÃO difere do ORIGINAL em pelo menos uma linha`, () => {
    expect(
      linhasCruas().filter((l) => l.display_category_name !== l.original_category_name).length,
    ).toBeGreaterThan(0);
  });

  it(`${FIXTURE_CATEGORY_BR_RECORTE}: o corte do corpo commitado é ele mesmo (ponto fixo), com as 28 raízes`, () => {
    const commitado = lerFixture(FIXTURE_CATEGORY_BR_RECORTE);
    const recortado = cortarArvoreDeCategorias(commitado, FOLHAS_CAPTURADAS_BR);
    // The roots first: a cut that kept only the eight paths would still parse,
    // and this is the count that says which half it dropped.
    const relido = shopeeCategoryListSchema.parse(recortado);
    expect(raizes(construirIndice(relido.response.category_list))).toHaveLength(28);
    expect(recortado).toEqual(commitado);
  });

  it(`⛔ NEAR-MISS sintético sobre ${FIXTURE_CATEGORY_BR_RECORTE}: UM \`has_children: "false"\` é recusado em response.category_list.<i>.has_children`, async () => {
    // SYNTHETIC: the committed body with ONE row's boolean turned into the
    // string "false" — never a capture. The schema is a strict `z.boolean()`;
    // a loose reader would call that non-leaf... a leaf, or the reverse.
    const corpo = JSON.parse(readFileSync(join(WIRE_DIR, FIXTURE_CATEGORY_BR_RECORTE), 'utf8')) as {
      response: { category_list: Record<string, unknown>[] };
    };
    const lista = corpo.response.category_list;
    const i = lista.findIndex((l) => l.category_id === FOLHAS_CAPTURADAS_BR[0]);
    expect(i).toBeGreaterThanOrEqual(0);
    lista[i] = { ...lista[i], has_children: 'false' };

    const direto = shopeeCategoryListSchema.safeParse(corpo);
    expect(direto.success).toBe(false);
    expect(direto.error?.issues.map((issue) => issue.path)).toEqual([
      ['response', 'category_list', i, 'has_children'],
    ]);

    const { client } = clienteQueServe(JSON.stringify(corpo), 200);
    const erro: unknown = await client.getCategory().then(
      () => null,
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(ShopeeSchemaError);
    expect((erro as ShopeeSchemaError).campos).toEqual(['response.category_list[].has_children']);
  });
});

/* -------------------------------------------------------------------------- */
/*                   Pin 2 — the eight attribute trees                        */
/* -------------------------------------------------------------------------- */

/** [file, the leaf category it was read for] — the README rows' request params. */
const ARVORES_DE_ATRIBUTOS = [
  [FIXTURE_ATTRIBUTE_TREE_BR_A_CANECA, 101239],
  [FIXTURE_ATTRIBUTE_TREE_BR_ANUNCIO_ATRIBUTOS, 101787],
  [FIXTURE_ATTRIBUTE_TREE_BR_ANUNCIO_LOGISTICA, 101775],
  [FIXTURE_ATTRIBUTE_TREE_BR_ANUNCIO_VARIACOES, 100352],
  [FIXTURE_ATTRIBUTE_TREE_BR_B_CAPA, 100490],
  [FIXTURE_ATTRIBUTE_TREE_BR_C_CAMISETA, 100244],
  [FIXTURE_ATTRIBUTE_TREE_BR_D_CAFE, 100824],
  [FIXTURE_ATTRIBUTE_TREE_BR_D_SHAMPOO, 100869],
] as const;

/** A raw attribute / value, as the file holds it (recursive). */
interface AtributoCru {
  readonly attribute_id: number;
  readonly attribute_info?: Record<string, unknown>;
  readonly multi_lang?: readonly { readonly language?: unknown }[];
  readonly attribute_value_list?: readonly ValorCru[];
}
interface ValorCru {
  readonly value_id: number;
  readonly multi_lang?: readonly { readonly language?: unknown }[];
  readonly child_attribute_list?: readonly AtributoCru[];
}

/** Every attribute and value of a raw tree, depth-first, with its depth. */
function percorrerCru(arvore: readonly AtributoCru[]): {
  readonly atributos: AtributoCru[];
  readonly valores: { readonly atributo: number; readonly valor: ValorCru }[];
} {
  const atributos: AtributoCru[] = [];
  const valores: { atributo: number; valor: ValorCru }[] = [];
  const visitar = (lista: readonly AtributoCru[]): void => {
    for (const a of lista) {
      atributos.push(a);
      for (const v of a.attribute_value_list ?? []) {
        valores.push({ atributo: a.attribute_id, valor: v });
        visitar(v.child_attribute_list ?? []);
      }
    }
  };
  visitar(arvore);
  return { atributos, valores };
}

/** The projected DTO's attribute and value counts, depth-first. */
function contarDto(arvore: readonly AtributoDto[]): { atributos: number; valores: number } {
  let atributos = 0;
  let valores = 0;
  const visitar = (lista: readonly AtributoDto[]): void => {
    for (const a of lista) {
      atributos += 1;
      for (const v of a.attributeValueList) {
        valores += 1;
        visitar(v.childAttributeList);
      }
    }
  };
  visitar(arvore);
  return { atributos, valores };
}

function arvoreCrua(file: string): readonly AtributoCru[] {
  const corpo = lerFixture(file) as unknown as {
    response: { list: { attribute_tree: AtributoCru[] }[] };
  };
  return corpo.response.list.flatMap((row) => row.attribute_tree);
}

/** The tree through the CLIENT: one category asked, one row answered. */
async function arvoreDoCliente(
  file: string,
  categoria: number,
): Promise<{ readonly arvore: readonly ShopeeAttribute[]; readonly pedidos: Pedido[] }> {
  const { client, pedidos } = clienteDoCorpo(file);
  const lido = await client.getAttributeTree({ categoryIds: [categoria] });
  expect(lido.list.map((row) => row.category_id)).toEqual([categoria]);
  return { arvore: lido.list[0]?.attribute_tree ?? [], pedidos };
}

describe('pino 2 — as oito árvores de atributos', () => {
  it('get_attribute_tree.br-*: cobre as oito, uma vez cada', () => {
    // Anti-vacuity anchor for the `it.each` below.
    expect(ARVORES_DE_ATRIBUTOS.map(([file]) => file)).toHaveLength(8);
    expect(new Set(ARVORES_DE_ATRIBUTOS.map(([file]) => file)).size).toBe(8);
  });

  it.each(ARVORES_DE_ATRIBUTOS)(
    '%s: parseia pelo cliente (categoria %d, pt-br), o DTO conta o mesmo que o corpo cru e não foi truncado',
    async (file, categoria) => {
      expect(shopeeAttributeTreeSchema.safeParse(lerFixture(file)).success).toBe(true);
      const { arvore, pedidos } = await arvoreDoCliente(file, categoria);
      expect(pedidos.map((p) => p.caminho)).toEqual([SHOPEE_GET_ATTRIBUTE_TREE_PATH]);
      expect(pedidos[0]?.query.get('category_id_list')).toBe(String(categoria));
      expect(pedidos[0]?.query.get('language')).toBe('pt-br');

      const cru = percorrerCru(arvoreCrua(file));
      const projetada = projetarAtributos(arvore);
      expect(projetada.truncated).toBe(false);
      expect(contarDto(projetada.atributos)).toEqual({
        atributos: cru.atributos.length,
        valores: cru.valores.length,
      });
    },
  );

  it.each(ARVORES_DE_ATRIBUTOS)(
    '%s: nenhum `input_validation_type` 4 (⊆ {0,2,3}); `date_format_type` e `introduction` ausentes',
    (file) => {
      const { atributos } = percorrerCru(arvoreCrua(file));
      expect(atributos.length).toBeGreaterThan(0);
      for (const a of atributos) {
        const info = a.attribute_info ?? {};
        expect([0, 2, 3], String(a.attribute_id)).toContain(info.input_validation_type);
        expect('date_format_type' in info, String(a.attribute_id)).toBe(false);
        expect('introduction' in info, String(a.attribute_id)).toBe(false);
      }
    },
  );

  it('get_attribute_tree.br-* (as oito juntas): 141 atributos (69 ids distintos), TODOS com uma entrada `pt-BR`; 708 valores, exatamente UM sem — a-caneca 100134/1942; nenhuma outra língua', () => {
    const atributos: AtributoCru[] = [];
    const valores: { file: string; atributo: number; valor: ValorCru }[] = [];
    for (const [file] of ARVORES_DE_ATRIBUTOS) {
      const cru = percorrerCru(arvoreCrua(file));
      atributos.push(...cru.atributos);
      valores.push(...cru.valores.map((v) => ({ file, ...v })));
    }
    const temPtBr = (ml: readonly { readonly language?: unknown }[] | undefined): boolean =>
      (ml ?? []).some((m) => m.language === 'pt-BR');

    expect(atributos).toHaveLength(141);
    expect(new Set(atributos.map((a) => a.attribute_id)).size).toBe(69);
    expect(atributos.filter((a) => !temPtBr(a.multi_lang))).toHaveLength(0);

    expect(valores).toHaveLength(708);
    expect(
      valores
        .filter((v) => !temPtBr(v.valor.multi_lang))
        .map((v) => [v.file, v.atributo, v.valor.value_id]),
    ).toEqual([[FIXTURE_ATTRIBUTE_TREE_BR_A_CANECA, 100134, 1942]]);

    const linguas = new Set(
      [...atributos.map((a) => a.multi_lang), ...valores.map((v) => v.valor.multi_lang)].flatMap(
        (ml) => (ml ?? []).map((m) => m.language),
      ),
    );
    expect([...linguas]).toEqual(['pt-BR']);
  });
});

/* -------------------------------------------------------------------------- */
/*            Pin 3 — the three listings against their category trees         */
/* -------------------------------------------------------------------------- */

/** [item body, its tree, the category both name] — the capture's own pairs. */
const ANUNCIOS_E_ARVORES = [
  [
    FIXTURE_ITEM_BASE_INFO_BR_ANUNCIO_ATRIBUTOS,
    FIXTURE_ATTRIBUTE_TREE_BR_ANUNCIO_ATRIBUTOS,
    101787,
  ],
  [
    FIXTURE_ITEM_BASE_INFO_BR_ANUNCIO_LOGISTICA,
    FIXTURE_ATTRIBUTE_TREE_BR_ANUNCIO_LOGISTICA,
    101775,
  ],
  [
    FIXTURE_ITEM_BASE_INFO_BR_ANUNCIO_VARIACOES,
    FIXTURE_ATTRIBUTE_TREE_BR_ANUNCIO_VARIACOES,
    100352,
  ],
] as const;

describe('pino 3 — os três anúncios contra a árvore da sua categoria', () => {
  it.each(ANUNCIOS_E_ARVORES)(
    '%s × %s (categoria %d): o validador não acha NENHUM problema e o decoder não descarta nada',
    async (itemFile, arvoreFile, categoria) => {
      const itens = lerBaseDosItens(itemFile).item_list;
      expect(itens.length).toBe(1);
      const item = itens[0];
      expect(item?.category_id).toBe(categoria);

      const { arvore } = await arvoreDoCliente(arvoreFile, categoria);
      const lidos = lerAtributosArmazenadosShopee(item?.attribute_list);
      expect(lidos.atributos.length).toBeGreaterThan(0);
      expect(lidos.descartes).toEqual([]);
      expect(validarAtributosShopee(projetarAtributos(arvore), lidos.atributos)).toEqual([]);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                    Pin 4 — the three `get_item_limit` reads                */
/* -------------------------------------------------------------------------- */

/** [file, the requested category — `null` is the shop-wide read]. */
const LIMITES = [
  [FIXTURE_ITEM_LIMIT_BR_ANUNCIO_ATRIBUTOS, 101787],
  [FIXTURE_ITEM_LIMIT_BR_C_CAMISETA, 100244],
  [FIXTURE_ITEM_LIMIT_BR_LOJA, null],
] as const;

/** The raw `dts_limit`, as the file holds it. */
function dtsCru(file: string): Record<string, unknown> {
  const corpo = lerFixture(file) as unknown as {
    response: { dts_limit?: Record<string, unknown> };
  };
  return corpo.response.dts_limit ?? {};
}

describe('pino 4 — as três leituras de `get_item_limit`', () => {
  it.each(LIMITES)(
    '%s (categoria %s): GTIN só na leitura por categoria, nunca como irmão de `response`; peso e dimensão obrigatórios; tabela de medidas ausente só na loja',
    async (file, categoria) => {
      const { client, pedidos } = clienteDoCorpo(file);
      const lido = await lerLimitesDeItem(ctxDe(client), categoria);

      expect(pedidos.map((p) => p.caminho)).toEqual([SHOPEE_GET_ITEM_LIMIT_PATH]);
      expect(pedidos[0]?.query.get('category_id')).toBe(
        categoria === null ? null : String(categoria),
      );

      // The merged rule: present exactly on the two category reads.
      expect(lido.gtinLimit === null).toBe(categoria === null);
      // The SIBLING position (outside `response`): absent on all three.
      expect('gtin_limit' in (lerFixture(file) as Record<string, unknown>)).toBe(false);
      const { client: outro } = clienteDoCorpo(file);
      const bruto = await outro.getItemLimit(categoria === null ? {} : { categoryId: categoria });
      expect(bruto.gtin_limit).toBeNull();

      expect(lido.limites.weightLimit?.weightMandatory).toBe(true);
      expect(lido.limites.dimensionLimit?.dimensionMandatory).toBe(true);
      expect(lido.limites.sizeChartLimit === null).toBe(categoria === null);

      // No `-1` on any end of the days-to-ship band (guide 209 §4's sentinel).
      const banda = lido.limites.dtsLimit?.daysToShipLimit ?? null;
      for (const ponta of [banda?.min, banda?.max]) {
        expect(ponta === null || ponta === undefined || ponta >= 0).toBe(true);
      }

      // Both web slices parse the 200 the route would build from this read.
      const resposta: unknown = JSON.parse(
        JSON.stringify({
          scope: categoria === null ? 'shop' : 'category',
          categoryId: categoria,
          limites: lido.limites,
          gtinLimit: lido.gtinLimit,
          supportsPreOrder: lido.supportsPreOrder,
        }),
      );
      expect(respostaLimitesDoItemShopeeSchema.safeParse(resposta).success).toBe(true);
      expect(respostaLimitesTabelaMedidasShopeeSchema.safeParse(resposta).success).toBe(true);
    },
  );

  it.each(LIMITES)(
    '%s (categoria %s): `supportsPreOrder` DERIVADO é o `dts_limit.support_pre_order` da Shopee onde a chave existe',
    async (file, categoria) => {
      const { client } = clienteDoCorpo(file);
      const lido = await lerLimitesDeItem(ctxDe(client), categoria);
      const dts = dtsCru(file);

      // The key is on the ITEM page for both category reads, and absent shop-wide.
      expect('support_pre_order' in dts).toBe(categoria !== null);
      if ('support_pre_order' in dts) {
        expect(typeof dts.support_pre_order).toBe('boolean');
        expect(lido.supportsPreOrder).toBe(dts.support_pre_order);
      }
    },
  );

  it(`${FIXTURE_ITEM_LIMIT_BR_C_CAMISETA}: a categoria 100244 ACEITA pré-venda e a derivação concorda (o par do \`false\` de 101787)`, async () => {
    const { client } = clienteDoCorpo(FIXTURE_ITEM_LIMIT_BR_C_CAMISETA);
    expect(dtsCru(FIXTURE_ITEM_LIMIT_BR_C_CAMISETA).support_pre_order).toBe(true);
    expect((await lerLimitesDeItem(ctxDe(client), 100244)).supportsPreOrder).toBe(true);

    const { client: outro } = clienteDoCorpo(FIXTURE_ITEM_LIMIT_BR_ANUNCIO_ATRIBUTOS);
    expect(dtsCru(FIXTURE_ITEM_LIMIT_BR_ANUNCIO_ATRIBUTOS).support_pre_order).toBe(false);
    expect((await lerLimitesDeItem(ctxDe(outro), 101787)).supportsPreOrder).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                    Pin 5 — the variation trees (needs (b))                 */
/* -------------------------------------------------------------------------- */

/** [file, category] — the three trees answered 200 on `get_variation_tree`. */
const ARVORES_DE_VARIACOES = [
  [FIXTURE_VARIATION_TREE_BR_A_CANECA, 101239],
  [FIXTURE_VARIATION_TREE_BR_ANUNCIO_VARIACOES, 100352],
  [FIXTURE_VARIATION_TREE_BR_C_CAMISETA, 100244],
] as const;

describe('pino 5 — as árvores de variações pelo cliente PADRÃO', () => {
  it.each(ARVORES_DE_VARIACOES)(
    '%s (categoria %d): o cliente sem override assina LITERALMENTE /api/v2/product/get_variation_tree e a árvore parseia',
    async (file, categoria) => {
      const { client, pedidos } = clienteDoCorpo(file);
      const lido = await client.getVariations({ categoryId: categoria });

      expect(pedidos.map((p) => [p.metodo, p.caminho])).toEqual([
        ['GET', '/api/v2/product/get_variation_tree'],
      ]);
      expect(pedidos[0]?.query.get('category_id')).toBe(String(categoria));
      expect(lido.standardise_variation_list.length).toBeGreaterThan(0);
    },
  );

  it(`${FIXTURE_VARIATION_TREE_BR_A_CANECA}: 6 variações, NENHUMA com opção alguma`, async () => {
    const { client } = clienteDoCorpo(FIXTURE_VARIATION_TREE_BR_A_CANECA);
    const lido = await client.getVariations({ categoryId: 101239 });
    expect(lido.standardise_variation_list).toHaveLength(6);
    expect(
      lido.standardise_variation_list.filter((v) =>
        v.variation_group_list.some((g) => g.variation_option_list.length > 0),
      ),
    ).toHaveLength(0);
  });

  it.each([
    [FIXTURE_VARIATION_TREE_BR_ANUNCIO_VARIACOES, 100352],
    [FIXTURE_VARIATION_TREE_BR_C_CAMISETA, 100244],
  ] as const)(
    '%s (categoria %d): Tamanho 101056 tem DOIS grupos — 841350766059029 e 844758844060204',
    async (file, categoria) => {
      const { client } = clienteDoCorpo(file);
      const lido = await client.getVariations({ categoryId: categoria });
      const tamanho = lido.standardise_variation_list.filter(
        (v) => v.variation_id === VARIACAO_TAMANHO,
      );
      expect(tamanho).toHaveLength(1);
      expect(tamanho[0]?.variation_group_list.map((g) => g.variation_group_id)).toEqual([
        GRUPO_TAMANHO_INT,
        GRUPO_TAMANHO_BR,
      ]);
    },
  );

  it(`${FIXTURE_VARIATIONS_BR_C_CAMISETA_HTTP404}: servido em 404 na grafia das AMOSTRAS (override), rejeita ShopeeApiError \`error_not_found\``, async () => {
    const { client, pedidos } = clienteDoCorpo(FIXTURE_VARIATIONS_BR_C_CAMISETA_HTTP404, {
      getVariations: '/api/v2/product/get_variations',
    });
    const erro: unknown = await client.getVariations({ categoryId: 100244 }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(pedidos.map((p) => p.caminho)).toEqual(['/api/v2/product/get_variations']);
    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect((erro as ShopeeApiError).code).toBe('error_not_found');
    expect((erro as ShopeeApiError).httpStatus).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/*            Pin 6 — the listing's two-level group (needs (b))               */
/* -------------------------------------------------------------------------- */

describe(`pino 6 — ${FIXTURE_MODEL_LIST_BR_ANUNCIO_VARIACOES}`, () => {
  /** The model list through the client. */
  async function modelos(): Promise<Awaited<ReturnType<ShopeeClient['getModelList']>>> {
    const { client, pedidos } = clienteDoCorpo(FIXTURE_MODEL_LIST_BR_ANUNCIO_VARIACOES);
    const lido = await client.getModelList({ itemId: ITEM_INVENTADO });
    expect(pedidos.map((p) => p.caminho)).toEqual([SHOPEE_GET_MODEL_LIST_PATH]);
    return lido;
  }

  /** The listing's tiers, as the import reads them; both arrays must have arrived. */
  function tiersDe(lido: Awaited<ReturnType<typeof modelos>>): ReturnType<typeof tiersDoItem> {
    expect(lido.tier_variation).not.toBeNull();
    expect(lido.standardise_tier_variation).not.toBeNull();
    return tiersDoItem({
      tiers: lido.tier_variation ?? [],
      padronizados: lido.standardise_tier_variation ?? [],
    });
  }

  it(`${FIXTURE_MODEL_LIST_BR_ANUNCIO_VARIACOES}: \`standardise_tier_variation[0]\` NÃO tem a chave \`variation_group_id\` (lida como 0); o [1] tem 844758844060204`, () => {
    const corpo = lerFixture(FIXTURE_MODEL_LIST_BR_ANUNCIO_VARIACOES) as unknown as {
      response: { standardise_tier_variation: Record<string, unknown>[] };
    };
    const padronizados = corpo.response.standardise_tier_variation;
    expect(padronizados).toHaveLength(2);
    expect(padronizados[0]?.variation_id).toBe(VARIACAO_COR);
    expect('variation_group_id' in (padronizados[0] ?? {})).toBe(false);
    expect(padronizados[1]?.variation_id).toBe(VARIACAO_TAMANHO);
    expect(padronizados[1]?.variation_group_id).toBe(GRUPO_TAMANHO_BR);
  });

  it(`${FIXTURE_MODEL_LIST_BR_ANUNCIO_VARIACOES}: \`tiersDoItem\` lê Cor (101054) com grupo 0 e Tamanho (101056) com 844758844060204`, async () => {
    const lido = await modelos();
    const tiers = tiersDe(lido);
    expect(tiers.map((t) => [t.variationId, t.variationGroupId])).toEqual([
      [VARIACAO_COR, 0],
      [VARIACAO_TAMANHO, GRUPO_TAMANHO_BR],
    ]);
  });

  it(`${FIXTURE_MODEL_LIST_BR_ANUNCIO_VARIACOES}: \`planejarTaxonomia\` (memo vazio) grava \`variation_group_list\` 844758844060204 no Tamanho e 0 na Cor`, async () => {
    const lido = await modelos();
    const tiers = tiersDe(lido);
    const plano = planejarTaxonomia({
      tiers,
      modelos: lido.model,
      candidatos: [],
      integracaoId: INTEGRACAO,
      categoryId: 100352,
      nomeCategoria: '',
      nowMs: AGORA_MS,
    });

    const entradas = (grupoId: string): unknown => {
      const grupo = plano.grupos.find((g) => g.grupoId === grupoId);
      expect(grupo?.criar, grupoId).toBe(true);
      return grupo?.docNovo?.linksVariacoesShopee;
    };
    expect(entradas(`shopee-${String(VARIACAO_COR)}`)).toEqual([
      expect.objectContaining({ variation_id: VARIACAO_COR, variation_group_list: 0 }),
    ]);
    expect(entradas(`shopee-${String(VARIACAO_TAMANHO)}`)).toEqual([
      expect.objectContaining({
        variation_id: VARIACAO_TAMANHO,
        variation_group_list: GRUPO_TAMANHO_BR,
        integracaoShopeeId: INTEGRACAO,
      }),
    ]);
  });

  it(`${FIXTURE_MODEL_LIST_BR_ANUNCIO_VARIACOES}: (#1911 P14a R3) sobre um grupo Cor JÁ vinculado, \`planejarTaxonomia\` grava 844758844060204 no Tamanho, e a opção do vendedor (id 0) liga pela LINHA armazenada — não pelo nome da variante`, async () => {
    const lido = await modelos();
    const tiers = tiersDe(lido);
    const categoria = 100352;
    // An INVENTED ERP grupo whose stored entry already binds the seller's id-0
    // option (as the import, the legacy form or the binding editor writes it) to
    // a variante the operator named otherwise.
    const linha = {
      shopee_option_id: 0,
      shopee_option_name: 'Opção inventada 1',
      arakene_variation_id: ['v-erp'],
    };
    const plano = planejarTaxonomia({
      tiers,
      modelos: lido.model,
      candidatos: [
        {
          id: 'g-cor',
          raw: {
            nome: 'Cor',
            variacoes: [{ id: 'v-erp', nome: 'Cor do ERP' }],
            linksVariacoesShopee: [
              {
                name: '',
                category_id: categoria,
                variation_id: VARIACAO_COR,
                variation_group_list: 0,
                integracaoShopeeId: INTEGRACAO,
                variationOptions: [linha],
              },
            ],
          },
        },
      ],
      integracaoId: INTEGRACAO,
      categoryId: categoria,
      nomeCategoria: '',
      nowMs: AGORA_MS,
    });

    const cor = plano.grupos.find((g) => g.grupoId === 'g-cor');
    expect(cor?.criar).toBe(false);
    // The seller's option sits at WIRE index 4 (pin 9 below); its four
    // standard siblings bind nothing stored and are created by id.
    expect(cor?.varianteIds).toEqual([
      'shopee-9632',
      'shopee-6245',
      'shopee-9186',
      'shopee-9179',
      'v-erp',
    ]);
    const variacoes = (cor?.patch?.variacoes ?? []) as { readonly id: string }[];
    // `casado.variacoes` first, then rung 4's pushes in wire order; no `n-` twin of
    // the seller's option.
    expect(variacoes.map((v) => v.id)).toEqual([
      'v-erp',
      'shopee-9632',
      'shopee-6245',
      'shopee-9186',
      'shopee-9179',
    ]);
    const entradas = (cor?.patch?.linksVariacoesShopee ?? []) as {
      readonly variationOptions: readonly { readonly shopee_option_id: number }[];
    }[];
    expect(entradas).toHaveLength(1);
    expect(entradas[0]?.variationOptions.filter((o) => o.shopee_option_id === 0)).toEqual([linha]);
    // The five models on that option carry the bound variante.
    expect(
      plano.combos.filter((c) => c.variacoesUid?.includes(varianteFakePath('g-cor', 'v-erp')))
        .length,
    ).toBe(5);

    const tamanho = plano.grupos.find((g) => g.grupoId === `shopee-${String(VARIACAO_TAMANHO)}`);
    expect(tamanho?.criar).toBe(true);
    expect(tamanho?.docNovo?.linksVariacoesShopee).toEqual([
      expect.objectContaining({
        variation_id: VARIACAO_TAMANHO,
        variation_group_list: GRUPO_TAMANHO_BR,
        integracaoShopeeId: INTEGRACAO,
      }),
    ]);
  });

  it(`${FIXTURE_MODEL_LIST_BR_ANUNCIO_VARIACOES}: (#1911 P14a M1) o corpo commitado pela PUBLICAÇÃO: a opção do vendedor (id 0) sob a variação padrão pareia pela linha {0, …}, no índice 4 — e o republish não muda nada`, async () => {
    const lido = await modelos();
    const categoria = 100352;
    const entradaDe = (
      variationId: number,
      grupoVariacao: number,
      linha: {
        readonly shopee_option_id: number;
        readonly shopee_option_name: string;
        readonly arakene_variation_id: readonly string[];
      },
    ) => ({
      name: '',
      category_id: categoria,
      variation_id: variationId,
      variation_group_list: grupoVariacao,
      integracaoShopeeId: INTEGRACAO,
      variationOptions: [linha],
    });
    // The capture's model on that option and Tamanho P (public taxonomy, 6857). Its
    // id and SKU are read back from the body, never named here (this file's header).
    const modelo = lido.model.find((m) => m.tier_index.join() === '4,1');
    expect(modelo).toBeDefined();
    const sku = modelo?.model_sku ?? null;
    expect(sku).not.toBeNull();

    const r = montarTiers({
      integracaoId: INTEGRACAO,
      categoryId: categoria,
      bandaDeEstoque: null,
      bandaNomeDoTier: null,
      bandaNomeDaOpcao: null,
      viva: lido,
      grupos: [
        {
          grupoId: 'g-cor',
          nome: 'Cor',
          ordem: 1,
          permiteFotos: false,
          variacoes: [{ varianteId: 'v-erp', nome: 'Cor do ERP', ordem: 0 }],
          linksVariacoesShopee: [
            entradaDe(VARIACAO_COR, 0, {
              shopee_option_id: 0,
              shopee_option_name: 'Opção inventada 1',
              arakene_variation_id: ['v-erp'],
            }),
          ],
        },
        {
          grupoId: 'g-tam',
          nome: 'Tamanho',
          ordem: 2,
          permiteFotos: false,
          variacoes: [{ varianteId: 'v-p', nome: 'P', ordem: 0 }],
          linksVariacoesShopee: [
            entradaDe(VARIACAO_TAMANHO, GRUPO_TAMANHO_BR, {
              shopee_option_id: 6857,
              shopee_option_name: 'P',
              arakene_variation_id: ['v-p'],
            }),
          ],
        },
      ],
      filhos: [
        {
          produtoId: 'p-filho',
          sku,
          gtin: null,
          ordem: 1,
          variacoesUid: [varianteFakePath('g-cor', 'v-erp'), varianteFakePath('g-tam', 'v-p')],
          preco: 10,
          estoque: 5,
          fotos: [],
          linkModelId: null,
          linkDocId: 'l-filho',
          tierIndexArmazenado: null,
        },
      ],
    });
    expect(r.problemas).toEqual([]);
    expect(r.tiers[0]?.opcoes).toHaveLength(5);
    expect(r.tiers[0]?.opcoes[4]?.varianteId).toBe('v-erp');
    expect(r.modelos.map((m) => m.tier_index)).toEqual([[4, 1]]);

    const plano = reconciliarModelos({
      montados: r.modelos,
      armazenados: [
        {
          produtoId: 'p-filho',
          linkDocId: 'l-filho',
          modelId: modelo?.model_id ?? 0,
          modelSku: sku,
          tierIndex: [4, 1],
        },
      ],
      viva: lido,
      profundidadeNossa: r.tiers.length,
    });
    expect(plano.acao).toBe('nenhuma');
    expect(plano.modelList).toHaveLength(25);
    expect(plano.modelosSemFilho).toHaveLength(24);
  });

  it(`${FIXTURE_MODEL_LIST_BR_ANUNCIO_VARIACOES}: 25 modelos, 25 \`tier_index\` distintos`, async () => {
    const lido = await modelos();
    expect(lido.model.length).toBe(25);
    expect(new Set(lido.model.map((m) => JSON.stringify(m.tier_index))).size).toBe(25);
  });
});

/* -------------------------------------------------------------------------- */
/*                         Pin 7 — the shop's channels                        */
/* -------------------------------------------------------------------------- */

describe(`pino 7 — ${FIXTURE_CHANNEL_LIST_BR}`, () => {
  it(`${FIXTURE_CHANNEL_LIST_BR}: 4 linhas; \`lerCanaisDaLoja\` mantém as 4; todas SIZE_INPUT com \`mask_channel_id\` 0; 90022 desligado`, async () => {
    const cru = lerFixture(FIXTURE_CHANNEL_LIST_BR) as unknown as {
      response: { logistics_channel_list: unknown[] };
    };
    expect(cru.response.logistics_channel_list).toHaveLength(4);

    const { client, pedidos } = clienteDoCorpo(FIXTURE_CHANNEL_LIST_BR);
    const canais = await lerCanaisDaLoja(client);

    expect(pedidos.map((p) => [p.metodo, p.caminho])).toEqual([
      ['GET', SHOPEE_GET_CHANNEL_LIST_PATH],
    ]);
    expect(canais).toHaveLength(4);
    expect(canais.filter((c) => c.fee_type === 'SIZE_INPUT')).toHaveLength(4);
    expect(canais.filter((c) => c.mask_channel_id === 0)).toHaveLength(4);
    expect(canais.filter((c) => c.logistics_channel_id === 90022).map((c) => c.enabled)).toEqual([
      false,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*              Pin 8 — the item bodies are redacted and pseudonymised        */
/* -------------------------------------------------------------------------- */

const CORPOS_DE_ITEM = [
  FIXTURE_ITEM_BASE_INFO_BR_ANUNCIO_ATRIBUTOS,
  FIXTURE_ITEM_BASE_INFO_BR_ANUNCIO_LOGISTICA,
  FIXTURE_ITEM_BASE_INFO_BR_ANUNCIO_VARIACOES,
] as const;

/** Every string under a key named `item_sku` or `model_sku`, anywhere in a body. */
function skusDo(corpo: WireValue): string[] {
  const achados: string[] = [];
  const visitar = (v: WireValue): void => {
    if (Array.isArray(v)) {
      for (const x of v) visitar(x);
      return;
    }
    if (!ehObjeto(v)) return;
    for (const [chave, valor] of Object.entries(v)) {
      if ((chave === 'item_sku' || chave === 'model_sku') && typeof valor === 'string') {
        achados.push(valor);
      }
      visitar(valor);
    }
  };
  visitar(corpo);
  return achados;
}

describe('pino 8 — os três corpos de anúncio', () => {
  it.each(CORPOS_DE_ITEM)(
    '%s: parseia pelo cliente e por `lerBaseDosItens`, com título e descrição `REDACTED` (a regra de título rodou)',
    async (file) => {
      const { client, pedidos } = clienteDoCorpo(file);
      const lido = await client.getItemBaseInfo({ itemIds: [ITEM_INVENTADO] });
      expect(pedidos.map((p) => p.caminho)).toEqual([SHOPEE_GET_ITEM_BASE_INFO_PATH]);
      // A boolean, never a diff: a failing `toEqual` would print the listing.
      expect(isDeepStrictEqual(lido, lerBaseDosItens(file))).toBe(true);

      expect(lido.item_list.length).toBe(1);
      expect(lido.item_list.every((i) => i?.item_name === 'REDACTED')).toBe(true);
      expect(lido.item_list.every((i) => i?.description === 'REDACTED')).toBe(true);
    },
  );

  it('CORPOS_BR_1911 (os 21 corpos `.br-`): todo `item_sku` / `model_sku` tem a forma do pseudônimo (28: 3 de anúncio + 25 de modelo)', () => {
    const skus = CORPOS_BR_1911.flatMap((file) => skusDo(lerFixture(file)));
    // Counts, never the values: a failing matcher must not print a SKU.
    expect(skus.length).toBe(28);
    expect(skus.filter((sku) => !/^SKU-[0-9a-f]{8}$/.test(sku)).length).toBe(0);
  });

  it.each(CORPOS_BR_1911)(
    '%s: nenhuma URL além do placeholder do redator e nenhum id de imagem da Shopee — só `imagem-redigida`',
    (file) => {
      // The redactor is a DENYLIST and `piiScan` has no URL pattern, so a URL at
      // a path no entry names, or an image id the capture script failed to
      // replace (`image_id_list` is deliberately not denylisted), would reach a
      // public commit green. The kit set has this guard in `wireCorpus.test.ts`.
      const strings: string[] = [];
      const visitar = (v: WireValue): void => {
        if (typeof v === 'string') strings.push(v);
        else if (Array.isArray(v)) for (const x of v) visitar(x);
        else if (ehObjeto(v)) for (const x of Object.values(v)) visitar(x);
      };
      visitar(lerFixture(file));
      // Counts, never the values: a failing matcher must not print a URL or an image id.
      expect(
        strings.filter((s) => /https?:\/\//.test(s) && s !== 'https://redacted.invalid/imagem')
          .length,
      ).toBe(0);
      expect(strings.filter((s) => /^[a-z]{2}-\d+-/.test(s)).length).toBe(0);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*         Pin 9 — the listing reads are NEUTRALISED (Lucas 2026-11-05)        */
/* -------------------------------------------------------------------------- */

/**
 * The four bodies `neutralizarLeituraDeAnuncio` changes: the BR listing reads.
 * Pin 9 asserts that EVERY BR body is a fixpoint (so the other seventeen pass
 * through it), and that these four are exactly the BR `get_item_base_info` /
 * `get_model_list` bodies — a new listing read must join the value pins below.
 */
const CORPOS_NEUTRALIZADOS = [...CORPOS_DE_ITEM, FIXTURE_MODEL_LIST_BR_ANUNCIO_VARIACOES] as const;

/** Every leaf of a body with its dotted path (`*` for an array index). */
function folhasDe(corpo: WireValue): { readonly caminho: string; readonly valor: WireValue }[] {
  const achadas: { caminho: string; valor: WireValue }[] = [];
  const visitar = (v: WireValue, caminho: string): void => {
    if (Array.isArray(v)) v.forEach((x) => visitar(x, `${caminho}.*`));
    else if (ehObjeto(v)) for (const [k, x] of Object.entries(v)) visitar(x, `${caminho}.${k}`);
    else achadas.push({ caminho, valor: v });
  };
  visitar(corpo, '');
  return achadas;
}

/** The model-row prefix of `CAMPOS_NEUTRALIZADOS`' stock paths. */
const PREFIXO_DO_MODELO = 'response.model.*';

/**
 * The stock counts `neutralizarAnuncio.ts` replaces, read from its own
 * `CAMPOS_NEUTRALIZADOS` (never a third hand-written copy), as path SUFFIXES
 * from `.stock_info_v2` on — so the same matcher also finds a stock leaf on an
 * item row, where the transform does not reach.
 */
const CAMINHOS_DE_ESTOQUE = CAMPOS_NEUTRALIZADOS.filter((c) => c.includes('.stock_info_v2.'));
const ESTOQUES = new RegExp(
  `(?:${CAMINHOS_DE_ESTOQUE.map((c) => {
    if (!c.startsWith(`${PREFIXO_DO_MODELO}.`)) throw new Error(`not a model path: ${c}`);
    return c.slice(PREFIXO_DO_MODELO.length).replace(/[.*]/g, (s) => `\\${s}`);
  }).join('|')})$`,
);

describe(`pino 9 — as leituras de anúncio estão NEUTRALIZADAS (${CORPOS_NEUTRALIZADOS.join(', ')})`, () => {
  it.each(CORPOS_BR_1911)(
    '%s: o corpo commitado é ponto fixo de `neutralizarLeituraDeAnuncio`',
    (file) => {
      const commitado = lerFixture(file);
      // A boolean, never a diff: a failing `toEqual` would print the body.
      expect(isDeepStrictEqual(neutralizarLeituraDeAnuncio(commitado), commitado)).toBe(true);
      // Key order too: `isDeepStrictEqual` ignores it, the serialised text does not.
      expect(
        JSON.stringify(neutralizarLeituraDeAnuncio(commitado)) === JSON.stringify(commitado),
      ).toBe(true);
    },
  );

  it('CORPOS_BR_1911: as leituras de anúncio (`get_item_base_info` / `get_model_list`) são EXATAMENTE os quatro corpos neutralizados', () => {
    expect(CORPOS_BR_1911.filter((f) => /^get_(item_base_info|model_list)\./.test(f))).toEqual(
      [...CORPOS_NEUTRALIZADOS].sort(),
    );
  });

  it.each(CORPOS_BR_1911.filter((f) => f.startsWith('get_item_base_info.')))(
    '%s: a linha do anúncio não traz preço, estoque nem preço de atacado — folhas que a neutralização NÃO alcança',
    (file) => {
      // A red here means a model-less (`has_model: false`) listing carries
      // item-level price or stock leaves that `neutralizarLeituraDeAnuncio`
      // does not touch. The transform must then be extended — with Lucas's
      // approval, since it is outside his 2026-11-05 scope — before that body
      // is committed. Counts only.
      const folhas = folhasDe(lerFixture(file));
      expect(
        folhas.filter((f) =>
          (CHAVES_DE_PRECO as readonly string[]).includes(f.caminho.split('.').at(-1) ?? ''),
        ).length,
      ).toBe(0);
      expect(folhas.filter((f) => ESTOQUES.test(f.caminho)).length).toBe(0);
      expect(folhas.filter((f) => /\.wholesales?\./.test(f.caminho)).length).toBe(0);
    },
  );

  it.each(CORPOS_DE_ITEM)('%s: `create_time` e `update_time` são as constantes neutras', (file) => {
    const linhas = lerBaseDosItens(file).item_list;
    expect(linhas.length).toBe(1);
    expect(linhas.every((l) => l?.create_time === CRIACAO_NEUTRA)).toBe(true);
    expect(linhas.every((l) => l?.update_time === ATUALIZACAO_NEUTRA)).toBe(true);
  });

  it(`${FIXTURE_MODEL_LIST_BR_ANUNCIO_VARIACOES}: os 100 preços são PRECO_NEUTRO e as 150 contagens de estoque estão em {0, ESTOQUE_NEUTRO}`, () => {
    const folhas = folhasDe(lerFixture(FIXTURE_MODEL_LIST_BR_ANUNCIO_VARIACOES));
    const precos = folhas.filter((f) =>
      (CHAVES_DE_PRECO as readonly string[]).includes(f.caminho.split('.').at(-1) ?? ''),
    );
    expect(precos.length).toBe(100);
    expect(precos.filter((f) => f.valor !== PRECO_NEUTRO).length).toBe(0);

    // The six documented stock paths × 25 models: the matcher is the module's own list.
    expect(CAMINHOS_DE_ESTOQUE.length).toBe(6);
    const estoques = folhas.filter((f) => ESTOQUES.test(f.caminho));
    expect(estoques.length).toBe(150);
    expect(estoques.filter((f) => f.valor !== 0 && f.valor !== ESTOQUE_NEUTRO).length).toBe(0);
    // Both arms are present: in-stock AND sold-out models survived the transform.
    expect(estoques.filter((f) => f.valor === ESTOQUE_NEUTRO).length).toBeGreaterThan(0);
    expect(estoques.filter((f) => f.valor === 0).length).toBeGreaterThan(0);
  });

  it(`${FIXTURE_MODEL_LIST_BR_ANUNCIO_VARIACOES}: a ÚNICA opção do vendedor (Cor, id 0, índice 4) lê \`Opção inventada 1\` no tier e na lista padronizada, e todo \`model_name\` é a junção das opções (5 com ela)`, async () => {
    const { client } = clienteDoCorpo(FIXTURE_MODEL_LIST_BR_ANUNCIO_VARIACOES);
    const lido = await client.getModelList({ itemId: ITEM_INVENTADO });
    const tiers = lido.tier_variation ?? [];
    const padronizados = lido.standardise_tier_variation ?? [];
    expect(padronizados[0]?.variation_id).toBe(VARIACAO_COR);

    const idsZero = padronizados.flatMap((p, t) =>
      p.variation_option_list.flatMap((o, i) => (o.variation_option_id === 0 ? [[t, i]] : [])),
    );
    expect(idsZero).toEqual([[0, 4]]);
    expect(tiers[0]?.option_list[4]?.option === 'Opção inventada 1').toBe(true);
    expect(
      padronizados[0]?.variation_option_list[4]?.variation_option_name === 'Opção inventada 1',
    ).toBe(true);

    const juncao = (m: (typeof lido.model)[number]): string =>
      m.tier_index.map((ix, t) => tiers[t]?.option_list[ix]?.option ?? '').join(',');
    expect(lido.model.length).toBe(25);
    expect(lido.model.filter((m) => m.model_name !== juncao(m)).length).toBe(0);
    expect(
      lido.model.filter(
        (m) => typeof m.model_name === 'string' && m.model_name.includes('Opção inventada 1'),
      ).length,
    ).toBe(5);
  });
});
