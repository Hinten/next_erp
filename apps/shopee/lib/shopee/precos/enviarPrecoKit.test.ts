/**
 * The kit price TRANSPORT (`enviarPrecoDeKit`, step 19 — reconcile §2.8) over
 * the COMMITTED probe captures, and RT4: a kit WRITTEN by the real create
 * (`publicarKitShopee`, PR 5) priced end to end through the real discovery, the
 * real planner and the real sender — `update_kit_item` carrying ONLY the changed
 * model with its live recipe, and a read-back that decides (M148–M150).
 *
 * And RT15's PRICE half (reconcile §4.2, register 303 — PR 7 pins the stock
 * half in `anuncios/publicarShopee.test.ts`): two CONCURRENT real creates leave
 * two native kits with one SKU, both linked; step 13 over those written docs
 * plans a price for BOTH and G9 sends each its own `update_kit_item`. Its
 * near-miss is R-w's way out: Lucas deletes one in Seller Centre, the REAL
 * re-verify reads it `removido`, and only the survivor stays priced.
 *
 * No hand-built link or row in RT4 or RT15: every document the price path reads
 * was written by the create (or the re-verify) in the same test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ERROR_KIND,
  SHOPEE_GET_KIT_ITEM_INFO_PATH,
  SHOPEE_GET_VARIATIONS_PATH,
  SHOPEE_LOGISTICS_FEE_TYPE,
  SHOPEE_SURFACE,
  ShopeeApiError,
  ShopeeConfigError,
  shopeeErrorFromEnvelope,
  shopeeItemBaseInfoPayloadSchema,
  shopeeItemListPayloadSchema,
  shopeeKitItemInfoPayloadSchema,
  shopeeLogisticsChannelSchema,
  shopeeModelListPayloadSchema,
  type ShopeeAddKitItemRequest,
  type ShopeeClient,
  type ShopeeItemViolationInfo,
  type ShopeeKitItemInfo,
  type ShopeeUpdateKitItemRequest,
} from '@delfrance/integrations-shopee';
import { ESTADO_ANUNCIO_SHOPEE, toOuterRef, varianteFakePath } from '@delfrance/schemas';
import { integracaoCollection } from '@delfrance/data/admin/collections';

import type { ResolvedorDeImagensShopee } from '../anuncios/fotosPublicacao';
import { reverificarAnuncioShopee } from '../anuncios/reverificarAnuncio';
import {
  FIXTURE_KIT_ITEM_INFO_SG_NAO_KIT,
  FIXTURE_KIT_ITEM_INFO_SG_POS_CRIACAO,
  FIXTURE_KIT_ITEM_INFO_SG_QUANTIDADE_IGNORADA,
  IDS_DA_FAMILIA_NO_CORPUS,
  IDS_DO_KIT_NO_CORPUS,
  lerFixture,
  lerKitDoCorpus,
} from '../fixtures/wireCorpus';
import { idDoVinculoDeKit } from '../kits/idsKit';
import { publicarKitShopee } from '../kits/publicarKit';
import type { KitDeps } from '../kits/resultadoKit';
import { limparTaxonomiaShopee } from '../taxonomia/cache';
import { type DocData, FakeDb, asDb, increment } from '../testing/fakeDb';
import { lerFamiliasDePrecoPorIds } from './descobertaPreco';
import { enviarPrecoDoItem } from './enviarPreco';
import { enviarPrecoDeKit } from './enviarPrecoKit';
import { MOTIVO_PRECO_SHOPEE } from './errosPreco';
import { criarLeitorDeBaseEmLote } from './leitorDeBase';
import {
  montarItensDePreco,
  precificarItem,
  precosDaFamilia,
  type ItemPlanejadoPreco,
} from './planoPreco';
import type { ContextoContaPreco } from './regiaoPreco';

/* -------------------------------------------------------------------------- */
/*  Fixture ids — the kit ROLES (s19-ctx), never a real partner, shop or item.  */
/* -------------------------------------------------------------------------- */

const KIT = IDS_DO_KIT_NO_CORPUS.kit;
const MODELO_1 = IDS_DO_KIT_NO_CORPUS.modeloDoKit;
const MODELO_2 = IDS_DA_FAMILIA_NO_CORPUS.segundoModeloDoKit;
const MODELO_3 = IDS_DA_FAMILIA_NO_CORPUS.modeloAnexado;
const COMP_A = IDS_DO_KIT_NO_CORPUS.componenteA;
const COMP_B = IDS_DO_KIT_NO_CORPUS.componenteB;
const OCULTO_B = IDS_DO_KIT_NO_CORPUS.modeloOcultoDoComponenteB;

/** A client that serves ONLY the two kit calls, and records each one in order. */
function clienteDoKit(
  kit: ShopeeKitItemInfo | Error,
  update: Error | null = null,
): {
  readonly client: ShopeeClient;
  readonly ordem: string[];
  readonly corpos: ShopeeUpdateKitItemRequest[];
} {
  const ordem: string[] = [];
  const corpos: ShopeeUpdateKitItemRequest[] = [];
  const conhecidas: Record<string, (p: never) => Promise<unknown>> = {
    getKitItemInfo: () => {
      ordem.push('get_kit_item_info');
      return kit instanceof Error ? Promise.reject(kit) : Promise.resolve(kit);
    },
    updateKitItem: (corpo: ShopeeUpdateKitItemRequest) => {
      ordem.push('update_kit_item');
      corpos.push(corpo);
      return update === null
        ? Promise.resolve({ request_id: 'req-1', error: '', message: '', warning: '' })
        : Promise.reject(update);
    },
  };
  const client = new Proxy({} as Record<string, unknown>, {
    get(_alvo, prop) {
      if (typeof prop !== 'string') return undefined;
      const fn = conhecidas[prop];
      if (fn !== undefined) return fn;
      return () => {
        throw new Error(`fixture: o transporte de kit chamou ${prop}`);
      };
    },
  }) as unknown as ShopeeClient;
  return { client, ordem, corpos };
}

/** The probe-#2 family kit after the append: THREE live models, quantities as read. */
const FAMILIA_VIVA = (): ShopeeKitItemInfo =>
  lerKitDoCorpus(FIXTURE_KIT_ITEM_INFO_SG_QUANTIDADE_IGNORADA);

/* -------------------------------------------------------------------------- */
/*  1. the body — over the committed captures                                  */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoDeKit — o corpo PARCIAL de `update_kit_item`', () => {
  it('⚠️ PAR (M149): UM modelo mudou num kit de TRÊS ⇒ o corpo leva SÓ ele — o tier VIVO, o preço e os componentes VIVOS verbatim; nenhuma outra chave', async () => {
    const c = clienteDoKit(FAMILIA_VIVA());

    const r = await enviarPrecoDeKit(c.client, KIT, [{ model_id: MODELO_2, original_price: 33 }]);

    expect(c.corpos).toEqual([
      {
        item_id: KIT,
        item_setting: {
          model_list: [
            {
              model_id: MODELO_2,
              tier_index: [1],
              original_price: 33,
              component_list: [
                {
                  component_item_id: COMP_A,
                  component_model_id: IDS_DA_FAMILIA_NO_CORPUS.modelosDoComponenteA['White,04'],
                  quantity: 1,
                },
                // The plain component's HIDDEN default id, resent as read (probe #1).
                { component_item_id: COMP_B, component_model_id: OCULTO_B, quantity: 1 },
              ],
            },
          ],
        },
      },
    ]);
    // No tier list, no item field — a partial update keeps the rest (P2-c, register 301).
    const [corpo] = c.corpos;
    expect(Object.keys(corpo ?? {})).toEqual(['item_id', 'item_setting']);
    expect(Object.keys(corpo?.item_setting ?? {})).toEqual(['model_list']);
    expect(c.ordem).toEqual(['get_kit_item_info', 'update_kit_item']);
    expect(r.semModeloVivo).toEqual([]);
  });

  it('⛔ QUASE-IGUAL (M149): o modelo com o componente PRINCIPAL leva `main_component: true` — e só ele; o tier é o DELE (0), nunca a posição na lista', async () => {
    const c = clienteDoKit(FAMILIA_VIVA());

    await enviarPrecoDeKit(c.client, KIT, [
      { model_id: MODELO_3, original_price: 31 },
      { model_id: MODELO_1, original_price: 35 },
    ]);

    const enviados = c.corpos[0]?.item_setting?.model_list ?? [];
    expect(enviados.map((m) => [m.model_id, m.tier_index])).toEqual([
      [MODELO_3, [2]],
      [MODELO_1, [0]],
    ]);
    const principais = enviados.flatMap((m) =>
      (m.component_list ?? []).filter((linha) => linha.main_component === true),
    );
    expect(principais).toEqual([
      {
        component_item_id: COMP_A,
        component_model_id: IDS_DA_FAMILIA_NO_CORPUS.modelosDoComponenteA['White,02'],
        quantity: 1,
        main_component: true,
      },
    ]);
  });

  it('a resposta é SINTETIZADA: cada modelo enviado no `success_list` SEM preço, `failure_list` vazia — o 200 nu não confirma nada', async () => {
    const c = clienteDoKit(FAMILIA_VIVA());

    const r = await enviarPrecoDeKit(c.client, KIT, [
      { model_id: MODELO_2, original_price: 33 },
      { model_id: MODELO_3, original_price: 34 },
    ]);

    expect(r.resposta).toEqual({
      success_list: [
        { model_id: MODELO_2, original_price: null },
        { model_id: MODELO_3, original_price: null },
      ],
      failure_list: [],
    });
  });

  it('um modelo planejado AUSENTE do kit vivo não vai, e volta em `semModeloVivo` — os outros seguem', async () => {
    const c = clienteDoKit(lerKitDoCorpus(FIXTURE_KIT_ITEM_INFO_SG_POS_CRIACAO));

    const r = await enviarPrecoDeKit(c.client, KIT, [
      { model_id: MODELO_2, original_price: 33 },
      { model_id: MODELO_1, original_price: 46 },
    ]);

    expect(r.semModeloVivo).toEqual([MODELO_2]);
    expect(c.corpos[0]?.item_setting?.model_list?.map((m) => m.model_id)).toEqual([MODELO_1]);
    expect(r.resposta.success_list.map((s) => s.model_id)).toEqual([MODELO_1]);
  });

  it('QUASE-IGUAL: NENHUM modelo planejado está vivo ⇒ ZERO `update_kit_item` (o pacote recusaria a lista vazia)', async () => {
    const c = clienteDoKit(lerKitDoCorpus(FIXTURE_KIT_ITEM_INFO_SG_POS_CRIACAO));
    const chamadas: string[] = [];

    const r = await enviarPrecoDeKit(
      c.client,
      KIT,
      [{ model_id: MODELO_2, original_price: 33 }],
      () => chamadas.push('x'),
    );

    expect(c.ordem).toEqual(['get_kit_item_info']);
    expect(chamadas).toHaveLength(1);
    expect(r).toEqual({
      resposta: { success_list: [], failure_list: [] },
      semModeloVivo: [MODELO_2],
    });
  });

  it('`aoChamarShopee` conta CADA chamada antes dela — também a que lança', async () => {
    const erro = new Error('queda de rede');
    const c = clienteDoKit(FAMILIA_VIVA(), erro);
    let chamadas = 0;

    await expect(
      enviarPrecoDeKit(c.client, KIT, [{ model_id: MODELO_2, original_price: 33 }], () => {
        chamadas += 1;
      }),
    ).rejects.toBe(erro);
    expect(chamadas).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. what is refused, and how                                                */
/* -------------------------------------------------------------------------- */

describe('enviarPrecoDeKit — erros', () => {
  it('`product_info: null` ⇒ a MESMA classe e o MESMO código da leitura de um kit ilegível (`"."`, `other`), sem `update_kit_item`', async () => {
    const c = clienteDoKit(shopeeKitItemInfoPayloadSchema.parse({ product_info: null }));

    const erro = await enviarPrecoDeKit(c.client, KIT, [
      { model_id: MODELO_1, original_price: 46 },
    ]).then(
      () => {
        throw new Error('deveria ter recusado');
      },
      (e: unknown) => e,
    );

    // The capture of a NON-kit read: the code a real unreadable kit answers.
    const capturado = lerFixture(FIXTURE_KIT_ITEM_INFO_SG_NAO_KIT) as { error: string };
    expect(erro).toBeInstanceOf(ShopeeApiError);
    expect(erro).toMatchObject({
      code: capturado.error,
      kind: SHOPEE_ERROR_KIND.other,
      path: SHOPEE_GET_KIT_ITEM_INFO_PATH,
    });
    expect(c.ordem).toEqual(['get_kit_item_info']);
  });

  it('a leitura do kit de OUTRO item ⇒ `ShopeeConfigError`, nada enviado', async () => {
    const outro = lerKitDoCorpus(FIXTURE_KIT_ITEM_INFO_SG_POS_CRIACAO);
    const c = clienteDoKit(outro);

    await expect(
      enviarPrecoDeKit(c.client, KIT + 1, [{ model_id: MODELO_1, original_price: 46 }]),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(c.corpos).toEqual([]);
  });

  it('um modelo vivo SEM `tier_index` lido ⇒ `ShopeeConfigError` (nunca um índice inventado), nada enviado', async () => {
    const kit = FAMILIA_VIVA();
    const semTier = shopeeKitItemInfoPayloadSchema.parse({
      product_info: {
        ...kit.product_info,
        model_list: kit.product_info?.model_list.map((m) =>
          m.model_id === MODELO_2 ? { ...m, tier_index: [] } : m,
        ),
      },
    });
    const c = clienteDoKit(semTier);

    await expect(
      enviarPrecoDeKit(c.client, KIT, [{ model_id: MODELO_2, original_price: 33 }]),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
    expect(c.corpos).toEqual([]);
  });

  it('o erro de cada chamada chega VERBATIM (a MESMA instância) — nada é capturado aqui', async () => {
    const naLeitura = shopeeErrorFromEnvelope(
      { error: 'error_auth', message: 'no', request_id: null, warning: null },
      { path: SHOPEE_GET_KIT_ITEM_INFO_PATH, httpStatus: 403, surface: SHOPEE_SURFACE.business },
    );
    await expect(
      enviarPrecoDeKit(clienteDoKit(naLeitura).client, KIT, [
        { model_id: MODELO_1, original_price: 46 },
      ]),
    ).rejects.toBe(naLeitura);
  });
});

/* -------------------------------------------------------------------------- */
/*  3. RT4 — create → step-13 price → read-back                                */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

const INTEGRACAO = 'int-1';
const REF_CONTA = toOuterRef(integracaoCollection.docPath({}, INTEGRACAO));
const AGORA = 1_757_000_000_000;
const CATEGORIA = 107290;
const CANAL = 90_003;
const K = 'kit-k';
const K_AZUL = 'kit-k-azul';
const K_VERDE = 'kit-k-verde';
const GRUPO = 'grupo-cor';
const SKU = 'KIT-1';
const COMP_A_MODELO = IDS_DO_KIT_NO_CORPUS.modeloDoComponenteA;
const VINCULO = idDoVinculoDeKit(INTEGRACAO, KIT);
/** The model ids the shop hands a fresh kit, in SENT order (the corpus roles). */
const MODELOS_NOVOS = [MODELO_1, MODELO_2] as const;
/** RT15's twin: the SECOND kit a concurrent create makes, with the same SKU (the D1 second-kit role). */
const KIT_GEMEO = 2500139873;
const VINCULO_GEMEO = idDoVinculoDeKit(INTEGRACAO, KIT_GEMEO);
const MODELOS_DO_GEMEO = [2000458827, 2000458828] as const;
/** The `item_id`s the shop hands out, in creation order, and each one's model ids. */
const ITENS_A_CRIAR = [KIT, KIT_GEMEO] as const;
const MODELOS_DE: Readonly<Record<number, readonly number[]>> = {
  [KIT]: MODELOS_NOVOS,
  [KIT_GEMEO]: MODELOS_DO_GEMEO,
};

/**
 * The shared double plus `select` and `getAll(...refs, { fieldMask })`, both
 * APPLYING the projection — the discovery's two verbs (the
 * `kitNativoImportado.test.ts` extension, never `testing/fakeDb.ts`).
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

/** Components A (a 2-tier listing; the ERP component is its child) and plain B (a família de um). */
function semearComponentes(db: FakeDb): void {
  db.seed('produtos/comp-a', { nome: 'Camiseta', sku: 'CAM', paiId: null });
  db.seed('produtos/comp-a/prodshopee/link-comp-a', {
    item_id: COMP_A,
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
    item_id: COMP_B,
    contaProdutoShopeeOuterRef: REF_CONTA,
    category_id: CATEGORIA,
  });
  db.seed('produtos/comp-b-membro', { nome: 'Boné', sku: 'BONE-UN', paiId: 'comp-b' });
}

/** K, a 2-child FAMILY on one axis: Azul = A + B, Verde = 2 × A; K's price propagates. */
function semearFamilia(db: FakeDb): void {
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
    ],
  });
  db.seed(`produtos/${K_AZUL}`, {
    nome: 'Kit azul',
    sku: `${SKU}-AZ`,
    paiId: K,
    ordem: 1,
    ehKit: true,
    grupoDeVariacoesUid: [GRUPO],
    variacoesUid: [varianteFakePath(GRUPO, 'var-azul')],
    componentesKit: {
      'comp-a-filho': { quantidade: 1, limitarEstoque: true },
      'comp-b-membro': { quantidade: 1, limitarEstoque: true },
    },
  });
  db.seed(`produtos/${K_VERDE}`, {
    nome: 'Kit verde',
    sku: `${SKU}-VD`,
    paiId: K,
    ordem: 2,
    ehKit: true,
    grupoDeVariacoesUid: [GRUPO],
    variacoesUid: [varianteFakePath(GRUPO, 'var-verde')],
    componentesKit: { 'comp-a-filho': { quantidade: 2, limitarEstoque: true } },
  });
}

/** One stored kit model: what the shop holds, and serves through its three reads. */
interface ModeloNaLoja {
  readonly model_id: number;
  readonly model_sku: string | null;
  original_price: number;
  readonly tier_index: number[];
  readonly component_list: Json[];
}

/** One kit the shop created: its item fields and its (mutable-price) models. */
interface KitNaLoja {
  kit: Json;
  readonly modelos: ModeloNaLoja[];
}

/** RT15's barrier: the first `esperados - 1` `add_kit_item` calls wait for the last. */
interface Portao {
  readonly esperados: number;
  chegaram: number;
  readonly liberar: (() => void)[];
}

interface Loja {
  readonly client: ShopeeClient;
  readonly ops: string[];
  readonly corposDoKit: ShopeeUpdateKitItemRequest[];
  /** `false` ⇒ `update_kit_item` answers 200 and changes NOTHING (P2-c). */
  aplicarPrecos: boolean;
  /** Set ⇒ no `add_kit_item` creates until `esperados` of them arrived (both scans ran first). */
  portao: Portao | null;
  /** Seller Centre deletes a kit: its base row and its kit read `SELLER_DELETE` from then on. */
  apagar: (itemId: number) => void;
}

/**
 * A shop that CREATES what `add_kit_item` is sent — at the next id of
 * {@link ITENS_A_CRIAR}, the plain component read back with its HIDDEN model
 * id, the models in SENT order, `tag.kit: true` — serves each kit's prices in
 * BRL through `get_model_list`, and applies an `update_kit_item` price to the
 * kit it names — or, with `aplicarPrecos: false`, answers the bare 200 and
 * keeps the old one. Anything not arranged throws, and so does a write to an
 * item that is not one of its kits.
 */
function lojaDeKit(): Loja {
  const ops: string[] = [];
  const corposDoKit: ShopeeUpdateKitItemRequest[] = [];
  const ocultos: Readonly<Record<number, number>> = { [COMP_B]: OCULTO_B };
  const bases = new Map<number, Json>([
    [COMP_A, { item_id: COMP_A, item_status: 'NORMAL', has_model: true, tag: { kit: false } }],
    [COMP_B, { item_id: COMP_B, item_status: 'NORMAL', has_model: false, tag: { kit: false } }],
  ]);
  const kits = new Map<number, KitNaLoja>();
  const proximos: number[] = [...ITENS_A_CRIAR];
  const loja: Loja = {
    client: {} as ShopeeClient,
    ops,
    corposDoKit,
    aplicarPrecos: true,
    portao: null,
    apagar: (itemId) => {
      const base = bases.get(itemId);
      if (base !== undefined) bases.set(itemId, { ...base, item_status: 'SELLER_DELETE' });
      const doKit = kits.get(itemId);
      if (doKit !== undefined) doKit.kit = { ...doKit.kit, item_status: 'SELLER_DELETE' };
    },
  };

  const kitAtual = (itemId: number): Json | null => {
    const doKit = kits.get(itemId);
    return doKit === undefined
      ? null
      : { ...doKit.kit, model_list: doKit.modelos.map((m) => ({ ...m })) };
  };

  const conhecidas: Record<string, (p: never) => Promise<unknown>> = {
    getItemBaseInfo: (p: { itemIds: readonly number[] }) => {
      ops.push('get_item_base_info');
      return Promise.resolve(
        shopeeItemBaseInfoPayloadSchema.parse({
          item_list: p.itemIds.flatMap((id) => {
            const linha = bases.get(id);
            return linha === undefined ? [] : [linha];
          }),
        }),
      );
    },
    getItemList: () => {
      ops.push('get_item_list');
      const linhas = [...bases.values()].map((b) => ({
        item_id: b.item_id,
        item_status: b.item_status,
        tag: b.tag,
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
        shopeeKitItemInfoPayloadSchema.parse({ product_info: kitAtual(p.itemId) }),
      );
    },
    getModelList: (p: { itemId: number }) => {
      ops.push('get_model_list');
      const doKit = kits.get(p.itemId);
      if (doKit === undefined) {
        return Promise.resolve(shopeeModelListPayloadSchema.parse({ model: [] }));
      }
      return Promise.resolve(
        shopeeModelListPayloadSchema.parse({
          tier_variation: doKit.kit.tier_variation_list ?? [],
          model: doKit.modelos.map((m) => ({
            model_id: m.model_id,
            tier_index: m.tier_index,
            model_status: 'MODEL_NORMAL',
            model_sku: m.model_sku,
            price_info: [
              {
                currency: 'BRL',
                original_price: m.original_price,
                current_price: m.original_price,
              },
            ],
          })),
        }),
      );
    },
    getKitItemLimit: () => {
      ops.push('get_kit_item_limit');
      return Promise.reject(
        shopeeErrorFromEnvelope(
          { error: 'error_not_found', message: null, request_id: null, warning: null },
          {
            path: '/api/v2/product/get_kit_item_limit',
            httpStatus: 404,
            surface: SHOPEE_SURFACE.business,
          },
        ),
      );
    },
    getChannelList: () => {
      ops.push('get_channel_list');
      return Promise.resolve({
        logistics_channel_list: [
          shopeeLogisticsChannelSchema.parse({
            logistics_channel_id: CANAL,
            enabled: true,
            fee_type: SHOPEE_LOGISTICS_FEE_TYPE.sizeInput,
          }),
        ],
      });
    },
    // The barrier (RT15): neither concurrent run creates until both reached
    // here, so both SKU scans and both link reads ran before any kit existed —
    // the real double-click race, not a sequential re-run.
    addKitItem: async (corpo: ShopeeAddKitItemRequest) => {
      ops.push('add_kit_item');
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
      const itemId = proximos.shift();
      if (itemId === undefined) throw new Error('fixture: a loja não tem mais item_id para criar');
      const s = corpo.item_setting;
      const modelos: ModeloNaLoja[] = s.model_list.map((m, i) => ({
        model_id: MODELOS_DE[itemId]?.[i] ?? MODELO_3,
        model_sku: m.model_sku ?? null,
        original_price: m.original_price,
        tier_index: [...m.tier_index],
        component_list: m.component_list.map((c) => ({
          component_item_id: c.component_item_id,
          component_model_id: c.component_model_id ?? ocultos[c.component_item_id] ?? null,
          quantity: c.quantity,
          main_component: c.main_component === true,
        })),
      }));
      const tiers = s.tier_variation_list.map((t) => ({
        name: t.name,
        option_list: t.option_list.map((o) => ({ option: o.option })),
      }));
      kits.set(itemId, {
        kit: {
          item_id: itemId,
          item_name: s.item_name,
          item_sku: s.item_sku ?? null,
          item_status: 'NORMAL',
          category_id: CATEGORIA,
          weight: String(s.weight),
          tier_variation_list: tiers,
        },
        modelos,
      });
      bases.set(itemId, {
        item_id: itemId,
        item_name: s.item_name,
        item_sku: s.item_sku ?? null,
        item_status: 'NORMAL',
        has_model: true,
        tag: { kit: true },
        category_id: CATEGORIA,
        image: { image_id_list: ['img-kit-1'] },
      });
      return {
        request_id: 'req-1',
        error: '',
        message: '',
        warning: '',
        response: { item_id: itemId },
      };
    },
    updateKitItem: (corpo: ShopeeUpdateKitItemRequest) => {
      ops.push('update_kit_item');
      corposDoKit.push(corpo);
      const doKit = kits.get(corpo.item_id);
      if (doKit === undefined) {
        throw new Error(
          `fixture: update_kit_item no item ${String(corpo.item_id)}, que não é um kit`,
        );
      }
      if (loja.aplicarPrecos) {
        for (const enviado of corpo.item_setting?.model_list ?? []) {
          const alvo = doKit.modelos.find((m) => m.model_id === enviado.model_id);
          if (alvo !== undefined && enviado.original_price !== undefined) {
            alvo.original_price = enviado.original_price;
          }
        }
      }
      return Promise.resolve({ request_id: 'req-2', error: '', message: '', warning: '' });
    },
    // The re-verify's best-effort violation read (RT15's near-miss): a clean row.
    getItemViolationInfo: (p: { itemIds: readonly number[] }) => {
      ops.push('get_item_violation_info');
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
  };
  const client = new Proxy({} as Record<string, unknown>, {
    get(_alvo, prop) {
      // Not a thenable: the re-verify hands the client through a Promise.
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      const fn = conhecidas[prop];
      if (fn !== undefined) return fn;
      return () => {
        ops.push(`?${prop}`);
        throw new Error(`fixture: a loja não serve ${prop}`);
      };
    },
  }) as unknown as ShopeeClient;
  return Object.assign(loja, { client });
}

function resolvedorFake(): ResolvedorDeImagensShopee {
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

function depsDoKit(db: FakeDb, loja: Loja): KitDeps {
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
    resolvedorDeImagens: resolvedorFake(),
    increment,
  };
}

/** The conta the price sender takes — a verdict that PASSED, in reais. */
function contaDePreco(loja: Loja): ContextoContaPreco {
  return {
    integracaoId: INTEGRACAO,
    client: loja.client,
    regiao: 'BR',
    moeda: 'BRL',
    multiplo: 4,
    tabelaNormalId: 'tab-normal',
  } as ContextoContaPreco;
}

/**
 * The ERP's new prices after the create: K stops propagating, Azul keeps the
 * price the kit was created at, Verde goes up — so exactly ONE model changes.
 */
function novosPrecos(db: FakeDb): void {
  const merge = (caminho: string, patch: Json): void => {
    db.seed(caminho, { ...(db.store[caminho]?.data as Json), ...patch });
  };
  merge(`produtos/${K}`, { propagatePriceToChildren: false });
  merge(`produtos/${K_AZUL}`, { precos: { 'tab-normal': { valor: 99.9 } } });
  merge(`produtos/${K_VERDE}`, { precos: { 'tab-normal': { valor: 120 } } });
}

/** Create → discover → plan → price: the planned item, priced, through the REAL readers. */
async function criarEPlanejar(db: FakeDb, loja: Loja) {
  const criado = await publicarKitShopee(
    depsDoKit(db, loja),
    { produtoId: K, statusPedido: 'NORMAL', principal: 'comp-a-filho' },
    { arma: 'kit-criar' },
  );
  expect(criado).toMatchObject({ desfecho: 'criado', itemId: KIT, linkDocId: VINCULO });
  novosPrecos(db);
  const familia = (await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [K] })).get(K);
  expect(familia).toBeDefined();
  const plano = montarItensDePreco(familia!, INTEGRACAO);
  return { familia: familia!, plano };
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

describe('RT4 — a criação REAL → o preço do passo 13 → a releitura', () => {
  it('⚠️ PAR (M148/M149/M150): o plano endereça o kit pelos modelos ESCRITOS; o G9 manda `update_kit_item` com SÓ o modelo que mudou e a receita viva; a releitura no preço novo ⇒ `enviado`', async () => {
    const db = new FakeDbComProjecao();
    semearComponentes(db);
    semearFamilia(db);
    const loja = lojaDeKit();

    const { familia, plano } = await criarEPlanejar(db, loja);

    // The plan: ONE item, the link the create wrote, each model bound to the
    // child the create bound it to — no kit flag anywhere in it.
    expect(familia.links.map((l) => [l.linkDocId, l.kitNativo])).toEqual([[VINCULO, true]]);
    expect(plano.pulos).toEqual([]);
    expect(plano.itens).toHaveLength(1);
    const [planejado] = plano.itens;
    expect(planejado?.itemId).toBe(KIT);
    expect(planejado?.modelos.map((m) => [m.produtoId, m.modelId])).toEqual([
      [K_AZUL, MODELO_1],
      [K_VERDE, MODELO_2],
    ]);

    const item = precificarItem(planejado!, precosDaFamilia(familia), 'tab-normal');
    loja.ops.length = 0;
    const r = await enviarPrecoDoItem(item, {
      db: asDb(db),
      conta: contaDePreco(loja),
      nowMs: AGORA + 60_000,
      baixarPreco: false,
      lerBase: criarLeitorDeBaseEmLote(loja.client, [KIT]),
    });

    // EXACTLY the changed model, its live option, its live recipe — no other key.
    expect(loja.corposDoKit).toEqual([
      {
        item_id: KIT,
        item_setting: {
          model_list: [
            {
              model_id: MODELO_2,
              tier_index: [1],
              original_price: 120,
              component_list: [
                { component_item_id: COMP_A, component_model_id: COMP_A_MODELO, quantity: 2 },
              ],
            },
          ],
        },
      },
    ]);
    expect(loja.ops).not.toContain('?updatePrice');
    expect(loja.ops).toEqual([
      'get_item_base_info',
      'get_model_list',
      'get_kit_item_info',
      'update_kit_item',
      // G11 — the RE-READ, never the synthesised echo.
      'get_item_base_info',
      'get_model_list',
    ]);
    expect(r.tipo).toBe('enviado');
    if (r.tipo !== 'enviado') return;
    expect(r.modelos.map((m) => [m.modelId, m.resultado, m.motivo])).toEqual([
      [MODELO_1, 'pulado', 'preco-igual'],
      [MODELO_2, 'enviado', null],
    ]);
  });

  it('⛔ QUASE-IGUAL (M150): a MESMA escrita respondida 200 SEM mudar nada (P2-c) ⇒ `falha preco-nao-atualizado`, embora a resposta sintetizada liste o modelo', async () => {
    const db = new FakeDbComProjecao();
    semearComponentes(db);
    semearFamilia(db);
    const loja = lojaDeKit();
    const { familia, plano } = await criarEPlanejar(db, loja);
    loja.aplicarPrecos = false;

    const item = precificarItem(plano.itens[0]!, precosDaFamilia(familia), 'tab-normal');
    const escritasAntes = db.writes.length;
    const r = await enviarPrecoDoItem(item, {
      db: asDb(db),
      conta: contaDePreco(loja),
      nowMs: AGORA + 60_000,
      baixarPreco: false,
      lerBase: criarLeitorDeBaseEmLote(loja.client, [KIT]),
    });

    expect(loja.corposDoKit).toHaveLength(1);
    expect(r).toMatchObject({ tipo: 'falha', motivo: 'preco-nao-atualizado', carimbado: false });
    // Accepted, not confirmed: neither side of the link is written.
    expect(db.writes.slice(escritasAntes)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. RT15, PR 8's half — the accepted double create (R-w), priced            */
/* -------------------------------------------------------------------------- */

/**
 * Two REAL `kit-criar` runs at once, behind the shop's barrier: both SKU scans
 * come back empty and both link reads see nothing, so both create and both
 * write a link (two ids, register 303). Then the ERP moves Verde's price, as
 * in RT4. Nothing below this line is hand-built.
 */
async function criarDoisKits(db: FakeDb, loja: Loja): Promise<void> {
  loja.portao = { esperados: 2, chegaram: 0, liberar: [] };
  const criar = () =>
    publicarKitShopee(
      depsDoKit(db, loja),
      { produtoId: K, statusPedido: 'NORMAL', principal: 'comp-a-filho' },
      { arma: 'kit-criar' },
    );

  const [a, b] = await Promise.all([criar(), criar()]);

  expect([a.desfecho, b.desfecho]).toEqual(['criado', 'criado']);
  expect([a.itemId, b.itemId].sort()).toEqual([KIT, KIT_GEMEO]);
  expect(loja.ops.filter((op) => op === 'add_kit_item')).toHaveLength(2);
  expect(db.idsEm(`produtos/${K}/prodshopee`).sort()).toEqual([VINCULO, VINCULO_GEMEO].sort());
  novosPrecos(db);
}

/** Discovery → plan over K, through the REAL readers. */
async function planoDeK(db: FakeDb) {
  const familia = (await lerFamiliasDePrecoPorIds(asDb(db), { anchorIds: [K] })).get(K);
  expect(familia).toBeDefined();
  return { familia: familia!, plano: montarItensDePreco(familia!, INTEGRACAO) };
}

/** Each planned item as `[linkDocId, itemId, [[child, model_id], …]]`, by item id. */
function porItem(itens: readonly ItemPlanejadoPreco[]) {
  return itens
    .map(
      (i) =>
        [i.linkDocId, i.itemId, i.modelos.map((m) => [m.produtoId, m.modelId] as const)] as const,
    )
    .sort((x, y) => x[1] - y[1]);
}

/** Price and send every planned item, in plan order; each result keyed by its item id. */
async function enviarTodos(
  db: FakeDb,
  loja: Loja,
  familia: Awaited<ReturnType<typeof planoDeK>>['familia'],
  itens: readonly ItemPlanejadoPreco[],
) {
  const lerBase = criarLeitorDeBaseEmLote(
    loja.client,
    itens.map((i) => i.itemId),
  );
  const resultados: (readonly [number, Awaited<ReturnType<typeof enviarPrecoDoItem>>])[] = [];
  for (const planejado of itens) {
    const item = precificarItem(planejado, precosDaFamilia(familia), 'tab-normal');
    const r = await enviarPrecoDoItem(item, {
      db: asDb(db),
      conta: contaDePreco(loja),
      nowMs: AGORA + 60_000,
      baixarPreco: false,
      lerBase,
    });
    resultados.push([planejado.itemId, r] as const);
  }
  return resultados.sort((x, y) => x[0] - y[0]);
}

/** Verde's model as G9 must resend it: the live option, the new price, the live recipe. */
function verdeEnviado(modelId: number) {
  return {
    model_id: modelId,
    tier_index: [1],
    original_price: 120,
    component_list: [{ component_item_id: COMP_A, component_model_id: COMP_A_MODELO, quantity: 2 }],
  };
}

describe('RT15 (metade do PR 8) — a criação dupla ACEITA (R-w, registro 303) é precificada', () => {
  it('⚠️ PAR: dois kit-criar SIMULTÂNEOS ⇒ dois kits, dois vínculos ⇒ o passo 13 planeja OS DOIS (nenhum pulo, cada um com os modelos do SEU kit) e o G9 manda a CADA UM o seu `update_kit_item` — só o modelo que mudou, a receita viva', async () => {
    const db = new FakeDbComProjecao();
    semearComponentes(db);
    semearFamilia(db);
    const loja = lojaDeKit();
    await criarDoisKits(db, loja);

    const { familia, plano } = await planoDeK(db);

    // Both links reach the planner, both stamped native by their read-back…
    expect(
      familia.links
        .map((l) => [l.linkDocId, l.item_id, l.kitNativo])
        .sort((x, y) => Number(x[1]) - Number(y[1])),
    ).toEqual([
      [VINCULO, KIT, true],
      [VINCULO_GEMEO, KIT_GEMEO, true],
    ]);
    // …and BOTH are planned: never deduplicated per produto, never refused for
    // ambiguity (that is PUBLISH's rule), each listing's models bound to the
    // same two children through its OWN rows (never the twin's).
    expect(plano.pulos).toEqual([]);
    expect(porItem(plano.itens)).toEqual([
      [
        VINCULO,
        KIT,
        [
          [K_AZUL, MODELO_1],
          [K_VERDE, MODELO_2],
        ],
      ],
      [
        VINCULO_GEMEO,
        KIT_GEMEO,
        [
          [K_AZUL, MODELOS_DO_GEMEO[0]],
          [K_VERDE, MODELOS_DO_GEMEO[1]],
        ],
      ],
    ]);

    loja.ops.length = 0;
    const resultados = await enviarTodos(db, loja, familia, plano.itens);

    // G9: ONE `update_kit_item` per kit, each carrying only ITS Verde model.
    expect([...loja.corposDoKit].sort((x, y) => x.item_id - y.item_id)).toEqual([
      { item_id: KIT, item_setting: { model_list: [verdeEnviado(MODELO_2)] } },
      { item_id: KIT_GEMEO, item_setting: { model_list: [verdeEnviado(MODELOS_DO_GEMEO[1])] } },
    ]);
    expect(loja.ops).not.toContain('?updatePrice');
    // Both confirmed by their OWN re-read (G11), Azul unchanged on each.
    expect(
      resultados.map(([itemId, r]) => [
        itemId,
        r.tipo,
        r.tipo === 'enviado' ? r.modelos.map((m) => [m.modelId, m.resultado]) : null,
      ]),
    ).toEqual([
      [
        KIT,
        'enviado',
        [
          [MODELO_1, 'pulado'],
          [MODELO_2, 'enviado'],
        ],
      ],
      [
        KIT_GEMEO,
        'enviado',
        [
          [MODELOS_DO_GEMEO[0], 'pulado'],
          [MODELOS_DO_GEMEO[1], 'enviado'],
        ],
      ],
    ]);
  });

  it('⛔ QUASE-PAR (a saída do R-w): Lucas exclui o GÊMEO no Seller Centre e o reverify REAL o lê `removido` ⇒ o passo 13 planeja SÓ o sobrevivente (`anuncio-removido` para o gêmeo) e o G9 nunca escreve no excluído', async () => {
    const db = new FakeDbComProjecao();
    semearComponentes(db);
    semearFamilia(db);
    const loja = lojaDeKit();
    await criarDoisKits(db, loja);

    loja.apagar(KIT_GEMEO);
    const reverificado = await reverificarAnuncioShopee(
      asDb(db),
      { integracaoId: INTEGRACAO, produtoId: K, linkDocId: VINCULO_GEMEO },
      { clientFor: () => Promise.resolve(loja.client), increment, nowMs: AGORA + 2_000 },
    );
    expect(reverificado?.estadoAnuncio).toBe(ESTADO_ANUNCIO_SHOPEE.removido);

    const { familia, plano } = await planoDeK(db);
    expect(porItem(plano.itens)).toEqual([
      [
        VINCULO,
        KIT,
        [
          [K_AZUL, MODELO_1],
          [K_VERDE, MODELO_2],
        ],
      ],
    ]);
    expect(plano.pulos).toEqual([
      {
        produtoId: K,
        linkDocId: VINCULO_GEMEO,
        itemId: KIT_GEMEO,
        motivo: MOTIVO_PRECO_SHOPEE.anuncioRemovido,
        modelos: [],
      },
    ]);

    loja.ops.length = 0;
    const resultados = await enviarTodos(db, loja, familia, plano.itens);
    expect(loja.corposDoKit.map((c) => c.item_id)).toEqual([KIT]);
    expect(resultados.map(([itemId, r]) => [itemId, r.tipo])).toEqual([[KIT, 'enviado']]);
  });
});
