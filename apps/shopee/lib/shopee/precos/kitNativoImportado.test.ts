/**
 * IDA E VOLTA — o `kitNativo` e as linhas `variashopee` que o IMPORT (passo 9)
 * grava são o que o plano de PREÇO (passo 13) lê, pela descoberta real.
 *
 * Os dois lados já têm testes próprios: o import prova que carimba o campo e
 * liga cada modelo do kit ao seu filho, o plano prova que um kit nativo COM
 * modelos é planejado (passo 19, L5: o preço vai por `update_kit_item`,
 * escolhido no G9 pela leitura fresca) e que um kit SEM vínculo de modelo é
 * `sem-modelos`. Nenhum dos dois prova a EMENDA — que o que um escreve chega ao
 * outro depois da projeção da descoberta. Foi exatamente essa emenda que faltou
 * uma vez: o schema e o plano mestre descreviam um carimbo que o import nunca
 * escrevia, e cada lado passava sozinho.
 *
 * O último bloco é a metade do PR 8 do RT6 (passo 19, L8): depois do
 * "converter em kit nativo" REAL, o anúncio comum SUBSTITUÍDO continua vivo e
 * vendendo, então o preço ainda tem de chegar a ele — por `update_price` — e ao
 * kit novo — por `update_kit_item`. A metade do PR 6 (estoque + reverificação)
 * mora em `kits/recriarKit.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_GET_KIT_ITEM_LIMIT_PATH,
  SHOPEE_GET_VARIATIONS_PATH,
  SHOPEE_LOGISTICS_FEE_TYPE,
  SHOPEE_SURFACE,
  shopeeCategoriaSchema,
  shopeeErrorFromEnvelope,
  shopeeItemBaseInfoPayloadSchema,
  shopeeItemBaseInfoRowSchema,
  shopeeItemListPayloadSchema,
  shopeeKitItemInfoPayloadSchema,
  shopeeKitItemSchema,
  shopeeLogisticsChannelSchema,
  shopeeModelListPayloadSchema,
  shopeeUpdatePriceSchema,
  type ShopeeAddKitItemRequest,
  type ShopeeCategoria,
  type ShopeeClient,
  type ShopeeItemViolationInfo,
  type ShopeeUpdateKitItemRequest,
} from '@delfrance/integrations-shopee';
import {
  ESTADO_ANUNCIO_SHOPEE,
  importacaoShopeeOptionsSchema,
  toOuterRef,
  varianteFakePath,
} from '@delfrance/schemas';
import { integracaoCollection } from '@delfrance/data/admin/collections';

import type { ResolvedorDeImagensShopee } from '../anuncios/fotosPublicacao';
import { reverificarAnuncioShopee } from '../anuncios/reverificarAnuncio';
import { idDoVinculoDeKit } from '../kits/idsKit';
import { publicarKitShopee } from '../kits/publicarKit';
import type { KitDeps } from '../kits/resultadoKit';
import { criarMemoDeCategorias } from '../produtos/categoriaShopee';
import { importarAnuncioShopee } from '../produtos/importarAnuncio';
import type { ImportarKitShopeeDeps, ItemLido } from '../produtos/itemLido';
import { importarKitShopee } from '../produtos/kitShopee';
import { idDoPaiPlanejado } from '../produtos/resolveProduto';
import { limparTaxonomiaShopee } from '../taxonomia/cache';
import { type DocData, FakeDb, asDb, increment } from '../testing/fakeDb';
import { lerFamiliasDePrecoPorIds } from './descobertaPreco';
import { enviarPrecoDoItem } from './enviarPreco';
import { MOTIVO_PRECO_SHOPEE } from './errosPreco';
import { criarLeitorDeBaseEmLote } from './leitorDeBase';
import { montarItensDePreco, precificarItem, precosDaFamilia } from './planoPreco';
import type { ContextoContaPreco } from './regiaoPreco';

/* ---------------------------------- fixtures ------------------------------ */

const ITEM_ID = 2500139861;
const COMPONENTE = 2500139862;
/**
 * O id de modelo OCULTO de um componente sem variação, como o
 * `get_kit_item_info` de fato o devolve (medido, sonda 1 do passo 19): diferente
 * de zero, nunca o `item_id`. O import o liga pela listagem porque o `has_model`
 * do componente é `false`.
 */
const MODELO_OCULTO_DO_COMPONENTE = 2000458829;
const MODEL_A = 2000458802;
const INTEGRACAO = 'int-1';
const REF_CONTA = `documents/integracao/${INTEGRACAO}`;
const AGORA = 1_757_000_000_000;
const PAI_ID = idDoPaiPlanejado(INTEGRACAO, ITEM_ID);

const ARVORE: ShopeeCategoria[] = [
  { category_id: 100001, parent_category_id: 0, display_category_name: 'Roupas' },
  { category_id: 100009, parent_category_id: 100001, display_category_name: 'Camisetas' },
  { category_id: 100017, parent_category_id: 100009, display_category_name: 'Manga Curta' },
].map((c) => shopeeCategoriaSchema.parse({ has_children: false, ...c }));

/** Só `get_category` responde: o import não chama a Shopee. */
function cliente(): ShopeeClient {
  return new Proxy({} as Record<string, unknown>, {
    get(_alvo, prop) {
      if (prop === 'getCategory') return () => Promise.resolve({ category_list: [...ARVORE] });
      return () => {
        throw new Error(`o import chamou a Shopee: ${String(prop)}`);
      };
    },
  }) as unknown as ShopeeClient;
}

beforeEach(() => {
  limparTaxonomiaShopee();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

function deps(db: FakeDb): ImportarKitShopeeDeps {
  return {
    db: asDb(db),
    increment,
    integracaoId: INTEGRACAO,
    tabelaNormalOuterRef: 'documents/listaDePrecos/tab-normal',
    tabelaPromocionalOuterRef: null,
    depositoOuterRef: 'documents/depositos/dep-1',
    options: importacaoShopeeOptionsSchema.parse({ importarFotos: false }),
    nowMs: AGORA,
    categorias: criarMemoDeCategorias(cliente(), INTEGRACAO),
  };
}

/** Um kit nativo de UM model, com o componente já vinculado no ERP. */
function entradaDeKit(): ItemLido {
  return {
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
          model_sku: 'KIT-001-A',
          original_price: 99.9,
          component_list: [
            {
              component_item_id: COMPONENTE,
              component_model_id: MODELO_OCULTO_DO_COMPONENTE,
              quantity: 1,
            },
          ],
        },
      ],
    }),
    temModelosDosComponentes: new Map([[COMPONENTE, false]]),
    itemId: ITEM_ID,
  };
}

/** Um anúncio COMUM, sem modelos, com preço em BRL. */
function entradaComum(): ItemLido {
  const base = shopeeItemBaseInfoRowSchema.parse({
    item_id: ITEM_ID,
    item_name: 'Camiseta Básica',
    item_sku: 'CAM-001',
    category_id: 100017,
    tag: { kit: false },
    price_info: [{ currency: 'BRL', original_price: 99.9, current_price: 49.9 }],
  });
  return { base, models: null, taxInfo: null, kit: null, itemId: ITEM_ID };
}

function semearComponente(db: FakeDb): void {
  db.seed('produtos/comp-a', { nome: 'Componente', sku: 'comp-a', paiId: null });
  db.seed(`produtos/comp-a/prodshopee/vinc-${String(COMPONENTE)}`, {
    item_id: COMPONENTE,
    contaProdutoShopeeOuterRef: REF_CONTA,
  });
}

/**
 * O double compartilhado mais os dois verbos que a descoberta usa e ele não
 * tem — `select` e `getAll` com `fieldMask` —, e os dois APLICAM a projeção.
 * Sem isso um campo que a descoberta deixa de projetar chegaria ao plano mesmo
 * assim, e a ida e volta provaria menos do que diz.
 */
class FakeDbComProjecao extends FakeDb {
  override collection(colPath: string) {
    // eslint-disable-next-line no-restricted-syntax -- a test double extending the shared double's own chain
    const consulta = super.collection(colPath);
    const buscar = consulta.get;
    let campos: readonly string[] | null = null;
    return Object.assign(consulta, {
      select: (...lista: string[]) => {
        campos = lista;
        return consulta;
      },
      get: async () => {
        const resposta = await buscar();
        return {
          docs: resposta.docs.map((doc) => ({
            ...doc,
            data: () => projetar(doc.data(), campos),
          })),
        };
      },
    });
  }

  getAll(...args: unknown[]) {
    const ultimo = args[args.length - 1];
    const mascara =
      typeof ultimo === 'object' && ultimo !== null && 'fieldMask' in ultimo
        ? (ultimo as { fieldMask: string[] }).fieldMask
        : null;
    const refs = (mascara === null ? args : args.slice(0, -1)) as {
      id: string;
      get: () => Promise<{ exists: boolean; data: () => DocData | undefined }>;
    }[];
    return Promise.all(
      refs.map(async (ref) => {
        const snap = await ref.get();
        return {
          id: ref.id,
          exists: snap.exists,
          data: () => (snap.exists ? projetar(snap.data(), mascara) : undefined),
        };
      }),
    );
  }
}

function projetar(dados: DocData | undefined, campos: readonly string[] | null): DocData {
  if (dados === undefined) return {};
  if (campos === null) return dados;
  const saida: DocData = {};
  for (const campo of campos) if (Object.hasOwn(dados, campo)) saida[campo] = dados[campo];
  return saida;
}

async function planoDoPai(db: FakeDb) {
  const familia = (await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [PAI_ID] })).get(PAI_ID);
  expect(familia).toBeDefined();
  return montarItensDePreco(familia!, INTEGRACAO);
}

/* ---------------------------------- os testes ----------------------------- */

async function familiaDoPai(db: FakeDb) {
  const familia = (await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [PAI_ID] })).get(PAI_ID);
  expect(familia).toBeDefined();
  return familia!;
}

describe('ida e volta — o kit NATIVO importado chega ao plano de preço', () => {
  it('um kit NATIVO importado é PLANEJADO (passo 19): UM item com o modelo do kit, ligado ao filho que o import gravou — nenhum pulo', async () => {
    const db = new FakeDbComProjecao();
    semearComponente(db);

    await importarKitShopee(deps(db), entradaDeKit());
    const familia = await familiaDoPai(db);
    const plano = montarItensDePreco(familia, INTEGRACAO);

    // A projeção da descoberta carrega o carimbo (o degrau 3 o lê)...
    expect(familia.links.map((l) => l.kitNativo)).toEqual([true]);
    // ...e o plano endereça o kit pelos MODELOS, como qualquer anúncio com modelos.
    expect(plano.pulos).toEqual([]);
    expect(plano.itens).toHaveLength(1);
    expect(plano.itens[0]).toMatchObject({ produtoId: PAI_ID, itemId: ITEM_ID });
    expect(plano.itens[0]?.modelos.map((m) => m.modelId)).toEqual([MODEL_A]);
    // O modelo é preçado pelo FILHO que o import ligou — nunca pela âncora no modelo 0.
    const [modelo] = plano.itens[0]?.modelos ?? [];
    expect(modelo?.produtoId).not.toBe(PAI_ID);
    expect(familia.children.map((c) => c.produtoId)).toContain(modelo?.produtoId);
  });

  it('⛔ QUASE-IGUAL (M153): o MESMO kit importado SEM a linha do modelo ⇒ `sem-modelos`, nunca o item sem modelos', async () => {
    const db = new FakeDbComProjecao();
    semearComponente(db);

    await importarKitShopee(deps(db), entradaDeKit());
    // Apaga só as linhas `variashopee` que o import gravou: o vínculo (com o
    // carimbo) fica, e o kit deixa de ter modelo vinculado.
    for (const caminho of Object.keys(db.store)) {
      if (/\/variashopee\//.test(caminho)) delete db.store[caminho];
    }
    const plano = await planoDoPai(db);

    expect(plano.itens).toEqual([]);
    expect(plano.pulos).toEqual([
      expect.objectContaining({
        produtoId: PAI_ID,
        itemId: ITEM_ID,
        motivo: MOTIVO_PRECO_SHOPEE.semModelos,
      }),
    ]);
  });

  it('⛔ PAR: um anúncio COMUM importado planeja o item SEM modelos — o carimbo é `false`', async () => {
    const db = new FakeDbComProjecao();

    await importarAnuncioShopee(deps(db), entradaComum());
    const familia = await familiaDoPai(db);
    const plano = montarItensDePreco(familia, INTEGRACAO);

    expect(familia.links.map((l) => l.kitNativo)).toEqual([false]);
    expect(plano.pulos).toEqual([]);
    expect(plano.itens).toHaveLength(1);
    expect(plano.itens[0]).toMatchObject({ itemId: ITEM_ID, modelos: [] });
  });

  it('um RE-IMPORT do kit planeja o MESMO item — o merge não perde o carimbo nem duplica a linha do modelo', async () => {
    const db = new FakeDbComProjecao();
    semearComponente(db);

    await importarKitShopee(deps(db), entradaDeKit());
    const primeiro = montarItensDePreco(await familiaDoPai(db), INTEGRACAO);
    await importarKitShopee(deps(db), entradaDeKit());
    const familia = await familiaDoPai(db);
    const segundo = montarItensDePreco(familia, INTEGRACAO);

    expect(familia.links.map((l) => l.kitNativo)).toEqual([true]);
    expect(segundo).toEqual(primeiro);
    expect(segundo.itens[0]?.modelos).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  RT6, a metade do PR 8 — converter → o anúncio comum ainda recebe PREÇO      */
/* -------------------------------------------------------------------------- */

/*
 * Every document the price path reads here was written by the REAL writers: the
 * ordinary listing is the legacy state L0 describes (an old-model kit step 11
 * published — the one seed), and the kit link, its rows and the supersede
 * pointer are what the REAL `converterEmKit` wrote. Ids are the kit ROLES.
 */

type Json = Record<string, unknown>;

const RT6_REF_CONTA = toOuterRef(integracaoCollection.docPath({}, INTEGRACAO));
const RT6_KIT = 2500139870;
const RT6_MODELOS_DO_KIT = [2000458820, 2000458823] as const;
const RT6_COMUM = 2500139861;
const RT6_COMUM_AZ = 2000458802;
const RT6_COMUM_VD = 2000458803;
const RT6_COMP_A = 2500139871;
const RT6_COMP_A_MODELO = 2000458821;
const RT6_COMP_B = 2500139872;
const RT6_COMP_B_OCULTO = 2000458829;
const RT6_CATEGORIA = 107290;
const RT6_K = 'kit-k';
const RT6_AZUL = 'kit-k-azul';
const RT6_VERDE = 'kit-k-verde';
const RT6_GRUPO = 'grupo-cor';
const RT6_SKU = 'KIT-1';
const RT6_VINCULO_KIT = idDoVinculoDeKit(INTEGRACAO, RT6_KIT);
const RT6_VINCULO_COMUM = 'link-comum';

function rt6SemearComponentes(db: FakeDb): void {
  db.seed('produtos/comp-a', { nome: 'Camiseta', sku: 'CAM', paiId: null });
  db.seed('produtos/comp-a/prodshopee/link-comp-a', {
    item_id: RT6_COMP_A,
    contaProdutoShopeeOuterRef: RT6_REF_CONTA,
    category_id: RT6_CATEGORIA,
  });
  db.seed('produtos/comp-a-filho', { nome: 'Camiseta P', sku: 'CAM-P', paiId: 'comp-a' });
  db.seed('produtos/comp-a-filho/variashopee/var-comp-a', {
    model_id: RT6_COMP_A_MODELO,
    contaVariacaoShopeeOuterRef: RT6_REF_CONTA,
    produtoShopeeOuterRef: 'documents/produtos/comp-a/prodshopee/link-comp-a',
  });
  db.seed('produtos/comp-b', {
    nome: 'Boné',
    sku: 'BONE',
    paiId: null,
    filhoUnicoId: 'comp-b-membro',
  });
  db.seed('produtos/comp-b/prodshopee/link-comp-b', {
    item_id: RT6_COMP_B,
    contaProdutoShopeeOuterRef: RT6_REF_CONTA,
    category_id: RT6_CATEGORIA,
  });
  db.seed('produtos/comp-b-membro', { nome: 'Boné', sku: 'BONE-UN', paiId: 'comp-b' });
}

/**
 * K — an OLD-MODEL kit (L0: `ehKit`, `ehKitVirtual` off), a 2-child family on one
 * axis (Azul = A + B, Verde = 2 × A, K's price propagating), already published by
 * step 11 as an ORDINARY listing with one `variashopee` per child.
 */
function rt6SemearKitComAnuncioComum(db: FakeDb): void {
  db.seed(`produtos/${RT6_K}`, {
    nome: 'Kit camiseta e boné',
    sku: RT6_SKU,
    paiId: null,
    ehKit: true,
    ehKitVirtual: null,
    pesoBrutoKg: 0.8,
    alturaCm: 10,
    larguraCm: 20,
    profundidadeCm: 30,
    precos: { 'tab-normal': { valor: 99.9 } },
    fotos: [{ arquivoOuterRef: 'arquivos/arq-1' }],
  });
  db.seed(`produtos/${RT6_K}/extraData/singleton`, { descricao: 'Kit para presente.' });
  db.seed(`grupoDeVariacoes/${RT6_GRUPO}`, {
    nome: 'Cor',
    ordem: 1,
    variacoes: [
      { id: 'var-azul', nome: 'Azul' },
      { id: 'var-verde', nome: 'Verde' },
    ],
  });
  const filho = (id: string, variante: string, ordem: number, componentesKit: Json): void => {
    db.seed(`produtos/${id}`, {
      nome: `Kit ${variante}`,
      sku: `${RT6_SKU}-${String(ordem)}`,
      paiId: RT6_K,
      ordem,
      ehKit: true,
      grupoDeVariacoesUid: [RT6_GRUPO],
      variacoesUid: [varianteFakePath(RT6_GRUPO, variante)],
      componentesKit,
    });
  };
  filho(RT6_AZUL, 'var-azul', 1, {
    'comp-a-filho': { quantidade: 1, limitarEstoque: true },
    'comp-b-membro': { quantidade: 1, limitarEstoque: true },
  });
  filho(RT6_VERDE, 'var-verde', 2, { 'comp-a-filho': { quantidade: 2, limitarEstoque: true } });
  db.seed(`produtos/${RT6_K}/prodshopee/${RT6_VINCULO_COMUM}`, {
    contaProdutoShopeeOuterRef: RT6_REF_CONTA,
    item_id: RT6_COMUM,
    item_name: 'Kit camiseta e boné',
    item_status: 'NORMAL',
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    kitNativo: false,
    category_id: RT6_CATEGORIA,
  });
  for (const [filhoId, modelo, tier] of [
    [RT6_AZUL, RT6_COMUM_AZ, 0],
    [RT6_VERDE, RT6_COMUM_VD, 1],
  ] as const) {
    db.seed(`produtos/${filhoId}/variashopee/var-comum-${String(tier)}`, {
      contaVariacaoShopeeOuterRef: RT6_REF_CONTA,
      produtoShopeeOuterRef: `documents/produtos/${RT6_K}/prodshopee/${RT6_VINCULO_COMUM}`,
      model_id: modelo,
      tier_index: [tier],
      model_status: 'NORMAL',
      modeloAusenteEm: null,
      receitaKitConferida: null,
    });
  }
}

/** One model as the shop holds it — the price is MUTABLE, the rest is what was created. */
interface Rt6Modelo {
  readonly model_id: number;
  readonly model_sku: string | null;
  original_price: number;
  readonly tier_index: number[];
  readonly component_list: Json[];
}

interface Rt6Loja {
  readonly client: ShopeeClient;
  readonly ops: { readonly op: string; readonly itemId: number | null }[];
  readonly corposPreco: unknown[];
  readonly corposKit: ShopeeUpdateKitItemRequest[];
  /** Seller Centre deleted the ORDINARY listing (it reads `SELLER_DELETE`). */
  apagarComum: () => void;
}

/**
 * A shop holding the ORDINARY listing (two models, BRL shelf prices, `tag.kit:
 * false`) that CREATES what `add_kit_item` is sent (`tag.kit: true`, the plain
 * component read back with its HIDDEN model id) and applies BOTH price
 * transports: `update_price` to the ordinary listing, `update_kit_item` to the
 * kit. A transport sent to the wrong kind of listing throws. Anything not
 * arranged throws.
 */
function rt6Loja(): Rt6Loja {
  const ops: { op: string; itemId: number | null }[] = [];
  const corposPreco: unknown[] = [];
  const corposKit: ShopeeUpdateKitItemRequest[] = [];
  const bases = new Map<number, Json>([
    [
      RT6_COMP_A,
      { item_id: RT6_COMP_A, item_status: 'NORMAL', has_model: true, tag: { kit: false } },
    ],
    [
      RT6_COMP_B,
      { item_id: RT6_COMP_B, item_status: 'NORMAL', has_model: false, tag: { kit: false } },
    ],
    [
      RT6_COMUM,
      {
        item_id: RT6_COMUM,
        item_name: 'Kit camiseta e boné',
        item_sku: RT6_SKU,
        item_status: 'NORMAL',
        has_model: true,
        tag: { kit: false },
        category_id: RT6_CATEGORIA,
      },
    ],
  ]);
  const comum: Rt6Modelo[] = [
    {
      model_id: RT6_COMUM_AZ,
      model_sku: null,
      original_price: 99.9,
      tier_index: [0],
      component_list: [],
    },
    {
      model_id: RT6_COMUM_VD,
      model_sku: null,
      original_price: 99.9,
      tier_index: [1],
      component_list: [],
    },
  ];
  let doKit: Rt6Modelo[] = [];
  let kit: Json | null = null;

  const listaDeModelos = (modelos: readonly Rt6Modelo[], tiers: unknown) =>
    shopeeModelListPayloadSchema.parse({
      tier_variation: tiers,
      model: modelos.map((m) => ({
        model_id: m.model_id,
        tier_index: m.tier_index,
        model_status: 'MODEL_NORMAL',
        model_sku: m.model_sku,
        price_info: [
          { currency: 'BRL', original_price: m.original_price, current_price: m.original_price },
        ],
      })),
    });

  const conhecidas: Record<string, (p: never) => Promise<unknown>> = {
    getItemBaseInfo: (p: { itemIds: readonly number[] }) => {
      ops.push({ op: 'get_item_base_info', itemId: null });
      return Promise.resolve(
        shopeeItemBaseInfoPayloadSchema.parse({
          item_list: p.itemIds.flatMap((id) => {
            const b = bases.get(id);
            return b === undefined ? [] : [b];
          }),
        }),
      );
    },
    getItemList: (p: { statuses: readonly string[] }) => {
      ops.push({ op: 'get_item_list', itemId: null });
      const item = [...bases.values()]
        .filter((b) => p.statuses.includes(String(b.item_status)))
        .map((b) => ({ item_id: b.item_id, item_status: b.item_status, tag: b.tag }));
      return Promise.resolve(
        shopeeItemListPayloadSchema.parse({
          item,
          total_count: item.length,
          has_next_page: false,
          next_offset: null,
          next: '',
        }),
      );
    },
    getKitItemInfo: (p: { itemId: number }) => {
      ops.push({ op: 'get_kit_item_info', itemId: p.itemId });
      return Promise.resolve(
        shopeeKitItemInfoPayloadSchema.parse({
          product_info:
            p.itemId === RT6_KIT && kit !== null
              ? { ...kit, model_list: doKit.map((m) => ({ ...m })) }
              : null,
        }),
      );
    },
    getModelList: (p: { itemId: number }) => {
      ops.push({ op: 'get_model_list', itemId: p.itemId });
      if (p.itemId === RT6_COMUM) return Promise.resolve(listaDeModelos(comum, []));
      if (p.itemId === RT6_KIT && kit !== null) {
        return Promise.resolve(listaDeModelos(doKit, kit.tier_variation_list));
      }
      return Promise.resolve(shopeeModelListPayloadSchema.parse({ model: [] }));
    },
    getKitItemLimit: () => {
      ops.push({ op: 'get_kit_item_limit', itemId: null });
      return Promise.reject(
        shopeeErrorFromEnvelope(
          { error: 'error_not_found', message: null, request_id: null, warning: null },
          {
            path: SHOPEE_GET_KIT_ITEM_LIMIT_PATH,
            httpStatus: 404,
            surface: SHOPEE_SURFACE.business,
          },
        ),
      );
    },
    getChannelList: () => {
      ops.push({ op: 'get_channel_list', itemId: null });
      return Promise.resolve({
        logistics_channel_list: [
          shopeeLogisticsChannelSchema.parse({
            logistics_channel_id: 90_003,
            enabled: true,
            fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
          }),
        ],
      });
    },
    getItemViolationInfo: (p: { itemIds: readonly number[] }) => {
      ops.push({ op: 'get_item_violation_info', itemId: null });
      return Promise.resolve({
        item_list: p.itemIds.map((id) => ({
          item_id: id,
          item_status: bases.get(id)?.item_status ?? 'NORMAL',
          deboost: false,
          item_status_details: null,
          deboost_details: null,
          deboosted_details: null,
          fail_error: null,
          fail_message: null,
        })),
      } as unknown as ShopeeItemViolationInfo);
    },
    addKitItem: (corpo: ShopeeAddKitItemRequest) => {
      ops.push({ op: 'add_kit_item', itemId: null });
      const s = corpo.item_setting;
      doKit = s.model_list.map((m, i) => ({
        model_id: RT6_MODELOS_DO_KIT[i] ?? RT6_KIT + i,
        model_sku: m.model_sku ?? null,
        original_price: m.original_price,
        tier_index: [...m.tier_index],
        component_list: m.component_list.map((c) => ({
          component_item_id: c.component_item_id,
          component_model_id:
            c.component_model_id ?? (c.component_item_id === RT6_COMP_B ? RT6_COMP_B_OCULTO : null),
          quantity: c.quantity,
          main_component: c.main_component === true,
        })),
      }));
      kit = {
        item_id: RT6_KIT,
        item_name: s.item_name,
        item_sku: s.item_sku ?? null,
        item_status: 'NORMAL',
        category_id: RT6_CATEGORIA,
        weight: String(s.weight),
        tier_variation_list: s.tier_variation_list.map((t) => ({
          name: t.name,
          option_list: t.option_list.map((o) => ({ option: o.option })),
        })),
      };
      bases.set(RT6_KIT, {
        item_id: RT6_KIT,
        item_name: s.item_name,
        item_sku: s.item_sku ?? null,
        item_status: 'NORMAL',
        has_model: true,
        tag: { kit: true },
        category_id: RT6_CATEGORIA,
        image: { image_id_list: ['img-kit-1'] },
      });
      return Promise.resolve({
        request_id: 'req-1',
        error: '',
        message: '',
        warning: '',
        response: { item_id: RT6_KIT },
      });
    },
    updatePrice: (corpo: {
      item_id: number;
      price_list: readonly { model_id: number; original_price: number }[];
    }) => {
      ops.push({ op: 'update_price', itemId: corpo.item_id });
      corposPreco.push(corpo);
      // A kit is never priced through `update_price` here (L5's ruling).
      if (corpo.item_id !== RT6_COMUM) {
        throw new Error(`fixture: update_price no item ${String(corpo.item_id)}`);
      }
      for (const linha of corpo.price_list) {
        const alvo = comum.find((m) => m.model_id === linha.model_id);
        if (alvo !== undefined) alvo.original_price = linha.original_price;
      }
      return Promise.resolve(
        shopeeUpdatePriceSchema.parse({
          request_id: 'req-2',
          error: '',
          message: null,
          warning: null,
          response: { success_list: corpo.price_list, failure_list: [] },
        }),
      );
    },
    updateKitItem: (corpo: ShopeeUpdateKitItemRequest) => {
      ops.push({ op: 'update_kit_item', itemId: corpo.item_id });
      corposKit.push(corpo);
      if (corpo.item_id !== RT6_KIT) {
        throw new Error(`fixture: update_kit_item no item ${String(corpo.item_id)}`);
      }
      for (const enviado of corpo.item_setting?.model_list ?? []) {
        const alvo = doKit.find((m) => m.model_id === enviado.model_id);
        if (alvo !== undefined && enviado.original_price !== undefined) {
          alvo.original_price = enviado.original_price;
        }
      }
      return Promise.resolve({ request_id: 'req-3', error: '', message: '', warning: '' });
    },
  };
  const client = new Proxy({} as Record<string, unknown>, {
    get(_alvo, prop) {
      // Not a thenable: the re-verify hands the client through a Promise.
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      const fn = conhecidas[prop];
      if (fn !== undefined) return fn;
      return () => {
        ops.push({ op: `?${prop}`, itemId: null });
        throw new Error(`fixture: a loja não serve ${prop}`);
      };
    },
  }) as unknown as ShopeeClient;
  return {
    client,
    ops,
    corposPreco,
    corposKit,
    apagarComum: () => {
      const base = bases.get(RT6_COMUM);
      if (base !== undefined) bases.set(RT6_COMUM, { ...base, item_status: 'SELLER_DELETE' });
    },
  };
}

function rt6Resolvedor(): ResolvedorDeImagensShopee {
  return {
    resolver: (fotos) =>
      Promise.resolve({
        imageIds: ['img-kit-1'],
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
}

function rt6DepsDoKit(db: FakeDb, loja: Rt6Loja): KitDeps {
  return {
    db: asDb(db),
    client: loja.client,
    partnerClient: () => {
      throw new Error('fixture: o partner client só é usado pelo resolvedor de imagens');
    },
    integracaoId: INTEGRACAO,
    tabelaNormalOuterRef: 'documents/listaDePrecos/tab-normal',
    depositoOuterRef: 'documents/depositos/dep-1',
    operacaoOuterRef: null,
    nowMs: AGORA,
    esperar: () => Promise.resolve(),
    taxonomia: {
      integracaoId: INTEGRACAO,
      client: loja.client,
      variationsPath: SHOPEE_GET_VARIATIONS_PATH,
    },
    categorias: {
      carregar: () => {
        throw new Error('fixture: o kit não lê a árvore de categorias');
      },
    },
    resolvedorDeImagens: rt6Resolvedor(),
    increment,
  };
}

/** The conta the price sender takes — a verdict that PASSED, in reais. */
function rt6Conta(loja: Rt6Loja): ContextoContaPreco {
  return {
    integracaoId: INTEGRACAO,
    client: loja.client,
    regiao: 'BR',
    moeda: 'BRL',
    multiplo: 4,
    tabelaNormalId: 'tab-normal',
  } as ContextoContaPreco;
}

/** The REAL converter: the native kit created, the ordinary link SUPERSEDED. */
async function rt6Converter(db: FakeDb, loja: Rt6Loja): Promise<void> {
  const r = await publicarKitShopee(
    rt6DepsDoKit(db, loja),
    { produtoId: RT6_K, statusPedido: 'NORMAL', principal: 'comp-a-filho' },
    { arma: 'kit-converter', antecessorLinkDocId: RT6_VINCULO_COMUM },
  );
  expect(r).toMatchObject({
    arma: 'kit-converter',
    desfecho: 'criado',
    itemId: RT6_KIT,
    linkDocId: RT6_VINCULO_KIT,
    antecessor: { itemId: RT6_COMUM, linkDocId: RT6_VINCULO_COMUM, substituido: true },
  });
  // The ERP's new prices: K stops propagating, Azul stays, Verde goes up — so on
  // EACH listing exactly the Verde model changes.
  const merge = (caminho: string, patch: Json): void => {
    db.seed(caminho, { ...(db.store[caminho]?.data as Json), ...patch });
  };
  merge(`produtos/${RT6_K}`, { propagatePriceToChildren: false });
  merge(`produtos/${RT6_AZUL}`, { precos: { 'tab-normal': { valor: 99.9 } } });
  merge(`produtos/${RT6_VERDE}`, { precos: { 'tab-normal': { valor: 120 } } });
}

async function rt6Plano(db: FakeDb) {
  const familia = (await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [RT6_K] })).get(RT6_K);
  expect(familia).toBeDefined();
  return { familia: familia!, plano: montarItensDePreco(familia!, INTEGRACAO) };
}

describe('RT6 (metade do PR 8) — depois do converter, o anúncio comum SUBSTITUÍDO ainda recebe preço', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    limparTaxonomiaShopee();
    vi.restoreAllMocks();
  });

  it('⚠️ PAR (L8): o plano endereça OS DOIS anúncios; o G9 manda `update_price` ao comum (base `tag.kit` false) e `update_kit_item` ao kit novo — cada um com SÓ o modelo que mudou', async () => {
    const db = new FakeDbComProjecao();
    rt6SemearComponentes(db);
    rt6SemearKitComAnuncioComum(db);
    const loja = rt6Loja();
    await rt6Converter(db, loja);

    // The supersede pointer the converter wrote is on the ORDINARY link…
    expect(db.store[`produtos/${RT6_K}/prodshopee/${RT6_VINCULO_COMUM}`]?.data).toMatchObject({
      substituidoPorLinkDocId: RT6_VINCULO_KIT,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });

    // …and step 13 does not read it: BOTH listings are planned, nothing skipped.
    const { familia, plano } = await rt6Plano(db);
    expect(plano.pulos).toEqual([]);
    expect(
      plano.itens
        .map((i) => [i.linkDocId, i.itemId, i.modelos.map((m) => [m.produtoId, m.modelId])])
        .sort((a, b) => (String(a[1]) < String(b[1]) ? -1 : 1)),
    ).toEqual([
      [
        RT6_VINCULO_COMUM,
        RT6_COMUM,
        [
          [RT6_AZUL, RT6_COMUM_AZ],
          [RT6_VERDE, RT6_COMUM_VD],
        ],
      ],
      [
        RT6_VINCULO_KIT,
        RT6_KIT,
        [
          [RT6_AZUL, RT6_MODELOS_DO_KIT[0]],
          [RT6_VERDE, RT6_MODELOS_DO_KIT[1]],
        ],
      ],
    ]);

    const lerBase = criarLeitorDeBaseEmLote(loja.client, [RT6_COMUM, RT6_KIT]);
    const resultados = [];
    for (const planejado of plano.itens) {
      const item = precificarItem(planejado, precosDaFamilia(familia), 'tab-normal');
      resultados.push(
        await enviarPrecoDoItem(item, {
          db: asDb(db),
          conta: rt6Conta(loja),
          nowMs: AGORA + 60_000,
          baixarPreco: false,
          lerBase,
        }),
      );
    }

    // The ORDINARY listing: `update_price`, only the Verde model.
    expect(loja.corposPreco).toEqual([
      { item_id: RT6_COMUM, price_list: [{ model_id: RT6_COMUM_VD, original_price: 120 }] },
    ]);
    // The NEW kit: `update_kit_item`, only the Verde model, its LIVE recipe verbatim.
    expect(loja.corposKit).toEqual([
      {
        item_id: RT6_KIT,
        item_setting: {
          model_list: [
            {
              model_id: RT6_MODELOS_DO_KIT[1],
              tier_index: [1],
              original_price: 120,
              component_list: [
                {
                  component_item_id: RT6_COMP_A,
                  component_model_id: RT6_COMP_A_MODELO,
                  quantity: 2,
                },
              ],
            },
          ],
        },
      },
    ]);
    // ⛔ Never the other transport on either listing.
    expect(loja.ops.filter((o) => o.op === 'update_price').map((o) => o.itemId)).toEqual([
      RT6_COMUM,
    ]);
    expect(loja.ops.filter((o) => o.op === 'update_kit_item').map((o) => o.itemId)).toEqual([
      RT6_KIT,
    ]);
    expect(resultados.map((r) => r.tipo)).toEqual(['enviado', 'enviado']);
  });

  it('⛔ QUASE-PAR: SUBSTITUÍDO não é REMOVIDO — depois que o comum é excluído no Seller Centre e o reverify REAL o lê `removido`, o passo 13 o pula (`anuncio-removido`) e só o kit segue planejado', async () => {
    const db = new FakeDbComProjecao();
    rt6SemearComponentes(db);
    rt6SemearKitComAnuncioComum(db);
    const loja = rt6Loja();
    await rt6Converter(db, loja);

    loja.apagarComum();
    const reverificado = await reverificarAnuncioShopee(
      asDb(db),
      { integracaoId: INTEGRACAO, produtoId: RT6_K, linkDocId: RT6_VINCULO_COMUM },
      { clientFor: () => Promise.resolve(loja.client), increment, nowMs: AGORA + 2_000 },
    );
    expect(reverificado).not.toBeNull();
    expect(db.store[`produtos/${RT6_K}/prodshopee/${RT6_VINCULO_COMUM}`]?.data).toMatchObject({
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
    });

    const { plano } = await rt6Plano(db);
    expect(plano.itens.map((i) => i.itemId)).toEqual([RT6_KIT]);
    expect(plano.pulos).toEqual([
      expect.objectContaining({
        itemId: RT6_COMUM,
        motivo: MOTIVO_PRECO_SHOPEE.anuncioRemovido,
      }),
    ]);
  });
});
