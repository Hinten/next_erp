/**
 * `republicarKit` — the `kit-atualizar` arm (reconcile §2.6) — end to end over
 * `fakeDb` + a STATEFUL shop double that behaves as probe #2 measured:
 * `update_kit_item` is PARTIAL, an append (`model_id: 0` + the whole tier list)
 * becomes a new live model, and a quantity or component change on an EXISTING
 * model answers 200 and is SILENTLY IGNORED (P2-c). The double runs the
 * PACKAGE's own `assertUpdateKitItemRequest`, as the real client does before the
 * token is asked for.
 *
 * Round trips (§4.2): RT9 import → republish (over the COMMITTED probe capture
 * of a family kit) and RT10 create → republish (canonical rows AND the legacy
 * bare-path encoding). Mutants: M101–M113, M167–M169, M184 (republish halves),
 * and M98's full form (a crash after the link write, completed by a plain
 * republish).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reavaliarAvisoDeReceitaKit } from '@delfrance/data/admin/avisos';
import {
  SHOPEE_GET_KIT_ITEM_LIMIT_PATH,
  SHOPEE_GET_VARIATIONS_PATH,
  SHOPEE_LOGISTICS_FEE_TYPE,
  SHOPEE_SURFACE,
  SHOPEE_UPDATE_KIT_ITEM_PATH,
  ShopeeNetworkError,
  assertUpdateKitItemRequest,
  shopeeErrorFromEnvelope,
  shopeeItemBaseInfoPayloadSchema,
  shopeeItemListPayloadSchema,
  shopeeKitItemInfoPayloadSchema,
  shopeeKitItemLimitPayloadSchema,
  shopeeLogisticsChannelSchema,
  shopeeModelListPayloadSchema,
  type ShopeeAddKitItemRequest,
  type ShopeeClient,
  type ShopeeUpdateKitItemRequest,
} from '@delfrance/integrations-shopee';
import {
  chaveAvisoReceitaKitShopee,
  chaveReceitaKitErp,
  importacaoShopeeOptionsSchema,
  toOuterRef,
  varianteFakePath,
} from '@delfrance/schemas';
import { avisoCollection, integracaoCollection } from '@delfrance/data/admin/collections';

import {
  MOTIVO_PROBLEMA_PUBLICACAO,
  MOTIVO_PUBLICACAO_BLOQUEADA,
  ShopeePublishBlockedError,
  ShopeePublishRejectedError,
} from '../anuncios/errosPublicacao';
import type { ResolvedorDeImagensShopee } from '../anuncios/fotosPublicacao';
import {
  FIXTURE_KIT_ITEM_INFO_SG_QUANTIDADE_IGNORADA,
  FIXTURE_UPDATE_KIT_ITEM_SG_PARCIAL,
  FIXTURE_UPDATE_KIT_ITEM_SG_SEM_ITEM_ID,
  lerFixture,
} from '../fixtures/wireCorpus';
import type { ImportarKitShopeeDeps } from '../produtos/itemLido';
import { importarKitShopee } from '../produtos/kitShopee';
import { lerAnuncioShopee } from '../produtos/lerAnuncio';
import { limparTaxonomiaShopee } from '../taxonomia/cache';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { MOTIVO_VARIACAO_NAO_ANEXADA, avisoVariacaoNaoAnexada } from './aplicarKit';
import { idDaVariacaoDeKit, idDoVinculoDeKit } from './idsKit';
import { publicarKitShopee } from './publicarKit';
import type { ArmaDeKit, EntradaDeKit } from './prepararKit';
import { MOTIVO_ANEXO_IMPOSSIVEL } from './republicarKit';
import type { KitDeps, ResultadoPublicacaoKit } from './resultadoKit';

/* -------------------------------------------------------------------------- */
/*  Fixture ids by ROLE only (s19-ctx / reconcile §0). Never a real id.         */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

const INTEGRACAO = 'int-1';
const REF_CONTA = toOuterRef(integracaoCollection.docPath({}, INTEGRACAO));
const AGORA = 1_757_000_000_000;

const KIT_ITEM = 2500139870;
const KIT_MODELO = 2000458820;
const KIT_MODELO_2 = 2000458823;
/** The appended model's role id (§0): the shop hands it to the first `model_id: 0`. */
const KIT_MODELO_ANEXADO = 2000458822;
/**
 * The SECOND model one body appends (R6-M02/M03). Not `KIT_MODELO_ANEXADO + 1`:
 * that is `KIT_MODELO_2`, a live model id, and a collision would bind a fixture
 * artefact instead of the append under test.
 */
const KIT_MODELO_ANEXADO_2 = 2000458830;
/** The double-create twin / the second kit's role id. */
const KIT_GEMEO = 2500139873;
const COMP_A_ITEM = 2500139871;
const COMP_A_MODELO = 2000458821;
const COMP_B_ITEM = 2500139872;
const COMP_B_OCULTO = 2000458829;
const CATEGORIA = 107290;
const CANAL = 90_003;

const K = 'kit-k';
const K_AZUL = 'kit-k-azul';
const K_VERDE = 'kit-k-verde';
const K_VERMELHO = 'kit-k-vermelho';
const GRUPO = 'grupo-cor';
const SKU = 'KIT-1';
const VINCULO = idDoVinculoDeKit(INTEGRACAO, KIT_ITEM);

/* --------------------------------- the db --------------------------------- */

function semearComponentes(db: FakeDb): void {
  // A — a varied listing; each ERP component is one of its VARIATION children.
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
  // B — a plain listing on a família-de-um WRAPPER; the kit maps name the MEMBER.
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

const K_COMUM: Json = {
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
};

const VARIACOES = [
  { id: 'var-azul', nome: 'Azul' },
  { id: 'var-verde', nome: 'Verde' },
  { id: 'var-vermelho', nome: 'Vermelho' },
];

function semearGrupo(db: FakeDb, variacoes: readonly Json[] = VARIACOES): void {
  db.seed(`grupoDeVariacoes/${GRUPO}`, { nome: 'Cor', ordem: 1, variacoes });
}

function semearFilho(
  db: FakeDb,
  id: string,
  a: {
    readonly variante: string;
    readonly sku: string | null;
    readonly ordem: number;
    readonly componentesKit: Json;
  },
): void {
  db.seed(`produtos/${id}`, {
    nome: `Kit ${a.variante}`,
    sku: a.sku,
    paiId: K,
    ordem: a.ordem,
    ehKit: true,
    grupoDeVariacoesUid: [GRUPO],
    variacoesUid: [varianteFakePath(GRUPO, a.variante)],
    componentesKit: a.componentesKit,
  });
}

/** K, a 2-child FAMILY on one axis (`Cor`): Azul = A + B, Verde = 2 × A. */
function semearFamilia(db: FakeDb): void {
  db.seed(`produtos/${K}`, { nome: 'Kit camiseta e boné', ...K_COMUM });
  db.seed(`produtos/${K}/extraData/singleton`, {
    descricao: 'Kit com uma camiseta de algodão e um boné, para presente.',
  });
  semearGrupo(db);
  semearFilho(db, K_AZUL, {
    variante: 'var-azul',
    sku: `${SKU}-AZ`,
    ordem: 1,
    componentesKit: {
      'comp-a-filho': { quantidade: 1, limitarEstoque: true },
      'comp-b-membro': { quantidade: 1, limitarEstoque: true },
    },
  });
  semearFilho(db, K_VERDE, {
    variante: 'var-verde',
    sku: `${SKU}-VD`,
    ordem: 2,
    componentesKit: { 'comp-a-filho': { quantidade: 2, limitarEstoque: true } },
  });
}

/** A THIRD child the live kit does not carry yet: Vermelho = 3 × A. */
function semearVermelho(db: FakeDb, over: Json = {}): void {
  semearFilho(db, K_VERMELHO, {
    variante: 'var-vermelho',
    sku: `${SKU}-VM`,
    ordem: 3,
    componentesKit: { 'comp-a-filho': { quantidade: 3, limitarEstoque: true } },
  });
  if (Object.keys(over).length > 0) {
    db.seed(`produtos/${K_VERMELHO}`, { ...(doc(db, `produtos/${K_VERMELHO}`) ?? {}), ...over });
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

/** The model ids the shop hands a fresh kit, in SENT order. */
const MODELOS_NOVOS = [KIT_MODELO, KIT_MODELO_2] as const;

interface ItemNaLoja {
  base: Json;
  kit?: Json;
}

interface Loja {
  readonly client: ShopeeClient;
  readonly ops: string[];
  readonly corposDoAdd: ShopeeAddKitItemRequest[];
  readonly corposDoUpdate: ShopeeUpdateKitItemRequest[];
  readonly itens: Map<number, ItemNaLoja>;
  falhaNaReleitura: Error | null;
  falhaNoUpdate: Error | null;
  /** The appended model reads back WITHOUT its last component row (P2-c's spirit). */
  anexoPerdeUltimaLinha: boolean;
  /** The 200 is answered and the append is silently DROPPED (no model, no option). */
  anexoSome: boolean;
  imagens: readonly string[];
  limites: 'indisponivel' | Json;
}

function naoServido(): Error {
  return shopeeErrorFromEnvelope(
    { error: 'error_not_found', message: null, request_id: null, warning: null },
    { path: SHOPEE_GET_KIT_ITEM_LIMIT_PATH, httpStatus: 404, surface: SHOPEE_SURFACE.business },
  );
}

/** One component row as Shopee READS it back: a plain item's hidden id filled in. */
function componenteLido(c: {
  readonly component_item_id: number;
  readonly component_model_id?: number;
  readonly quantity: number;
  readonly main_component?: boolean;
}): Json {
  return {
    component_item_id: c.component_item_id,
    component_model_id: c.component_model_id ?? OCULTO[c.component_item_id] ?? null,
    quantity: c.quantity,
    main_component: c.main_component === true,
  };
}

function kitDe(item: ItemNaLoja): Json & { model_list: Json[]; tier_variation_list: Json[] } {
  if (item.kit === undefined) throw new Error('fixture: o item não é um kit');
  return item.kit as Json & { model_list: Json[]; tier_variation_list: Json[] };
}

function lojaDeKits(op: { readonly limites?: 'indisponivel' | Json } = {}): Loja {
  const ops: string[] = [];
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
  let proximoAnexo = KIT_MODELO_ANEXADO;
  const loja: Loja = {
    client: {} as ShopeeClient,
    ops,
    corposDoAdd: [],
    corposDoUpdate: [],
    itens,
    falhaNaReleitura: null,
    falhaNoUpdate: null,
    anexoPerdeUltimaLinha: false,
    anexoSome: false,
    imagens: ['img-kit-1'],
    limites: op.limites ?? 'indisponivel',
  };

  const criar = (corpo: ShopeeAddKitItemRequest): number => {
    const s = corpo.item_setting;
    const modelos = s.model_list.map((m, i) => ({
      model_id: MODELOS_NOVOS[i] ?? KIT_MODELO + 100 + i,
      model_sku: m.model_sku ?? null,
      original_price: m.original_price,
      tier_index: [...m.tier_index],
      component_list: m.component_list.map(componenteLido),
    }));
    instalarKit(loja, KIT_ITEM, {
      item_name: s.item_name,
      item_sku: s.item_sku ?? null,
      model_list: modelos,
      tier_variation_list: s.tier_variation_list.map((t) => ({
        name: t.name,
        option_list: t.option_list.map((o) => ({ option: o.option })),
      })),
    });
    return KIT_ITEM;
  };

  const atualizar = (corpo: ShopeeUpdateKitItemRequest): void => {
    const item = itens.get(corpo.item_id);
    if (item === undefined) throw new Error('fixture: update_kit_item num item que não existe');
    const kit = kitDe(item);
    const s = corpo.item_setting ?? {};
    for (const m of s.model_list ?? []) {
      if (m.model_id > 0) {
        const vivo = kit.model_list.find((v) => v.model_id === m.model_id);
        if (vivo === undefined) throw new Error('fixture: model_id desconhecido');
        if (m.original_price !== undefined) vivo.original_price = m.original_price;
        if (m.model_sku !== undefined) vivo.model_sku = m.model_sku;
        // ⚠️ P2-c: the components (a quantity included) are SILENTLY ignored.
        continue;
      }
      if (loja.anexoSome) continue;
      const linhas = (m.component_list ?? []).map(componenteLido);
      kit.model_list.push({
        model_id: proximoAnexo,
        model_sku: m.model_sku ?? null,
        original_price: m.original_price ?? null,
        tier_index: [...m.tier_index],
        component_list: loja.anexoPerdeUltimaLinha ? linhas.slice(0, -1) : linhas,
      });
      proximoAnexo = proximoAnexo === KIT_MODELO_ANEXADO ? KIT_MODELO_ANEXADO_2 : proximoAnexo + 1;
    }
    if (s.tier_variation_list !== undefined && !loja.anexoSome) {
      kit.tier_variation_list = s.tier_variation_list.map((t) => ({
        name: t.name ?? null,
        option_list: t.option_list.map((o) => ({ option: o.option })),
      }));
    }
    if (s.item_name !== undefined) {
      kit.item_name = s.item_name;
      item.base = { ...item.base, item_name: s.item_name };
    }
  };

  const conhecidas: Record<string, (p: never) => Promise<unknown>> = {
    getItemBaseInfo: (p: { itemIds: readonly number[] }) => {
      ops.push('get_item_base_info');
      if (loja.falhaNaReleitura !== null && p.itemIds.includes(KIT_ITEM)) {
        const falha = loja.falhaNaReleitura;
        loja.falhaNaReleitura = null;
        return Promise.reject(falha);
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
    getItemList: () => {
      ops.push('get_item_list');
      const linhas = [...itens.values()].map((i) => ({
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
      ops.push('get_kit_item_info');
      return Promise.resolve(
        shopeeKitItemInfoPayloadSchema.parse({
          product_info: structuredClone(itens.get(p.itemId)?.kit ?? null),
        }),
      );
    },
    getModelList: (p: { itemId: number }) => {
      ops.push('get_model_list');
      const item = itens.get(p.itemId);
      const kit = item?.kit === undefined ? null : kitDe(item);
      return Promise.resolve(
        shopeeModelListPayloadSchema.parse({
          tier_variation: structuredClone(kit?.tier_variation_list ?? []),
          model: (kit?.model_list ?? []).map((m) => ({
            model_id: m.model_id,
            tier_index: m.tier_index,
            model_status: 'MODEL_NORMAL',
            model_sku: m.model_sku,
          })),
        }),
      );
    },
    getKitItemLimit: () => {
      ops.push('get_kit_item_limit');
      if (loja.limites === 'indisponivel') return Promise.reject(naoServido());
      return Promise.resolve(shopeeKitItemLimitPayloadSchema.parse(loja.limites));
    },
    getChannelList: () => {
      ops.push('get_channel_list');
      return Promise.resolve({ logistics_channel_list: [CANAL_DA_LOJA] });
    },
    addKitItem: (corpo: ShopeeAddKitItemRequest) => {
      ops.push('add_kit_item');
      loja.corposDoAdd.push(corpo);
      const itemId = criar(corpo);
      return Promise.resolve({
        request_id: 'req-1',
        error: '',
        message: '',
        warning: '',
        response: { item_id: itemId },
      });
    },
    updateKitItem: (corpo: ShopeeUpdateKitItemRequest) => {
      ops.push('update_kit_item');
      loja.corposDoUpdate.push(structuredClone(corpo));
      // The REAL client runs the package guard before the token is asked for.
      assertUpdateKitItemRequest(corpo);
      if (loja.falhaNoUpdate !== null) {
        const falha = loja.falhaNoUpdate;
        loja.falhaNoUpdate = null;
        return Promise.reject(falha);
      }
      atualizar(corpo);
      // The committed probe capture: the BARE envelope this page answers.
      return Promise.resolve(lerFixture(FIXTURE_UPDATE_KIT_ITEM_SG_PARCIAL));
    },
  };
  const client = new Proxy({} as Record<string, unknown>, {
    get(_alvo, prop) {
      if (typeof prop !== 'string') return undefined;
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

/** A kit as Shopee holds it — the create's echo, or a Seller-Centre kit (RT9). */
function instalarKit(
  loja: Pick<Loja, 'itens'>,
  itemId: number,
  k: {
    readonly item_name: string;
    readonly item_sku: string | null;
    readonly model_list: readonly Json[];
    readonly tier_variation_list: readonly Json[];
  },
): void {
  loja.itens.set(itemId, {
    base: {
      item_id: itemId,
      item_name: k.item_name,
      item_sku: k.item_sku,
      item_status: 'NORMAL',
      has_model: true,
      tag: { kit: true },
      category_id: CATEGORIA,
      create_time: 1791244800,
    },
    kit: {
      item_id: itemId,
      item_name: k.item_name,
      item_sku: k.item_sku,
      item_status: 'NORMAL',
      category_id: CATEGORIA,
      weight: '0.8',
      model_list: structuredClone([...k.model_list]),
      tier_variation_list: structuredClone([...k.tier_variation_list]),
      create_time: 1791244800,
    },
  });
}

function resolvedorFake(loja: Loja): ResolvedorDeImagensShopee {
  return {
    resolver: (fotos, opcoes) => {
      loja.ops.push(`upload:${String(opcoes?.cap ?? 'padrao')}`);
      return Promise.resolve({
        imageIds: [...loja.imagens],
        reutilizadas: 0,
        enviadas: loja.imagens.length,
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

const CRIAR: ArmaDeKit = { arma: 'kit-criar' };
const ATUALIZAR: ArmaDeKit = { arma: 'kit-atualizar', linkDocId: VINCULO };

async function criar(db: FakeDb, loja: Loja, ent: Partial<EntradaDeKit> = {}) {
  return await publicarKitShopee(deps(db, loja), entrada(ent), CRIAR);
}

async function republicar(
  db: FakeDb,
  loja: Loja,
  ent: Partial<EntradaDeKit> = {},
): Promise<ResultadoPublicacaoKit> {
  return await publicarKitShopee(deps(db, loja, AGORA + 60_000), entrada(ent), ATUALIZAR);
}

/** A created family kit, and the shop ops of the republish ALONE from here on. */
async function familiaCriada(op: { readonly limites?: 'indisponivel' | Json } = {}) {
  const db = new FakeDb();
  semearComponentes(db);
  semearFamilia(db);
  const loja = lojaDeKits(op);
  const r = await criar(db, loja);
  expect(r.desfecho).toBe('criado');
  loja.ops.length = 0;
  return { db, loja };
}

/* ------------------------------- db readers --------------------------------- */

function doc(db: FakeDb, caminho: string): Json | undefined {
  return db.store[caminho]?.data as Json | undefined;
}

/** Every `variashopee` naming `linkDocId` (BOTH encodings), as `[child, model_id]`. */
function linhasDoVinculo(db: FakeDb, linkDocId: string): [string, unknown][] {
  return Object.entries(db.store)
    .filter(([p]) => /^produtos\/[^/]+\/variashopee\/[^/]+$/.test(p))
    .filter(([, d]) => {
      const ref = (d.data as Json).produtoShopeeOuterRef;
      return typeof ref === 'string' && ref.endsWith(`/prodshopee/${linkDocId}`);
    })
    .map(([p, d]): [string, unknown] => [p.split('/')[1]!, (d.data as Json).model_id])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : Number(a[1]) - Number(b[1])));
}

function carimboDe(db: FakeDb, filho: string, modelo: number): unknown {
  return doc(db, `produtos/${filho}/variashopee/${idDaVariacaoDeKit(VINCULO, modelo)}`)
    ?.receitaKitConferida;
}

function aviso(db: FakeDb): Json | undefined {
  return doc(db, avisoCollection.docPath({}, chaveAvisoReceitaKitShopee(INTEGRACAO, K)));
}

function contar(loja: Loja, op: string): number {
  return loja.ops.filter((o) => o === op).length;
}

function corpoDoUpdate(loja: Loja): ShopeeUpdateKitItemRequest {
  expect(loja.corposDoUpdate).toHaveLength(1);
  return loja.corposDoUpdate[0]!;
}

function modeloEnviado(loja: Loja, modelId: number) {
  return corpoDoUpdate(loja).item_setting?.model_list?.find((m) => m.model_id === modelId);
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

/** The (conta, K) aviso, decided the way `onProdutoChanged` decides it after a save. */
async function gatilho(db: FakeDb): Promise<string> {
  return await reavaliarAvisoDeReceitaKit(
    asDb(db),
    { integracaoId: INTEGRACAO, kitProdutoId: K },
    'receita-igual-a-shopee',
    { agoraUs: (AGORA + 30_000) * 1000, increment },
  );
}

/** A child's recipe edited in the ERP (a re-seed bumps its `updateTime`). */
function editarReceita(db: FakeDb, filho: string, componentesKit: Json): void {
  db.seed(`produtos/${filho}`, { ...(doc(db, `produtos/${filho}`) ?? {}), componentesKit });
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
/*  (1) RT10 — create → republish over the WRITTEN rows                         */
/* ========================================================================== */

describe('RT10 — kit-atualizar logo após a criação, sobre as linhas ESCRITAS', () => {
  it('liga cada modelo vivo pela LINHA, zero anexados, nenhuma linha nova; reenvia os componentes VIVOS — o id oculto de B incluso (M101)', async () => {
    const { db, loja } = await familiaCriada();
    const linhasAntes = linhasDoVinculo(db, VINCULO);
    const carimbosAntes = [carimboDe(db, K_AZUL, KIT_MODELO), carimboDe(db, K_VERDE, KIT_MODELO_2)];

    const r = await republicar(db, loja);

    expect(r).toMatchObject({
      arma: 'kit-atualizar',
      desfecho: 'atualizado',
      itemId: KIT_ITEM,
      linkDocId: VINCULO,
      kitNativo: true,
      modelos: { vinculados: 2, anexados: 0, semFilho: 0 },
      recusa: null,
      comando: null,
    });
    // EQUAL pair of the fold: B's hidden id vs "no model" ⇒ no receita-divergente.
    expect(r.avisos).toEqual([]);
    expect(contar(loja, 'update_kit_item')).toBe(1);
    expect(contar(loja, 'add_kit_item')).toBe(0);
    const azul = modeloEnviado(loja, KIT_MODELO);
    expect(azul).toEqual({
      model_id: KIT_MODELO,
      tier_index: [0],
      original_price: 99.9,
      model_sku: `${SKU}-AZ`,
      component_list: [
        {
          component_item_id: COMP_A_ITEM,
          component_model_id: COMP_A_MODELO,
          quantity: 1,
          main_component: true,
        },
        // ⚠️ the HIDDEN default model id of the plain component, resent verbatim.
        { component_item_id: COMP_B_ITEM, component_model_id: COMP_B_OCULTO, quantity: 1 },
      ],
    });
    const corpo = corpoDoUpdate(loja);
    expect(corpo.item_setting?.model_list?.some((m) => m.model_id === 0)).toBe(false);
    expect(corpo.item_setting?.tier_variation_list).toBeUndefined();
    expect(corpo.item_setting).toMatchObject({
      item_sku: SKU,
      description_type: 'normal',
      images: { image_id_list: ['img-kit-1'] },
      weight: 0.8,
    });
    expect(corpo.item_setting && 'unlisted' in corpo.item_setting).toBe(false);
    expect(linhasDoVinculo(db, VINCULO)).toEqual(linhasAntes);
    expect([carimboDe(db, K_AZUL, KIT_MODELO), carimboDe(db, K_VERDE, KIT_MODELO_2)]).toEqual(
      carimbosAntes,
    );
  });

  it('(M105) linhas na grafia LEGADA (caminho NU do vínculo, ids automáticos) ainda ligam: nenhuma linha duplicada, zero anexados, recarimbadas no lugar', async () => {
    const { db, loja } = await familiaCriada();
    // The rows as a pre-step-19 writer left them: an auto id, the BARE path.
    for (const [filho, modelo] of [
      [K_AZUL, KIT_MODELO],
      [K_VERDE, KIT_MODELO_2],
    ] as const) {
      const caminho = `produtos/${filho}/variashopee/${idDaVariacaoDeKit(VINCULO, modelo)}`;
      const dados = doc(db, caminho) ?? {};
      delete db.store[caminho];
      db.seed(`produtos/${filho}/variashopee/legado-${String(modelo)}`, {
        ...dados,
        produtoShopeeOuterRef: `produtos/${K}/prodshopee/${VINCULO}`,
        receitaKitConferida: null,
      });
    }
    const docsAntes = Object.keys(db.store)
      .filter((p) => p.includes('/variashopee/'))
      .sort();

    const r = await republicar(db, loja);

    expect(r.modelos).toEqual({ vinculados: 2, anexados: 0, semFilho: 0 });
    expect(
      Object.keys(db.store)
        .filter((p) => p.includes('/variashopee/'))
        .sort(),
    ).toEqual(docsAntes);
    expect(linhasDoVinculo(db, VINCULO)).toEqual([
      [K_AZUL, KIT_MODELO],
      [K_VERDE, KIT_MODELO_2],
    ]);
    // The fold-equal read-back stamps the legacy row where it LIVES.
    expect(doc(db, `produtos/${K_VERDE}/variashopee/legado-${String(KIT_MODELO_2)}`)).toMatchObject(
      {
        receitaKitConferida: chaveReceitaKitErp({ 'comp-a-filho': { quantidade: 2 } }),
      },
    );
  });

  it('⚠️ NEAR-MISS (M105): as linhas de um anúncio REMOVIDO nos mesmos filhos não ligam nada e ficam BYTE A BYTE', async () => {
    const { db, loja } = await familiaCriada();
    const removido = 'vinculo-removido';
    db.seed(`produtos/${K}/prodshopee/${removido}`, {
      item_id: 2500139861,
      contaProdutoShopeeOuterRef: REF_CONTA,
      estadoAnuncio: 'removido',
    });
    db.seed(`produtos/${K_AZUL}/variashopee/velha`, {
      model_id: 2000458802,
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: `documents/produtos/${K}/prodshopee/${removido}`,
      receitaKitConferida: 'uma receita antiga',
    });
    const velha = structuredClone(doc(db, `produtos/${K_AZUL}/variashopee/velha`));

    const r = await republicar(db, loja);

    expect(r.modelos).toEqual({ vinculados: 2, anexados: 0, semFilho: 0 });
    expect(doc(db, `produtos/${K_AZUL}/variashopee/velha`)).toEqual(velha);
  });
});

/* ========================================================================== */
/*  (2) the recipe never goes, and the 200 proves nothing                       */
/* ========================================================================== */

describe('L4(3) / P2-c — a receita nunca vai e a 200 não prova nada', () => {
  it('(M102, M103) uma quantidade mudou no ERP ⇒ AVISO receita-divergente, o update SAI com a quantidade VIVA, e a linha NÃO é recarimbada — o aviso segue ABERTO', async () => {
    const { db, loja } = await familiaCriada();
    const carimboVelho = carimboDe(db, K_VERDE, KIT_MODELO_2);
    editarReceita(db, K_VERDE, { 'comp-a-filho': { quantidade: 3, limitarEstoque: true } });
    expect(await gatilho(db)).toBe('aberto');

    const r = await republicar(db, loja);

    expect(r.avisos).toEqual([
      {
        codigo: 'receita-divergente',
        produtoId: K_VERDE,
        mensagem:
          `a composição da variação ${K_VERDE} mudou no ERP; a Shopee não permite alterá-la — o ` +
          `kit continua com a receita antiga; use --link ${VINCULO} --recriar para criar um kit novo`,
      },
    ]);
    expect(contar(loja, 'update_kit_item')).toBe(1);
    // M101: the components go back as Shopee holds them — 2, never the ERP's 3.
    expect(modeloEnviado(loja, KIT_MODELO_2)?.component_list).toEqual([
      { component_item_id: COMP_A_ITEM, component_model_id: COMP_A_MODELO, quantity: 2 },
    ]);
    // M103: the read-back still says 2 ⇒ the old stamp stays and the aviso stays open.
    expect(carimboDe(db, K_VERDE, KIT_MODELO_2)).toBe(carimboVelho);
    expect(r.avisosResolvidos).toBe(0);
    expect(aviso(db)).toMatchObject({ resolvidoEm: null });
  });

  it('(M110) um repoint #1450 abriu o aviso; a republicação SEM salvar o produto dobra IGUAL, recarimba e fecha `republicado-igual`', async () => {
    const { db, loja } = await familiaCriada();
    // The wrapper instead of its member: the same Shopee address, a new fingerprint.
    const repontado = {
      'comp-a-filho': { quantidade: 1, limitarEstoque: true },
      'comp-b': { quantidade: 1, limitarEstoque: true },
    };
    editarReceita(db, K_AZUL, repontado);
    expect(await gatilho(db)).toBe('aberto');

    const r = await republicar(db, loja);

    expect(r.avisos).toEqual([]);
    expect(carimboDe(db, K_AZUL, KIT_MODELO)).toBe(chaveReceitaKitErp(repontado));
    expect(r.avisosResolvidos).toBe(1);
    expect(aviso(db)).toMatchObject({ resolucaoMotivo: 'republicado-igual' });
    expect(aviso(db)?.resolvidoEm).not.toBeNull();
  });

  it('(M106a) a receita de um filho LIGADO nomeia um componente sem anúncio ⇒ receita-nao-publicavel, nunca receita-divergente — e o update SAI', async () => {
    const { db, loja } = await familiaCriada();
    db.seed('produtos/comp-c', { nome: 'Meia', sku: 'MEIA', paiId: null });
    editarReceita(db, K_AZUL, {
      'comp-a-filho': { quantidade: 1, limitarEstoque: true },
      'comp-b-membro': { quantidade: 1, limitarEstoque: true },
      'comp-c': { quantidade: 1, limitarEstoque: true },
    });
    const carimbo = carimboDe(db, K_AZUL, KIT_MODELO);

    const r = await republicar(db, loja);

    expect(r.avisos.map((a) => [a.codigo, a.produtoId])).toEqual([
      ['receita-nao-publicavel', K_AZUL],
    ]);
    expect(r.avisos[0]?.mensagem).toContain('componente-nao-publicado: comp-c');
    expect(contar(loja, 'update_kit_item')).toBe(1);
    expect(carimboDe(db, K_AZUL, KIT_MODELO)).toBe(carimbo);
  });

  it('(M106b / L1) um kit de 2 itens SEM --principal NÃO recusa a republicação — o principal VOLTA da Shopee', async () => {
    const { db, loja } = await familiaCriada();

    const r = await republicar(db, loja, { principal: null });

    expect(r.desfecho).toBe('atualizado');
    expect(contar(loja, 'update_kit_item')).toBe(1);
    expect(r.avisos.filter((a) => a.codigo === 'principal-diferente')).toEqual([]);
  });

  it('(M112) o anúncio do componente B lê BANNED ⇒ receita-nao-publicavel nomeando componente-anuncio-inativo, sem --recriar; nunca receita-divergente; o update SAI', async () => {
    const { db, loja } = await familiaCriada();
    const b = loja.itens.get(COMP_B_ITEM)!;
    b.base = { ...b.base, item_status: 'BANNED' };

    const r = await republicar(db, loja);

    expect(r.avisos.map((a) => [a.codigo, a.produtoId])).toEqual([
      ['receita-nao-publicavel', K_AZUL],
    ]);
    expect(r.avisos[0]?.mensagem).toContain('componente-anuncio-inativo: comp-b-membro');
    expect(r.avisos[0]?.mensagem).not.toContain('--recriar');
    expect(contar(loja, 'update_kit_item')).toBe(1);
  });

  it('uma variação LIGADA passou a UM componente de quantidade 1 ⇒ SÓ receita-nao-publicavel (kit-componente-unico-quantidade) — nunca também o conselho de --recriar', async () => {
    const { db, loja } = await familiaCriada();
    editarReceita(db, K_VERDE, { 'comp-a-filho': { quantidade: 1, limitarEstoque: true } });

    const r = await republicar(db, loja);

    expect(r.avisos.map((a) => [a.codigo, a.produtoId])).toEqual([
      ['receita-nao-publicavel', K_VERDE],
    ]);
    expect(r.avisos[0]?.mensagem).toContain(
      MOTIVO_PUBLICACAO_BLOQUEADA.kitComponenteUnicoQuantidade,
    );
    expect(contar(loja, 'update_kit_item')).toBe(1);
  });

  it('uma variação LIGADA com a receita VAZIA ⇒ receita-nao-publicavel (kit-sem-componentes), e o update SAI', async () => {
    const { db, loja } = await familiaCriada();
    editarReceita(db, K_VERDE, {});

    const r = await republicar(db, loja);

    expect(r.avisos.map((a) => [a.codigo, a.produtoId])).toEqual([
      ['receita-nao-publicavel', K_VERDE],
    ]);
    expect(r.avisos[0]?.mensagem).toContain(MOTIVO_PUBLICACAO_BLOQUEADA.kitSemComponentes);
    expect(contar(loja, 'update_kit_item')).toBe(1);
  });

  it('(M109) um --principal que NÃO é o principal vivo ⇒ AVISO principal-diferente e o update SAI; ⚠️ near-miss: nomear o próprio principal vivo não avisa', async () => {
    const { db, loja } = await familiaCriada();

    const r = await republicar(db, loja, { principal: 'comp-b-membro' });

    expect(r.avisos).toEqual([
      {
        codigo: 'principal-diferente',
        produtoId: K,
        mensagem:
          'o componente principal informado (comp-b-membro) não é o principal do kit ' +
          `${String(KIT_ITEM)} na Shopee (comp-a-filho); a Shopee não deixa trocar o principal de ` +
          'um kit, então ele foi mantido — para trocá-lo, recrie o kit com ' +
          `--link ${VINCULO} --recriar --principal <componente>`,
      },
    ]);
    expect(contar(loja, 'update_kit_item')).toBe(1);
    // The main is FROZEN: the resent rows still flag A, never B.
    const principais = corpoDoUpdate(loja)
      .item_setting?.model_list?.flatMap((m) => m.component_list ?? [])
      .filter((c) => c.main_component === true);
    expect(principais).toEqual([
      {
        component_item_id: COMP_A_ITEM,
        component_model_id: COMP_A_MODELO,
        quantity: 1,
        main_component: true,
      },
    ]);

    loja.ops.length = 0;
    loja.corposDoUpdate.length = 0;
    const igual = await republicar(db, loja, { principal: 'comp-a-filho' });
    expect(igual.avisos).toEqual([]);
  });
});

/* ========================================================================== */
/*  (3) appends                                                                */
/* ========================================================================== */

describe('anexar — só um filho que NENHUM modelo vivo carrega', () => {
  it('(M104) o filho novo vai como model_id 0 com o tier INTEIRO; a leitura de volta o liga, a linha nasce CARIMBADA (dobra igual)', async () => {
    const { db, loja } = await familiaCriada();
    semearVermelho(db);

    const r = await republicar(db, loja);

    const corpo = corpoDoUpdate(loja);
    const anexos = corpo.item_setting?.model_list?.filter((m) => m.model_id === 0) ?? [];
    expect(anexos).toEqual([
      {
        model_id: 0,
        tier_index: [2],
        original_price: 99.9,
        model_sku: `${SKU}-VM`,
        component_list: [
          { component_item_id: COMP_A_ITEM, component_model_id: COMP_A_MODELO, quantity: 3 },
        ],
      },
    ]);
    expect(corpo.item_setting?.tier_variation_list).toEqual([
      {
        name: 'Cor',
        option_list: [{ option: 'Azul' }, { option: 'Verde' }, { option: 'Vermelho' }],
      },
    ]);
    expect(r.modelos).toEqual({ vinculados: 3, anexados: 1, semFilho: 0 });
    expect(linhasDoVinculo(db, VINCULO)).toEqual([
      [K_AZUL, KIT_MODELO],
      [K_VERDE, KIT_MODELO_2],
      [K_VERMELHO, KIT_MODELO_ANEXADO],
    ]);
    expect(carimboDe(db, K_VERMELHO, KIT_MODELO_ANEXADO)).toBe(
      chaveReceitaKitErp({ 'comp-a-filho': { quantidade: 3 } }),
    );
    expect(r.avisos).toEqual([]);
  });

  it('(M107) a leitura de volta do anexo PERDEU uma linha ⇒ a linha nasce SEM carimbo, receita-divergente, e o aviso ABRE', async () => {
    const { db, loja } = await familiaCriada();
    semearVermelho(db, {
      componentesKit: {
        'comp-a-filho': { quantidade: 2, limitarEstoque: true },
        'comp-b-membro': { quantidade: 1, limitarEstoque: true },
      },
    });
    loja.anexoPerdeUltimaLinha = true;

    const r = await republicar(db, loja);

    expect(carimboDe(db, K_VERMELHO, KIT_MODELO_ANEXADO)).toBeNull();
    expect(r.avisos.map((a) => [a.codigo, a.produtoId])).toEqual([
      ['receita-divergente', K_VERMELHO],
    ]);
    expect(aviso(db)).toMatchObject({ resolvidoEm: null });
    expect((aviso(db)?.params as Json).variacoes).toBe(K_VERMELHO);
  });

  it('(M108 / U1) um modelo VIVO sem linha cuja opção casa com um filho é LIGADO, nunca re-anexado: a linha é escrita, zero anexados', async () => {
    const { db, loja } = await familiaCriada();
    semearVermelho(db);
    await republicar(db, loja);
    // U1: the append landed, the run died before Vermelho's row was written.
    delete db.store[
      `produtos/${K_VERMELHO}/variashopee/${idDaVariacaoDeKit(VINCULO, KIT_MODELO_ANEXADO)}`
    ];
    loja.ops.length = 0;
    loja.corposDoUpdate.length = 0;

    const r = await republicar(db, loja);

    const corpo = corpoDoUpdate(loja);
    expect(corpo.item_setting?.model_list?.some((m) => m.model_id === 0)).toBe(false);
    expect(corpo.item_setting?.tier_variation_list).toBeUndefined();
    expect(modeloEnviado(loja, KIT_MODELO_ANEXADO)).toMatchObject({ tier_index: [2] });
    expect(r.modelos).toEqual({ vinculados: 3, anexados: 0, semFilho: 0 });
    expect(r.avisos).toEqual([]);
    expect(linhasDoVinculo(db, VINCULO)).toEqual([
      [K_AZUL, KIT_MODELO],
      [K_VERDE, KIT_MODELO_2],
      [K_VERMELHO, KIT_MODELO_ANEXADO],
    ]);
  });

  it('(M106c) um 10º filho do ERP num kit de 9 ⇒ NÃO anexado, variacao-nao-anexada, e o update SAI mesmo assim', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    db.seed(`produtos/${K}`, { nome: 'Kit de dez cores', ...K_COMUM });
    db.seed(`produtos/${K}/extraData/singleton`, { descricao: 'Kit de camisetas, em dez cores.' });
    const cores = Array.from({ length: 10 }, (_, i) => ({ id: `var-${i}`, nome: `Cor ${i}` }));
    semearGrupo(db, cores);
    const filho = (i: number): void =>
      semearFilho(db, `kit-k-${i}`, {
        variante: `var-${i}`,
        sku: `${SKU}-${i}`,
        ordem: i,
        componentesKit: { 'comp-a-filho': { quantidade: 2, limitarEstoque: true } },
      });
    for (let i = 0; i < 9; i += 1) filho(i);
    const loja = lojaDeKits();
    expect((await criar(db, loja)).desfecho).toBe('criado');
    filho(9);
    loja.ops.length = 0;

    const r = await republicar(db, loja);

    expect(r.avisos).toEqual([
      avisoVariacaoNaoAnexada('kit-k-9', MOTIVO_VARIACAO_NAO_ANEXADA.variacoesDemais),
    ]);
    expect(contar(loja, 'update_kit_item')).toBe(1);
    expect(corpoDoUpdate(loja).item_setting?.model_list).toHaveLength(9);
    expect(corpoDoUpdate(loja).item_setting?.model_list?.some((m) => m.model_id === 0)).toBe(false);
  });

  /**
   * K on ONE axis of `total` colours: the first `criados` children exist when
   * the kit is created on Shopee, the rest are ERP children added afterwards.
   */
  async function kitDeCores(total: number, criados: number) {
    const db = new FakeDb();
    semearComponentes(db);
    db.seed(`produtos/${K}`, { nome: 'Kit de cores', ...K_COMUM });
    db.seed(`produtos/${K}/extraData/singleton`, {
      descricao: 'Kit de camisetas, em várias cores.',
    });
    semearGrupo(
      db,
      Array.from({ length: total }, (_, i) => ({ id: `var-${i}`, nome: `Cor ${i}` })),
    );
    const filho = (i: number): void =>
      semearFilho(db, `kit-k-${i}`, {
        variante: `var-${i}`,
        sku: `${SKU}-${i}`,
        ordem: i,
        componentesKit: { 'comp-a-filho': { quantidade: 2, limitarEstoque: true } },
      });
    for (let i = 0; i < criados; i += 1) filho(i);
    const loja = lojaDeKits();
    expect((await criar(db, loja)).desfecho).toBe('criado');
    for (let i = criados; i < total; i += 1) filho(i);
    loja.ops.length = 0;
    return { db, loja };
  }

  it('(R6-M02) 8 modelos vivos + 2 filhos NOVOS ⇒ o cap de 9 conta o anexo DESTE corpo: UM anexo, o outro variacao-nao-anexada (variacoesDemais), e o update SAI com 9 modelos', async () => {
    const { loja, db } = await kitDeCores(10, 8);

    const r = await republicar(db, loja);

    expect(r.avisos).toEqual([
      avisoVariacaoNaoAnexada('kit-k-9', MOTIVO_VARIACAO_NAO_ANEXADA.variacoesDemais),
    ]);
    const modelos = corpoDoUpdate(loja).item_setting?.model_list ?? [];
    expect(modelos).toHaveLength(9);
    expect(modelos.filter((m) => m.model_id === 0).map((m) => [m.tier_index, m.model_sku])).toEqual(
      [[[8], `${SKU}-8`]],
    );
    expect(
      corpoDoUpdate(loja).item_setting?.tier_variation_list?.[0]?.option_list.map((o) => o.option),
    ).toEqual(Array.from({ length: 9 }, (_, i) => `Cor ${i}`));
    expect(r.modelos).toEqual({ vinculados: 9, anexados: 1, semFilho: 0 });
  });

  it('⚠️ NEAR-MISS (R6-M02): 7 modelos vivos + 2 filhos novos cabem ⇒ AMBOS anexados, 9 modelos, nenhum aviso', async () => {
    const { loja, db } = await kitDeCores(9, 7);

    const r = await republicar(db, loja);

    expect(r.avisos).toEqual([]);
    const modelos = corpoDoUpdate(loja).item_setting?.model_list ?? [];
    expect(modelos).toHaveLength(9);
    expect(modelos.filter((m) => m.model_id === 0).map((m) => m.tier_index)).toEqual([[7], [8]]);
    expect(r.modelos).toEqual({ vinculados: 9, anexados: 2, semFilho: 0 });
  });

  it('(R6-M03) 2 vivos + 2 filhos NOVOS ⇒ cada anexo na SUA opção nova (tier_index [2] e [3]), o tier com 4 opções, e a leitura de volta liga e carimba os dois', async () => {
    const { db, loja } = await familiaCriada();
    semearGrupo(db, [...VARIACOES, { id: 'var-amarelo', nome: 'Amarelo' }]);
    semearVermelho(db);
    semearFilho(db, 'kit-k-amarelo', {
      variante: 'var-amarelo',
      sku: `${SKU}-AM`,
      ordem: 4,
      componentesKit: { 'comp-a-filho': { quantidade: 4, limitarEstoque: true } },
    });

    const r = await republicar(db, loja);

    const corpo = corpoDoUpdate(loja);
    expect(corpo.item_setting?.model_list?.filter((m) => m.model_id === 0)).toEqual([
      {
        model_id: 0,
        tier_index: [2],
        original_price: 99.9,
        model_sku: `${SKU}-VM`,
        component_list: [
          { component_item_id: COMP_A_ITEM, component_model_id: COMP_A_MODELO, quantity: 3 },
        ],
      },
      {
        model_id: 0,
        tier_index: [3],
        original_price: 99.9,
        model_sku: `${SKU}-AM`,
        component_list: [
          { component_item_id: COMP_A_ITEM, component_model_id: COMP_A_MODELO, quantity: 4 },
        ],
      },
    ]);
    expect(corpo.item_setting?.tier_variation_list).toEqual([
      {
        name: 'Cor',
        option_list: [
          { option: 'Azul' },
          { option: 'Verde' },
          { option: 'Vermelho' },
          { option: 'Amarelo' },
        ],
      },
    ]);
    expect(r.modelos).toEqual({ vinculados: 4, anexados: 2, semFilho: 0 });
    expect(r.avisos).toEqual([]);
    expect(linhasDoVinculo(db, VINCULO)).toEqual([
      ['kit-k-amarelo', KIT_MODELO_ANEXADO_2],
      [K_AZUL, KIT_MODELO],
      [K_VERDE, KIT_MODELO_2],
      [K_VERMELHO, KIT_MODELO_ANEXADO],
    ]);
    expect(carimboDe(db, K_VERMELHO, KIT_MODELO_ANEXADO)).toBe(
      chaveReceitaKitErp({ 'comp-a-filho': { quantidade: 3 } }),
    );
    expect(carimboDe(db, 'kit-k-amarelo', KIT_MODELO_ANEXADO_2)).toBe(
      chaveReceitaKitErp({ 'comp-a-filho': { quantidade: 4 } }),
    );
  });

  /** Two NEW children (after the live Azul/Verde) on the grupo names given. */
  function semearDoisNovos(db: FakeDb, nomes: readonly [string, string]): void {
    semearGrupo(db, [
      ...VARIACOES,
      { id: 'var-roxo', nome: nomes[0] },
      { id: 'var-roxo-2', nome: nomes[1] },
    ]);
    semearFilho(db, 'kit-k-roxo', {
      variante: 'var-roxo',
      sku: `${SKU}-RX`,
      ordem: 3,
      componentesKit: { 'comp-a-filho': { quantidade: 3, limitarEstoque: true } },
    });
    semearFilho(db, 'kit-k-roxo-2', {
      variante: 'var-roxo-2',
      sku: `${SKU}-RX2`,
      ordem: 4,
      componentesKit: { 'comp-a-filho': { quantidade: 4, limitarEstoque: true } },
    });
  }

  it("(R6-M04) dois filhos NOVOS cujas variantes dobram ao MESMO texto ('Roxo' ≡ ' Roxo ') ⇒ só o primeiro é anexado, o segundo variacao-nao-anexada (semOpcao), e o tier nunca repete uma opção", async () => {
    const { db, loja } = await familiaCriada();
    semearDoisNovos(db, ['Roxo', ' Roxo ']);

    const r = await republicar(db, loja);

    const corpo = corpoDoUpdate(loja);
    expect(
      corpo.item_setting?.model_list
        ?.filter((m) => m.model_id === 0)
        .map((m) => [m.tier_index, m.model_sku]),
    ).toEqual([[[2], `${SKU}-RX`]]);
    expect(corpo.item_setting?.tier_variation_list?.[0]?.option_list).toEqual([
      { option: 'Azul' },
      { option: 'Verde' },
      { option: 'Roxo' },
    ]);
    expect(r.avisos).toEqual([
      {
        codigo: 'variacao-nao-anexada',
        produtoId: 'kit-k-roxo-2',
        mensagem: `a variação kit-k-roxo-2 não foi anexada ao kit: ${MOTIVO_ANEXO_IMPOSSIVEL.semOpcao}`,
      },
    ]);
    expect(r.modelos).toEqual({ vinculados: 3, anexados: 1, semFilho: 0 });
  });

  it("⚠️ NEAR-MISS (R6-M04): 'Roxo' vs 'roxo' — a dobra mantém a CAIXA ⇒ os DOIS são anexados, em [2] e [3], nenhum aviso", async () => {
    const { db, loja } = await familiaCriada();
    semearDoisNovos(db, ['Roxo', 'roxo']);

    const r = await republicar(db, loja);

    const corpo = corpoDoUpdate(loja);
    expect(
      corpo.item_setting?.model_list
        ?.filter((m) => m.model_id === 0)
        .map((m) => [m.tier_index, m.model_sku]),
    ).toEqual([
      [[2], `${SKU}-RX`],
      [[3], `${SKU}-RX2`],
    ]);
    expect(corpo.item_setting?.tier_variation_list?.[0]?.option_list).toEqual([
      { option: 'Azul' },
      { option: 'Verde' },
      { option: 'Roxo' },
      { option: 'roxo' },
    ]);
    expect(r.avisos).toEqual([]);
    expect(r.modelos).toEqual({ vinculados: 4, anexados: 2, semFilho: 0 });
    expect(linhasDoVinculo(db, VINCULO)).toEqual([
      [K_AZUL, KIT_MODELO],
      ['kit-k-roxo', KIT_MODELO_ANEXADO],
      ['kit-k-roxo-2', KIT_MODELO_ANEXADO_2],
      [K_VERDE, KIT_MODELO_2],
    ]);
  });

  it('um filho cuja variante REPETE uma opção viva não é anexado — e o aviso usa a MESMA frase do construtor compartilhado', async () => {
    const { db, loja } = await familiaCriada();
    // A second child on the Azul variante (a data hole): no option of its own.
    semearFilho(db, K_VERMELHO, {
      variante: 'var-azul',
      sku: `${SKU}-VM`,
      ordem: 3,
      componentesKit: { 'comp-a-filho': { quantidade: 3, limitarEstoque: true } },
    });

    const r = await republicar(db, loja);

    expect(r.avisos).toEqual([
      {
        codigo: 'variacao-nao-anexada',
        produtoId: K_VERMELHO,
        mensagem: `a variação ${K_VERMELHO} não foi anexada ao kit: ${MOTIVO_ANEXO_IMPOSSIVEL.semOpcao}`,
      },
    ]);
    // The shared builder's shape, reason aside.
    const compartilhado = avisoVariacaoNaoAnexada(
      K_VERMELHO,
      MOTIVO_VARIACAO_NAO_ANEXADA.doisEixos,
    );
    expect(r.avisos[0]?.mensagem.startsWith(compartilhado.mensagem.split(': ')[0]!)).toBe(true);
    expect(corpoDoUpdate(loja).item_setting?.model_list?.some((m) => m.model_id === 0)).toBe(false);
  });

  it('um filho NOVO sem preço não é anexado (semPreco) — o update SAI com o preço e o SKU do ERP nos LIGADOS', async () => {
    const { db, loja } = await familiaCriada();
    // The children now price on their own (no propagation), and the new one has none.
    db.seed(`produtos/${K}`, {
      ...(doc(db, `produtos/${K}`) ?? {}),
      propagatePriceToChildren: false,
    });
    for (const f of [K_AZUL, K_VERDE]) {
      db.seed(`produtos/${f}`, {
        ...(doc(db, `produtos/${f}`) ?? {}),
        precos: { 'tab-normal': { valor: 49.9 } },
      });
    }
    db.seed(`produtos/${K_AZUL}`, { ...(doc(db, `produtos/${K_AZUL}`) ?? {}), sku: 'KIT-1-AZUL' });
    semearVermelho(db);

    const r = await republicar(db, loja);

    expect(r.avisos).toEqual([
      {
        codigo: 'variacao-nao-anexada',
        produtoId: K_VERMELHO,
        mensagem: `a variação ${K_VERMELHO} não foi anexada ao kit: ${MOTIVO_ANEXO_IMPOSSIVEL.semPreco}`,
      },
    ]);
    expect(contar(loja, 'update_kit_item')).toBe(1);
    // A BOUND child's price and SKU are the ERP's, never the live ones.
    expect(modeloEnviado(loja, KIT_MODELO)).toMatchObject({
      original_price: 49.9,
      model_sku: 'KIT-1-AZUL',
    });
  });

  it('a Shopee responde 200 e DESCARTA o anexo ⇒ zero anexados, e a leitura de volta avisa variacao-nao-anexada (publique de novo)', async () => {
    const { db, loja } = await familiaCriada();
    semearVermelho(db);
    loja.anexoSome = true;

    const r = await republicar(db, loja);

    expect(corpoDoUpdate(loja).item_setting?.model_list?.some((m) => m.model_id === 0)).toBe(true);
    expect(r.modelos).toEqual({ vinculados: 2, anexados: 0, semFilho: 0 });
    expect(r.avisos).toEqual([
      avisoVariacaoNaoAnexada(K_VERMELHO, MOTIVO_VARIACAO_NAO_ANEXADA.kitJaExistia),
    ]);
  });
});

/* ========================================================================== */
/*  (4) what DOES refuse                                                       */
/* ========================================================================== */

describe('o que recusa a republicação — só linhas que NÃO são receita (§2.6)', () => {
  it('(M111) sem --principal, a faixa de preço SERVIDA para a categoria do principal VIVO recusa preco-fora-da-faixa, zero update; ⚠️ near-miss: dentro da faixa, sai', async () => {
    // Created on a host that serves no kit band; the band appears afterwards
    // (a fresh cache window), and only the republish reads it.
    const fora = await familiaCriada();
    limparTaxonomiaShopee();
    fora.loja.limites = { price_limit: { min_limit: 1, max_limit: 50 } };

    const erro = await recusaDe(republicar(fora.db, fora.loja, { principal: null }));

    expect(erro.problemas.map((p) => [p.motivo, p.campo])).toEqual([
      [MOTIVO_PUBLICACAO_BLOQUEADA.precoForaDaFaixa, `filhos.${K_AZUL}`],
      [MOTIVO_PUBLICACAO_BLOQUEADA.precoForaDaFaixa, `filhos.${K_VERDE}`],
    ]);
    expect(contar(fora.loja, 'get_kit_item_limit')).toBe(1);
    expect(contar(fora.loja, 'update_kit_item')).toBe(0);

    limparTaxonomiaShopee();
    const dentro = await familiaCriada();
    limparTaxonomiaShopee();
    dentro.loja.limites = { price_limit: { min_limit: 1, max_limit: 1_000 } };
    expect((await republicar(dentro.db, dentro.loja, { principal: null })).desfecho).toBe(
      'atualizado',
    );
  });

  it('(cut-note 6) K com o NOME em branco não recusa sem-nome: o nome do ANÚNCIO (o do vínculo) vence, e as fotos sobem', async () => {
    const { db, loja } = await familiaCriada();
    db.seed(`produtos/${K}`, { ...(doc(db, `produtos/${K}`) ?? {}), nome: '  ' });

    const r = await republicar(db, loja);

    expect(r.desfecho).toBe('atualizado');
    expect(corpoDoUpdate(loja).item_setting?.item_name).toBe('Kit camiseta e boné');
    expect(loja.ops.some((o) => o.startsWith('upload'))).toBe(true);
  });

  it('(M169) SKU de K vazio ou com espaços NÃO recusa: AVISO sku-do-kit-nao-enviado com o motivo, e o item_sku VIVO volta', async () => {
    for (const [sku, motivo] of [
      [null, MOTIVO_PUBLICACAO_BLOQUEADA.kitSemSku],
      [`${SKU} `, MOTIVO_PUBLICACAO_BLOQUEADA.kitSkuComEspacos],
    ] as const) {
      limparTaxonomiaShopee();
      const { db, loja } = await familiaCriada();
      db.seed(`produtos/${K}`, { ...(doc(db, `produtos/${K}`) ?? {}), sku });

      const r = await republicar(db, loja);

      expect(r.avisos.map((a) => a.codigo)).toEqual(['sku-do-kit-nao-enviado']);
      expect(r.avisos[0]?.mensagem).toContain(`(${motivo})`);
      expect(corpoDoUpdate(loja).item_setting?.item_sku).toBe(SKU);
    }
  });

  it('(M184) sem-peso CARREGADO com fotos em K ⇒ a recusa é SÓ sem-peso (nunca sem-fotos), e nada sobe; ⚠️ near-miss: fotos resolvidas e VAZIAS ⇒ sem-fotos', async () => {
    const semPeso = await familiaCriada();
    semPeso.db.seed(`produtos/${K}`, {
      ...(doc(semPeso.db, `produtos/${K}`) ?? {}),
      pesoBrutoKg: null,
    });

    const erro = await recusaDe(republicar(semPeso.db, semPeso.loja));

    expect(erro.problemas.map((p) => p.motivo)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.semPeso]);
    expect(semPeso.loja.ops.some((o) => o.startsWith('upload'))).toBe(false);
    expect(contar(semPeso.loja, 'update_kit_item')).toBe(0);

    limparTaxonomiaShopee();
    const semFoto = await familiaCriada();
    semFoto.loja.imagens = [];
    const erro2 = await recusaDe(republicar(semFoto.db, semFoto.loja));
    expect(erro2.problemas.map((p) => p.motivo)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.semFotos]);
  });

  it('o kit lê SELLER_DELETE ⇒ listagem-removida (a frase do kit), o vínculo fica `removido`, zero update e zero foto; ⚠️ near-miss: UNLIST segue', async () => {
    const { db, loja } = await familiaCriada();
    const kit = loja.itens.get(KIT_ITEM)!;
    kit.base = { ...kit.base, item_status: 'SELLER_DELETE' };

    const erro = await recusaDe(republicar(db, loja));

    expect(erro.problemas).toEqual([
      {
        campo: null,
        motivo: MOTIVO_PUBLICACAO_BLOQUEADA.listagemRemovida,
        mensagem:
          `o kit nativo ${String(KIT_ITEM)} foi excluído na Shopee — publique com --link ` +
          `${VINCULO} --recriar para criar um novo`,
      },
    ]);
    expect(doc(db, `produtos/${K}/prodshopee/${VINCULO}`)?.estadoAnuncio).toBe('removido');
    expect(contar(loja, 'update_kit_item')).toBe(0);
    expect(loja.ops.some((o) => o.startsWith('upload'))).toBe(false);

    // A PURGED kit (no base row at all) is a deleted one too (S2C-07).
    const purgado = await familiaCriada();
    purgado.loja.itens.delete(KIT_ITEM);
    const erroPurgado = await recusaDe(republicar(purgado.db, purgado.loja));
    expect(erroPurgado.problemas.map((p) => p.motivo)).toEqual([
      MOTIVO_PUBLICACAO_BLOQUEADA.listagemRemovida,
    ]);

    // ⚠️ NEAR-MISS: a PAUSED kit is live — the republish goes out.
    const pausado = await familiaCriada();
    const kitPausado = pausado.loja.itens.get(KIT_ITEM)!;
    kitPausado.base = { ...kitPausado.base, item_status: 'UNLIST' };
    expect((await republicar(pausado.db, pausado.loja)).desfecho).toBe('atualizado');
    expect(contar(pausado.loja, 'update_kit_item')).toBe(1);
  });

  it('⛔ um vínculo NATIVO cujo item a Shopee NÃO serve como kit ⇒ erro de defeito, sem foto, sem update e sem escrita', async () => {
    const { db, loja } = await familiaCriada();
    const kit = loja.itens.get(KIT_ITEM)!;
    kit.base = { ...kit.base, tag: { kit: false }, has_model: false };
    const escritas = db.writes.length;

    await expect(republicar(db, loja)).rejects.toThrow(/não é servido como kit/);

    expect(loja.ops.some((o) => o.startsWith('upload'))).toBe(false);
    expect(contar(loja, 'update_kit_item')).toBe(0);
    expect(db.writes.length).toBe(escritas);
  });

  it('a Shopee RECUSA o update_kit_item (a captura "product is not found") ⇒ ShopeePublishRejectedError na etapa update_kit_item, classificado pelo kit', async () => {
    const { db, loja } = await familiaCriada();
    const corpo = lerFixture(FIXTURE_UPDATE_KIT_ITEM_SG_SEM_ITEM_ID) as {
      error: string;
      message: string;
    };
    loja.falhaNoUpdate = shopeeErrorFromEnvelope(
      { error: corpo.error, message: corpo.message, request_id: null, warning: null },
      { path: SHOPEE_UPDATE_KIT_ITEM_PATH, httpStatus: 200, surface: SHOPEE_SURFACE.business },
    );

    const erro = await republicar(db, loja).then(
      () => null,
      (e: unknown) => e,
    );

    expect(erro).toBeInstanceOf(ShopeePublishRejectedError);
    expect(erro).toMatchObject({
      etapa: 'update_kit_item',
      shopeeCode: '.',
      itemId: KIT_ITEM,
      problemas: [{ motivo: MOTIVO_PROBLEMA_PUBLICACAO.kitInexistente }],
    });
  });

  it('⛔ uma falha de REDE no update propaga como está (regra 6) — a republicação é idempotente, roda-se de novo', async () => {
    const { db, loja } = await familiaCriada();
    loja.falhaNoUpdate = new ShopeeNetworkError('caiu no update');

    await expect(republicar(db, loja)).rejects.toBeInstanceOf(ShopeeNetworkError);
  });
});

/* ========================================================================== */
/*  (5) the completion of an interrupted create (S2C-06, §2.5.4 C2)             */
/* ========================================================================== */

/** C2: the create's link write landed, the read-back crashed — no #2, no rows. */
async function criacaoInterrompida() {
  const db = new FakeDb();
  semearComponentes(db);
  semearFamilia(db);
  const loja = lojaDeKits();
  loja.falhaNaReleitura = new ShopeeNetworkError('caiu na releitura');
  await expect(criar(db, loja)).rejects.toBeInstanceOf(ShopeeNetworkError);
  expect(doc(db, `produtos/${K}/prodshopee/${VINCULO}`)?.item_status ?? null).toBeNull();
  expect(linhasDoVinculo(db, VINCULO)).toEqual([]);
  loja.ops.length = 0;
  return { db, loja };
}

describe('a republicação COMPLETA uma criação interrompida (S2C-06)', () => {
  it('(M98, completo) C2 ⇒ kit-atualizar: zero add_kit_item, cada filho ligado pela OPÇÃO, cada linha UMA vez, zero anexados, o #2 escrito', async () => {
    const { db, loja } = await criacaoInterrompida();

    const r = await republicar(db, loja);

    expect(contar(loja, 'add_kit_item')).toBe(0);
    expect(contar(loja, 'update_kit_item')).toBe(1);
    expect(r.modelos).toEqual({ vinculados: 2, anexados: 0, semFilho: 0 });
    expect(linhasDoVinculo(db, VINCULO)).toEqual([
      [K_AZUL, KIT_MODELO],
      [K_VERDE, KIT_MODELO_2],
    ]);
    expect(doc(db, `produtos/${K}/prodshopee/${VINCULO}`)).toMatchObject({
      item_status: 'NORMAL',
      estadoAnuncio: 'ativo',
      kitNativo: true,
    });
    expect(carimboDe(db, K_AZUL, KIT_MODELO)).toBe(
      chaveReceitaKitErp({ 'comp-a-filho': { quantidade: 1 }, 'comp-b-membro': { quantidade: 1 } }),
    );
  });

  it('(M168) C2 + sem-peso ⇒ o #2 e TODAS as linhas são escritos, zero update_kit_item, e a recusa vem DEPOIS', async () => {
    const { db, loja } = await criacaoInterrompida();
    db.seed(`produtos/${K}`, { ...(doc(db, `produtos/${K}`) ?? {}), pesoBrutoKg: null });

    const erro = await recusaDe(republicar(db, loja));

    expect(erro.problemas.map((p) => p.motivo)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.semPeso]);
    expect(contar(loja, 'update_kit_item')).toBe(0);
    expect(doc(db, `produtos/${K}/prodshopee/${VINCULO}`)?.item_status).toBe('NORMAL');
    expect(linhasDoVinculo(db, VINCULO)).toEqual([
      [K_AZUL, KIT_MODELO],
      [K_VERDE, KIT_MODELO_2],
    ]);
  });

  it('(R6-M13 RP6) um vínculo SEM o #2 (item_status nunca escrito) cujas linhas JÁ existem ainda completa ANTES da recusa: o #2 é escrito, zero update', async () => {
    // Every bound model has its row, so only the missing #2 asks for the
    // completion — the `semLeituraDeVolta` half of `precisaCompletar`.
    const { db, loja } = await familiaCriada();
    const caminho = `produtos/${K}/prodshopee/${VINCULO}`;
    const semDois: Json = { ...(doc(db, caminho) ?? {}) };
    delete semDois.item_status;
    db.seed(caminho, semDois);
    db.seed(`produtos/${K}`, { ...(doc(db, `produtos/${K}`) ?? {}), pesoBrutoKg: null });
    expect(linhasDoVinculo(db, VINCULO)).toEqual([
      [K_AZUL, KIT_MODELO],
      [K_VERDE, KIT_MODELO_2],
    ]);

    const erro = await recusaDe(republicar(db, loja));

    expect(erro.problemas.map((p) => p.motivo)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.semPeso]);
    expect(contar(loja, 'update_kit_item')).toBe(0);
    expect(doc(db, caminho)?.item_status).toBe('NORMAL');
  });

  it('(M113) as variantes mudaram de ORDEM no grupo desde a criação ⇒ cada modelo vai para o filho cuja variante é a SUA opção viva, nunca pela posição recalculada', async () => {
    const { db, loja } = await criacaoInterrompida();
    semearGrupo(db, [VARIACOES[1]!, VARIACOES[0]!, VARIACOES[2]!]);

    const r = await republicar(db, loja);

    expect(linhasDoVinculo(db, VINCULO)).toEqual([
      [K_AZUL, KIT_MODELO],
      [K_VERDE, KIT_MODELO_2],
    ]);
    expect(r.avisos).toEqual([]);
    expect(modeloEnviado(loja, KIT_MODELO)?.model_sku).toBe(`${SKU}-AZ`);
  });

  it('(M113) um modelo vivo SEM filho no ERP é reenviado como está e avisa modelo-sem-filho; nenhuma linha para ele', async () => {
    const { db, loja } = await familiaCriada();
    delete db.store[`produtos/${K_VERDE}`];

    const r = await republicar(db, loja);

    expect(r.avisos.map((a) => a.codigo)).toEqual(['modelo-sem-filho']);
    expect(r.modelos).toEqual({ vinculados: 1, anexados: 0, semFilho: 1 });
    // Unbound ⇒ its LIVE price and SKU go back, its live rows verbatim.
    expect(modeloEnviado(loja, KIT_MODELO_2)).toEqual({
      model_id: KIT_MODELO_2,
      tier_index: [1],
      original_price: 99.9,
      model_sku: `${SKU}-VD`,
      component_list: [
        { component_item_id: COMP_A_ITEM, component_model_id: COMP_A_MODELO, quantity: 2 },
      ],
    });
  });
});

/* ========================================================================== */
/*  (6) M167 — a republish never scans (L10(4))                                 */
/* ========================================================================== */

describe('(M167) a republicação NUNCA busca pelo SKU — L10(4)', () => {
  it('um gêmeo NÃO vinculado com o SKU de K na lista ⇒ kit-atualizar envia o update com ZERO get_item_list e nenhum aviso o nomeia', async () => {
    const { db, loja } = await familiaCriada();
    instalarKit(loja, KIT_GEMEO, {
      item_name: 'Kit gêmeo',
      item_sku: SKU,
      model_list: [],
      tier_variation_list: [],
    });

    const r = await republicar(db, loja);

    expect(contar(loja, 'get_item_list')).toBe(0);
    expect(contar(loja, 'update_kit_item')).toBe(1);
    expect(r.avisos.some((a) => a.mensagem.includes(String(KIT_GEMEO)))).toBe(false);
  });

  it('⚠️ NEAR-MISS: a MESMA loja como kit-criar ⇒ get_item_list chamado e kit-ja-existe-na-shopee nomeando o gêmeo, zero add_kit_item', async () => {
    const { db, loja } = await familiaCriada();
    instalarKit(loja, KIT_GEMEO, {
      item_name: 'Kit gêmeo',
      item_sku: SKU,
      model_list: [],
      tier_variation_list: [],
    });

    const erro = await recusaDe(criar(db, loja));

    expect(contar(loja, 'get_item_list')).toBe(1);
    expect(erro.problemas.map((p) => p.motivo)).toEqual([
      MOTIVO_PUBLICACAO_BLOQUEADA.kitJaExisteNaShopee,
    ]);
    expect(erro.problemas[0]?.mensagem).toContain(String(KIT_GEMEO));
    expect(contar(loja, 'add_kit_item')).toBe(0);
  });
});

/* ========================================================================== */
/*  (7) RT9 — import → republish, over the COMMITTED probe capture              */
/* ========================================================================== */

/**
 * The family kit of probe #2 (`get_kit_item_info.sg-quantidade-ignorada.json`)
 * with its THIRD (appended) model dropped — a named transform: the 2-model kit
 * as Seller Centre / an earlier create left it. A's models 2000458821 /
 * 2000458824, B plain with its hidden id 2000458829.
 */
function kitDaSondaComDoisModelos(): Json & { model_list: Json[]; tier_variation_list: Json[] } {
  const corpo = lerFixture(FIXTURE_KIT_ITEM_INFO_SG_QUANTIDADE_IGNORADA) as {
    response: { product_info: Json & { model_list: Json[]; tier_variation_list: Json[] } };
  };
  const kit = structuredClone(corpo.response.product_info);
  kit.model_list = kit.model_list.slice(0, 2);
  const tier = kit.tier_variation_list[0] as { option_list: Json[] };
  tier.option_list = tier.option_list.slice(0, 2);
  return kit;
}

const SONDA_SKU = 'SONDA-KIT2';
const COMP_A_MODELO_B = 2000458824;
const COMP_A_MODELO_C = 2000458825;
const GRUPO_KIT = 'grupo-kit';

/** The ERP that matches the capture: K + two children, A's three variation children. */
function semearErpDaSonda(db: FakeDb): void {
  semearComponentes(db);
  for (const [id, modelo] of [
    ['comp-a-filho-b', COMP_A_MODELO_B],
    ['comp-a-filho-c', COMP_A_MODELO_C],
  ] as const) {
    db.seed(`produtos/${id}`, { nome: `Camiseta ${id}`, sku: `CAM-${id}`, paiId: 'comp-a' });
    db.seed(`produtos/${id}/variashopee/var-${id}`, {
      model_id: modelo,
      contaVariacaoShopeeOuterRef: REF_CONTA,
      produtoShopeeOuterRef: 'documents/produtos/comp-a/prodshopee/link-comp-a',
    });
  }
  db.seed(`produtos/${K}`, { nome: 'Sonda kit familia teste', ...K_COMUM, sku: SONDA_SKU });
  db.seed(`produtos/${K}/extraData/singleton`, { descricao: 'Kit de teste da sonda, três cores.' });
  db.seed(`grupoDeVariacoes/${GRUPO_KIT}`, {
    nome: 'Kit',
    ordem: 1,
    variacoes: [
      { id: 'var-a', nome: 'Kit A' },
      { id: 'var-b', nome: 'Kit B' },
      { id: 'var-c', nome: 'Kit C' },
    ],
  });
  const filho = (id: string, variante: string, sku: string, ordem: number, comp: string): void =>
    db.seed(`produtos/${id}`, {
      nome: `Sonda ${variante}`,
      sku,
      paiId: K,
      ordem,
      ehKit: true,
      grupoDeVariacoesUid: [GRUPO_KIT],
      variacoesUid: [varianteFakePath(GRUPO_KIT, variante)],
      componentesKit: {
        [comp]: { quantidade: 1, limitarEstoque: true },
        'comp-b-membro': { quantidade: 1, limitarEstoque: true },
      },
    });
  filho('sonda-a', 'var-a', `${SONDA_SKU}-A`, 1, 'comp-a-filho');
  filho('sonda-b', 'var-b', `${SONDA_SKU}-B`, 2, 'comp-a-filho-b');
}

describe('RT9 — importação → republicação (L2: "republicar um kit importado de N modelos funciona")', () => {
  it('sobre os docs ESCRITOS pelo import da captura: zero anexados, todo modelo ligado, component_list VERBATIM (o oculto 2000458829 incluso), nenhum modelo-sem-filho', async () => {
    const db = new FakeDb();
    semearErpDaSonda(db);
    const loja = lojaDeKits();
    const kit = kitDaSondaComDoisModelos();
    instalarKit(loja, KIT_ITEM, {
      item_name: kit.item_name as string,
      item_sku: SONDA_SKU,
      model_list: kit.model_list,
      tier_variation_list: kit.tier_variation_list,
    });

    const importado = await importarKitShopee(
      depsDaImportacao(db),
      await lerAnuncioShopee(loja.client, KIT_ITEM),
    );
    expect(importado.produtoId).toBe(K);
    expect(linhasDoVinculo(db, VINCULO)).toEqual([
      ['sonda-a', KIT_MODELO],
      ['sonda-b', KIT_MODELO_2],
    ]);
    loja.ops.length = 0;

    const r = await republicar(db, loja);

    expect(r.modelos).toEqual({ vinculados: 2, anexados: 0, semFilho: 0 });
    expect(r.avisos.filter((a) => a.codigo === 'modelo-sem-filho')).toEqual([]);
    expect(r.avisos).toEqual([]);
    const enviados = corpoDoUpdate(loja).item_setting?.model_list ?? [];
    expect(enviados.some((m) => m.model_id === 0)).toBe(false);
    for (const vivo of kit.model_list as { model_id: number; component_list: Json[] }[]) {
      const enviado = enviados.find((m) => m.model_id === vivo.model_id);
      expect(enviado?.component_list).toEqual(
        vivo.component_list.map((c) => ({
          component_item_id: c.component_item_id,
          component_model_id: c.component_model_id,
          quantity: c.quantity,
          ...(c.main_component === true ? { main_component: true } : {}),
        })),
      );
    }
    expect(
      enviados
        .flatMap((m) => m.component_list ?? [])
        .filter((c) => c.component_item_id === COMP_B_ITEM),
    ).toEqual([
      { component_item_id: COMP_B_ITEM, component_model_id: COMP_B_OCULTO, quantity: 1 },
      { component_item_id: COMP_B_ITEM, component_model_id: COMP_B_OCULTO, quantity: 1 },
    ]);
    expect(linhasDoVinculo(db, VINCULO)).toEqual([
      ['sonda-a', KIT_MODELO],
      ['sonda-b', KIT_MODELO_2],
    ]);
  });

  it('⚠️ NEAR-MISS: um filho EXTRA no ERP (Kit C) ⇒ exatamente UM anexo, com o tier inteiro — e ele cai no id de modelo anexado da captura', async () => {
    const db = new FakeDb();
    semearErpDaSonda(db);
    const loja = lojaDeKits();
    const kit = kitDaSondaComDoisModelos();
    instalarKit(loja, KIT_ITEM, {
      item_name: kit.item_name as string,
      item_sku: SONDA_SKU,
      model_list: kit.model_list,
      tier_variation_list: kit.tier_variation_list,
    });
    await importarKitShopee(depsDaImportacao(db), await lerAnuncioShopee(loja.client, KIT_ITEM));
    db.seed('produtos/sonda-c', {
      nome: 'Sonda var-c',
      sku: `${SONDA_SKU}-C`,
      paiId: K,
      ordem: 3,
      ehKit: true,
      grupoDeVariacoesUid: [GRUPO_KIT],
      variacoesUid: [varianteFakePath(GRUPO_KIT, 'var-c')],
      componentesKit: {
        'comp-a-filho-c': { quantidade: 1, limitarEstoque: true },
        'comp-b-membro': { quantidade: 1, limitarEstoque: true },
      },
    });
    loja.ops.length = 0;

    const r = await republicar(db, loja);

    const anexos = corpoDoUpdate(loja).item_setting?.model_list?.filter((m) => m.model_id === 0);
    expect(anexos).toHaveLength(1);
    expect(anexos?.[0]).toMatchObject({ tier_index: [2], model_sku: `${SONDA_SKU}-C` });
    expect(corpoDoUpdate(loja).item_setting?.tier_variation_list).toEqual([
      { name: 'Kit', option_list: [{ option: 'Kit A' }, { option: 'Kit B' }, { option: 'Kit C' }] },
    ]);
    expect(r.modelos).toEqual({ vinculados: 3, anexados: 1, semFilho: 0 });
    expect(linhasDoVinculo(db, VINCULO)).toEqual([
      ['sonda-a', KIT_MODELO],
      ['sonda-b', KIT_MODELO_2],
      ['sonda-c', KIT_MODELO_ANEXADO],
    ]);
  });
});
