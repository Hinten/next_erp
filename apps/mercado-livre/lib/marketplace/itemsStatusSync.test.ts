import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
} from '@delfrance/integrations-mercado-livre';

import { type ItemsApiResolver, type ItemsSyncApi, syncItemStatus } from './itemsStatusSync';
import { parseItemIdFromResource } from './linkRefs';

/* ------------------------------ fake Firestore ---------------------------- */
// Doc get/set(merge)/update, chained where/get, a collectionGroup query (docs
// carry `ref.parent.parent.id` = the owning produto). Mirrors import.test.ts.

type DocData = Record<string, unknown>;

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly updates: Array<{ path: string; patch: DocData }> = [];
  /** Fault injection: `${path}/${id}` → remaining `update()` throws (transient). */
  readonly failUpdates = new Map<string, number>();

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }
  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  docData(path: string, id: string): DocData | undefined {
    return this.col(path).get(id);
  }

  private query(entries: Array<[string, DocData, string]>) {
    const clauses: Array<[string, unknown]> = [];
    const q = {
      where(field: string, _op: string, value: unknown) {
        clauses.push([field, value]);
        return q;
      },
      async get() {
        const rows = entries.filter(([, d]) => clauses.every(([f, v]) => d[f] === v));
        return {
          docs: rows.map(([id, d, colPath]) => ({
            id,
            data: () => d,
            exists: true,
            ref: { parent: { parent: { id: parentDocId(colPath) } } },
          })),
          empty: rows.length === 0,
        };
      },
    };
    return q;
  }

  collection(path: string) {
    const col = this.col(path);
    const self = this;
    return {
      doc: (id: string) => ({
        id,
        get: async () => ({ exists: col.has(id), id, data: () => col.get(id) }),
        set: async (data: DocData, opts?: { merge?: boolean }) => {
          col.set(id, opts?.merge ? { ...(col.get(id) ?? {}), ...data } : { ...data });
        },
        update: async (patch: DocData) => {
          const full = `${path}/${id}`;
          const fails = self.failUpdates.get(full) ?? 0;
          if (fails > 0) {
            self.failUpdates.set(full, fails - 1);
            throw Object.assign(new Error('firestore unavailable'), { code: 14 });
          }
          // Admin `update()` rejects NOT_FOUND on a missing doc (never creates it).
          if (!col.has(id)) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
          self.updates.push({ path: full, patch });
          col.set(id, { ...(col.get(id) ?? {}), ...patch });
        },
      }),
    };
  }

  collectionGroup(groupId: string) {
    const entries: Array<[string, DocData, string]> = [];
    for (const [path, col] of this.cols) {
      if (path.split('/').pop() === groupId) for (const [id, d] of col) entries.push([id, d, path]);
    }
    return this.query(entries);
  }
}

function parentDocId(colPath: string): string {
  const segs = colPath.split('/').filter(Boolean);
  return segs[segs.length - 2] ?? '';
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* --------------------------------- fixtures ------------------------------- */

const CONTA = 'conta-A';
const PRODUTO = 'prod1';
const LINK_PATH = `produtos/${PRODUTO}/produtoMercadoLivre`;
const ITEM = 'MLB123';

function api(item: DocData): ItemsSyncApi {
  return { getItem: vi.fn(async () => item) } as unknown as ItemsSyncApi;
}
function failingApi(err: Error): ItemsSyncApi {
  return {
    getItem: vi.fn(async () => {
      throw err;
    }),
  } as unknown as ItemsSyncApi;
}
/** A lazy resolver that yields a fake API returning `item` (link-first contract). */
function resolverFor(item: DocData): ItemsApiResolver {
  return vi.fn(async () => api(item));
}
function failingResolver(err: Error): ItemsApiResolver {
  return vi.fn(async () => failingApi(err));
}

/** Seed a linked produto + its `produtoMercadoLivre` link doc. */
function seedLink(db: FakeDb, link: DocData = {}, produto: DocData = {}): void {
  db.seed('produtos', PRODUTO, {
    nome: 'Camiseta',
    marketplace: [{ integracaoUid: CONTA, externalId: ITEM }],
    marketplaceIds: [ITEM],
    integracoesComProduto: [CONTA],
    ...produto,
  });
  db.seed(LINK_PATH, 'link1', {
    id: ITEM,
    contaOuterRef: `documents/integracao/${CONTA}`,
    title: 'Camiseta',
    estado: 'p',
    status: 'active',
    sub_status: null,
    isUserProductModel: false,
    ...link,
  });
}

beforeEach(() => vi.restoreAllMocks());

/* ----------------------------------- tests -------------------------------- */

describe('parseItemIdFromResource', () => {
  it('extracts the id from a well-formed items resource', () => {
    expect(parseItemIdFromResource('/items/MLB123')).toBe('MLB123');
    expect(parseItemIdFromResource('/items/MLB123/')).toBe('MLB123'); // trailing slash
  });
  it('returns null for a bare collection resource (no id)', () => {
    expect(parseItemIdFromResource('/items')).toBeNull();
    expect(parseItemIdFromResource('items')).toBeNull();
    expect(parseItemIdFromResource('/')).toBeNull();
    expect(parseItemIdFromResource('')).toBeNull();
  });
});

describe('syncItemStatus — resolution (link-first)', () => {
  it('no linked produto → no-op WITHOUT an ML call', async () => {
    const db = new FakeDb();
    const resolve = resolverFor({ status: 'paused' });
    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolve);
    expect(out).toBe('no-link');
    expect(db.updates).toEqual([]);
    expect(resolve).not.toHaveBeenCalled(); // link-first: no external call for an unlinked item
  });

  it('ignores a link owned by another account (no ML call)', async () => {
    const db = new FakeDb();
    seedLink(db, { contaOuterRef: 'documents/integracao/outra-conta' });
    const resolve = resolverFor({ status: 'paused' });
    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolve);
    expect(out).toBe('no-link');
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('syncItemStatus — link sync', () => {
  it('active → paused: syncs estado + raw status/sub_status + ensures parent denorm', async () => {
    const db = new FakeDb();
    seedLink(db);
    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'paused', sub_status: ['out_of_stock'] }),
    );
    expect(out).toBe('synced');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({
      estado: 'pa',
      status: 'paused',
      sub_status: ['out_of_stock'],
    });
    // estado changed → non-cancel ensure-present (idempotent arrayUnion).
    const denorm = db.updates.find((u) => u.path === `produtos/${PRODUTO}`);
    expect(denorm).toBeDefined();
    expect((denorm!.patch.marketplaceIds as FieldValue).isEqual(FieldValue.arrayUnion(ITEM))).toBe(
      true,
    );
    expect(
      (denorm!.patch.integracoesComProduto as FieldValue).isEqual(FieldValue.arrayUnion(CONTA)),
    ).toBe(true);
  });

  it('sub_status-only change (estado unchanged): syncs raw fields, NO parent denorm write', async () => {
    const db = new FakeDb();
    seedLink(db, { status: 'active', sub_status: null });
    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'active', sub_status: ['catalog_boost_opportunity'] }),
    );
    expect(out).toBe('synced');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({
      estado: 'p',
      sub_status: ['catalog_boost_opportunity'],
    });
    // estado did not change → parent arrays untouched.
    expect(db.updates.find((u) => u.path === `produtos/${PRODUTO}`)).toBeUndefined();
  });

  it('no change at all → unchanged (idempotent, no write)', async () => {
    const db = new FakeDb();
    seedLink(db, { status: 'active', sub_status: ['x'] });
    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'active', sub_status: ['x'] }),
    );
    expect(out).toBe('unchanged');
    expect(db.updates).toEqual([]);
    // link doc untouched.
    expect(db.docData(LINK_PATH, 'link1')).not.toHaveProperty('ultimaModificacao');
  });
});

describe('syncItemStatus — cancel (closed)', () => {
  it('closed → estado cancelado + key-based denorm removal', async () => {
    const db = new FakeDb();
    seedLink(db);
    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolverFor({ status: 'closed' }));
    expect(out).toBe('synced');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'c', status: 'closed' });
    // Parent denorm entry for this listing removed (plain arrays, not arrayRemove).
    expect(db.docData('produtos', PRODUTO)).toMatchObject({
      marketplace: [],
      marketplaceIds: [],
      integracoesComProduto: [],
    });
  });

  it('cancel keeps the integração when another listing of it remains', async () => {
    const db = new FakeDb();
    seedLink(
      db,
      {},
      {
        marketplace: [
          { integracaoUid: CONTA, externalId: ITEM },
          { integracaoUid: CONTA, externalId: 'MLB999' },
        ],
        marketplaceIds: [ITEM, 'MLB999'],
        integracoesComProduto: [CONTA],
      },
    );
    await syncItemStatus(asDb(db), CONTA, ITEM, resolverFor({ status: 'closed' }));
    expect(db.docData('produtos', PRODUTO)).toMatchObject({
      marketplace: [{ integracaoUid: CONTA, externalId: 'MLB999' }],
      marketplaceIds: ['MLB999'],
      integracoesComProduto: [CONTA], // still has MLB999
    });
  });
});

describe('syncItemStatus — partial-failure recovery (denorm-first ordering)', () => {
  it('cancel: denorm write fails, then a retry reconciles — the link never advances ahead of the denorm', async () => {
    const db = new FakeDb();
    seedLink(db);
    db.failUpdates.set(`produtos/${PRODUTO}`, 1); // parent denorm update throws once

    // Attempt 1: denorm runs FIRST and throws → the whole sync throws and, crucially,
    // the link estado is NOT advanced (so a retry still sees a change to reconcile).
    await expect(
      syncItemStatus(asDb(db), CONTA, ITEM, resolverFor({ status: 'closed' })),
    ).rejects.toThrow(/unavailable/);
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'p' }); // NOT 'c'
    expect(db.docData('produtos', PRODUTO)).toMatchObject({
      marketplace: [{ integracaoUid: CONTA, externalId: ITEM }], // entry still present
    });

    // Retry: the denorm update succeeds → both the parent and the link reconcile.
    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolverFor({ status: 'closed' }));
    expect(out).toBe('synced');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'c' });
    expect(db.docData('produtos', PRODUTO)).toMatchObject({
      marketplace: [],
      marketplaceIds: [],
      integracoesComProduto: [],
    });
  });

  it('non-cancel reactivation: denorm write fails, then a retry reconciles (link not advanced)', async () => {
    const db = new FakeDb();
    seedLink(db, { estado: 'pa', status: 'paused' });
    db.failUpdates.set(`produtos/${PRODUTO}`, 1);

    await expect(
      syncItemStatus(asDb(db), CONTA, ITEM, resolverFor({ status: 'active' })),
    ).rejects.toThrow(/unavailable/);
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'pa' }); // not advanced to 'p'

    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolverFor({ status: 'active' }));
    expect(out).toBe('synced');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'p' });
  });

  it('orphan link (parent produto missing) → link still synced, no throw, no parent write', async () => {
    const db = new FakeDb();
    // Seed ONLY the link doc — the parent produto is gone (delete-cascade window).
    db.seed(LINK_PATH, 'link1', {
      id: ITEM,
      contaOuterRef: `documents/integracao/${CONTA}`,
      title: 'Camiseta',
      estado: 'p',
      status: 'active',
      sub_status: null,
      isUserProductModel: false,
    });
    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolverFor({ status: 'paused' }));
    expect(out).toBe('synced'); // guarded — no NOT_FOUND throw on the missing parent
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'pa' });
    expect(db.docData('produtos', PRODUTO)).toBeUndefined(); // never resurrected
  });
});

describe('syncItemStatus — deferred UP / migration (#441)', () => {
  it('User-Products link → deferred WITHOUT an ML call (cheap link-only guard)', async () => {
    const db = new FakeDb();
    seedLink(db, { isUserProductModel: true });
    const resolve = resolverFor({ status: 'paused' });
    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolve);
    expect(out).toBe('deferred-up');
    expect(db.updates).toEqual([]);
    expect(resolve).not.toHaveBeenCalled(); // skipped before any ML fetch
  });

  it('link awaiting migration (estado "am") → deferred without an ML call', async () => {
    const db = new FakeDb();
    seedLink(db, { estado: 'am' });
    const resolve = resolverFor({ status: 'active' });
    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolve);
    expect(out).toBe('deferred-up');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('migration-tagged item → deferred (needs the fetched item, so the ML call DOES run)', async () => {
    const db = new FakeDb();
    seedLink(db);
    const resolve = resolverFor({ status: 'closed', tags: ['variations_migration_source'] });
    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolve);
    expect(out).toBe('deferred-up');
    expect(resolve).toHaveBeenCalled(); // the tag is only visible after fetching
    expect(db.updates).toEqual([]);
  });
});

describe('syncItemStatus — transport errors', () => {
  it('404 (deleted listing) → item-gone, no throw', async () => {
    const db = new FakeDb();
    seedLink(db);
    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      failingResolver(new MercadoLivreHttpError('ML 404', 404, null)),
    );
    expect(out).toBe('item-gone');
    expect(db.updates).toEqual([]);
  });

  it('5xx → throws (queue/sweep retry)', async () => {
    const db = new FakeDb();
    seedLink(db);
    await expect(
      syncItemStatus(
        asDb(db),
        CONTA,
        ITEM,
        failingResolver(new MercadoLivreHttpError('ML 500', 500, null)),
      ),
    ).rejects.toThrow(MercadoLivreHttpError);
  });

  it('network failure → throws', async () => {
    const db = new FakeDb();
    seedLink(db);
    await expect(
      syncItemStatus(
        asDb(db),
        CONTA,
        ITEM,
        failingResolver(new MercadoLivreNetworkError('offline')),
      ),
    ).rejects.toThrow(MercadoLivreNetworkError);
  });
});
