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
import {
  BuscaForaDoPrazoShopeeError,
  clienteDaBuscaNoPrazo,
  fraseDaBaseInfoNaoDevolvida,
  localizarItensPorSku,
  localizarKitsPorSku,
  varrerListaDeItensShopee,
} from './localizarKitPorSku';

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
      listados: new Map([[KIT, 'NORMAL']]),
      incompleta: null,
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

  it('⛔ (#1911 batch-A) a candidate whose base row never came back is NOT "not a hit": the scan is INCOMPLETE (base-info), naming it', async () => {
    const { client, getItemBaseInfo } = cliente({
      paginas: () => pagina(corpoListaComKit()),
      bases: [],
    });

    expect(await buscar(client)).toEqual({
      completo: false,
      achados: [],
      listados: new Map(),
      incompleta: { causa: 'base-info', itemIds: [KIT] },
      paginas: 1,
      // The pages PLUS the base-info call actually made.
      chamadas: 2,
    });
    expect(getItemBaseInfo).toHaveBeenCalledTimes(1);
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
      listados: new Map([[KIT, 'NORMAL']]),
      incompleta: null,
      paginas: 2,
      chamadas: 3,
    });
  });

  it('(#2065) `listados` = EVERY candidate the complete walk listed — hit or not — with its LIST row status; never a non-candidate, never the excluded id', async () => {
    const { client } = cliente({
      paginas: () =>
        paginaSintetica(
          [
            linhaDaLista(KIT, true),
            // Not a hit (another SKU), but listed: it exists.
            linhaDaLista(KIT_2, null, 'UNLIST'),
            // DATA says not a kit: never a candidate.
            linhaDaLista(COMP_B, false),
            // The recriar's own target: excluded before any base info.
            linhaDaLista(COMP_A, true),
          ],
          { has: false },
        ),
      bases: [baseDoKit(), baseDoKit({ item_id: KIT_2, item_sku: 'OUTRO-KIT' })],
    });

    const r = await buscar(client, new FakeDb(), { excluir: [COMP_A] });

    expect(r.achados).toEqual([{ itemId: KIT, vinculo: null }]);
    expect(r.listados).toEqual(
      new Map([
        [KIT, 'NORMAL'],
        [KIT_2, 'UNLIST'],
      ]),
    );
  });

  it('an empty shop: complete, nothing found, one call', async () => {
    const { client, getItemBaseInfo } = cliente({
      paginas: () => paginaSintetica([], { has: false }),
    });

    expect(await buscar(client)).toEqual({
      completo: true,
      achados: [],
      listados: new Map(),
      incompleta: null,
      paginas: 1,
      chamadas: 1,
    });
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
    expect(r).toEqual({
      completo: false,
      achados: [],
      listados: new Map(),
      incompleta: { causa: 'lista' },
      paginas: 100,
      chamadas: 100,
    });
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

      expect(r, String(next)).toEqual({
        completo: false,
        achados: [],
        listados: new Map(),
        incompleta: { causa: 'lista' },
        paginas: 1,
        chamadas: 1,
      });
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

  it('⛔ (#1911 batch-A) candidates that vanished before the base info (the batch "none exists" verdict) make the scan INCOMPLETE — never "nothing found"', async () => {
    const { client } = cliente({
      paginas: () => pagina(corpoListaComKit()),
      falhaDaBase: new ShopeeApiError('Shopee respondeu error_item_not_found (HTTP 200)', {
        code: 'product.error_item_not_found',
        kind: SHOPEE_ERROR_KIND.other,
        httpStatus: 200,
        path: '/api/v2/product/get_item_base_info',
      }),
    });

    expect(await buscar(client)).toEqual({
      completo: false,
      achados: [],
      listados: new Map(),
      incompleta: { causa: 'base-info', itemIds: [KIT] },
      paginas: 1,
      chamadas: 2,
    });
  });

  it('writes nothing', async () => {
    const db = new FakeDb();
    const { client } = cliente({ paginas: () => pagina(corpoListaComKit()), bases: [baseDoKit()] });

    await buscar(client, db);

    expect(db.writes).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  #1911 P5b verifier — THE walk's "FIRST sighting wins", pinned              */
/* -------------------------------------------------------------------------- */

describe('varrerListaDeItensShopee — FIRST sighting wins (the walk P5b shares with ENSURE and both same-SKU scans)', () => {
  /** Page 1 shows `KIT` tagged kit; page 2 shows the SAME row again with no tag. */
  function duasVistas(): (p: GetItemListParams, indice: number) => ShopeeItemList {
    return (_p, indice) =>
      indice === 0
        ? paginaSintetica([linhaDaLista(KIT, true), linhaDaLista(COMP_A, false)], {
            has: true,
            next: 100,
          })
        : paginaSintetica([linhaDaLista(KIT, null)], { has: false });
  }

  it('a row an offset walk shows twice keeps its FIRST list row, in first-sighting order', async () => {
    const { client } = cliente({ paginas: duasVistas() });

    const v = await varrerListaDeItensShopee(client, {
      maxPaginas: MAX_PAGINAS_BUSCA_KIT,
      candidato: () => true,
      registro: { origem: '[teste]', ids: {} },
    });

    expect(v).toMatchObject({ completo: true, paginas: 2 });
    expect([...v.candidatos.keys()]).toEqual([KIT, COMP_A]);
    expect(v.candidatos.get(KIT)?.tag).toEqual({ kit: true });
  });

  it('⛔ why it matters (fail closed): a tag-less base reads the FIRST sighting — the kit tag — so the kit is still a hit', async () => {
    const { client } = cliente({
      paginas: duasVistas(),
      bases: [baseDoKit({ tag: null, item_sku: SKU })],
    });

    const r = await buscar(client);

    expect(r.completo).toBe(true);
    expect(r.achados.map((a) => a.itemId)).toEqual([KIT]);
  });
});

/* -------------------------------------------------------------------------- */
/*  #1911 batch-A review — a LISTED row the base-info batch never returned     */
/*  is a DOUBT: the scan is incomplete, for BOTH kinds, in the ONE loop        */
/* -------------------------------------------------------------------------- */

describe('localizarItensPorSku — a listed candidate with NO base row fails CLOSED (#1911 batch-A review)', () => {
  /** Ordinary listings of the shop (the ordinary arm's ids; fixture values). */
  const ITEM_1 = 2500200001;
  const ITEM_2 = 2500200002;
  const SKU_ITEM = 'SKU-1';

  /** An ORDINARY listing's base row — the REAL kit capture underneath, re-tagged. */
  function baseComum(itemId: number, item_sku: string | null = SKU_ITEM): Json {
    return baseDoKit({ item_id: itemId, item_sku, tag: { kit: false } });
  }

  function buscarItens(client: ShopeeClient, db: FakeDb = new FakeDb()) {
    return localizarItensPorSku(client, asDb(db), {
      integracaoId: INTEGRACAO,
      sku: SKU_ITEM,
      excluirItemIds: new Set<number>(),
      kit: false,
    });
  }

  it("the bot's repro: one NORMAL row, `tag.kit: false`, base info answers `item_list: []` ⇒ INCOMPLETE, no achados, the id named", async () => {
    const { client, getItemBaseInfo } = cliente({
      paginas: () => paginaSintetica([linhaDaLista(ITEM_1, false)], { has: false }),
      bases: [],
    });

    expect(await buscarItens(client)).toEqual({
      completo: false,
      achados: [],
      listados: new Map(),
      incompleta: { causa: 'base-info', itemIds: [ITEM_1] },
      paginas: 1,
      chamadas: 2,
    });
    expect(getItemBaseInfo).toHaveBeenCalledTimes(1);
  });

  it('⛔ quase-par: a base row with ANOTHER SKU ⇒ COMPLETE, nothing found (the read proved it is not ours)', async () => {
    const { client } = cliente({
      paginas: () => paginaSintetica([linhaDaLista(ITEM_1, false)], { has: false }),
      bases: [baseComum(ITEM_1, 'OUTRO-SKU')],
    });

    expect(await buscarItens(client)).toEqual({
      completo: true,
      achados: [],
      listados: new Map([[ITEM_1, 'NORMAL']]),
      incompleta: null,
      paginas: 1,
      chamadas: 2,
    });
  });

  it('a HIT beside an unread candidate is NOT reported: incomplete, `achados` empty, and NO link read', async () => {
    const db = new FakeDb();
    const { client } = cliente({
      paginas: () =>
        paginaSintetica([linhaDaLista(ITEM_1, false), linhaDaLista(ITEM_2, false)], {
          has: false,
        }),
      bases: [baseComum(ITEM_1)],
    });

    const r = await buscarItens(client, db);

    expect(r).toMatchObject({
      completo: false,
      achados: [],
      incompleta: { causa: 'base-info', itemIds: [ITEM_2] },
    });
    // Nothing it found could change the refusal: no `resolverLinkPorItemId`.
    expect(db.consultas.filter((c) => c.fonte.startsWith('group:'))).toEqual([]);
  });

  it('⛔ quase-par: EVERY row read ⇒ complete, and the hit is listed (with its link read)', async () => {
    const db = new FakeDb();
    const { client } = cliente({
      paginas: () =>
        paginaSintetica([linhaDaLista(ITEM_1, false), linhaDaLista(ITEM_2, false)], {
          has: false,
        }),
      bases: [baseComum(ITEM_1), baseComum(ITEM_2, 'OUTRO-SKU')],
    });

    const r = await buscarItens(client, db);

    expect(r).toEqual({
      completo: true,
      achados: [{ itemId: ITEM_1, vinculo: null }],
      listados: new Map([
        [ITEM_1, 'NORMAL'],
        [ITEM_2, 'NORMAL'],
      ]),
      incompleta: null,
      paginas: 1,
      chamadas: 2,
    });
    expect(db.consultas.filter((c) => c.fonte.startsWith('group:'))).toHaveLength(1);
  });

  it('the KIT arm, the same loop: a listed kit candidate with no base row ⇒ incomplete (no `kit` fork keeps the old skip)', async () => {
    // The ordinary arm's own repro mirrored onto `kit: true` — a row tagged kit.
    const { client } = cliente({
      paginas: () => paginaSintetica([linhaDaLista(KIT, true)], { has: false }),
      bases: [],
    });

    expect(await buscar(client)).toMatchObject({
      completo: false,
      achados: [],
      incompleta: { causa: 'base-info', itemIds: [KIT] },
    });
  });

  it('⛔ quase-par (kit): a base row that is NOT a kit, or carries another SKU ⇒ complete, nothing found', async () => {
    for (const over of [{ tag: { kit: false } }, { item_sku: 'OUTRO-KIT' }]) {
      const { client } = cliente({
        paginas: () => paginaSintetica([linhaDaLista(KIT, null)], { has: false }),
        bases: [baseDoKit(over)],
      });

      expect(await buscar(client), JSON.stringify(over)).toEqual({
        completo: true,
        achados: [],
        listados: new Map([[KIT, 'NORMAL']]),
        incompleta: null,
        paginas: 1,
        chamadas: 2,
      });
    }
  });

  it('`chamadas` counts EVERY base-info call made: 60 candidates ⇒ two chunks, one id missing ⇒ 1 page + 2', async () => {
    const ids = Array.from({ length: 60 }, (_v, i) => ITEM_1 + i);
    const faltando = ids[55]!;
    const { client, getItemBaseInfo } = cliente({
      paginas: () =>
        paginaSintetica(
          ids.map((id) => linhaDaLista(id, false)),
          { has: false },
        ),
      bases: ids.filter((id) => id !== faltando).map((id) => baseComum(id, 'OUTRO-SKU')),
    });

    const r = await buscarItens(client);

    expect(getItemBaseInfo).toHaveBeenCalledTimes(2);
    expect(r).toEqual({
      completo: false,
      achados: [],
      listados: new Map(),
      incompleta: { causa: 'base-info', itemIds: [faltando] },
      paginas: 1,
      chamadas: 3,
    });
  });

  it('ONE console.warn: the count and at most 10 ids — every id still in `incompleta`, never a SKU', async () => {
    const ids = Array.from({ length: 12 }, (_v, i) => ITEM_1 + 11 - i);
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { client } = cliente({
        paginas: () =>
          paginaSintetica(
            ids.map((id) => linhaDaLista(id, false)),
            { has: false },
          ),
        bases: [],
      });

      const r = await buscarItens(client);

      const ordenados = [...ids].sort((x, y) => x - y);
      expect(r.incompleta).toEqual({ causa: 'base-info', itemIds: ordenados });
      expect(aviso).toHaveBeenCalledTimes(1);
      const [linha, campos] = aviso.mock.calls[0]!;
      expect(String(linha)).toContain('12 anúncio(s)');
      expect(campos).toEqual({
        integracaoId: INTEGRACAO,
        naoLidos: 12,
        itemIds: ordenados.slice(0, 10),
      });
      expect(JSON.stringify(aviso.mock.calls)).not.toContain(SKU_ITEM);
    } finally {
      aviso.mockRestore();
    }
  });

  it('the shared sentence names the count and ≤ 10 ids ("e mais N"), and says what to do', () => {
    const doze = Array.from({ length: 12 }, (_v, i) => ITEM_1 + i);
    const frase = fraseDaBaseInfoNaoDevolvida(doze);
    expect(frase).toContain('a Shopee não devolveu os dados de 12 anúncio(s) listado(s)');
    expect(frase).toContain(`${String(ITEM_1 + 9)} e mais 2`);
    expect(frase).not.toContain(String(ITEM_1 + 10));
    expect(frase).toContain('nada foi criado; tente de novo');
    expect(frase).toContain('confira esses anúncios no Seller Centre');
    expect(fraseDaBaseInfoNaoDevolvida([ITEM_1])).toContain(`(ids ${String(ITEM_1)})`);
  });
});

describe('the deadline checkpoint `podeContinuar` (#1911 batch-A review, 2026-10-28)', () => {
  const ITEM_1 = 2500300001;
  const SKU_ITEM = 'SKU-1';

  function baseComum(itemId: number, item_sku: string | null = SKU_ITEM): Json {
    return baseDoKit({ item_id: itemId, item_sku, tag: { kit: false } });
  }

  /** `n` pages of one ordinary row each, Shopee's own cursor between them. */
  function paginas(n: number): (p: GetItemListParams, i: number) => ShopeeItemList {
    return (_p, i) =>
      paginaSintetica([linhaDaLista(ITEM_1 + i, false)], {
        has: i + 1 < n,
        next: i + 1 < n ? (i + 1) * 100 : null,
      });
  }

  /** A predicate that answers `true` exactly `k` times, then `false`, counting the asks. */
  function ate(k: number): {
    readonly podeContinuar: () => boolean;
    readonly perguntas: () => number;
  } {
    let n = 0;
    return {
      podeContinuar: () => {
        n += 1;
        return n <= k;
      },
      perguntas: () => n,
    };
  }

  it('the walk asks BEFORE EACH page: false before page 1 ⇒ throws, ZERO pages', async () => {
    const { client, getItemList } = cliente({ paginas: paginas(3) });
    const p = ate(0);

    const err = await varrerListaDeItensShopee(client, {
      maxPaginas: 10,
      candidato: () => true,
      registro: { origem: '[t]', ids: {} },
      podeContinuar: p.podeContinuar,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BuscaForaDoPrazoShopeeError);
    expect((err as BuscaForaDoPrazoShopeeError).antesDe).toBe('get_item_list');
    expect(getItemList).not.toHaveBeenCalled();
  });

  it('…false after page k (k = 2 of 3) ⇒ stops at k: no answer at all, never a partial "complete"', async () => {
    const { client, getItemList } = cliente({ paginas: paginas(3) });

    const err = await varrerListaDeItensShopee(client, {
      maxPaginas: 10,
      candidato: () => true,
      registro: { origem: '[t]', ids: {} },
      podeContinuar: ate(2).podeContinuar,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BuscaForaDoPrazoShopeeError);
    expect(getItemList).toHaveBeenCalledTimes(2);
  });

  it('⛔ NEAR-MISS: true throughout ⇒ the walk completes as before, asking once per page', async () => {
    const { client } = cliente({ paginas: paginas(3) });
    const p = ate(99);

    const r = await varrerListaDeItensShopee(client, {
      maxPaginas: 10,
      candidato: () => true,
      registro: { origem: '[t]', ids: {} },
      podeContinuar: p.podeContinuar,
    });

    expect(r).toMatchObject({ completo: true, paginas: 3 });
    expect(p.perguntas()).toBe(3);
  });

  it('⛔ "continue only if": a predicate answering anything but `true` stops the walk', async () => {
    const { client, getItemList } = cliente({ paginas: paginas(1) });
    const err = await varrerListaDeItensShopee(client, {
      maxPaginas: 10,
      candidato: () => true,
      registro: { origem: '[t]', ids: {} },
      podeContinuar: () => undefined as unknown as boolean,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BuscaForaDoPrazoShopeeError);
    expect(getItemList).not.toHaveBeenCalled();
  });

  it('the same-SKU scan asks before EACH base-info chunk too: false between two chunks ⇒ throws, NO decision on chunk 1 (a hit there included), NO link read', async () => {
    // 51 candidates ⇒ two chunks (50 + 1); the same-SKU listing is in chunk 1.
    const ids = Array.from({ length: 51 }, (_v, i) => ITEM_1 + i);
    const { client, getItemBaseInfo } = cliente({
      paginas: () =>
        paginaSintetica(
          ids.map((id) => linhaDaLista(id, false)),
          { has: false },
        ),
      bases: ids.map((id, i) => baseComum(id, i === 0 ? SKU_ITEM : 'OUTRO-SKU')),
    });
    const db = new FakeDb();

    // page + chunk 1 pass; chunk 2 is refused.
    const err = await localizarItensPorSku(client, asDb(db), {
      integracaoId: INTEGRACAO,
      sku: SKU_ITEM,
      excluirItemIds: new Set<number>(),
      kit: false,
      podeContinuar: ate(2).podeContinuar,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BuscaForaDoPrazoShopeeError);
    expect((err as BuscaForaDoPrazoShopeeError).antesDe).toBe('get_item_base_info');
    expect(getItemBaseInfo).toHaveBeenCalledTimes(1);
    expect(db.consultas).toEqual([]);
  });

  it('⛔ NEAR-MISS: the deadline fits all three calls ⇒ the scan decides as before (the hit, its link read)', async () => {
    const ids = Array.from({ length: 51 }, (_v, i) => ITEM_1 + i);
    const { client, getItemBaseInfo } = cliente({
      paginas: () =>
        paginaSintetica(
          ids.map((id) => linhaDaLista(id, false)),
          { has: false },
        ),
      bases: ids.map((id, i) => baseComum(id, i === 0 ? SKU_ITEM : 'OUTRO-SKU')),
    });

    const r = await localizarItensPorSku(client, asDb(new FakeDb()), {
      integracaoId: INTEGRACAO,
      sku: SKU_ITEM,
      excluirItemIds: new Set<number>(),
      kit: false,
      podeContinuar: ate(3).podeContinuar,
    });

    expect(getItemBaseInfo).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ completo: true, achados: [{ itemId: ITEM_1, vinculo: null }] });
  });

  it('`clienteDaBuscaNoPrazo` without a predicate is the client ITSELF (no wrapper, no behaviour change)', () => {
    const { client } = cliente({ paginas: paginas(1) });
    expect(clienteDaBuscaNoPrazo(client, undefined)).toBe(client);
    expect(clienteDaBuscaNoPrazo(client, () => true)).not.toBe(client);
  });

  it('the KIT arm takes NO predicate: its walk is unchanged (a 100-page shop walks to the end)', async () => {
    const { client, getItemList } = cliente({ paginas: paginas(MAX_PAGINAS_BUSCA_KIT) });

    const r = await buscar(client);

    expect(r.completo).toBe(true);
    expect(getItemList).toHaveBeenCalledTimes(MAX_PAGINAS_BUSCA_KIT);
    await localizarKitsPorSku(client, asDb(new FakeDb()), {
      integracaoId: INTEGRACAO,
      sku: SKU,
      excluirItemIds: new Set<number>(),
      // @ts-expect-error — the kit arm has no deadline checkpoint (#1911 batch-A review).
      podeContinuar: () => false,
    });
  });

  it('BuscaForaDoPrazoShopeeError is an APP class, never a Shopee error', () => {
    const err = new BuscaForaDoPrazoShopeeError('get_item_list');
    expect(err).not.toBeInstanceOf(ShopeeApiError);
    expect(err.name).toBe('BuscaForaDoPrazoShopeeError');
    expect(err.message).toContain('Nada foi decidido nem enviado');
  });
});
