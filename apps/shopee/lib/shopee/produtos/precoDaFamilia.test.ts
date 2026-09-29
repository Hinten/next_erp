/**
 * **A regra da família** do import (Lucas, 2026-09-28): quando o import FORMA a
 * família de um anúncio COM models — CRIA o pai, ou o pai é um produto
 * existente SEM filhos ainda — ele decide o preço do pai e o seu
 * `propagatePriceToChildren` a partir dos preços dos models —
 * `planejarPrecoDaFamilia`, a ÚNICA cópia, alcançada pelo planejador de anúncio,
 * pelo braço de kit e (por esses dois) pelo job em massa. No produto sem filhos
 * preço e flag vão JUNTOS no patch guardado (`update(…, { lastUpdateTime })`), e
 * só com AS DUAS opções de preço ligadas — os filhos nascem sob `importarPreco`,
 * o pai é sobrescrito sob `sobrescreverPreco` (V-1); fora disso, o import de
 * antes da regra.
 *
 * ⛔ Numa REIMPORTAÇÃO de um pai que JÁ TEM filhos o import não escreve NEM a
 * flag NEM um preço no pai — byte a byte o import de antes da regra
 * (`a1dd294f`). A flag de uma família existente é do operador: ligá-la faz o
 * gatilho do produto trocar o mapa `precos` INTEIRO de cada filho pelo do pai
 * (apagando preços por variação em outras tabelas, e repreçando variações do
 * ERP que nem estão no anúncio); desligá-la deixa sem preço os filhos que
 * dependiam do pai em outras tabelas. Nada disso existe sem filhos.
 *
 * ⛔ O braço da CORRIDA da criação (`.create()` ⇒ ALREADY_EXISTS ⇒ merge) nunca
 * mescla o preço nem a flag da regra: o documento no id determinístico pode ser
 * um pai que uma tentativa anterior criou e nunca vinculou. Depois do merge ele
 * é decidido como o produto sem filhos que quase sempre é (V-2): sem filho no
 * ERP, a regra pelo MESMO patch guardado; com um filho, nada mais.
 *
 * O bloco 5 é o INVARIANTE que motivou a regra, para a CRIAÇÃO e para o produto
 * sem filhos: importar uma família e logo precificá-la com o `precificarItem` do
 * passo 13 (lendo pelo `lerPrecosDosProdutos`, no MESMO banco) — e prepará-la
 * para a publicação do passo 11 — dá a cada model exatamente o seu preço de
 * prateleira na Shopee. Na REIMPORTAÇÃO de uma família a volta NÃO é prometida —
 * um pai que propaga continua precificando os seus models pelo próprio mapa — e
 * o bloco fixa esse comportamento documentado.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { produtoCollection } from '@delfrance/data/admin/collections';
import {
  SHOPEE_GET_VARIATIONS_PATH,
  SHOPEE_ITEM_STATUS_WRITABLE,
  SHOPEE_LOGISTICS_FEE_TYPE,
  shopeeCategoriaSchema,
  shopeeItemBaseInfoRowSchema,
  shopeeKitItemSchema,
  shopeeLogisticsChannelSchema,
  shopeeModelListPayloadSchema,
  type ShopeeCategoria,
  type ShopeeClient,
  type ShopeeItemBaseInfo,
  type ShopeeKitItem,
  type ShopeeKitItemInfo,
  type ShopeeModel,
  type ShopeePriceInfo,
} from '@delfrance/integrations-shopee';
import { roundReais } from '@delfrance/core/money';
import { importacaoShopeeOptionsSchema, type ImportacaoShopeeOptions } from '@delfrance/schemas';

import { MOTIVO_PUBLICACAO_BLOQUEADA } from '../anuncios/errosPublicacao';
import type { ResolvedorDeImagensShopee } from '../anuncios/fotosPublicacao';
import {
  planejarPublicacao,
  prepararPublicacao,
  resolverFotosDaPublicacao,
} from '../anuncios/publicarAnuncio';
import { lerFamiliasDePrecoPorIds, lerPrecosDosProdutos } from '../precos/descobertaPreco';
import { montarItensDePreco, precificarItem } from '../precos/planoPreco';
import { limparTaxonomiaShopee } from '../taxonomia/cache';
import { construirIndice } from '../taxonomia/categorias';
import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import { criarMemoDeCategorias } from './categoriaShopee';
import { ShopeePrecoDesatualizadoError, aplicarPrecosShopee } from './estoquePrecos';
import { processarImportacaoShopee } from './importacaoMassa';
import { importarAnuncioShopee } from './importarAnuncio';
import { renderResumoImportacao, resumoDoPlano } from './importarAnuncioCli';
import type {
  ContextoImportacaoShopee,
  ImportarAnuncioDeps,
  ItemLido,
  ResultadoImportacaoShopee,
} from './itemLido';
import { importarKitShopee } from './kitShopee';
import {
  mapearProdutoPai,
  planejarPrecoDaFamilia,
  precoDePrateleiraDe,
  type ArgsMapearProdutoPai,
} from './mapeamento';
import {
  planejarImportacaoShopee,
  type PlanoImportacaoShopee,
  type PreparoImportacaoShopee,
} from './planoImportacao';
import { idDoFilhoPlanejado, idDoPaiPlanejado } from './resolveProduto';

/* ---------------------------------- fixtures ------------------------------ */

const ITEM_ID = 2500139861;
const COMPONENTE = 2500139862;
const KIT_ID = 2500139863;
const MODEL_A = 2000458802;
const MODEL_B = 2000458803;
const MODEL_C = 2000458804;
const INTEGRACAO = 'int-1';
const REF_CONTA = `documents/integracao/${INTEGRACAO}`;
const TABELA_NORMAL = 'documents/listaDePrecos/tab-normal';
/** ⚠️ `produto.precos` é chaveado pelo ID do documento da lista, nunca pelo ref. */
const TABELA_NORMAL_ID = 'tab-normal';
const DEPOSITO = 'documents/depositos/dep-1';
const PAI_EXISTENTE = 'pai-existente';
/** Um produto SIMPLES do ERP, sem filhos, que o anúncio COM models encontra pelo SKU. */
const SIMPLES = 'simples-erp';
const AGORA = 1_757_000_000_000;

/**
 * Um preço BRL com uma PROMOÇÃO por baixo — o de prateleira é `original_price`,
 * e é ele (nunca o `current_price`) que o pai e os filhos recebem.
 */
function brl(prateleira: number): ShopeePriceInfo[] {
  return [
    { currency: 'BRL', original_price: prateleira, current_price: prateleira - 1 },
  ] as ShopeePriceInfo[];
}

/** O zero-fill da Shopee: a entrada existe e não tem preço nenhum. */
const ZERADO = [{ currency: 'BRL', original_price: 0, current_price: 0 }] as ShopeePriceInfo[];
/** A sandbox SG: a entrada existe, a moeda não é BRL. */
const SGD = [{ currency: 'SGD', original_price: 49.9, current_price: 49.9 }] as ShopeePriceInfo[];

function opcoes(parcial: Partial<ImportacaoShopeeOptions> = {}): ImportacaoShopeeOptions {
  return importacaoShopeeOptionsSchema.parse({ importarFotos: false, ...parcial });
}

/** A família: um model por preço, na ordem dada, cada um num tier próprio. */
function anuncio(precos: readonly (ShopeePriceInfo[] | null)[]): ItemLido {
  const ids = [MODEL_A, MODEL_B, MODEL_C];
  const models = shopeeModelListPayloadSchema.parse({
    model: precos.map((price_info, i) => ({
      model_id: ids[i],
      tier_index: [i],
      model_sku: `CAM-001-${String(i)}`,
      price_info,
    })),
    tier_variation: [
      { name: 'Cor', option_list: precos.map((_, i) => ({ option: `Cor ${String(i)}` })) },
    ],
  });
  const base = shopeeItemBaseInfoRowSchema.parse({
    item_id: ITEM_ID,
    item_name: 'Camiseta Básica',
    item_sku: 'CAM-001',
    category_id: 100017,
    has_model: true,
  });
  return { base, models, taxInfo: null, kit: null, itemId: ITEM_ID };
}

function modelosDe(entrada: ItemLido): readonly ShopeeModel[] {
  return entrada.models?.model ?? [];
}

/** O preparo PURO de uma família — o que o planejador recebe. */
function preparo(
  entrada: ItemLido,
  parcial: Partial<PreparoImportacaoShopee> = {},
): PreparoImportacaoShopee {
  return {
    entrada,
    integracaoId: INTEGRACAO,
    nowMs: AGORA,
    options: opcoes(),
    tabelaNormalOuterRef: TABELA_NORMAL,
    tabelaPromocionalOuterRef: null,
    depositoOuterRef: DEPOSITO,
    pai: {
      existente: null,
      extraData: null,
      linkSobFilho: false,
      jaTemFilhos: false,
      estoque: null,
    },
    filhos: modelosDe(entrada).map((modelo) => ({
      modelo,
      existente: null,
      vinculoDeOutraFamilia: false,
      link: null,
      estoque: null,
    })),
    linkPai: null,
    grupos: { docs: [] },
    categorias: [],
    imagensJaCacheadas: [],
    ...parcial,
  };
}

const EXISTENTE = { id: PAI_EXISTENTE, raw: { nome: 'Camiseta Básica', paiId: null } };
const SEM_FILHOS = { id: SIMPLES, raw: { nome: 'Camiseta Básica', sku: 'CAM-001', paiId: null } };

function plano(entrada: ItemLido, parcial: Partial<PreparoImportacaoShopee> = {}) {
  return planejarImportacaoShopee(preparo(entrada, parcial));
}

/** A reimportação de uma FAMÍLIA — o pai existe e JÁ TEM filhos no ERP. */
function planoDeAtualizacao(
  entrada: ItemLido,
  parcial: Partial<PreparoImportacaoShopee> = {},
): PlanoImportacaoShopee {
  return plano(entrada, {
    pai: { ...preparo(entrada).pai, existente: EXISTENTE, jaTemFilhos: true },
    ...parcial,
  });
}

/** Um produto existente SEM filhos que o anúncio transforma em família. */
function planoDeProdutoSemFilhos(
  entrada: ItemLido,
  parcial: Partial<PreparoImportacaoShopee> = {},
): PlanoImportacaoShopee {
  return plano(entrada, {
    pai: { ...preparo(entrada).pai, existente: SEM_FILHOS, jaTemFilhos: false },
    ...parcial,
  });
}

/**
 * Só o preço dos models: `planejarPrecoDaFamilia` não lê mais nada deles.
 * `criar` ⇒ o pai é CRIADO; `false` ⇒ um produto existente SEM filhos.
 */
function familia(
  precos: readonly (ShopeePriceInfo[] | null)[],
  options: ImportacaoShopeeOptions = opcoes(),
  criar = true,
) {
  return planejarPrecoDaFamilia({
    criar,
    options,
    tabelaNormalOuterRef: TABELA_NORMAL,
    modelos: precos.map((price_info) => ({ price_info })),
  });
}

/** `Roupas > Camisetas > Manga Curta`. */
const ARVORE: ShopeeCategoria[] = [
  { category_id: 100001, parent_category_id: 0, display_category_name: 'Roupas' },
  { category_id: 100009, parent_category_id: 100001, display_category_name: 'Camisetas' },
  { category_id: 100017, parent_category_id: 100009, display_category_name: 'Manga Curta' },
].map((c) => shopeeCategoriaSchema.parse({ has_children: false, ...c }));

/** Um cliente que só responde `get_category` — e LANÇA em qualquer outra chamada. */
function clienteDeCategorias(): ShopeeClient {
  return new Proxy({} as Record<string, unknown>, {
    get(_alvo, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'getCategory') return () => Promise.resolve({ category_list: [...ARVORE] });
      return () => {
        throw new Error(`o importador chamou a Shopee: ${prop}`);
      };
    },
  }) as unknown as ShopeeClient;
}

beforeEach(() => {
  limparTaxonomiaShopee();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

function deps(db: FakeDb, parcial: Partial<ImportarAnuncioDeps> = {}): ImportarAnuncioDeps {
  return {
    db: asDb(db),
    integracaoId: INTEGRACAO,
    tabelaNormalOuterRef: TABELA_NORMAL,
    tabelaPromocionalOuterRef: null,
    depositoOuterRef: DEPOSITO,
    options: opcoes(),
    nowMs: AGORA,
    categorias: criarMemoDeCategorias(clienteDeCategorias(), INTEGRACAO),
    ...parcial,
  };
}

function docDoProduto(db: FakeDb, produtoId: string): Record<string, unknown> {
  return (db.store[`produtos/${produtoId}`]?.data ?? {}) as Record<string, unknown>;
}

/** O pai já existente, com o `prodshopee` que faz o degrau 1 da cascata resolvê-lo. */
function semearPaiExistente(db: FakeDb, campos: Record<string, unknown>): void {
  db.seed(`produtos/${PAI_EXISTENTE}`, {
    nome: 'Camiseta Básica',
    sku: 'CAM-001',
    paiId: null,
    ...campos,
  });
  db.seed(`produtos/${PAI_EXISTENTE}/prodshopee/link-1`, {
    item_id: ITEM_ID,
    contaProdutoShopeeOuterRef: REF_CONTA,
  });
}

/**
 * Uma variação do ERP que o anúncio NÃO alcança (SKU próprio, sem vínculo) —
 * o que faz do pai uma FAMÍLIA existente, cuja flag é do operador.
 */
function semearVariacaoDoErp(db: FakeDb, paiId = PAI_EXISTENTE): void {
  db.seed('produtos/variacao-do-erp', {
    nome: 'Camiseta Básica Rosa',
    sku: 'CAM-001-RS',
    paiId,
    precos: { [TABELA_NORMAL_ID]: { valor: 8 }, 'tab-atacado': { valor: 3 } },
  });
}

/** O produto simples do ERP, SEM filhos e SEM vínculo — o degrau do SKU o resolve. */
function semearProdutoSemFilhos(db: FakeDb, campos: Record<string, unknown>): void {
  db.seed(`produtos/${SIMPLES}`, {
    nome: 'Camiseta Básica',
    sku: 'CAM-001',
    paiId: null,
    ...campos,
  });
}

/**
 * As escritas no documento do PAI a partir de `desde` que tocam o preço ou a
 * flag — uma chave `propagatePriceToChildren`, `precos` ou `precos.<tabela>`.
 */
function escritasDePrecoNoPai(db: FakeDb, paiId: string, desde = 0) {
  return db.writes
    .slice(desde)
    .filter((w) => w.path === `produtos/${paiId}`)
    .filter((w) =>
      Object.keys(w.patch).some(
        (k) => k === 'propagatePriceToChildren' || k === 'precos' || k.startsWith('precos.'),
      ),
    );
}

/* ------------------------ 1. a função, isolada ---------------------------- */

describe('planejarPrecoDaFamilia — a regra da família na CRIAÇÃO (Lucas, 2026-09-28)', () => {
  it('todos os models com o MESMO preço ⇒ o pai recebe esse preço (o de prateleira) E a propagação LIGADA', () => {
    expect(familia([brl(49.9), brl(49.9), brl(49.9)])).toEqual({
      precos: { tabelaId: TABELA_NORMAL_ID, valor: 49.9 },
      propagaPreco: true,
      motivo: null,
    });
  });

  it('⚠️ PAR — `10` e `10.004` caem no MESMO centavo ⇒ um preço só: o pai leva o do PRIMEIRO model e propaga', () => {
    expect(familia([brl(10), brl(10.004)])).toEqual({
      precos: { tabelaId: TABELA_NORMAL_ID, valor: 10 },
      propagaPreco: true,
      motivo: null,
    });
    // A ordem decide só QUAL dos dois vira o valor — nunca se há um preço só.
    expect(familia([brl(10.004), brl(10)]).precos?.valor).toBe(10.004);
  });

  it('⚠️ QUASE-IGUAL — `10.00` e `10.01` ficam a UM centavo ⇒ preços DIFERENTES: pai sem preço, propagação DESLIGADA', () => {
    expect(familia([brl(10.0), brl(10.01)])).toEqual({
      precos: null,
      propagaPreco: false,
      motivo: 'pai-com-filhos',
    });
  });

  it('preços diferentes, em qualquer posição ⇒ pai sem preço e `propagatePriceToChildren: false`', () => {
    expect(familia([brl(49.9), brl(59.9)]).propagaPreco).toBe(false);
    expect(familia([brl(49.9), brl(49.9), brl(59.9)]).propagaPreco).toBe(false);
    expect(familia([brl(59.9), brl(49.9), brl(49.9)]).precos).toBeNull();
  });

  it.each([
    ['zerado (o zero-fill da Shopee)', ZERADO],
    ['em SGD', SGD],
    ['sem `price_info`', null],
    ['com `price_info` vazio', [] as ShopeePriceInfo[]],
  ])(
    'UM model %s entre dois de preço igual ⇒ propagação DESLIGADA — nunca o preço dos outros',
    (_rotulo, semPreco) => {
      expect(familia([brl(49.9), semPreco, brl(49.9)])).toEqual({
        precos: null,
        propagaPreco: false,
        motivo: 'pai-com-filhos',
      });
    },
  );

  it('NENHUM model com preço utilizável (todos `moeda-nao-brl`, a sandbox SG) ⇒ nem preço NEM flag', () => {
    expect(familia([SGD, SGD])).toEqual({
      precos: null,
      propagaPreco: null,
      motivo: 'pai-com-filhos',
    });
  });

  it('nenhum model ⇒ nem preço nem flag (nada a comparar não é "todos iguais")', () => {
    expect(familia([])).toEqual({ precos: null, propagaPreco: null, motivo: 'pai-com-filhos' });
  });

  it('família de UM model só ⇒ um preço só ⇒ pai com o preço e a propagação ligada', () => {
    expect(familia([brl(49.9)])).toEqual({
      precos: { tabelaId: TABELA_NORMAL_ID, valor: 49.9 },
      propagaPreco: true,
      motivo: null,
    });
  });

  it('`importarPreco` desligado ⇒ nem preço NEM flag, mesmo com preços iguais', () => {
    expect(familia([brl(49.9), brl(49.9)], opcoes({ importarPreco: false }))).toEqual({
      precos: null,
      propagaPreco: null,
      motivo: 'opcao-desligada',
    });
  });

  it('⛔ QUASE-IGUAL — a opção é a da CRIAÇÃO: com só `sobrescreverPreco` desligado a regra ainda ESCREVE', () => {
    expect(familia([brl(49.9)], opcoes({ sobrescreverPreco: false }))).toEqual({
      precos: { tabelaId: TABELA_NORMAL_ID, valor: 49.9 },
      propagaPreco: true,
      motivo: null,
    });
  });

  it('PAR — num produto SEM filhos, com AS DUAS opções de preço ligadas, a regra ESCREVE: preço e propagação', () => {
    expect(familia([brl(49.9), brl(49.9)], opcoes(), false)).toEqual({
      precos: { tabelaId: TABELA_NORMAL_ID, valor: 49.9 },
      propagaPreco: true,
      motivo: null,
    });
    expect(familia([brl(49.9), brl(59.9)], opcoes(), false).propagaPreco).toBe(false);
  });

  it('⛔ QUASE-IGUAL (V-1) — num produto SEM filhos, só `importarPreco` desligado ⇒ nem preço NEM flag: os filhos NASCEM sem preço, e a resposta é a de antes da regra (`pai-com-filhos`)', () => {
    for (const precos of [
      [brl(49.9), brl(49.9)],
      [brl(49.9), brl(59.9)],
    ]) {
      expect(familia(precos, opcoes({ importarPreco: false }), false)).toEqual({
        precos: null,
        propagaPreco: null,
        motivo: 'pai-com-filhos',
      });
    }
  });

  it('num produto SEM filhos, `sobrescreverPreco` desligado ⇒ nem preço NEM flag, mesmo com preços iguais', () => {
    expect(familia([brl(49.9), brl(49.9)], opcoes({ sobrescreverPreco: false }), false)).toEqual({
      precos: null,
      propagaPreco: null,
      motivo: 'opcao-desligada',
    });
  });

  it('sem tabela normal na conta ⇒ nem preço nem flag', () => {
    expect(
      planejarPrecoDaFamilia({
        criar: true,
        options: opcoes(),
        tabelaNormalOuterRef: null,
        modelos: [{ price_info: brl(49.9) }],
      }),
    ).toEqual({ precos: null, propagaPreco: null, motivo: 'sem-tabela' });
  });

  it('`jaTemFilhos` é OBRIGATÓRIO no mapeador — quem não sabe dizer se o produto já tem filhos não compila (CA9)', () => {
    const base = {
      entrada: anuncio([brl(49.9), brl(49.9)]),
      existente: SEM_FILHOS,
      existenteExtraData: null,
      options: opcoes(),
      nowMs: AGORA,
      integracaoId: INTEGRACAO,
      tabelaNormalOuterRef: TABELA_NORMAL,
      depositoOuterRef: DEPOSITO,
      categoriaOuterRef: null,
      temFilhos: true,
      estoqueExistente: null,
    };
    // @ts-expect-error — sem `jaTemFilhos`: um valor omitido lido como "sem filhos" viraria a flag de uma família existente.
    const semOCampo: ArgsMapearProdutoPai = base;
    expect(semOCampo).toBe(base);
    // Dito pelo chamador, é o que vale: uma família existente não ganha nada…
    expect(mapearProdutoPai({ ...base, jaTemFilhos: true })).toMatchObject({
      precos: null,
      propagaPreco: null,
      precoIgnorado: 'pai-com-filhos',
    });
    // …e um produto sem filhos vira família pela regra.
    expect(mapearProdutoPai({ ...base, jaTemFilhos: false }).propagaPreco).toBe(true);
  });
});

/* ------------------- 2. o plano — onde preço e flag pousam ---------------- */

describe('o plano — CRIAÇÃO e produto SEM filhos aplicam a regra; a atualização de uma FAMÍLIA não escreve preço nem flag no pai', () => {
  it('CRIAÇÃO, preços iguais ⇒ `precos` E `propagatePriceToChildren: true` no documento do pai; cada filho com o SEU preço', () => {
    const p = plano(anuncio([brl(49.9), brl(49.9)]));
    expect(p.criar).toBe(true);
    expect(p.precosPai).toBeNull();
    expect(p.produtoPai?.data.precos).toEqual({ [TABELA_NORMAL_ID]: { valor: 49.9 } });
    expect(p.produtoPai?.data.propagatePriceToChildren).toBe(true);
    expect(p.propagaPrecoPai).toBe(true);
    expect(p.precoPaiIgnorado).toBeNull();
    for (const filho of p.filhos) {
      expect(filho.produto?.data.precos).toEqual({ [TABELA_NORMAL_ID]: { valor: 49.9 } });
      // Um filho NUNCA leva a flag — só a do pai é lida por quem envia.
      expect(filho.produto?.data).not.toHaveProperty('propagatePriceToChildren');
    }
  });

  it('CRIAÇÃO, preços diferentes ⇒ pai com `precos: null` e `propagatePriceToChildren: false`', () => {
    const p = plano(anuncio([brl(49.9), brl(59.9)]));
    expect(p.produtoPai?.data.precos).toBeNull();
    expect(p.produtoPai?.data.propagatePriceToChildren).toBe(false);
    expect(p.propagaPrecoPai).toBe(false);
    expect(p.precoPaiIgnorado).toBe('pai-com-filhos');
    expect(p.filhos.map((f) => f.produto?.data.precos)).toEqual([
      { [TABELA_NORMAL_ID]: { valor: 49.9 } },
      { [TABELA_NORMAL_ID]: { valor: 59.9 } },
    ]);
  });

  it('CRIAÇÃO com um model zerado ⇒ propagação DESLIGADA', () => {
    const p = plano(anuncio([brl(49.9), ZERADO]));
    expect(p.produtoPai?.data.propagatePriceToChildren).toBe(false);
    expect(p.produtoPai?.data.precos).toBeNull();
  });

  it('CRIAÇÃO sem preço NENHUM (SGD) ⇒ a chave nem aparece — o default do schema, como antes da regra', () => {
    const p = plano(anuncio([SGD, SGD]));
    expect(p.produtoPai?.data).not.toHaveProperty('propagatePriceToChildren');
    expect(p.propagaPrecoPai).toBeNull();
    expect(p.produtoPai?.data.precos).toBeNull();
  });

  it('CRIAÇÃO com `importarPreco` desligado ⇒ a chave nem aparece', () => {
    const p = plano(anuncio([brl(49.9), brl(49.9)]), {
      options: opcoes({ importarPreco: false }),
    });
    expect(p.produtoPai?.data).not.toHaveProperty('propagatePriceToChildren');
    expect(p.propagaPrecoPai).toBeNull();
  });

  it.each([
    ['preços iguais', [brl(49.9), brl(49.9)]],
    ['preços diferentes', [brl(49.9), brl(59.9)]],
    ['um model zerado', [brl(49.9), ZERADO]],
  ])(
    '⛔ ATUALIZAÇÃO de um pai que JÁ TEM filhos, %s ⇒ NEM preço NEM flag no pai: `pai-com-filhos`, sem patch guardado, como antes da regra',
    (_r, precos) => {
      const p = planoDeAtualizacao(anuncio(precos));
      expect(p.criar).toBe(false);
      expect(p.precosPai).toBeNull();
      expect(p.propagaPrecoPai).toBeNull();
      expect(p.precoPaiIgnorado).toBe('pai-com-filhos');
      expect(p.produtoPai?.data ?? {}).not.toHaveProperty('propagatePriceToChildren');
      expect(p.produtoPai?.data ?? {}).not.toHaveProperty('precos');
      // Cada filho (novo aqui) leva o SEU preço, exatamente como antes da regra.
      expect(p.filhos.map((f) => f.produto?.data.precos)).toEqual(
        modelosDe(anuncio(precos)).map((m) => {
          const valor = m.price_info?.[0]?.original_price ?? 0;
          return valor > 0 ? { [TABELA_NORMAL_ID]: { valor } } : null;
        }),
      );
    },
  );

  it('⛔ ATUALIZAÇÃO de uma família com só `importarPreco` desligado (`sobrescreverPreco` ligado) ⇒ ainda nada no pai — a regra nunca vê uma família existente', () => {
    const p = planoDeAtualizacao(anuncio([brl(49.9), brl(49.9)]), {
      options: opcoes({ importarPreco: false }),
    });
    expect(p.precosPai).toBeNull();
    expect(p.propagaPrecoPai).toBeNull();
    expect(p.precoPaiIgnorado).toBe('pai-com-filhos');
  });

  it('ATUALIZAÇÃO de uma família com `sobrescreverPreco` desligado ⇒ `opcao-desligada`, nem preço nem flag', () => {
    const p = planoDeAtualizacao(anuncio([brl(49.9), brl(49.9)]), {
      options: opcoes({ sobrescreverPreco: false }),
    });
    expect(p.precosPai).toBeNull();
    expect(p.propagaPrecoPai).toBeNull();
    expect(p.precoPaiIgnorado).toBe('opcao-desligada');
  });

  it('ATUALIZAÇÃO de uma família sem preço nenhum (SGD) ⇒ nem patch de preço nem flag', () => {
    const p = planoDeAtualizacao(anuncio([SGD, SGD]));
    expect(p.precosPai).toBeNull();
    expect(p.propagaPrecoPai).toBeNull();
    expect(p.precoPaiIgnorado).toBe('pai-com-filhos');
  });

  it('PRODUTO SEM FILHOS, preços iguais ⇒ preço E `propagatePriceToChildren: true` num ÚNICO patch GUARDADO — nunca no merge', () => {
    const p = planoDeProdutoSemFilhos(anuncio([brl(49.9), brl(49.9)]));
    expect(p.criar).toBe(false);
    expect(p.precosPai).toEqual({
      produtoId: SIMPLES,
      patch: {
        [`precos.${TABELA_NORMAL_ID}`]: { valor: 49.9 },
        propagatePriceToChildren: true,
      },
    });
    expect(p.propagaPrecoPai).toBe(true);
    expect(p.precoPaiIgnorado).toBeNull();
    // O merge simples (sem guarda) não leva nenhum dos dois.
    expect(p.produtoPai?.data ?? {}).not.toHaveProperty('propagatePriceToChildren');
    expect(p.produtoPai?.data ?? {}).not.toHaveProperty('precos');
  });

  it('PRODUTO SEM FILHOS, preços diferentes ⇒ SÓ a flag `false` no patch guardado — o preço antigo não é apagado', () => {
    const p = planoDeProdutoSemFilhos(anuncio([brl(49.9), brl(59.9)]));
    expect(p.precosPai).toEqual({
      produtoId: SIMPLES,
      patch: { propagatePriceToChildren: false },
    });
    expect(p.propagaPrecoPai).toBe(false);
    expect(p.precoPaiIgnorado).toBe('pai-com-filhos');
    expect(p.produtoPai?.data ?? {}).not.toHaveProperty('propagatePriceToChildren');
  });

  it('PRODUTO SEM FILHOS com `sobrescreverPreco` desligado ⇒ nem preço nem flag — nada de patch guardado', () => {
    const p = planoDeProdutoSemFilhos(anuncio([brl(49.9), brl(49.9)]), {
      options: opcoes({ sobrescreverPreco: false }),
    });
    expect(p.precosPai).toBeNull();
    expect(p.propagaPrecoPai).toBeNull();
    expect(p.precoPaiIgnorado).toBe('opcao-desligada');
  });

  it('⛔ PRODUTO SEM FILHOS com só `importarPreco` desligado ⇒ nem preço nem flag, `pai-com-filhos` — o plano de antes da regra (V-1)', () => {
    const p = planoDeProdutoSemFilhos(anuncio([brl(49.9), brl(59.9)]), {
      options: opcoes({ importarPreco: false }),
    });
    expect(p.precosPai).toBeNull();
    expect(p.propagaPrecoPai).toBeNull();
    expect(p.precoPaiIgnorado).toBe('pai-com-filhos');
    // Os filhos NASCEM sem preço — é por isso que a regra não vale aqui.
    expect(p.filhos.map((f) => f.produto?.data.precos)).toEqual([null, null]);
  });

  it('PRODUTO SEM FILHOS sem preço nenhum (SGD) ⇒ nem preço nem flag', () => {
    const p = planoDeProdutoSemFilhos(anuncio([SGD, SGD]));
    expect(p.precosPai).toBeNull();
    expect(p.propagaPrecoPai).toBeNull();
  });

  it('⛔ o braço da corrida só deixa de fora preço e flag num anúncio COM models criado — nunca numa atualização', () => {
    expect(plano(anuncio([brl(49.9), brl(49.9)])).camposForaDaCorrida).toEqual([
      'precos',
      'propagatePriceToChildren',
    ]);
    expect(planoDeAtualizacao(anuncio([brl(49.9), brl(49.9)])).camposForaDaCorrida).toEqual([]);
    expect(planoDeProdutoSemFilhos(anuncio([brl(49.9), brl(49.9)])).camposForaDaCorrida).toEqual(
      [],
    );
  });

  it('o patch do braço da corrida (V-2) é a regra do produto SEM filhos: iguais ⇒ preço + `true`; diferentes ⇒ só `false`', () => {
    expect(plano(anuncio([brl(49.9), brl(49.9)])).precosPaiNaCorrida).toEqual({
      produtoId: idDoPaiPlanejado(INTEGRACAO, ITEM_ID),
      patch: { [`precos.${TABELA_NORMAL_ID}`]: { valor: 49.9 }, propagatePriceToChildren: true },
    });
    expect(plano(anuncio([brl(49.9), brl(59.9)])).precosPaiNaCorrida).toEqual({
      produtoId: idDoPaiPlanejado(INTEGRACAO, ITEM_ID),
      patch: { propagatePriceToChildren: false },
    });
  });

  it.each<[string, Partial<PreparoImportacaoShopee>, (ShopeePriceInfo[] | null)[]]>([
    ['só `importarPreco` desligado', { options: opcoes({ importarPreco: false }) }, [brl(49.9)]],
    [
      'só `sobrescreverPreco` desligado',
      { options: opcoes({ sobrescreverPreco: false }) },
      [brl(49.9)],
    ],
    ['todos os models em SGD', {}, [SGD, SGD]],
    ['sem tabela normal', { tabelaNormalOuterRef: null }, [brl(49.9)]],
  ])(
    '⛔ o patch do braço da corrida é `null` com %s — nada a escrever sobre o documento que já estava lá',
    (_r, parcial, precos) => {
      expect(plano(anuncio(precos), parcial).precosPaiNaCorrida).toBeNull();
    },
  );

  it('o patch do braço da corrida é `null` fora da CRIAÇÃO de um anúncio COM models — atualização, produto sem filhos, anúncio sem models', () => {
    expect(planoDeAtualizacao(anuncio([brl(49.9), brl(49.9)])).precosPaiNaCorrida).toBeNull();
    expect(planoDeProdutoSemFilhos(anuncio([brl(49.9), brl(49.9)])).precosPaiNaCorrida).toBeNull();
    const semModels: ItemLido = {
      base: shopeeItemBaseInfoRowSchema.parse({
        item_id: ITEM_ID,
        item_name: 'Camiseta Básica',
        price_info: brl(49.9),
      }),
      models: null,
      taxInfo: null,
      kit: null,
      itemId: ITEM_ID,
    };
    expect(plano(semModels, { filhos: [] }).precosPaiNaCorrida).toBeNull();
    // `has_model` decides — never a stray `models` payload beside a no-model item.
    const comPayload: ItemLido = { ...semModels, models: anuncio([brl(49.9)]).models };
    expect(plano(comPayload, { filhos: [] }).precosPaiNaCorrida).toBeNull();
  });

  it('um anúncio SEM models cujo produto já tem filhos no ERP segue sem preço e sem flag — a regra é dos MODELS', () => {
    const semModels: ItemLido = {
      base: shopeeItemBaseInfoRowSchema.parse({
        item_id: ITEM_ID,
        item_name: 'Camiseta Básica',
        price_info: brl(49.9),
      }),
      models: null,
      taxInfo: null,
      kit: null,
      itemId: ITEM_ID,
    };
    const p = plano(semModels, {
      pai: { ...preparo(semModels).pai, existente: EXISTENTE, jaTemFilhos: true },
      filhos: [],
    });
    expect(p.precosPai).toBeNull();
    expect(p.propagaPrecoPai).toBeNull();
    expect(p.precoPaiIgnorado).toBe('pai-com-filhos');
  });

  it('o ensaio (`importar:anuncio`) diz a decisão: sim, não, ou não seria escrito — e a atualização de uma família nunca a escreve', () => {
    const texto = (p: PlanoImportacaoShopee, entrada: ItemLido): string =>
      renderResumoImportacao(resumoDoPlano(p, entrada)).join('\n');
    const iguais = anuncio([brl(49.9), brl(49.9)]);
    const diferentes = anuncio([brl(49.9), brl(59.9)]);
    const sgd = anuncio([SGD, SGD]);
    expect(resumoDoPlano(plano(iguais), iguais).propagaPreco).toBe(true);
    expect(texto(plano(iguais), iguais)).toContain('propagar preço .......... sim');
    expect(texto(plano(diferentes), diferentes)).toContain('propagar preço .......... não');
    expect(texto(plano(sgd), sgd)).toContain('propagar preço .......... — (não seria escrito)');
    expect(resumoDoPlano(planoDeAtualizacao(iguais), iguais).propagaPreco).toBeNull();
    expect(texto(planoDeAtualizacao(iguais), iguais)).toContain(
      'propagar preço .......... — (não seria escrito)',
    );
    // Um produto SEM filhos vira família: o ensaio diz o que o patch guardado grava.
    expect(texto(planoDeProdutoSemFilhos(iguais), iguais)).toContain(
      'propagar preço .......... sim',
    );
    expect(texto(planoDeProdutoSemFilhos(diferentes), diferentes)).toContain(
      'propagar preço .......... não',
    );
  });
});

/* ---- 3. a REIMPORTAÇÃO de uma FAMÍLIA deixa o pai como estava ------------- */

describe('⛔ a reimportação não toca o preço nem a flag de um pai que JÁ TEM filhos — é do operador', () => {
  it.each([
    [
      'desligada pelo operador, preço velho, models IGUAIS (a regra o ligaria)',
      { precos: { [TABELA_NORMAL_ID]: { valor: 5 } }, propagatePriceToChildren: false },
      [brl(49.9), brl(49.9)],
    ],
    [
      'ausente (lida como LIGADA), preço velho, models DIFERENTES (a regra a desligaria)',
      { precos: { [TABELA_NORMAL_ID]: { valor: 5 } } },
      [brl(49.9), brl(59.9)],
    ],
    [
      'ligada, preço em DUAS tabelas, models DIFERENTES',
      {
        precos: { [TABELA_NORMAL_ID]: { valor: 5 }, 'tab-atacado': { valor: 4 } },
        propagatePriceToChildren: true,
      },
      [brl(49.9), brl(59.9)],
    ],
    [
      'ligada, pai SEM preço, models IGUAIS (a regra lhe daria um)',
      { precos: null, propagatePriceToChildren: true },
      [brl(49.9), brl(49.9)],
    ],
  ])(
    'flag %s ⇒ o documento do pai sai com o MESMO preço e a MESMA flag',
    async (_r, campos, precos) => {
      const db = new FakeDb();
      semearPaiExistente(db, campos);
      semearVariacaoDoErp(db);

      await importarAnuncioShopee(deps(db), anuncio(precos));

      const pai = docDoProduto(db, PAI_EXISTENTE);
      expect(pai.precos).toEqual(campos.precos);
      expect('propagatePriceToChildren' in pai).toBe('propagatePriceToChildren' in campos);
      expect(pai.propagatePriceToChildren).toBe(
        (campos as { propagatePriceToChildren?: boolean }).propagatePriceToChildren,
      );
      // Nenhuma escrita no pai nomeia preço ou flag — nem o patch guardado existe.
      expect(escritasDePrecoNoPai(db, PAI_EXISTENTE)).toEqual([]);
      expect(db.patches.filter((w) => w.path === `produtos/${PAI_EXISTENTE}`)).toEqual([]);
      // Os filhos (novos aqui) levam o SEU preço, como antes da regra.
      expect(docDoProduto(db, idDoFilhoPlanejado(PAI_EXISTENTE, MODEL_B)).precos).toEqual({
        [TABELA_NORMAL_ID]: { valor: precos[1]![0]!.original_price },
      });
    },
  );
});

/* --- 3b. um produto SEM filhos vira família: a regra vale, no patch guardado --- */

describe('um produto existente SEM filhos que o anúncio transforma em família — a regra vale, pelo patch GUARDADO', () => {
  /** A tabela normal a 30 e uma OUTRA tabela, que o patch pontilhado nunca toca. */
  const PRECOS_ANTIGOS = {
    [TABELA_NORMAL_ID]: { valor: 30 },
    'tab-atacado': { valor: 25 },
  };

  it('preços IGUAIS ⇒ o pai leva o preço (só a tabela normal) E a propagação LIGADA, num único patch guardado', async () => {
    const db = new FakeDb();
    semearProdutoSemFilhos(db, { precos: PRECOS_ANTIGOS });

    const r = await importarAnuncioShopee(deps(db), anuncio([brl(49.9), brl(49.9)]));

    expect(r.criado).toBe(false);
    const pai = docDoProduto(db, SIMPLES);
    expect(pai.precos).toEqual({
      [TABELA_NORMAL_ID]: { valor: 49.9 },
      'tab-atacado': { valor: 25 },
    });
    expect(pai.propagatePriceToChildren).toBe(true);
    // Preço e flag chegam JUNTOS, pelo `update` guardado — nenhuma outra escrita
    // no pai nomeia um dos dois (o merge simples não leva nenhum).
    expect(escritasDePrecoNoPai(db, SIMPLES)).toEqual([
      {
        path: `produtos/${SIMPLES}`,
        patch: {
          [`precos.${TABELA_NORMAL_ID}`]: { valor: 49.9 },
          propagatePriceToChildren: true,
        },
      },
    ]);
    expect(db.patches.filter((w) => w.path === `produtos/${SIMPLES}`)).toHaveLength(1);
  });

  it('preços DIFERENTES ⇒ propagação DESLIGADA e o preço antigo MANTIDO (nada apaga uma chave)', async () => {
    const db = new FakeDb();
    semearProdutoSemFilhos(db, { precos: PRECOS_ANTIGOS });

    await importarAnuncioShopee(deps(db), anuncio([brl(49.9), brl(59.9)]));

    const pai = docDoProduto(db, SIMPLES);
    expect(pai.precos).toEqual(PRECOS_ANTIGOS);
    expect(pai.propagatePriceToChildren).toBe(false);
    // Só a flag, e pela MESMA guarda.
    expect(db.patches.filter((w) => w.path === `produtos/${SIMPLES}`)).toEqual([
      { path: `produtos/${SIMPLES}`, patch: { propagatePriceToChildren: false } },
    ]);
    expect(escritasDePrecoNoPai(db, SIMPLES)).toHaveLength(1);
  });

  it('`sobrescreverPreco` desligado ⇒ nada muda no pai: nem preço, nem flag', async () => {
    const db = new FakeDb();
    semearProdutoSemFilhos(db, { precos: PRECOS_ANTIGOS });

    await importarAnuncioShopee(
      deps(db, { options: opcoes({ sobrescreverPreco: false }) }),
      anuncio([brl(49.9), brl(49.9)]),
    );

    const pai = docDoProduto(db, SIMPLES);
    expect(pai.precos).toEqual(PRECOS_ANTIGOS);
    expect(pai).not.toHaveProperty('propagatePriceToChildren');
    expect(escritasDePrecoNoPai(db, SIMPLES)).toEqual([]);
  });

  it.each<[string, Partial<ImportacaoShopeeOptions>, (number | null)[]]>([
    [
      '`importarPreco` desligado (os filhos NASCEM sem preço)',
      { importarPreco: false, sobrescreverPreco: true },
      [null, null],
    ],
    [
      '`sobrescreverPreco` desligado (o pai não é sobrescrito)',
      { importarPreco: true, sobrescreverPreco: false },
      [49.9, 59.9],
    ],
  ])(
    '⛔ V-1 — preços DIFERENTES com %s ⇒ nada novo no pai: sem flag, ele segue PROPAGANDO os seus 30, e a volta é a de antes da regra — 30 / 30, nenhum `filho-sem-preco`',
    async (_r, opcoesDePreco, precosDosFilhos) => {
      const db = new FakeDbDaVolta();
      semearProdutoSemFilhos(db, { precos: { [TABELA_NORMAL_ID]: { valor: 30 } } });
      const entrada = anuncio([brl(49.9), brl(59.9)]);

      const r = await importarAnuncioShopee(deps(db, { options: opcoes(opcoesDePreco) }), entrada);

      expect(r.criado).toBe(false);
      const pai = docDoProduto(db, SIMPLES);
      expect(pai).not.toHaveProperty('propagatePriceToChildren');
      expect(pai.precos).toEqual({ [TABELA_NORMAL_ID]: { valor: 30 } });
      expect(escritasDePrecoNoPai(db, SIMPLES)).toEqual([]);
      // Os filhos, como as opções os deixam — nunca o preço do pai.
      expect(
        [MODEL_A, MODEL_B].map((m) => docDoProduto(db, idDoFilhoPlanejado(SIMPLES, m)).precos),
      ).toEqual(
        precosDosFilhos.map((v) => (v === null ? null : { [TABELA_NORMAL_ID]: { valor: v } })),
      );
      // O que `a1dd294f` dava (medido pela lente V): o pai propaga os 30 a todo model.
      expect([...(await sincronizar(db, SIMPLES)).values()]).toEqual([30, 30]);
      const publicacao = await publicar(db, SIMPLES, [MODEL_A, MODEL_B]);
      expect([...publicacao.precos.values()]).toEqual([30, 30]);
      expect(publicacao.semPreco).toEqual([]);
    },
  );

  it.each([
    ['iguais (preço + flag)', [brl(49.9), brl(49.9)]],
    ['diferentes (só a flag)', [brl(49.9), brl(59.9)]],
  ])(
    '⛔ um `updateTime` VENCIDO ⇒ o patch guardado falha e NEM preço NEM flag pousam — preços %s',
    async (_r, precos) => {
      const db = new FakeDb();
      semearProdutoSemFilhos(db, { precos: PRECOS_ANTIGOS });
      const p = planoDeProdutoSemFilhos(anuncio(precos));
      expect(p.precosPai?.patch).toHaveProperty('propagatePriceToChildren');

      // Um gravador concorrente (o operador salvando o produto) entre a leitura
      // e o patch: o carimbo lido já não vale.
      const snap = await produtoCollection.docRef(asDb(db), {}, SIMPLES).get();
      await produtoCollection.merge(asDb(db), {}, SIMPLES, { ultimaModificacao: AGORA });

      await expect(
        aplicarPrecosShopee(asDb(db), { ...p.precosPai!, lastUpdateTime: snap.updateTime }),
      ).rejects.toThrow(ShopeePrecoDesatualizadoError);
      const pai = docDoProduto(db, SIMPLES);
      expect(pai.precos).toEqual(PRECOS_ANTIGOS);
      expect(pai).not.toHaveProperty('propagatePriceToChildren');
    },
  );

  it('⛔ um gravador CONCORRENTE entre a leitura e o patch ⇒ a guarda do importador PERDE, ele REPLANEJA contra o documento novo, e preço e flag pousam uma vez só', async () => {
    const db = new FakeDb();
    semearProdutoSemFilhos(db, { precos: PRECOS_ANTIGOS });
    const caminho = `produtos/${SIMPLES}`;
    const original = db.falhasDeUpdate.get.bind(db.falhasDeUpdate);
    let concorrentes = 1;
    vi.spyOn(db.falhasDeUpdate, 'get').mockImplementation((chave: string) => {
      if (chave === caminho && concorrentes > 0) {
        concorrentes -= 1;
        // O operador salva o produto: o `updateTime` que o importador leu vence.
        db.seed(caminho, { ...docDoProduto(db, SIMPLES), ultimaModificacao: AGORA + 1 });
      }
      return original(chave);
    });

    await importarAnuncioShopee(deps(db), anuncio([brl(49.9), brl(49.9)]));

    // Um PREPARO a mais que o mesmo import sem concorrente: o carimbo afirmado é
    // o da leitura do preparo, então a perda replaneja do zero (uma cascata de
    // pai a mais). Sem a guarda o patch teria pousado sobre o operador e não
    // haveria replanejamento.
    const cascatasDePai = (banco: FakeDb) =>
      banco.consultas.filter((c) => c.fonte === 'group:prodshopee').length;
    const limpo = new FakeDb();
    semearProdutoSemFilhos(limpo, { precos: PRECOS_ANTIGOS });
    await importarAnuncioShopee(deps(limpo), anuncio([brl(49.9), brl(49.9)]));
    expect(cascatasDePai(db)).toBe(cascatasDePai(limpo) + 1);
    expect(db.patches.filter((w) => w.path === caminho)).toEqual([
      {
        path: caminho,
        patch: {
          [`precos.${TABELA_NORMAL_ID}`]: { valor: 49.9 },
          propagatePriceToChildren: true,
        },
      },
    ]);
    expect(docDoProduto(db, SIMPLES).propagatePriceToChildren).toBe(true);
  });

  it('⛔ o importador que perde a guarda duas vezes LANÇA e não deixa preço nem flag no pai', async () => {
    const db = new FakeDb();
    semearProdutoSemFilhos(db, { precos: PRECOS_ANTIGOS });
    db.falhasDeUpdate.set(`produtos/${SIMPLES}`, grpc(9, 'FAILED_PRECONDITION'));

    await expect(importarAnuncioShopee(deps(db), anuncio([brl(49.9), brl(49.9)]))).rejects.toThrow(
      ShopeePrecoDesatualizadoError,
    );

    const pai = docDoProduto(db, SIMPLES);
    expect(pai.precos).toEqual(PRECOS_ANTIGOS);
    expect(pai).not.toHaveProperty('propagatePriceToChildren');
    expect(escritasDePrecoNoPai(db, SIMPLES)).toEqual([]);
  });
});

/* ---- 3c. o braço da CORRIDA da criação ------------------------------------- */

describe('⛔ o braço ALREADY_EXISTS da criação: o merge nunca leva preço nem flag, e o documento SEM filhos é decidido como um produto sem filhos', () => {
  /**
   * Um pai que uma tentativa ANTERIOR criou no id determinístico e nunca
   * vinculou (o `prodshopee` não pousou), com o SKU editado pelo operador — os
   * degraus 1 e 2 não o acham, o plano CRIA, o `.create()` cai no ALREADY_EXISTS.
   * O vínculo é escrito antes de qualquer filho, então esse documento nasce SEM
   * filhos — a menos que alguém tenha pendurado um desde então.
   */
  function semearPaiNaoVinculado(db: FakeDb, campos: Record<string, unknown>): string {
    const paiId = idDoPaiPlanejado(INTEGRACAO, ITEM_ID);
    db.seed(`produtos/${paiId}`, { nome: 'Camiseta', sku: 'SKU-EDITADO', paiId: null, ...campos });
    return paiId;
  }

  const DO_OPERADOR = {
    precos: { [TABELA_NORMAL_ID]: { valor: 5 }, 'tab-atacado': { valor: 4 } },
    propagatePriceToChildren: false,
  };

  it.each([
    ['IGUAIS (a regra LIGARIA a flag e poria 49.9)', DO_OPERADOR, [brl(49.9), brl(49.9)]],
    [
      'DIFERENTES (a regra DESLIGARIA a flag)',
      { ...DO_OPERADOR, propagatePriceToChildren: true },
      [brl(49.9), brl(59.9)],
    ],
  ])(
    'COM um filho no ERP, models %s ⇒ o preço e a flag do pai ficam INTACTOS — é uma família, e ela é do operador',
    async (_r, campos, precos) => {
      const db = new FakeDb();
      const paiId = semearPaiNaoVinculado(db, campos);
      semearVariacaoDoErp(db, paiId);

      const r = await importarAnuncioShopee(deps(db), anuncio(precos));

      expect(r.criado).toBe(false);
      const pai = docDoProduto(db, paiId);
      expect(pai.precos).toEqual(campos.precos);
      expect(pai.propagatePriceToChildren).toBe(campos.propagatePriceToChildren);
      expect(escritasDePrecoNoPai(db, paiId)).toEqual([]);
      // O resto do documento de criação CHEGOU (o merge aconteceu) — só as duas
      // chaves da regra ficaram de fora.
      expect(pai.sku).toBe('CAM-001');
      // E cada filho criado leva o SEU preço, como sempre.
      expect(docDoProduto(db, idDoFilhoPlanejado(paiId, MODEL_B)).precos).toEqual({
        [TABELA_NORMAL_ID]: { valor: precos[1]![0]!.original_price },
      });
    },
  );

  it('SEM filho no ERP, models IGUAIS ⇒ o pai leva o preço (só a tabela normal) E a propagação LIGADA, num único patch GUARDADO ANTES do merge', async () => {
    const db = new FakeDb();
    const paiId = semearPaiNaoVinculado(db, DO_OPERADOR);

    const r = await importarAnuncioShopee(deps(db), anuncio([brl(49.9), brl(49.9)]));

    expect(r.criado).toBe(false);
    const pai = docDoProduto(db, paiId);
    expect(pai.precos).toEqual({
      [TABELA_NORMAL_ID]: { valor: 49.9 },
      'tab-atacado': { valor: 4 },
    });
    expect(pai.propagatePriceToChildren).toBe(true);
    expect(pai.sku).toBe('CAM-001');
    // ⛔ O patch vem ANTES do merge da corrida: guardado pela leitura que o braço
    // fez do documento, que o próprio merge invalidaria se viesse primeiro.
    const escritasNoPai = db.writes.filter((w) => w.path === `produtos/${paiId}`);
    const iPatch = escritasNoPai.findIndex((w) => `precos.${TABELA_NORMAL_ID}` in w.patch);
    const iMerge = escritasNoPai.findIndex((w) => 'sku' in w.patch);
    expect(iPatch).toBeGreaterThanOrEqual(0);
    expect(iMerge).toBeGreaterThan(iPatch);
    // O merge da corrida não levou nenhum dos dois; o patch guardado levou ambos.
    expect(escritasDePrecoNoPai(db, paiId)).toEqual([
      {
        path: `produtos/${paiId}`,
        patch: {
          [`precos.${TABELA_NORMAL_ID}`]: { valor: 49.9 },
          propagatePriceToChildren: true,
        },
      },
    ]);
    // E a pergunta "tem filho?" é UMA consulta `paiId ==`, limitada a 1.
    expect(
      db.consultasCompletas.filter(
        (c) =>
          c.limite === 1 &&
          c.clausulas.some(
            ([campo, op, valor]) => campo === 'paiId' && op === '==' && valor === paiId,
          ),
      ),
    ).toHaveLength(1);
  });

  it('⛔ V-2 — SEM filho no ERP, o documento de uma tentativa anterior (49.9, propagando) e os models agora 49.9 / 59.9 ⇒ propagação DESLIGADA, o 49.9 MANTIDO, e a sincronização E a publicação dão a cada model o SEU preço', async () => {
    const db = new FakeDbDaVolta();
    const paiId = semearPaiNaoVinculado(db, {
      precos: { [TABELA_NORMAL_ID]: { valor: 49.9 } },
      propagatePriceToChildren: true,
    });
    const entrada = anuncio([brl(49.9), brl(59.9)]);

    const r = await importarAnuncioShopee(deps(db), entrada);

    expect(r.criado).toBe(false);
    const pai = docDoProduto(db, paiId);
    expect(pai.propagatePriceToChildren).toBe(false);
    expect(pai.precos).toEqual({ [TABELA_NORMAL_ID]: { valor: 49.9 } });
    // Só a flag, e pela MESMA guarda.
    expect(db.patches.filter((w) => w.path === `produtos/${paiId}`)).toEqual([
      { path: `produtos/${paiId}`, patch: { propagatePriceToChildren: false } },
    ]);
    // Sem a regra no braço da corrida, o pai seguia propagando 49.9 e o model
    // de 59.9 descia para 49.9 na primeira sincronização (e na publicação).
    esperarVoltaSemMudanca(await sincronizar(db, paiId), entrada);
    const modelIds = modelosDe(entrada).map((m) => m.model_id);
    const publicacao = await publicar(db, paiId, modelIds);
    esperarVoltaSemMudanca(publicacao.precos, entrada);
    expect(publicacao.semPreco).toEqual([]);
  });

  it.each<[string, Partial<ImportarAnuncioDeps>, (ShopeePriceInfo[] | null)[]]>([
    [
      'só `importarPreco` desligado',
      { options: opcoes({ importarPreco: false }) },
      [brl(49.9), brl(49.9)],
    ],
    [
      'só `sobrescreverPreco` desligado',
      { options: opcoes({ sobrescreverPreco: false }) },
      [brl(49.9), brl(49.9)],
    ],
    ['todos os models em SGD', {}, [SGD, SGD]],
    ['sem tabela normal na conta', { tabelaNormalOuterRef: null }, [brl(49.9), brl(49.9)]],
  ])(
    '⛔ SEM filho no ERP, %s ⇒ o preço do documento (as DUAS tabelas) e a flag ficam INTACTOS — e o resto do documento de criação chega',
    async (_r, parcial, precos) => {
      const db = new FakeDb();
      const paiId = semearPaiNaoVinculado(db, DO_OPERADOR);

      const r = await importarAnuncioShopee(deps(db, parcial), anuncio(precos));

      expect(r.criado).toBe(false);
      const pai = docDoProduto(db, paiId);
      expect(pai.precos).toEqual(DO_OPERADOR.precos);
      expect(pai.propagatePriceToChildren).toBe(false);
      expect(escritasDePrecoNoPai(db, paiId)).toEqual([]);
      expect(pai.sku).toBe('CAM-001');
    },
  );

  it('⛔ o patch da corrida é GUARDADO: um gravador CONCORRENTE entre a leitura do braço e o patch ⇒ ele PERDE, o importador REPLANEJA, e preço e flag pousam uma vez só', async () => {
    const db = new FakeDb();
    const paiId = semearPaiNaoVinculado(db, DO_OPERADOR);
    const caminho = `produtos/${paiId}`;
    const original = db.falhasDeUpdate.get.bind(db.falhasDeUpdate);
    let concorrentes = 1;
    vi.spyOn(db.falhasDeUpdate, 'get').mockImplementation((chave: string) => {
      if (chave === caminho && concorrentes > 0) {
        concorrentes -= 1;
        // O operador salva o produto: o `updateTime` lido pelo braço vence.
        db.seed(caminho, { ...docDoProduto(db, paiId), ultimaModificacao: AGORA + 1 });
      }
      return original(chave);
    });

    await importarAnuncioShopee(deps(db), anuncio([brl(49.9), brl(49.9)]));

    // Uma leitura do pai A MAIS que o mesmo import sem concorrente: a da
    // tentativa que perdeu. Sem a guarda o patch teria pousado sobre o operador
    // e não haveria replanejamento.
    const leiturasDoPai = (banco: FakeDb) =>
      banco.opLog.filter((o) => o.op === 'get' && o.path === caminho).length;
    const limpo = new FakeDb();
    semearPaiNaoVinculado(limpo, DO_OPERADOR);
    await importarAnuncioShopee(deps(limpo), anuncio([brl(49.9), brl(49.9)]));
    expect(leiturasDoPai(db)).toBe(leiturasDoPai(limpo) + 1);
    expect(db.patches.filter((w) => w.path === caminho)).toEqual([
      {
        path: caminho,
        patch: {
          [`precos.${TABELA_NORMAL_ID}`]: { valor: 49.9 },
          propagatePriceToChildren: true,
        },
      },
    ]);
    expect(docDoProduto(db, paiId).propagatePriceToChildren).toBe(true);
  });

  it('o kit (o mesmo gravador): COM um filho no ERP o merge não leva preço nem flag; SEM filho o patch guardado da corrida pousa', async () => {
    for (const comFilho of [true, false]) {
      const db = new FakeDb();
      const paiId = semearPaiNaoVinculado(db, DO_OPERADOR);
      if (comFilho) semearVariacaoDoErp(db, paiId);
      db.seed('produtos/comp-a', { nome: 'Componente', sku: 'comp-a', paiId: null });
      db.seed(`produtos/comp-a/prodshopee/vinc-${String(COMPONENTE)}`, {
        item_id: COMPONENTE,
        contaProdutoShopeeOuterRef: REF_CONTA,
      });

      const r = await importarKitShopee(deps(db), {
        base: shopeeItemBaseInfoRowSchema.parse({ item_id: ITEM_ID, tag: { kit: true } }),
        models: null,
        taxInfo: null,
        kit: shopeeKitItemSchema.parse({
          item_id: ITEM_ID,
          item_name: 'Kit Camiseta + Boné',
          item_sku: 'KIT-001',
          category_id: 100017,
          model_list: [
            {
              model_id: MODEL_A,
              model_sku: 'KIT-001-0',
              original_price: 99.9,
              component_list: [
                { component_item_id: COMPONENTE, component_model_id: 0, quantity: 1 },
              ],
            },
          ],
        }),
        itemId: ITEM_ID,
      });

      expect(r.criado).toBe(false);
      const pai = docDoProduto(db, paiId);
      if (comFilho) {
        expect(pai.precos).toEqual(DO_OPERADOR.precos);
        expect(pai.propagatePriceToChildren).toBe(false);
        expect(escritasDePrecoNoPai(db, paiId)).toEqual([]);
      } else {
        expect(pai.precos).toEqual({ ...DO_OPERADOR.precos, [TABELA_NORMAL_ID]: { valor: 99.9 } });
        expect(pai.propagatePriceToChildren).toBe(true);
        expect(escritasDePrecoNoPai(db, paiId)).toEqual([
          {
            path: `produtos/${paiId}`,
            patch: {
              [`precos.${TABELA_NORMAL_ID}`]: { valor: 99.9 },
              propagatePriceToChildren: true,
            },
          },
        ]);
      }
    }
  });

  it('CONTROLE: um anúncio SEM models mescla o documento de criação inteiro, preço incluído — como antes', async () => {
    const db = new FakeDb();
    const paiId = semearPaiNaoVinculado(db, { precos: DO_OPERADOR.precos });
    const semModels: ItemLido = {
      base: shopeeItemBaseInfoRowSchema.parse({
        item_id: ITEM_ID,
        item_name: 'Camiseta Básica',
        item_sku: 'CAM-001',
        category_id: 100017,
        price_info: brl(49.9),
      }),
      models: null,
      taxInfo: null,
      kit: null,
      itemId: ITEM_ID,
    };

    const r = await importarAnuncioShopee(deps(db), semModels);

    expect(r.criado).toBe(false);
    const escritas = escritasDePrecoNoPai(db, paiId);
    expect(escritas).toHaveLength(1);
    expect(escritas[0]?.patch.precos).toEqual({ [TABELA_NORMAL_ID]: { valor: 49.9 } });
    expect(escritas[0]?.patch).not.toHaveProperty('propagatePriceToChildren');
    expect(
      (docDoProduto(db, paiId).precos as Record<string, unknown> | undefined)?.[TABELA_NORMAL_ID],
    ).toEqual({ valor: 49.9 });
  });
});

/* -------------------- 4. o kit passa pela MESMA regra --------------------- */

describe('o kit passa pela MESMA regra — uma função, nenhuma cópia, e também só na criação', () => {
  function kit(precos: readonly number[]): ShopeeKitItem {
    const ids = [MODEL_A, MODEL_B, MODEL_C];
    return shopeeKitItemSchema.parse({
      item_id: ITEM_ID,
      item_name: 'Kit Camiseta + Boné',
      item_sku: 'KIT-001',
      category_id: 100017,
      model_list: precos.map((original_price, i) => ({
        model_id: ids[i],
        model_sku: `KIT-001-${String(i)}`,
        original_price,
        component_list: [{ component_item_id: COMPONENTE, component_model_id: 0, quantity: 1 }],
      })),
    });
  }

  function importarKit(db: FakeDb, precos: readonly number[]) {
    db.seed('produtos/comp-a', { nome: 'Componente', sku: 'comp-a', paiId: null });
    db.seed(`produtos/comp-a/prodshopee/vinc-${String(COMPONENTE)}`, {
      item_id: COMPONENTE,
      contaProdutoShopeeOuterRef: REF_CONTA,
    });
    return importarKitShopee(deps(db), {
      base: shopeeItemBaseInfoRowSchema.parse({ item_id: ITEM_ID, tag: { kit: true } }),
      models: null,
      taxInfo: null,
      kit: kit(precos),
      itemId: ITEM_ID,
    });
  }

  it('kit de dois models com preços DIFERENTES ⇒ pai sem preço e propagação DESLIGADA', async () => {
    const db = new FakeDb();
    await importarKit(db, [99.9, 79.9]);
    const paiId = idDoPaiPlanejado(INTEGRACAO, ITEM_ID);

    expect(docDoProduto(db, paiId).precos).toBeNull();
    expect(docDoProduto(db, paiId).propagatePriceToChildren).toBe(false);
    expect(docDoProduto(db, idDoFilhoPlanejado(paiId, MODEL_B)).precos).toEqual({
      [TABELA_NORMAL_ID]: { valor: 79.9 },
    });
  });

  it('kit que encontra um produto SEM filhos (pelo SKU) ⇒ a regra vale, pelo patch GUARDADO — e um que já é FAMÍLIA não ganha nada', async () => {
    for (const comFilho of [false, true]) {
      const db = new FakeDb();
      db.seed('produtos/kit-erp', {
        nome: 'Kit',
        sku: 'KIT-001',
        paiId: null,
        precos: { [TABELA_NORMAL_ID]: { valor: 30 } },
      });
      if (comFilho) semearVariacaoDoErp(db, 'kit-erp');

      const r = await importarKit(db, [99.9, 99.9]);

      expect(r.criado).toBe(false);
      const pai = docDoProduto(db, 'kit-erp');
      if (comFilho) {
        expect(pai.precos).toEqual({ [TABELA_NORMAL_ID]: { valor: 30 } });
        expect(pai).not.toHaveProperty('propagatePriceToChildren');
        expect(escritasDePrecoNoPai(db, 'kit-erp')).toEqual([]);
      } else {
        expect(pai.precos).toEqual({ [TABELA_NORMAL_ID]: { valor: 99.9 } });
        expect(pai.propagatePriceToChildren).toBe(true);
        expect(db.patches.filter((w) => w.path === 'produtos/kit-erp')).toEqual([
          {
            path: 'produtos/kit-erp',
            patch: {
              [`precos.${TABELA_NORMAL_ID}`]: { valor: 99.9 },
              propagatePriceToChildren: true,
            },
          },
        ]);
      }
    }
  });

  it('kit de dois models com o MESMO preço ⇒ pai com o preço e a propagação LIGADA', async () => {
    const db = new FakeDb();
    await importarKit(db, [99.9, 99.9]);
    const paiId = idDoPaiPlanejado(INTEGRACAO, ITEM_ID);

    expect(docDoProduto(db, paiId).precos).toEqual({ [TABELA_NORMAL_ID]: { valor: 99.9 } });
    expect(docDoProduto(db, paiId).propagatePriceToChildren).toBe(true);
  });

  it('⛔ REIMPORTAÇÃO do kit, iguais → diferentes ⇒ o pai fica com o preço e a propagação da CRIAÇÃO; o filho leva o seu', async () => {
    const db = new FakeDb();
    const paiId = idDoPaiPlanejado(INTEGRACAO, ITEM_ID);
    const primeira = await importarKit(db, [99.9, 99.9]);
    expect(primeira.criado).toBe(true);
    const antes = db.writes.length;

    const segunda = await importarKit(db, [99.9, 79.9]);

    expect(segunda.criado).toBe(false);
    expect(docDoProduto(db, paiId).precos).toEqual({ [TABELA_NORMAL_ID]: { valor: 99.9 } });
    expect(docDoProduto(db, paiId).propagatePriceToChildren).toBe(true);
    expect(escritasDePrecoNoPai(db, paiId, antes)).toEqual([]);
    // O filho existente leva o preço novo (`sobrescreverPreco`), como antes da regra.
    expect(docDoProduto(db, idDoFilhoPlanejado(paiId, MODEL_B)).precos).toEqual({
      [TABELA_NORMAL_ID]: { valor: 79.9 },
    });
  });

  it('⛔ REIMPORTAÇÃO do kit, diferentes → iguais ⇒ o pai continua sem preço e com a propagação DESLIGADA', async () => {
    const db = new FakeDb();
    const paiId = idDoPaiPlanejado(INTEGRACAO, ITEM_ID);
    await importarKit(db, [99.9, 79.9]);
    const antes = db.writes.length;

    const segunda = await importarKit(db, [99.9, 99.9]);

    expect(segunda.criado).toBe(false);
    expect(docDoProduto(db, paiId).precos).toBeNull();
    expect(docDoProduto(db, paiId).propagatePriceToChildren).toBe(false);
    expect(escritasDePrecoNoPai(db, paiId, antes)).toEqual([]);
  });
});

/* --------- 5. a volta completa: importar, e logo sincronizar ------------- */

type DocData = Record<string, unknown>;

function projetar(dados: DocData | undefined, campos: readonly string[] | null): DocData {
  if (dados === undefined) return {};
  if (campos === null) return dados;
  const saida: DocData = {};
  for (const campo of campos) if (Object.hasOwn(dados, campo)) saida[campo] = dados[campo];
  return saida;
}

/**
 * O double compartilhado mais as DUAS leituras do Admin SDK que a descoberta de
 * preços do passo 13 usa e ele não modela — `Query.select(...)` (uma projeção de
 * verdade) e `Firestore.getAll(...refs, { fieldMask })`. Estendido AQUI, nunca
 * em `testing/fakeDb.ts`: o import e a sincronização rodam no MESMO banco.
 */
class FakeDbDaVolta extends FakeDb {
  /** Todo `getAll`, com a máscara — prova que a leitura pediu a flag. */
  readonly mascaras: (readonly string[] | null)[] = [];

  override collection(colPath: string) {
    // eslint-disable-next-line no-restricted-syntax -- a test double extending the shared double's own chain
    const consulta = super.collection(colPath);
    const buscar = consulta.get;
    let campos: string[] | null = null;
    return Object.assign(consulta, {
      select: (...lista: string[]) => {
        campos = lista;
        return consulta;
      },
      get: async () => {
        const resposta = await buscar();
        return {
          docs: resposta.docs.map((doc) => ({ ...doc, data: () => projetar(doc.data(), campos) })),
        };
      },
    });
  }

  getAll(...args: unknown[]) {
    const ultimo = args[args.length - 1];
    const opcoes =
      typeof ultimo === 'object' && ultimo !== null && 'fieldMask' in ultimo
        ? (ultimo as { fieldMask: string[] })
        : null;
    const refs = (opcoes === null ? args : args.slice(0, -1)) as {
      id: string;
      get: () => Promise<{ exists: boolean; data: () => DocData | undefined }>;
    }[];
    this.mascaras.push(opcoes?.fieldMask ?? null);
    return Promise.all(
      refs.map(async (ref) => {
        const snap = await ref.get();
        return {
          id: ref.id,
          exists: snap.exists,
          data: () => (snap.exists ? projetar(snap.data(), opcoes?.fieldMask ?? null) : undefined),
        };
      }),
    );
  }
}

/** O preço de prateleira que a Shopee mostra para o model — `null` quando não há. */
function prateleira(modelo: ShopeeModel): number | null {
  const entrada = modelo.price_info?.find((p) => p.currency === 'BRL');
  return entrada === undefined ? null : precoDePrateleiraDe(entrada);
}

/**
 * O passo 13 inteiro sobre o banco que o import acabou de escrever: a
 * descoberta da família, o plano do item, a leitura dos preços no envio e o
 * `precificarItem`. Devolve o `precoAlvo` de cada model, por `model_id`.
 */
async function sincronizar(db: FakeDbDaVolta, anchorId: string): Promise<Map<number, unknown>> {
  const familias = await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [anchorId] });
  const f = familias.get(anchorId);
  if (f === undefined) throw new Error('a descoberta não achou a família importada');
  const { itens, pulos } = montarItensDePreco(f, INTEGRACAO);
  expect(pulos).toEqual([]);
  expect(itens).toHaveLength(1);
  const item = itens[0]!;
  const precos = await lerPrecosDosProdutos(asDb(db), [
    item.produtoId,
    ...item.modelos.map((m) => m.produtoId),
  ]);
  const precificado = precificarItem(item, precos, TABELA_NORMAL_ID);
  return new Map(precificado.alvos.map((a) => [a.modelId, a.precoAlvo]));
}

/** O invariante: cada model sai com EXATAMENTE o seu preço de prateleira. */
function esperarVoltaSemMudanca(alvos: Map<number, unknown>, entrada: ItemLido): void {
  const modelos = modelosDe(entrada);
  // Não vazio: um item sem alvos satisfaria o invariante por vacuidade.
  expect(alvos.size).toBe(modelos.length);
  for (const modelo of modelos) {
    const p = prateleira(modelo);
    // ⚠️ Um `null` só onde a Shopee também não tem preço — um `null` em todo
    // model (o defeito que a regra corrige) NÃO passa por "não mudou nada".
    expect(alvos.get(modelo.model_id)).toBe(p === null ? null : roundReais(p));
  }
}

/** O índice de categorias da publicação: a folha do anúncio importado. */
const INDICE_PUBLICACAO = construirIndice([
  { category_id: 100017, parent_category_id: 0, has_children: false } as never,
]);

/** Um cliente que só responde as três leituras do `preparar` da publicação. */
function clienteDaPublicacao(): ShopeeClient {
  const respostas: Record<string, () => unknown> = {
    getItemLimit: () => ({
      response: {
        price_limit: { min_limit: 1, max_limit: 1000, min: null, max: null },
        stock_limit: { min_limit: 0, max_limit: 1_000_000, min: null, max: null },
      },
    }),
    getAttributeTree: () => ({ list: [] }),
    getChannelList: () => ({
      logistics_channel_list: [
        shopeeLogisticsChannelSchema.parse({
          logistics_channel_id: 90_003,
          enabled: true,
          fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
        }),
      ],
    }),
  };
  return new Proxy({} as Record<string, unknown>, {
    get(_alvo, prop) {
      if (typeof prop !== 'string') return undefined;
      const resposta = respostas[prop];
      if (resposta !== undefined) return () => Promise.resolve(resposta());
      return () => {
        throw new Error(`a publicação chamou a Shopee: ${prop}`);
      };
    },
  }) as unknown as ShopeeClient;
}

/** Fotos já resolvidas: a volta é sobre PREÇO, nunca sobre imagem. */
const RESOLVEDOR: ResolvedorDeImagensShopee = {
  resolver: (fotos) =>
    Promise.resolve({
      imageIds: ['img-1'],
      reutilizadas: 0,
      enviadas: 1,
      falhas: [],
      consideradas: fotos.length,
      descartadasPeloLimite: 0,
    }),
  resumo: () => ({
    consideradas: 1,
    reutilizadas: 0,
    enviadas: 1,
    falhas: 0,
    descartadasPeloLimite: 0,
  }),
};

/**
 * O passo 11 sobre o banco que o import acabou de escrever — `preparar` →
 * fotos → `planejar`, a sequência de `publicarAnuncioShopee` sem nenhuma
 * escrita. Devolve o preço de cada variação, por `model_id`, e os problemas.
 */
async function publicar(db: FakeDb, produtoId: string, modelIds: readonly number[]) {
  __resetAllReadCaches();
  const client = clienteDaPublicacao();
  const contexto = await prepararPublicacao(
    {
      db: asDb(db),
      client,
      integracaoId: INTEGRACAO,
      tabelaNormalOuterRef: TABELA_NORMAL,
      depositoOuterRef: DEPOSITO,
      operacaoOuterRef: null,
      nowMs: AGORA,
      taxonomia: { integracaoId: INTEGRACAO, client, variationsPath: SHOPEE_GET_VARIATIONS_PATH },
      categorias: { carregar: () => Promise.resolve(INDICE_PUBLICACAO) },
    },
    { produtoId, categoryId: 100017, statusPedido: SHOPEE_ITEM_STATUS_WRITABLE.normal },
    RESOLVEDOR,
  );
  if (contexto === null) throw new Error('a publicação não achou o produto importado');
  const plano = planejarPublicacao(contexto, await resolverFotosDaPublicacao(contexto));
  const precoPorFilho = new Map(contexto.filhos.map((f) => [f.produtoId, f.preco]));
  return {
    ehAtualizacao: plano.ehAtualizacao,
    precos: new Map(modelIds.map((m) => [m, precoPorFilho.get(idDoFilhoPlanejado(produtoId, m))])),
    semPreco: plano.problemas.filter(
      (pr) => pr.motivo === MOTIVO_PUBLICACAO_BLOQUEADA.filhoSemPreco,
    ),
  };
}

describe('a volta completa: importar e logo sincronizar (passo 13)', () => {
  it.each([
    ['todos iguais', [brl(49.9), brl(49.9), brl(49.9)]],
    ['diferentes', [brl(49.9), brl(59.9), brl(39.9)]],
    ['parcial — um model zerado', [brl(49.9), ZERADO, brl(49.9)]],
    ['PAR na dobra — `10` e `10.004`', [brl(10), brl(10.004)]],
    ['QUASE-IGUAL na dobra — `10.00` e `10.01`', [brl(10.0), brl(10.01)]],
    ['um model só', [brl(49.9)]],
  ])(
    'CRIAÇÃO, família %s ⇒ cada model no seu preço de prateleira, na sincronização E na publicação (a volta não muda preço NENHUM)',
    async (_r, precos) => {
      const db = new FakeDbDaVolta();
      const entrada = anuncio(precos);
      const paiId = idDoPaiPlanejado(INTEGRACAO, ITEM_ID);

      await importarAnuncioShopee(deps(db), entrada);
      const alvos = await sincronizar(db, paiId);

      esperarVoltaSemMudanca(alvos, entrada);
      // A leitura do envio pediu a flag — sem ela a regra não chegaria ao preço.
      expect(db.mascaras.at(-1)).toContain('propagatePriceToChildren');

      // A metade do passo 11 (V-5): a publicação lê o MESMO preço por model.
      const modelos = modelosDe(entrada);
      const publicacao = await publicar(
        db,
        paiId,
        modelos.map((m) => m.model_id),
      );
      expect(publicacao.ehAtualizacao).toBe(true);
      esperarVoltaSemMudanca(publicacao.precos, entrada);
      // `filho-sem-preco` só para o model que a própria Shopee deixa sem preço.
      expect(publicacao.semPreco).toHaveLength(
        modelos.filter((m) => prateleira(m) === null).length,
      );
    },
  );

  it('⛔ ATUALIZAÇÃO de uma FAMÍLIA — a volta NÃO é prometida: um pai que PROPAGA (flag ausente) continua precificando TODO model pelo seu mapa', async () => {
    const db = new FakeDbDaVolta();
    // Sem o campo: lê-se como PROPAGANDO — o default do schema.
    semearPaiExistente(db, { precos: { [TABELA_NORMAL_ID]: { valor: 10 } } });
    semearVariacaoDoErp(db);
    const entrada = anuncio([brl(49.9), brl(59.9)]);

    await importarAnuncioShopee(deps(db), entrada);
    const alvos = await sincronizar(db, PAI_EXISTENTE);

    // Decisão do Lucas: a reimportação de uma família não mexe na flag, então o
    // pai continua valendo para cada model — a primeira sincronização os leva a 10.
    expect([...alvos.values()]).toEqual([10, 10]);
    expect(docDoProduto(db, PAI_EXISTENTE)).not.toHaveProperty('propagatePriceToChildren');
    expect(docDoProduto(db, PAI_EXISTENTE).precos).toEqual({ [TABELA_NORMAL_ID]: { valor: 10 } });
    // Os filhos receberam o SEU preço (como antes da regra) — lido só se a
    // propagação for desligada.
    expect(docDoProduto(db, idDoFilhoPlanejado(PAI_EXISTENTE, MODEL_B)).precos).toEqual({
      [TABELA_NORMAL_ID]: { valor: 59.9 },
    });
  });

  it('ATUALIZAÇÃO de uma família com propagação DESLIGADA pelo operador ⇒ cada model pelo SEU preço, que a reimportação escreveu', async () => {
    const db = new FakeDbDaVolta();
    semearPaiExistente(db, {
      precos: { [TABELA_NORMAL_ID]: { valor: 5 } },
      propagatePriceToChildren: false,
    });
    semearVariacaoDoErp(db);
    const entrada = anuncio([brl(49.9), brl(59.9)]);

    await importarAnuncioShopee(deps(db), entrada);
    const alvos = await sincronizar(db, PAI_EXISTENTE);

    esperarVoltaSemMudanca(alvos, entrada);
    expect(docDoProduto(db, PAI_EXISTENTE).propagatePriceToChildren).toBe(false);
    expect(docDoProduto(db, PAI_EXISTENTE).precos).toEqual({ [TABELA_NORMAL_ID]: { valor: 5 } });
  });

  it.each([
    ['iguais', [brl(49.9), brl(49.9), brl(49.9)], true],
    ['diferentes', [brl(49.9), brl(59.9), brl(39.9)], false],
  ])(
    'PRODUTO SEM FILHOS (preço antigo 30, flag ausente), models %s ⇒ a sincronização E a publicação dão a cada model o seu preço de prateleira',
    async (_r, precos, flag) => {
      const db = new FakeDbDaVolta();
      // O caso do lens U: sem a regra, o pai seguia PROPAGANDO os 30 antigos.
      semearProdutoSemFilhos(db, { precos: { [TABELA_NORMAL_ID]: { valor: 30 } } });
      const entrada = anuncio(precos);

      const r = await importarAnuncioShopee(deps(db), entrada);
      expect(r.criado).toBe(false);
      expect(docDoProduto(db, SIMPLES).propagatePriceToChildren).toBe(flag);

      esperarVoltaSemMudanca(await sincronizar(db, SIMPLES), entrada);

      const modelIds = modelosDe(entrada).map((m) => m.model_id);
      const publicacao = await publicar(db, SIMPLES, modelIds);
      expect(publicacao.ehAtualizacao).toBe(true);
      esperarVoltaSemMudanca(publicacao.precos, entrada);
      expect(publicacao.semPreco).toEqual([]);
    },
  );
});

/* ------ 6. o job em massa entrega as opções do JOB aos importadores ------- */

describe('o job em massa entrega `job.options` — as de preço incluídas — ao importador que injeta', () => {
  it.each([
    ['`importarPreco` desligado, `sobrescreverPreco` ligado', false, true],
    ['`importarPreco` ligado, `sobrescreverPreco` desligado', true, false],
  ])(
    'o anúncio E o kit recebem exatamente as opções gravadas no job (M10c) — %s',
    async (_r, importarPreco, sobrescreverPreco) => {
      const db = new FakeDb();
      // As DUAS combinações complementares: um job que forçasse QUALQUER uma das
      // duas opções de preço a um valor fixo (ligada ou desligada, no anúncio ou
      // só no kit) cai numa das duas linhas.
      const opcoesDoJob = opcoes({ importarPreco, sobrescreverPreco });
      db.seed('importacoesShopee/job-1', {
        integracaoId: INTEGRACAO,
        status: 'running',
        nextOffset: null,
        fila: [ITEM_ID],
        filaKits: [KIT_ID],
        scanned: 0,
        imported: 0,
        created: 0,
        skipped: 0,
        kits: 0,
        failureCount: 0,
        failures: [],
        options: opcoesDoJob,
        startedAt: AGORA - 1000,
        updatedAt: AGORA - 1000,
        finishedAt: null,
        erro: null,
      });
      const resultado = (): ResultadoImportacaoShopee => ({
        produtoId: 'prod-1',
        criado: true,
        nome: 'Anúncio',
        variacoes: { total: 0, criadas: 0, semLink: 0 },
        fotos: { importadas: 0, ignoradas: 0, falhas: 0 },
      });
      const importarAnuncio = vi.fn(async (_d: ImportarAnuncioDeps, _e: ItemLido) => resultado());
      const importarKit = vi.fn(async (_d: ImportarAnuncioDeps, _e: ItemLido) => ({
        ...resultado(),
        kit: { componentes: 1, criado: true },
      }));
      const cliente = {
        getItemBaseInfo: vi.fn(
          async (p: { itemIds: number[] }) =>
            ({
              item_list: p.itemIds.map((id) => ({
                item_id: id,
                item_name: 'Anúncio',
                has_model: false,
              })),
            }) as unknown as ShopeeItemBaseInfo,
        ),
        getKitItemInfo: vi.fn(
          async (p: { itemId: number }) =>
            ({ product_info: { item_id: p.itemId } }) as unknown as ShopeeKitItemInfo,
        ),
      };
      const contexto: ContextoImportacaoShopee = {
        client: cliente as unknown as ShopeeClient,
        integracaoId: INTEGRACAO,
        tabelaNormalOuterRef: TABELA_NORMAL,
        tabelaPromocionalOuterRef: null,
        depositoOuterRef: DEPOSITO,
      };

      await processarImportacaoShopee(
        {
          db: asDb(db),
          resolverContexto: async () => contexto,
          importarAnuncio,
          importarKit,
          scheduler: { enqueue: vi.fn(async () => {}) },
          now: () => AGORA,
        },
        { jobId: 'job-1', integracaoId: INTEGRACAO },
        0,
      );

      expect(importarAnuncio).toHaveBeenCalledTimes(1);
      expect(importarKit).toHaveBeenCalledTimes(1);
      expect(importarAnuncio.mock.calls[0]?.[0].options).toEqual(opcoesDoJob);
      expect(importarKit.mock.calls[0]?.[0].options).toEqual(opcoesDoJob);
    },
  );
});
