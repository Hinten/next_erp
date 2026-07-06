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

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) {
      c = new Map();
      this.cols.set(path, c);
    }
    return c;
  }

  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
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
        return {
          id: docId,
          get: async () => ({ exists: col.has(docId), id: docId, data: () => col.get(docId) }),
          set: async (data: DocData, opts?: { merge?: boolean }) => {
            col.set(docId, opts?.merge ? { ...(col.get(docId) ?? {}), ...data } : { ...data });
          },
          update: async (patch: DocData) => {
            self.updates.push({ path: `${path}/${docId}`, patch });
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
    expect(
      (update!.patch.integracoesComProduto as FieldValue).isEqual(FieldValue.arrayUnion(CONTA)),
    ).toBe(true);
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
    expect(child.integracoesComProduto).toEqual(['outra-conta', CONTA]);
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
