import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { MercadoLivreHttpError, type MercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { type PublishDeps, publishProduto } from './publish';

/**
 * Regression tests for the DUAL-RUN contract of the publish orchestrator: the
 * still-running Flutter app equality-queries the docs this module writes, so
 * every `*OuterRef` must be stored `documents/`-prefixed (`pathWithDocuments`)
 * and a re-publish must preserve every Flutter-authored field it doesn't own
 * (the old app persisted via `copyWith(...).save()`). Backed by an in-memory
 * fake of the few Admin-SDK surfaces the handles touch.
 */

type DocData = Record<string, unknown>;

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly updates: Array<{ path: string; patch: DocData }> = [];
  private autoN = 0;
  /** Monotonic per-doc version standing in for Firestore's `updateTime`. */
  private readonly versions = new Map<string, number>();
  /**
   * Fires once, right after the next `get()` on this doc path, so a test can
   * simulate a concurrent writer landing inside a read-modify-write window.
   */
  afterGet: { path: string; fn: () => void } | null = null;

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) {
      c = new Map();
      this.cols.set(path, c);
    }
    return c;
  }

  versionOf(key: string): number {
    return this.versions.get(key) ?? 1;
  }

  bump(key: string): void {
    this.versions.set(key, this.versionOf(key) + 1);
  }

  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
    this.bump(`${path}/${id}`);
  }

  docs(path: string): Map<string, DocData> {
    return this.col(path);
  }

  collection(path: string) {
    const col = this.col(path);
    const self = this;
    return {
      doc: (id?: string) => {
        const docId = id ?? `auto-${++self.autoN}`;
        const key = `${path}/${docId}`;
        return {
          id: docId,
          get: async () => {
            const snap = {
              exists: col.has(docId),
              id: docId,
              data: () => col.get(docId),
              updateTime: self.versionOf(key),
            };
            if (self.afterGet?.path === key) {
              const { fn } = self.afterGet;
              self.afterGet = null;
              fn();
            }
            return snap;
          },
          set: async (data: DocData, opts?: { merge?: boolean }) => {
            col.set(docId, opts?.merge ? { ...(col.get(docId) ?? {}), ...data } : { ...data });
            self.bump(key);
          },
          update: async (patch: DocData, precondition?: { lastUpdateTime?: unknown }) => {
            // Recorded only once the write COMMITS — a rejected update never
            // reaches Firestore, so a test asserting on `updates` must not see
            // one (the CAS retry below issues two attempts, one of which loses).
            const current = col.get(docId);
            if (!current) {
              // Real Firestore rejects update() on a missing doc with gRPC 5;
              // `mergeIfExists` narrows exactly that to `false`.
              const err = new Error(`NOT_FOUND: ${key}`) as Error & { code: number };
              err.code = 5;
              throw err;
            }
            if (
              precondition?.lastUpdateTime != null &&
              precondition.lastUpdateTime !== self.versionOf(key)
            ) {
              // gRPC FAILED_PRECONDITION — the doc moved under the read the
              // patch was derived from (rule 7, tier 1).
              const err = new Error(`FAILED_PRECONDITION: ${key}`) as Error & { code: number };
              err.code = 9;
              throw err;
            }
            col.set(docId, { ...current, ...patch });
            self.bump(key);
            self.updates.push({ path: key, patch });
          },
        };
      },
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => ({
          docs: [...col.entries()]
            .filter(([, d]) => d[field] === value)
            .map(([docId, d]) => ({ id: docId, data: () => d, exists: true })),
        }),
      }),
      get: async () => ({
        docs: [...col.entries()].map(([docId, d]) => ({ id: docId, data: () => d, exists: true })),
        empty: col.size === 0,
      }),
    };
  }
}

const CONTA = 'conta-1';
const PROD = 'prod-1';
const LINKS_PATH = `produtos/${PROD}/produtoMercadoLivre`;

const ITEM_RESPONSE = {
  id: 'MLB777',
  status: 'active',
  permalink: 'https://ml/MLB777',
  price: 79.9,
  category_id: 'MLB31447',
  listing_type_id: 'gold_special',
  shipping: { free_shipping: false },
  variations: null,
};

function makeApi(overrides: Partial<Record<keyof MercadoLivreApi, unknown>> = {}): {
  api: MercadoLivreApi;
  mocks: Record<string, ReturnType<typeof vi.fn>>;
} {
  const mocks = {
    createItem: vi.fn(async () => ITEM_RESPONSE),
    updateItem: vi.fn(async () => ITEM_RESPONSE),
    suggestCategories: vi.fn(async () => [{ category_id: 'MLB31447' }]),
    getCategory: vi.fn(async () => ({ id: 'MLB31447', settings: null })),
    uploadPicture: vi.fn(async () => ({ id: 'PIC-NEW' })),
    setItemDescription: vi.fn(async () => ({ plain_text: 'ok' })),
    ...overrides,
  } as Record<string, ReturnType<typeof vi.fn>>;
  return { api: mocks as unknown as MercadoLivreApi, mocks };
}

function seedBase(db: FakeDb, opts: { externalIds?: DocData[] | null } = {}): void {
  db.seed('produtos', PROD, {
    nome: 'Camiseta Básica',
    sku: 'SKU-1',
    paiId: null,
    publicado: true,
    precos: { 'lista-1': { valor: 79.9 } },
    fotos: [{ arquivoOuterRef: 'arquivos/arq-1' }],
  });
  db.seed(`produtos/${PROD}/estoques`, 'est-1', {
    depositoOuterRef: 'documents/depositos/dep-1',
    quantidade: 10,
    quantidadeReservada: 2,
  });
  db.seed('arquivos', 'arq-1', {
    filename: 'foto.jpg',
    contentType: 'image/jpeg',
    url: 'https://storage/foto.jpg',
    externalIds: opts.externalIds ?? null,
  });
  // The rascunho the listing editor saves before a first publish. Since #799
  // publish no longer picks the ML category itself (a wrong domain_discovery
  // hit was only discoverable once the listing existed), an unpublished
  // listing must already carry `category_id` on its link doc. `id: null` is
  // what still makes this a create. Tests that need the Flutter-authored shape
  // overwrite this same doc id.
  db.seed(LINKS_PATH, 'ML-DOC-1', {
    contaOuterRef: `documents/integracao/${CONTA}`,
    channels: ['marketplace'],
    estado: 'r',
    id: null,
    site_id: 'MLB',
    title: 'Camiseta Básica',
    category_id: 'MLB31447',
    condition: 'new',
    listing_type_id: 'gold_special',
    isUserProductModel: false,
  });
}

function makeDeps(db: FakeDb, api: MercadoLivreApi): PublishDeps {
  return {
    db: db as unknown as Firestore,
    api,
    integracaoId: CONTA,
    tabelaNormalOuterRef: 'documents/listaDePrecos/lista-1',
    depositoOuterRef: null,
    listingTypeId: 'gold_special',
    fetchImpl: vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(4),
    })) as unknown as typeof globalThis.fetch,
  };
}

/** The Flutter-authored link doc a re-publish must not corrupt. */
const FLUTTER_LINK: DocData = {
  contaOuterRef: `documents/integracao/${CONTA}`,
  channels: ['marketplace', 'mshops'],
  estado: 'pa',
  id: 'MLB777',
  sku: null,
  descricao: 'Descrição custom do vendedor',
  site_id: 'MLB',
  title: 'Título antigo',
  category_id: 'MLB31447',
  condition: 'new',
  listing_type_id: 'gold_pro',
  crossdocking: 3,
  freteGratis: false,
  precoPublicado: 50,
  tarifaFrete: 1.5,
  comissao: 0.11,
  isUserProductModel: false,
  video_id: 'VID-9',
  attributes: null,
  errors: null,
  ultimaModificacao: 1000,
  dataCadastro: 1000,
  campoLegadoDesconhecido: 'preservar',
};

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('publishProduto — dual-run wire shape', () => {
  it('first publish writes canonical documents/-prefixed refs everywhere', async () => {
    const db = new FakeDb();
    seedBase(db);
    const { api, mocks } = makeApi({
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        variations: [{ id: 555, seller_custom_field: 'child-1' }],
      })),
    });
    db.seed('produtos', 'child-1', {
      nome: 'Camiseta M',
      sku: 'SKU-1-M',
      paiId: PROD,
      ordem: 0,
      precos: { 'lista-1': { valor: 79.9 } },
      variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
    });
    db.seed('produtos/child-1/estoques', 'est-c', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 4,
      quantidadeReservada: 0,
    });
    db.seed('grupoDeVariacoes', 'g-tam', {
      nome: 'Tamanho',
      tipo: 1,
      variacoes: [{ id: 'v-m', nome: 'M' }],
    });

    const result = await publishProduto(makeDeps(db, api), PROD);
    expect(result.itemId).toBe('MLB777');

    const [linkDocId, link] = [...db.docs(LINKS_PATH).entries()][0]!;
    expect(link.contaOuterRef).toBe(`documents/integracao/${CONTA}`);
    expect(link.estado).toBe('p');
    expect(link.id).toBe('MLB777');
    expect(link.errors).toEqual([]);

    const varDocs = [...db.docs('produtos/child-1/variacaoMercadoLivre').values()];
    expect(varDocs).toHaveLength(1);
    expect(varDocs[0]).toMatchObject({
      id: 555,
      produtoVariacaoOuterRef: 'documents/produtos/child-1',
      produtoMercadoLivreOuterRef: `documents/produtos/${PROD}/produtoMercadoLivre/${linkDocId}`,
      sku: 'SKU-1-M',
    });

    // Picture cache appended race-safely (arrayUnion), prefixed path.
    expect(mocks.uploadPicture).toHaveBeenCalledOnce();
    const update = db.updates.find((u) => u.path === 'arquivos/arq-1');
    expect(update).toBeDefined();
    const sentinel = update!.patch.externalIds as FieldValue;
    expect(
      sentinel.isEqual(
        FieldValue.arrayUnion({
          externalId: 'PIC-NEW',
          integracaoPath: `documents/integracao/${CONTA}`,
        }),
      ),
    ).toBe(true);
  });

  it('re-publish preserves every Flutter-authored field (old copyWith semantics)', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.updateItem).toHaveBeenCalledOnce();
    expect(mocks.uploadPicture).not.toHaveBeenCalled(); // cache hit
    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    // Fields the publish owns are refreshed…
    expect(link).toMatchObject({ estado: 'p', id: 'MLB777', precoPublicado: 79.9, errors: [] });
    // …everything Flutter authored survives untouched.
    expect(link).toMatchObject({
      descricao: 'Descrição custom do vendedor',
      channels: ['marketplace', 'mshops'],
      video_id: 'VID-9',
      crossdocking: 3,
      tarifaFrete: 1.5,
      comissao: 0.11,
      dataCadastro: 1000,
      campoLegadoDesconhecido: 'preservar',
      contaOuterRef: `documents/integracao/${CONTA}`,
    });
    // The link doc's own description wins and rides the replace variant.
    expect(mocks.setItemDescription).toHaveBeenCalledWith(
      'MLB777',
      'Descrição custom do vendedor',
      { replace: true },
    );
  });

  it('sends and preserves an operator-edited title instead of produto.nome (#799)', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    // The payload carries the LISTING's title, not the ERP produto name…
    expect(mocks.updateItem!.mock.calls[0]![1]).toMatchObject({ title: 'Título antigo' });
    // …and the publish no longer clobbers it on the way back.
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')!.title).toBe('Título antigo');
  });

  it('sends produto.nome when the link title is blank, without rewriting the doc', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK, title: '   ' });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    // Blank means absent for the PAYLOAD…
    expect(mocks.updateItem!.mock.calls[0]![1]).toMatchObject({ title: 'Camiseta Básica' });
    // …but `title` is operator-owned, so publish leaves the stored value alone
    // rather than deciding on the operator's behalf what it should have been.
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')!.title).toBe('   ');
  });

  it('does not clobber a concurrent edit made during the ML round trip (rule 7)', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    const { api } = makeApi({
      updateItem: vi.fn(async () => {
        // The still-running Flutter app edits the listing while we are talking
        // to ML — the window the old read-modify-write silently lost.
        const cur = db.docs(LINKS_PATH).get('ML-DOC-1')!;
        db.seed(LINKS_PATH, 'ML-DOC-1', { ...cur, descricao: 'Editado durante a publicação' });
        return ITEM_RESPONSE;
      }),
    });

    await publishProduto(makeDeps(db, api), PROD);

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    // Publish used to re-apply the snapshot it read at the top of the function,
    // reverting this to 'Descrição custom do vendedor'.
    expect(link.descricao).toBe('Editado durante a publicação');
    // Publish-owned fields still land.
    expect(link).toMatchObject({ estado: 'p', id: 'MLB777', errors: [] });
  });

  it('recreates a COMPLETE link doc when it was deleted mid-publish, never a ghost', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    const { api } = makeApi({
      updateItem: vi.fn(async () => {
        db.docs(LINKS_PATH).delete('ML-DOC-1');
        return ITEM_RESPONSE;
      }),
    });

    await publishProduto(makeDeps(db, api), PROD);

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    // A live ML listing with no link doc is invisible to every sweep, so the
    // write falls through rather than being dropped…
    expect(link).toMatchObject({ id: 'MLB777', estado: 'p' });
    // …and it is schema-complete, not the key-only ghost merge() would upsert.
    expect(link.contaOuterRef).toBe(`documents/integracao/${CONTA}`);
    expect(link.title).toBe('Título antigo');
    expect(link.site_id).toBe('MLB');
  });

  it('re-derives the child denorm stamp when the doc moves under it (rule 7 tier 1)', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed('produtos', 'child-1', {
      nome: 'Camiseta M',
      sku: 'SKU-1-M',
      paiId: PROD,
      precos: { 'lista-1': { valor: 79.9 } },
      variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
    });
    db.seed('grupoDeVariacoes', 'g-tam', {
      nome: 'Tamanho',
      tipo: 1,
      variacoes: [{ id: 'v-m', nome: 'M' }],
    });
    const { api } = makeApi({
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        variations: [{ id: 555, seller_custom_field: 'child-1' }],
      })),
    });
    // Another writer lands on the child produto inside the stamp's
    // read-modify-write window, exactly once.
    // The concurrent write lands on `marketplaceIds` — a field the stamp still
    // owns since #920 moved `integracoesComProduto` to the link trigger. Any
    // write fails the `lastUpdateTime` precondition, but only a field the stamp
    // re-derives can show whether the retry RE-DERIVED or blindly re-applied.
    db.afterGet = {
      path: 'produtos/child-1',
      fn: () => {
        const cur = db.docs('produtos').get('child-1')!;
        db.seed('produtos', 'child-1', { ...cur, marketplaceIds: ['concorrente'] });
      },
    };

    await publishProduto(makeDeps(db, api), PROD);

    const child = db.docs('produtos').get('child-1')!;
    // The first update failed the precondition; the retry re-READ and
    // re-DERIVED, so the concurrent value is folded in rather than erased.
    expect(child.marketplaceIds).toEqual(expect.arrayContaining(['concorrente', '555']) as unknown);
    expect(child.marketplace).toEqual([
      { integracaoUid: CONTA, externalParentId: 'MLB777', externalId: '555' },
    ]);
  });

  it('a link without category_id is blocked, and never asks ML to pick one (#799)', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', {
      contaOuterRef: `documents/integracao/${CONTA}`,
      estado: 'r',
      id: null,
      title: 'Camiseta Básica',
      category_id: null,
      listing_type_id: 'gold_special',
    });
    const { api, mocks } = makeApi();

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      'categoria do Mercado Livre não definida (category_id)',
    );
    // Publish used to silently apply suggestCategories(nome, 1)[0]; a wrong
    // first hit was only discoverable once the listing existed.
    expect(mocks.suggestCategories).not.toHaveBeenCalled();
    expect(mocks.createItem).not.toHaveBeenCalled();
  });

  it('writes status/sub_status from the ML response (#799)', async () => {
    const db = new FakeDb();
    seedBase(db);
    const { api } = makeApi({
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        status: 'paused',
        sub_status: ['out_of_stock'],
      })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    // Without these the stock planner reads the fresh listing as a #780
    // legacy-authored doc and sends optimistically for a cycle.
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({
      status: 'paused',
      sub_status: ['out_of_stock'],
      estado: 'pa',
    });
  });

  it('persists the authored attributes and never duplicates the derived ones (#799)', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', {
      ...FLUTTER_LINK,
      id: null,
      attributes: [{ id: 'BRAND', value_name: 'Acme' }],
    });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    // SELLER_SKU/WEIGHT/SELLER_PACKAGE_* are rebuilt from the produto on every
    // publish — storing them would grow the array without bound.
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')!.attributes).toEqual([
      { id: 'BRAND', value_name: 'Acme' },
    ]);
    // They still reach ML on the wire.
    const sent = mocks.createItem!.mock.calls[0]![0] as { attributes: Array<{ id: string }> };
    expect(sent.attributes.map((a) => a.id)).toContain('SELLER_SKU');
  });

  it('an ML failure stamps estado E + errors without wiping existing fields', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    const { api } = makeApi({
      updateItem: vi.fn(async () => {
        throw new MercadoLivreHttpError('item.price invalid', 400, { message: 'invalid' });
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow('item.price invalid');

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    expect(link.estado).toBe('E');
    expect(link.errors).toEqual(['item.price invalid']);
    // Previously persisted data survives the stamp.
    expect(link).toMatchObject({
      precoPublicado: 50,
      descricao: 'Descrição custom do vendedor',
      channels: ['marketplace', 'mshops'],
      campoLegadoDesconhecido: 'preservar',
    });
  });

  it('a description failure AFTER the item write still stamps estado E on the doc', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    const { api } = makeApi({
      setItemDescription: vi.fn(async () => {
        throw new MercadoLivreHttpError('description rate limited', 429, {});
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      'description rate limited',
    );

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    // The item itself published (id refreshed), but the failure is on record.
    expect(link.id).toBe('MLB777');
    expect(link.estado).toBe('E');
    expect(link.errors).toEqual(['description rate limited']);
  });

  it('a description failure on a link deleted mid-publish still records the item id', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    const { api } = makeApi({
      setItemDescription: vi.fn(async () => {
        // The operator removes the listing between the item write and the
        // description call — the window a bare merge() would fill with a
        // key-only ghost holding an error and no `id`.
        db.docs(LINKS_PATH).delete('ML-DOC-1');
        throw new MercadoLivreHttpError('description rate limited', 429, {});
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      'description rate limited',
    );

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    // A live ML listing must never end up with no id on record.
    expect(link.id).toBe('MLB777');
    expect(link.estado).toBe('E');
    // …and the recreated doc is schema-complete, not a key-only ghost.
    expect(link.contaOuterRef).toBe(`documents/integracao/${CONTA}`);
    expect(link.title).toBe('Título antigo');
    expect(link.site_id).toBe('MLB');
  });

  it('stamps the parent deprecated arrays in the legacy order-import shape (#431)', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    const { api } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    const update = db.updates.find((u) => u.path === `produtos/${PROD}`);
    expect(update).toBeDefined();
    // Exact probe shape: {integracaoUid, externalId} — NO relevantData, or the
    // legacy array-contains (exact map equality) would miss it.
    expect(
      (update!.patch.marketplace as FieldValue).isEqual(
        FieldValue.arrayUnion({ integracaoUid: CONTA, externalId: 'MLB777' }),
      ),
    ).toBe(true);
    expect(
      (update!.patch.marketplaceIds as FieldValue).isEqual(FieldValue.arrayUnion('MLB777')),
    ).toBe(true);
    // #920: `integracoesComProduto` is NOT in this patch any more —
    // `onProdutoMercadoLivreLinkChanged` derives it from the link doc written
    // above. Two writers is how a conta gets silently dropped while a live
    // listing exists, so this assertion guards the removal.
    expect(update!.patch).not.toHaveProperty('integracoesComProduto');
  });

  it('stamps each variation child with the legacy cleanup semantics (#431)', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    const { api } = makeApi({
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        variations: [{ id: 555, seller_custom_field: 'child-1' }],
      })),
    });
    db.seed('produtos', 'child-1', {
      nome: 'Camiseta M',
      sku: 'SKU-1-M',
      paiId: PROD,
      ordem: 0,
      precos: { 'lista-1': { valor: 79.9 } },
      variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
      marketplace: [
        // Stale: same conta + same listing, but an old variation id.
        { integracaoUid: CONTA, externalParentId: 'MLB777', externalId: '111' },
        // Parent-shaped entry wrongly on a child — legacy removes it.
        { integracaoUid: CONTA, externalId: 'MLB777' },
        // Another conta's entry must survive untouched.
        { integracaoUid: 'outra-conta', externalParentId: 'MLB999', externalId: '42' },
      ],
      marketplaceIds: ['111'],
      integracoesComProduto: ['outra-conta'],
    });
    db.seed('produtos/child-1/estoques', 'est-c', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 4,
      quantidadeReservada: 0,
    });
    db.seed('grupoDeVariacoes', 'g-tam', {
      nome: 'Tamanho',
      tipo: 1,
      variacoes: [{ id: 'v-m', nome: 'M' }],
    });

    await publishProduto(makeDeps(db, api), PROD);

    const child = db.docs('produtos').get('child-1')!;
    expect(child.marketplace).toEqual([
      { integracaoUid: 'outra-conta', externalParentId: 'MLB999', externalId: '42' },
      { integracaoUid: CONTA, externalParentId: 'MLB777', externalId: '555' },
    ]);
    expect(child.marketplaceIds).toEqual(['111', '555']);
    // #920: the stamp no longer touches this array — the child's
    // `variacaoMercadoLivre` link carries `contaOuterRef` and
    // `onVariacaoMercadoLivreLinkChanged` derives it. The seeded value must
    // come through untouched, CONTA included only by the trigger.
    expect(child.integracoesComProduto).toEqual(['outra-conta']);
  });

  it('re-publish with an already-correct child entry does not duplicate it (#432 review)', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    const { api } = makeApi({
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        variations: [{ id: 555, seller_custom_field: 'child-1' }],
      })),
    });
    db.seed('produtos', 'child-1', {
      nome: 'Camiseta M',
      sku: 'SKU-1-M',
      paiId: PROD,
      ordem: 0,
      precos: { 'lista-1': { valor: 79.9 } },
      variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
      // Already exactly what this publish will produce.
      marketplace: [{ integracaoUid: CONTA, externalParentId: 'MLB777', externalId: '555' }],
      marketplaceIds: ['555'],
      integracoesComProduto: [CONTA],
    });
    db.seed('produtos/child-1/estoques', 'est-c', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 4,
      quantidadeReservada: 0,
    });
    db.seed('grupoDeVariacoes', 'g-tam', {
      nome: 'Tamanho',
      tipo: 1,
      variacoes: [{ id: 'v-m', nome: 'M' }],
    });

    await publishProduto(makeDeps(db, api), PROD);

    const child = db.docs('produtos').get('child-1')!;
    expect(child.marketplace).toEqual([
      { integracaoUid: CONTA, externalParentId: 'MLB777', externalId: '555' },
    ]);
    expect(child.marketplaceIds).toEqual(['555']);
    expect(child.integracoesComProduto).toEqual([CONTA]);
  });

  it('does NOT stamp the deprecated arrays when the ML call fails', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    const { api } = makeApi({
      createItem: vi.fn(async () => {
        throw new MercadoLivreHttpError('rejected', 400, {});
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow('rejected');

    expect(db.updates.find((u) => u.path === `produtos/${PROD}`)).toBeUndefined();
    expect(db.docs('produtos').get(PROD)!.marketplace).toBeUndefined();
  });

  it('binds the tabela de medidas chart end-to-end (SIZE_GRID_*, SIZE swap, descrição, foto)', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.docs('produtos').get(PROD)!.tabelaDeMedidasModaUid = 'documents/tabMedi/tm-1';
    db.seed('tabMedi', 'tm-1', {
      nome: 'Tabela camisetas',
      codigo: null,
      descricao: 'Confira as medidas na tabela.',
      fotos: [{ arquivoOuterRef: 'arquivos/arq-chart' }],
      tabelasDeMedidasMercadoLivre: {
        [CONTA]: {
          tabelas: [
            {
              id: '1594439',
              nome: 'Camisetas ML',
              domain_id: 'MLB-T_SHIRTS',
              attributes: [],
              rows: [
                {
                  varianteUid: 'documents/grupoDeVariacoes/g-tam/variacoes/v-m',
                  id: '1594439:1',
                  attributes: [{ id: 'SIZE', value_name: 'M (38-40)' }],
                },
              ],
            },
          ],
        },
      },
    });
    db.seed('arquivos', 'arq-chart', {
      filename: 'chart.jpg',
      contentType: 'image/jpeg',
      url: 'https://storage/chart.jpg',
      externalIds: [{ externalId: 'PIC-CHART', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.seed('produtos', 'child-1', {
      nome: 'Camiseta M',
      sku: 'SKU-1-M',
      paiId: PROD,
      ordem: 0,
      precos: { 'lista-1': { valor: 79.9 } },
      variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-m'],
    });
    db.seed('produtos/child-1/estoques', 'est-c', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 4,
      quantidadeReservada: 0,
    });
    db.seed('grupoDeVariacoes', 'g-tam', {
      nome: 'Tamanho',
      tipo: 1,
      variacoes: [{ id: 'v-m', nome: 'M' }],
    });
    const { api, mocks } = makeApi({
      getCategory: vi.fn(async () => ({
        id: 'MLB31447',
        settings: { catalog_domain: 'MLB-T_SHIRTS' },
      })),
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        variations: [{ id: 555, seller_custom_field: 'child-1' }],
      })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.getCategory).toHaveBeenCalledWith('MLB31447');
    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    const attrs = payload.attributes as Array<Record<string, unknown>>;
    expect(attrs).toContainEqual({ id: 'SIZE_GRID_ID', value_name: '1594439' });
    const variation = (payload.variations as Array<Record<string, unknown>>)[0]!;
    expect(variation.attributes).toContainEqual({
      id: 'SIZE_GRID_ROW_ID',
      value_name: '1594439:1',
    });
    // The chart row's SIZE replaces the variante's nome ('M').
    expect(variation.attribute_combinations).toContainEqual({
      id: 'SIZE',
      value_name: 'M (38-40)',
    });
    // Chart photo appended after the produto pictures (cached — no upload).
    expect(payload.pictures).toEqual([{ id: 'PIC-CACHED' }, { id: 'PIC-CHART' }]);
    // No extraData/link description → the tabela text is the whole description.
    expect(mocks.setItemDescription).toHaveBeenCalledWith(
      'MLB777',
      'Confira as medidas na tabela.',
      { replace: false },
    );
  });

  it('domain mismatch → no SIZE_GRID_* attributes, but descrição/foto still apply', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.docs('produtos').get(PROD)!.tabelaDeMedidasModaUid = 'documents/tabMedi/tm-1';
    db.seed('tabMedi', 'tm-1', {
      nome: 'Tabela camisetas',
      codigo: null,
      descricao: 'Confira as medidas na tabela.',
      fotos: [{ arquivoOuterRef: 'arquivos/arq-chart' }],
      tabelasDeMedidasMercadoLivre: {
        [CONTA]: { tabelas: [{ id: '1594439', domain_id: 'MLB-SNEAKERS', rows: [] }] },
      },
    });
    db.seed('arquivos', 'arq-chart', {
      filename: 'chart.jpg',
      contentType: 'image/jpeg',
      url: 'https://storage/chart.jpg',
      externalIds: [{ externalId: 'PIC-CHART', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    const { api, mocks } = makeApi({
      getCategory: vi.fn(async () => ({
        id: 'MLB31447',
        settings: { catalog_domain: 'MLB-T_SHIRTS' },
      })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    const attrs = payload.attributes as Array<Record<string, unknown>>;
    expect(attrs.find((a) => a.id === 'SIZE_GRID_ID')).toBeUndefined();
    expect(payload.pictures).toEqual([{ id: 'PIC-CACHED' }, { id: 'PIC-CHART' }]);
    expect(mocks.setItemDescription).toHaveBeenCalledWith(
      'MLB777',
      'Confira as medidas na tabela.',
      { replace: false },
    );
  });

  it('a getCategory failure during the chart binding stamps estado E (legacy MLError catch)', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.docs('produtos').get(PROD)!.tabelaDeMedidasModaUid = 'documents/tabMedi/tm-1';
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    db.seed('tabMedi', 'tm-1', {
      nome: 'Tabela camisetas',
      codigo: null,
      descricao: null,
      fotos: null,
      tabelasDeMedidasMercadoLivre: {
        [CONTA]: { tabelas: [{ id: '1594439', domain_id: 'MLB-T_SHIRTS', rows: [] }] },
      },
    });
    const { api } = makeApi({
      getCategory: vi.fn(async () => {
        throw new MercadoLivreHttpError('category not found', 404, {});
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow('category not found');

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    expect(link.estado).toBe('E');
    expect(link.errors).toEqual(['category not found']);
    // Field preservation holds on this stamp path too.
    expect(link.descricao).toBe('Descrição custom do vendedor');
  });

  it("a link doc holding descricao '' falls through — the tabela text still ships", async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.docs('produtos').get(PROD)!.tabelaDeMedidasModaUid = 'documents/tabMedi/tm-1';
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK, descricao: '' });
    db.seed('tabMedi', 'tm-1', {
      nome: 'Tabela camisetas',
      codigo: null,
      descricao: 'Confira as medidas na tabela.',
      fotos: null,
      tabelasDeMedidasMercadoLivre: null,
    });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.setItemDescription).toHaveBeenCalledWith(
      'MLB777',
      'Confira as medidas na tabela.',
      { replace: true },
    );
  });

  it('prunes a purged ML picture id from the arquivo cache (picture_not_found)', async () => {
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [
        { externalId: 'PIC-DEAD', integracaoPath: `documents/integracao/${CONTA}` },
        { externalId: 'PIC-OTHER', integracaoPath: 'documents/integracao/outra-conta' },
      ],
    });
    const { api } = makeApi({
      createItem: vi.fn(async () => {
        throw new MercadoLivreHttpError('publish failed', 400, {
          cause: [
            {
              code: 'item.pictures.picture_not_found',
              message: 'Picture id PIC-DEAD does not exist.',
            },
          ],
        });
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow('publish failed');

    // The dead entry is gone so the next publish re-uploads; the other
    // conta's entry is untouched.
    const arquivo = db.docs('arquivos').get('arq-1')!;
    expect(arquivo.externalIds).toEqual([
      { externalId: 'PIC-OTHER', integracaoPath: 'documents/integracao/outra-conta' },
    ]);
  });
});
