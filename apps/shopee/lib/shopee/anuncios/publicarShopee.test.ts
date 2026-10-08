/**
 * The publish ENTRY POINT (step 19, PR 7 — reconcile §2.5.3, §4.2): every round
 * trip that needs the DISPATCHER in the chain, end to end over `fakeDb` + a
 * STATEFUL multi-kit shop double.
 *
 * - RT11 — an L6 refusal → step 9's import → the dispatcher, over the WRITTEN
 *   docs, answers `kit-atualizar` and `publicarShopee` executes it;
 * - RT12 — an `incerto` create → the refusal → the MASS import → the next
 *   publish, through the entry;
 * - RT13 / RT14 — the PR 7 halves of the recriar and converter crash resumes
 *   (the PR 6 halves drive the appliers directly in `kits/recriarKit.test.ts`);
 * - RT15 — the accepted double create (R-w), concurrent for real;
 * - M176 — the `incerto` command is arm-specific; M186 — the dry run and the
 *   live run address ONE listing.
 *
 * No link or row is hand-built, except the ORDINARY (old-model) listing a
 * converter starts from — the legacy state L0 describes — and M186's link
 * states, which are what the dispatcher is asked to read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ADD_KIT_ITEM_PATH,
  SHOPEE_GET_KIT_ITEM_LIMIT_PATH,
  SHOPEE_GET_VARIATIONS_PATH,
  SHOPEE_LOGISTICS_FEE_TYPE,
  SHOPEE_SURFACE,
  assertUpdateKitItemRequest,
  shopeeErrorFromEnvelope,
  shopeeItemBaseInfoPayloadSchema,
  shopeeItemListPayloadSchema,
  shopeeKitItemInfoPayloadSchema,
  shopeeLogisticsChannelSchema,
  shopeeModelListPayloadSchema,
  type ShopeeAddKitItemRequest,
  type ShopeeClient,
  type ShopeeUpdateKitItemRequest,
} from '@delfrance/integrations-shopee';
import {
  ESTADO_ANUNCIO_SHOPEE,
  importacaoShopeeOptionsSchema,
  toOuterRef,
  varianteFakePath,
} from '@delfrance/schemas';
import { integracaoCollection } from '@delfrance/data/admin/collections';

import { MOTIVO_ESTOQUE_SHOPEE } from '../estoque/errosEstoque';
import { podeEnviarEstoqueShopee } from '../estoque/podeEnviarEstoque';
import { lerFixture, FIXTURE_ADD_KIT_ITEM_SG_TOO_MANY_CONNECTIONS } from '../fixtures/wireCorpus';
import { idDoVinculoDeKit } from '../kits/idsKit';
import type { KitDeps, ResultadoPublicacaoKit } from '../kits/resultadoKit';
import { iniciarImportacaoShopee, processarImportacaoShopee } from '../produtos/importacaoMassa';
import type { ImportarKitShopeeDeps } from '../produtos/itemLido';
import { importarKitShopee } from '../produtos/kitShopee';
import { lerAnuncioShopee } from '../produtos/lerAnuncio';
import { limparTaxonomiaShopee } from '../taxonomia/cache';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { MSG_RECRIAR_SEM_LINK, lerCorpoPublicar } from './corpoPublicacao';
import { MOTIVO_PUBLICACAO_BLOQUEADA, ShopeePublishBlockedError } from './errosPublicacao';
import type { ResolvedorDeImagensShopee } from './fotosPublicacao';
import { resolverLinkPorProduto } from './linkAnuncio';
import { prepararPublicacao, publicarAnuncioShopee } from './publicarAnuncio';
import {
  ensaiarPublicacaoShopee,
  escolherArmaShopee,
  publicarShopee,
  type EntradaDePublicacaoShopee,
  type ResultadoPublicacaoShopee,
} from './publicarShopee';

// M186's seam: step 11's two halves, REAL by default (every kit module reads its
// helpers through this same module), observable when a test asks.
vi.mock('./publicarAnuncio', async (importOriginal) => {
  const real = await importOriginal<typeof import('./publicarAnuncio')>();
  return {
    ...real,
    prepararPublicacao: vi.fn(real.prepararPublicacao),
    publicarAnuncioShopee: vi.fn(real.publicarAnuncioShopee),
  };
});

/* -------------------------------------------------------------------------- */
/*  Fixtures — role ids only (s19-ctx). Never a real partner, shop or item.     */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

const INTEGRACAO = 'int-1';
const REF_CONTA = toOuterRef(integracaoCollection.docPath({}, INTEGRACAO));
const AGORA = 1_757_000_000_000;

/** The FIRST kit the shop creates; the SECOND (a recriar's new kit, the double-create twin). */
const KIT_1 = 2500139870;
const KIT_2 = 2500139873;
/** The ordinary (old-model) listing a converter starts from. */
const ITEM_COMUM = 2500139861;
const MODELO_COMUM_AZ = 2000458802;
const MODELO_COMUM_VD = 2000458803;
const COMP_A_ITEM = 2500139871;
const COMP_A_MODELO = 2000458821;
const COMP_B_ITEM = 2500139872;
const COMP_B_OCULTO = 2000458829;
const CATEGORIA = 107290;
const CANAL = 90_003;

const MODELOS_DE: Readonly<Record<number, readonly number[]>> = {
  [KIT_1]: [2000458820, 2000458823, 2000458822],
  [KIT_2]: [2000458824, 2000458825, 2000458826],
};
/** `create_time` (SECONDS) — the second kit is NEWER (the recriar's delete gate). */
const CRIADO_EM: Readonly<Record<number, number>> = { [KIT_1]: 1791244800, [KIT_2]: 1791248400 };

const K = 'kit-k';
const K_AZUL = 'kit-k-azul';
const K_VERDE = 'kit-k-verde';
const GRUPO = 'grupo-cor';
const SKU = 'KIT-1';
const VINCULO_1 = idDoVinculoDeKit(INTEGRACAO, KIT_1);
const VINCULO_2 = idDoVinculoDeKit(INTEGRACAO, KIT_2);
const VINCULO_COMUM = 'link-comum';

/* --------------------------------- the db --------------------------------- */

function semearComponentes(db: FakeDb): void {
  db.seed('produtos/comp-a', { nome: 'Camiseta', sku: 'CAM', paiId: null });
  db.seed('produtos/comp-a/prodshopee/link-comp-a', {
    item_id: COMP_A_ITEM,
    contaProdutoShopeeOuterRef: REF_CONTA,
    category_id: CATEGORIA,
  });
  db.seed('produtos/comp-a-filho', { nome: 'Camiseta P', sku: 'CAM-P', paiId: 'comp-a' });
  db.seed('produtos/comp-a-filho/variashopee/var-comp-a', {
    model_id: COMP_A_MODELO,
    contaVariacaoShopeeOuterRef: REF_CONTA,
    produtoShopeeOuterRef: 'documents/produtos/comp-a/prodshopee/link-comp-a',
  });
  db.seed('produtos/comp-b', {
    nome: 'Boné',
    sku: 'BONE',
    paiId: null,
    filhoUnicoId: 'comp-b-membro',
  });
  db.seed('produtos/comp-b/prodshopee/link-comp-b', {
    item_id: COMP_B_ITEM,
    contaProdutoShopeeOuterRef: REF_CONTA,
    category_id: CATEGORIA,
  });
  db.seed('produtos/comp-b-membro', { nome: 'Boné', sku: 'BONE-UN', paiId: 'comp-b' });
}

/** K, a 2-child FAMILY on ONE axis (`Cor`): Azul = A + B, Verde = 2 × A. */
function semearFamilia(db: FakeDb, k: Json = {}): void {
  db.seed(`produtos/${K}`, {
    nome: 'Kit camiseta e boné',
    sku: SKU,
    paiId: null,
    ehKit: true,
    ehKitVirtual: true,
    pesoBrutoKg: 0.8,
    alturaCm: 10,
    larguraCm: 20,
    profundidadeCm: 30,
    precos: { 'tab-normal': { valor: 99.9 } },
    fotos: [{ arquivoOuterRef: 'arquivos/arq-1' }],
    ...k,
  });
  db.seed(`produtos/${K}/extraData/singleton`, {
    descricao: 'Kit com uma camiseta de algodão e um boné, para presente.',
  });
  db.seed(`grupoDeVariacoes/${GRUPO}`, {
    nome: 'Cor',
    ordem: 1,
    variacoes: [
      { id: 'var-azul', nome: 'Azul' },
      { id: 'var-verde', nome: 'Verde' },
    ],
  });
  semearFilho(db, K_AZUL, 'var-azul', `${SKU}-AZ`, 1, {
    'comp-a-filho': { quantidade: 1, limitarEstoque: true },
    'comp-b-membro': { quantidade: 1, limitarEstoque: true },
  });
  semearFilho(db, K_VERDE, 'var-verde', `${SKU}-VD`, 2, {
    'comp-a-filho': { quantidade: 2, limitarEstoque: true },
  });
}

function semearFilho(
  db: FakeDb,
  id: string,
  variante: string,
  sku: string,
  ordem: number,
  componentesKit: Json,
): void {
  db.seed(`produtos/${id}`, {
    nome: `Kit ${variante}`,
    sku,
    paiId: K,
    ordem,
    ehKit: true,
    grupoDeVariacoesUid: [GRUPO],
    variacoesUid: [varianteFakePath(GRUPO, variante)],
    componentesKit,
  });
}

/** The ERP recipe edit a recriar exists for: Verde 2 × A → `n` × A. */
function editarVerde(db: FakeDb, quantidade: number): void {
  const atual = db.store[`produtos/${K_VERDE}`]?.data as Json;
  db.seed(`produtos/${K_VERDE}`, {
    ...atual,
    componentesKit: { 'comp-a-filho': { quantidade, limitarEstoque: true } },
  });
}

/** K's OLD-MODEL listing (L0): an ORDINARY `prodshopee` + one `variashopee` per child. */
function semearAnuncioComum(db: FakeDb): void {
  db.seed(`produtos/${K}/prodshopee/${VINCULO_COMUM}`, {
    contaProdutoShopeeOuterRef: REF_CONTA,
    item_id: ITEM_COMUM,
    item_name: 'Kit camiseta e boné',
    item_status: 'NORMAL',
    estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    kitNativo: false,
    category_id: CATEGORIA,
  });
  for (const [filho, modelo, tier] of [
    [K_AZUL, MODELO_COMUM_AZ, 0],
    [K_VERDE, MODELO_COMUM_VD, 1],
  ] as const) {
    db.seed(`produtos/${filho}/variashopee/var-comum-${String(tier)}`, {
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: `documents/produtos/${K}/prodshopee/${VINCULO_COMUM}`,
      model_id: modelo,
      tier_index: [tier],
      model_status: 'NORMAL',
      modeloAusenteEm: null,
      receitaKitConferida: null,
    });
  }
}

/* --------------------------- the stateful shop double ------------------------ */

const CANAL_DA_LOJA = shopeeLogisticsChannelSchema.parse({
  logistics_channel_id: CANAL,
  enabled: true,
  fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
});

const OCULTO: Readonly<Record<number, number>> = { [COMP_B_ITEM]: COMP_B_OCULTO };

interface ItemNaLoja {
  base: Json;
  kit?: Json;
  modelos?: Json;
}

interface Chamada {
  readonly op: string;
  readonly ids: readonly number[];
}

/** A barrier: the first `esperados - 1` `add_kit_item` calls wait for the last. */
interface Portao {
  readonly esperados: number;
  chegaram: number;
  readonly liberar: (() => void)[];
}

interface Loja {
  readonly client: ShopeeClient;
  readonly ops: string[];
  readonly chamadas: Chamada[];
  readonly corposDoAdd: ShopeeAddKitItemRequest[];
  readonly corposDoUpdate: ShopeeUpdateKitItemRequest[];
  readonly itens: Map<number, ItemNaLoja>;
  readonly proximos: number[];
  /** `add_kit_item` creates, THEN throws this (an uncertain create that did create). */
  falhaAposCriar: Error | null;
  /** Per CREATED item: `add_kit_item` creates it, then throws (a run that dies before its link write). */
  readonly falhaAposCriarPorItem: Map<number, Error>;
  /** A crash mid-run: the `get_item_base_info` carrying `itemId` throws `erro` after `depois` such calls. */
  falhaNaLeitura: { readonly itemId: number; readonly erro: Error; depois: number } | null;
  exclusao: 'apaga' | 'quebra';
  portao: Portao | null;
}

function muitasConexoes(): Error {
  const corpo = lerFixture(FIXTURE_ADD_KIT_ITEM_SG_TOO_MANY_CONNECTIONS) as {
    error: string;
    message: string;
  };
  return shopeeErrorFromEnvelope(
    { error: corpo.error, message: corpo.message, request_id: null, warning: null },
    { path: SHOPEE_ADD_KIT_ITEM_PATH, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

function naoServido(): Error {
  return shopeeErrorFromEnvelope(
    { error: 'error_not_found', message: null, request_id: null, warning: null },
    { path: SHOPEE_GET_KIT_ITEM_LIMIT_PATH, httpStatus: 404, surface: SHOPEE_SURFACE.business },
  );
}

function itemComum(): ItemNaLoja {
  return {
    base: {
      item_id: ITEM_COMUM,
      item_sku: SKU,
      item_status: 'NORMAL',
      has_model: true,
      tag: { kit: false },
      category_id: CATEGORIA,
    },
    modelos: {
      tier_variation: [],
      model: [
        { model_id: MODELO_COMUM_AZ, tier_index: [0], model_status: 'MODEL_NORMAL' },
        { model_id: MODELO_COMUM_VD, tier_index: [1], model_status: 'MODEL_NORMAL' },
      ],
    },
  };
}

/**
 * A shop that CREATES what `add_kit_item` is sent (at the next id of
 * `proximos`) and serves it back the way the SG probe measured: `tag.kit: true`,
 * every plain component with its HIDDEN `component_model_id`, the models in SENT
 * tier order, listed by `get_item_list` from then on (deleted kits never).
 * `delete_item` folds the kit to `SELLER_DELETE`. Anything not arranged throws.
 */
function novaLoja(): Loja {
  const ops: string[] = [];
  const chamadas: Chamada[] = [];
  const itens = new Map<number, ItemNaLoja>([
    [
      COMP_A_ITEM,
      {
        base: { item_id: COMP_A_ITEM, item_status: 'NORMAL', has_model: true, tag: { kit: false } },
      },
    ],
    [
      COMP_B_ITEM,
      {
        base: {
          item_id: COMP_B_ITEM,
          item_status: 'NORMAL',
          has_model: false,
          tag: { kit: false },
        },
      },
    ],
  ]);
  const loja: Loja = {
    client: {} as ShopeeClient,
    ops,
    chamadas,
    corposDoAdd: [],
    corposDoUpdate: [],
    itens,
    proximos: [KIT_1, KIT_2],
    falhaAposCriar: null,
    falhaAposCriarPorItem: new Map(),
    falhaNaLeitura: null,
    exclusao: 'apaga',
    portao: null,
  };
  const anotar = (op: string, ids: readonly number[]): void => {
    ops.push(op);
    chamadas.push({ op, ids });
  };

  const criar = (corpo: ShopeeAddKitItemRequest): number => {
    const itemId = loja.proximos.shift();
    if (itemId === undefined) throw new Error('fixture: a loja não tem mais item_id para criar');
    const s = corpo.item_setting;
    const ids = MODELOS_DE[itemId] ?? [];
    const modelos = s.model_list.map((m, i) => ({
      model_id: ids[i] ?? itemId + i,
      model_sku: m.model_sku ?? null,
      original_price: m.original_price,
      tier_index: [...m.tier_index],
      component_list: m.component_list.map((c) => ({
        component_item_id: c.component_item_id,
        component_model_id: c.component_model_id ?? OCULTO[c.component_item_id] ?? null,
        quantity: c.quantity,
        main_component: c.main_component === true,
      })),
    }));
    const tiers = (s.tier_variation_list ?? []).map((t) => ({
      name: t.name,
      option_list: t.option_list.map((o) => ({ option: o.option })),
    }));
    const criadoEm = CRIADO_EM[itemId] ?? null;
    itens.set(itemId, {
      base: {
        item_id: itemId,
        item_name: s.item_name,
        item_sku: s.item_sku ?? null,
        item_status: 'NORMAL',
        has_model: true,
        tag: { kit: true },
        category_id: CATEGORIA,
        create_time: criadoEm,
      },
      kit: {
        item_id: itemId,
        item_name: s.item_name,
        item_sku: s.item_sku ?? null,
        item_status: 'NORMAL',
        category_id: CATEGORIA,
        weight: String(s.weight),
        model_list: modelos,
        tier_variation_list: tiers,
        create_time: criadoEm,
      },
      modelos: {
        tier_variation: tiers,
        model: modelos.map((m) => ({
          model_id: m.model_id,
          tier_index: m.tier_index,
          model_status: 'MODEL_NORMAL',
          model_sku: m.model_sku,
        })),
      },
    });
    return itemId;
  };

  const apagar = (itemId: number): void => {
    const item = itens.get(itemId);
    if (item === undefined) return;
    item.base = { ...item.base, item_status: 'SELLER_DELETE' };
    if (item.kit !== undefined) item.kit = { ...item.kit, item_status: 'SELLER_DELETE' };
  };

  const conhecidas: Record<string, (p: never) => Promise<unknown>> = {
    getItemBaseInfo: (p: { itemIds: readonly number[] }) => {
      anotar('get_item_base_info', p.itemIds);
      const falha = loja.falhaNaLeitura;
      if (falha !== null && p.itemIds.includes(falha.itemId)) {
        if (falha.depois > 0) {
          falha.depois -= 1;
        } else {
          loja.falhaNaLeitura = null;
          return Promise.reject(falha.erro);
        }
      }
      return Promise.resolve(
        shopeeItemBaseInfoPayloadSchema.parse({
          item_list: p.itemIds.flatMap((id) => {
            const item = itens.get(id);
            return item === undefined ? [] : [item.base];
          }),
        }),
      );
    },
    getItemList: (p: { statuses: readonly string[] }) => {
      anotar('get_item_list', []);
      const linhas = [...itens.values()]
        .filter((i) => p.statuses.includes(String(i.base.item_status)))
        .map((i) => ({
          item_id: i.base.item_id,
          item_status: i.base.item_status,
          tag: i.base.tag,
        }));
      return Promise.resolve(
        shopeeItemListPayloadSchema.parse({
          item: linhas,
          total_count: linhas.length,
          has_next_page: false,
          next_offset: null,
          next: '',
        }),
      );
    },
    getKitItemInfo: (p: { itemId: number }) => {
      anotar('get_kit_item_info', [p.itemId]);
      return Promise.resolve(
        shopeeKitItemInfoPayloadSchema.parse({ product_info: itens.get(p.itemId)?.kit ?? null }),
      );
    },
    getModelList: (p: { itemId: number }) => {
      anotar('get_model_list', [p.itemId]);
      return Promise.resolve(
        shopeeModelListPayloadSchema.parse(
          itens.get(p.itemId)?.modelos ?? { tier_variation: [], model: [] },
        ),
      );
    },
    getKitItemLimit: () => {
      anotar('get_kit_item_limit', []);
      return Promise.reject(naoServido());
    },
    getChannelList: () => {
      anotar('get_channel_list', []);
      return Promise.resolve({ logistics_channel_list: [CANAL_DA_LOJA] });
    },
    // The mass import builds a category memo; one leaf is all this shop has.
    getCategory: () => {
      anotar('get_category', []);
      return Promise.resolve({
        category_list: [
          {
            category_id: CATEGORIA,
            parent_category_id: 0,
            display_category_name: 'Kits',
            has_children: false,
          },
        ],
      });
    },
    addKitItem: async (corpo: ShopeeAddKitItemRequest) => {
      anotar('add_kit_item', []);
      loja.corposDoAdd.push(corpo);
      const portao = loja.portao;
      if (portao !== null) {
        portao.chegaram += 1;
        if (portao.chegaram < portao.esperados) {
          await new Promise<void>((liberar) => portao.liberar.push(liberar));
        } else {
          loja.portao = null;
          for (const liberar of portao.liberar) liberar();
        }
      }
      const itemId = criar(corpo);
      const doItem = loja.falhaAposCriarPorItem.get(itemId);
      if (doItem !== undefined) throw doItem;
      if (loja.falhaAposCriar !== null) {
        const falha = loja.falhaAposCriar;
        loja.falhaAposCriar = null;
        throw falha;
      }
      return {
        request_id: 'req-1',
        error: '',
        message: '',
        warning: '',
        response: { item_id: itemId },
      };
    },
    updateKitItem: (corpo: ShopeeUpdateKitItemRequest) => {
      anotar('update_kit_item', [corpo.item_id]);
      loja.corposDoUpdate.push(corpo);
      assertUpdateKitItemRequest(corpo);
      return Promise.resolve({ request_id: 'req-2', error: '', message: '', warning: '' });
    },
    deleteItem: (corpo: { item_id: number }) => {
      anotar('delete_item', [corpo.item_id]);
      const modo = loja.exclusao;
      loja.exclusao = 'apaga';
      if (modo === 'quebra') {
        // NOT a Shopee error: the run must crash (rule 6), leaving R2 behind.
        return Promise.reject(new TypeError('fixture: o processo caiu durante o delete_item'));
      }
      apagar(corpo.item_id);
      return Promise.resolve({ request_id: 'req-3', error: '', message: '', warning: '' });
    },
  };
  const client = new Proxy({} as Record<string, unknown>, {
    get(_alvo, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      const fn = conhecidas[prop];
      if (fn !== undefined) return fn;
      return () => {
        ops.push(`?${prop}`);
        throw new Error(`fixture: a publicação chamou ${prop}, que esta loja não serve`);
      };
    },
  }) as unknown as ShopeeClient;
  return Object.assign(loja, { client });
}

function resolvedorFake(loja: Loja): ResolvedorDeImagensShopee {
  return {
    resolver: (fotos, opcoes) => {
      loja.ops.push(`upload:${String(opcoes?.cap ?? 'padrao')}`);
      return Promise.resolve({
        imageIds: ['img-kit-1'],
        reutilizadas: 0,
        enviadas: 1,
        falhas: [],
        consideradas: fotos.length,
        descartadasPeloLimite: 0,
      });
    },
    resumo: () => ({
      consideradas: 1,
      reutilizadas: 0,
      enviadas: 1,
      falhas: 0,
      descartadasPeloLimite: 0,
    }),
  };
}

function deps(db: FakeDb, loja: Loja, nowMs = AGORA): KitDeps {
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
    nowMs,
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
    resolvedorDeImagens: resolvedorFake(loja),
    increment,
  };
}

function depsDaImportacao(db: FakeDb, nowMs = AGORA + 1_000): ImportarKitShopeeDeps {
  return {
    db: asDb(db),
    increment,
    integracaoId: INTEGRACAO,
    tabelaNormalOuterRef: 'documents/listaDePrecos/tab-normal',
    tabelaPromocionalOuterRef: null,
    depositoOuterRef: 'documents/depositos/dep-1',
    options: importacaoShopeeOptionsSchema.parse({ importarFotos: false }),
    nowMs,
  };
}

function entrada(over: Partial<EntradaDePublicacaoShopee> = {}): EntradaDePublicacaoShopee {
  return {
    produtoId: K,
    linkDocId: null,
    categoryId: null,
    statusPedido: 'NORMAL',
    principal: 'comp-a-filho',
    recriar: false,
    converterEmKit: false,
    ...over,
  };
}

const publicar = (
  db: FakeDb,
  loja: Loja,
  over: Partial<EntradaDePublicacaoShopee> = {},
): Promise<ResultadoPublicacaoShopee | null> => publicarShopee(deps(db, loja), entrada(over));

/** The KIT result of a publish, asserting the dispatcher routed it to a kit arm. */
async function kit(p: Promise<ResultadoPublicacaoShopee | null>): Promise<ResultadoPublicacaoKit> {
  const r = await p;
  if (r === null || r.tipo !== 'kit')
    throw new Error(`esperava um braço de kit, veio ${JSON.stringify(r?.tipo ?? null)}`);
  return r.resultado;
}

/** Step 9's REAL single-item import of a kit. */
async function importar(db: FakeDb, loja: Loja, itemId: number) {
  return await importarKitShopee(depsDaImportacao(db), await lerAnuncioShopee(loja.client, itemId));
}

/**
 * Re-run EXACTLY the command a 202 printed (S1F-03): its flags become the
 * entrada, nothing else.
 */
function entradaDoComando(comando: string): EntradaDePublicacaoShopee {
  const partes = comando.split(' ');
  expect(partes[0]).toBe('publicar:anuncio');
  const valor = (flag: string): string | null => {
    const i = partes.indexOf(flag);
    return i < 0 ? null : (partes[i + 1] ?? null);
  };
  expect(valor('--integracao')).toBe(INTEGRACAO);
  return {
    produtoId: valor('--produto') ?? '',
    linkDocId: valor('--link'),
    categoryId: null,
    statusPedido: 'NORMAL',
    principal: valor('--principal'),
    recriar: partes.includes('--recriar'),
    converterEmKit: partes.includes('--converter-em-kit'),
  };
}

/* ------------------------------- db readers --------------------------------- */

function doc(db: FakeDb, caminho: string): Json | undefined {
  return db.store[caminho]?.data as Json | undefined;
}

function vinculo(db: FakeDb, linkDocId: string): Json | undefined {
  return doc(db, `produtos/${K}/prodshopee/${linkDocId}`);
}

function vinculosDeK(db: FakeDb): string[] {
  return db.idsEm(`produtos/${K}/prodshopee`).sort();
}

function produtos(db: FakeDb): string[] {
  return Object.keys(db.store)
    .filter((p) => /^produtos\/[^/]+$/.test(p))
    .sort();
}

function quantas(loja: Loja, op: string, desde = 0): number {
  return loja.ops.slice(desde).filter((o) => o === op).length;
}

function escritasNaLoja(loja: Loja, desde = 0): string[] {
  return loja.ops
    .slice(desde)
    .filter((o) => o === 'add_kit_item' || o === 'update_kit_item' || o === 'delete_item');
}

async function recusaDe(p: Promise<unknown>): Promise<ShopeePublishBlockedError> {
  const erro = await p.then(
    () => {
      throw new Error('deveria ter recusado');
    },
    (e: unknown) => e,
  );
  expect(erro).toBeInstanceOf(ShopeePublishBlockedError);
  return erro as ShopeePublishBlockedError;
}

async function falhaDe(p: Promise<unknown>): Promise<unknown> {
  return await p.then(
    () => {
      throw new Error('deveria ter falhado');
    },
    (e: unknown) => e,
  );
}

const motivos = (e: ShopeePublishBlockedError): string[] => e.problemas.map((p) => p.motivo);

beforeEach(() => {
  limparTaxonomiaShopee();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  limparTaxonomiaShopee();
  vi.restoreAllMocks();
});

/* ========================================================================== */
/*  the entry point                                                            */
/* ========================================================================== */

describe('publicarShopee — a entrada', () => {
  it('um produto que não existe ⇒ null (o 404), sem uma chamada à Shopee', async () => {
    const loja = novaLoja();
    expect(await publicar(new FakeDb(), loja, { produtoId: 'nao-existe' })).toBeNull();
    expect(
      await escolherArmaShopee(deps(new FakeDb(), loja), entrada({ produtoId: 'x' })),
    ).toBeNull();
    expect(loja.ops).toEqual([]);
  });

  it('uma recusa do despacho é LANÇADA como ShopeePublishBlockedError — zero chamadas, zero escritas', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${K}`, {
      nome: 'Kit',
      sku: SKU,
      paiId: null,
      ehKit: false,
      ehKitVirtual: true,
    });
    const loja = novaLoja();

    const erro = await recusaDe(publicar(db, loja));

    expect(motivos(erro)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.kitVirtualSemKit]);
    expect(erro.produtoId).toBe(K);
    expect(loja.ops).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('o dry run (ensaiarPublicacaoShopee) de um kit-criar lê e planeja — nunca add_kit_item, nenhuma escrita', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const loja = novaLoja();

    const ensaio = await ensaiarPublicacaoShopee(deps(db, loja), entrada(), resolvedorFake(loja));

    expect(ensaio?.tipo).toBe('kit');
    if (ensaio?.tipo !== 'kit') return;
    expect(ensaio.arma).toEqual({ arma: 'kit-criar' });
    expect(ensaio.ensaio.plano.kitNovo).toEqual({ acao: 'criar' });
    expect(loja.ops).not.toContain('add_kit_item');
    expect(db.writes).toEqual([]);
  });
});

/* ========================================================================== */
/*  RT11 — L6 refusal → import → publish                                       */
/* ========================================================================== */

describe('RT11 — recusa L6 → importação → publicação, pelo despacho', () => {
  /**
   * A kit with K's SKU made in Seller Centre: the SAME shop, created by a run
   * whose ERP is another database — so Shopee holds it and this ERP links nothing.
   */
  async function kitDoSellerCentre(loja: Loja, sku = SKU): Promise<void> {
    const outro = new FakeDb();
    semearComponentes(outro);
    semearFamilia(outro);
    const r = await kit(publicar(outro, loja));
    expect(r).toMatchObject({ desfecho: 'criado', itemId: KIT_1 });
    const item = loja.itens.get(KIT_1);
    if (item === undefined || item.kit === undefined) throw new Error('fixture: kit sumiu');
    item.base = { ...item.base, item_sku: sku };
    item.kit = { ...item.kit, item_sku: sku };
  }

  for (const sku of [SKU, `${SKU} `]) {
    it(`SKU ${JSON.stringify(sku)}: kit-ja-existe-na-shopee ⇒ importarKitShopee cai em K ⇒ o despacho sobre os docs GRAVADOS diz kit-atualizar ⇒ publicarShopee o EXECUTA`, async () => {
      const loja = novaLoja();
      await kitDoSellerCentre(loja, sku);
      const db = new FakeDb();
      semearComponentes(db);
      semearFamilia(db);
      const produtosAntes = produtos(db);
      const desde = loja.ops.length;

      // (1) the create arm's L6 scan refuses, naming the kit — "importe-o".
      const erro = await recusaDe(publicar(db, loja));
      expect(motivos(erro)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.kitJaExisteNaShopee]);
      expect(erro.problemas[0]?.mensagem).toContain(`item ${String(KIT_1)}`);
      expect(erro.problemas[0]?.mensagem).toContain('importe-o');
      expect(quantas(loja, 'add_kit_item', desde)).toBe(0);
      expect(db.writes).toEqual([]);

      // (2) step 9's REAL import links it onto K — no new produto, ONE link.
      await importar(db, loja, KIT_1);
      expect(produtos(db)).toEqual(produtosAntes);
      expect(vinculosDeK(db)).toEqual([VINCULO_1]);

      // (3) the dispatcher over the WRITTEN docs: kit-atualizar on that link.
      expect(await escolherArmaShopee(deps(db, loja), entrada())).toEqual({
        ok: true,
        arma: { arma: 'kit-atualizar', linkDocId: VINCULO_1 },
      });

      // (4) …and the entry EXECUTES it: one update_kit_item on the kit, no create.
      const desde2 = loja.ops.length;
      const r = await kit(publicar(db, loja));
      expect(r).toMatchObject({
        arma: 'kit-atualizar',
        desfecho: 'atualizado',
        itemId: KIT_1,
        linkDocId: VINCULO_1,
        modelos: { anexados: 0 },
      });
      expect(loja.chamadas.slice(desde2).filter((c) => c.op === 'update_kit_item')).toEqual([
        { op: 'update_kit_item', ids: [KIT_1] },
      ]);
      expect(quantas(loja, 'add_kit_item')).toBe(1);
      expect(produtos(db)).toEqual(produtosAntes);
      expect(vinculosDeK(db)).toEqual([VINCULO_1]);
    });
  }
});

/* ========================================================================== */
/*  RT12 — incerto → refusal → MASS import → next publish                      */
/* ========================================================================== */

describe('RT12 — `incerto` → recusa → importação EM MASSA → a próxima publicação', () => {
  it('o 202 sem escrita ⇒ o mesmo comando recusa "importe-o" ⇒ o job alcança o kit não vinculado e grava o vínculo no id derivado ⇒ kit-atualizar EXECUTADO; UM add_kit_item, UM prodshopee', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const loja = novaLoja();
    loja.falhaAposCriar = muitasConexoes();

    // (1) incerto: Shopee DID create, the answer was a transient — nothing written.
    const incerto = await kit(publicar(db, loja));
    expect(incerto).toMatchObject({
      arma: 'kit-criar',
      desfecho: 'incerto',
      itemId: null,
      linkDocId: null,
      recusa: { codigo: 'product.error_busi' },
    });
    expect(incerto.comando).not.toBeNull();
    expect(db.writes).toEqual([]);

    // (2) the re-run is still kit-criar (no link) — its scan refuses "importe-o".
    expect(await escolherArmaShopee(deps(db, loja), entrada())).toEqual({
      ok: true,
      arma: { arma: 'kit-criar' },
    });
    const erro = await recusaDe(
      publicarShopee(deps(db, loja), entradaDoComando(incerto.comando ?? '')),
    );
    expect(motivos(erro)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.kitJaExisteNaShopee]);

    // (3) the MASS import: the kit is not linked, so the job imports it.
    const options = importacaoShopeeOptionsSchema.parse({ importarFotos: false });
    const jobId = await iniciarImportacaoShopee(asDb(db), {
      integracaoId: INTEGRACAO,
      options,
      now: AGORA,
    });
    const despacho = await processarImportacaoShopee(
      {
        db: asDb(db),
        resolverContexto: () =>
          Promise.resolve({
            client: loja.client,
            integracaoId: INTEGRACAO,
            tabelaNormalOuterRef: 'documents/listaDePrecos/tab-normal',
            tabelaPromocionalOuterRef: null,
            depositoOuterRef: 'documents/depositos/dep-1',
          }),
        importarAnuncio: () => {
          throw new Error('fixture: nenhum anúncio comum deveria ser importado');
        },
        importarKit: importarKitShopee,
        increment,
        scheduler: { enqueue: () => Promise.resolve() },
        now: () => AGORA + 2_000,
      },
      { jobId, integracaoId: INTEGRACAO },
      0,
    );
    expect(despacho).toBe('done');
    expect(vinculosDeK(db)).toEqual([VINCULO_1]);
    expect(vinculo(db, VINCULO_1)).toMatchObject({ item_id: KIT_1, kitNativo: true });

    // (4) the next publish: kit-atualizar on the imported link, EXECUTED.
    const r = await kit(publicar(db, loja));
    expect(r).toMatchObject({
      arma: 'kit-atualizar',
      desfecho: 'atualizado',
      linkDocId: VINCULO_1,
    });
    expect(quantas(loja, 'add_kit_item')).toBe(1);
    expect(vinculosDeK(db)).toEqual([VINCULO_1]);
  });
});

/* ========================================================================== */
/*  RT13 — recriar crash resume, PR 7 half                                     */
/* ========================================================================== */

describe('RT13 (metade do PR 7) — a retomada da recriação pelo despacho', () => {
  it('R2 ⇒ publicar sem --link: vinculos-ambiguos nomeando os DOIS, com a dica; o MESMO --link antigo --recriar ⇒ retomado, UM delete; publicar ⇒ kit-atualizar no NOVO; o mesmo comando de novo ⇒ zero escrita; --recriar sem --link ⇒ 400', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const loja = novaLoja();
    const criado = await kit(publicar(db, loja));
    expect(criado).toMatchObject({ arma: 'kit-criar', desfecho: 'criado', linkDocId: VINCULO_1 });
    editarVerde(db, 3);

    // The recriar crashes right before its delete: R2 (both kits linked, live).
    loja.exclusao = 'quebra';
    expect(
      await falhaDe(publicar(db, loja, { linkDocId: VINCULO_1, recriar: true })),
    ).toBeInstanceOf(TypeError);

    // A plain publish refuses, naming BOTH, with the interrupted-recriar hint — zero calls.
    const desde = loja.ops.length;
    const ambiguos = await recusaDe(publicar(db, loja));
    expect(motivos(ambiguos)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.vinculosAmbiguos]);
    const frase = ambiguos.problemas[0]?.mensagem ?? '';
    expect(frase).toContain(`${VINCULO_1} (item ${String(KIT_1)})`);
    expect(frase).toContain(`${VINCULO_2} (item ${String(KIT_2)})`);
    expect(frase).toContain('--link <kit antigo> --recriar');
    expect(loja.ops.length).toBe(desde);

    // The SAME command resumes: zero add_kit_item, ONE delete of the old kit.
    const r = await kit(publicar(db, loja, { linkDocId: VINCULO_1, recriar: true }));
    expect(r).toMatchObject({
      arma: 'kit-recriar',
      desfecho: 'retomado',
      itemId: KIT_2,
      linkDocId: VINCULO_2,
      antecessor: { itemId: KIT_1, excluido: true },
    });
    expect(quantas(loja, 'add_kit_item', desde)).toBe(0);
    expect(loja.chamadas.slice(desde).filter((c) => c.op === 'delete_item')).toEqual([
      { op: 'delete_item', ids: [KIT_1] },
    ]);
    expect(vinculo(db, VINCULO_1)?.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.removido);

    // A plain publish now republishes the NEW kit.
    const desde2 = loja.ops.length;
    const atual = await kit(publicar(db, loja));
    expect(atual).toMatchObject({ arma: 'kit-atualizar', itemId: KIT_2, linkDocId: VINCULO_2 });
    expect(loja.chamadas.slice(desde2).filter((c) => c.op === 'update_kit_item')).toEqual([
      { op: 'update_kit_item', ids: [KIT_2] },
    ]);

    // The SAME recriar command again: retomado, ZERO Shopee writes (R4).
    const desde3 = loja.ops.length;
    const deNovo = await kit(publicar(db, loja, { linkDocId: VINCULO_1, recriar: true }));
    expect(deNovo.desfecho).toBe('retomado');
    expect(escritasNaLoja(loja, desde3)).toEqual([]);

    // `--recriar` with no `--link` never reaches the dispatcher: the body reader's 400.
    expect(lerCorpoPublicar({ integracaoId: INTEGRACAO, produtoId: K, recriar: true })).toEqual({
      ok: false,
      erro: MSG_RECRIAR_SEM_LINK,
    });
  });
});

/* ========================================================================== */
/*  RT14 — converter crash resume, PR 7 half                                   */
/* ========================================================================== */

describe('RT14 (metade do PR 7) — a retomada do converter pelo despacho', () => {
  it('V2 ⇒ publicar ⇒ kit-atualizar no NOVO (regra 3 antes da 4); --converter-em-kit ⇒ zero add_kit_item, comum SUBSTITUÍDO; de novo ⇒ ja-e-kit-nativo; --link comum ⇒ vinculo-substituido; NENHUMA escrita carrega o item comum', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db, { ehKitVirtual: null });
    semearAnuncioComum(db);
    const loja = novaLoja();
    loja.itens.set(ITEM_COMUM, itemComum());

    // The converter dies right after its link write: V2.
    loja.falhaNaLeitura = {
      itemId: KIT_1,
      erro: new TypeError('fixture: o processo caiu depois do vínculo novo'),
      depois: 0,
    };
    expect(await falhaDe(publicar(db, loja, { converterEmKit: true }))).toBeInstanceOf(TypeError);
    expect(vinculo(db, VINCULO_1)).toMatchObject({ kitNativo: true, item_id: KIT_1 });
    expect(vinculo(db, VINCULO_COMUM)?.substituidoPorLinkDocId ?? null).toBeNull();

    // A plain publish: the native kit wins (rule 3) — never the ordinary listing.
    const atual = await kit(publicar(db, loja));
    expect(atual).toMatchObject({ arma: 'kit-atualizar', itemId: KIT_1, linkDocId: VINCULO_1 });

    // The converter again: completes the linked kit, supersedes the ordinary link.
    const desde = loja.ops.length;
    const convertido = await kit(publicar(db, loja, { converterEmKit: true }));
    expect(convertido).toMatchObject({
      arma: 'kit-converter',
      desfecho: 'retomado',
      itemId: KIT_1,
      antecessor: { itemId: ITEM_COMUM, substituido: true },
    });
    expect(quantas(loja, 'add_kit_item', desde)).toBe(0);
    expect(vinculo(db, VINCULO_COMUM)?.substituidoPorLinkDocId).toBe(VINCULO_1);

    // Again: the finished conversion — ja-e-kit-nativo, zero Shopee calls.
    const desde2 = loja.ops.length;
    const ja = await recusaDe(publicar(db, loja, { converterEmKit: true }));
    expect(motivos(ja)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.jaEKitNativo]);
    expect(ja.problemas[0]?.mensagem).toContain(VINCULO_1);
    // Naming the ordinary listing: it is superseded — publish no longer targets it.
    const nomeado = await recusaDe(publicar(db, loja, { linkDocId: VINCULO_COMUM }));
    expect(motivos(nomeado)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.vinculoSubstituido]);
    expect(loja.ops.length).toBe(desde2);

    // L8 / lens 6: not ONE Shopee write ever carried the ordinary listing's id.
    const escritasDoComum = loja.chamadas.filter(
      (c) =>
        ['add_kit_item', 'update_kit_item', 'delete_item'].includes(c.op) &&
        c.ids.includes(ITEM_COMUM),
    );
    expect(escritasDoComum).toEqual([]);
  });
});

/* ========================================================================== */
/*  RT15 — the accepted double create (R-w)                                     */
/* ========================================================================== */

describe('RT15 — a criação dupla ACEITA (R-w, registro 303)', () => {
  it('duas execuções kit-criar SIMULTÂNEAS (as duas buscas vazias) criam e vinculam DOIS kits ⇒ publicar ⇒ vinculos-ambiguos com os DOIS item ids, zero chamadas; o passo 12 pula o estoque dos dois', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const loja = novaLoja();
    // Neither add_kit_item proceeds until both runs reached it: both scans ran
    // before any kit existed, both link reads saw nothing — the real race.
    loja.portao = { esperados: 2, chegaram: 0, liberar: [] };

    const [a, b] = await Promise.all([kit(publicar(db, loja)), kit(publicar(db, loja))]);

    expect([a.desfecho, b.desfecho]).toEqual(['criado', 'criado']);
    expect([a.itemId, b.itemId].sort()).toEqual([KIT_1, KIT_2]);
    expect(quantas(loja, 'add_kit_item')).toBe(2);
    expect(vinculosDeK(db)).toEqual([VINCULO_1, VINCULO_2].sort());

    const desde = loja.ops.length;
    const erro = await recusaDe(publicar(db, loja));
    expect(motivos(erro)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.vinculosAmbiguos]);
    expect(erro.problemas[0]?.mensagem).toContain(`item ${String(KIT_1)}`);
    expect(erro.problemas[0]?.mensagem).toContain(`item ${String(KIT_2)}`);
    expect(loja.ops.length).toBe(desde);

    // Nothing oversells: step 12 skips both (Shopee derives a kit's stock).
    // (The step-13 half — a price planned and sent for both, and the survivor-only
    // plan once the twin is deleted — is PR 8's: precos/enviarPrecoKit.test.ts, RT15.)
    for (const linkDocId of [VINCULO_1, VINCULO_2]) {
      expect(
        podeEnviarEstoqueShopee(vinculo(db, linkDocId) ?? {}, doc(db, `produtos/${K}`) ?? {}, {
          nowMs: AGORA,
        }),
        linkDocId,
      ).toEqual({ enviar: false, motivo: MOTIVO_ESTOQUE_SHOPEE.kitDerivado });
    }
  });

  it('(L10(4)) UM vinculado e um gêmeo NÃO vinculado ⇒ publicar = kit-atualizar com ZERO get_item_list e nenhum aviso do gêmeo; o próximo braço de CRIAÇÃO (--link vinculado --recriar) recusa nomeando o gêmeo; --converter-em-kit ⇒ ja-e-kit-nativo, zero chamadas', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const loja = novaLoja();
    loja.portao = { esperados: 2, chegaram: 0, liberar: [] };
    // Whichever run gets the SECOND kit dies before its link write.
    loja.falhaAposCriarPorItem.set(
      KIT_2,
      new TypeError('fixture: o processo caiu antes do vínculo'),
    );

    const [a, b] = await Promise.allSettled([publicar(db, loja), publicar(db, loja)]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(vinculosDeK(db)).toEqual([VINCULO_1]);
    expect(loja.itens.get(KIT_2)?.base.item_status).toBe('NORMAL');

    // A plain publish republishes the linked kit — and never scans.
    const desde = loja.ops.length;
    const atual = await kit(publicar(db, loja));
    expect(atual).toMatchObject({ arma: 'kit-atualizar', itemId: KIT_1 });
    expect(quantas(loja, 'get_item_list', desde)).toBe(0);
    expect(atual.avisos.map((x) => x.mensagem).join(' ')).not.toContain(String(KIT_2));

    // The next CREATE-arm run scans and names the twin.
    const desde2 = loja.ops.length;
    const erro = await recusaDe(publicar(db, loja, { linkDocId: VINCULO_1, recriar: true }));
    expect(motivos(erro)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.kitJaExisteNaShopee]);
    expect(erro.problemas[0]?.mensagem).toContain(`item ${String(KIT_2)}`);
    expect(quantas(loja, 'add_kit_item', desde2)).toBe(0);
    expect(quantas(loja, 'delete_item', desde2)).toBe(0);

    // A converter with no live ordinary listing never scans.
    const desde3 = loja.ops.length;
    const ja = await recusaDe(publicar(db, loja, { converterEmKit: true }));
    expect(motivos(ja)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.jaEKitNativo]);
    expect(loja.ops.length).toBe(desde3);
  });

  it('(L10-R2) em voo: o `incerto` deixa o kit sem vínculo ⇒ o `comando` EXATO do 202 busca e recusa nomeando-o; depois que outra execução vinculou um kit, o MESMO comando é kit-atualizar com zero get_item_list', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const loja = novaLoja();
    loja.falhaAposCriar = muitasConexoes();

    const incerto = await kit(publicar(db, loja));
    expect(incerto.desfecho).toBe('incerto');
    const comando = incerto.comando ?? '';

    const erro = await recusaDe(publicarShopee(deps(db, loja), entradaDoComando(comando)));
    expect(motivos(erro)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.kitJaExisteNaShopee]);
    expect(erro.problemas[0]?.mensagem).toContain(`item ${String(KIT_1)}`);

    // Another run links a kit (here: step 9's import of that very kit).
    await importar(db, loja, KIT_1);
    const desde = loja.ops.length;
    const r = await kit(publicarShopee(deps(db, loja), entradaDoComando(comando)));
    expect(r).toMatchObject({ arma: 'kit-atualizar', linkDocId: VINCULO_1 });
    expect(quantas(loja, 'get_item_list', desde)).toBe(0);
    expect(quantas(loja, 'add_kit_item')).toBe(1);
  });
});

/* ========================================================================== */
/*  M176 — the incerto command is arm-specific                                 */
/* ========================================================================== */

describe('(M176) o `comando` do `incerto` é o do BRAÇO', () => {
  it('criar: nem --recriar nem --converter-em-kit nem --link — com o --principal enviado', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const loja = novaLoja();
    loja.falhaAposCriar = muitasConexoes();

    const r = await kit(publicar(db, loja));

    expect(r.desfecho).toBe('incerto');
    expect(r.comando).toBe(
      `publicar:anuncio --integracao ${INTEGRACAO} --produto ${K} --principal comp-a-filho`,
    );
  });

  it('recriar: carrega `--link <alvo> --recriar`', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const loja = novaLoja();
    await kit(publicar(db, loja));
    editarVerde(db, 3);
    loja.falhaAposCriar = muitasConexoes();

    const r = await kit(publicar(db, loja, { linkDocId: VINCULO_1, recriar: true }));

    expect(r).toMatchObject({ arma: 'kit-recriar', desfecho: 'incerto' });
    expect(r.comando).toContain(`--link ${VINCULO_1} --recriar`);
    expect(r.comando).not.toContain('--converter-em-kit');
    // Re-run literally: the SAME arm, never a plain publish (kit-atualizar on the old kit).
    expect(entradaDoComando(r.comando ?? '')).toMatchObject({
      linkDocId: VINCULO_1,
      recriar: true,
    });
  });

  it('converter: carrega `--converter-em-kit` (e o antecessor), nunca --recriar', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db, { ehKitVirtual: null });
    semearAnuncioComum(db);
    const loja = novaLoja();
    loja.itens.set(ITEM_COMUM, itemComum());
    loja.falhaAposCriar = muitasConexoes();

    const r = await kit(publicar(db, loja, { converterEmKit: true }));

    expect(r).toMatchObject({ arma: 'kit-converter', desfecho: 'incerto' });
    expect(r.comando).toContain('--converter-em-kit');
    expect(r.comando).not.toContain('--recriar');
    expect(entradaDoComando(r.comando ?? '')).toMatchObject({
      converterEmKit: true,
      recriar: false,
    });
  });
});

/* ========================================================================== */
/*  M186 — the dry run and the live run address ONE listing                    */
/* ========================================================================== */

describe('(M186, L10-R1) o dry run e a publicação de verdade endereçam o MESMO anúncio', () => {
  const ITEM_REMOVIDO = 2500139874;

  /** `removidoEhNativo`: a kit produto beside its removed native kit; else a NON-kit produto. */
  function semearProdutoComVinculos(db: FakeDb, removidoEhNativo: boolean): void {
    db.seed(`produtos/${K}`, {
      nome: 'Kit',
      sku: SKU,
      paiId: null,
      ehKit: removidoEhNativo,
      ehKitVirtual: false,
    });
    db.seed(`produtos/${K}/prodshopee/a-removido`, {
      contaProdutoShopeeOuterRef: REF_CONTA,
      item_id: ITEM_REMOVIDO,
      kitNativo: removidoEhNativo,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
    });
    db.seed(`produtos/${K}/prodshopee/b-comum`, {
      contaProdutoShopeeOuterRef: REF_CONTA,
      item_id: ITEM_COMUM,
      kitNativo: false,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });
  }

  /** The id each half HANDED step 11 — observed at the seam, the halves stubbed once. */
  async function idsEntregues(db: FakeDb): Promise<{ ensaio: unknown; publicacao: unknown }> {
    const loja = novaLoja();
    const preparar = vi.mocked(prepararPublicacao);
    const publicarItem = vi.mocked(publicarAnuncioShopee);
    preparar.mockClear();
    publicarItem.mockClear();
    preparar.mockResolvedValueOnce({ linkDocId: 'stub' } as unknown as Awaited<
      ReturnType<typeof prepararPublicacao>
    >);
    publicarItem.mockResolvedValueOnce({ linkDocId: 'stub' } as unknown as Awaited<
      ReturnType<typeof publicarAnuncioShopee>
    >);

    const ensaio = await ensaiarPublicacaoShopee(
      deps(db, loja),
      entrada({ principal: null }),
      resolvedorFake(loja),
    );
    expect(ensaio?.tipo).toBe('item');
    const vivo = await publicar(db, loja, { principal: null });
    expect(vivo?.tipo).toBe('item');
    expect(loja.ops).toEqual([]);
    return {
      ensaio: preparar.mock.calls[0]?.[1].linkDocId,
      publicacao: publicarItem.mock.calls[0]?.[1].linkDocId,
    };
  }

  it('um kit NATIVO removido que ordena primeiro + um comum vivo ⇒ os DOIS no comum vivo — o null cru planejaria o kit removido', async () => {
    const db = new FakeDb();
    semearProdutoComVinculos(db, true);

    expect(await idsEntregues(db)).toEqual({ ensaio: 'b-comum', publicacao: 'b-comum' });
    // What handing step 11 the raw `null` would have planned: its lexical resolver
    // picks the removed native kit (M186's mutant).
    expect((await resolverLinkPorProduto(asDb(db), INTEGRACAO, K, null))?.linkDocId).toBe(
      'a-removido',
    );
  });

  it('⛔ quase-par: num produto NÃO-kit, um comum REMOVIDO que ordena primeiro ⇒ os DOIS no removido, exatamente como na main', async () => {
    const db = new FakeDb();
    semearProdutoComVinculos(db, false);

    expect(await idsEntregues(db)).toEqual({ ensaio: 'a-removido', publicacao: 'a-removido' });
    expect((await resolverLinkPorProduto(asDb(db), INTEGRACAO, K, null))?.linkDocId).toBe(
      'a-removido',
    );
  });
});
