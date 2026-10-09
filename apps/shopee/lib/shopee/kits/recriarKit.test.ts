/**
 * `recriarKit` / `converterEmKit` (step 19, PR 6 — reconcile §2.7, §2.5.4)
 * end to end over `fakeDb` + a STATEFUL multi-kit shop double, driven through
 * `publicarKitShopee` with an EXPLICIT arm (the dispatcher is PR 7).
 *
 * Every state a re-run meets is reached by the REAL writers: the old kit is a
 * real `kit-criar`, a "crash" is a failure injected into the shop mid-run, an
 * uncertain create is the committed transient capture, and an import is step
 * 9's real `importarKitShopee`. No link or row is hand-built — except the one
 * ORDINARY listing the converter starts from, which is the legacy state L0
 * describes (an old-model kit published by step 11).
 *
 * The round trips (§4.2): RT5 (recipe edit → aviso → recriar → resolved, no
 * produto save between — the clock fix), RT6's PR 6 half (converter → the old
 * listing still gets stock, through the REAL re-verify and its per-listing
 * sync), RT13 / RT14's PR 6 halves (the crash resumes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ADD_KIT_ITEM_PATH,
  SHOPEE_DELETE_ITEM_PATH,
  SHOPEE_GET_KIT_ITEM_LIMIT_PATH,
  SHOPEE_GET_VARIATIONS_PATH,
  SHOPEE_LOGISTICS_FEE_TYPE,
  SHOPEE_SURFACE,
  ShopeeNetworkError,
  shopeeErrorFromEnvelope,
  shopeeItemBaseInfoPayloadSchema,
  shopeeItemListPayloadSchema,
  shopeeKitItemInfoPayloadSchema,
  shopeeLogisticsChannelSchema,
  shopeeModelListPayloadSchema,
  type ShopeeAddKitItemRequest,
  type ShopeeClient,
  type ShopeeItemViolationInfo,
} from '@delfrance/integrations-shopee';
import { reavaliarAvisoDeReceitaKit } from '@delfrance/data/admin/avisos';
import {
  ACAO_STATUS_ANUNCIO,
  ESTADO_ANUNCIO_SHOPEE,
  MOTIVO_RESOLUCAO_RECEITA_KIT,
  chaveAvisoReceitaKitShopee,
  chaveReceitaKitErp,
  ehKitNativoAtivo,
  importacaoShopeeOptionsSchema,
  podeMoverAnuncioShopee,
  toOuterRef,
  varianteFakePath,
} from '@delfrance/schemas';
import { avisoCollection, integracaoCollection } from '@delfrance/data/admin/collections';

import {
  MOTIVO_PUBLICACAO_BLOQUEADA,
  ShopeePublishBlockedError,
  ShopeePublishRejectedError,
} from '../anuncios/errosPublicacao';
import type { ResolvedorDeImagensShopee } from '../anuncios/fotosPublicacao';
import { resolverLinkVivoPorProduto } from '../anuncios/linkAnuncio';
import { reverificarAnuncioShopee } from '../anuncios/reverificarAnuncio';
import { agoraUsDe } from '../avisos/autorizacao';
import { MOTIVO_ESTOQUE_SHOPEE } from '../estoque/errosEstoque';
import {
  montarTarefasDeEstoqueShopee,
  type FilhoDaFamilia,
  type LinhaDeFamiliaShopee,
  type MembroDaFamilia,
} from '../estoque/planoEstoque';
import { podeEnviarEstoqueShopee } from '../estoque/podeEnviarEstoque';
import { lerFixture, FIXTURE_ADD_KIT_ITEM_SG_TOO_MANY_CONNECTIONS } from '../fixtures/wireCorpus';
import type { ImportarKitShopeeDeps } from '../produtos/itemLido';
import { importarKitShopee } from '../produtos/kitShopee';
import { lerAnuncioShopee } from '../produtos/lerAnuncio';
import { limparTaxonomiaShopee } from '../taxonomia/cache';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { idDaVariacaoDeKit, idDoVinculoDeKit } from './idsKit';
import type { ArmaDeKit, EntradaDeKit } from './prepararKit';
import { ensaiarKitShopee, publicarKitShopee } from './publicarKit';
import {
  avisoKitAlvoMaisNovo,
  avisoKitAntigoNaoExcluido,
  avisoKitNovoDivergente,
  avisoKitNovoInativo,
  divergenciaDoKitNovo,
  nadaARecriar,
  recriarKit,
} from './recriarKit';
import type { AvisoKit, KitDeps, ResultadoPublicacaoKit } from './resultadoKit';

/* -------------------------------------------------------------------------- */
/*  Fixtures — role ids only (s19-ctx). Never a real partner, shop or item.     */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

const INTEGRACAO = 'int-1';
const REF_CONTA = toOuterRef(integracaoCollection.docPath({}, INTEGRACAO));
const AGORA = 1_757_000_000_000;

/** The FIRST kit a shop creates (the old kit of a recriar; the converter's new kit). */
const KIT_1 = 2500139870;
/** The SECOND one (the recriar's new kit; the double-create twin). */
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

/** The model ids the shop hands each kit, in SENT order. */
const MODELOS_DE: Readonly<Record<number, readonly number[]>> = {
  [KIT_1]: [2000458820, 2000458823, 2000458822],
  [KIT_2]: [2000458824, 2000458825, 2000458826],
};
/** `create_time` (SECONDS) each kit reads back with — the second is NEWER. */
const CRIADO_EM: Readonly<Record<number, number>> = {
  [KIT_1]: 1791244800,
  [KIT_2]: 1791248400,
};

const K = 'kit-k';
const K_AZUL = 'kit-k-azul';
const K_VERDE = 'kit-k-verde';
const K_VERMELHO = 'kit-k-vermelho';
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

/**
 * K, a 2-child FAMILY on ONE axis (`Cor`): Azul = A + B, Verde = 2 × A.
 * `vermelho` adds a THIRD child (Vermelho = 2 × A) the old kit never carried.
 */
function semearFamilia(db: FakeDb, op: { readonly vermelho?: boolean } = {}): void {
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
      { id: 'var-vermelho', nome: 'Vermelho' },
    ],
  });
  semearFilho(db, K_AZUL, 'var-azul', 1, {
    'comp-a-filho': { quantidade: 1, limitarEstoque: true },
    'comp-b-membro': { quantidade: 1, limitarEstoque: true },
  });
  semearFilho(db, K_VERDE, 'var-verde', 2, {
    'comp-a-filho': { quantidade: 2, limitarEstoque: true },
  });
  if (op.vermelho === true) semearVermelho(db);
}

/** A THIRD child (Vermelho = 2 × A) no kit created before it carries. */
function semearVermelho(db: FakeDb): void {
  semearFilho(db, K_VERMELHO, 'var-vermelho', 3, {
    'comp-a-filho': { quantidade: 2, limitarEstoque: true },
  });
}

/** The child SKU per variante — step 9's child rung 2 binds a model by it. */
const SKU_DO_FILHO: Readonly<Record<string, string>> = {
  'var-azul': `${SKU}-AZ`,
  'var-verde': `${SKU}-VD`,
  'var-vermelho': `${SKU}-VM`,
};

function semearFilho(
  db: FakeDb,
  id: string,
  variante: string,
  ordem: number,
  componentesKit: Json,
): void {
  db.seed(`produtos/${id}`, {
    nome: `Kit ${variante}`,
    sku: SKU_DO_FILHO[variante] ?? null,
    paiId: K,
    ordem,
    ehKit: true,
    grupoDeVariacoesUid: [GRUPO],
    variacoesUid: [varianteFakePath(GRUPO, variante)],
    componentesKit,
  });
}

/** A produto SAVE of one field set (the trigger's input), keeping the rest. */
function salvar(db: FakeDb, produtoId: string, patch: Json): void {
  const atual = db.store[`produtos/${produtoId}`]?.data as Json;
  db.seed(`produtos/${produtoId}`, { ...atual, ...patch });
}

/** The ERP recipe edit every recriar here exists for: Verde 2 × A → `n` × A. */
function editarVerde(db: FakeDb, quantidade: number): void {
  salvar(db, K_VERDE, {
    componentesKit: { 'comp-a-filho': { quantidade, limitarEstoque: true } },
  });
}

/**
 * K's OLD-MODEL listing (L0): an ORDINARY `prodshopee` published by step 11,
 * and one `variashopee` per child pointing at it. The converter's starting state.
 */
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

/** The hidden default model id Shopee reads back for each PLAIN component (probe #1). */
const OCULTO: Readonly<Record<number, number>> = { [COMP_B_ITEM]: COMP_B_OCULTO };

interface ItemNaLoja {
  base: Json;
  kit?: Json;
  modelos?: Json;
}

/** One call to the shop, with every item id it CARRIED (M116's recorder). */
interface Chamada {
  readonly op: string;
  readonly ids: readonly number[];
}

interface Loja {
  readonly client: ShopeeClient;
  readonly ops: string[];
  readonly chamadas: Chamada[];
  readonly corposDoAdd: ShopeeAddKitItemRequest[];
  readonly itens: Map<number, ItemNaLoja>;
  /** `get_item_list`'s `tag` per item, when it differs from the base row's. */
  readonly tagNaLista: Map<number, Json | null>;
  /** The item ids the next creates mint, in order. */
  readonly proximos: number[];
  /** `add_kit_item` creates, THEN throws this (an uncertain create that did create). */
  falhaAposCriar: Error | null;
  /** `add_kit_item` throws this WITHOUT creating. */
  falhaSemCriar: Error | null;
  /**
   * A crash mid-run: the `get_item_base_info` carrying `itemId` throws `erro`,
   * after `depois` such calls went through (0 = the next one).
   */
  falhaNaLeitura: { readonly itemId: number; readonly erro: Error; depois: number } | null;
  /** What the next `delete_item` does. */
  exclusao: 'apaga' | 'recusa' | 'apaga-e-falha' | 'quebra';
  /** The `item_status` the NEXT created kit reads back with. */
  statusDoProximo: string;
  /** The `create_time` the NEXT created kit reads back with (`undefined` = the role's). */
  criadoDoProximo: number | null | undefined;
}

/** The transient `add_kit_item` refusal, from the COMMITTED probe capture (⇒ `incerto`). */
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

/** A KNOWN permanent kit refusal (⇒ `nao-criado`): this app may not create kits. */
function kitBloqueado(): Error {
  return shopeeErrorFromEnvelope(
    {
      error: 'product.error_busi_cannot_edit_vsku',
      message: null,
      request_id: null,
      warning: null,
    },
    { path: SHOPEE_ADD_KIT_ITEM_PATH, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

/** A documented `delete_item` refusal (a promotion lock). */
function exclusaoRecusada(): Error {
  return shopeeErrorFromEnvelope(
    {
      error: 'product.error_cannt_delete_in_promotion',
      message: null,
      request_id: null,
      warning: null,
    },
    { path: SHOPEE_DELETE_ITEM_PATH, httpStatus: 200, surface: SHOPEE_SURFACE.business },
  );
}

function naoServido(): Error {
  return shopeeErrorFromEnvelope(
    { error: 'error_not_found', message: null, request_id: null, warning: null },
    { path: SHOPEE_GET_KIT_ITEM_LIMIT_PATH, httpStatus: 404, surface: SHOPEE_SURFACE.business },
  );
}

/** The ordinary listing in the shop: NOT a kit, two models (its own SKU is K's). */
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
 * every plain component read back with its HIDDEN `component_model_id`, the
 * models in SENT tier order, listed by `get_item_list` from then on (deleted
 * kits never). `delete_item` folds the kit to `SELLER_DELETE`, which stays
 * readable (probe #1). Anything not arranged throws.
 */
function novaLoja(): Loja {
  const ops: string[] = [];
  const chamadas: Chamada[] = [];
  const corposDoAdd: ShopeeAddKitItemRequest[] = [];
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
    corposDoAdd,
    itens,
    tagNaLista: new Map(),
    proximos: [KIT_1, KIT_2],
    falhaAposCriar: null,
    falhaSemCriar: null,
    falhaNaLeitura: null,
    exclusao: 'apaga',
    statusDoProximo: 'NORMAL',
    criadoDoProximo: undefined,
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
    const criadoEm =
      loja.criadoDoProximo === undefined ? (CRIADO_EM[itemId] ?? null) : loja.criadoDoProximo;
    // OP-9: a create sent `unlisted: true` lists PAUSED (the doc's word, register 305).
    const status = s.unlisted === true ? 'UNLIST' : loja.statusDoProximo;
    loja.criadoDoProximo = undefined;
    loja.statusDoProximo = 'NORMAL';
    itens.set(itemId, {
      base: {
        item_id: itemId,
        item_name: s.item_name,
        item_sku: s.item_sku ?? null,
        item_status: status,
        has_model: true,
        tag: { kit: true },
        category_id: CATEGORIA,
        create_time: criadoEm,
      },
      kit: {
        item_id: itemId,
        item_name: s.item_name,
        item_sku: s.item_sku ?? null,
        item_status: status,
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
        .map((i) => {
          const itemId = i.base.item_id as number;
          return {
            item_id: itemId,
            item_status: i.base.item_status,
            tag: loja.tagNaLista.has(itemId) ? loja.tagNaLista.get(itemId) : i.base.tag,
          };
        });
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
    getItemViolationInfo: (p: { itemIds: readonly number[] }) => {
      anotar('get_item_violation_info', p.itemIds);
      return Promise.resolve({
        item_list: p.itemIds.map((id) => ({
          item_id: id,
          item_status: 'NORMAL',
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
      anotar('add_kit_item', []);
      corposDoAdd.push(corpo);
      if (loja.falhaSemCriar !== null) {
        const falha = loja.falhaSemCriar;
        loja.falhaSemCriar = null;
        return Promise.reject(falha);
      }
      const itemId = criar(corpo);
      if (loja.falhaAposCriar !== null) {
        const falha = loja.falhaAposCriar;
        loja.falhaAposCriar = null;
        return Promise.reject(falha);
      }
      return Promise.resolve({
        request_id: 'req-1',
        error: '',
        message: '',
        warning: '',
        response: { item_id: itemId },
      });
    },
    deleteItem: (corpo: { item_id: number }) => {
      anotar('delete_item', [corpo.item_id]);
      const modo = loja.exclusao;
      loja.exclusao = 'apaga';
      switch (modo) {
        case 'recusa':
          return Promise.reject(exclusaoRecusada());
        case 'quebra':
          // NOT a Shopee error: the run must crash (rule 6), leaving R2 behind.
          return Promise.reject(new TypeError('fixture: o processo caiu durante o delete_item'));
        case 'apaga-e-falha':
          apagar(corpo.item_id);
          return Promise.reject(new ShopeeNetworkError('fixture: timeout depois de apagar'));
        case 'apaga':
          apagar(corpo.item_id);
          return Promise.resolve({ request_id: 'req-3', error: '', message: '', warning: '' });
      }
    },
  };
  const client = new Proxy({} as Record<string, unknown>, {
    get(_alvo, prop) {
      // Not a thenable: the re-verify hands the client through a Promise.
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      const fn = conhecidas[prop];
      if (fn !== undefined) return fn;
      return () => {
        ops.push(`?${prop}`);
        throw new Error(`fixture: o kit chamou ${prop}, que esta loja não serve`);
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

function entrada(over: Partial<EntradaDeKit> = {}): EntradaDeKit {
  return { produtoId: K, statusPedido: 'NORMAL', principal: 'comp-a-filho', ...over };
}

async function publicar(
  db: FakeDb,
  loja: Loja,
  arma: ArmaDeKit,
  ent: Partial<EntradaDeKit> = {},
): Promise<ResultadoPublicacaoKit> {
  return await publicarKitShopee(deps(db, loja), entrada(ent), arma);
}

const criar = (db: FakeDb, loja: Loja, ent: Partial<EntradaDeKit> = {}) =>
  publicar(db, loja, { arma: 'kit-criar' }, ent);

const recriar = (db: FakeDb, loja: Loja, linkDocId: string, ent: Partial<EntradaDeKit> = {}) =>
  publicar(db, loja, { arma: 'kit-recriar', linkDocId }, ent);

const converter = (db: FakeDb, loja: Loja, ent: Partial<EntradaDeKit> = {}) =>
  publicar(db, loja, { arma: 'kit-converter', antecessorLinkDocId: VINCULO_COMUM }, ent);

/** Step 9's REAL single-item import of a kit. */
async function importar(db: FakeDb, loja: Loja, itemId: number) {
  const lido = await lerAnuncioShopee(loja.client, itemId);
  return await importarKitShopee(depsDaImportacao(db), lido);
}

/** The trigger's own decision (`apps/functions` calls exactly this) after a produto save. */
async function reavaliarComoOGatilho(db: FakeDb, nowMs = AGORA + 500): Promise<string> {
  return await reavaliarAvisoDeReceitaKit(
    asDb(db),
    { integracaoId: INTEGRACAO, kitProdutoId: K },
    MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
    { agoraUs: agoraUsDe({ nowMs }), increment },
  );
}

/* ------------------------------- db readers --------------------------------- */

function doc(db: FakeDb, caminho: string): Json | undefined {
  return db.store[caminho]?.data as Json | undefined;
}

function vinculo(db: FakeDb, linkDocId: string): Json | undefined {
  return doc(db, `produtos/${K}/prodshopee/${linkDocId}`);
}

function produtos(db: FakeDb): string[] {
  return Object.keys(db.store)
    .filter((p) => /^produtos\/[^/]+$/.test(p))
    .sort();
}

/** Every `variashopee` naming `linkDocId`, as `[child, model_id]`. */
function linhasDoVinculo(db: FakeDb, linkDocId: string): [string, unknown][] {
  return Object.entries(db.store)
    .filter(([p]) => /^produtos\/[^/]+\/variashopee\/[^/]+$/.test(p))
    .filter(([, d]) => {
      const ref = (d.data as Json).produtoShopeeOuterRef;
      return typeof ref === 'string' && ref.endsWith(`/prodshopee/${linkDocId}`);
    })
    .map(([p, d]): [string, unknown] => [p.split('/')[1]!, (d.data as Json).model_id])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** The `variashopee` docs naming `linkDocId`, whole — for a byte-unchanged check. */
function docsDasLinhas(db: FakeDb, linkDocId: string): Record<string, Json> {
  return Object.fromEntries(
    Object.entries(db.store)
      .filter(([p]) => /^produtos\/[^/]+\/variashopee\/[^/]+$/.test(p))
      .filter(([, d]) => {
        const ref = (d.data as Json).produtoShopeeOuterRef;
        return typeof ref === 'string' && ref.endsWith(`/prodshopee/${linkDocId}`);
      })
      .map(([p, d]) => [p, structuredClone(d.data as Json)]),
  );
}

function aviso(db: FakeDb): Json | undefined {
  return doc(db, avisoCollection.docPath({}, chaveAvisoReceitaKitShopee(INTEGRACAO, K)));
}

function avisoAberto(db: FakeDb): boolean {
  const a = aviso(db);
  return a !== undefined && a.resolvidoEm == null;
}

/** How many times `op` ran since `desde` (an index into `loja.ops`). */
function quantas(loja: Loja, op: string, desde = 0): number {
  return loja.ops.slice(desde).filter((o) => o === op).length;
}

/** The Shopee WRITES since `desde`. */
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
const codigos = (r: ResultadoPublicacaoKit): string[] => r.avisos.map((a) => a.codigo);

/** The usual start: K's family, created as KIT_1 (the old kit), then its Verde edited and the aviso opened. */
async function kitAntigoComReceitaEditada(
  db: FakeDb,
  loja: Loja,
  op: { readonly abrirAviso?: boolean } = {},
): Promise<void> {
  semearComponentes(db);
  semearFamilia(db);
  const r = await criar(db, loja);
  expect(r).toMatchObject({ desfecho: 'criado', itemId: KIT_1, linkDocId: VINCULO_1 });
  editarVerde(db, 3);
  if (op.abrirAviso !== false) {
    expect(await reavaliarComoOGatilho(db)).toBe('aberto');
    expect(avisoAberto(db)).toBe(true);
  }
}

/**
 * R2 (§2.5.4): the recriar created and LINKED the new kit, completed it (rows
 * written), and died right before its `delete_item` — the old kit still live,
 * not superseded. `exclusao: 'quebra'` is a NON-Shopee throw, so it propagates.
 */
async function recriacaoInterrompidaEmR2(
  db: FakeDb,
  loja: Loja,
  ent: Partial<EntradaDeKit> = {},
): Promise<void> {
  loja.exclusao = 'quebra';
  const erro = await falhaDe(recriar(db, loja, VINCULO_1, ent));
  expect(erro).toBeInstanceOf(TypeError);
  expect(ehKitNativoAtivo(vinculo(db, VINCULO_1) ?? {})).toBe(true);
  expect(ehKitNativoAtivo(vinculo(db, VINCULO_2) ?? {})).toBe(true);
  expect(linhasDoVinculo(db, VINCULO_2).length).toBeGreaterThan(0);
}

/**
 * R3 (§2.5.4): the recriar DELETED the old kit on Shopee and died before the
 * old-link write — a non-Shopee throw on its re-read of the OLD kit (the
 * second base read carrying it; the first is `prepararKit`'s target read).
 */
async function recriacaoInterrompidaEmR3(
  db: FakeDb,
  loja: Loja,
  ent: Partial<EntradaDeKit> = {},
): Promise<void> {
  loja.falhaNaLeitura = {
    itemId: KIT_1,
    erro: new TypeError('fixture: o processo caiu depois do delete_item'),
    depois: 1,
  };
  expect(await falhaDe(recriar(db, loja, VINCULO_1, ent))).toBeInstanceOf(TypeError);
  expect(loja.itens.get(KIT_1)?.base.item_status).toBe('SELLER_DELETE');
  expect(vinculo(db, VINCULO_1)?.estadoAnuncio).not.toBe(ESTADO_ANUNCIO_SHOPEE.removido);
  expect(ehKitNativoAtivo(vinculo(db, VINCULO_2) ?? {})).toBe(true);
}

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
/*  (1) recriar — the happy path and RT5                                       */
/* ========================================================================== */

describe('recriarKit — cria o NOVO primeiro, depois exclui o antigo (L4(4))', () => {
  it('recria: UM add_kit_item, o vínculo novo com linhas carimbadas, UM delete_item no antigo, o antigo `removido` com SELLER_DELETE', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_1);

    expect(r).toMatchObject({
      arma: 'kit-recriar',
      desfecho: 'criado',
      itemId: KIT_2,
      linkDocId: VINCULO_2,
      kitNativo: true,
      antecessor: { itemId: KIT_1, linkDocId: VINCULO_1, excluido: true, substituido: false },
      recusa: null,
      comando: null,
    });
    expect(escritasNaLoja(loja, desde)).toEqual(['add_kit_item', 'delete_item']);
    // (M114) the create came FIRST, the delete after it.
    expect(loja.ops.indexOf('add_kit_item', desde)).toBeLessThan(
      loja.ops.indexOf('delete_item', desde),
    );
    expect(loja.chamadas.filter((c) => c.op === 'delete_item').map((c) => c.ids)).toEqual([
      [KIT_1],
    ]);
    expect(vinculo(db, VINCULO_1)).toMatchObject({
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      item_status: 'SELLER_DELETE',
    });
    expect(ehKitNativoAtivo(vinculo(db, VINCULO_2) ?? {})).toBe(true);
    // The new kit carries the EDITED recipe and every row folded equal ⇒ stamped.
    const verdeNovo = linhasDoVinculo(db, VINCULO_2).find(([f]) => f === K_VERDE);
    expect(verdeNovo).toBeDefined();
    expect(
      doc(
        db,
        `produtos/${K_VERDE}/variashopee/${idDaVariacaoDeKit(VINCULO_2, verdeNovo?.[1] as number)}`,
      )?.receitaKitConferida,
    ).toBe(chaveReceitaKitErp({ 'comp-a-filho': { quantidade: 3 } }));
    // The OLD rows are left as they are (old orders still bind on them).
    expect(linhasDoVinculo(db, VINCULO_1)).toHaveLength(2);
  });

  it('RT5 — receita editada ⇒ aviso ABERTO pela decisão do gatilho ⇒ recriar ⇒ RESOLVIDO `kit-recriado`, sem salvar o produto no meio; reavaliar de novo mantém resolvido', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    const relogioDaAbertura = aviso(db)?.relogioEvento as number;
    const escritasEmProdutos = () =>
      db.writes.filter((w) => /^produtos\/[^/]+$/.test(w.path)).length;
    const produtosAntes = escritasEmProdutos();

    const r = await recriar(db, loja, VINCULO_1);

    // No produto SAVE between the raise and the close: the close's clock comes
    // from the links and rows the recriar wrote — a children-only clock would
    // tie the raise and `resolverAviso` drops an EQUAL clock.
    expect(escritasEmProdutos()).toBe(produtosAntes);
    expect(r.avisosResolvidos).toBe(1);
    expect(aviso(db)).toMatchObject({ resolucaoMotivo: MOTIVO_RESOLUCAO_RECEITA_KIT.kitRecriado });
    expect(avisoAberto(db)).toBe(false);
    expect(aviso(db)?.relogioEvento as number).toBeGreaterThan(relogioDaAbertura);

    expect(await reavaliarComoOGatilho(db, AGORA + 9_000)).toBe('resolvido');
    expect(avisoAberto(db)).toBe(false);
  });

  it('RT5 (variante dobra-de-volta) — a edição DESFEITA fecha o aviso `receita-igual-a-shopee`, sem recriar nada', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    const desde = loja.ops.length;

    editarVerde(db, 2);
    expect(await reavaliarComoOGatilho(db, AGORA + 700)).toBe('resolvido');

    expect(aviso(db)).toMatchObject({
      resolucaoMotivo: MOTIVO_RESOLUCAO_RECEITA_KIT.receitaIgualAShopee,
    });
    expect(loja.ops.slice(desde)).toEqual([]);
  });

  it('(M115) a busca EXCLUI o item do alvo: o kit antigo (mesmo SKU, vivo) não é um "já existe"', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    const desde = loja.chamadas.length;

    const r = await recriar(db, loja, VINCULO_1);

    expect(r.desfecho).toBe('criado');
    // The list SHOWED the old kit; nothing between the scan and the create
    // asked about it (its base row is never a scan candidate).
    const inicio = loja.chamadas.findIndex((c, i) => i >= desde && c.op === 'get_item_list');
    const fim = loja.chamadas.findIndex((c, i) => i > inicio && c.op === 'add_kit_item');
    expect(inicio).toBeGreaterThan(-1);
    expect(loja.chamadas.slice(inicio, fim).filter((c) => c.ids.includes(KIT_1))).toEqual([]);
  });

  it('(M114) um add_kit_item RECUSADO (nao-criado) ⇒ ZERO delete_item, o antigo intacto, nada gravado no vínculo antigo', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    const antigoAntes = structuredClone(vinculo(db, VINCULO_1));
    loja.falhaSemCriar = kitBloqueado();

    const erro = await falhaDe(recriar(db, loja, VINCULO_1));

    expect(erro).toBeInstanceOf(ShopeePublishRejectedError);
    expect(loja.ops).not.toContain('delete_item');
    expect(vinculo(db, VINCULO_1)).toEqual(antigoAntes);
    expect(vinculo(db, VINCULO_2)).toBeUndefined();
  });

  it('(M119) uma família de 2 itens SEM --principal ⇒ principal-obrigatorio, zero add_kit_item e zero delete_item', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    const desde = loja.ops.length;

    const erro = await recusaDe(recriar(db, loja, VINCULO_1, { principal: null }));

    expect(motivos(erro)).toContain(MOTIVO_PUBLICACAO_BLOQUEADA.principalObrigatorio);
    expect(escritasNaLoja(loja, desde)).toEqual([]);
  });
});

/* ========================================================================== */
/*  (2) step 0 — the safety net (M128, M173)                                   */
/* ========================================================================== */

describe('(M128) passo 0 — a rede de segurança `recriacao-sem-diferenca`', () => {
  it('um kit VIVO igual ao ERP (forma, receita, sem --principal, sem outro vínculo vivo) ⇒ recusa, ZERO escrita na Shopee — e a decisão do aviso ainda roda', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    // A stale aviso (a lost trigger run): opened by an edit, then the edit was
    // reverted with no decision after it.
    await kitAntigoComReceitaEditada(db, loja);
    editarVerde(db, 2);
    expect(avisoAberto(db)).toBe(true);
    const desde = loja.ops.length;

    const erro = await recusaDe(recriar(db, loja, VINCULO_1, { principal: null }));

    expect(motivos(erro)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.recriacaoSemDiferenca]);
    expect(erro.problemas[0]).toMatchObject({ campo: 'recriar' });
    expect(erro.problemas[0]?.mensagem).toContain(String(KIT_1));
    expect(escritasNaLoja(loja, desde)).toEqual([]);
    expect(loja.ops.slice(desde)).not.toContain('add_kit_item');
    expect(avisoAberto(db)).toBe(false);
  });

  it('o mesmo com --principal IGUAL ao principal vivo ⇒ recusa também', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja, { abrirAviso: false });
    editarVerde(db, 2);

    const erro = await recusaDe(recriar(db, loja, VINCULO_1, { principal: 'comp-a-filho' }));

    expect(motivos(erro)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.recriacaoSemDiferenca]);
  });

  it('⛔ quase-par — a quantidade de UM filho difere ⇒ PROSSEGUE (cria e exclui)', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja, { abrirAviso: false });

    const r = await recriar(db, loja, VINCULO_1);

    expect(r.desfecho).toBe('criado');
    expect(quantas(loja, 'delete_item')).toBe(1);
  });

  it('⛔ quase-par — um modelo VIVO sem filho no ERP ⇒ PROSSEGUE', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    semearComponentes(db);
    semearFamilia(db);
    await criar(db, loja);
    // The live kit gains a third model (Seller Centre) no ERP child carries.
    const kit = loja.itens.get(KIT_1)!;
    const terceiro = {
      model_id: 2000458822,
      model_sku: null,
      original_price: 99.9,
      tier_index: [2],
      component_list: [
        {
          component_item_id: COMP_A_ITEM,
          component_model_id: COMP_A_MODELO,
          quantity: 2,
          main_component: false,
        },
      ],
    };
    const tiers = kit.kit!.tier_variation_list as { option_list: Json[] }[];
    kit.kit = {
      ...kit.kit,
      model_list: [...(kit.kit!.model_list as Json[]), terceiro],
      tier_variation_list: [
        { ...tiers[0], option_list: [...tiers[0]!.option_list, { option: 'Vermelho' }] },
      ],
    };

    const r = await recriar(db, loja, VINCULO_1);

    expect(r.desfecho).toBe('criado');
  });

  it('⛔ quase-par — um filho do ERP sem modelo vivo ⇒ PROSSEGUE (o kit novo leva 3 modelos)', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    semearComponentes(db);
    semearFamilia(db);
    await criar(db, loja);
    semearVermelho(db);

    const r = await recriar(db, loja, VINCULO_1);

    expect(r.desfecho).toBe('criado');
    expect(r.modelos.vinculados).toBe(3);
  });

  it('⛔ quase-par — --principal nomeando OUTRO componente ⇒ PROSSEGUE (trocar o principal é recriar)', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    semearComponentes(db);
    semearFamilia(db);
    await criar(db, loja);

    const r = await recriar(db, loja, VINCULO_1, { principal: 'comp-b-membro' });

    expect(r.desfecho).toBe('criado');
    const principais = loja.corposDoAdd[1]?.item_setting.model_list.flatMap((m) =>
      m.component_list.filter((c) => c.main_component === true),
    );
    expect(principais?.map((c) => c.component_item_id)).toEqual([COMP_B_ITEM]);
  });

  it('⛔ quase-par — alvo SUBSTITUÍDO ⇒ a rede não roda, PROSSEGUE', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    semearComponentes(db);
    semearFamilia(db);
    await criar(db, loja);
    db.seed(`produtos/${K}/prodshopee/${VINCULO_1}`, {
      ...vinculo(db, VINCULO_1),
      substituidoPorLinkDocId: 'vinculo-que-nao-existe',
      substituidoEm: AGORA,
    });

    const r = await recriar(db, loja, VINCULO_1);

    expect(r.desfecho).toBe('criado');
  });

  it('(M123) ⛔ quase-par — alvo `removido` ⇒ a rede não roda, PROSSEGUE — e ZERO chamada carrega o item antigo (nem leitura, nem delete)', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    semearComponentes(db);
    semearFamilia(db);
    await criar(db, loja);
    // Deleted in Seller Centre and re-verified: the link says `removido`.
    const kit = loja.itens.get(KIT_1)!;
    kit.base = { ...kit.base, item_status: 'SELLER_DELETE' };
    salvarVinculo(db, VINCULO_1, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido });
    const desde = loja.chamadas.length;

    const r = await recriar(db, loja, VINCULO_1);

    expect(r).toMatchObject({
      desfecho: 'criado',
      itemId: KIT_2,
      antecessor: { itemId: KIT_1, excluido: true, substituido: false },
    });
    expect(loja.chamadas.slice(desde).filter((c) => c.ids.includes(KIT_1))).toEqual([]);
  });

  it('(M128 / V2R1-01) composição IGUAL + um GÊMEO de mesmo SKU não vinculado ⇒ `kit-ja-existe-na-shopee` nomeando o gêmeo, NUNCA `recriacao-sem-diferenca`', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    semearComponentes(db);
    semearFamilia(db);
    await criar(db, loja);
    // A double create's unlinked twin (R-w), same SKU, live.
    loja.itens.set(KIT_2, {
      base: {
        item_id: KIT_2,
        item_sku: SKU,
        item_status: 'NORMAL',
        has_model: true,
        tag: { kit: true },
        category_id: CATEGORIA,
      },
    });
    const desde = loja.ops.length;

    const erro = await recusaDe(recriar(db, loja, VINCULO_1, { principal: null }));

    expect(motivos(erro)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.kitJaExisteNaShopee]);
    expect(erro.problemas[0]?.mensagem).toContain(String(KIT_2));
    expect(escritasNaLoja(loja, desde)).toEqual([]);
  });

  it('(M128 / R4) o MESMO `--link antigo --recriar` depois de uma recriação terminada ⇒ 200 `retomado`, ZERO escrita na Shopee; `--link novo --recriar` igual ⇒ `recriacao-sem-diferenca`', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    await recriar(db, loja, VINCULO_1);
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_1);

    expect(r).toMatchObject({
      desfecho: 'retomado',
      itemId: KIT_2,
      linkDocId: VINCULO_2,
      antecessor: { itemId: KIT_1, excluido: true },
    });
    expect(escritasNaLoja(loja, desde)).toEqual([]);

    const erro = await recusaDe(recriar(db, loja, VINCULO_2));
    expect(motivos(erro)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.recriacaoSemDiferenca]);
    expect(escritasNaLoja(loja, desde)).toEqual([]);
  });

  it('(M173) passo 0 NÃO roda numa retomada: uma troca SÓ de principal, retomada SEM --principal com o kit novo vinculado ⇒ prossegue e exclui o antigo', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    semearComponentes(db);
    semearFamilia(db);
    await criar(db, loja);
    // A principal-only recriar (the recipes fold equal) interrupted at R2.
    await recriacaoInterrompidaEmR2(db, loja, { principal: 'comp-b-membro' });
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_1, { principal: null });

    expect(r).toMatchObject({ desfecho: 'retomado', antecessor: { excluido: true } });
    expect(quantas(loja, 'add_kit_item', desde)).toBe(0);
    expect(quantas(loja, 'delete_item', desde)).toBe(1);
  });

  it('(V2R3-01, a metade do prepararKit) numa RETOMADA o principal do CONTEXTO é o do kit COMPLETADO, nunca o do alvo: o ensaio de uma troca de principal interrompida em R2, SEM --principal, lê o P2 (B); ⛔ quase-par: sem kit vinculado (criar) ⇒ o --principal pedido', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    semearComponentes(db);
    semearFamilia(db);
    await criar(db, loja);
    await recriacaoInterrompidaEmR2(db, loja, { principal: 'comp-b-membro' });
    const escritas = db.writes.length;

    const ensaio = await ensaiarKitShopee(
      deps(db, loja),
      entrada({ principal: null }),
      { arma: 'kit-recriar', linkDocId: VINCULO_1 },
      resolvedorFake(loja),
    );

    expect(ensaio.plano.kitNovo).toEqual({
      acao: 'completar',
      linkDocId: VINCULO_2,
      itemId: KIT_2,
    });
    expect(ensaio.contexto.principal).toEqual({ itemId: COMP_B_ITEM, modelId: null });
    expect(ensaio.contexto.principalPedido).toBeNull();
    expect(db.writes.slice(escritas)).toEqual([]);

    // ⛔ the first recriar (nothing linked yet) holds the principal it was HANDED.
    const db2 = new FakeDb();
    const loja2 = novaLoja();
    await kitAntigoComReceitaEditada(db2, loja2, { abrirAviso: false });
    const criacao = await ensaiarKitShopee(
      deps(db2, loja2),
      entrada({ principal: 'comp-a-filho' }),
      { arma: 'kit-recriar', linkDocId: VINCULO_1 },
      resolvedorFake(loja2),
    );
    expect(criacao.plano.kitNovo).toEqual({ acao: 'criar' });
    expect(criacao.contexto.principal).toEqual({ itemId: COMP_A_ITEM, modelId: COMP_A_MODELO });
  });
});

/** A link update the way a re-verify would leave it (the setup of a removed target). */
function salvarVinculo(db: FakeDb, linkDocId: string, patch: Json): void {
  db.seed(`produtos/${K}/prodshopee/${linkDocId}`, { ...vinculo(db, linkDocId), ...patch });
}

/* ========================================================================== */
/*  (3) step 2 — the delete gate (M129, M172, M179)                            */
/* ========================================================================== */

describe('passo 2 — o portão da exclusão', () => {
  it('(M129) o kit novo lê REVIEWING ⇒ `kit-novo-inativo`, ZERO delete_item, o antigo intocado (ambos vivos)', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    const antigoAntes = structuredClone(vinculo(db, VINCULO_1));
    loja.statusDoProximo = 'REVIEWING';

    const r = await recriar(db, loja, VINCULO_1);

    expect(codigos(r)).toContain('kit-novo-inativo');
    expect(r.antecessor).toMatchObject({ excluido: false, substituido: false });
    expect(loja.ops).not.toContain('delete_item');
    expect(vinculo(db, VINCULO_1)).toEqual(antigoAntes);
    expect(r.avisos.find((a) => a.codigo === 'kit-novo-inativo')?.mensagem).toContain(
      `--link ${VINCULO_1} --recriar`,
    );
  });

  it('(M129) o kit novo lê BANNED ⇒ o mesmo: nada excluído', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    loja.statusDoProximo = 'BANNED';

    const r = await recriar(db, loja, VINCULO_1);

    expect(codigos(r)).toContain('kit-novo-inativo');
    expect(loja.ops).not.toContain('delete_item');
  });

  it('(M172) R2 + uma NOVA edição, `--link NOVO --recriar` (mira errada) ⇒ completa o ANTIGO, que dobra DIFERENTE ⇒ `kit-novo-divergente`, ZERO delete_item', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    await recriacaoInterrompidaEmR2(db, loja);
    editarVerde(db, 4);
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_2);

    expect(r).toMatchObject({ desfecho: 'retomado', itemId: KIT_1, linkDocId: VINCULO_1 });
    expect(codigos(r)).toContain('kit-novo-divergente');
    expect(codigos(r)).not.toContain('kit-antigo-nao-excluido');
    expect(quantas(loja, 'delete_item', desde)).toBe(0);
    expect(quantas(loja, 'add_kit_item', desde)).toBe(0);
  });

  it('(M172 / V2R1-02) troca SÓ de principal em R2, `--link NOVO --recriar` COM e SEM --principal ⇒ completa o antigo, ZERO delete_item, nomeando o antigo', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    semearComponentes(db);
    semearFamilia(db);
    await criar(db, loja);
    await recriacaoInterrompidaEmR2(db, loja, { principal: 'comp-b-membro' });
    const desde = loja.ops.length;

    const comPrincipal = await recriar(db, loja, VINCULO_2, { principal: 'comp-b-membro' });
    expect(comPrincipal).toMatchObject({ linkDocId: VINCULO_1, antecessor: { excluido: false } });
    expect(codigos(comPrincipal)).toEqual(
      expect.arrayContaining(['principal-diferente', 'kit-alvo-mais-novo']),
    );
    const diferente = comPrincipal.avisos.find((a) => a.codigo === 'principal-diferente');
    expect(diferente?.mensagem).toContain(`--link ${VINCULO_1} --recriar`);

    const semPrincipal = await recriar(db, loja, VINCULO_2, { principal: null });
    expect(codigos(semPrincipal)).toContain('kit-alvo-mais-novo');
    expect(codigos(semPrincipal)).not.toContain('principal-diferente');
    const maisNovo = semPrincipal.avisos.find((a) => a.codigo === 'kit-alvo-mais-novo');
    expect(maisNovo?.mensagem).toContain(`o kit antigo é o ${String(KIT_1)}`);
    expect(maisNovo?.mensagem).toContain(`--link ${VINCULO_1} --recriar`);

    expect(quantas(loja, 'delete_item', desde)).toBe(0);
  });

  it('(M172) um `create_time` NULO no kit novo ⇒ não dá para comparar ⇒ ZERO delete_item', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    loja.criadoDoProximo = null;

    const r = await recriar(db, loja, VINCULO_1);

    expect(codigos(r)).toContain('kit-alvo-mais-novo');
    expect(r.avisos.find((a) => a.codigo === 'kit-alvo-mais-novo')?.mensagem).toContain(
      'não foi possível comparar as datas de criação',
    );
    expect(loja.ops).not.toContain('delete_item');
  });

  it('(M172 / V2R3-01) a retomada BEM mirada `--link ANTIGO --recriar --principal P2` de uma troca de principal ⇒ exatamente UM delete_item(antigo): compara com o P2 do kit COMPLETADO, nunca o P1 do antigo', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    semearComponentes(db);
    semearFamilia(db);
    await criar(db, loja);
    await recriacaoInterrompidaEmR2(db, loja, { principal: 'comp-b-membro' });
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_1, { principal: 'comp-b-membro' });

    expect(r).toMatchObject({ desfecho: 'retomado', linkDocId: VINCULO_2 });
    expect(codigos(r)).not.toContain('principal-diferente');
    expect(loja.chamadas.slice(desde).filter((c) => c.op === 'delete_item')).toEqual([
      { op: 'delete_item', ids: [KIT_1] },
    ]);
  });

  it('(M172) a nova tentativa de R5 COM --principal ⇒ o delete é reenviado', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    semearComponentes(db);
    semearFamilia(db);
    await criar(db, loja);
    loja.exclusao = 'recusa';
    const primeira = await recriar(db, loja, VINCULO_1, { principal: 'comp-b-membro' });
    expect(primeira.antecessor).toMatchObject({ substituido: true });
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_1, { principal: 'comp-b-membro' });

    expect(quantas(loja, 'delete_item', desde)).toBe(1);
    expect(r.antecessor).toMatchObject({ excluido: true });
  });

  it('(M179) R3 — o antigo JÁ apagado na Shopee e o kit novo DIVERGENTE e em REVIEWING ⇒ o portão é PULADO: zero delete_item, antigo `removido`, `receita-divergente` relatado, nunca `kit-novo-divergente`/`kit-novo-inativo`', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    await recriacaoInterrompidaEmR3(db, loja);
    // Then the ERP recipe moves again, and Shopee puts the new kit in review.
    editarVerde(db, 4);
    const novo = loja.itens.get(KIT_2)!;
    novo.base = { ...novo.base, item_status: 'REVIEWING' };
    novo.kit = { ...novo.kit, item_status: 'REVIEWING' };
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_1);

    expect(quantas(loja, 'delete_item', desde)).toBe(0);
    expect(vinculo(db, VINCULO_1)?.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.removido);
    expect(codigos(r)).toContain('receita-divergente');
    expect(codigos(r)).not.toContain('kit-novo-divergente');
    expect(codigos(r)).not.toContain('kit-novo-inativo');
    expect(r.antecessor).toMatchObject({ excluido: true });
  });
});

/* ========================================================================== */
/*  (4) step 3 + the crash resumes (M120, M125–M127, M130, M132, M174, RT13)  */
/* ========================================================================== */

describe('passo 3 e as retomadas da recriação (§2.5.4 R0–R5)', () => {
  it('(M125) R3 — delete feito e queda antes do vínculo antigo ⇒ o MESMO comando: zero add_kit_item, zero SEGUNDO delete_item, antigo `removido`, aviso resolvido', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    await recriacaoInterrompidaEmR3(db, loja);
    expect(quantas(loja, 'delete_item')).toBe(1);
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_1);

    expect(r).toMatchObject({
      desfecho: 'retomado',
      itemId: KIT_2,
      antecessor: { itemId: KIT_1, excluido: true, substituido: false },
    });
    expect(quantas(loja, 'add_kit_item', desde)).toBe(0);
    expect(quantas(loja, 'delete_item', desde)).toBe(0);
    expect(vinculo(db, VINCULO_1)?.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.removido);
    expect(avisoAberto(db)).toBe(false);
  });

  it('(M125) um delete_item que FALHA depois de apagar (timeout) ⇒ a releitura SELLER_DELETE decide: antigo `removido`, nunca substituído', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    loja.exclusao = 'apaga-e-falha';

    const r = await recriar(db, loja, VINCULO_1);

    expect(r.antecessor).toMatchObject({ excluido: true, substituido: false });
    expect(codigos(r)).not.toContain('kit-antigo-nao-excluido');
    expect(vinculo(db, VINCULO_1)).toMatchObject({
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido,
      item_status: 'SELLER_DELETE',
    });
    expect(vinculo(db, VINCULO_1)?.substituidoPorLinkDocId ?? null).toBeNull();
  });

  it('(M126 / RT13) R2 — queda logo DEPOIS do vínculo novo (sem #2, sem linhas) ⇒ o MESMO `--link antigo --recriar`: zero add_kit_item, as linhas do novo completadas, UM delete_item, antigo `removido`; de novo ⇒ `retomado` com ZERO escrita na Shopee', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    loja.falhaNaLeitura = {
      itemId: KIT_2,
      erro: new TypeError('fixture: o processo caiu depois do vínculo novo'),
      depois: 0,
    };
    expect(await falhaDe(recriar(db, loja, VINCULO_1))).toBeInstanceOf(TypeError);
    // R2 at its earliest stage: the link (literal `kitNativo: true`), no #2, no rows.
    expect(vinculo(db, VINCULO_2)).toMatchObject({ kitNativo: true, item_id: KIT_2 });
    expect(vinculo(db, VINCULO_2)?.item_status).toBeUndefined();
    expect(linhasDoVinculo(db, VINCULO_2)).toEqual([]);
    expect(loja.ops).not.toContain('delete_item');
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_1);

    expect(r).toMatchObject({
      desfecho: 'retomado',
      itemId: KIT_2,
      linkDocId: VINCULO_2,
      antecessor: { itemId: KIT_1, excluido: true, substituido: false },
    });
    expect(quantas(loja, 'add_kit_item', desde)).toBe(0);
    expect(loja.chamadas.slice(desde).filter((c) => c.op === 'delete_item')).toEqual([
      { op: 'delete_item', ids: [KIT_1] },
    ]);
    expect(linhasDoVinculo(db, VINCULO_2)).toEqual([
      [K_AZUL, MODELOS_DE[KIT_2]![0]],
      [K_VERDE, MODELOS_DE[KIT_2]![1]],
    ]);
    expect(vinculo(db, VINCULO_1)?.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.removido);
    expect(avisoAberto(db)).toBe(false);

    const desde2 = loja.ops.length;
    const deNovo = await recriar(db, loja, VINCULO_1);
    expect(deNovo.desfecho).toBe('retomado');
    expect(escritasNaLoja(loja, desde2)).toEqual([]);
  });

  it('(M127 / RT13-R1) uma recriação `incerto` que CRIOU ⇒ o mesmo comando recusa "importe-o" (zero add_kit_item, zero delete_item) ⇒ a importação REAL cai em K e nos filhos ORIGINAIS, as linhas antigas byte a byte iguais ⇒ o mesmo comando retoma; UM add_kit_item no total', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    const produtosAntes = produtos(db);
    const linhasAntigas = docsDasLinhas(db, VINCULO_1);
    loja.falhaAposCriar = muitasConexoes();
    const desde = loja.ops.length;

    const incerto = await recriar(db, loja, VINCULO_1);
    expect(incerto).toMatchObject({
      desfecho: 'incerto',
      itemId: null,
      linkDocId: null,
      antecessor: null,
    });
    expect(vinculo(db, VINCULO_2)).toBeUndefined();

    const erro = await recusaDe(recriar(db, loja, VINCULO_1));
    expect(motivos(erro)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.kitJaExisteNaShopee]);
    expect(erro.problemas[0]?.mensagem).toContain(String(KIT_2));
    expect(quantas(loja, 'add_kit_item', desde)).toBe(1);
    expect(quantas(loja, 'delete_item', desde)).toBe(0);

    const importado = await importar(db, loja, KIT_2);
    expect(importado.produtoId).toBe(K);
    expect(produtos(db)).toEqual(produtosAntes);
    expect(linhasDoVinculo(db, VINCULO_2)).toEqual([
      [K_AZUL, MODELOS_DE[KIT_2]![0]],
      [K_VERDE, MODELOS_DE[KIT_2]![1]],
    ]);
    expect(docsDasLinhas(db, VINCULO_1)).toEqual(linhasAntigas);

    const r = await recriar(db, loja, VINCULO_1);
    expect(r).toMatchObject({ desfecho: 'retomado', antecessor: { excluido: true } });
    expect(quantas(loja, 'add_kit_item', desde)).toBe(1);
    expect(quantas(loja, 'delete_item', desde)).toBe(1);
  });

  it('(M130 / M120 / RT13-R5) o delete é RECUSADO ⇒ antigo SUBSTITUÍDO (nunca dois nativos ativos) + `kit-antigo-nao-excluido`, e o aviso SEGUE ABERTO; o mesmo comando ⇒ rede pulada, zero add_kit_item, o delete REENVIADO ⇒ `removido` e o aviso resolvido', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    loja.exclusao = 'recusa';

    const r = await recriar(db, loja, VINCULO_1);

    expect(r.antecessor).toMatchObject({ itemId: KIT_1, excluido: false, substituido: true });
    expect(codigos(r)).toContain('kit-antigo-nao-excluido');
    expect(r.avisos.find((a) => a.codigo === 'kit-antigo-nao-excluido')?.mensagem).toContain(
      `reverificar:anuncio --link ${VINCULO_1}`,
    );
    expect(vinculo(db, VINCULO_1)).toMatchObject({
      substituidoPorLinkDocId: VINCULO_2,
      substituidoEm: AGORA,
      // Superseded is NOT removed: the old kit is still live and selling.
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
    });
    expect(ehKitNativoAtivo(vinculo(db, VINCULO_1) ?? {})).toBe(false);
    expect(ehKitNativoAtivo(vinculo(db, VINCULO_2) ?? {})).toBe(true);
    // S2C-03: the old kit still sells the OLD composition ⇒ the aviso stays open.
    expect(avisoAberto(db)).toBe(true);
    expect(r.avisosResolvidos).toBe(0);
    const desde = loja.ops.length;

    const deNovo = await recriar(db, loja, VINCULO_1);

    expect(deNovo).toMatchObject({ desfecho: 'retomado', antecessor: { excluido: true } });
    expect(quantas(loja, 'add_kit_item', desde)).toBe(0);
    expect(quantas(loja, 'delete_item', desde)).toBe(1);
    expect(vinculo(db, VINCULO_1)?.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.removido);
    expect(avisoAberto(db)).toBe(false);
    expect(deNovo.avisosResolvidos).toBe(1);
  });

  it('(M132) o antigo lê BANNED ⇒ NUNCA recebe delete_item: substituído + `kit-antigo-nao-excluido`', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    const antigo = loja.itens.get(KIT_1)!;
    antigo.base = { ...antigo.base, item_status: 'BANNED' };
    antigo.kit = { ...antigo.kit, item_status: 'BANNED' };

    const r = await recriar(db, loja, VINCULO_1);

    expect(loja.ops).not.toContain('delete_item');
    expect(r.antecessor).toMatchObject({ excluido: false, substituido: true });
    expect(codigos(r)).toContain('kit-antigo-nao-excluido');
    expect(vinculo(db, VINCULO_1)?.substituidoPorLinkDocId).toBe(VINCULO_2);
  });

  it('(M174) um alvo PURGADO (a leitura não traz linha) não lança: zero delete_item, antigo `removido`, aviso re-decidido', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    loja.itens.delete(KIT_1);

    const r = await recriar(db, loja, VINCULO_1);

    expect(r).toMatchObject({ desfecho: 'criado', antecessor: { excluido: true } });
    expect(loja.ops).not.toContain('delete_item');
    expect(vinculo(db, VINCULO_1)?.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.removido);
    expect(avisoAberto(db)).toBe(false);
  });

  it('(M177) R2 com as variantes TROCADAS depois da criação ⇒ cada modelo vivo liga pela SUA linha no vínculo novo: nenhuma linha nova sob o outro filho, nenhum recarimbo cruzado; o portão passa e UM delete_item', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    await recriacaoInterrompidaEmR2(db, loja);
    const linhasAntes = linhasDoVinculo(db, VINCULO_2);
    const carimbosAntes = docsDasLinhas(db, VINCULO_2);
    // The operator swaps the two variantes in the ERP: Azul's child now says Verde.
    salvar(db, K_AZUL, { variacoesUid: [varianteFakePath(GRUPO, 'var-verde')] });
    salvar(db, K_VERDE, { variacoesUid: [varianteFakePath(GRUPO, 'var-azul')] });
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_1);

    expect(linhasDoVinculo(db, VINCULO_2)).toEqual(linhasAntes);
    expect(docsDasLinhas(db, VINCULO_2)).toEqual(carimbosAntes);
    expect(codigos(r)).not.toContain('kit-novo-divergente');
    expect(quantas(loja, 'delete_item', desde)).toBe(1);
  });

  it('(M181, metade do PR 6) uma RETOMADA (R2) com uma falha de FASE A (`sem-peso`) ⇒ recusada na fase A: ZERO chamada à Shopee e o log de escritas vazio', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    await recriacaoInterrompidaEmR2(db, loja);
    salvar(db, K, { pesoBrutoKg: null });
    const ops = loja.ops.length;
    const escritas = db.writes.length;

    const erro = await recusaDe(recriar(db, loja, VINCULO_1));

    expect(motivos(erro)).toContain(MOTIVO_PUBLICACAO_BLOQUEADA.semPeso);
    expect(loja.ops.slice(ops)).toEqual([]);
    expect(db.writes.slice(escritas)).toEqual([]);
  });

  it('(M183) uma recriação `incerto` ⇒ o 202: `recusa` + `comando` (o MESMO --link antigo --recriar, com --principal), zero delete_item, nada substituído, o log de escritas VAZIO', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    const escritas = db.writes.length;
    loja.falhaSemCriar = muitasConexoes();

    const r = await recriar(db, loja, VINCULO_1);

    expect(r).toMatchObject({
      arma: 'kit-recriar',
      desfecho: 'incerto',
      itemId: null,
      linkDocId: null,
      antecessor: null,
      avisosResolvidos: 0,
      comando: `publicar:anuncio --integracao ${INTEGRACAO} --produto ${K} --link ${VINCULO_1} --recriar --principal comp-a-filho`,
    });
    expect(r.recusa).not.toBeNull();
    expect(loja.ops).not.toContain('delete_item');
    expect(db.writes.slice(escritas)).toEqual([]);
  });

  it('(M183, variante) o alvo JÁ `removido` (uma reavaliação "nada" GRAVARIA a marca d’água) ⇒ o log de escritas segue VAZIO, sem 200 `kit-novo-inativo`', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    semearComponentes(db);
    semearFamilia(db);
    await criar(db, loja);
    const antigo = loja.itens.get(KIT_1)!;
    antigo.base = { ...antigo.base, item_status: 'SELLER_DELETE' };
    salvarVinculo(db, VINCULO_1, { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido });
    const escritas = db.writes.length;
    loja.falhaSemCriar = muitasConexoes();

    const r = await recriar(db, loja, VINCULO_1);

    expect(r.desfecho).toBe('incerto');
    expect(codigos(r)).not.toContain('kit-novo-inativo');
    expect(db.writes.slice(escritas)).toEqual([]);
  });
});

/* ========================================================================== */
/*  (5) converter — L8 (M116, M117, M119, M131, M183, RT6, RT14)               */
/* ========================================================================== */

/** K with its OLD-MODEL listing (L0): the converter's start. */
function kitComAnuncioComum(db: FakeDb, loja: Loja): void {
  semearComponentes(db);
  semearFamilia(db);
  salvar(db, K, { ehKitVirtual: null });
  semearAnuncioComum(db);
  loja.itens.set(ITEM_COMUM, itemComum());
}

/** Every Shopee call that CARRIED the ordinary listing's `item_id`. */
function chamadasDoComum(loja: Loja, desde = 0): Chamada[] {
  return loja.chamadas.slice(desde).filter((c) => c.ids.includes(ITEM_COMUM));
}

/** A stock-planner input built from the docs the run WROTE (the pipeline's projection, by hand). */
function familiaDoDb(db: FakeDb): LinhaDeFamiliaShopee {
  const membro = (produtoId: string): MembroDaFamilia => {
    const raw = doc(db, `produtos/${produtoId}`) ?? {};
    return {
      produtoId,
      ehKit: raw.ehKit === true,
      ehKitVirtual: raw.ehKitVirtual === true,
      publicado: true,
      componentesKit: null,
      timestampMs: null,
      estoque: null,
      componentEstoques: [],
    };
  };
  const filho = (produtoId: string): FilhoDaFamilia => ({
    ...membro(produtoId),
    varLinks: db.idsEm(`produtos/${produtoId}/variashopee`).map((id) => ({
      ...doc(db, `produtos/${produtoId}/variashopee/${id}`),
      varLinkDocId: id,
    })),
  });
  return {
    anchorId: K,
    anchor: membro(K),
    integracoesComProduto: [INTEGRACAO],
    links: db.idsEm(`produtos/${K}/prodshopee`).map((id) => ({
      ...vinculo(db, id),
      linkDocId: id,
    })),
    children: [filho(K_AZUL), filho(K_VERDE)],
  };
}

describe('converterEmKit — o kit nativo novo, o anúncio comum SUBSTITUÍDO (L8)', () => {
  it('(M116 / M117) converte: UM add_kit_item, o comum SUBSTITUÍDO (nunca `removido`, estado intacto), as linhas dele byte a byte iguais, e NENHUMA chamada carrega o item comum', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    kitComAnuncioComum(db, loja);
    const linhasComuns = docsDasLinhas(db, VINCULO_COMUM);

    const r = await converter(db, loja);

    expect(r).toMatchObject({
      arma: 'kit-converter',
      desfecho: 'criado',
      itemId: KIT_1,
      linkDocId: VINCULO_1,
      kitNativo: true,
      antecessor: {
        itemId: ITEM_COMUM,
        linkDocId: VINCULO_COMUM,
        excluido: false,
        substituido: true,
      },
    });
    expect(vinculo(db, VINCULO_COMUM)).toMatchObject({
      substituidoPorLinkDocId: VINCULO_1,
      substituidoEm: AGORA,
      estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
      item_status: 'NORMAL',
      kitNativo: false,
    });
    expect(docsDasLinhas(db, VINCULO_COMUM)).toEqual(linhasComuns);
    expect(chamadasDoComum(loja)).toEqual([]);
    expect(escritasNaLoja(loja)).toEqual(['add_kit_item']);
  });

  it('(M116, variante) a linha da lista do comum vem com `tag: null` ⇒ ele ENTRA no lote de base da busca — e só nele —, lá `tag.kit: false` ⇒ não é achado; o converter segue', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    kitComAnuncioComum(db, loja);
    loja.tagNaLista.set(ITEM_COMUM, null);

    const r = await converter(db, loja);

    expect(r.desfecho).toBe('criado');
    expect(chamadasDoComum(loja).map((c) => c.op)).toEqual(['get_item_base_info']);
  });

  it('(M119) uma família de 2 itens SEM --principal ⇒ principal-obrigatorio, zero add_kit_item, o comum intacto', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    kitComAnuncioComum(db, loja);
    const comumAntes = structuredClone(vinculo(db, VINCULO_COMUM));

    const erro = await recusaDe(converter(db, loja, { principal: null }));

    expect(motivos(erro)).toContain(MOTIVO_PUBLICACAO_BLOQUEADA.principalObrigatorio);
    expect(loja.ops).not.toContain('add_kit_item');
    expect(vinculo(db, VINCULO_COMUM)).toEqual(comumAntes);
  });

  it('RT6 (metade do PR 6) — depois do converter o anúncio COMUM ainda recebe estoque: o portão diz `enviar`; reverificar o kit novo E o comum (o reverify REAL, por anúncio) não marca linha nenhuma; o planejador de estoque planeja o comum e pula o kit (`kit-derivado`)', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    kitComAnuncioComum(db, loja);
    await converter(db, loja);

    expect(podeEnviarEstoqueShopee(vinculo(db, VINCULO_COMUM) ?? {}, {}, { nowMs: AGORA })).toEqual(
      {
        enviar: true,
      },
    );

    const depsReverificacao = {
      clientFor: () => Promise.resolve(loja.client),
      increment,
      nowMs: AGORA + 2_000,
    };
    const doKit = await reverificarAnuncioShopee(
      asDb(db),
      { integracaoId: INTEGRACAO, produtoId: K, linkDocId: VINCULO_1 },
      depsReverificacao,
    );
    const doComum = await reverificarAnuncioShopee(
      asDb(db),
      { integracaoId: INTEGRACAO, produtoId: K, linkDocId: VINCULO_COMUM },
      depsReverificacao,
    );
    expect(doKit?.modelos).toMatchObject({ total: 2, ausentes: 0 });
    expect(doComum?.modelos).toMatchObject({ total: 2, ausentes: 0 });
    for (const linkDocId of [VINCULO_1, VINCULO_COMUM]) {
      for (const linha of Object.values(docsDasLinhas(db, linkDocId))) {
        expect(linha.modeloAusenteEm ?? null, linkDocId).toBeNull();
      }
    }

    const plano = montarTarefasDeEstoqueShopee(
      familiaDoDb(db),
      new Map([
        [K_AZUL, 5],
        [K_VERDE, 3],
      ]),
      { integracaoId: INTEGRACAO, sweepId: 'varredura-1', sweepComputadoEmMs: AGORA, nowMs: AGORA },
    );
    expect(
      plano.tarefas.map((t) => [
        t.linkDocId,
        t.modelos.map((m) => m.modelId).sort((a, b) => a - b),
      ]),
    ).toEqual([[VINCULO_COMUM, [MODELO_COMUM_AZ, MODELO_COMUM_VD]]]);
    expect(plano.pulos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          linkDocId: VINCULO_1,
          motivo: MOTIVO_ESTOQUE_SHOPEE.kitDerivado,
        }),
      ]),
    );
  });

  it('(M131 / RT14) V2 — o converter caiu logo depois do vínculo novo ⇒ `--converter-em-kit` de novo: ZERO add_kit_item, o kit novo completado, o comum SUBSTITUÍDO; nenhuma ESCRITA carrega o item comum', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    kitComAnuncioComum(db, loja);
    loja.falhaNaLeitura = {
      itemId: KIT_1,
      erro: new TypeError('fixture: o processo caiu depois do vínculo novo'),
      depois: 0,
    };
    expect(await falhaDe(converter(db, loja))).toBeInstanceOf(TypeError);
    expect(vinculo(db, VINCULO_1)).toMatchObject({ kitNativo: true, item_id: KIT_1 });
    expect(vinculo(db, VINCULO_COMUM)?.substituidoPorLinkDocId ?? null).toBeNull();
    const desde = loja.ops.length;

    const r = await converter(db, loja);

    expect(r).toMatchObject({
      desfecho: 'retomado',
      itemId: KIT_1,
      antecessor: { itemId: ITEM_COMUM, substituido: true },
    });
    expect(quantas(loja, 'add_kit_item', desde)).toBe(0);
    expect(linhasDoVinculo(db, VINCULO_1)).toHaveLength(2);
    expect(vinculo(db, VINCULO_COMUM)?.substituidoPorLinkDocId).toBe(VINCULO_1);
    const escritasDoComum = chamadasDoComum(loja).filter((c) =>
      ['add_kit_item', 'update_kit_item', 'delete_item'].includes(c.op),
    );
    expect(escritasDoComum).toEqual([]);
  });

  it('(RT14 / V1) um converter `incerto` que CRIOU, com os filhos carregando as linhas do comum ⇒ "importe-o" ⇒ a importação REAL: nenhum produto criado, as linhas novas nos filhos ORIGINAIS, as do comum byte a byte iguais ⇒ `--converter-em-kit` ⇒ comum substituído; UM add_kit_item no total', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    kitComAnuncioComum(db, loja);
    const produtosAntes = produtos(db);
    const linhasComuns = docsDasLinhas(db, VINCULO_COMUM);
    loja.falhaAposCriar = muitasConexoes();

    const incerto = await converter(db, loja);
    expect(incerto).toMatchObject({ desfecho: 'incerto', itemId: null, antecessor: null });
    expect(incerto.comando).toBe(
      `publicar:anuncio --integracao ${INTEGRACAO} --produto ${K} --converter-em-kit --link ${VINCULO_COMUM} --principal comp-a-filho`,
    );
    expect(vinculo(db, VINCULO_COMUM)?.substituidoPorLinkDocId ?? null).toBeNull();

    const erro = await recusaDe(converter(db, loja));
    expect(motivos(erro)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.kitJaExisteNaShopee]);
    expect(erro.problemas[0]?.mensagem).toContain(String(KIT_1));

    const importado = await importar(db, loja, KIT_1);
    expect(importado.produtoId).toBe(K);
    expect(produtos(db)).toEqual(produtosAntes);
    expect(linhasDoVinculo(db, VINCULO_1)).toEqual([
      [K_AZUL, MODELOS_DE[KIT_1]![0]],
      [K_VERDE, MODELOS_DE[KIT_1]![1]],
    ]);
    expect(docsDasLinhas(db, VINCULO_COMUM)).toEqual(linhasComuns);

    const r = await converter(db, loja);
    expect(r).toMatchObject({ desfecho: 'retomado', antecessor: { substituido: true } });
    expect(quantas(loja, 'add_kit_item')).toBe(1);
    expect(chamadasDoComum(loja)).toEqual([]);
  });

  it('(M172) uma retomada do converter COM --principal igual ⇒ nenhum `principal-diferente` espúrio; ⛔ quase-par: outro --principal ⇒ o aviso (e o comum substituído assim mesmo)', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    kitComAnuncioComum(db, loja);
    loja.falhaNaLeitura = {
      itemId: KIT_1,
      erro: new TypeError('fixture: o processo caiu depois do vínculo novo'),
      depois: 0,
    };
    await falhaDe(converter(db, loja));

    const igual = await converter(db, loja, { principal: 'comp-a-filho' });
    expect(codigos(igual)).not.toContain('principal-diferente');

    const outro = await converter(db, loja, { principal: 'comp-b-membro' });
    expect(codigos(outro)).toContain('principal-diferente');
    expect(outro.antecessor).toMatchObject({ substituido: true });
  });

  it('(M181, metade do PR 6) uma retomada do converter (V2) com `sem-peso` ⇒ recusada na fase A: ZERO chamada à Shopee e o log de escritas vazio', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    kitComAnuncioComum(db, loja);
    loja.falhaNaLeitura = {
      itemId: KIT_1,
      erro: new TypeError('fixture: o processo caiu depois do vínculo novo'),
      depois: 0,
    };
    await falhaDe(converter(db, loja));
    salvar(db, K, { pesoBrutoKg: null });
    const ops = loja.ops.length;
    const escritas = db.writes.length;

    const erro = await recusaDe(converter(db, loja));

    expect(motivos(erro)).toContain(MOTIVO_PUBLICACAO_BLOQUEADA.semPeso);
    expect(loja.ops.slice(ops)).toEqual([]);
    expect(db.writes.slice(escritas)).toEqual([]);
  });

  it('(M183) um converter `incerto` ⇒ o 202 com `recusa` + `comando`, NENHUMA substituição, o log de escritas VAZIO', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    kitComAnuncioComum(db, loja);
    const escritas = db.writes.length;
    loja.falhaSemCriar = muitasConexoes();

    const r = await converter(db, loja);

    expect(r).toMatchObject({ arma: 'kit-converter', desfecho: 'incerto', antecessor: null });
    expect(r.recusa).not.toBeNull();
    expect(r.comando).toContain('--converter-em-kit');
    expect(db.writes.slice(escritas)).toEqual([]);
  });
});

/* ========================================================================== */
/*  (6) the review's mutation pins (R6-M01, M05–M08, M13/RK13)                */
/* ========================================================================== */

describe('(R6-M01) passo 2 — o portão guarda todo alvo que EXISTE, vivo ou não', () => {
  for (const statusAntigo of ['BANNED', 'REVIEWING'] as const) {
    it(`o antigo lê ${statusAntigo} e o kit NOVO lê REVIEWING ⇒ \`kit-novo-inativo\` e PARA: ZERO delete_item, o antigo nem substituído`, async () => {
      const db = new FakeDb();
      const loja = novaLoja();
      await kitAntigoComReceitaEditada(db, loja);
      const antigo = loja.itens.get(KIT_1)!;
      antigo.base = { ...antigo.base, item_status: statusAntigo };
      antigo.kit = { ...antigo.kit, item_status: statusAntigo };
      const antigoAntes = structuredClone(vinculo(db, VINCULO_1));
      loja.statusDoProximo = 'REVIEWING';

      const r = await recriar(db, loja, VINCULO_1);

      expect(codigos(r)).toContain('kit-novo-inativo');
      expect(codigos(r)).not.toContain('kit-antigo-nao-excluido');
      expect(r.antecessor).toMatchObject({ itemId: KIT_1, excluido: false, substituido: false });
      expect(loja.ops).not.toContain('delete_item');
      // Publish must not move to a kit that is not live: L_old stays the active one.
      expect(vinculo(db, VINCULO_1)).toEqual(antigoAntes);
      expect(vinculo(db, VINCULO_1)?.substituidoPorLinkDocId ?? null).toBeNull();
    });

    it(`⛔ quase-par — o antigo lê ${statusAntigo} e o kit novo lê NORMAL ⇒ o portão passa: SUBSTITUÍDO + \`kit-antigo-nao-excluido\`, ainda ZERO delete_item (M132)`, async () => {
      const db = new FakeDb();
      const loja = novaLoja();
      await kitAntigoComReceitaEditada(db, loja);
      const antigo = loja.itens.get(KIT_1)!;
      antigo.base = { ...antigo.base, item_status: statusAntigo };
      antigo.kit = { ...antigo.kit, item_status: statusAntigo };

      const r = await recriar(db, loja, VINCULO_1);

      expect(codigos(r)).not.toContain('kit-novo-inativo');
      expect(codigos(r)).toContain('kit-antigo-nao-excluido');
      expect(r.antecessor).toMatchObject({ excluido: false, substituido: true });
      expect(loja.ops).not.toContain('delete_item');
      expect(vinculo(db, VINCULO_1)?.substituidoPorLinkDocId).toBe(VINCULO_2);
    });
  }

  it('mira errada sobre um alvo NÃO vivo: R2, o kit NOVO em REVIEWING e `--link NOVO --recriar` ⇒ completa o ANTIGO, o portão PARA (`kit-novo-divergente` + `kit-alvo-mais-novo`) e o vínculo novo NUNCA é substituído pelo antigo', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    await recriacaoInterrompidaEmR2(db, loja);
    const novo = loja.itens.get(KIT_2)!;
    novo.base = { ...novo.base, item_status: 'REVIEWING' };
    novo.kit = { ...novo.kit, item_status: 'REVIEWING' };
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_2);

    expect(r).toMatchObject({ desfecho: 'retomado', itemId: KIT_1, linkDocId: VINCULO_1 });
    expect(codigos(r)).toEqual(
      expect.arrayContaining(['kit-novo-divergente', 'kit-alvo-mais-novo']),
    );
    expect(codigos(r)).not.toContain('kit-antigo-nao-excluido');
    expect(r.antecessor).toMatchObject({ itemId: KIT_2, excluido: false, substituido: false });
    expect(quantas(loja, 'delete_item', desde)).toBe(0);
    expect(vinculo(db, VINCULO_2)?.substituidoPorLinkDocId ?? null).toBeNull();
    expect(ehKitNativoAtivo(vinculo(db, VINCULO_2) ?? {})).toBe(true);
  });
});

describe('(R6-M05) passo 2 — cada código de divergência PARA o portão', () => {
  it('R2 + um filho ACRESCENTADO no ERP depois da criação ⇒ `variacao-nao-anexada` ⇒ `kit-novo-divergente` nomeando o filho, ZERO delete_item', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    await recriacaoInterrompidaEmR2(db, loja);
    semearVermelho(db);
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_1);

    expect(r).toMatchObject({
      desfecho: 'retomado',
      itemId: KIT_2,
      antecessor: { itemId: KIT_1, excluido: false, substituido: false },
    });
    expect(codigos(r)).toContain('variacao-nao-anexada');
    expect(r.avisos.find((a) => a.codigo === 'kit-novo-divergente')?.mensagem).toContain(
      `variacao-nao-anexada ${K_VERMELHO}`,
    );
    expect(quantas(loja, 'add_kit_item', desde)).toBe(0);
    expect(quantas(loja, 'delete_item', desde)).toBe(0);
    expect(vinculo(db, VINCULO_1)?.substituidoPorLinkDocId ?? null).toBeNull();
  });

  it('R2 + um filho RETIRADO da família depois da criação ⇒ `modelo-sem-filho` ⇒ `kit-novo-divergente`, ZERO delete_item', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    await recriacaoInterrompidaEmR2(db, loja);
    salvar(db, K_VERDE, { paiId: null });
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_1);

    expect(r).toMatchObject({
      desfecho: 'retomado',
      itemId: KIT_2,
      antecessor: { excluido: false, substituido: false },
    });
    expect(codigos(r)).toContain('modelo-sem-filho');
    expect(r.avisos.find((a) => a.codigo === 'kit-novo-divergente')?.mensagem).toContain(
      'modelo-sem-filho',
    );
    expect(quantas(loja, 'delete_item', desde)).toBe(0);
  });

  it('⛔ quase-par — a MESMA retomada sem mudança no ERP ⇒ o portão passa: UM delete_item', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    await recriacaoInterrompidaEmR2(db, loja);
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_1);

    expect(codigos(r)).not.toContain('kit-novo-divergente');
    expect(r.antecessor).toMatchObject({ excluido: true });
    expect(quantas(loja, 'delete_item', desde)).toBe(1);
  });

  it('divergenciaDoKitNovo (puro): cada um dos QUATRO códigos sozinho é divergência; ⛔ quase-par: um aviso que não é de composição ⇒ `null`', () => {
    const completo = {
      modelos: [{ filhoId: K_AZUL, tierIndex: 0, linhas: [], projecaoCompleta: true }],
    };
    const so = (codigo: AvisoKit['codigo']): { avisos: AvisoKit[] } => ({
      avisos: [{ codigo, produtoId: K_AZUL, mensagem: 'm' }],
    });
    for (const codigo of [
      'receita-divergente',
      'variacao-nao-anexada',
      'modelo-sem-filho',
      'receita-nao-publicavel',
    ] as const) {
      expect(divergenciaDoKitNovo(so(codigo), completo)).toBe(`${codigo} ${K_AZUL}`);
    }
    for (const codigo of [
      'componente-nao-limita-estoque',
      'principal-diferente',
      'kit-novo-inativo',
      'sku-do-kit-nao-enviado',
    ] as const) {
      expect(divergenciaDoKitNovo(so(codigo), completo)).toBeNull();
    }
  });
});

describe('(R6-M06) uma projeção INCOMPLETA nunca é "igual" — nos DOIS lugares', () => {
  it('passo 0: o kit vivo igual às linhas RESOLVIDAS, mas um componente do ERP sem anúncio ⇒ a recusa da receita, NUNCA `recriacao-sem-diferenca`; ZERO escrita na Shopee', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    semearComponentes(db);
    semearFamilia(db);
    await criar(db, loja);
    // Verde gains a component with NO listing on this conta: its projection is
    // still 2 × A — exactly what the live kit carries — but it is not complete.
    db.seed('produtos/comp-c', { nome: 'Meia', sku: 'MEIA', paiId: null });
    salvar(db, K_VERDE, {
      componentesKit: {
        'comp-a-filho': { quantidade: 2, limitarEstoque: true },
        'comp-c': { quantidade: 1, limitarEstoque: true },
      },
    });
    const desde = loja.ops.length;

    const erro = await recusaDe(recriar(db, loja, VINCULO_1));

    expect(motivos(erro)).toContain(MOTIVO_PUBLICACAO_BLOQUEADA.componenteNaoPublicado);
    expect(motivos(erro)).not.toContain(MOTIVO_PUBLICACAO_BLOQUEADA.recriacaoSemDiferenca);
    expect(escritasNaLoja(loja, desde)).toEqual([]);
  });

  it('⛔ quase-par — o mesmo kit SEM o componente sem anúncio ⇒ `recriacao-sem-diferenca`', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    semearComponentes(db);
    semearFamilia(db);
    await criar(db, loja);

    const erro = await recusaDe(recriar(db, loja, VINCULO_1));

    expect(motivos(erro)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.recriacaoSemDiferenca]);
  });

  it('o portão (puro): uma projeção incompleta SEM aviso correspondente ainda é divergência — o backstop; ⛔ quase-par: completa ⇒ `null`; com o aviso, nomeada UMA vez', () => {
    const modelo = (projecaoCompleta: boolean) => ({
      modelos: [{ filhoId: K_VERDE, tierIndex: 1, linhas: [], projecaoCompleta }],
    });
    expect(divergenciaDoKitNovo({ avisos: [] }, modelo(false))).toBe(
      `receita-nao-publicavel ${K_VERDE}`,
    );
    expect(divergenciaDoKitNovo({ avisos: [] }, modelo(true))).toBeNull();
    expect(
      divergenciaDoKitNovo(
        { avisos: [{ codigo: 'receita-nao-publicavel', produtoId: K_VERDE, mensagem: 'm' }] },
        modelo(false),
      ),
    ).toBe(`receita-nao-publicavel ${K_VERDE}`);
  });
});

describe('(R6-M07) passo 2 — "mais novo" é ESTRITO', () => {
  it('o kit novo com o MESMO `create_time` do alvo ⇒ ZERO delete_item e `kit-alvo-mais-novo` na frase do EMPATE', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    loja.criadoDoProximo = CRIADO_EM[KIT_1]!;

    const r = await recriar(db, loja, VINCULO_1);

    const maisNovo = r.avisos.find((a) => a.codigo === 'kit-alvo-mais-novo');
    expect(maisNovo?.mensagem).toContain(`o kit ${String(KIT_1)} (--link ${VINCULO_1})`);
    expect(maisNovo?.mensagem).toContain('confira qual é o kit antigo');
    expect(maisNovo?.mensagem).not.toContain('não foi possível comparar');
    expect(maisNovo?.mensagem).not.toContain('o kit antigo é o');
    expect(r.antecessor).toMatchObject({ excluido: false, substituido: false });
    expect(loja.ops).not.toContain('delete_item');
  });

  it('⛔ quase-par — UM segundo mais novo ⇒ o portão passa: UM delete_item', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    loja.criadoDoProximo = CRIADO_EM[KIT_1]! + 1;

    const r = await recriar(db, loja, VINCULO_1);

    expect(codigos(r)).not.toContain('kit-alvo-mais-novo');
    expect(r.antecessor).toMatchObject({ excluido: true });
    expect(quantas(loja, 'delete_item')).toBe(1);
  });
});

describe('(R6-M08) `chamadasShopee` de uma recriação que exclui', () => {
  it('conta TODA chamada do transporte desde a busca: a busca, o add_kit_item, a leitura de volta, o get_model_list, o delete_item e a RELEITURA do antigo', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    const desde = loja.chamadas.length;

    const r = await recriar(db, loja, VINCULO_1);

    expect(r.antecessor).toMatchObject({ excluido: true });
    const daBusca = loja.chamadas.findIndex((c, i) => i >= desde && c.op === 'get_item_list');
    expect(daBusca).toBeGreaterThan(-1);
    const contadas = loja.chamadas.slice(daBusca);
    // The delete's re-read is the LAST thing the run asks Shopee: base + kit page
    // + the component batch.
    expect(contadas.slice(-4).map((c) => c.op)).toEqual([
      'delete_item',
      'get_item_base_info',
      'get_kit_item_info',
      'get_item_base_info',
    ]);
    expect(r.chamadasShopee).toBe(contadas.length);
  });
});

describe('(R6-M13 / RK13) nadaARecriar — um vínculo VAZIO não é "igual"', () => {
  it('nenhum modelo vivo e nenhum filho ⇒ `false` (a verdade vácua não é prova); ⛔ quase-par: o mesmo contexto contra o kit vivo igual ⇒ `true`', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    semearComponentes(db);
    semearFamilia(db);
    await criar(db, loja);
    const { contexto, plano } = await ensaiarKitShopee(
      deps(db, loja),
      entrada(),
      { arma: 'kit-recriar', linkDocId: VINCULO_1 },
      resolvedorFake(loja),
    );
    const vivo = contexto.vivo?.kit ?? null;
    expect(vivo).not.toBeNull();

    expect(nadaARecriar(contexto, plano, vivo!)).toBe(true);
    expect(
      nadaARecriar({ ...contexto, filhos: [], principalPedido: null }, plano, {
        ...vivo!,
        model_list: [],
        tier_variation_list: [],
      }),
    ).toBe(false);
  });
});

/* ========================================================================== */
/*  (7) the handoff rulings (H1 `--status UNLIST` gate, H2 the re-run command) */
/* ========================================================================== */

/** The old kit K_1 reads `status` on Shopee (base + kit page alike). */
function antigoLe(loja: Loja, status: string): void {
  const antigo = loja.itens.get(KIT_1)!;
  antigo.base = { ...antigo.base, item_status: status };
  antigo.kit = { ...antigo.kit, item_status: status };
}

describe('(H1) passo 2 — um kit PAUSADO nunca substitui um kit À VENDA', () => {
  it('o antigo lê NORMAL e `--recriar --status UNLIST` cria o novo pausado ⇒ `kit-novo-inativo` e PARA: ZERO delete_item, o antigo intocado e nunca substituído', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    const antigoAntes = structuredClone(vinculo(db, VINCULO_1));
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_1, { statusPedido: 'UNLIST' });

    // The new kit really was created paused — this is the run the rule guards.
    expect(loja.corposDoAdd.at(-1)?.item_setting.unlisted).toBe(true);
    expect(r).toMatchObject({ desfecho: 'criado', itemId: KIT_2, itemStatus: 'UNLIST' });
    expect(codigos(r)).toContain('kit-novo-inativo');
    expect(codigos(r)).not.toContain('kit-antigo-nao-excluido');
    expect(r.antecessor).toMatchObject({ itemId: KIT_1, excluido: false, substituido: false });
    expect(quantas(loja, 'delete_item', desde)).toBe(0);
    expect(vinculo(db, VINCULO_1)).toEqual(antigoAntes);
    expect(vinculo(db, VINCULO_1)?.substituidoPorLinkDocId ?? null).toBeNull();
    // Something is still on sale: the old kit, untouched on Shopee.
    expect(loja.itens.get(KIT_1)?.base.item_status).toBe('NORMAL');
  });

  it('o antigo lê NORMAL e o novo lê UNLIST por conta da Shopee (sem --status) ⇒ o mesmo: ZERO delete_item', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    loja.statusDoProximo = 'UNLIST';
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_1);

    expect(codigos(r)).toContain('kit-novo-inativo');
    expect(quantas(loja, 'delete_item', desde)).toBe(0);
    expect(r.antecessor).toMatchObject({ excluido: false, substituido: false });
  });

  it('⛔ quase-par — o antigo JÁ lê UNLIST e o novo nasce UNLIST (`--status UNLIST`) ⇒ o portão passa: UM delete_item, o antigo `removido`', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    antigoLe(loja, 'UNLIST');
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_1, { statusPedido: 'UNLIST' });

    expect(r).toMatchObject({ itemId: KIT_2, itemStatus: 'UNLIST' });
    expect(codigos(r)).not.toContain('kit-novo-inativo');
    expect(r.antecessor).toMatchObject({ itemId: KIT_1, excluido: true, substituido: false });
    expect(quantas(loja, 'delete_item', desde)).toBe(1);
    expect(vinculo(db, VINCULO_1)?.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.removido);
  });

  it('⛔ quase-par — o antigo lê UNLIST e o novo nasce NORMAL ⇒ o portão passa também: UM delete_item', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    antigoLe(loja, 'UNLIST');
    const desde = loja.ops.length;

    const r = await recriar(db, loja, VINCULO_1);

    expect(codigos(r)).not.toContain('kit-novo-inativo');
    expect(quantas(loja, 'delete_item', desde)).toBe(1);
  });
});

/** A kit `itemId` reads `status` on Shopee (base + kit page alike) — e.g. relisted by hand. */
function kitLe(loja: Loja, itemId: number, status: string): void {
  const item = loja.itens.get(itemId)!;
  item.base = { ...item.base, item_status: status };
  item.kit = { ...item.kit, item_status: status };
}

function mensagemDe(r: ResultadoPublicacaoKit, codigo: AvisoKit['codigo']): string {
  const aviso = r.avisos.find((a) => a.codigo === codigo);
  expect(aviso).toBeDefined();
  return aviso!.mensagem;
}

describe('(PR #1868 review) `kit-novo-inativo` nunca manda só esperar o que não muda sozinho: UNLIST ⇒ REATIVAR o vínculo NOVO, BANNED ⇒ corrigir a violação, antes de publicar de novo', () => {
  it('o antigo à venda + `--recriar --status UNLIST` ⇒ a frase nomeia o vínculo NOVO e a reativação ANTES do mesmo comando; publicar de novo sozinho (UNLIST ou NORMAL) PARA de novo; o anuncio-status sem linkDocId miraria o ANTIGO; reativado o novo, o mesmo comando exclui o antigo', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);

    const r = await recriar(db, loja, VINCULO_1, { statusPedido: 'UNLIST' });
    expect(r).toMatchObject({ itemId: KIT_2, linkDocId: VINCULO_2, itemStatus: 'UNLIST' });
    const frase = mensagemDe(r, 'kit-novo-inativo');
    expect(frase).toContain(`vínculo ${VINCULO_2}`);
    // The route takes a `linkDocId` only beside exactly ONE produtoId: the
    // sentence names it, and it is the aviso's own produto (the kit).
    expect(r.avisos.find((a) => a.codigo === 'kit-novo-inativo')?.produtoId).toBe(K);
    const reativar = frase.indexOf(
      `anuncio-status com acao reativar, produtoIds [${K}] e linkDocId ${VINCULO_2}`,
    );
    const repetir = frase.indexOf(`--link ${VINCULO_1} --recriar`);
    expect(reativar).toBeGreaterThan(-1);
    expect(repetir).toBeGreaterThan(reativar);

    // Why the LINK must be named: until step 3 both kits are active native
    // links, and the status route's resolver with no `linkDocId` takes the
    // lexically-first — here the OLD kit, so a relist would be a no-op on it.
    expect(VINCULO_1 < VINCULO_2).toBe(true);
    expect(ehKitNativoAtivo(vinculo(db, VINCULO_1)!)).toBe(true);
    expect(ehKitNativoAtivo(vinculo(db, VINCULO_2)!)).toBe(true);
    expect((await resolverLinkVivoPorProduto(asDb(db), INTEGRACAO, K))?.linkDocId).toBe(VINCULO_1);
    expect((await resolverLinkVivoPorProduto(asDb(db), INTEGRACAO, K, VINCULO_2))?.linkDocId).toBe(
      VINCULO_2,
    );

    // …and the named surface DOES relist the new kit: the route's own steps 1
    // and 2 (this resolver, then the pre-check from the STORED reading) pass
    // the new link, which the UNLIST create left `pausado`, while the old one
    // would be skipped as `ja-ativo` without a Shopee call.
    expect(vinculo(db, VINCULO_2)?.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.pausado);
    for (const [linkDocId, esperado] of [
      [VINCULO_2, { pode: true }],
      [VINCULO_1, { pode: false, motivo: 'ja-ativo' }],
    ] as const) {
      const link = await resolverLinkVivoPorProduto(asDb(db), INTEGRACAO, K, linkDocId);
      expect(link?.linkDocId).toBe(linkDocId);
      expect(
        podeMoverAnuncioShopee(
          { item_id: link!.itemId, estadoAnuncio: link!.estadoAnuncio },
          ACAO_STATUS_ANUNCIO.reativar,
        ),
      ).toEqual(esperado);
    }

    // The loop the old sentence sent the operator into: nothing on a re-run
    // relists — not the same flags, not even `--status NORMAL`.
    for (const statusPedido of ['UNLIST', 'NORMAL'] as const) {
      const desde = loja.ops.length;
      const deNovo = await recriar(db, loja, VINCULO_1, { statusPedido });
      expect(codigos(deNovo)).toContain('kit-novo-inativo');
      expect(quantas(loja, 'add_kit_item', desde)).toBe(0);
      expect(quantas(loja, 'delete_item', desde)).toBe(0);
      expect(loja.itens.get(KIT_2)?.base.item_status).toBe('UNLIST');
    }

    // Following the sentence: the NEW kit relisted, THEN the same command.
    kitLe(loja, KIT_2, 'NORMAL');
    const desde = loja.ops.length;
    const fim = await recriar(db, loja, VINCULO_1, { statusPedido: 'UNLIST' });
    expect(codigos(fim)).not.toContain('kit-novo-inativo');
    expect(fim.antecessor).toMatchObject({ itemId: KIT_1, excluido: true, substituido: false });
    expect(quantas(loja, 'delete_item', desde)).toBe(1);
    expect(vinculo(db, VINCULO_1)?.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.removido);
  });

  it('o kit novo BANIDO ⇒ esperar NÃO basta: a frase manda corrigir a violação no Seller Centre ANTES do mesmo comando, nunca reativar; publicar de novo sozinho PARA de novo; corrigido (ativo), o mesmo comando exclui o antigo', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    loja.statusDoProximo = 'BANNED';

    const r = await recriar(db, loja, VINCULO_1);
    const frase = mensagemDe(r, 'kit-novo-inativo');
    expect(frase).toBe(
      `o kit novo ${String(KIT_2)} (vínculo ${VINCULO_2}) está BANNED na Shopee; o kit antigo ` +
        `${String(KIT_1)} só é excluído quando o novo estiver ativo, e um kit banido não volta ` +
        'sozinho — corrija a violação do novo no Seller Centre, aguarde a nova revisão e só ' +
        `então publique de novo com --link ${VINCULO_1} --recriar`,
    );
    // Shopee refuses to relist a banned kit, and the route's pre-check skips it.
    expect(frase).not.toContain('reativ');
    expect(frase).not.toContain('anuncio-status');
    const novo = await resolverLinkVivoPorProduto(asDb(db), INTEGRACAO, K, VINCULO_2);
    expect(
      podeMoverAnuncioShopee(
        { item_id: novo!.itemId, estadoAnuncio: novo!.estadoAnuncio },
        ACAO_STATUS_ANUNCIO.reativar,
      ),
    ).toEqual({ pode: false, motivo: 'anuncio-banido' });

    // Waiting is the loop: a re-run of the same command stops at the gate again.
    for (let i = 0; i < 2; i += 1) {
      const desde = loja.ops.length;
      const deNovo = await recriar(db, loja, VINCULO_1);
      expect(mensagemDe(deNovo, 'kit-novo-inativo')).toBe(frase);
      expect(quantas(loja, 'add_kit_item', desde)).toBe(0);
      expect(quantas(loja, 'delete_item', desde)).toBe(0);
    }

    // Following the sentence: the violation corrected, the review passed.
    kitLe(loja, KIT_2, 'NORMAL');
    const desde = loja.ops.length;
    const fim = await recriar(db, loja, VINCULO_1);
    expect(codigos(fim)).not.toContain('kit-novo-inativo');
    expect(fim.antecessor).toMatchObject({ itemId: KIT_1, excluido: true, substituido: false });
    expect(quantas(loja, 'delete_item', desde)).toBe(1);
  });

  it('⛔ quase-par — REVIEWING / ilegível nomeiam o vínculo novo mas NUNCA mandam reativar nem corrigir (cabe à Shopee mudar): o mesmo comando, depois', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    loja.statusDoProximo = 'REVIEWING';
    const r = await recriar(db, loja, VINCULO_1);
    const frase = mensagemDe(r, 'kit-novo-inativo');
    expect(frase).toBe(
      `o kit novo ${String(KIT_2)} (vínculo ${VINCULO_2}) está REVIEWING na Shopee; o kit ` +
        `antigo ${String(KIT_1)} só é excluído quando o novo estiver ativo — publique de novo ` +
        `com --link ${VINCULO_1} --recriar depois`,
    );

    const base = {
      produtoId: K,
      itemId: KIT_2,
      novoLinkDocId: VINCULO_2,
      antecessorItemId: KIT_1,
      antigoLinkDocId: VINCULO_1,
    };
    expect(avisoKitNovoInativo({ ...base, itemStatus: null }).mensagem).toBe(
      `o kit novo ${String(KIT_2)} (vínculo ${VINCULO_2}) está — na Shopee; o kit antigo ` +
        `${String(KIT_1)} só é excluído quando o novo estiver ativo — publique de novo com ` +
        `--link ${VINCULO_1} --recriar depois`,
    );
    for (const itemStatus of ['REVIEWING', null]) {
      const { mensagem } = avisoKitNovoInativo({ ...base, itemStatus });
      expect(mensagem).not.toContain('reativ');
      expect(mensagem).not.toContain('violação');
    }
    // The three endings stay three: UNLIST relists, BANNED corrects, neither waits.
    expect(avisoKitNovoInativo({ ...base, itemStatus: 'UNLIST' }).mensagem).toContain(
      `linkDocId ${VINCULO_2}`,
    );
    for (const itemStatus of ['UNLIST', 'BANNED']) {
      expect(avisoKitNovoInativo({ ...base, itemStatus }).mensagem).not.toContain('depois');
    }
  });

  it('⛔ quase-par — as OUTRAS recusas do portão seguem com a frase de antes, sem reativação', () => {
    expect(
      avisoKitNovoDivergente({
        produtoId: K,
        itemId: KIT_2,
        motivo: 'receita-divergente kit-k-verde',
        antecessorItemId: KIT_1,
        novoLinkDocId: VINCULO_2,
      }).mensagem,
    ).toBe(
      `o kit ${String(KIT_2)} não está igual à composição do ERP (receita-divergente ` +
        `kit-k-verde); o kit ${String(KIT_1)} não foi excluído — se faltar variação, publique ` +
        `com --link ${VINCULO_2} para anexá-la e rode de novo; se a composição mudou depois, ` +
        'exclua um dos dois no Seller Centre e rode reverificar:anuncio',
    );
    expect(
      avisoKitAlvoMaisNovo({
        produtoId: K,
        alvoItemId: KIT_2,
        alvoLinkDocId: VINCULO_2,
        itemId: KIT_1,
        linkDocId: VINCULO_1,
        comparacao: 'mais-antigo',
      }).mensagem,
    ).toBe(
      `o kit ${String(KIT_2)} (--link ${VINCULO_2}) não é mais antigo que o kit ` +
        `${String(KIT_1)} que o substituiria — nada foi excluído; o kit antigo é o ` +
        `${String(KIT_1)}: rode com --link ${VINCULO_1} --recriar`,
    );
    expect(
      avisoKitAntigoNaoExcluido({ produtoId: K, itemId: KIT_1, linkDocId: VINCULO_1 }).mensagem,
    ).not.toContain('reativ');
  });
});

describe('(H2) o comando de um recriar/converter `incerto` é LITERALMENTE o mesmo', () => {
  it('`--recriar --status UNLIST` ⇒ o comando repete `--status UNLIST`; ⛔ quase-par: NORMAL não imprime --status', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    loja.falhaSemCriar = muitasConexoes();

    const pausado = await recriar(db, loja, VINCULO_1, { statusPedido: 'UNLIST' });

    expect(pausado.desfecho).toBe('incerto');
    expect(pausado.comando).toBe(
      `publicar:anuncio --integracao ${INTEGRACAO} --produto ${K} --link ${VINCULO_1} --recriar --principal comp-a-filho --status UNLIST`,
    );

    loja.falhaSemCriar = muitasConexoes();
    const normal = await recriar(db, loja, VINCULO_1);
    expect(normal.comando).not.toContain('--status');
  });

  it('`--converter-em-kit --status UNLIST` ⇒ o comando repete `--status UNLIST`', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    kitComAnuncioComum(db, loja);
    loja.falhaSemCriar = muitasConexoes();

    const r = await converter(db, loja, { statusPedido: 'UNLIST' });

    expect(r.desfecho).toBe('incerto');
    expect(r.comando).toBe(
      `publicar:anuncio --integracao ${INTEGRACAO} --produto ${K} --converter-em-kit --link ${VINCULO_COMUM} --principal comp-a-filho --status UNLIST`,
    );
  });

  it('o --principal impresso é o DIGITADO, nunca o primeiro alias lexical do mesmo endereço; ⛔ quase-par: sem o digitado, o alias', async () => {
    const db = new FakeDb();
    const loja = novaLoja();
    await kitAntigoComReceitaEditada(db, loja);
    const { contexto, plano } = await ensaiarKitShopee(
      deps(db, loja),
      entrada(),
      { arma: 'kit-recriar', linkDocId: VINCULO_1 },
      resolvedorFake(loja),
    );
    expect(contexto.principalSolicitado).toBe('comp-a-filho');
    // 'comp-a-alias' resolves to the SAME address and sorts BEFORE 'comp-a-filho'.
    const resolucao = new Map(contexto.resolucao);
    resolucao.set('comp-a-alias', {
      ok: true,
      endereco: { itemId: COMP_A_ITEM, modelId: COMP_A_MODELO },
    });

    loja.falhaSemCriar = muitasConexoes();
    const digitado = await recriarKit(deps(db, loja), { ...contexto, resolucao }, plano);
    expect(digitado.comando).toContain('--principal comp-a-filho');

    loja.falhaSemCriar = muitasConexoes();
    const mapeado = await recriarKit(
      deps(db, loja),
      { ...contexto, resolucao, principalSolicitado: null },
      plano,
    );
    expect(mapeado.comando).toContain('--principal comp-a-alias');
  });
});
