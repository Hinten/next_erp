import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreError,
  MercadoLivreHttpError,
  type MercadoLivreApi,
} from '@delfrance/integrations-mercado-livre';

import { type ImportDeps, importProduto } from './import';
import { MercadoLivreImportError } from './importCore';
import { MAX_FAMILY_SIBLINGS } from './importFamily';
import { type Bucket } from './arquivoUpload';

/* ------------------------------ fake Firestore ---------------------------- */
// Supports doc get/set/update, chained where/limit/get, a collectionGroup query
// (docs carry `ref.parent.parent.id` = the owning produto), and auto ids.

type DocData = Record<string, unknown>;

/**
 * Apply an `update()` patch, expanding dotted keys into nested writes the way
 * Firestore does — `{'precos.tabNormal': v}` sets that ONE map entry and leaves
 * its siblings alone, rather than creating a literal `'precos.tabNormal'`
 * field. Without this the double cannot distinguish a surgical dotted write
 * from a whole-map replace, which is the exact property #803 relies on.
 */
function applyUpdatePatch(base: DocData, patch: DocData): DocData {
  const out: DocData = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (!key.includes('.')) {
      out[key] = value;
      continue;
    }
    const [head, ...rest] = key.split('.');
    const existing = out[head!];
    const nested: DocData =
      existing != null && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as DocData) }
        : {};
    nested[rest.join('.')] = value;
    out[head!] = nested;
  }
  return out;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly updates: Array<{ path: string; patch: DocData; precondition?: unknown }> = [];
  /** Every write in issue order — `updates` alone cannot show set-vs-update ordering. */
  readonly writeLog: Array<{ op: 'set' | 'create' | 'update'; path: string }> = [];
  /**
   * Collection queries, by their FIRST `where` clause. Enough to tell one lookup
   * from another (`sku ==` vs `paiId ==`) and, more to the point, to assert that a
   * lazily-guarded read was NOT issued — #801's sibling scan must stay unpaid when
   * every variation already resolves by link.
   */
  readonly queryLog: Array<{ path: string; field: string }> = [];
  /**
   * Fires after every doc `get()`. The seam for injecting a concurrent writer
   * into the exact window a `lastUpdateTime` guard protects: between the read a
   * patch is derived from and the write that applies it.
   */
  afterGet: ((path: string) => Promise<void> | void) | null = null;
  private autoN = 0;
  /**
   * Per-document write counter standing in for Firestore's `updateTime`. It
   * exists so `lastUpdateTime` preconditions are actually ENFORCED here (see
   * `update` below): a double that merely records the precondition and writes
   * anyway hides exactly the bug the guard is meant to catch — a write ordered
   * AFTER another write to the same doc, asserting a stamp we already burned.
   */
  private versions = new Map<string, number>();

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }
  private bump(key: string): void {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }
  private stamp(key: string): string {
    return `v${this.versions.get(key) ?? 0}`;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
    this.bump(`${path}/${id}`);
  }
  /** The current `updateTime` stand-in for a doc — for precondition assertions. */
  stampOf(path: string, id: string): string {
    return this.stamp(`${path}/${id}`);
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
          get: async () => {
            const snap = {
              exists: col.has(docId),
              id: docId,
              data: () => col.get(docId),
              // The real SDK always carries an updateTime on an existing doc;
              // the import threads it back as a `lastUpdateTime` precondition
              // on the precos write (ADR 0011 tier 1), so the double must
              // supply one or the guard would go untested.
              updateTime: col.has(docId) ? (self.stamp(`${path}/${docId}`) as unknown) : undefined,
            };
            await self.afterGet?.(`${path}/${docId}`);
            return snap;
          },
          set: async (data: DocData, opts?: { merge?: boolean }) => {
            col.set(docId, opts?.merge ? { ...(col.get(docId) ?? {}), ...data } : { ...data });
            self.writeLog.push({ op: 'set', path: `${path}/${docId}` });
            self.bump(`${path}/${docId}`);
          },
          create: async (data: DocData) => {
            if (col.has(docId)) throw Object.assign(new Error('already exists'), { code: 6 });
            col.set(docId, { ...data });
            self.writeLog.push({ op: 'create', path: `${path}/${docId}` });
            self.bump(`${path}/${docId}`);
          },
          update: async (patch: DocData, precondition?: { lastUpdateTime?: unknown }) => {
            const key = `${path}/${docId}`;
            // Enforce, don't just record: a stale lastUpdateTime must throw
            // gRPC 9 exactly as Firestore would.
            if (
              precondition?.lastUpdateTime !== undefined &&
              precondition.lastUpdateTime !== self.stamp(key)
            ) {
              throw Object.assign(new Error('failed precondition'), { code: 9 });
            }
            self.updates.push({ path: key, patch, precondition });
            self.writeLog.push({ op: 'update', path: key });
            col.set(docId, applyUpdatePatch(col.get(docId) ?? {}, patch));
            self.bump(key);
          },
        };
      },
      where: (field: string, op: string, value: unknown) => {
        self.queryLog.push({ path, field });
        return self
          .query([...col.entries()].map(([id, d]) => [id, d, path]))
          .where(field, op, value);
      },
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
  // #1087 — what `GET /moderations/last_moderation/{id}-ITM` answers. An `Error`
  // is thrown instead, which is how the 404-is-data and the transient-degrade
  // branches are driven. Default `[]`: ML has nothing on this listing.
  moderations: DocData[] | Error = [],
): MercadoLivreApi {
  return {
    getItem: vi.fn(async () => item),
    getItemDescription: vi.fn(async () => ({ plain_text: description })),
    getCategory: vi.fn(async () => {
      if (category instanceof Error) throw category;
      return category;
    }),
    getLastModeration: vi.fn(async () => {
      if (moderations instanceof Error) throw moderations;
      return moderations;
    }),
  } as unknown as MercadoLivreApi;
}

/** ML's `last_moderation` wire shape for a paused-by-policy listing (#1087). */
const MODERACAO_ML: DocData = {
  name: 'POOR_QUALITY_THUMBNAIL',
  id: 'mod-1',
  date_created: '2021-04-14T10:47:05.270-0400',
  evidences: [{ section_name: 'pictures', text_matched: '604505-MLB' }],
  wordings: [
    { type: 'REASON', value: 'A foto principal não atende à qualidade exigida.' },
    { type: 'REMEDY', value: 'Suba uma foto com fundo branco e sem textos.' },
  ],
};

/** The same moderação as `mapModeracoes` stores it on the link doc. */
const MODERACAO_GRAVADA = {
  nome: 'POOR_QUALITY_THUMBNAIL',
  dataCriacao: '2021-04-14T10:47:05.270-0400',
  motivo: 'A foto principal não atende à qualidade exigida.',
  remedio: 'Suba uma foto com fundo branco e sem textos.',
  secoes: ['pictures'],
  evidencias: ['604505-MLB'],
};

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

/** A listing ML has paused for a policy reason — trips `precisaConsultarModeracao`. */
const ITEM_MODERADO: DocData = {
  ...SIMPLE_ITEM,
  status: 'paused',
  sub_status: ['moderation_penalty'],
};

function deps(db: FakeDb, api: MercadoLivreApi, over: Partial<ImportDeps> = {}): ImportDeps {
  return {
    db: asDb(db),
    api,
    integracaoId: 'conta-A',
    sellerUserId: 55,
    tabelaNormalOuterRef: 'documents/tabelasDePrecos/tabNormal',
    depositoOuterRef: 'documents/depositos/dep1',
    ...over,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('importProduto — guards', () => {
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
    // legacy denorm applied
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

describe('importProduto — precos race guard (#803, ADR 0011 tier 1)', () => {
  it('guards the precos write with the read it was derived from, and issues it BEFORE the produto merge', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'existing-prod', { nome: 'Já Existe', sku: 'OLD' });
    db.seed('produtos/existing-prod/produtoMercadoLivre', 'lnk1', {
      id: 'MLB123',
      contaOuterRef: 'documents/integracao/conta-A',
    });
    const stampAtPlanTime = db.stampOf('produtos', 'existing-prod');

    await importProduto(deps(db, makeApi(SIMPLE_ITEM)), 'MLB123');

    const precosWrite = db.updates.find(
      (u) => u.path === 'produtos/existing-prod' && 'precos.tabNormal' in u.patch,
    );
    expect(precosWrite?.precondition).toEqual({ lastUpdateTime: stampAtPlanTime });

    // ORDERING, not decoration: the produto merge always writes on the update
    // path (it carries ultimaModificacao, #800) and so BUMPS updateTime. If it
    // ran first, the precondition above would assert a stamp we had already
    // burned and every price-writing import would fail FAILED_PRECONDITION.
    const produtoWrites = db.writeLog.filter((w) => w.path === 'produtos/existing-prod');
    expect(produtoWrites[0]).toEqual({ op: 'update', path: 'produtos/existing-prod' });
  });

  it('re-plans ONCE when a concurrent writer wins the race, instead of reverting them', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'existing-prod', { nome: 'Já Existe', sku: 'OLD' });
    db.seed('produtos/existing-prod/produtoMercadoLivre', 'lnk1', {
      id: 'MLB123',
      contaOuterRef: 'documents/integracao/conta-A',
    });

    // Land a competing write in the exact window the guard protects: right
    // after the import reads the produto its plan is derived from. The Flutter
    // app saving the WHOLE precos map is the real-world shape — a dotted-path
    // write cannot defend against it, which is why the precondition exists.
    let injected = false;
    db.afterGet = (path) => {
      if (injected || path !== 'produtos/existing-prod') return;
      injected = true;
      db.seed('produtos', 'existing-prod', {
        ...db.docs('produtos').get('existing-prod'),
        precos: { outra: { valor: 1 } },
      });
    };

    const res = await importProduto(deps(db, makeApi(SIMPLE_ITEM)), 'MLB123');

    // It succeeded — via the re-plan, not by blindly re-applying the patch.
    expect(res).toMatchObject({ produtoId: 'existing-prod', created: false });
    const stored = db.docs('produtos').get('existing-prod')!.precos as Record<string, unknown>;
    // Both survive: the racer's key was NOT reverted, and ours still landed
    // (79.9 = SIMPLE_ITEM's base_price, which wins over `price`).
    expect(stored).toEqual({ outra: { valor: 1 }, tabNormal: { valor: 79.9 } });
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

/**
 * ML MODERATIONS on the import path (#1087).
 *
 * The import is the THIRD writer of the link doc's `moderacoes`, after the
 * `items` webhook and `reverificarAnuncio`. Before this it wrote `status` and
 * `sub_status` while never asking ML why — so a moderated anúncio imported as a
 * bare "pausado", which is exactly the state #1087 exists to abolish.
 */
describe('importProduto — ML moderations (#1087)', () => {
  /** The parent link doc, whatever id it was minted under. */
  function linkOf(db: FakeDb, produtoId: string): DocData {
    return [...db.docs(`produtos/${produtoId}/produtoMercadoLivre`).values()][0]!;
  }

  it('a moderated listing lands with ML’s REASON, not a bare pausado', async () => {
    const db = new FakeDb();
    const api = makeApi(ITEM_MODERADO, undefined, undefined, [MODERACAO_ML]);
    const res = await importProduto(deps(db, api), 'MLB123');

    expect(linkOf(db, res.produtoId)).toMatchObject({
      status: 'paused',
      sub_status: ['moderation_penalty'],
      moderacoes: [MODERACAO_GRAVADA],
    });
    // The `-ITM` element suffix, through the real `moderationReferenceId` — a
    // bare item id is a silent miss on ML's side, not an error.
    expect(api.getLastModeration).toHaveBeenCalledWith('MLB123-ITM');
  });

  it('⚠️ THE HOT-PATH GUARANTEE: a healthy listing spends NO moderation call', async () => {
    // `items`-driven or catalogue-wide, the overwhelming majority of listings are
    // healthy, and they must keep costing exactly the one `GET /items/{id}` they
    // cost before. The gate is what makes that true.
    const db = new FakeDb();
    const api = makeApi(SIMPLE_ITEM);
    const res = await importProduto(deps(db, api), 'MLB123');

    expect(api.getLastModeration).not.toHaveBeenCalled();
    // …and it still records "asked, none" — free, off the item already fetched.
    expect(linkOf(db, res.produtoId).moderacoes).toEqual([]);
  });

  it('⚠️ a re-import of a listing whose moderação ML LIFTED clears the stored reason', async () => {
    // The regression, end to end. The link write spreads the existing doc and
    // `clearFalha()` deliberately carries no `moderacoes`, so the old reason used
    // to survive onto a listing ML now calls `active`.
    const db = new FakeDb();
    const moderado = makeApi(ITEM_MODERADO, undefined, undefined, [MODERACAO_ML]);
    const res = await importProduto(deps(db, moderado), 'MLB123');
    expect(linkOf(db, res.produtoId).moderacoes).toEqual([MODERACAO_GRAVADA]);

    const saudavel = makeApi({ ...SIMPLE_ITEM, status: 'active', sub_status: [] });
    await importProduto(deps(db, saudavel), 'MLB123');

    expect(linkOf(db, res.produtoId)).toMatchObject({ status: 'active', moderacoes: [] });
    // Cleared by the GATE, not by a second endpoint call — the item itself said
    // there was nothing left to explain.
    expect(saudavel.getLastModeration).not.toHaveBeenCalled();
  });

  it('reads a 404 from last_moderation as "não moderado", never as a failure', async () => {
    const db = new FakeDb();
    const api = makeApi(
      ITEM_MODERADO,
      undefined,
      undefined,
      new MercadoLivreHttpError('ML 404', 404, null),
    );
    const res = await importProduto(deps(db, api), 'MLB123');

    expect(api.getLastModeration).toHaveBeenCalled();
    expect(linkOf(db, res.produtoId).moderacoes).toEqual([]);
  });

  it('⚠️ a TRANSIENT moderation failure degrades to "never asked" — the produto still imports', async () => {
    // The deliberate divergence from the other two writers. For them the status
    // write IS the unit of work, so rethrowing costs nothing; here it would throw
    // away a produto, its extraData, its stock and its children over a
    // diagnostic. The listing is not left blind — `status`/`sub_status` are
    // recorded from the item already in hand.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = new FakeDb();
    const api = makeApi(
      ITEM_MODERADO,
      undefined,
      undefined,
      new MercadoLivreHttpError('ML 500', 500, null),
    );
    const res = await importProduto(deps(db, api), 'MLB123');

    expect(db.docs('produtos').get(res.produtoId)).toBeDefined();
    expect(linkOf(db, res.produtoId)).toMatchObject({ status: 'paused' });
    // `null`, never `[]`: on disk `[]` is byte-identical to a healthy listing, so
    // it would record "not moderated" about a listing we failed to ask about.
    expect(linkOf(db, res.produtoId).moderacoes ?? null).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('a degraded re-import keeps the reason it already had rather than blanking it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = new FakeDb();
    const ok = makeApi(ITEM_MODERADO, undefined, undefined, [MODERACAO_ML]);
    const res = await importProduto(deps(db, ok), 'MLB123');

    const falha = makeApi(
      ITEM_MODERADO,
      undefined,
      undefined,
      new MercadoLivreHttpError('ML 500', 500, null),
    );
    await importProduto(deps(db, falha), 'MLB123');

    expect(linkOf(db, res.produtoId).moderacoes).toEqual([MODERACAO_GRAVADA]);
    expect(warn).toHaveBeenCalled();
  });

  it('⚠️ lerModeracoes:false (the mass path) skips the CALL but still clears a healthy listing', async () => {
    // The flag suppresses the network read, never the write. A listing whose own
    // status warrants no moderation still lands `[]`, so a catalogue-wide
    // re-import self-heals every stale reason for free.
    const db = new FakeDb();
    const saudavel = makeApi(SIMPLE_ITEM);
    const res = await importProduto(deps(db, saudavel, { lerModeracoes: false }), 'MLB123');
    expect(saudavel.getLastModeration).not.toHaveBeenCalled();
    expect(linkOf(db, res.produtoId).moderacoes).toEqual([]);

    // A genuinely moderated one degrades to "never asked" instead.
    const db2 = new FakeDb();
    const moderado = makeApi(ITEM_MODERADO, undefined, undefined, [MODERACAO_ML]);
    const res2 = await importProduto(deps(db2, moderado, { lerModeracoes: false }), 'MLB123');
    expect(moderado.getLastModeration).not.toHaveBeenCalled();
    expect(linkOf(db2, res2.produtoId).moderacoes ?? null).toBeNull();
  });

  it('a closed listing never spends a moderation call — the guard runs first', async () => {
    // `closed` + `moderation_penalty` IS a moderation reading, so without the
    // ordering this would pay ML for a listing the import rejects anyway.
    const db = new FakeDb();
    const api = makeApi({ ...SIMPLE_ITEM, status: 'closed', sub_status: ['moderation_penalty'] });
    await expect(importProduto(deps(db, api), 'MLB123')).rejects.toThrow(/encerrado/);
    expect(api.getLastModeration).not.toHaveBeenCalled();
  });

  it('a legacy variations[] child link never gains a moderação of its own', async () => {
    // A `variations[]` entry is not a listing of its own and has no status to
    // explain — symmetric with `status`/`sub_status`, and what keeps #707's
    // phantom prune free of reasons it never read.
    const db = new FakeDb();
    const api = makeApi(
      {
        ...ITEM_MODERADO,
        variations: [
          {
            id: 111,
            available_quantity: 3,
            attributes: [{ id: 'SELLER_SKU', value_name: 'SKU1-P' }],
            attribute_combinations: [{ id: 'SIZE', name: 'Tamanho', value_name: 'P' }],
          },
        ],
      },
      undefined,
      undefined,
      [MODERACAO_ML],
    );
    const res = await importProduto(deps(db, api), 'MLB123');

    // The parent still carries it…
    expect(linkOf(db, res.produtoId).moderacoes).toEqual([MODERACAO_GRAVADA]);
    // …every child link does not.
    const childLinks = [...db.cols.keys()].filter((p) => p.endsWith('/variacaoMercadoLivre'));
    expect(childLinks.length).toBeGreaterThan(0);
    for (const path of childLinks) {
      for (const doc of db.docs(path).values()) {
        expect(doc.moderacoes ?? null).toBeNull();
      }
    }
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

      // legacy denorm: the child's marketplace entry carries externalParentId
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

describe('importProduto — ERP-first variation children (#801)', () => {
  const PARENT_ID = 'erp-pai';
  const PARENT_LINK_ID = 'erp-pai-link';
  const PARENT_LINK_REF = `documents/produtos/${PARENT_ID}/produtoMercadoLivre/${PARENT_LINK_ID}`;

  const fake = (grupoId: string, varianteId: string) =>
    `documents/grupoDeVariacoes/${grupoId}/variacoes/${varianteId}`;
  const COMBO_G = [fake('SIZE', '10'), fake('COLOR', '20')];
  const COMBO_M = [fake('SIZE', '11'), fake('COLOR', '20')];

  // Child SELLER_SKUs ML knows and the ERP does NOT — so the `sku` + `paiId` rule
  // stays blind and the combination rule is the only thing that can dedup.
  const ITEM: DocData = {
    id: 'MLB999',
    title: 'Camiseta',
    category_id: 'MLB1430',
    base_price: 59.9,
    price: 59.9,
    condition: 'new',
    status: 'active',
    listing_type_id: 'gold_special',
    seller_id: 55,
    attributes: [{ id: 'SELLER_SKU', value_name: 'ML-PAI' }],
    variations: [
      {
        id: 111,
        available_quantity: 5,
        attributes: [{ id: 'SELLER_SKU', value_name: 'ML-000111' }],
        attribute_combinations: [
          { id: 'SIZE', name: 'Tamanho', value_id: '10', value_name: 'G' },
          { id: 'COLOR', name: 'Cor', value_id: '20', value_name: 'Azul' },
        ],
      },
      {
        id: 222,
        available_quantity: 7,
        attributes: [{ id: 'SELLER_SKU', value_name: 'ML-000222' }],
        attribute_combinations: [
          { id: 'SIZE', name: 'Tamanho', value_id: '11', value_name: 'M' },
          { id: 'COLOR', name: 'Cor', value_id: '20', value_name: 'Azul' },
        ],
      },
    ],
  };

  const variante = (id: string, nome: string) => ({
    id,
    nome,
    codigo: null,
    variantesVinculadasIds: null,
    externalVariacaoLinks: [],
    timestamp: 1,
  });

  /**
   * The taxonomy an operator already built by hand. The ML combos MATCH it (grupo
   * by attribute id, variante by `value_id`), so the fake paths the import derives
   * are byte-identical to the ones the ERP children already carry — which is the
   * whole reason this dedup can work at all.
   */
  function seedTaxonomia(db: FakeDb): void {
    db.seed('grupoDeVariacoes', 'SIZE', {
      nome: 'Tamanho',
      tipo: 1,
      ordem: 1,
      variacoesIds: ['10', '11'],
      variacoes: [variante('10', 'G'), variante('11', 'M')],
    });
    db.seed('grupoDeVariacoes', 'COLOR', {
      nome: 'Cor',
      tipo: 2,
      ordem: 2,
      variacoesIds: ['20'],
      variacoes: [variante('20', 'Azul')],
    });
  }

  /** A parent already linked to the listing — the precondition for reusing its children. */
  function seedParent(db: FakeDb): void {
    db.seed('produtos', PARENT_ID, { nome: 'Camiseta', sku: 'ERP-PAI', paiId: null });
    db.seed(`produtos/${PARENT_ID}/produtoMercadoLivre`, PARENT_LINK_ID, {
      id: 'MLB999',
      contaOuterRef: 'documents/integracao/conta-A',
      produtoOuterRef: `documents/produtos/${PARENT_ID}`,
    });
  }

  function seedChild(db: FakeDb, id: string, sku: string, variacoesUid: string[]): void {
    db.seed('produtos', id, { nome: `Camiseta ${id}`, sku, paiId: PARENT_ID, variacoesUid });
  }

  const childrenOf = (db: FakeDb, parentId: string) =>
    [...db.docs('produtos').entries()].filter(([, d]) => d.paiId === parentId);

  /**
   * {@link ITEM} with ONE SELLER_SKU across both variations — the collision the ERP
   * itself produces: a child's SKU is `parentSku + variante.codigo`, and these
   * variantes carry no `codigo`, so both children are born holding the parent's.
   */
  const ITEM_SKU_COMPARTILHADO: DocData = {
    ...ITEM,
    variations: (ITEM.variations as DocData[]).map((v) => ({
      ...v,
      attributes: [{ id: 'SELLER_SKU', value_name: 'ERP-PAI' }],
    })),
  };

  /**
   * {@link ITEM} with NON-NUMERIC variation ids. `itemVariationSchema` accepts them
   * ("ML has sent numeric and (rarely) string ids over time"), and they are what makes
   * `numericVariationId` — and therefore the link's `id` field — come out `null`.
   */
  const ITEM_ID_NAO_NUMERICO: DocData = {
    ...ITEM,
    variations: (ITEM.variations as DocData[]).map((v, i) => ({ ...v, id: i === 0 ? 'A' : 'B' })),
  };

  /** The one `variacaoMercadoLivre` link under a child — fails loudly if there isn't exactly one. */
  const soleLink = (db: FakeDb, childId: string): DocData => {
    const links = db.docs(`produtos/${childId}/variacaoMercadoLivre`);
    expect([...links.keys()]).toHaveLength(1);
    return [...links.values()][0]!;
  };

  it('reuses the ERP children carrying the same variação combination — no duplicates, no ML link, no matching SKU', async () => {
    const db = new FakeDb();
    seedTaxonomia(db);
    seedParent(db);
    seedChild(db, 'erp-filho-G', 'ERP-G', COMBO_G);
    seedChild(db, 'erp-filho-M', 'ERP-M', COMBO_M);

    const res = await importProduto(deps(db, makeApi(ITEM)), 'MLB999');

    expect(res.produtoId).toBe(PARENT_ID);
    // Both variations landed on the pre-existing children: nothing was created.
    expect(res.variations).toEqual({ total: 2, created: 0 });
    expect(db.docs('produtos').size).toBe(3); // parent + the two ERP children, no second set
    expect(
      childrenOf(db, PARENT_ID)
        .map(([id]) => id)
        .sort(),
    ).toEqual(['erp-filho-G', 'erp-filho-M']);

    // Each reused child gains exactly one link, pointing at THIS parent link.
    for (const childId of ['erp-filho-G', 'erp-filho-M']) {
      const links = db.docs(`produtos/${childId}/variacaoMercadoLivre`);
      expect(links.size).toBe(1);
      expect([...links.values()][0]).toMatchObject({
        produtoMercadoLivreOuterRef: PARENT_LINK_REF,
        produtoVariacaoOuterRef: `documents/produtos/${childId}`,
      });
    }
    // The reuse is non-destructive: the ERP's own sku/combination survive.
    expect(db.docs('produtos').get('erp-filho-G')).toMatchObject({
      sku: 'ERP-G',
      variacoesUid: COMBO_G,
    });
  });

  it('matches regardless of the stored order (the blind spot a literal legacy port would keep)', async () => {
    const db = new FakeDb();
    seedTaxonomia(db);
    seedParent(db);
    // Reversed vs the ML combo order, and one entry in the leading-slash form the
    // legacy app also wrote — `sameCombo` canonicalises before comparing.
    seedChild(db, 'erp-filho-G', 'ERP-G', [`/${fake('COLOR', '20')}`, fake('SIZE', '10')]);
    seedChild(db, 'erp-filho-M', 'ERP-M', [...COMBO_M].reverse());

    const res = await importProduto(deps(db, makeApi(ITEM)), 'MLB999');

    expect(res.variations).toEqual({ total: 2, created: 0 });
    expect(db.docs('produtos').size).toBe(3);
  });

  it('a parent with no pre-existing children is unaffected — both children are still minted', async () => {
    const db = new FakeDb();
    seedTaxonomia(db);
    seedParent(db);

    const res = await importProduto(deps(db, makeApi(ITEM)), 'MLB999');

    expect(res.variations).toEqual({ total: 2, created: 2 });
    expect(childrenOf(db, PARENT_ID)).toHaveLength(2);
  });

  it('never claims a child that carries no combination of its own', async () => {
    const db = new FakeDb();
    seedTaxonomia(db);
    seedParent(db);
    // An ERP child the operator never assigned variations to. Matching it would
    // bind an arbitrary variation to it; both variations must mint instead.
    seedChild(db, 'erp-filho-sem-combo', 'ERP-X', []);

    const res = await importProduto(deps(db, makeApi(ITEM)), 'MLB999');

    expect(res.variations).toEqual({ total: 2, created: 2 });
    expect(childrenOf(db, PARENT_ID)).toHaveLength(3); // the combo-less one, untouched, + 2 new
    expect(db.docs('produtos/erp-filho-sem-combo/variacaoMercadoLivre').size).toBe(0);
  });

  it('rejects a candidate already linked to a DIFFERENT variation of the same parent', async () => {
    const db = new FakeDb();
    seedTaxonomia(db);
    seedParent(db);
    // Same combination as variation 111, but the child is already spoken for by
    // variation 999 — merging the two would collapse two ML variations onto one
    // produto. It must be left alone and a fresh child minted.
    seedChild(db, 'erp-filho-G', 'ERP-G', COMBO_G);
    db.seed('produtos/erp-filho-G/variacaoMercadoLivre', 'link-999', {
      id: 999,
      produtoMercadoLivreOuterRef: PARENT_LINK_REF,
      produtoVariacaoOuterRef: 'documents/produtos/erp-filho-G',
    });

    const res = await importProduto(deps(db, makeApi(ITEM)), 'MLB999');

    expect(res.variations).toEqual({ total: 2, created: 2 });
    expect(childrenOf(db, PARENT_ID)).toHaveLength(3);
    // untouched: still exactly the one foreign link
    expect([...db.docs('produtos/erp-filho-G/variacaoMercadoLivre').keys()]).toEqual(['link-999']);
  });

  it('reuses a candidate whose existing link names THIS variation (stringified legacy id)', async () => {
    const db = new FakeDb();
    seedTaxonomia(db);
    seedParent(db);
    seedChild(db, 'erp-filho-G', 'ERP-G', COMBO_G);
    // Flutter-era row: the numeric `id` stored as a string, so rule 1's `id ==`
    // query misses it and resolution falls through to the combination rule.
    db.seed('produtos/erp-filho-G/variacaoMercadoLivre', 'link-111', {
      id: '111',
      produtoMercadoLivreOuterRef: PARENT_LINK_REF,
      produtoVariacaoOuterRef: 'documents/produtos/erp-filho-G',
    });

    const res = await importProduto(deps(db, makeApi(ITEM)), 'MLB999');

    // variation 111 reuses the child AND its link doc; 222 is new.
    expect(res.variations).toEqual({ total: 2, created: 1 });
    expect([...db.docs('produtos/erp-filho-G/variacaoMercadoLivre').keys()]).toEqual(['link-111']);
  });

  it('reuse REPLACES the child’s precos under sobrescreverPreco (default true) — a decision, not an accident', async () => {
    const db = new FakeDb();
    seedTaxonomia(db);
    seedParent(db);
    db.seed('produtos', 'erp-filho-G', {
      nome: 'Camiseta G',
      sku: 'ERP-G',
      paiId: PARENT_ID,
      variacoesUid: COMBO_G,
      precos: { tabNormal: { valor: 10 } }, // the operator's own price
    });
    seedChild(db, 'erp-filho-M', 'ERP-M', COMBO_M);

    await importProduto(deps(db, makeApi(ITEM)), 'MLB999');

    // `sobrescreverPreco` defaults TRUE, so the ML parent's price wins — same as the
    // SKU rule has always done. Contrast `sobrescreverEstoque`, which defaults FALSE
    // precisely so ERP stock is never clobbered. If this assertion ever has to change,
    // it is because the OPTION's meaning changed, not because the dedup regressed.
    expect(db.docs('produtos').get('erp-filho-G')).toMatchObject({
      sku: 'ERP-G', // untouched
      variacoesUid: COMBO_G, // untouched
      precos: { tabNormal: { valor: 59.9 } }, // REPLACED
    });
  });

  it('sobrescreverPreco=false leaves the reused child’s own price table alone', async () => {
    const db = new FakeDb();
    seedTaxonomia(db);
    seedParent(db);
    db.seed('produtos', 'erp-filho-G', {
      nome: 'Camiseta G',
      sku: 'ERP-G',
      paiId: PARENT_ID,
      variacoesUid: COMBO_G,
      precos: { tabNormal: { valor: 10 } },
    });
    seedChild(db, 'erp-filho-M', 'ERP-M', COMBO_M);

    await importProduto(
      deps(db, makeApi(ITEM), {
        options: { sobrescreverPreco: false },
      }),
      'MLB999',
    );

    expect(db.docs('produtos').get('erp-filho-G')).toMatchObject({
      precos: { tabNormal: { valor: 10 } },
    });
  });

  it('reusing a child whose estoque sits at a NON-CANONICAL id updates that row, never a second one', async () => {
    const db = new FakeDb();
    seedTaxonomia(db);
    seedParent(db);
    seedChild(db, 'erp-filho-G', 'ERP-G', COMBO_G);
    seedChild(db, 'erp-filho-M', 'ERP-M', COMBO_M);
    // A Flutter-era stock row: auto-id, not `est-<produtoId>-<depositoId>`.
    db.seed('produtos/erp-filho-G/estoques', 'legacy-auto-id', {
      parentId: 'erp-filho-G',
      depositoOuterRef: 'documents/depositos/dep1',
      quantidade: 3,
      quantidadeReservada: 0,
    });

    await importProduto(
      deps(db, makeApi(ITEM), {
        options: { sobrescreverEstoque: true },
      }),
      'MLB999',
    );

    // Exactly ONE row, still at its original id, carrying the ML quantity. Merging
    // into the canonical id would have upserted a SECOND, field-less row that every
    // canonical-id reader would then prefer — the duplicate-stock harm #801 removes.
    const estoques = db.docs('produtos/erp-filho-G/estoques');
    expect([...estoques.keys()]).toEqual(['legacy-auto-id']);
    expect(estoques.get('legacy-auto-id')).toMatchObject({
      parentId: 'erp-filho-G',
      depositoOuterRef: 'documents/depositos/dep1',
      quantidade: 5,
    });
  });

  it('does not read the parent’s children when every variation resolves by link', async () => {
    const db = new FakeDb();
    seedTaxonomia(db);
    seedParent(db);
    await importProduto(deps(db, makeApi(ITEM)), 'MLB999');

    // Steady state: everything now resolves on rule 1, so the lazy sibling scan
    // must not be issued at all.
    db.queryLog.length = 0;
    const second = await importProduto(deps(db, makeApi(ITEM)), 'MLB999');

    expect(second.variations).toEqual({ total: 2, created: 0 });
    expect(db.queryLog.filter((q) => q.path === 'produtos' && q.field === 'paiId')).toEqual([]);
  });

  /**
   * Rule 2 had NO coverage before this block — the fixture above deliberately gives
   * ML child SKUs the ERP does not carry, so the SKU rule stayed blind and the
   * combination rule was the thing under test.
   *
   * ⚠️ Assert BINDINGS, not counts. `FakeDb.limit` slices after filtering a `Map`, so
   * `db.seed` order is what `limit(1)` used to return — but with the guard removed
   * most of these still report the same `{total, created}` and the same produto
   * count. What actually changes is WHICH child holds a link, what that link's `id`
   * says, and which child got a stock row.
   */
  describe('an ambiguous SKU never decides the binding (#1067)', () => {
    it.each([
      ['G seeded first', ['erp-filho-G', 'erp-filho-M']],
      ['M seeded first', ['erp-filho-M', 'erp-filho-G']],
    ] as const)(
      'two siblings sharing one SKU each bind to their OWN variation (%s)',
      async (_rotulo, ordemDeSeed) => {
        const db = new FakeDb();
        seedTaxonomia(db);
        seedParent(db);
        const combos: Record<string, string[]> = {
          'erp-filho-G': COMBO_G,
          'erp-filho-M': COMBO_M,
        };
        for (const childId of ordemDeSeed) seedChild(db, childId, 'ERP-PAI', combos[childId]!);

        const res = await importProduto(deps(db, makeApi(ITEM_SKU_COMPARTILHADO)), 'MLB999');

        expect(res.variations).toEqual({ total: 2, created: 0 });
        expect(db.docs('produtos').size).toBe(3);
        // Running BOTH seed orders is the point: it proves the outcome is order-
        // INDEPENDENT rather than asserting whatever order the double happens to have.
        // Under `limit(1)` both variations landed on whichever was seeded first — its
        // link got repointed in place and the other child kept no link and no stock.
        expect(soleLink(db, 'erp-filho-G').id).toBe(111);
        expect(soleLink(db, 'erp-filho-M').id).toBe(222);
        expect([...db.docs('produtos/erp-filho-M/estoques').values()][0]).toMatchObject({
          quantidade: 7,
        });
      },
    );

    it('a UNIQUE SKU match still binds even when its combination contradicts', async () => {
      const db = new FakeDb();
      seedTaxonomia(db);
      seedParent(db);
      // Variation 111's SELLER_SKU sits on the child holding 222's combination. Only
      // one child carries that SKU, so the SKU decides. Rejecting on disagreement
      // would re-open #801's duplication for every catalogue whose grupos the
      // taxonomy resolver cannot match — there the fake paths differ, so rule 3 misses
      // too and the SKU is the only rung that still binds anything.
      seedChild(db, 'erp-filho-contraditorio', 'ML-000111', COMBO_M);

      const res = await importProduto(deps(db, makeApi(ITEM)), 'MLB999');

      expect(soleLink(db, 'erp-filho-contraditorio').id).toBe(111);
      // 222 finds it by combination, but it is spoken for now, so 222 mints its own.
      expect(res.variations).toEqual({ total: 2, created: 1 });
    });

    it('a UNIQUE SKU match with no combination of its own binds and gets one backfilled', async () => {
      const db = new FakeDb();
      seedTaxonomia(db);
      seedParent(db);
      // Flutter-era child: `variacoesUid` absent entirely, so rule 3 can never claim
      // it and rule 2 is the only thing keeping it out of a duplicate set.
      db.seed('produtos', 'erp-filho-flutter', {
        nome: 'Camiseta G',
        sku: 'ML-000111',
        paiId: PARENT_ID,
      });

      const res = await importProduto(deps(db, makeApi(ITEM)), 'MLB999');

      expect(res.variations).toEqual({ total: 2, created: 1 });
      expect(soleLink(db, 'erp-filho-flutter').id).toBe(111);
      expect(db.docs('produtos').get('erp-filho-flutter')).toMatchObject({
        variacoesUid: COMBO_G,
      });
    });

    it('an ambiguous SKU whose siblings carry no combination mints instead of guessing', async () => {
      const db = new FakeDb();
      seedTaxonomia(db);
      seedParent(db);
      seedChild(db, 'erp-filho-a', 'ERP-PAI', []);
      seedChild(db, 'erp-filho-b', 'ERP-PAI', []);

      const res = await importProduto(deps(db, makeApi(ITEM_SKU_COMPARTILHADO)), 'MLB999');

      // Nothing can disambiguate — shared SKU, no combination on either side. Minting
      // is the non-destructive branch: binding an arbitrary one would repoint a link
      // and replace a price table on a coin flip.
      expect(res.variations).toEqual({ total: 2, created: 2 });
      expect(db.docs('produtos/erp-filho-a/variacaoMercadoLivre').size).toBe(0);
      expect(db.docs('produtos/erp-filho-b/variacaoMercadoLivre').size).toBe(0);
    });

    it('a UNIQUE SKU match already linked to a DIFFERENT variation is left alone', async () => {
      const db = new FakeDb();
      seedTaxonomia(db);
      seedParent(db);
      db.seed('produtos', 'erp-filho-flutter', {
        nome: 'Camiseta G',
        sku: 'ML-000111',
        paiId: PARENT_ID,
      });
      // Spoken for by variation 999. `assembleVariationChildPlan` overwrites a link's
      // naming field unconditionally, so adopting this one would repoint it in place
      // and strand 999 — the harm rule 3 has always guarded and rule 2 did not.
      db.seed('produtos/erp-filho-flutter/variacaoMercadoLivre', 'link-999', {
        id: 999,
        produtoMercadoLivreOuterRef: PARENT_LINK_REF,
        produtoVariacaoOuterRef: 'documents/produtos/erp-filho-flutter',
      });

      const res = await importProduto(deps(db, makeApi(ITEM)), 'MLB999');

      expect(res.variations).toEqual({ total: 2, created: 2 });
      expect(soleLink(db, 'erp-filho-flutter')).toMatchObject({ id: 999 });
    });

    it('an unambiguous SKU match terminates at rule 2 — no sibling scan', async () => {
      const db = new FakeDb();
      seedTaxonomia(db);
      seedParent(db);
      seedChild(db, 'erp-filho-G', 'ML-000111', COMBO_G);
      seedChild(db, 'erp-filho-M', 'ML-000222', COMBO_M);

      const res = await importProduto(deps(db, makeApi(ITEM)), 'MLB999');

      expect(res.variations).toEqual({ total: 2, created: 0 });
      // `limit(2)` costs one extra DOCUMENT, never an extra QUERY: rule 2 answered
      // both variations, so rule 3's lazy `paiId ==` scan must stay unpaid.
      expect(db.queryLog.filter((q) => q.path === 'produtos' && q.field === 'paiId')).toEqual([]);
      expect(db.queryLog.filter((q) => q.path === 'produtos' && q.field === 'sku')).toHaveLength(2);
    });

    /**
     * A link's naming field is `numericVariationId(variationId)`, i.e. **`null` for a
     * non-numeric ML variation id** — a shape THIS importer writes, not just a
     * Flutter-era artefact. "Names nothing readable" therefore cannot mean "claimed by
     * someone else", or every re-import would decline the link it wrote a moment ago
     * and mint a duplicate. Both rules re-import the same listing three times here;
     * the produto count is the whole assertion.
     */
    it.each([
      ['rule 2 — SKUs ML knows', 'ML-000111', 'ML-000222'],
      ['rule 3 — SKUs ML does not know', 'ERP-G', 'ERP-M'],
    ])('a null-id link stays adoptable across re-imports (%s)', async (_rotulo, skuG, skuM) => {
      const db = new FakeDb();
      seedTaxonomia(db);
      seedParent(db);
      seedChild(db, 'erp-filho-G', skuG, COMBO_G);
      seedChild(db, 'erp-filho-M', skuM, COMBO_M);

      for (let i = 0; i < 3; i += 1) {
        await importProduto(deps(db, makeApi(ITEM_ID_NAO_NUMERICO)), 'MLB999');
      }

      expect(db.docs('produtos').size).toBe(3);
      expect(
        childrenOf(db, PARENT_ID)
          .map(([id]) => id)
          .sort(),
      ).toEqual(['erp-filho-G', 'erp-filho-M']);
    });
  });
});

describe('importProduto — User-Products (family_name) listing (#521)', () => {
  const FAMILY_ID = 'FAM1';
  const MEMBER_A_ID = 'MLBA1';
  const MEMBER_B_ID = 'MLBB1';
  const MEMBER_C_ID = 'MLBC1';

  const MEMBER_A: DocData = {
    id: MEMBER_A_ID,
    family_name: 'Camiseta Família',
    family_id: FAMILY_ID,
    title: 'Camiseta',
    category_id: 'MLB1430',
    base_price: 59.9,
    price: 59.9,
    available_quantity: 5,
    condition: 'new',
    status: 'active',
    listing_type_id: 'gold_special',
    seller_id: 55,
    user_product_id: 'UP-A',
    attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-A' }],
    attribute_combinations: [{ id: 'SIZE', name: 'Tamanho', value_id: '10', value_name: 'G' }],
  };
  const MEMBER_B: DocData = {
    ...MEMBER_A,
    id: MEMBER_B_ID,
    user_product_id: 'UP-B',
    available_quantity: 7,
    attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-B' }],
    attribute_combinations: [{ id: 'SIZE', name: 'Tamanho', value_id: '11', value_name: 'M' }],
  };
  const MEMBER_C: DocData = {
    ...MEMBER_A,
    id: MEMBER_C_ID,
    user_product_id: 'UP-C',
    available_quantity: 3,
    attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-C' }],
    attribute_combinations: [{ id: 'SIZE', name: 'Tamanho', value_id: '12', value_name: 'P' }],
  };

  // Literal parity ids (deps()'s integracaoId is 'conta-A') — pinned directly
  // against the production formula so a regression that reintroduces a
  // separator (or otherwise changes the concat) is caught here, not just by a
  // hex-64/prefix shape check.
  const expectedParentId = createHash('sha256').update(`conta-A${FAMILY_ID}`).digest('hex');
  const expectedParentLinkId = `100000000000000000${FAMILY_ID}`;
  const expectedChildId = (memberId: string) =>
    `XMLB000000000000000${expectedParentLinkId}vMLB${memberId}`;

  /** `FieldValue.arrayUnion(...)`'s public `elements` array — the appended entries. */
  function arrayUnionElements(v: unknown): unknown[] {
    return (v as { elements: unknown[] }).elements;
  }

  function makeUpApi(opts: {
    items: Record<string, DocData>;
    family?: DocData | Error;
    search?: DocData | Error;
    category?: DocData | Error;
    /** `<memberItemId>-ITM` → ML's `last_moderation` answer for that member (#1087). */
    moderations?: Record<string, DocData[] | Error>;
  }): MercadoLivreApi {
    const category = opts.category ?? { id: 'MLB1430', name: 'Roupas' };
    return {
      getItem: vi.fn(async (id: string) => {
        const it = opts.items[id];
        // A sibling the test didn't fixture is a best-effort fan-out failure
        // (MercadoLivreError), not a hard crash — mirrors a real "item not found".
        if (!it) throw new MercadoLivreError(`item não encontrado: ${id}`);
        return it;
      }),
      getItemDescription: vi.fn(async () => ({ plain_text: 'Descrição' })),
      getCategory: vi.fn(async () => {
        if (category instanceof Error) throw category;
        return category;
      }),
      getUserProductFamily: vi.fn(async () => {
        if (opts.family instanceof Error) throw opts.family;
        return opts.family ?? { user_products_ids: [] };
      }),
      searchItemsByUserProduct: vi.fn(async () => {
        if (opts.search instanceof Error) throw opts.search;
        return opts.search ?? { results: [] };
      }),
      // #1087 — keyed by MEMBER item id, because under User Products each member
      // is its own listing and carries its own moderation. The key is the full
      // `moderation_reference_id` (`<itemId>-ITM`).
      getLastModeration: vi.fn(async (referenceId: string) => {
        const found = opts.moderations?.[referenceId];
        if (found instanceof Error) throw found;
        return found ?? [];
      }),
    } as unknown as MercadoLivreApi;
  }

  it('imports the family parent + the called member as a child — literal parity ids, denorm, skip-stock', async () => {
    const db = new FakeDb();
    const api = makeUpApi({ items: { [MEMBER_A_ID]: MEMBER_A } });
    const res = await importProduto(deps(db, api), MEMBER_A_ID);

    expect(res.created).toBe(true);
    expect(res.nome).toBe('Camiseta Família');
    expect(res.produtoId).toBe(expectedParentId);
    expect(res.variations).toEqual({ total: 1, created: 1 });
    // no siblings found (default empty family/search) — the fan-out still ran
    // (default familyFanOut) and reported an empty summary.
    expect(res.family).toEqual({ total: 0, imported: 0, created: 0, capped: false, failures: [] });

    // parent: sku falls back to the family id (parity); never gets its own stock.
    expect(db.docs('produtos').get(expectedParentId)).toMatchObject({
      nome: 'Camiseta Família',
      sku: FAMILY_ID,
    });
    expect(db.docs(`produtos/${expectedParentId}/estoques`).size).toBe(0);

    // parent link: literal fixed doc id; `id` field = family id; isUserProductModel stamped.
    const parentLink = db
      .docs(`produtos/${expectedParentId}/produtoMercadoLivre`)
      .get(expectedParentLinkId);
    expect(parentLink).toMatchObject({ id: FAMILY_ID, isUserProductModel: true });

    // parent denorm carries relevantData.isUserProductModel (parity — ProdMarketplace.relevantData).
    const parentUpdate = db.updates.find(
      (u) => u.path === `produtos/${expectedParentId}` && 'marketplace' in u.patch,
    );
    expect(parentUpdate).toBeDefined();
    expect(arrayUnionElements(parentUpdate!.patch.marketplace)[0]).toMatchObject({
      integracaoUid: 'conta-A',
      externalId: FAMILY_ID,
      relevantData: { isUserProductModel: true },
    });

    // child: produto id AND link doc id are the SAME literal fixed-width string.
    const childId = expectedChildId(MEMBER_A_ID);
    expect(db.docs('produtos').get(childId)).toMatchObject({
      paiId: expectedParentId,
      sku: 'SKU-A',
    });
    const childLink = db.docs(`produtos/${childId}/variacaoMercadoLivre`).get(childId);
    expect(childLink).toMatchObject({ itemId: MEMBER_A_ID, id: null });

    // child stock created from the member's own available_quantity.
    const childEstoques = db.docs(`produtos/${childId}/estoques`);
    expect(childEstoques.size).toBe(1);
    expect([...childEstoques.values()][0]).toMatchObject({ quantidade: 5 });

    // child denorm also carries relevantData + externalParentId = family id.
    const childUpdate = db.updates.find(
      (u) => u.path === `produtos/${childId}` && 'marketplace' in u.patch,
    );
    expect(arrayUnionElements(childUpdate!.patch.marketplace)[0]).toMatchObject({
      externalId: MEMBER_A_ID,
      externalParentId: FAMILY_ID,
      relevantData: { isUserProductModel: true },
    });
  });

  it('a second member of the same family resolves the SAME parent via the family-id link', async () => {
    const db = new FakeDb();
    const api = makeUpApi({ items: { [MEMBER_A_ID]: MEMBER_A, [MEMBER_B_ID]: MEMBER_B } });
    const resA = await importProduto(deps(db, api), MEMBER_A_ID);
    const resB = await importProduto(deps(db, api, { familyFanOut: false }), MEMBER_B_ID);

    expect(resB.produtoId).toBe(resA.produtoId);
    expect(db.docs('produtos').get(expectedChildId(MEMBER_B_ID))).toMatchObject({
      paiId: resA.produtoId,
      sku: 'SKU-B',
    });
    // only one parent produto exists (parent + 2 children)
    expect(db.docs('produtos').size).toBe(3);
  });

  it('re-importing the same member is idempotent (zero new docs)', async () => {
    const db = new FakeDb();
    const api = makeUpApi({ items: { [MEMBER_A_ID]: MEMBER_A } });
    await importProduto(deps(db, api), MEMBER_A_ID);
    const countAfterFirst = db.docs('produtos').size;

    const second = await importProduto(deps(db, api, { familyFanOut: false }), MEMBER_A_ID);
    expect(second.created).toBe(false);
    expect(second.variations).toEqual({ total: 1, created: 0 });
    expect(db.docs('produtos').size).toBe(countAfterFirst);
  });

  describe('ML moderations on a family member (#1087)', () => {
    it('a moderated member stamps both its variacaoMercadoLivre link and the family parent link', async () => {
      // Moderation is per ML item, and under User Products a member IS its own
      // listing — so the member's own link records ML's verdict. The family
      // parent takes the SAME value rather than a fold: its `estado`/`status`
      // already come from whichever member was imported, so taking that member's
      // reason too is what keeps the parent internally consistent — one listing,
      // one status, one reason.
      const db = new FakeDb();
      const api = makeUpApi({
        items: {
          [MEMBER_A_ID]: { ...MEMBER_A, status: 'paused', sub_status: ['moderation_penalty'] },
        },
        moderations: { [`${MEMBER_A_ID}-ITM`]: [MODERACAO_ML] },
      });
      const res = await importProduto(deps(db, api), MEMBER_A_ID);

      expect(api.getLastModeration).toHaveBeenCalledWith(`${MEMBER_A_ID}-ITM`);

      const childId = expectedChildId(MEMBER_A_ID);
      expect(db.docs(`produtos/${childId}/variacaoMercadoLivre`).get(childId)).toMatchObject({
        status: 'paused',
        sub_status: ['moderation_penalty'],
        moderacoes: [MODERACAO_GRAVADA],
      });
      expect(
        db.docs(`produtos/${res.produtoId}/produtoMercadoLivre`).get(expectedParentLinkId),
      ).toMatchObject({ status: 'paused', moderacoes: [MODERACAO_GRAVADA] });
    });

    it('a healthy member costs no moderation call and still clears both links', async () => {
      const db = new FakeDb();
      const api = makeUpApi({ items: { [MEMBER_A_ID]: MEMBER_A } });
      const res = await importProduto(deps(db, api), MEMBER_A_ID);

      expect(api.getLastModeration).not.toHaveBeenCalled();
      const childId = expectedChildId(MEMBER_A_ID);
      expect(db.docs(`produtos/${childId}/variacaoMercadoLivre`).get(childId)?.moderacoes).toEqual(
        [],
      );
      expect(
        db.docs(`produtos/${res.produtoId}/produtoMercadoLivre`).get(expectedParentLinkId)
          ?.moderacoes,
      ).toEqual([]);
    });
  });

  describe('family fan-out', () => {
    it('imports the sibling found via the family endpoints, calling the family endpoint exactly once (no recursion)', async () => {
      const db = new FakeDb();
      const api = makeUpApi({
        items: { [MEMBER_A_ID]: MEMBER_A, [MEMBER_B_ID]: MEMBER_B },
        family: { user_products_ids: ['UP-A', 'UP-B'] },
        search: { results: [MEMBER_A_ID, MEMBER_B_ID] }, // echoes the primary — must be filtered out
      });
      const res = await importProduto(deps(db, api), MEMBER_A_ID);

      expect(res.family).toMatchObject({
        total: 1,
        imported: 1,
        created: 1,
        capped: false,
        failures: [],
      });
      // exactly once — a sibling import never re-triggers its own family lookup.
      expect(api.getUserProductFamily).toHaveBeenCalledTimes(1);
      expect(api.getItem).toHaveBeenCalledWith(MEMBER_B_ID);
      expect(db.docs('produtos').get(expectedChildId(MEMBER_B_ID))).toMatchObject({
        sku: 'SKU-B',
      });
    });

    it('a MercadoLivreError resolving the family is best-effort — primary-only import, reflected in the family block', async () => {
      const db = new FakeDb();
      const api = makeUpApi({
        items: { [MEMBER_A_ID]: MEMBER_A },
        family: new MercadoLivreError('family lookup indisponível'),
      });
      const res = await importProduto(deps(db, api), MEMBER_A_ID);

      expect(res.created).toBe(true);
      // resolutionError distinguishes "couldn't ask ML" from a real
      // single-member family (which carries NO resolutionError key).
      expect(res.family).toEqual({
        total: 0,
        imported: 0,
        created: 0,
        capped: false,
        failures: [],
        resolutionError: 'family lookup indisponível',
      });
    });

    it('one sibling failing with MercadoLivreImportError (closed) is recorded; others still succeed', async () => {
      const db = new FakeDb();
      const api = makeUpApi({
        items: {
          [MEMBER_A_ID]: MEMBER_A,
          [MEMBER_B_ID]: { ...MEMBER_B, status: 'closed' },
          [MEMBER_C_ID]: MEMBER_C,
        },
        family: { user_products_ids: ['UP-A', 'UP-B', 'UP-C'] },
        search: { results: [MEMBER_A_ID, MEMBER_B_ID, MEMBER_C_ID] },
      });
      const res = await importProduto(deps(db, api), MEMBER_A_ID);

      expect(res.family?.imported).toBe(1);
      expect(res.family?.created).toBe(1);
      expect(res.family?.failures).toEqual([
        { itemId: MEMBER_B_ID, error: expect.stringContaining('encerrado') },
      ]);
      // the successful sibling (C) still landed its own child produto.
      expect(db.docs('produtos').get(expectedChildId(MEMBER_C_ID))).toMatchObject({
        sku: 'SKU-C',
      });
    });

    it('caps the fan-out and reports the cap when the family has more siblings than the limit', async () => {
      const db = new FakeDb();
      const siblingIds = Array.from({ length: MAX_FAMILY_SIBLINGS + 5 }, (_, i) => `MLBSIB${i}`);
      const api = makeUpApi({
        // Siblings are intentionally NOT fixtured — every attempted one fails
        // best-effort (MercadoLivreError), which is enough to prove the CAP
        // arithmetic without needing 65 real fixtures.
        items: { [MEMBER_A_ID]: MEMBER_A },
        family: { user_products_ids: siblingIds.map((_, i) => `UP-SIB${i}`) },
        search: { results: [MEMBER_A_ID, ...siblingIds] },
      });
      const res = await importProduto(deps(db, api), MEMBER_A_ID);

      expect(res.family?.capped).toBe(true);
      expect(res.family?.total).toBe(MAX_FAMILY_SIBLINGS);
      expect(res.family?.imported).toBe(0);
      expect((res.family?.failures ?? []).length).toBe(MAX_FAMILY_SIBLINGS);
    });
  });

  describe('upParentOverride (#441 — UP migration parent forcing)', () => {
    const LEGACY_PARENT_ID = 'legacy-parent-XYZ';

    it('forces the family parent onto the override produto — no cascade resolution, no duplicate parent at the normal hash id', async () => {
      const db = new FakeDb();
      db.seed('produtos', LEGACY_PARENT_ID, { nome: 'Camiseta Legada', sku: 'OLD-SKU' });
      const api = makeUpApi({ items: { [MEMBER_A_ID]: MEMBER_A } });
      const res = await importProduto(
        deps(db, api, {
          familyFanOut: false,
          upParentOverride: { produtoId: LEGACY_PARENT_ID },
        }),
        MEMBER_A_ID,
      );

      expect(res.produtoId).toBe(LEGACY_PARENT_ID);
      expect(res.created).toBe(false); // the override produto already existed (the OLD legacy parent)

      // the family PML link mints UNDER the override produto, literal fixed doc id.
      const link = db
        .docs(`produtos/${LEGACY_PARENT_ID}/produtoMercadoLivre`)
        .get(expectedParentLinkId);
      expect(link).toMatchObject({ id: FAMILY_ID, isUserProductModel: true });

      // no separate family parent minted at the normal deterministic-hash id.
      expect(db.docs('produtos').has(expectedParentId)).toBe(false);

      // the called member's own child still lands correctly, parented on the override.
      const childId = expectedChildId(MEMBER_A_ID);
      expect(db.docs('produtos').get(childId)).toMatchObject({
        paiId: LEGACY_PARENT_ID,
        sku: 'SKU-A',
      });
    });

    it('reuses an EXISTING family PML link already under the override produto (linkDocId + raw spread) instead of a fresh mint', async () => {
      const db = new FakeDb();
      db.seed('produtos', LEGACY_PARENT_ID, { nome: 'Camiseta Legada', sku: 'OLD-SKU' });
      db.seed(`produtos/${LEGACY_PARENT_ID}/produtoMercadoLivre`, 'pre-existing-link-id', {
        id: FAMILY_ID,
        contaOuterRef: 'documents/integracao/conta-A',
        someLegacyField: 'preserved',
      });
      const api = makeUpApi({ items: { [MEMBER_A_ID]: MEMBER_A } });
      const res = await importProduto(
        deps(db, api, {
          familyFanOut: false,
          upParentOverride: { produtoId: LEGACY_PARENT_ID },
        }),
        MEMBER_A_ID,
      );

      expect(res.produtoId).toBe(LEGACY_PARENT_ID);
      // the existing link doc is reused (spread-existing) — no second link doc.
      expect(db.docs(`produtos/${LEGACY_PARENT_ID}/produtoMercadoLivre`).size).toBe(1);
      const link = db
        .docs(`produtos/${LEGACY_PARENT_ID}/produtoMercadoLivre`)
        .get('pre-existing-link-id');
      expect(link).toMatchObject({
        id: FAMILY_ID,
        someLegacyField: 'preserved',
        isUserProductModel: true,
      });
    });

    it('a link under the override produto belonging to a DIFFERENT integração is ignored — a fresh link mints instead', async () => {
      const db = new FakeDb();
      db.seed('produtos', LEGACY_PARENT_ID, { nome: 'Camiseta Legada', sku: 'OLD-SKU' });
      db.seed(`produtos/${LEGACY_PARENT_ID}/produtoMercadoLivre`, 'other-account-link', {
        id: FAMILY_ID,
        contaOuterRef: 'documents/integracao/conta-OUTRA',
      });
      const api = makeUpApi({ items: { [MEMBER_A_ID]: MEMBER_A } });
      const res = await importProduto(
        deps(db, api, {
          familyFanOut: false,
          upParentOverride: { produtoId: LEGACY_PARENT_ID },
        }),
        MEMBER_A_ID,
      );

      expect(res.produtoId).toBe(LEGACY_PARENT_ID);
      // the foreign-account link survives untouched, AND our own fresh link mints
      // at the literal fixed doc id — two links total under the override produto.
      expect(db.docs(`produtos/${LEGACY_PARENT_ID}/produtoMercadoLivre`).size).toBe(2);
      const ownLink = db
        .docs(`produtos/${LEGACY_PARENT_ID}/produtoMercadoLivre`)
        .get(expectedParentLinkId);
      expect(ownLink).toMatchObject({
        id: FAMILY_ID,
        contaOuterRef: 'documents/integracao/conta-A',
      });
    });

    it('override absent → resolution is byte-identical to the pre-existing cascade (regression pin)', async () => {
      const db = new FakeDb();
      const api = makeUpApi({ items: { [MEMBER_A_ID]: MEMBER_A } });
      const res = await importProduto(deps(db, api, { familyFanOut: false }), MEMBER_A_ID);

      // same literal parity id as the dedicated cascade test earlier in this
      // file — proves `upParentOverride` is fully inert when omitted.
      expect(res.produtoId).toBe(expectedParentId);
      expect(res.created).toBe(true);
    });
  });

  describe('ERP-first family children (#801)', () => {
    const fake = (grupoId: string, varianteId: string) =>
      `documents/grupoDeVariacoes/${grupoId}/variacoes/${varianteId}`;

    /** The ERP taxonomy the members' SIZE combos resolve ONTO (grupo by id, variante by value_id). */
    function seedTaxonomia(db: FakeDb): void {
      db.seed('grupoDeVariacoes', 'SIZE', {
        nome: 'Tamanho',
        tipo: 1,
        ordem: 1,
        variacoesIds: ['10', '11'],
        variacoes: [
          { id: '10', nome: 'G', codigo: null, variantesVinculadasIds: null, timestamp: 1 },
          { id: '11', nome: 'M', codigo: null, variantesVinculadasIds: null, timestamp: 1 },
        ],
      });
    }

    /**
     * User-Products imports one member per `importVariationChildren` call, so the
     * "don't claim a child twice" guard cannot be a per-call set — it has to be the
     * per-candidate link check. Two members, imported through the family fan-out,
     * must land on their OWN pre-existing ERP child.
     */
    it('each member reuses its own ERP child across separate calls, and never steals a sibling’s', async () => {
      const db = new FakeDb();
      seedTaxonomia(db);
      db.seed('produtos', expectedParentId, { nome: 'Camiseta Família', sku: 'ERP-PAI' });
      db.seed('produtos', 'erp-filho-G', {
        nome: 'Camiseta G',
        sku: 'ERP-G',
        paiId: expectedParentId,
        variacoesUid: [fake('SIZE', '10')],
      });
      db.seed('produtos', 'erp-filho-M', {
        nome: 'Camiseta M',
        sku: 'ERP-M',
        paiId: expectedParentId,
        variacoesUid: [fake('SIZE', '11')],
      });

      const api = makeUpApi({
        items: { [MEMBER_A_ID]: MEMBER_A, [MEMBER_B_ID]: MEMBER_B },
        family: { user_products_ids: ['UP-A', 'UP-B'] },
        search: { results: [MEMBER_A_ID, MEMBER_B_ID] },
      });
      const res = await importProduto(deps(db, api), MEMBER_A_ID);

      expect(res.produtoId).toBe(expectedParentId);
      expect(res.variations).toEqual({ total: 1, created: 0 });
      // parent + the two ERP children — the fan-out imported B onto the other one,
      // rather than minting a fixed-width child for either member.
      expect(db.docs('produtos').size).toBe(3);
      expect(db.docs('produtos').has(expectedChildId(MEMBER_A_ID))).toBe(false);
      expect(db.docs('produtos').has(expectedChildId(MEMBER_B_ID))).toBe(false);

      // Each child holds exactly one link, naming ITS OWN member.
      const linkItemId = (childId: string) => {
        const links = db.docs(`produtos/${childId}/variacaoMercadoLivre`);
        expect(links.size).toBe(1);
        return ([...links.values()][0] as DocData).itemId;
      };
      expect(linkItemId('erp-filho-G')).toBe(MEMBER_A_ID);
      expect(linkItemId('erp-filho-M')).toBe(MEMBER_B_ID);
    });

    it('a member whose combination collides with an already-linked child mints instead of merging', async () => {
      const db = new FakeDb();
      seedTaxonomia(db);
      db.seed('produtos', expectedParentId, { nome: 'Camiseta Família', sku: 'ERP-PAI' });
      // ONE ERP child, already linked to member B, but carrying member A's combo.
      db.seed('produtos', 'erp-filho-G', {
        nome: 'Camiseta G',
        sku: 'ERP-G',
        paiId: expectedParentId,
        variacoesUid: [fake('SIZE', '10')],
      });
      db.seed('produtos/erp-filho-G/variacaoMercadoLivre', 'link-B', {
        itemId: MEMBER_B_ID,
        produtoMercadoLivreOuterRef: `documents/produtos/${expectedParentId}/produtoMercadoLivre/${expectedParentLinkId}`,
      });

      const api = makeUpApi({ items: { [MEMBER_A_ID]: MEMBER_A } });
      const res = await importProduto(deps(db, api, { familyFanOut: false }), MEMBER_A_ID);

      expect(res.variations).toEqual({ total: 1, created: 1 });
      expect(db.docs('produtos').has(expectedChildId(MEMBER_A_ID))).toBe(true);
      expect([...db.docs('produtos/erp-filho-G/variacaoMercadoLivre').keys()]).toEqual(['link-B']);
    });
  });
});
