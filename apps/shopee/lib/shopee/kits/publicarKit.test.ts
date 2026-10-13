/**
 * `publicarKitShopee` end to end over `fakeDb` + a STATEFUL shop double — and
 * the round trips that chain the REAL create into the REAL readers (reconcile
 * §4.2): RT1 create → re-import, RT2 create → order line, RT3 create → step 12
 * skips, RT7 the L9 recovery (an `incerto` create re-imported onto the SAME
 * produto). No hand-built link or row anywhere: every doc a reader sees was
 * written by the create (or by step 9's import) in the same test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ADD_KIT_ITEM_PATH,
  SHOPEE_GET_KIT_ITEM_LIMIT_PATH,
  SHOPEE_GET_VARIATIONS_PATH,
  SHOPEE_LOGISTICS_FEE_TYPE,
  SHOPEE_SURFACE,
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
  MOTIVO_PUBLICACAO_BLOQUEADA,
  ShopeePublishBlockedError,
} from '../anuncios/errosPublicacao';
import type { ResolvedorDeImagensShopee } from '../anuncios/fotosPublicacao';
import { MOTIVO_ESTOQUE_SHOPEE } from '../estoque/errosEstoque';
import { podeEnviarEstoqueShopee } from '../estoque/podeEnviarEstoque';
import { lerFixture, FIXTURE_ADD_KIT_ITEM_SG_TOO_MANY_CONNECTIONS } from '../fixtures/wireCorpus';
import { resolverProdutoDaLinhaShopee } from '../pedidos/produtoResolve';
import type { ImportarKitShopeeDeps } from '../produtos/itemLido';
import { importarKitShopee } from '../produtos/kitShopee';
import { lerAnuncioShopee } from '../produtos/lerAnuncio';
import { limparTaxonomiaShopee } from '../taxonomia/cache';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { idDaVariacaoDeKit, idDoVinculoDeKit } from './idsKit';
import { ensaiarKitShopee, publicarKitShopee } from './publicarKit';
import type { ArmaDeKit, EntradaDeKit } from './prepararKit';
import type { KitDeps } from './resultadoKit';

/* -------------------------------------------------------------------------- */
/*  Fixtures — role ids only (s19-ctx). Never a real partner, shop or item.     */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

const INTEGRACAO = 'int-1';
const REF_CONTA = toOuterRef(integracaoCollection.docPath({}, INTEGRACAO));
const AGORA = 1_757_000_000_000;

const KIT_ITEM = 2500139870;
const KIT_MODELO = 2000458820;
/** The family kit's SECOND model (the wire corpus's own role id for it). */
const KIT_MODELO_2 = 2000458823;
const COMP_A_ITEM = 2500139871;
const COMP_A_MODELO = 2000458821;
const COMP_B_ITEM = 2500139872;
const COMP_B_OCULTO = 2000458829;
const CATEGORIA = 107290;
const CANAL = 90_003;

const K = 'kit-k';
const K_AZUL = 'kit-k-azul';
const K_VERDE = 'kit-k-verde';
const K_MEMBRO = 'kit-k-un';
const GRUPO = 'grupo-cor';
const SKU = 'KIT-1';
const VINCULO = idDoVinculoDeKit(INTEGRACAO, KIT_ITEM);

/* --------------------------------- the db --------------------------------- */

function semearComponentes(db: FakeDb): void {
  // A — a 2-tier listing; the ERP component is its VARIATION child.
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
  // B — a plain listing on a família-de-um WRAPPER; every kit map names the MEMBER.
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

/**
 * K, a 2-child FAMILY (one axis, `Cor`): Azul = A + B, Verde = 2 × A. `semSkuVerde`
 * drops Verde's SKU, so step 9 can bind it only by the variation COMBINATION.
 */
function semearFamilia(db: FakeDb, op: { readonly semSkuVerde?: boolean } = {}): void {
  db.seed(`produtos/${K}`, { nome: 'Kit camiseta e boné', ...K_COMUM });
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
    sku: op.semSkuVerde === true ? null : `${SKU}-VD`,
    paiId: K,
    ordem: 2,
    ehKit: true,
    grupoDeVariacoesUid: [GRUPO],
    variacoesUid: [varianteFakePath(GRUPO, 'var-verde')],
    componentesKit: { 'comp-a-filho': { quantidade: 2, limitarEstoque: true } },
  });
}

/** K, a FAMÍLIA DE UM: wrapper + member, recipe 2 × A on both (the mirror). */
function semearFamiliaDeUm(db: FakeDb): void {
  db.seed(`produtos/${K}`, {
    nome: 'Kit camiseta dupla',
    ...K_COMUM,
    filhoUnicoId: K_MEMBRO,
    componentesKit: { 'comp-a-filho': { quantidade: 2, limitarEstoque: true } },
  });
  db.seed(`produtos/${K}/extraData/singleton`, {
    descricao: 'Duas camisetas de algodão num kit só, para presente.',
  });
  db.seed(`produtos/${K_MEMBRO}`, {
    nome: 'Kit camiseta dupla',
    sku: `${SKU}-UN`,
    paiId: K,
    ehKit: true,
    componentesKit: { 'comp-a-filho': { quantidade: 2, limitarEstoque: true } },
  });
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
  readonly base: Json;
  readonly kit?: Json;
  readonly modelos?: Json;
}

interface Loja {
  readonly client: ShopeeClient;
  readonly ops: string[];
  readonly corposDoAdd: ShopeeAddKitItemRequest[];
  readonly corposDoUpdate: ShopeeUpdateKitItemRequest[];
  readonly itens: Map<number, ItemNaLoja>;
  /** What the NEXT `add_kit_item` does after creating: answer, or throw this. */
  falhaAposCriar: Error | null;
  /** The next base read of the kit item throws this (a crash after the link write). */
  falhaNaReleitura: Error | null;
  readonly limites: 'indisponivel' | Json;
}

/** The transient `add_kit_item` refusal, from the COMMITTED probe capture. */
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

/**
 * A shop that CREATES what `add_kit_item` is sent and serves it back the way the
 * SG probe measured: `tag.kit: true`, every plain component read back with its
 * HIDDEN non-zero `component_model_id`, the models in the SENT tier order, the
 * kit listed by `get_item_list` from then on. Anything not arranged throws.
 */
function lojaComKits(op: { readonly limites?: 'indisponivel' | Json } = {}): Loja {
  const ops: string[] = [];
  const corposDoAdd: ShopeeAddKitItemRequest[] = [];
  const corposDoUpdate: ShopeeUpdateKitItemRequest[] = [];
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
    corposDoAdd,
    corposDoUpdate,
    itens,
    falhaAposCriar: null,
    falhaNaReleitura: null,
    limites: op.limites ?? 'indisponivel',
  };

  const criar = (corpo: ShopeeAddKitItemRequest): number => {
    const itemId = KIT_ITEM;
    const s = corpo.item_setting;
    const modelos = s.model_list.map((m, i) => ({
      model_id: MODELOS_NOVOS[i] ?? KIT_MODELO + 100 + i,
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
    // OP-9: a create sent `unlisted: true` lists paused (the unmeasured flag's
    // documented meaning, register 305) — the read-back then says so.
    const status = s.unlisted === true ? 'UNLIST' : 'NORMAL';
    itens.set(itemId, {
      base: {
        item_id: itemId,
        item_name: s.item_name,
        item_sku: s.item_sku ?? null,
        item_status: status,
        has_model: true,
        tag: { kit: true },
        category_id: CATEGORIA,
        create_time: 1791244800,
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
        create_time: 1791244800,
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
        shopeeKitItemInfoPayloadSchema.parse({ product_info: itens.get(p.itemId)?.kit ?? null }),
      );
    },
    getModelList: (p: { itemId: number }) => {
      ops.push('get_model_list');
      return Promise.resolve(
        shopeeModelListPayloadSchema.parse(
          itens.get(p.itemId)?.modelos ?? { tier_variation: [], model: [] },
        ),
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
      corposDoAdd.push(corpo);
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
    // The republish's ONE write (RT7's tail): the package guard runs first, as
    // in the real client; the shop changes nothing a republish reads back.
    updateKitItem: (corpo: ShopeeUpdateKitItemRequest) => {
      ops.push('update_kit_item');
      corposDoUpdate.push(corpo);
      assertUpdateKitItemRequest(corpo);
      return Promise.resolve({ request_id: 'req-2', error: '', message: '', warning: '' });
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

/** Step 9's deps for the SAME conta, the categoria leg off (no tree in this shop). */
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

async function criarKit(db: FakeDb, loja: Loja, ent: Partial<EntradaDeKit> = {}) {
  return await publicarKitShopee(deps(db, loja), entrada(ent), CRIAR);
}

/** Step 9's import of the kit, reading it through the REAL single-item read. */
async function importar(db: FakeDb, loja: Loja) {
  const lido = await lerAnuncioShopee(loja.client, KIT_ITEM);
  return await importarKitShopee(depsDaImportacao(db), lido);
}

/* ------------------------------- db readers --------------------------------- */

function doc(db: FakeDb, caminho: string): Json | undefined {
  return db.store[caminho]?.data as Json | undefined;
}

function produtos(db: FakeDb): string[] {
  return Object.keys(db.store)
    .filter((p) => /^produtos\/[^/]+$/.test(p))
    .sort();
}

function vinculosDe(db: FakeDb, produtoId: string): string[] {
  return db.idsEm(`produtos/${produtoId}/prodshopee`).sort();
}

/** Every `variashopee` of the conta naming `linkDocId`, as `[child, model_id]`. */
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

function avisoAberto(db: FakeDb): boolean {
  const aviso = doc(db, avisoCollection.docPath({}, chaveAvisoReceitaKitShopee(INTEGRACAO, K)));
  return aviso !== undefined && aviso.resolvidoEm == null;
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
/*  (1) the entry point                                                        */
/* ========================================================================== */

describe('publicarKitShopee — kit-criar de ponta a ponta', () => {
  it('cria a família: UM add_kit_item, o vínculo no id derivado, uma linha por filho, kitNativo true', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const loja = lojaComKits();

    const r = await criarKit(db, loja);

    expect(r).toMatchObject({
      arma: 'kit-criar',
      desfecho: 'criado',
      produtoId: K,
      itemId: KIT_ITEM,
      linkDocId: VINCULO,
      kitNativo: true,
      modelos: { vinculados: 2, anexados: 0, semFilho: 0 },
      recusa: null,
      comando: null,
    });
    expect(loja.ops.filter((o) => o === 'add_kit_item')).toHaveLength(1);
    expect(vinculosDe(db, K)).toEqual([VINCULO]);
    expect(linhasDoVinculo(db, VINCULO)).toEqual([
      [K_AZUL, KIT_MODELO],
      [K_VERDE, KIT_MODELO_2],
    ]);
    // ONE main across the kit (P2-a), on the first model holding the principal.
    const principais = loja.corposDoAdd[0]?.item_setting.model_list.flatMap((m) =>
      m.component_list.filter((c) => c.main_component === true),
    );
    expect(principais).toEqual([
      {
        component_item_id: COMP_A_ITEM,
        component_model_id: COMP_A_MODELO,
        quantity: 1,
        main_component: true,
      },
    ]);
  });

  it('⛔ o DRY RUN (ensaiarKitShopee) lê, busca e planeja — e não escreve nada nem chama add_kit_item', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const loja = lojaComKits();

    const ensaio = await ensaiarKitShopee(deps(db, loja), entrada(), CRIAR, resolvedorFake(loja));

    expect(ensaio.plano.kitNovo).toEqual({ acao: 'criar' });
    expect(ensaio.plano.problemas).toEqual([]);
    expect(ensaio.plano.corpo?.item_setting.item_sku).toBe(SKU);
    expect(ensaio.contexto.busca?.completo).toBe(true);
    expect(loja.ops).not.toContain('add_kit_item');
    expect(loja.ops).toContain('get_item_list');
    expect(db.writes).toEqual([]);
  });

  it('(M85) limites NÃO servidos ⇒ a criação segue; servidos com máximo 1 componente por modelo ⇒ recusa LOCAL, zero add_kit_item', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const servidos = lojaComKits({
      limites: { component_count_limit_of_single_model: { min_limit: 1, max_limit: 1 } },
    });

    const erro = await recusaDe(criarKit(db, servidos));

    expect(erro.problemas.map((p) => p.motivo)).toContain(
      MOTIVO_PUBLICACAO_BLOQUEADA.componentesForaDaFaixa,
    );
    expect(servidos.ops).not.toContain('add_kit_item');
    expect(db.writes).toEqual([]);

    // The SAME kit on a host that does not serve the band is created. (The band
    // is cached per (conta, category) for the TTL: a fresh window first.)
    limparTaxonomiaShopee();
    const db2 = new FakeDb();
    semearComponentes(db2);
    semearFamilia(db2);
    const r = await criarKit(db2, lojaComKits());
    expect(r.desfecho).toBe('criado');
  });

  it('(M96 / L1) uma família de 2 itens SEM --principal ⇒ principal-obrigatorio, nunca um padrão silencioso', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const loja = lojaComKits();

    const erro = await recusaDe(criarKit(db, loja, { principal: null }));

    expect(erro.problemas.map((p) => p.motivo)).toEqual([
      MOTIVO_PUBLICACAO_BLOQUEADA.principalObrigatorio,
    ]);
    expect(loja.ops).not.toContain('add_kit_item');
  });

  it('um --principal publicado que NÃO é componente ⇒ principal-invalido NOMEANDO-o', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    db.seed('produtos/avulso', { nome: 'Avulso', sku: 'AV', paiId: null });
    db.seed('produtos/avulso/prodshopee/link-avulso', {
      item_id: 2500139861,
      contaProdutoShopeeOuterRef: REF_CONTA,
      category_id: CATEGORIA,
    });
    const loja = lojaComKits();
    loja.itens.set(2500139861, {
      base: { item_id: 2500139861, item_status: 'NORMAL', has_model: false, tag: { kit: false } },
    });

    const erro = await recusaDe(criarKit(db, loja, { principal: 'avulso' }));

    expect(erro.problemas).toHaveLength(1);
    expect(erro.problemas[0]).toMatchObject({
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.principalInvalido,
    });
    expect(erro.problemas[0]?.mensagem).toContain('avulso');
  });

  it('(OP-8) um --principal que NÃO resolve, numa família de UM item ⇒ principal-invalido, nunca o principal padrão; zero add_kit_item', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamiliaDeUm(db);
    const loja = lojaComKits();

    const erro = await recusaDe(criarKit(db, loja, { principal: 'fantasma' }));

    expect(erro.problemas).toEqual([
      {
        campo: 'principal',
        motivo: MOTIVO_PUBLICACAO_BLOQUEADA.principalInvalido,
        mensagem: 'o componente principal fantasma não faz parte da composição do kit',
      },
    ]);
    expect(loja.ops).not.toContain('add_kit_item');
    expect(loja.ops).not.toContain('get_item_list');
    expect(db.writes).toEqual([]);

    // ⛔ QUASE-PAR: o MESMO kit sem --principal é criado com o principal padrão.
    const db2 = new FakeDb();
    semearComponentes(db2);
    semearFamiliaDeUm(db2);
    const r = await criarKit(db2, lojaComKits(), { principal: null });
    expect(r.desfecho).toBe('criado');
  });

  it('(OP-8) o mesmo nome irresolúvel numa família de DOIS itens ⇒ principal-invalido, nunca principal-obrigatorio', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const loja = lojaComKits();

    const erro = await recusaDe(criarKit(db, loja, { principal: 'fantasma' }));

    expect(erro.problemas.map((p) => p.motivo)).toEqual([
      MOTIVO_PUBLICACAO_BLOQUEADA.principalInvalido,
    ]);
    expect(loja.ops).not.toContain('add_kit_item');
  });

  it('(OP-9) --status UNLIST cria o kit PAUSADO: unlisted: true no add_kit_item e o read-back pausado; NORMAL não manda a chave', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const loja = lojaComKits();

    const r = await criarKit(db, loja, { statusPedido: 'UNLIST' });

    expect(loja.corposDoAdd[0]?.item_setting.unlisted).toBe(true);
    expect(r).toMatchObject({ desfecho: 'criado', itemStatus: 'UNLIST', estadoAnuncio: 'pausado' });

    // ⛔ QUASE-PAR: NORMAL ⇒ nenhuma chave `unlisted` (o corpo que as sondas mediram).
    const db2 = new FakeDb();
    semearComponentes(db2);
    semearFamilia(db2);
    const normal = lojaComKits();
    const n = await criarKit(db2, normal, { statusPedido: 'NORMAL' });
    expect('unlisted' in (normal.corposDoAdd[0]?.item_setting ?? { unlisted: 'ausente' })).toBe(
      false,
    );
    expect(n).toMatchObject({ desfecho: 'criado', itemStatus: 'NORMAL', estadoAnuncio: 'ativo' });
  });

  it('(R1-RT7-02) uma entrada GUARDADA sem quantidade: a criação verificada carimba o que os leitores dobram — o aviso NÃO abre', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const azul = doc(db, `produtos/${K_AZUL}`) ?? {};
    db.seed(`produtos/${K_AZUL}`, {
      ...azul,
      componentesKit: {
        'comp-a-filho': { quantidade: 1, limitarEstoque: true },
        'comp-b-membro': { limitarEstoque: true },
      },
    });
    const loja = lojaComKits();

    const r = await criarKit(db, loja);

    expect(r.desfecho).toBe('criado');
    expect(r.avisos.map((a) => a.codigo)).not.toContain('receita-divergente');
    expect(r.avisosResolvidos).toBe(1);
    expect(avisoAberto(db)).toBe(false);
  });
});

/* ========================================================================== */
/*  (2) RT1 — create → re-import                                               */
/* ========================================================================== */

describe('RT1 — a criação e a re-importação são um PONTO FIXO', () => {
  it('família de 2: o import cai em K pelo degrau 1, cada filho no SEU filho, as chaves BYTE A BYTE, sem aviso, UM vínculo, UMA linha por (vínculo, modelo)', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const loja = lojaComKits();
    const antesProdutos = produtos(db);
    const chavesAntes = {
      azul: Object.keys((doc(db, `produtos/${K_AZUL}`)?.componentesKit as Json) ?? {}).sort(),
      verde: Object.keys((doc(db, `produtos/${K_VERDE}`)?.componentesKit as Json) ?? {}).sort(),
    };
    await criarKit(db, loja);
    const carimbos = linhasCarimbadas(db);
    expect(carimbos).toEqual({
      [K_AZUL]: chaveReceitaKitErp({
        'comp-a-filho': { quantidade: 1 },
        'comp-b-membro': { quantidade: 1 },
      }),
      [K_VERDE]: chaveReceitaKitErp({ 'comp-a-filho': { quantidade: 2 } }),
    });

    const res = await importar(db, loja);

    expect(res.produtoId).toBe(K);
    expect(produtos(db)).toEqual(antesProdutos);
    expect(vinculosDe(db, K)).toEqual([VINCULO]);
    expect(linhasDoVinculo(db, VINCULO)).toEqual([
      [K_AZUL, KIT_MODELO],
      [K_VERDE, KIT_MODELO_2],
    ]);
    const azul = doc(db, `produtos/${K_AZUL}`)?.componentesKit as Record<string, Json>;
    const verde = doc(db, `produtos/${K_VERDE}`)?.componentesKit as Record<string, Json>;
    // B's key is the MEMBER (the sellable-unit hop), never the wrapper.
    expect(Object.keys(azul).sort()).toEqual(chavesAntes.azul);
    expect(Object.keys(verde).sort()).toEqual(chavesAntes.verde);
    expect(azul['comp-a-filho']).toMatchObject({ quantidade: 1, limitarEstoque: true });
    expect(azul['comp-b-membro']).toMatchObject({ quantidade: 1, limitarEstoque: true });
    expect(verde['comp-a-filho']).toMatchObject({ quantidade: 2, limitarEstoque: true });
    // n ≥ 2 ⇒ K carries no map of its own (today's import shape, R-8).
    expect(doc(db, `produtos/${K}`)?.componentesKit ?? null).toBeNull();
    expect(linhasCarimbadas(db)).toEqual(carimbos);
    expect(res.kit.avisos).toEqual([]);
    expect(avisoAberto(db)).toBe(false);
  });

  it('família de UM: zero escrita de taxonomia, e as variações do MEMBRO intocadas', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamiliaDeUm(db);
    const loja = lojaComKits();
    const antesProdutos = produtos(db);

    const r = await criarKit(db, loja);
    expect(r.desfecho).toBe('criado');
    expect(loja.corposDoAdd[0]?.item_setting.tier_variation_list).toEqual([
      { name: 'Kit', option_list: [{ option: 'Padrão' }] },
    ]);
    const membroAntes = structuredClone(doc(db, `produtos/${K_MEMBRO}`));
    const escritasAntes = db.writes.length;

    await importar(db, loja);

    const escritas = db.writes.slice(escritasAntes);
    expect(escritas.filter((w) => w.path.startsWith('grupoDeVariacoes/'))).toEqual([]);
    expect(produtos(db)).toEqual(antesProdutos);
    expect(doc(db, `produtos/${K}`)?.filhoUnicoId).toBe(K_MEMBRO);
    const membro = doc(db, `produtos/${K_MEMBRO}`);
    expect(membro?.variacoesUid ?? null).toEqual(membroAntes?.variacoesUid ?? null);
    expect(membro?.grupoDeVariacoesUid ?? null).toEqual(membroAntes?.grupoDeVariacoesUid ?? null);
    expect(linhasDoVinculo(db, VINCULO)).toEqual([[K_MEMBRO, KIT_MODELO]]);
    expect(avisoAberto(db)).toBe(false);
  });
});

/** `child → receitaKitConferida` of every row the kit link owns. */
function linhasCarimbadas(db: FakeDb): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const [filho, modelo] of linhasDoVinculo(db, VINCULO)) {
    const linha = doc(
      db,
      `produtos/${filho}/variashopee/${idDaVariacaoDeKit(VINCULO, modelo as number)}`,
    );
    saida[filho] = linha?.receitaKitConferida;
  }
  return saida;
}

/* ========================================================================== */
/*  (3) RT2 / RT3 — the order cascade and the stock gate read what was written */
/* ========================================================================== */

describe('RT2 — uma linha de pedido do kit criado', () => {
  it('(item do kit, modelo do kit) ⇒ o FILHO, pelo degrau 1 (variashopee) — cada modelo no seu filho', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    await criarKit(db, lojaComKits());

    for (const [modelId, filho] of [
      [KIT_MODELO, K_AZUL],
      [KIT_MODELO_2, K_VERDE],
    ] as const) {
      await expect(
        resolverProdutoDaLinhaShopee(asDb(db), {
          integracaoId: INTEGRACAO,
          itemId: KIT_ITEM,
          modelId,
          sku: null,
        }),
      ).resolves.toEqual({ produtoId: filho, via: 'variashopee' });
    }
  });
});

describe('RT3 — o passo 12 pula o kit criado', () => {
  it('o vínculo ESCRITO pela criação ⇒ kit-derivado', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    await criarKit(db, lojaComKits());

    const link = doc(db, `produtos/${K}/prodshopee/${VINCULO}`) ?? {};
    expect(podeEnviarEstoqueShopee(link, doc(db, `produtos/${K}`) ?? {}, { nowMs: AGORA })).toEqual(
      {
        enviar: false,
        motivo: MOTIVO_ESTOQUE_SHOPEE.kitDerivado,
      },
    );
  });

  it('⚠️ a QUEDA logo após a escrita do vínculo (sem releitura, sem linhas) ⇒ o literal kitNativo: true já faz o passo 12 pular', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const loja = lojaComKits();
    loja.falhaNaReleitura = new ShopeeNetworkError('caiu na releitura');

    await expect(criarKit(db, loja)).rejects.toBeInstanceOf(ShopeeNetworkError);

    const link = doc(db, `produtos/${K}/prodshopee/${VINCULO}`) ?? {};
    expect(link.kitNativo).toBe(true);
    expect(link.item_status ?? null).toBeNull();
    expect(linhasDoVinculo(db, VINCULO)).toEqual([]);
    expect(podeEnviarEstoqueShopee(link, doc(db, `produtos/${K}`) ?? {}, { nowMs: AGORA })).toEqual(
      {
        enviar: false,
        motivo: MOTIVO_ESTOQUE_SHOPEE.kitDerivado,
      },
    );
  });
});

/* ========================================================================== */
/*  (4) RT7 — THE L9 RECOVERY                                                  */
/* ========================================================================== */

describe('RT7 — a recuperação L9: um kit criado e NÃO vinculado é importado para o MESMO produto', () => {
  it('incerto ⇒ nada gravado; o re-run recusa «importe-o»; o import cai em K (degrau 2), A pelo SKU, o filho SEM SKU pela combinação; UM add_kit_item', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db, { semSkuVerde: true });
    const loja = lojaComKits();
    const antesProdutos = produtos(db);

    // 1 — Shopee CREATES the kit and answers with a transient refusal.
    loja.falhaAposCriar = muitasConexoes();
    const incerto = await criarKit(db, loja);

    expect(incerto).toMatchObject({
      desfecho: 'incerto',
      itemId: null,
      linkDocId: null,
      recusa: { motivo: 'instabilidade-shopee' },
    });
    expect(incerto.comando).toBe(
      `publicar:anuncio --integracao ${INTEGRACAO} --produto ${K} --principal comp-a-filho`,
    );
    expect(db.writes).toEqual([]);

    // 2 — the re-run of the SAME command: the scan finds it ⇒ "importe-o".
    const erro = await recusaDe(criarKit(db, loja));
    expect(erro.problemas.map((p) => p.motivo)).toEqual([
      MOTIVO_PUBLICACAO_BLOQUEADA.kitJaExisteNaShopee,
    ]);
    expect(erro.problemas[0]?.mensagem).toContain(String(KIT_ITEM));
    expect(loja.ops.filter((o) => o === 'add_kit_item')).toHaveLength(1);
    expect(db.writes).toEqual([]);

    // 3 — step 9's import, through the real single-item read.
    const res = await importar(db, loja);

    expect(res.produtoId).toBe(K);
    expect(produtos(db)).toEqual(antesProdutos);
    expect(vinculosDe(db, K)).toEqual([VINCULO]);
    expect(linhasDoVinculo(db, VINCULO)).toEqual([
      [K_AZUL, KIT_MODELO],
      [K_VERDE, KIT_MODELO_2],
    ]);
    expect(loja.ops.filter((o) => o === 'add_kit_item')).toHaveLength(1);
  });

  it('RT7 (cauda — republicarKit): kit-atualizar sobre os docs ESCRITOS pelo import ⇒ todo modelo vivo ligado, zero anexados, nenhuma linha criada duas vezes, add_kit_item UMA vez no total', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db, { semSkuVerde: true });
    const loja = lojaComKits();
    loja.falhaAposCriar = muitasConexoes();
    expect((await criarKit(db, loja)).desfecho).toBe('incerto');
    await recusaDe(criarKit(db, loja));
    await importar(db, loja);
    const linhasDoImport = linhasDoVinculo(db, VINCULO);
    const docsDeLinha = Object.keys(db.store)
      .filter((p) => p.includes('/variashopee/'))
      .sort();

    const r = await publicarKitShopee(deps(db, loja, AGORA + 2_000), entrada(), {
      arma: 'kit-atualizar',
      linkDocId: VINCULO,
    });

    expect(r).toMatchObject({
      arma: 'kit-atualizar',
      desfecho: 'atualizado',
      linkDocId: VINCULO,
      itemId: KIT_ITEM,
      modelos: { vinculados: 2, anexados: 0, semFilho: 0 },
    });
    expect(loja.ops.filter((o) => o === 'add_kit_item')).toHaveLength(1);
    expect(loja.ops.filter((o) => o === 'update_kit_item')).toHaveLength(1);
    const enviados = loja.corposDoUpdate[0]?.item_setting?.model_list ?? [];
    expect(enviados.map((m) => m.model_id).sort()).toEqual([KIT_MODELO, KIT_MODELO_2]);
    // Nothing was created twice: the import's rows are the only rows.
    expect(linhasDoVinculo(db, VINCULO)).toEqual(linhasDoImport);
    expect(
      Object.keys(db.store)
        .filter((p) => p.includes('/variashopee/'))
        .sort(),
    ).toEqual(docsDeLinha);
    expect(vinculosDe(db, K)).toEqual([VINCULO]);
  });

  it('⚠️ NEAR-MISS: um SEGUNDO produto RAIZ com o SKU de K ⇒ a primeira criação já recusa kit-sku-repetido na fase A, zero chamadas à Shopee', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    db.seed('produtos/outro-pai', { nome: 'Outro', sku: SKU, paiId: null });
    const loja = lojaComKits();

    const erro = await recusaDe(criarKit(db, loja));

    expect(erro.problemas.map((p) => p.motivo)).toEqual([
      MOTIVO_PUBLICACAO_BLOQUEADA.kitSkuRepetido,
    ]);
    expect(loja.ops).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('(S2C-01) os filhos já carregam as linhas de um anúncio REMOVIDO ⇒ o import ainda liga cada filho original, as linhas velhas byte a byte, nenhum produto cunhado', async () => {
    const db = new FakeDb();
    semearComponentes(db);
    semearFamilia(db);
    const removido = 'vinculo-removido';
    db.seed(`produtos/${K}/prodshopee/${removido}`, {
      item_id: 2500139861,
      contaProdutoShopeeOuterRef: REF_CONTA,
      estadoAnuncio: 'removido',
    });
    for (const [filho, modelo] of [
      [K_AZUL, 2000458802],
      [K_VERDE, 2000458803],
    ] as const) {
      db.seed(`produtos/${filho}/variashopee/velha-${String(modelo)}`, {
        model_id: modelo,
        contaVariacaoShopeeOuterRef: REF_CONTA,
        produtoShopeeOuterRef: `documents/produtos/${K}/prodshopee/${removido}`,
      });
    }
    const velhas = Object.fromEntries(
      Object.entries(db.store)
        .filter(([p]) => p.includes('/variashopee/velha-'))
        .map(([p, d]) => [p, structuredClone(d.data)]),
    );
    const loja = lojaComKits();
    const antesProdutos = produtos(db);

    loja.falhaAposCriar = muitasConexoes();
    expect((await criarKit(db, loja)).desfecho).toBe('incerto');
    await importar(db, loja);

    expect(produtos(db)).toEqual(antesProdutos);
    expect(linhasDoVinculo(db, VINCULO)).toEqual([
      [K_AZUL, KIT_MODELO],
      [K_VERDE, KIT_MODELO_2],
    ]);
    for (const [caminho, dados] of Object.entries(velhas)) {
      expect(db.store[caminho]?.data).toEqual(dados);
    }
    expect(doc(db, `produtos/${K}`)?.filhoUnicoId ?? null).toBeNull();
  });
});
