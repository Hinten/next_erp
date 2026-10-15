import { describe, expect, it, vi } from 'vitest';

import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeRateLimitError,
  shopeeItemBaseInfoPayloadSchema,
  shopeeItemBaseInfoSchema,
  shopeeItemListPayloadSchema,
  shopeeItemListSchema,
  type GetItemListParams,
  type ShopeeClient,
  type ShopeeItemBaseInfo,
  type ShopeeItemList,
} from '@delfrance/integrations-shopee';
import { toOuterRef } from '@delfrance/schemas';
import { integracaoCollection } from '@delfrance/data/admin/collections';

import {
  FIXTURE_ITEM_BASE_INFO_SG_KIT,
  FIXTURE_ITEM_BASE_INFO_SG_KIT_APAGADO,
  FIXTURE_ITEM_LIST_SG_COM_KIT,
  FIXTURE_ITEM_LIST_SG_SELLER_DELETE,
  IDS_DO_KIT_NO_CORPUS,
  lerFixture,
} from '../fixtures/wireCorpus';
import { FakeDb, asDb } from '../testing/fakeDb';
import { MAX_PAGINAS_BUSCA_KIT, STATUS_BUSCA_KIT } from './constantesKit';
import { localizarKitsPorSku } from './localizarKitPorSku';

/* --------------------------------- fixtures -------------------------------- */

const INTEGRACAO = 'int-1';
const REF_CONTA = toOuterRef(integracaoCollection.docPath({}, INTEGRACAO));
const REF_OUTRA_CONTA = toOuterRef(integracaoCollection.docPath({}, 'int-2'));

const KIT = IDS_DO_KIT_NO_CORPUS.kit;
const COMP_A = IDS_DO_KIT_NO_CORPUS.componenteA;
const COMP_B = IDS_DO_KIT_NO_CORPUS.componenteB;
/** The second kit role (the recriar's new kit / the double-create twin). */
const KIT_2 = 2500139873;
/** The SKU the REAL capture carries (`get_item_base_info.sg-kit`). */
const SKU = 'SONDA-KIT';

type Json = Record<string, unknown>;

/** `get_item_list` right after the create, as the probe captured it (kit, A, B). */
function corpoListaComKit(): Json {
  return lerFixture(FIXTURE_ITEM_LIST_SG_COM_KIT) as Json;
}

/**
 * ⚠️ SYNTHETIC, by a named transform of the REAL capture (the corpus README forbids
 * hand-adding it there): the kit row's `tag` set to `null`, every other byte kept —
 * a row that predates Shopee's `tag` field (2024-10-18).
 */
function semTag(corpo: Json, itemId: number = KIT): Json {
  const copia = structuredClone(corpo) as { response: { item: Json[] } };
  for (const linha of copia.response.item) {
    if (linha.item_id === itemId) linha.tag = null;
  }
  return copia;
}

function pagina(corpo: Json): ShopeeItemList {
  return shopeeItemListSchema.parse(corpo).response;
}

/** The kit's REAL base row, with the given overrides on that row. */
function baseDoKit(over: Json = {}, fixture = FIXTURE_ITEM_BASE_INFO_SG_KIT): Json {
  const corpo = shopeeItemBaseInfoSchema.parse(lerFixture(fixture)).response;
  const linha = corpo.item_list[0] as Json;
  return { ...linha, ...over };
}

function linhaDaLista(itemId: number, kit: boolean | null, status = 'NORMAL'): Json {
  return {
    item_id: itemId,
    item_status: status,
    update_time: 1791244800,
    tag: kit === null ? null : { kit },
  };
}

function paginaSintetica(
  linhas: Json[],
  proxima: { has: boolean; next?: number | null },
): ShopeeItemList {
  return shopeeItemListPayloadSchema.parse({
    item: linhas,
    total_count: linhas.length,
    has_next_page: proxima.has,
    next_offset: proxima.next ?? null,
    next: '',
  });
}

/** A client with `getItemList` + `getItemBaseInfo`, both recorded. */
function cliente(a: {
  readonly paginas: (p: GetItemListParams, indice: number) => ShopeeItemList;
  readonly bases?: readonly Json[];
  readonly falhaDaBase?: Error;
}): {
  readonly client: ShopeeClient;
  readonly getItemList: ReturnType<typeof vi.fn>;
  readonly getItemBaseInfo: ReturnType<typeof vi.fn>;
} {
  let indice = 0;
  const getItemList = vi.fn((p: GetItemListParams) => Promise.resolve(a.paginas(p, indice++)));
  const porId = new Map((a.bases ?? []).map((b) => [b.item_id as number, b]));
  const getItemBaseInfo = vi.fn(
    (p: { itemIds: readonly number[] }): Promise<ShopeeItemBaseInfo> =>
      a.falhaDaBase !== undefined
        ? Promise.reject(a.falhaDaBase)
        : Promise.resolve(
            shopeeItemBaseInfoPayloadSchema.parse({
              item_list: p.itemIds.map((id) => porId.get(id)).filter((b) => b !== undefined),
            }),
          ),
  );
  return {
    client: { getItemList, getItemBaseInfo } as unknown as ShopeeClient,
    getItemList,
    getItemBaseInfo,
  };
}

async function buscar(
  client: ShopeeClient,
  db: FakeDb = new FakeDb(),
  over: { sku?: string; excluir?: readonly number[] } = {},
) {
  return localizarKitsPorSku(client, asDb(db), {
    integracaoId: INTEGRACAO,
    sku: over.sku ?? SKU,
    excluirItemIds: new Set(over.excluir ?? []),
  });
}

/* ---------------------------------- tests ---------------------------------- */

describe('localizarKitsPorSku — over the REAL capture', () => {
  it('finds the probe kit by its SKU: one page, ONE base-info call over the kit row only', async () => {
    const { client, getItemList, getItemBaseInfo } = cliente({
      paginas: () => pagina(corpoListaComKit()),
      bases: [baseDoKit()],
    });

    const r = await buscar(client);

    expect(r).toEqual({
      completo: true,
      achados: [{ itemId: KIT, vinculo: null }],
      paginas: 1,
      chamadas: 2,
    });
    // A and B carry `tag.kit: false` — DATA, never asked about.
    expect(getItemBaseInfo).toHaveBeenCalledTimes(1);
    expect(getItemBaseInfo.mock.calls[0]![0]).toEqual({ itemIds: [KIT] });
    expect(getItemList).toHaveBeenCalledTimes(1);
  });

  it('(M79) the page asks EXACTLY the four live statuses, 100 per page, from offset 0, with NO time window', async () => {
    const { client, getItemList } = cliente({
      paginas: () => pagina(corpoListaComKit()),
      bases: [baseDoKit()],
    });

    await buscar(client);

    const pedido = getItemList.mock.calls[0]![0] as GetItemListParams;
    expect(pedido).toEqual({ offset: 0, pageSize: 100, statuses: STATUS_BUSCA_KIT });
    expect([...pedido.statuses]).toEqual(['NORMAL', 'UNLIST', 'REVIEWING', 'BANNED']);
    expect('updateTimeFromS' in pedido).toBe(false);
    expect('updateTimeToS' in pedido).toBe(false);
  });

  it('(M79) a DELETED same-SKU kit is never a hit — the status filter is what keeps it out', async () => {
    // The fake honours the filter the way Shopee does: the SELLER_DELETE capture is
    // served ONLY to a page that asks for SELLER_DELETE.
    const { client, getItemBaseInfo } = cliente({
      paginas: (p) =>
        p.statuses.includes('SELLER_DELETE')
          ? pagina(lerFixture(FIXTURE_ITEM_LIST_SG_SELLER_DELETE) as Json)
          : paginaSintetica([], { has: false }),
      // Its base row: the same SKU, a kit — it WOULD be a hit if it were listed.
      bases: [baseDoKit({}, FIXTURE_ITEM_BASE_INFO_SG_KIT_APAGADO)],
    });

    const r = await buscar(client);

    expect(r.achados).toEqual([]);
    expect(r.completo).toBe(true);
    expect(getItemBaseInfo).not.toHaveBeenCalled();
  });
});

describe("localizarKitsPorSku — the SKU fold is step 9's parent rung (M80)", () => {
  it("PAR IGUAL: Shopee's `SONDA-KIT ` (trailing space) is a hit for the ERP's `SONDA-KIT`", async () => {
    const { client } = cliente({
      paginas: () => pagina(corpoListaComKit()),
      bases: [baseDoKit({ item_sku: ' SONDA-KIT ' })],
    });

    expect((await buscar(client)).achados).toEqual([{ itemId: KIT, vinculo: null }]);
  });

  it('⛔ NEAR-MISS: case, inner whitespace and an absent item_sku are NOT hits', async () => {
    for (const item_sku of ['sonda-kit', 'SONDA KIT', 'SONDA-KIT2', null, '']) {
      const { client } = cliente({
        paginas: () => pagina(corpoListaComKit()),
        bases: [baseDoKit({ item_sku })],
      });

      expect((await buscar(client)).achados, String(item_sku)).toEqual([]);
    }
  });

  it('⛔ a padded or empty ERP SKU is a caller bug: RangeError, ZERO Shopee calls', async () => {
    for (const sku of ['', ' SONDA-KIT', 'SONDA-KIT ']) {
      const { client, getItemList, getItemBaseInfo } = cliente({
        paginas: () => pagina(corpoListaComKit()),
      });

      await expect(buscar(client, new FakeDb(), { sku }), JSON.stringify(sku)).rejects.toThrow(
        RangeError,
      );
      expect(getItemList).not.toHaveBeenCalled();
      expect(getItemBaseInfo).not.toHaveBeenCalled();
    }
  });
});

describe('localizarKitsPorSku — fail closed on the tag (M88)', () => {
  it('(M88) the semTag(sg-com-kit) row is still a candidate, and its base info makes it a hit', async () => {
    const { client, getItemBaseInfo } = cliente({
      paginas: () => pagina(semTag(corpoListaComKit())),
      bases: [baseDoKit()],
    });

    const r = await buscar(client);

    expect(r.achados).toEqual([{ itemId: KIT, vinculo: null }]);
    expect(getItemBaseInfo.mock.calls[0]![0]).toEqual({ itemIds: [KIT] });
  });

  it('⛔ NEAR-MISS: a tag-less ORDINARY listing is asked about, and its base `tag.kit: false` keeps it out', async () => {
    // A's row predates the tag: it joins the batch, but it is not a kit.
    const { client, getItemBaseInfo } = cliente({
      paginas: () => pagina(semTag(corpoListaComKit(), COMP_A)),
      bases: [baseDoKit(), { ...baseDoKit(), item_id: COMP_A, tag: { kit: false } }],
    });

    const r = await buscar(client);

    expect(getItemBaseInfo.mock.calls[0]![0]).toEqual({ itemIds: [KIT, COMP_A] });
    expect(r.achados).toEqual([{ itemId: KIT, vinculo: null }]);
  });

  it("a base row with NO tag defers to the list row's `tag.kit: true` (the import's own reading)", async () => {
    const { client } = cliente({
      paginas: () => pagina(corpoListaComKit()),
      bases: [baseDoKit({ tag: null })],
    });

    expect((await buscar(client)).achados).toEqual([{ itemId: KIT, vinculo: null }]);
  });

  it('⛔ NEAR-MISS: no tag on EITHER side is not a kit', async () => {
    const { client } = cliente({
      paginas: () => pagina(semTag(corpoListaComKit())),
      bases: [baseDoKit({ tag: null })],
    });

    expect((await buscar(client)).achados).toEqual([]);
  });

  it('a candidate whose base row never came back is not a hit', async () => {
    const { client } = cliente({ paginas: () => pagina(corpoListaComKit()), bases: [] });

    expect(await buscar(client)).toEqual({ completo: true, achados: [], paginas: 1, chamadas: 2 });
  });
});

describe('localizarKitsPorSku — who links a hit (M89), and the exclusion', () => {
  it('(M89) a same-SKU kit linked to ANOTHER produto is a hit naming that produto — a first create excludes nothing', async () => {
    const db = new FakeDb();
    db.seed('produtos/outro-kit', { nome: 'K', sku: SKU, paiId: null });
    db.seed('produtos/outro-kit/prodshopee/vinc-k', {
      item_id: KIT,
      contaProdutoShopeeOuterRef: REF_CONTA,
      kitNativo: true,
    });
    const { client } = cliente({ paginas: () => pagina(corpoListaComKit()), bases: [baseDoKit()] });

    const r = await buscar(client, db);

    expect(r.achados).toEqual([
      { itemId: KIT, vinculo: { produtoId: 'outro-kit', linkDocId: 'vinc-k' } },
    ]);
    // ONE lookup on the declared (item_id, conta) composite, item_id a NUMBER.
    const grupo = db.consultas.filter((c) => c.fonte.startsWith('group:'));
    expect(grupo).toHaveLength(1);
    expect(grupo[0]!.clausulas).toEqual([
      ['item_id', KIT],
      ['contaProdutoShopeeOuterRef', REF_CONTA],
    ]);
  });

  it('⛔ NEAR-MISS: a link of ANOTHER conta does not link the hit here', async () => {
    const db = new FakeDb();
    db.seed('produtos/outro-kit', { nome: 'K', sku: SKU, paiId: null });
    db.seed('produtos/outro-kit/prodshopee/vinc-k', {
      item_id: KIT,
      contaProdutoShopeeOuterRef: REF_OUTRA_CONTA,
    });
    const { client } = cliente({ paginas: () => pagina(corpoListaComKit()), bases: [baseDoKit()] });

    expect((await buscar(client, db)).achados).toEqual([{ itemId: KIT, vinculo: null }]);
  });

  it('`excluirItemIds` (the recriar target) is dropped before the base info; ⛔ NEAR-MISS another id excluded keeps the hit', async () => {
    const excluido = cliente({ paginas: () => pagina(corpoListaComKit()), bases: [baseDoKit()] });
    const r = await buscar(excluido.client, new FakeDb(), { excluir: [KIT] });
    expect(r.achados).toEqual([]);
    expect(excluido.getItemBaseInfo).not.toHaveBeenCalled();
    expect(r.chamadas).toBe(1);

    const outro = cliente({ paginas: () => pagina(corpoListaComKit()), bases: [baseDoKit()] });
    expect((await buscar(outro.client, new FakeDb(), { excluir: [KIT_2] })).achados).toEqual([
      { itemId: KIT, vinculo: null },
    ]);
  });

  it('every hit, sorted by item_id — never only the first', async () => {
    const { client } = cliente({
      paginas: () =>
        paginaSintetica([linhaDaLista(KIT_2, true), linhaDaLista(KIT, true)], { has: false }),
      bases: [baseDoKit({ item_id: KIT_2 }), baseDoKit()],
    });

    expect((await buscar(client)).achados).toEqual([
      { itemId: KIT, vinculo: null },
      { itemId: KIT_2, vinculo: null },
    ]);
  });
});

describe('localizarKitsPorSku — the walk', () => {
  it("follows Shopee's own next_offset, and a row seen twice is asked about once", async () => {
    const { client, getItemList, getItemBaseInfo } = cliente({
      paginas: (_p, i) =>
        i === 0
          ? paginaSintetica([linhaDaLista(COMP_B, false), linhaDaLista(KIT, true)], {
              has: true,
              next: 137,
            })
          : paginaSintetica([linhaDaLista(KIT, true)], { has: false }),
      bases: [baseDoKit()],
    });

    const r = await buscar(client);

    expect(getItemList.mock.calls.map((c) => (c[0] as GetItemListParams).offset)).toEqual([0, 137]);
    expect(getItemBaseInfo.mock.calls[0]![0]).toEqual({ itemIds: [KIT] });
    expect(r).toEqual({
      completo: true,
      achados: [{ itemId: KIT, vinculo: null }],
      paginas: 2,
      chamadas: 3,
    });
  });

  it('an empty shop: complete, nothing found, one call', async () => {
    const { client, getItemBaseInfo } = cliente({
      paginas: () => paginaSintetica([], { has: false }),
    });

    expect(await buscar(client)).toEqual({ completo: true, achados: [], paginas: 1, chamadas: 1 });
    expect(getItemBaseInfo).not.toHaveBeenCalled();
  });

  it(`after ${String(MAX_PAGINAS_BUSCA_KIT)} pages still reporting more: INCOMPLETE, no base info, nothing found`, async () => {
    const { client, getItemList, getItemBaseInfo } = cliente({
      paginas: (p) =>
        paginaSintetica([linhaDaLista(KIT, true)], { has: true, next: p.offset + 100 }),
      bases: [baseDoKit()],
    });

    const r = await buscar(client);

    expect(getItemList).toHaveBeenCalledTimes(MAX_PAGINAS_BUSCA_KIT);
    expect(getItemBaseInfo).not.toHaveBeenCalled();
    expect(r).toEqual({ completo: false, achados: [], paginas: 100, chamadas: 100 });
  });

  it(`⛔ NEAR-MISS: page ${String(MAX_PAGINAS_BUSCA_KIT)} being the LAST is a complete walk`, async () => {
    const { client, getItemList } = cliente({
      paginas: (p, i) =>
        paginaSintetica([linhaDaLista(KIT, true)], {
          has: i < MAX_PAGINAS_BUSCA_KIT - 1,
          next: p.offset + 100,
        }),
      bases: [baseDoKit()],
    });

    const r = await buscar(client);

    expect(getItemList).toHaveBeenCalledTimes(MAX_PAGINAS_BUSCA_KIT);
    expect(r.completo).toBe(true);
    expect(r.achados).toEqual([{ itemId: KIT, vinculo: null }]);
  });

  it('⛔ a cursor Shopee did not hand back, or one that does not advance, is INCOMPLETE — never the end of the shop', async () => {
    for (const next of [null, 0]) {
      const { client, getItemList, getItemBaseInfo } = cliente({
        paginas: () => paginaSintetica([linhaDaLista(KIT, true)], { has: true, next }),
        bases: [baseDoKit()],
      });

      const r = await buscar(client);

      expect(r, String(next)).toEqual({ completo: false, achados: [], paginas: 1, chamadas: 1 });
      expect(getItemList).toHaveBeenCalledTimes(1);
      expect(getItemBaseInfo).not.toHaveBeenCalled();
    }
  });

  it('a list failure propagates untouched (rule 6)', async () => {
    const erro = new ShopeeRateLimitError('limite', {
      code: 'error_too_many_request',
      kind: 'burst',
      httpStatus: 429,
      path: '/api/v2/product/get_item_list',
    });
    const client = {
      getItemList: vi.fn(() => Promise.reject(erro)),
      getItemBaseInfo: vi.fn(),
    } as unknown as ShopeeClient;

    await expect(buscar(client)).rejects.toBe(erro);
  });

  it('candidates that vanished before the base info (the batch "none exists" verdict) are simply not hits', async () => {
    const { client } = cliente({
      paginas: () => pagina(corpoListaComKit()),
      falhaDaBase: new ShopeeApiError('Shopee respondeu error_item_not_found (HTTP 200)', {
        code: 'product.error_item_not_found',
        kind: SHOPEE_ERROR_KIND.other,
        httpStatus: 200,
        path: '/api/v2/product/get_item_base_info',
      }),
    });

    expect(await buscar(client)).toEqual({ completo: true, achados: [], paginas: 1, chamadas: 2 });
  });

  it('writes nothing', async () => {
    const db = new FakeDb();
    const { client } = cliente({ paginas: () => pagina(corpoListaComKit()), bases: [baseDoKit()] });

    await buscar(client, db);

    expect(db.writes).toEqual([]);
  });
});
