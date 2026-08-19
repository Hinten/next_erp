import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { MercadoLivreHttpError, type MercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';

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
    // #798: a FIRST publish probes `GET /users/me` for the `user_product_seller`
    // tag. Untagged by default — every fixture in this file is a legacy-model
    // listing, and an accidental UP resolution would change the payload shape.
    getMe: vi.fn(async () => ({ id: 9, tags: [] as string[] })),
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
    // The conta's ML user id, as the route reads it — the removed-variation
    // sweep needs it to enumerate a family (#798).
    sellerUserId: 9,
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
  // listaDePrecosCache.ts's reader is module-scope and keyed by document PATH
  // only (not by which FakeDb supplied the data) — every test here builds a
  // fresh FakeDb but many reuse the same price-list id ('lista-1'), so a
  // stale cached `nome` would otherwise leak from one test into the next.
  __resetAllReadCaches();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __resetAllReadCaches();
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

  it('a successful publish clears the PREVIOUS rejection, causes and all', async () => {
    // The regression this exists for: `causas` outliving its `errors` paints a
    // red field on a listing that just published fine, and a stale highlight is
    // indistinguishable from a fresh rejection. The two clear together or the
    // feature is worse than no feature.
    const db = new FakeDb();
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    db.seed(LINKS_PATH, 'ML-DOC-1', {
      ...FLUTTER_LINK,
      estado: 'E',
      errors: ['error · item.attributes.missing_required — falta BRAND [item.attributes]'],
      causas: [
        {
          code: 'item.attributes.missing_required',
          causaId: 147,
          tipo: 'error',
          departamento: 'catalog',
          mensagem: 'falta BRAND',
          referencias: ['item.attributes'],
          campos: ['attributes.BRAND'],
        },
      ],
    });
    const { api } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    expect(link).toMatchObject({ estado: 'p', errors: [], causas: [] });
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

  it('a produto with no price names the tabela by BOTH nome and id, not just its raw Firestore id', async () => {
    const db = new FakeDb();
    seedBase(db);
    // Same produto seedBase() writes, but with no price under the resolved
    // price-list id ('lista-1', from makeDeps' tabelaNormalOuterRef) —
    // reproduces the "sem preço" block end to end.
    db.seed('produtos', PROD, {
      nome: 'Camiseta Básica',
      sku: 'SKU-1',
      paiId: null,
      publicado: true,
      precos: {},
      fotos: [{ arquivoOuterRef: 'arquivos/arq-1' }],
    });
    db.seed('listaDePrecos', 'lista-1', { nome: 'Tabela Padrão' });
    const { api } = makeApi();

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      'produto "Camiseta Básica" sem preço na tabela "Tabela Padrão" (lista-1)',
    );
  });

  it('falls back to the id alone when the price table was never seeded — unchanged pre-fix message', async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed('produtos', PROD, {
      nome: 'Camiseta Básica',
      sku: 'SKU-1',
      paiId: null,
      publicado: true,
      precos: {},
      fotos: [{ arquivoOuterRef: 'arquivos/arq-1' }],
    });
    // No `listaDePrecos/lista-1` doc seeded at all.
    const { api } = makeApi();

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      'produto "Camiseta Básica" sem preço na tabela lista-1',
    );
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
        // ML's real rejection shape (developers site, *Guia para produtos →
        // Validações*), not a bare message: the whole point of the stamp is
        // that `cause[]` survives onto the doc.
        throw new MercadoLivreHttpError('ML 400: Validation error', 400, {
          message: 'Validation error',
          error: 'validation_error',
          status: 400,
          cause: [
            {
              department: 'catalog',
              cause_id: 147,
              type: 'error',
              code: 'item.attributes.missing_required',
              references: ['item.attributes'],
              message: 'The attributes [BRAND] are required for category MLB1234.',
            },
          ],
        });
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      'ML 400: Validation error',
    );

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    expect(link.estado).toBe('E');
    // ⚠️ NOT `['ML 400: Validation error']`. That headline — all `api.ts` can
    // build out of the body — was the entire diagnosis the operator used to
    // get, for a rejection ML had explained field by field.
    expect(link.errors).toEqual([
      'error · item.attributes.missing_required — The attributes [BRAND] are required for category MLB1234. [item.attributes]',
    ]);
    expect(link.causas).toEqual([
      expect.objectContaining({
        code: 'item.attributes.missing_required',
        causaId: 147,
        tipo: 'error',
        // Resolved against the payload we sent, so the editor can paint the row.
        campos: ['attributes.BRAND'],
      }),
    ]);
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

describe('publishProduto — kit-aware stock (#797 E5)', () => {
  /** seedBase gives the parent 10 − 2 reservada = 8 of its own. */
  const OWN_DISPONIVEL = 8;

  function seedKit(db: FakeDb, produtoPatch: DocData): void {
    seedBase(db, {
      externalIds: [{ externalId: 'PIC-CACHED', integracaoPath: `documents/integracao/${CONTA}` }],
    });
    Object.assign(db.docs('produtos').get(PROD)!, produtoPatch);
  }

  it('a kit publishes its component-min, not its own stock', async () => {
    const db = new FakeDb();
    seedKit(db, {
      ehKit: true,
      componentesKit: { 'comp-a': { quantidade: 2, limitarEstoque: true } },
    });
    db.seed('produtos', 'comp-a', { nome: 'Malha', paiId: null });
    db.seed('produtos/comp-a/estoques', 'est-a', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 5,
      quantidadeReservada: 0,
    });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    // 5 units of a component consumed 2-at-a-time build 2 kits. Before #797 E5
    // this published the kit's OWN 8 — an oversell of four.
    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.available_quantity).toBe(2);
    expect(payload.available_quantity).not.toBe(OWN_DISPONIVEL);
  });

  it('a component with no estoque at all counts as ZERO, never as unconstrained', async () => {
    const db = new FakeDb();
    seedKit(db, {
      ehKit: true,
      componentesKit: { 'comp-sem-estoque': { quantidade: 1, limitarEstoque: true } },
    });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.available_quantity).toBe(0);
  });

  it('a VIRTUAL kit still sends a quantity — POST /items requires one', async () => {
    const db = new FakeDb();
    seedKit(db, {
      ehKit: true,
      ehKitVirtual: true,
      componentesKit: { 'comp-a': { quantidade: 1, limitarEstoque: true } },
    });
    db.seed('produtos', 'comp-a', { nome: 'Malha', paiId: null });
    db.seed('produtos/comp-a/estoques', 'est-a', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 3,
      quantidadeReservada: 0,
    });
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    // The sweep's `quantidadeParaEnvio` returns null here meaning "do not push a
    // stock update". Publish must NOT read that as "omit the field": this port
    // never creates a real ML virtual kit (those are User-Products-only), so ML
    // receives a plain POST /items and rejects one with no available_quantity.
    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toHaveProperty('available_quantity');
    expect(payload.available_quantity).toBe(3);
  });

  it('a plain produto still publishes its own stock', async () => {
    const db = new FakeDb();
    seedKit(db, {});
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.available_quantity).toBe(OWN_DISPONIVEL);
  });
});

describe('publishProduto — per-variation pictures (#797 E7)', () => {
  const AZUL = 'documents/grupoDeVariacoes/g-cor/variacoes/v-azul';
  const PRETO = 'documents/grupoDeVariacoes/g-cor/variacoes/v-preto';

  function seedCores(db: FakeDb): void {
    seedBase(db, {
      externalIds: [
        { externalId: 'PIC-GENERICA', integracaoPath: `documents/integracao/${CONTA}` },
      ],
    });
    // Parent gallery: one untagged photo plus one per colour.
    db.docs('produtos').get(PROD)!.fotos = [
      { arquivoOuterRef: 'arquivos/arq-1' },
      { arquivoOuterRef: 'arquivos/arq-azul', variantePath: AZUL },
      { arquivoOuterRef: 'arquivos/arq-preto', variantePath: PRETO },
    ];
    for (const [arq, pic] of [
      ['arq-azul', 'PIC-AZUL'],
      ['arq-preto', 'PIC-PRETO'],
    ]) {
      db.seed('arquivos', arq!, {
        filename: `${arq}.jpg`,
        contentType: 'image/jpeg',
        url: `https://storage/${arq}.jpg`,
        externalIds: [{ externalId: pic!, integracaoPath: `documents/integracao/${CONTA}` }],
      });
    }
    db.seed('grupoDeVariacoes', 'g-cor', {
      nome: 'Cor',
      tipo: 2,
      variacoes: [
        { id: 'v-azul', nome: 'Azul' },
        { id: 'v-preto', nome: 'Preto' },
      ],
    });
    for (const [id, nome, uid, ordem] of [
      ['child-azul', 'Camiseta Azul', AZUL, 0],
      ['child-preto', 'Camiseta Preta', PRETO, 1],
    ] as const) {
      db.seed('produtos', id, { nome, sku: `SKU-${id}`, paiId: PROD, ordem, variacoesUid: [uid] });
      db.seed(`produtos/${id}/estoques`, 'est', {
        depositoOuterRef: 'documents/depositos/dep-1',
        quantidade: 3,
        quantidadeReservada: 0,
      });
    }
  }

  it('each variation gets the photos tagged for ITS variante', async () => {
    const db = new FakeDb();
    seedCores(db);
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    const variations = payload.variations as Array<Record<string, unknown>>;
    // Before #797 E7 `pictureIds` was never populated, so BOTH of these were
    // the parent set — and a republish overwrote the correct per-variation
    // picture_ids ML already held.
    expect(variations[0]!.picture_ids).toEqual(['PIC-AZUL']);
    expect(variations[1]!.picture_ids).toEqual(['PIC-PRETO']);
    expect(variations[0]!.picture_ids).not.toEqual(variations[1]!.picture_ids);
    // The item gallery is untouched — the variation ids are NOT unioned in.
    expect(payload.pictures).toEqual([
      { id: 'PIC-GENERICA' },
      { id: 'PIC-AZUL' },
      { id: 'PIC-PRETO' },
    ]);
  });

  it('an untagged catalogue still falls back to the parent gallery', async () => {
    const db = new FakeDb();
    seedCores(db);
    // Strip the per-colour tags: nothing matches, so rung 3 applies.
    db.docs('produtos').get(PROD)!.fotos = [{ arquivoOuterRef: 'arquivos/arq-1' }];
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    const variations = (mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>)
      .variations as Array<Record<string, unknown>>;
    // ML requires every variation to carry a picture.
    expect(variations[0]!.picture_ids).toEqual(['PIC-GENERICA']);
    expect(variations[1]!.picture_ids).toEqual(['PIC-GENERICA']);
  });

  it('resolves each arquivo ONCE per publish, however many children share it', async () => {
    const db = new FakeDb();
    seedCores(db);
    db.docs('produtos').get(PROD)!.fotos = [{ arquivoOuterRef: 'arquivos/arq-1' }];
    // No cached external id → the shared photo must be uploaded exactly once,
    // not once per child (parent + 2 children would be three uploads).
    db.docs('arquivos').get('arq-1')!.externalIds = null;
    const { api, mocks } = makeApi();

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.uploadPicture).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * #798 — the publishing MODEL is decided before anything is uploaded, and a
 * User-Products family fans out to ONE ML ITEM PER VARIATION.
 *
 * ML runs two publishing models side by side during its migration.
 * `buildItemPayload` DROPS the variations array for the UP one, so a family sent
 * through it would collapse into a single variation-less item — which is why a
 * family never goes through it at all.
 */
describe('publishProduto — User-Products model resolution (#798)', () => {
  /** Parent + one variation child. */
  function seedFamily(db: FakeDb): void {
    seedBase(db);
    db.seed('produtos', 'child-1', {
      nome: 'Camiseta M',
      sku: 'SKU-1-M',
      paiId: PROD,
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
  }

  /** ...plus a second child, so a fan-out is observably more than one call. */
  function seedFamilyOfTwo(db: FakeDb): void {
    seedFamily(db);
    db.seed('produtos', 'child-2', {
      nome: 'Camiseta G',
      sku: 'SKU-1-G',
      paiId: PROD,
      precos: { 'lista-1': { valor: 89.9 } },
      variacoesUid: ['documents/grupoDeVariacoes/g-tam/variacoes/v-g'],
    });
    db.seed('produtos/child-2/estoques', 'est-c2', {
      depositoOuterRef: 'documents/depositos/dep-1',
      quantidade: 7,
      quantidadeReservada: 0,
    });
    db.docs('grupoDeVariacoes').get('g-tam')!.variacoes = [
      { id: 'v-m', nome: 'M' },
      { id: 'v-g', nome: 'G' },
    ];
  }

  /** A tagged account whose createItem answers a distinct id per call. */
  function upApi(overrides: Record<string, unknown> = {}) {
    let n = 0;
    return makeApi({
      getMe: vi.fn(async () => ({ id: 9, tags: ['user_product_seller'] })),
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        id: `MLB90${++n}`,
        family_id: 4260899048783356,
      })),
      // The orphan sweep's two hops. Membership == exactly what was published,
      // so the default fixture closes nothing.
      getUserProductFamily: vi.fn(async () => ({ user_products_ids: ['MLBU1', 'MLBU2'] })),
      searchItemsByUserProduct: vi.fn(async () => ({ results: ['MLB901', 'MLB902'] })),
      ...overrides,
    });
  }

  type MlAttr = { id?: string; value_name?: string };
  const valueOf = (attrs: MlAttr[], id: string): string | undefined =>
    attrs.find((a) => a.id === id)?.value_name;

  /** An established family: the FAMILY id on the parent, item ids on members. */
  function seedPublishedFamily(db: FakeDb, publishedChildren: readonly string[]): void {
    db.seed(LINKS_PATH, 'ML-DOC-1', {
      ...FLUTTER_LINK,
      id: '4260899048783356',
      isUserProductModel: true,
      listing_type_id: 'gold_special',
    });
    publishedChildren.forEach((childId, i) => {
      db.seed(`produtos/${childId}/variacaoMercadoLivre`, `var-${childId}`, {
        itemId: `MLB90${i + 1}`,
        produtoVariacaoOuterRef: `documents/produtos/${childId}`,
        produtoMercadoLivreOuterRef: `documents/produtos/${PROD}/produtoMercadoLivre/ML-DOC-1`,
        contaOuterRef: `documents/integracao/${CONTA}`,
      });
    });
  }

  it('publishes ONE ML item per variation, sharing a family_name', async () => {
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    const { api, mocks } = upApi();

    const result = await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.createItem).toHaveBeenCalledTimes(2);
    expect(result.itemIds).toEqual(['MLB901', 'MLB902']);
    for (const call of mocks.createItem!.mock.calls) {
      const payload = call[0] as Record<string, unknown>;
      expect(payload.family_name).toBe('Camiseta Básica');
      // Two hard ML rejections: a written title, and any variations array.
      expect(payload.title).toBeUndefined();
      expect(payload.variations).toBeUndefined();
    }
    // Each item IS one variation, so its identity rides the ordinary attributes
    // (`attribute_combinations` does not exist on a User-Products write).
    const attrsOf = (i: number) =>
      (mocks.createItem!.mock.calls[i]![0] as { attributes: MlAttr[] }).attributes;
    expect(valueOf(attrsOf(0), 'SIZE')).toBe('M');
    expect(valueOf(attrsOf(1), 'SIZE')).toBe('G');
    // ...and its own SKU and stock, not the parent's.
    expect(valueOf(attrsOf(0), 'SELLER_SKU')).toBe('SKU-1-M');
    expect(valueOf(attrsOf(1), 'SELLER_SKU')).toBe('SKU-1-G');
    expect(
      mocks.createItem!.mock.calls.map(
        (c) => (c[0] as { available_quantity: number }).available_quantity,
      ),
    ).toEqual([4, 7]);
  });

  /**
   * #1118 review. `buildUserProductItemPayload` sends
   * `attributesWithValue(input.attributes)` minus the member's own overrides, so
   * a valueless or overridden entry SHIFTS every later index. Resolving
   * `item.attributes[0]` against `input.attributes` therefore paints a healthy
   * row red and leaves the offending one clean — the exact outcome the `campos`
   * docblock exists to forbid.
   */
  it('resolves NO control for a positional cause on the family path', async () => {
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    const { api } = upApi({
      createItem: vi.fn(async () => {
        throw new MercadoLivreHttpError('ML 400: Validation error', 400, {
          message: 'Validation error',
          error: 'validation_error',
          status: 400,
          cause: [
            {
              cause_id: 154,
              type: 'error',
              code: 'item.attributes.invalid_length',
              // Positional, and meaningless without the array actually sent.
              references: ['item.attributes[0]'],
              message: 'Invalid value length for attribute.',
            },
          ],
        });
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      'ML 400: Validation error',
    );

    const link = db.docs(LINKS_PATH).get('ML-DOC-1')!;
    expect(link.estado).toBe('E');
    // The cause is still PERSISTED and still readable — it just claims no control.
    expect(link.errors).toEqual([
      'error · item.attributes.invalid_length — Invalid value length for attribute. [item.attributes[0]]',
    ]);
    expect(link.causas).toEqual([
      expect.objectContaining({ code: 'item.attributes.invalid_length', campos: [] }),
    ]);
  });

  it('DOES resolve a bracketed id from the message on the family path', async () => {
    // The message scan is index-independent, so dropping the positional
    // resolver costs nothing where ML names the attribute.
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    const { api } = upApi({
      createItem: vi.fn(async () => {
        throw new MercadoLivreHttpError('ML 400: Validation error', 400, {
          cause: [
            {
              type: 'error',
              code: 'item.attributes.missing_required',
              references: ['item.attributes'],
              message: 'The attributes [BRAND] are required for category MLB1234.',
            },
          ],
        });
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(
      'ML 400: Validation error',
    );
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')!.causas).toEqual([
      expect.objectContaining({ campos: ['attributes.BRAND'] }),
    ]);
  });

  it('records every member itemId on its child link, and the FAMILY id on the parent', async () => {
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    const { api } = upApi();

    const result = await publishProduto(makeDeps(db, api), PROD);

    // `itemId` is the field precoPlan/bulkEstoquePlan already read — until now
    // only the importer ever wrote it.
    const m1 = [...db.docs('produtos/child-1/variacaoMercadoLivre').values()][0]!;
    const m2 = [...db.docs('produtos/child-2/variacaoMercadoLivre').values()][0]!;
    expect(m1).toMatchObject({
      itemId: 'MLB901',
      sku: 'SKU-1-M',
      produtoVariacaoOuterRef: 'documents/produtos/child-1',
      produtoMercadoLivreOuterRef: `documents/produtos/${PROD}/produtoMercadoLivre/ML-DOC-1`,
      contaOuterRef: `documents/integracao/${CONTA}`,
    });
    expect(m2).toMatchObject({ itemId: 'MLB902', sku: 'SKU-1-G' });
    // ⚠️ The legacy numeric variation id must stay null: there is no variation
    // object under User Products, and a value here would make
    // `variacaoLinkHasListing` report a legacy listing that does not exist.
    expect(m1.id).toBeNull();

    // The PARENT link carries the FAMILY id — never an item id, or the next
    // republish would `PUT /items/{familyId}`.
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({
      id: '4260899048783356',
      isUserProductModel: true,
      estado: 'p',
      errors: [],
    });
    expect(result.itemId).toBe('4260899048783356');
  });

  it('a republish PUTs each member by ITS OWN itemId, without family_name or price', async () => {
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    seedPublishedFamily(db, ['child-1', 'child-2']);
    const { api, mocks } = upApi({
      updateItem: vi.fn(async (id: string) => ({
        ...ITEM_RESPONSE,
        id,
        family_id: 4260899048783356,
      })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.createItem).not.toHaveBeenCalled();
    expect(mocks.updateItem!.mock.calls.map((c) => c[0])).toEqual(['MLB901', 'MLB902']);
    for (const call of mocks.updateItem!.mock.calls) {
      const payload = call[1] as Record<string, unknown>;
      // ML rejects editing family_name once the family has sales, and it feeds
      // the family-id hash — a PUT carrying it could move the member elsewhere.
      expect(payload.family_name).toBeUndefined();
      // Prices belong to the manual price flow and its "baixar preços" guard.
      expect(payload.price).toBeUndefined();
      expect(payload.title).toBeUndefined();
    }
  });

  it('a member added to an existing family POSTs, carrying category and price', async () => {
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    seedPublishedFamily(db, ['child-1']); // child-2 has never been published
    const { api, mocks } = upApi({
      // Distinct id, so the sweep sees the family exactly as published and this
      // test observes create-vs-update routing and nothing else.
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        id: 'MLB902',
        family_id: 4260899048783356,
      })),
      updateItem: vi.fn(async (id: string) => ({
        ...ITEM_RESPONSE,
        id,
        family_id: 4260899048783356,
      })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.updateItem!.mock.calls.map((c) => c[0])).toEqual(['MLB901']);
    expect(mocks.createItem).toHaveBeenCalledOnce();
    // ⚠️ The create-only fields key off the MEMBER, not the family: an
    // established family is `isUpdate` at the listing level, and letting that
    // decide would POST this new member with no category and earn a 400 the
    // operator cannot read.
    expect(mocks.createItem!.mock.calls[0]![0]).toMatchObject({
      // The link's operator-authored title is the family name (#799 bug 4a).
      family_name: 'Título antigo',
      category_id: 'MLB31447',
      listing_type_id: 'gold_special',
      price: 79.9,
    });
  });

  it('a failure mid fan-out keeps the members already confirmed', async () => {
    // Legacy batched every member and committed after the loop, so a failure on
    // the last one discarded the earlier ids while their ML items stayed live —
    // and the retry POSTed them again, duplicating items inside the family.
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    let n = 0;
    const { api } = upApi({
      createItem: vi.fn(async () => {
        n += 1;
        if (n === 2) throw new MercadoLivreHttpError('atributo inválido', 400, null);
        return { ...ITEM_RESPONSE, id: 'MLB901', family_id: 4260899048783356 };
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(MercadoLivreHttpError);

    expect([...db.docs('produtos/child-1/variacaoMercadoLivre').values()][0]).toMatchObject({
      itemId: 'MLB901',
    });
    expect([...db.docs('produtos/child-2/variacaoMercadoLivre').values()]).toHaveLength(0);
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({
      estado: 'E',
      errors: ['atributo inválido'],
    });
  });

  it('sends the description to EVERY member, not just the first', async () => {
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    db.seed(`produtos/${PROD}/extraData`, 'singleton', { descricao: 'Algodão 100%' });
    const { api, mocks } = upApi();

    await publishProduto(makeDeps(db, api), PROD);

    // ML replicates title/attributes/pictures across a user product, but NOT
    // the description — that one is per item.
    expect(mocks.setItemDescription!.mock.calls.map((c) => c[0])).toEqual(['MLB901', 'MLB902']);
  });

  it('prices each member from its own tabela entry when propagation is off', async () => {
    // The rule `precoPlan.buildPrecoDrafts` already applies. Publish has to
    // agree with it, or a first publish lands a price the next price sync
    // immediately overwrites.
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    db.docs('produtos').get(PROD)!.propagatePriceToChildren = false;
    const { api, mocks } = upApi();

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.createItem!.mock.calls.map((c) => (c[0] as { price: number }).price)).toEqual([
      79.9, 89.9,
    ]);
  });

  it('does NOT clobber a concurrent write to a member link (rule 7)', async () => {
    // `state.raw` is captured in the children loop, BEFORE the grupo reads, the
    // size-chart binding, every picture upload and all N ML calls — so by the
    // time the member link is written that snapshot is stale. Re-applying it
    // wholesale reverts whatever the live Flutter app, `importVariations` or the
    // UPtin takeover wrote in between; `parse` even fills defaults for what the
    // snapshot lacks, so it is a clobber and not a merge.
    const db = new FakeDb();
    seedFamily(db); // child-1 only
    seedPublishedFamily(db, ['child-1']);
    const { api } = upApi({
      updateItem: vi.fn(async (id: string, payload: Record<string, unknown>) => {
        // A concurrent writer lands mid-publish, exactly inside the window
        // between the children loop's read and this member's link write.
        //
        // ⚠️ Gated on the MEMBER payload. The orphan sweep also calls
        // `updateItem` — with `{status}` bodies, and AFTER the link write — so an
        // ungated mock re-applied the "concurrent" fields once more at the end
        // and the assertion below passed under a full-clobber implementation.
        if (!('status' in payload)) {
          const doc = db.docs('produtos/child-1/variacaoMercadoLivre').get('var-child-1')!;
          doc.attributes = [{ id: 'VOLTAGE', value_name: '220V' }];
          doc.campoLegadoDesconhecido = 'preservar';
        }
        return { ...ITEM_RESPONSE, id, family_id: 4260899048783356 };
      }),
    });

    await publishProduto(makeDeps(db, api), PROD);

    const member = db.docs('produtos/child-1/variacaoMercadoLivre').get('var-child-1')!;
    // Publish's own field landed...
    expect(member.itemId).toBe('MLB901');
    // ...and the concurrent writer's survived. `attributes` in particular is
    // what Flutter rebuilds its next publish's combinations from.
    expect(member.attributes).toEqual([{ id: 'VOLTAGE', value_name: '220V' }]);
    expect(member.campoLegadoDesconhecido).toBe('preservar');
  });

  it('closes the ML item of a variation deleted in the ERP', async () => {
    // "Camiseta G" was removed here; its MLB902 is still live on ML with no
    // produto behind it — the stock sweep would never touch it again and an
    // order for it would land with nothing to decrement.
    const db = new FakeDb();
    seedFamily(db); // child-1 only
    seedPublishedFamily(db, ['child-1']);
    const { api, mocks } = upApi({
      updateItem: vi.fn(async (id: string) => ({
        ...ITEM_RESPONSE,
        id,
        family_id: 4260899048783356,
      })),
    });

    const result = await publishProduto(makeDeps(db, api), PROD);

    expect(result.orfaosEncerrados).toEqual(['MLB902']);
    // Pause first, then close — the surviving member is never touched.
    expect(mocks.updateItem!.mock.calls).toEqual([
      ['MLB901', expect.any(Object)],
      ['MLB902', { status: 'paused' }],
      ['MLB902', { status: 'closed' }],
    ]);
  });

  it('a sweep failure never fails a publish that already succeeded', async () => {
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    const { api } = upApi({
      getUserProductFamily: vi.fn(async () => {
        throw new MercadoLivreHttpError('indisponível', 503, null);
      }),
    });

    const result = await publishProduto(makeDeps(db, api), PROD);

    expect(result.itemIds).toEqual(['MLB901', 'MLB902']);
    expect(result.orfaosEncerrados).toEqual([]);
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({ estado: 'p', errors: [] });
  });

  it('prices every member from the anchor by default', async () => {
    const db = new FakeDb();
    seedFamilyOfTwo(db);
    const { api, mocks } = upApi();

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.createItem!.mock.calls.map((c) => (c[0] as { price: number }).price)).toEqual([
      79.9, 79.9,
    ]);
  });

  it('the SAME family publishes normally on an untagged account', async () => {
    const db = new FakeDb();
    seedFamily(db);
    const { api, mocks } = makeApi({
      createItem: vi.fn(async () => ({
        ...ITEM_RESPONSE,
        variations: [{ id: 555, seller_custom_field: 'child-1' }],
      })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.createItem).toHaveBeenCalledOnce();
    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.title).toBe('Camiseta Básica');
    expect(payload.family_name).toBeUndefined();
    expect(payload.variations).toHaveLength(1);
  });

  it('a tagged account with NO children publishes in the UP shape', async () => {
    // The other half of the bug: reading only the link doc resolved every first
    // publish to 'legacy', so a simple produto went out with `title` and no
    // `family_name` — which ML rejects once the seller is tagged.
    const db = new FakeDb();
    seedBase(db);
    const { api, mocks } = makeApi({
      getMe: vi.fn(async () => ({ id: 9, tags: ['user_product_seller'] })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    const payload = mocks.createItem!.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.family_name).toBe('Camiseta Básica');
    expect(payload.title).toBeUndefined();
    // ...and the resolution is PERSISTED, so the re-publish below needs no probe.
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({ isUserProductModel: true });
  });

  it('a PUBLISHED legacy listing never probes the account', async () => {
    // Coexistence: an item published before the tag stays editable with the
    // legacy payload. Probing here could only flip it to a shape ML refuses for
    // an already-legacy item — so the call must not happen at all.
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK });
    const { api, mocks } = makeApi({
      getMe: vi.fn(async () => ({ id: 9, tags: ['user_product_seller'] })),
    });

    await publishProduto(makeDeps(db, api), PROD);

    expect(mocks.getMe).not.toHaveBeenCalled();
    expect(mocks.updateItem).toHaveBeenCalledOnce();
    const payload = mocks.updateItem!.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.family_name).toBeUndefined();
  });

  it("estado 'am' (mid-UPtin) blocks the publish before any ML call", async () => {
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK, estado: 'am' });
    const { api, mocks } = makeApi();

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(/UPtin/);

    expect(mocks.updateItem).not.toHaveBeenCalled();
    expect(mocks.createItem).not.toHaveBeenCalled();
    expect(mocks.uploadPicture).not.toHaveBeenCalled();
  });

  it('a getMe failure surfaces as itself AND lands on the link doc', async () => {
    // Two separate contracts. (1) A dead credential must reach the route's
    // 409/502 mapping — swallowing it into a `legacy` guess would publish the
    // wrong payload shape. (2) The module header: every ML failure leaves its
    // reason ON THE DOC, so the ML tab shows why the last attempt failed. The
    // probe is an ML call like any other, so it owes the same stamp.
    const db = new FakeDb();
    seedBase(db);
    const { api, mocks } = makeApi({
      getMe: vi.fn(async () => {
        throw new MercadoLivreHttpError('unauthorized', 401, null);
      }),
    });

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(MercadoLivreHttpError);
    expect(mocks.createItem).not.toHaveBeenCalled();
    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({
      estado: 'E',
      errors: ['unauthorized'],
      // Untouched: the probe never learned the model, so the persisted value
      // must survive rather than be guessed at.
      isUserProductModel: false,
    });
  });

  it('a PRE-FLIGHT refusal still writes nothing — it is not an ML failure', async () => {
    // The distinction the stamp above must not blur: `estado: 'am'` is a
    // validation block raised before any ML call, so the doc keeps its state.
    const db = new FakeDb();
    seedBase(db);
    db.seed(LINKS_PATH, 'ML-DOC-1', { ...FLUTTER_LINK, estado: 'am' });
    const { api } = makeApi();

    await expect(publishProduto(makeDeps(db, api), PROD)).rejects.toThrow(/UPtin/);

    expect(db.docs(LINKS_PATH).get('ML-DOC-1')).toMatchObject({ estado: 'am', errors: null });
  });
});
