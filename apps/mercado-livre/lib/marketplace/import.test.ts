import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MercadoLivreError, type MercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { type ImportDeps, importProduto } from './import';
import { MercadoLivreImportError } from './importCore';
import { type Bucket } from './arquivoUpload';

/* ------------------------------ fake Firestore ---------------------------- */
// Supports doc get/set/update, chained where/limit/get, a collectionGroup query
// (docs carry `ref.parent.parent.id` = the owning produto), and auto ids.

type DocData = Record<string, unknown>;

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly updates: Array<{ path: string; patch: DocData }> = [];
  private autoN = 0;

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  docs(path: string): Map<string, DocData> {
    return this.col(path);
  }

  private query(entries: Array<[string, DocData, string]>) {
    // entries: [docId, data, collectionPath]
    const clauses: Array<[string, unknown]> = [];
    let lim: number | null = null;
    const self = this;
    const q = {
      where(field: string, _op: string, value: unknown) {
        clauses.push([field, value]);
        return q;
      },
      limit(n: number) {
        lim = n;
        return q;
      },
      async get() {
        let rows = entries.filter(([, d]) => clauses.every(([f, v]) => d[f] === v));
        if (lim != null) rows = rows.slice(0, lim);
        return {
          docs: rows.map(([id, d, colPath]) => ({
            id,
            data: () => d,
            exists: true,
            ref: { parent: { parent: { id: parentDocId(colPath) } } },
          })),
          empty: rows.length === 0,
        };
        void self;
      },
    };
    return q;
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
          create: async (data: DocData) => {
            if (col.has(docId)) throw Object.assign(new Error('already exists'), { code: 6 });
            col.set(docId, { ...data });
          },
          update: async (patch: DocData) => {
            self.updates.push({ path: `${path}/${docId}`, patch });
            col.set(docId, { ...(col.get(docId) ?? {}), ...patch });
          },
        };
      },
      where: (field: string, op: string, value: unknown) =>
        self.query([...col.entries()].map(([id, d]) => [id, d, path])).where(field, op, value),
      limit: (n: number) => self.query([...col.entries()].map(([id, d]) => [id, d, path])).limit(n),
      get: async () => ({
        docs: [...col.entries()].map(([id, d]) => ({ id, data: () => d, exists: true })),
      }),
    };
  }

  collectionGroup(groupId: string) {
    const entries: Array<[string, DocData, string]> = [];
    for (const [path, col] of this.cols) {
      if (path.split('/').pop() === groupId) {
        for (const [id, d] of col) entries.push([id, d, path]);
      }
    }
    return this.query(entries);
  }

  // Minimal transaction fake for the taxonomy resolver (#519/#520): no real
  // isolation/retry — reads and writes apply immediately against the same maps,
  // which is enough for these single-threaded unit tests.
  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    const tx: FakeTransaction = {
      get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
      create: async (ref: { create: (d: DocData) => Promise<void> }, data: DocData) => {
        await ref.create(data);
      },
      set: async (
        ref: { set: (d: DocData, o?: { merge?: boolean }) => Promise<void> },
        data: DocData,
        opts?: { merge?: boolean },
      ) => {
        await ref.set(data, opts);
      },
      update: async (ref: { update: (d: DocData) => Promise<void> }, patch: DocData) => {
        await ref.update(patch);
      },
    };
    return fn(tx);
  }
}

interface FakeTransaction {
  get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
  create: (ref: { create: (d: DocData) => Promise<void> }, data: DocData) => Promise<void>;
  set: (
    ref: { set: (d: DocData, o?: { merge?: boolean }) => Promise<void> },
    data: DocData,
    opts?: { merge?: boolean },
  ) => Promise<void>;
  update: (ref: { update: (d: DocData) => Promise<void> }, patch: DocData) => Promise<void>;
}

function parentDocId(colPath: string): string {
  const segs = colPath.split('/').filter(Boolean);
  return segs[segs.length - 2] ?? '';
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/** Minimal Storage bucket for the photo-import step. */
class FakeBucket {
  readonly saved: string[] = [];
  readonly name = 'demo-erp.appspot.com';
  file(path: string) {
    const self = this;
    return {
      save: async () => {
        self.saved.push(path);
      },
    };
  }
}

/* --------------------------------- fixtures ------------------------------- */

function makeApi(
  item: DocData,
  description = 'Uma camiseta',
  // Default: a single-node chain (the item's own category, no ancestors) — enough
  // for tests that don't care about the category-import specifics (#442).
  category: DocData | Error = { id: (item.category_id as string) ?? 'MLB0000', name: 'Categoria' },
): MercadoLivreApi {
  return {
    getItem: vi.fn(async () => item),
    getItemDescription: vi.fn(async () => ({ plain_text: description })),
    getCategory: vi.fn(async () => {
      if (category instanceof Error) throw category;
      return category;
    }),
  } as unknown as MercadoLivreApi;
}

const SIMPLE_ITEM: DocData = {
  id: 'MLB123',
  title: 'Camiseta Preta',
  category_id: 'MLB1430',
  base_price: 79.9,
  price: 69.9,
  available_quantity: 12,
  condition: 'new',
  status: 'active',
  listing_type_id: 'gold_special',
  seller_id: 55,
  seller_custom_field: 'SKU1',
  attributes: [{ id: 'SELLER_SKU', value_name: 'SKU1' }],
};

function deps(db: FakeDb, api: MercadoLivreApi, over: Partial<ImportDeps> = {}): ImportDeps {
  return {
    db: asDb(db),
    api,
    integracaoId: 'conta-A',
    sellerUserId: 55,
    tabelaNormalOuterRef: 'documents/tabelasDePrecos/tabNormal',
    tabelaPromocionalOuterRef: 'documents/tabelasDePrecos/tabPromo',
    depositoOuterRef: 'documents/depositos/dep1',
    ...over,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('importProduto — guards', () => {
  it('rejects a User-Products listing (family_name) — #521', async () => {
    const db = new FakeDb();
    const api = makeApi({ ...SIMPLE_ITEM, family_name: 'Camiseta' });
    const promise = importProduto(deps(db, api), 'MLB123');
    await expect(promise).rejects.toThrow(MercadoLivreImportError);
    await expect(promise).rejects.toThrow(/User-Products/);
  });

  it('rejects a closed listing', async () => {
    const db = new FakeDb();
    const api = makeApi({ ...SIMPLE_ITEM, status: 'closed' });
    await expect(importProduto(deps(db, api), 'MLB123')).rejects.toThrow(/encerrado/);
  });

  it('rejects an item owned by another seller', async () => {
    const db = new FakeDb();
    const api = makeApi({ ...SIMPLE_ITEM, seller_id: 999 });
    await expect(importProduto(deps(db, api), 'MLB123')).rejects.toThrow(/outro vendedor/);
  });
});

describe('importProduto — create', () => {
  it('creates a produto (deterministic per-item id), extraData, estoque, link + denorm', async () => {
    const db = new FakeDb();
    const api = makeApi(SIMPLE_ITEM);
    const res = await importProduto(deps(db, api), 'MLB123');

    expect(res).toMatchObject({ created: true, nome: 'Camiseta Preta', estado: 'p' });
    // id is a per-item hash (NOT the seller_custom_field — collision-safe)
    expect(res.produtoId).toMatch(/^[0-9a-f]{64}$/);
    const pid = res.produtoId;
    expect(db.docs('produtos').get(pid)).toMatchObject({
      nome: 'Camiseta Preta',
      sku: 'SKU1',
      publicado: true,
    });
    expect(db.docs(`produtos/${pid}/extraData`).get('singleton')).toMatchObject({ condicao: 1 });
    expect(db.docs(`produtos/${pid}/estoques`).get(`est-${pid}-dep1`)).toMatchObject({
      quantidade: 12,
    });
    const link = [...db.docs(`produtos/${pid}/produtoMercadoLivre`).values()][0]!;
    expect(link).toMatchObject({ id: 'MLB123', estado: 'p', status: 'active' });
    // dual-run denorm applied
    expect(db.updates.some((u) => u.path === `produtos/${pid}`)).toBe(true);
  });

  it('two SKU-less ML items sharing a seller_custom_field create SEPARATE produtos (#2 collision fix)', async () => {
    // No SELLER_SKU (sku=null → no agglutination), same reused seller_custom_field.
    const db = new FakeDb();
    const base = { ...SIMPLE_ITEM, attributes: [], seller_custom_field: 'ABC' };
    const resA = await importProduto(deps(db, makeApi({ ...base, id: 'MLBA' })), 'MLBA');
    const resB = await importProduto(deps(db, makeApi({ ...base, id: 'MLBB' })), 'MLBB');
    expect(resA.produtoId).not.toBe(resB.produtoId);
    expect(db.docs('produtos').size).toBe(2);
  });
});

describe('importProduto — dedup to an existing produto', () => {
  it('re-syncs the produto found via the existing link doc (id == itemId)', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'existing-prod', { nome: 'Já Existe', sku: 'OLD' });
    db.seed('produtos/existing-prod/produtoMercadoLivre', 'lnk1', {
      id: 'MLB123',
      contaOuterRef: 'documents/integracao/conta-A',
    });
    const api = makeApi(SIMPLE_ITEM);
    const res = await importProduto(deps(db, api), 'MLB123');

    expect(res).toMatchObject({ produtoId: 'existing-prod', created: false });
    // nome never overwritten on re-import
    expect(db.docs('produtos').get('existing-prod')!.nome).toBe('Já Existe');
  });

  it('resolves an existing produto by SKU when there is no link yet', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'by-sku', { nome: 'Por SKU', sku: 'SKU1', paiId: null });
    const api = makeApi(SIMPLE_ITEM);
    const res = await importProduto(deps(db, api), 'MLB123');
    expect(res).toMatchObject({ produtoId: 'by-sku', created: false });
  });
});

describe('importProduto — photos (#439)', () => {
  const PIC_ITEM: DocData = {
    ...SIMPLE_ITEM,
    pictures: [{ id: 'PIC1', secure_url: 'https://http2.mlstatic.com/PIC1-O.jpg' }],
  };
  const asBucket = (b: FakeBucket) => b as unknown as Bucket;
  const photoFetch = () =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
      arrayBuffer: async () => new TextEncoder().encode('imgbytes').buffer,
    })) as unknown as typeof globalThis.fetch;

  it('imports the listing photos when a bucket is provided (importarFotos default)', async () => {
    const db = new FakeDb();
    const bucket = new FakeBucket();
    const fetch = photoFetch();
    const res = await importProduto(
      deps(db, makeApi(PIC_ITEM), { bucket: asBucket(bucket), fetchImpl: fetch }),
      'MLB123',
    );
    expect(db.docs('arquivos').size).toBe(1);
    expect(bucket.saved).toHaveLength(1);
    const fotoUpdate = db.updates
      .filter((u) => u.path === `produtos/${res.produtoId}`)
      .find((u) => 'fotos' in u.patch);
    expect(fotoUpdate).toBeDefined();
  });

  it('does NOT import photos when importarFotos is false', async () => {
    const db = new FakeDb();
    const fetch = photoFetch();
    await importProduto(
      deps(db, makeApi(PIC_ITEM), {
        bucket: asBucket(new FakeBucket()),
        fetchImpl: fetch,
        options: { importarFotos: false },
      }),
      'MLB123',
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(db.docs('arquivos').size).toBe(0);
  });

  it('imports no photos when no bucket is provided', async () => {
    const db = new FakeDb();
    const res = await importProduto(deps(db, makeApi(PIC_ITEM)), 'MLB123');
    expect(res.created).toBe(true);
    expect(db.docs('arquivos').size).toBe(0); // gated on deps.bucket
  });
});

describe('importProduto — ERP Categoria chain (#442)', () => {
  const CATEGORY_CHAIN: DocData = {
    id: 'MLB1430',
    name: 'Roupas',
    path_from_root: [
      { id: 'MLB1071', name: 'Vestuário e Acessórios' },
      { id: 'MLB1430', name: 'Roupas' },
    ],
  };

  it('importarCategorias=true + a category on the item → the produto create carries the leaf outer-ref', async () => {
    const db = new FakeDb();
    const api = makeApi(SIMPLE_ITEM, undefined, CATEGORY_CHAIN);
    const res = await importProduto(deps(db, api), 'MLB123');

    expect(api.getCategory).toHaveBeenCalledWith('MLB1430');
    expect(db.docs('produtos').get(res.produtoId)).toMatchObject({
      categoriaProdutoOuterRef: 'documents/categorias/MLB1430',
    });
    // the full ancestor chain got created, not just the leaf
    expect(db.docs('categorias').get('MLB1071')).toMatchObject({
      nome: 'Vestuário e Acessórios',
    });
    expect(db.docs('categorias').get('MLB1430')).toMatchObject({ nome: 'Roupas' });
  });

  it('importarCategorias=false → no getCategory call, no category link', async () => {
    const db = new FakeDb();
    const api = makeApi(SIMPLE_ITEM, undefined, CATEGORY_CHAIN);
    const res = await importProduto(
      deps(db, api, { options: { importarCategorias: false } }),
      'MLB123',
    );

    expect(api.getCategory).not.toHaveBeenCalled();
    expect(db.docs('produtos').get(res.produtoId)!.categoriaProdutoOuterRef).toBeNull();
    expect(db.docs('categorias').size).toBe(0);
  });

  it('a MercadoLivreError from getCategory is best-effort — the produto still imports, with a null ref', async () => {
    const db = new FakeDb();
    const api = makeApi(SIMPLE_ITEM, undefined, new MercadoLivreError('categoria indisponível'));
    const res = await importProduto(deps(db, api), 'MLB123');

    expect(res.created).toBe(true);
    expect(db.docs('produtos').get(res.produtoId)!.categoriaProdutoOuterRef).toBeNull();
    expect(db.docs('categorias').size).toBe(0);
  });
});

describe('importProduto — legacy variations[] listing (#520)', () => {
  // No top-level SELLER_SKU on the item itself → the parent sku falls back to the
  // strip-6 guess (`skuGuessFromVariations`): both children's SELLER_SKU collapse
  // to the SAME 'SHIRT1-' stem once the last 6 chars are stripped.
  const VARIATION_ITEM: DocData = {
    id: 'MLB999',
    title: 'Camiseta',
    category_id: 'MLB1430',
    base_price: 59.9,
    price: 59.9,
    condition: 'new',
    status: 'active',
    listing_type_id: 'gold_special',
    seller_id: 55,
    attributes: [],
    variations: [
      {
        id: 111,
        available_quantity: 5,
        attributes: [{ id: 'SELLER_SKU', value_name: 'SHIRT1-000111' }],
        attribute_combinations: [
          { id: 'SIZE', name: 'Tamanho', value_id: '10', value_name: 'G' },
          { id: 'COLOR', name: 'Cor', value_id: '20', value_name: 'Azul' },
        ],
      },
      {
        id: 222,
        available_quantity: 7,
        attributes: [{ id: 'SELLER_SKU', value_name: 'SHIRT1-000222' }],
        attribute_combinations: [
          { id: 'SIZE', name: 'Tamanho', value_id: '11', value_name: 'M' },
          { id: 'COLOR', name: 'Cor', value_id: '20', value_name: 'Azul' },
        ],
      },
    ],
  };

  it('imports the parent + one child produto per variation, with links/estoque/denorm', async () => {
    const db = new FakeDb();
    const api = makeApi(VARIATION_ITEM);
    const res = await importProduto(deps(db, api), 'MLB999');

    expect(res.created).toBe(true);
    expect(res.variations).toEqual({ total: 2, created: 2 });
    // parent sku falls back to the strip-6 guess (shared stem across children)
    expect(db.docs('produtos').get(res.produtoId)).toMatchObject({ sku: 'SHIRT1-' });
    // parent never gets its own stock — it lives on the children
    expect(db.docs(`produtos/${res.produtoId}/estoques`).size).toBe(0);

    const parentLinkId = [...db.docs(`produtos/${res.produtoId}/produtoMercadoLivre`).keys()][0]!;
    const parentLinkOuterRef = `documents/produtos/${res.produtoId}/produtoMercadoLivre/${parentLinkId}`;

    const children = [...db.docs('produtos').entries()].filter(
      ([id, d]) => id !== res.produtoId && d.paiId === res.produtoId,
    );
    expect(children).toHaveLength(2);

    for (const [childId, childData] of children) {
      expect(childData).toMatchObject({ publicado: true, paiId: res.produtoId });
      expect(typeof childData.sku).toBe('string');
      expect((childData.sku as string).startsWith('SHIRT1-')).toBe(true);

      // legacy fixed-width link doc id: 'XMLB000000000000000' + itemId + 'vMLB' + variationId
      const links = db.docs(`produtos/${childId}/variacaoMercadoLivre`);
      expect(links.size).toBe(1);
      const [linkId, linkData] = [...links.entries()][0]!;
      expect(linkId.startsWith('XMLB000000000000000MLB999vMLB')).toBe(true);
      expect(linkData).toMatchObject({
        produtoVariacaoOuterRef: `documents/produtos/${childId}`,
        produtoMercadoLivreOuterRef: parentLinkOuterRef,
      });

      // one estoque doc per child, quantidade = that variation's available_quantity
      const estoques = db.docs(`produtos/${childId}/estoques`);
      expect(estoques.size).toBe(1);
      const [, estoqueData] = [...estoques.entries()][0]!;
      expect(typeof estoqueData.quantidade).toBe('number');

      // dual-run denorm: the child's marketplace entry carries externalParentId
      // (the parent's own entry never does — models.dart `ProdMarketplace` json).
      const update = db.updates.find(
        (u) => u.path === `produtos/${childId}` && 'marketplace' in u.patch,
      );
      expect(update).toBeDefined();
    }
  });

  it('re-import resolves the SAME parent + child docs (idempotent — no duplicate produtos/links)', async () => {
    const db = new FakeDb();
    const api = makeApi(VARIATION_ITEM);
    const first = await importProduto(deps(db, api), 'MLB999');
    expect(db.docs('produtos').size).toBe(3); // parent + 2 children

    const second = await importProduto(deps(db, api), 'MLB999');
    expect(second.produtoId).toBe(first.produtoId);
    expect(second.created).toBe(false);
    expect(second.variations).toEqual({ total: 2, created: 0 });
    expect(db.docs('produtos').size).toBe(3); // no new docs created

    const parentLinks = db.docs(`produtos/${first.produtoId}/produtoMercadoLivre`);
    expect(parentLinks.size).toBe(1);
    const children = [...db.docs('produtos').entries()].filter(
      ([id, d]) => id !== first.produtoId && d.paiId === first.produtoId,
    );
    for (const [childId] of children) {
      expect(db.docs(`produtos/${childId}/variacaoMercadoLivre`).size).toBe(1);
    }
  });

  it('taxonomy: the SHARED COLOR grupo (same value on both variations) is created only once', async () => {
    const db = new FakeDb();
    const api = makeApi(VARIATION_ITEM);
    const res = await importProduto(deps(db, api), 'MLB999');

    // Two distinct attribute ids (SIZE, COLOR) across both variations — even
    // though COLOR:Azul repeats identically on both — resolve to exactly 2
    // grupoDeVariacoes docs, not 4.
    expect(db.docs('grupoDeVariacoes').size).toBe(2);
    expect(db.docs('grupoDeVariacoes').has('SIZE')).toBe(true);
    expect(db.docs('grupoDeVariacoes').has('COLOR')).toBe(true);

    const children = [...db.docs('produtos').entries()].filter(
      ([id, d]) => id !== res.produtoId && d.paiId === res.produtoId,
    );
    for (const [, childData] of children) {
      expect(childData.grupoDeVariacoesUid).toEqual(expect.arrayContaining(['SIZE', 'COLOR']));
      expect(Array.isArray(childData.variacoesUid)).toBe(true);
      expect((childData.variacoesUid as string[]).length).toBeGreaterThan(0);
    }
  });
});
