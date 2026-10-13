import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ShopeeAddKitItemRequest } from '@delfrance/integrations-shopee';
import { produtoShopeeLinkSchema, variacaoShopeeLinkSchema } from '@delfrance/schemas';

import {
  FIXTURE_ITEM_BASE_INFO_SG_KIT,
  FIXTURE_KIT_ITEM_INFO_SG_POS_CRIACAO,
  lerBaseDosItens,
  lerKitDoCorpus,
} from '../fixtures/wireCorpus';
import { montarItemLido } from '../produtos/itemLido';
import { FakeDb, asDb, grpc } from '../testing/fakeDb';
import { idDaVariacaoDeKit, idDoVinculoDeKit } from './idsKit';
import {
  escreverLeituraDoKit,
  escreverVariacoesDoKit,
  escreverVinculoDoKit,
  type DepsDeVinculoKit,
} from './vinculosKit';

/* Fixture ids by ROLE only (s19-ctx): kit 2500139870/2000458820, second kit 2500139873. */
const K = 'kit-k';
const FILHO = 'filho-a';
const KIT = 2500139870;
const KIT_2 = 2500139873;
const MODELO = 2000458820;
const AGORA = 1_791_331_200_000;
const CONTA_REF = 'documents/integracao/int-1';

function deps(db: FakeDb): DepsDeVinculoKit {
  return { db: asDb(db), integracaoId: 'int-1', nowMs: AGORA };
}

const CORPO: ShopeeAddKitItemRequest = {
  sync_setting: { auto_sync_dts: true },
  item_setting: {
    item_name: 'Kit de teste',
    images: { image_id_list: ['br-11134207-7r98o-lzri4neb5vcv18'] },
    description_type: 'normal',
    description: 'Descrição do kit de teste',
    logistic_info: [{ logistic_id: 90003, enabled: true }],
    weight: 1.5,
    item_sku: 'KIT-1',
    tier_variation_list: [{ name: 'Kit', option_list: [{ option: 'Padrão' }] }],
    model_list: [
      {
        tier_index: [0],
        original_price: 49.9,
        component_list: [{ component_item_id: 2500139871, quantity: 2, main_component: true }],
      },
    ],
  },
};

function lido() {
  return montarItemLido({
    itemId: KIT,
    payload: lerBaseDosItens(FIXTURE_ITEM_BASE_INFO_SG_KIT),
    linha: null,
    kit: lerKitDoCorpus(FIXTURE_KIT_ITEM_INFO_SG_POS_CRIACAO).product_info,
  });
}

describe('escreverVinculoDoKit — the ONE link write after add_kit_item (R-k tier 0)', () => {
  it('(M99) lands at idDoVinculoDeKit(integracaoId, itemId); two creates with two item ids ⇒ two docs', async () => {
    const db = new FakeDb();
    const um = await escreverVinculoDoKit(deps(db), { produtoId: K, itemId: KIT, corpo: CORPO });
    const dois = await escreverVinculoDoKit(deps(db), {
      produtoId: K,
      itemId: KIT_2,
      corpo: CORPO,
    });
    expect(um).toBe(idDoVinculoDeKit('int-1', KIT));
    expect(dois).toBe(idDoVinculoDeKit('int-1', KIT_2));
    expect(um).not.toBe(dois);
    expect(db.idsEm(`produtos/${K}/prodshopee`).sort()).toEqual([um, dois].sort());
  });

  it('(M76, R-1) writes the LITERAL kitNativo: true, the conta ref, item_id and step 11 #1 fields minus item-only keys', async () => {
    const db = new FakeDb();
    const id = await escreverVinculoDoKit(deps(db), { produtoId: K, itemId: KIT, corpo: CORPO });
    const doc = db.store[`produtos/${K}/prodshopee/${id}`]?.data;
    expect(doc).toMatchObject({
      contaProdutoShopeeOuterRef: CONTA_REF,
      item_id: KIT,
      kitNativo: true,
      item_name: 'Kit de teste',
      description: 'Descrição do kit de teste',
      logistic_info: [{ logistic_id: 90003, enabled: true }],
      ultimaPublicacao: { em: AGORA, etapa: 'add_kit_item', itemId: KIT },
      ultimaModificacao: AGORA,
      publicadoEm: AGORA,
      dataCadastro: AGORA,
    });
    // Item-only keys never ride a kit link write.
    for (const chave of ['category_id', 'condition', 'attributes', 'brand_id', 'taxInfoOmitido']) {
      expect(doc, chave).not.toHaveProperty(chave);
    }
    expect(produtoShopeeLinkSchema.safeParse(doc).success).toBe(true);
  });

  it('is a MERGE: an import that wrote the same doc first keeps its status keys (R-u race)', async () => {
    const db = new FakeDb();
    const id = idDoVinculoDeKit('int-1', KIT);
    db.seed(`produtos/${K}/prodshopee/${id}`, {
      contaProdutoShopeeOuterRef: CONTA_REF,
      item_id: KIT,
      item_name: 'Importado',
      item_status: 'NORMAL',
      estadoAnuncio: 'ativo',
    });
    await escreverVinculoDoKit(deps(db), { produtoId: K, itemId: KIT, corpo: CORPO });
    expect(db.store[`produtos/${K}/prodshopee/${id}`]?.data).toMatchObject({
      item_status: 'NORMAL',
      estadoAnuncio: 'ativo',
      kitNativo: true,
    });
  });
});

describe('escreverLeituraDoKit — #2, a plain merge of what Shopee REPORTED', () => {
  it('a full read writes the seam fields, kitNativo = ehKitDe(read) (overwriting the literal)', async () => {
    const db = new FakeDb();
    const id = idDoVinculoDeKit('int-1', KIT);
    db.seed(`produtos/${K}/prodshopee/${id}`, {
      contaProdutoShopeeOuterRef: CONTA_REF,
      item_id: KIT,
      item_name: 'Kit de teste',
      kitNativo: true,
      falhaPublicacao: { em: 1, etapa: 'add_kit_item', erro: 'x', mensagem: 'y', problemas: [] },
    });
    const escrita = await escreverLeituraDoKit(deps(db), {
      produtoId: K,
      linkDocId: id,
      leitura: { kind: 'item', item: lido() },
    });
    expect(escrita).toEqual({ estadoAnuncio: 'ativo', itemStatus: 'NORMAL', kitNativo: true });
    const ultima = db.writes.at(-1);
    expect(Object.keys(ultima?.patch ?? {}).sort()).toEqual(
      [
        'deboost',
        'estadoAnuncio',
        'falhaPublicacao',
        'item_name',
        'item_status',
        'kitNativo',
        'ultimaModificacao',
      ].sort(),
    );
    expect(ultima?.patch).toMatchObject({
      item_status: 'NORMAL',
      estadoAnuncio: 'ativo',
      // The sandbox sends the STRING "FALSE"; the shared fold reads it as false.
      deboost: false,
      kitNativo: true,
      falhaPublicacao: null,
    });
  });

  it('near-miss: a read whose tag says NOT a kit writes kitNativo false — never the literal', async () => {
    const db = new FakeDb();
    const payload = lerBaseDosItens(FIXTURE_ITEM_BASE_INFO_SG_KIT);
    const semKit = {
      ...payload,
      item_list: payload.item_list.map((r) => (r === null ? r : { ...r, tag: { kit: false } })),
    };
    const item = montarItemLido({ itemId: KIT, payload: semKit, linha: null });
    const escrita = await escreverLeituraDoKit(deps(db), {
      produtoId: K,
      linkDocId: 'l1',
      leitura: { kind: 'item', item },
    });
    expect(escrita.kitNativo).toBe(false);
    expect(db.writes.at(-1)?.patch.kitNativo).toBe(false);
  });

  it('a blank read item_name never overwrites the stored name (the field is required non-empty)', async () => {
    const db = new FakeDb();
    const payload = lerBaseDosItens(FIXTURE_ITEM_BASE_INFO_SG_KIT);
    const semNome = {
      ...payload,
      item_list: payload.item_list.map((r) => (r === null ? r : { ...r, item_name: '  ' })),
    };
    const item = montarItemLido({ itemId: KIT, payload: semNome, linha: null });
    await escreverLeituraDoKit(deps(db), {
      produtoId: K,
      linkDocId: 'l1',
      leitura: { kind: 'item', item },
    });
    expect(db.writes.at(-1)?.patch).not.toHaveProperty('item_name');
  });

  it('(S2C-02/S2C-07) a status-only read folds to estadoAnuncio and writes NOTHING else', async () => {
    const db = new FakeDb();
    const apagado = await escreverLeituraDoKit(deps(db), {
      produtoId: K,
      linkDocId: 'l1',
      leitura: { kind: 'status', itemStatus: 'SELLER_DELETE' },
    });
    expect(apagado).toEqual({
      estadoAnuncio: 'removido',
      itemStatus: 'SELLER_DELETE',
      kitNativo: null,
    });
    expect(db.writes.at(-1)?.patch).toEqual({
      estadoAnuncio: 'removido',
      ultimaModificacao: AGORA,
    });

    const ausente = await escreverLeituraDoKit(deps(db), {
      produtoId: K,
      linkDocId: 'l2',
      leitura: { kind: 'status', itemStatus: null },
    });
    expect(ausente.estadoAnuncio).toBe('removido');
    expect(db.writes.at(-1)?.patch).toEqual({
      estadoAnuncio: 'removido',
      ultimaModificacao: AGORA,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*        R1-RT7-05 — #2 never moves a link OUT of removido (rule 7 tier 1)    */
/* -------------------------------------------------------------------------- */

describe('escreverLeituraDoKit — never out of removido (R1-RT7-05)', () => {
  const ID = idDoVinculoDeKit('int-1', KIT);
  const CAMINHO = `produtos/${K}/prodshopee/${ID}`;
  const VIVO = {
    contaProdutoShopeeOuterRef: CONTA_REF,
    item_id: KIT,
    item_name: 'Kit de teste',
    kitNativo: true,
    item_status: 'NORMAL',
    estadoAnuncio: 'ativo',
  };
  const APAGADO = { ...VIVO, item_status: 'SELLER_DELETE', estadoAnuncio: 'removido' };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The FakeDb, with ONE concurrent write landing right after #2's FIRST read of
   * `alvo` — the recriar's `removido` arriving between a republish's read and its
   * write. Every other call reaches the double untouched.
   */
  function comEscritaConcorrente(db: FakeDb, alvo: string, escrever: () => void) {
    let feito = false;
    const colecao = db.collection.bind(db);
    return new Proxy(db, {
      get(t, prop, r) {
        if (prop !== 'collection') return Reflect.get(t, prop, r) as unknown;
        return (colPath: string) => {
          const col = colecao(colPath);
          return new Proxy(col, {
            get(ct, cp, cr) {
              const original = Reflect.get(ct, cp, cr) as unknown;
              if (cp !== 'doc') return original;
              // The double's own ref builder, wrapped — never a raw Firestore ref.
              const construirRef = original as typeof ct.doc;
              return (id?: string) => {
                const ref = construirRef(id);
                if (ref.path !== alvo) return ref;
                return {
                  ...ref,
                  get: async () => {
                    const snap = await ref.get();
                    if (!feito) {
                      feito = true;
                      escrever();
                    }
                    return snap;
                  },
                };
              };
            },
          });
        };
      },
    });
  }

  it('a stored removido + a full read NORMAL ⇒ NOTHING written, the stored removido reported; near-miss: a LIVE link takes the same read', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, APAGADO);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const antes = db.writes.length;

    const escrita = await escreverLeituraDoKit(deps(db), {
      produtoId: K,
      linkDocId: ID,
      leitura: { kind: 'item', item: lido() },
    });

    expect(db.writes.length).toBe(antes);
    expect(db.store[CAMINHO]?.data).toEqual(APAGADO);
    expect(escrita).toEqual({ estadoAnuncio: 'removido', itemStatus: 'NORMAL', kitNativo: true });

    // ⛔ near-miss: the SAME read over a live link writes, as before.
    const vivo = new FakeDb();
    vivo.seed(CAMINHO, { ...VIVO, estadoAnuncio: 'pausado', item_status: 'UNLIST' });
    const r = await escreverLeituraDoKit(deps(vivo), {
      produtoId: K,
      linkDocId: ID,
      leitura: { kind: 'item', item: lido() },
    });
    expect(r.estadoAnuncio).toBe('ativo');
    expect(vivo.store[CAMINHO]?.data).toMatchObject({
      estadoAnuncio: 'ativo',
      item_status: 'NORMAL',
    });
  });

  it('a removido landing BETWEEN the read and the write fails the precondition; the re-read decides, and the link stays removido', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, VIVO);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The republish read the kit NORMAL before the recriar's delete; the
    // recriar's `removido` lands right after the republish's #2 read the link.
    const corrida = comEscritaConcorrente(db, CAMINHO, () => db.seed(CAMINHO, APAGADO));

    const escrita = await escreverLeituraDoKit(
      { db: corrida as unknown as DepsDeVinculoKit['db'], nowMs: AGORA },
      { produtoId: K, linkDocId: ID, leitura: { kind: 'item', item: lido() } },
    );

    expect(escrita.estadoAnuncio).toBe('removido');
    expect(db.store[CAMINHO]?.data).toEqual(APAGADO);
    // Two reads of the link: the one that lost, the one that decided.
    expect(db.opLog.filter((o) => o.op === 'get' && o.path === CAMINHO)).toHaveLength(2);
  });

  it('a status-only read cannot revive a removido link either', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, APAGADO);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await escreverLeituraDoKit(deps(db), {
      produtoId: K,
      linkDocId: ID,
      leitura: { kind: 'status', itemStatus: 'NORMAL' },
    });
    expect(r.estadoAnuncio).toBe('removido');
    expect(db.store[CAMINHO]?.data).toEqual(APAGADO);
  });

  it('bounded: a precondition lost on every attempt surfaces after 3 reads; any other failure propagates at once (rule 6)', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, VIVO);
    db.falhasDeUpdate.set(CAMINHO, grpc(9, 'FAILED_PRECONDITION'));
    await expect(
      escreverLeituraDoKit(deps(db), {
        produtoId: K,
        linkDocId: ID,
        leitura: { kind: 'item', item: lido() },
      }),
    ).rejects.toMatchObject({ code: 9 });
    expect(db.opLog.filter((o) => o.op === 'get' && o.path === CAMINHO)).toHaveLength(3);

    const outro = new FakeDb();
    outro.seed(CAMINHO, VIVO);
    outro.falhasDeUpdate.set(CAMINHO, grpc(14, 'UNAVAILABLE'));
    await expect(
      escreverLeituraDoKit(deps(outro), {
        produtoId: K,
        linkDocId: ID,
        leitura: { kind: 'item', item: lido() },
      }),
    ).rejects.toMatchObject({ code: 14 });
    expect(outro.opLog.filter((o) => o.op === 'get' && o.path === CAMINHO)).toHaveLength(1);
  });
});

describe('escreverVariacoesDoKit — one row per (link, model), under the CHILD', () => {
  const LINK = idDoVinculoDeKit('int-1', KIT);
  const CAMINHO = `produtos/${FILHO}/variashopee/${idDaVariacaoDeKit(LINK, MODELO)}`;

  it('(M83) a NEW row is create()d under the child at idDaVariacaoDeKit, through linhaVariacaoDeKit', async () => {
    const db = new FakeDb();
    const r = await escreverVariacoesDoKit(deps(db), {
      linkProdutoId: K,
      linkDocId: LINK,
      linhasDaConta: [],
      linhas: [
        {
          filhoId: FILHO,
          modelId: MODELO,
          tierIndex: [0],
          modelStatus: 'MODEL_NORMAL',
          receitaKitConferida: '[["comp-a",2]]',
        },
      ],
    });
    expect(r).toEqual({ criadas: 1, recarimbadas: 0, mantidas: 0 });
    const doc = db.store[CAMINHO]?.data;
    expect(doc).toMatchObject({
      contaVariacaoShopeeOuterRef: CONTA_REF,
      produtoShopeeOuterRef: `documents/produtos/${K}/prodshopee/${LINK}`,
      model_id: MODELO,
      tier_index: [0],
      model_status: 'MODEL_NORMAL',
      receitaKitConferida: '[["comp-a",2]]',
    });
    expect(variacaoShopeeLinkSchema.safeParse(doc).success).toBe(true);
    expect(db.idsEm(`produtos/${K}/variashopee`)).toEqual([]);
  });

  it('(W1a) an unknown model_status token folds to null instead of failing the write', async () => {
    const db = new FakeDb();
    await escreverVariacoesDoKit(deps(db), {
      linkProdutoId: K,
      linkDocId: LINK,
      linhasDaConta: [],
      linhas: [
        {
          filhoId: FILHO,
          modelId: MODELO,
          tierIndex: [0],
          modelStatus: 'MODEL_INVENTADO',
          receitaKitConferida: null,
        },
      ],
    });
    expect(db.store[CAMINHO]?.data.model_status).toBeNull();
  });

  it('an EXISTING row of THIS link is re-stamped flat — only receitaKitConferida, never a set', async () => {
    const db = new FakeDb();
    db.seed(`produtos/${FILHO}/variashopee/legado`, {
      contaVariacaoShopeeOuterRef: CONTA_REF,
      produtoShopeeOuterRef: `produtos/${K}/prodshopee/${LINK}`,
      model_id: MODELO,
      precoEnviado: 39.9,
      modeloAusenteEm: null,
      receitaKitConferida: 'velho',
    });
    const r = await escreverVariacoesDoKit(deps(db), {
      linkProdutoId: K,
      linkDocId: LINK,
      linhasDaConta: [
        {
          produtoId: FILHO,
          docId: 'legado',
          linkDocId: LINK,
          raw: { model_id: MODELO },
        },
      ],
      linhas: [
        {
          filhoId: FILHO,
          modelId: MODELO,
          tierIndex: [0],
          modelStatus: 'MODEL_NORMAL',
          receitaKitConferida: 'novo',
        },
      ],
    });
    expect(r).toEqual({ criadas: 0, recarimbadas: 1, mantidas: 0 });
    expect(db.patches).toEqual([
      { path: `produtos/${FILHO}/variashopee/legado`, patch: { receitaKitConferida: 'novo' } },
    ]);
    expect(db.store[`produtos/${FILHO}/variashopee/legado`]?.data.precoEnviado).toBe(39.9);
    // No second row at the derived id.
    expect(db.store[CAMINHO]).toBeUndefined();
  });

  it('near-miss: an existing row with a DISTINCT read-back (null stamp) is left untouched — the old stamp stays', async () => {
    const db = new FakeDb();
    const caminho = `produtos/${FILHO}/variashopee/legado`;
    db.seed(caminho, {
      contaVariacaoShopeeOuterRef: CONTA_REF,
      produtoShopeeOuterRef: `produtos/${K}/prodshopee/${LINK}`,
      model_id: MODELO,
      receitaKitConferida: 'velho',
    });
    const r = await escreverVariacoesDoKit(deps(db), {
      linkProdutoId: K,
      linkDocId: LINK,
      linhasDaConta: [
        { produtoId: FILHO, docId: 'legado', linkDocId: LINK, raw: { model_id: MODELO } },
      ],
      linhas: [
        {
          filhoId: FILHO,
          modelId: MODELO,
          tierIndex: [0],
          modelStatus: null,
          receitaKitConferida: null,
        },
      ],
    });
    expect(r).toEqual({ criadas: 0, recarimbadas: 0, mantidas: 1 });
    expect(db.writes).toEqual([]);
    expect(db.store[caminho]?.data.receitaKitConferida).toBe('velho');
  });

  it('(V2R1-03) another listing’s row with the same model_id is NOT this link’s row — a new one is created', async () => {
    const db = new FakeDb();
    const r = await escreverVariacoesDoKit(deps(db), {
      linkProdutoId: K,
      linkDocId: LINK,
      linhasDaConta: [
        { produtoId: FILHO, docId: 'outro', linkDocId: 'link-velho', raw: { model_id: MODELO } },
      ],
      linhas: [
        {
          filhoId: FILHO,
          modelId: MODELO,
          tierIndex: [0],
          modelStatus: null,
          receitaKitConferida: 'x',
        },
      ],
    });
    expect(r.criadas).toBe(1);
    expect(db.store[CAMINHO]).toBeDefined();
  });

  it('(R-u) ALREADY_EXISTS — step 9 wrote the row first at the same id — falls back to the flat re-stamp', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, {
      contaVariacaoShopeeOuterRef: CONTA_REF,
      produtoShopeeOuterRef: `documents/produtos/${K}/prodshopee/${LINK}`,
      model_id: MODELO,
      precoEnviado: 10,
      receitaKitConferida: null,
    });
    const r = await escreverVariacoesDoKit(deps(db), {
      linkProdutoId: K,
      linkDocId: LINK,
      linhasDaConta: [],
      linhas: [
        {
          filhoId: FILHO,
          modelId: MODELO,
          tierIndex: [0],
          modelStatus: null,
          receitaKitConferida: 'carimbo',
        },
      ],
    });
    expect(r).toEqual({ criadas: 0, recarimbadas: 1, mantidas: 0 });
    expect(db.store[CAMINHO]?.data).toMatchObject({
      precoEnviado: 10,
      receitaKitConferida: 'carimbo',
    });
  });

  it('rule 6: a create failure that is not ALREADY_EXISTS propagates', async () => {
    const db = new FakeDb();
    db.falhasDeCriacao.set(CAMINHO, grpc(7, 'PERMISSION_DENIED'));
    await expect(
      escreverVariacoesDoKit(deps(db), {
        linkProdutoId: K,
        linkDocId: LINK,
        linhasDaConta: [],
        linhas: [
          {
            filhoId: FILHO,
            modelId: MODELO,
            tierIndex: [0],
            modelStatus: null,
            receitaKitConferida: null,
          },
        ],
      }),
    ).rejects.toThrow('PERMISSION_DENIED');
  });

  it('a row deleted between the read and the re-stamp is NOT resurrected (mergeIfExists)', async () => {
    const db = new FakeDb();
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await escreverVariacoesDoKit(deps(db), {
      linkProdutoId: K,
      linkDocId: LINK,
      linhasDaConta: [
        { produtoId: FILHO, docId: 'sumiu', linkDocId: LINK, raw: { model_id: MODELO } },
      ],
      linhas: [
        {
          filhoId: FILHO,
          modelId: MODELO,
          tierIndex: [0],
          modelStatus: null,
          receitaKitConferida: 'x',
        },
      ],
    });
    expect(r).toEqual({ criadas: 0, recarimbadas: 0, mantidas: 1 });
    expect(db.store[`produtos/${FILHO}/variashopee/sumiu`]).toBeUndefined();
    expect(aviso).toHaveBeenCalledTimes(1);
    aviso.mockRestore();
  });
});
