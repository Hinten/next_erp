import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  type MlItemPrices,
  type MlItemPricesEntry,
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
} from '@delfrance/integrations-mercado-livre';

import {
  type ItemsPricesContextResolver,
  type ItemsPricesSyncContext,
  selectMarketplacePrices,
  syncItemPrices,
} from './itemsPricesSync';
import { parseItemIdFromPricesResource } from './linkRefs';

/* ------------------------------ fake Firestore ---------------------------- */
// Doc get/set(merge)/update, chained where/limit/get, a collectionGroup query
// (docs carry `ref.parent.parent.id` = the owning produto). Mirrors
// itemsStatusSync.test.ts, plus `limit()` for the variacao link scan and
// `batch()` for the atomic produto-update + link-denorm commit.

type DocData = Record<string, unknown>;

interface FakeDocRef {
  update(patch: DocData): Promise<void>;
  set(data: DocData, opts?: { merge?: boolean }): Promise<void>;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly updates: Array<{ path: string; patch: DocData }> = [];

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
    let limitN: number | null = null;
    const q = {
      where(field: string, _op: string, value: unknown) {
        clauses.push([field, value]);
        return q;
      },
      limit(n: number) {
        limitN = n;
        return q;
      },
      async get() {
        let rows = entries.filter(([, d]) => clauses.every(([f, v]) => d[f] === v));
        if (limitN != null) rows = rows.slice(0, limitN);
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
          // Admin `update()` rejects NOT_FOUND on a missing doc (never creates it).
          if (!col.has(id)) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
          self.updates.push({ path: `${path}/${id}`, patch });
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

  /** Ops queue until `commit()` — enough to assert the single-commit contract. */
  batch() {
    const ops: Array<() => Promise<void>> = [];
    return {
      update(ref: FakeDocRef, patch: DocData) {
        ops.push(() => ref.update(patch));
        return this;
      },
      set(ref: FakeDocRef, data: DocData, opts?: { merge?: boolean }) {
        ops.push(() => ref.set(data, opts));
        return this;
      },
      async commit() {
        for (const op of ops) await op();
      },
    };
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
const CHILD = 'child1';
const LINK_PATH = `produtos/${PRODUTO}/produtoMercadoLivre`;
const VAR_LINK_PATH = `produtos/${CHILD}/variacaoMercadoLivre`;
const PML_REF = `documents/produtos/${PRODUTO}/produtoMercadoLivre/link1`;
const ITEM = 'MLB123';
const TAB_NORMAL = 'tabNormal';
const TAB_PROMO = 'tabPromo';

/** Fixed clock for the promo-window checks and the link stamp. */
const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const PAST = '2026-07-01T00:00:00.000Z';
const FUTURE = '2026-12-01T00:00:00.000Z';

function stdEntry(amount: number, over: Partial<MlItemPricesEntry> = {}): MlItemPricesEntry {
  return { id: 'std1', type: 'standard', amount, conditions: null, ...over } as MlItemPricesEntry;
}
function promoEntry(amount: number, over: Partial<MlItemPricesEntry> = {}): MlItemPricesEntry {
  return {
    id: 'promo1',
    type: 'promotion',
    amount,
    conditions: { context_restrictions: null, start_time: PAST, end_time: FUTURE },
    ...over,
  } as MlItemPricesEntry;
}

/** A lazy context resolver yielding a fake API returning `prices` (link-first contract). */
function ctxFor(
  prices: MlItemPricesEntry[],
  over: Partial<ItemsPricesSyncContext> = {},
): ItemsPricesContextResolver {
  return vi.fn(async () => ({
    api: { getPrices: vi.fn(async () => ({ id: ITEM, prices }) as MlItemPrices) },
    tabelaNormalOuterRef: `documents/listaDePrecos/${TAB_NORMAL}`,
    tabelaPromocionalOuterRef: `documents/listaDePrecos/${TAB_PROMO}`,
    ...over,
  }));
}
function failingCtx(err: Error): ItemsPricesContextResolver {
  return vi.fn(async () => ({
    api: {
      getPrices: vi.fn(async () => {
        throw err;
      }),
    },
    tabelaNormalOuterRef: `documents/listaDePrecos/${TAB_NORMAL}`,
    tabelaPromocionalOuterRef: `documents/listaDePrecos/${TAB_PROMO}`,
  }));
}

/** Seed a linked produto + its `produtoMercadoLivre` link doc (link mode). */
function seedLink(db: FakeDb, produto: DocData = {}, link: DocData = {}): void {
  db.seed('produtos', PRODUTO, {
    nome: 'Camiseta',
    precos: { [TAB_NORMAL]: { valor: 100 } },
    ...produto,
  });
  db.seed(LINK_PATH, 'link1', {
    id: ITEM,
    contaOuterRef: `documents/integracao/${CONTA}`,
    precoPublicado: 100,
    ...link,
  });
}

/** Seed a variation child link whose family PML belongs to `pmlConta`. */
function seedVariation(db: FakeDb, pmlConta: string = CONTA): void {
  db.seed('produtos', PRODUTO, { nome: 'Pai' });
  db.seed(LINK_PATH, 'link1', {
    id: 'MLB-FAMILY',
    contaOuterRef: `documents/integracao/${pmlConta}`,
  });
  db.seed('produtos', CHILD, { nome: 'Filho', precos: { [TAB_NORMAL]: { valor: 10 } } });
  db.seed(VAR_LINK_PATH, 'var1', { itemId: ITEM, id: 111, produtoMercadoLivreOuterRef: PML_REF });
}

beforeEach(() => vi.restoreAllMocks());

/* ----------------------------------- tests -------------------------------- */

describe('parseItemIdFromPricesResource', () => {
  it('extracts the id from a well-formed items_prices resource', () => {
    expect(parseItemIdFromPricesResource('/items/MLB123/prices')).toBe('MLB123');
    expect(parseItemIdFromPricesResource('/items/MLB123/prices/')).toBe('MLB123'); // trailing slash
  });
  it('returns null when the `prices` suffix is absent (an `items` resource)', () => {
    expect(parseItemIdFromPricesResource('/items/MLB123')).toBeNull();
    expect(parseItemIdFromPricesResource('/items/X')).toBeNull();
  });
  it('returns null for garbage / segment-starved resources', () => {
    expect(parseItemIdFromPricesResource('garbage')).toBeNull();
    expect(parseItemIdFromPricesResource('/prices')).toBeNull(); // no id segment
    expect(parseItemIdFromPricesResource('/')).toBeNull();
    expect(parseItemIdFromPricesResource('')).toBeNull();
  });
});

describe('selectMarketplacePrices', () => {
  it('standard only → normal set, promo null', () => {
    expect(selectMarketplacePrices([stdEntry(45.9)], NOW)).toEqual({ normal: 45.9, promo: null });
  });

  it('standard + active marketplace-restricted promo → both', () => {
    const out = selectMarketplacePrices(
      [
        stdEntry(45.9),
        promoEntry(39.9, {
          conditions: {
            context_restrictions: ['channel_marketplace'],
            start_time: PAST,
            end_time: FUTURE,
          },
        }),
      ],
      NOW,
    );
    expect(out).toEqual({ normal: 45.9, promo: 39.9 });
  });

  it('expired promo → promo null', () => {
    const out = selectMarketplacePrices(
      [
        stdEntry(45.9),
        promoEntry(39.9, {
          conditions: {
            context_restrictions: null,
            start_time: PAST,
            end_time: '2026-07-10T00:00:00.000Z',
          },
        }),
      ],
      NOW,
    );
    expect(out).toEqual({ normal: 45.9, promo: null });
  });

  it('not-yet-started promo → promo null', () => {
    const out = selectMarketplacePrices(
      [
        stdEntry(45.9),
        promoEntry(39.9, {
          conditions: {
            context_restrictions: null,
            start_time: '2026-08-01T00:00:00.000Z',
            end_time: FUTURE,
          },
        }),
      ],
      NOW,
    );
    expect(out).toEqual({ normal: 45.9, promo: null });
  });

  it('mshops-restricted standard is ignored in favor of the unrestricted one', () => {
    const out = selectMarketplacePrices(
      [stdEntry(50, { conditions: { context_restrictions: ['channel_mshops'] } }), stdEntry(45.9)],
      NOW,
    );
    expect(out).toEqual({ normal: 45.9, promo: null });
  });

  it('no standard entry and no regular_amount → normal null even when promos exist', () => {
    expect(selectMarketplacePrices([promoEntry(39.9)], NOW)).toEqual({ normal: null, promo: 39.9 });
  });

  it('promo-only payload falls back to the promo regular_amount for normal (legacy parity)', () => {
    expect(selectMarketplacePrices([promoEntry(39.9, { regular_amount: 49.9 })], NOW)).toEqual({
      normal: 49.9,
      promo: 39.9,
    });
  });

  it('non-positive amounts are ignored (precoSchema forbids valor <= 0)', () => {
    expect(
      selectMarketplacePrices([stdEntry(0), stdEntry(-5), stdEntry(45.9), promoEntry(0)], NOW),
    ).toEqual({ normal: 45.9, promo: null });
  });

  it('a null conditions bag participates (unrestricted, unbounded)', () => {
    const out = selectMarketplacePrices(
      [
        stdEntry(45.9, {
          conditions: { context_restrictions: null, start_time: null, end_time: null },
        }),
      ],
      NOW,
    );
    expect(out).toEqual({ normal: 45.9, promo: null });
  });

  it('garbage start_time → promo never applies (NaN fails the bound)', () => {
    const out = selectMarketplacePrices(
      [
        stdEntry(45.9),
        promoEntry(39.9, {
          conditions: { context_restrictions: null, start_time: 'not-a-date', end_time: FUTURE },
        }),
      ],
      NOW,
    );
    expect(out).toEqual({ normal: 45.9, promo: null });
  });

  it('amounts come back roundReais-rounded', () => {
    expect(selectMarketplacePrices([stdEntry(45.906), promoEntry(39.994)], NOW)).toEqual({
      normal: 45.91,
      promo: 39.99,
    });
  });
});

describe('syncItemPrices — resolution (link-first)', () => {
  it('no linked produto at all → no-link WITHOUT resolving the context', async () => {
    const db = new FakeDb();
    const resolveContext = ctxFor([stdEntry(45.9)]);
    const out = await syncItemPrices(asDb(db), CONTA, ITEM, { resolveContext, now: () => NOW });
    expect(out).toBe('no-link');
    expect(db.updates).toEqual([]);
    expect(resolveContext).not.toHaveBeenCalled(); // link-first: no ML work for an unlinked item
  });

  it('variation link whose family PML belongs to another account → no-link', async () => {
    const db = new FakeDb();
    seedVariation(db, 'outra-conta');
    const resolveContext = ctxFor([stdEntry(45.9)]);
    const out = await syncItemPrices(asDb(db), CONTA, ITEM, { resolveContext, now: () => NOW });
    expect(out).toBe('no-link');
    expect(resolveContext).not.toHaveBeenCalled();
  });

  it('orphan link (parent produto missing) → no-link, nothing written', async () => {
    const db = new FakeDb();
    // Seed ONLY the link doc — the parent produto is gone (delete-cascade window).
    db.seed(LINK_PATH, 'link1', { id: ITEM, contaOuterRef: `documents/integracao/${CONTA}` });
    const out = await syncItemPrices(asDb(db), CONTA, ITEM, {
      resolveContext: ctxFor([stdEntry(45.9)]),
      now: () => NOW,
    });
    expect(out).toBe('no-link');
    expect(db.updates).toEqual([]);
    expect(db.docData('produtos', PRODUTO)).toBeUndefined(); // never resurrected
  });
});

describe('syncItemPrices — link mode', () => {
  it('happy path: dotted normal+promo writes + link precoPublicado denorm', async () => {
    const db = new FakeDb();
    seedLink(db);
    const out = await syncItemPrices(asDb(db), CONTA, ITEM, {
      resolveContext: ctxFor([stdEntry(45.9), promoEntry(39.9)]),
      now: () => NOW,
    });
    expect(out).toBe('synced');
    const upd = db.updates.find((u) => u.path === `produtos/${PRODUTO}`);
    expect(upd).toBeDefined();
    expect(upd!.patch).toEqual({
      [`precos.${TAB_NORMAL}`]: { valor: 45.9 },
      [`precos.${TAB_PROMO}`]: { valor: 39.9 },
    });
    // Link denorm: promo wins (firstNonEmpty semantics) + the modification stamp.
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({
      precoPublicado: 39.9,
      ultimaModificacao: NOW,
    });
  });

  it('promo gone on ML → the promo key is actively DELETED, precoPublicado falls back to normal', async () => {
    const db = new FakeDb();
    seedLink(db, { precos: { [TAB_NORMAL]: { valor: 45.9 }, [TAB_PROMO]: { valor: 39.9 } } });
    const out = await syncItemPrices(asDb(db), CONTA, ITEM, {
      resolveContext: ctxFor([stdEntry(45.9)]), // no promotion entry anymore
      now: () => NOW,
    });
    expect(out).toBe('synced');
    const upd = db.updates.find((u) => u.path === `produtos/${PRODUTO}`);
    expect(upd).toBeDefined();
    expect(upd!.patch[`precos.${TAB_NORMAL}`]).toEqual({ valor: 45.9 });
    expect((upd!.patch[`precos.${TAB_PROMO}`] as FieldValue).isEqual(FieldValue.delete())).toBe(
      true,
    );
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ precoPublicado: 45.9 });
  });

  it('everything already equal → unchanged, ZERO writes (redelivery / own-PUT echo)', async () => {
    const db = new FakeDb();
    seedLink(db, { precos: { [TAB_NORMAL]: { valor: 45.9 }, [TAB_PROMO]: { valor: 39.9 } } });
    const out = await syncItemPrices(asDb(db), CONTA, ITEM, {
      resolveContext: ctxFor([stdEntry(45.9), promoEntry(39.9)]),
      now: () => NOW,
    });
    expect(out).toBe('unchanged');
    expect(db.updates).toEqual([]);
    // link doc untouched.
    expect(db.docData(LINK_PATH, 'link1')).not.toHaveProperty('ultimaModificacao');
  });

  it('no promo on ML and none stored → unchanged too (promo absence compares equal)', async () => {
    const db = new FakeDb();
    seedLink(db, { precos: { [TAB_NORMAL]: { valor: 45.9 } } });
    const out = await syncItemPrices(asDb(db), CONTA, ITEM, {
      resolveContext: ctxFor([stdEntry(45.9)]),
      now: () => NOW,
    });
    expect(out).toBe('unchanged');
    expect(db.updates).toEqual([]);
  });

  it('promo table colliding with the normal table is treated as none configured', async () => {
    const db = new FakeDb();
    seedLink(db);
    const collide = { tabelaPromocionalOuterRef: `documents/listaDePrecos/${TAB_NORMAL}` };
    const out = await syncItemPrices(asDb(db), CONTA, ITEM, {
      resolveContext: ctxFor([stdEntry(45.9)], collide),
      now: () => NOW,
    });
    expect(out).toBe('synced');
    const upd = db.updates.find((u) => u.path === `produtos/${PRODUTO}`);
    // ONE key only — no FieldValue.delete clobbering the normal write.
    expect(upd!.patch).toEqual({ [`precos.${TAB_NORMAL}`]: { valor: 45.9 } });

    // And a redelivery with the value now stored is 'unchanged', not a rewrite loop.
    const again = await syncItemPrices(asDb(db), CONTA, ITEM, {
      resolveContext: ctxFor([stdEntry(45.9)], collide),
      now: () => NOW,
    });
    expect(again).toBe('unchanged');
  });
});

describe('syncItemPrices — variation mode', () => {
  it('writes the CHILD produto precos and does NOT touch precoPublicado', async () => {
    const db = new FakeDb();
    seedVariation(db);
    const out = await syncItemPrices(asDb(db), CONTA, ITEM, {
      resolveContext: ctxFor([stdEntry(45.9), promoEntry(39.9)]),
      now: () => NOW,
    });
    expect(out).toBe('synced');
    const upd = db.updates.find((u) => u.path === `produtos/${CHILD}`);
    expect(upd).toBeDefined();
    expect(upd!.patch).toEqual({
      [`precos.${TAB_NORMAL}`]: { valor: 45.9 },
      [`precos.${TAB_PROMO}`]: { valor: 39.9 },
    });
    // The parent produto and the family PML link are untouched.
    expect(db.updates.find((u) => u.path === `produtos/${PRODUTO}`)).toBeUndefined();
    expect(db.docData(LINK_PATH, 'link1')).not.toHaveProperty('precoPublicado');
  });
});

describe('syncItemPrices — deterministic skips', () => {
  it('conta without a tabelaNormal ref → sem-tabela (no ML call, no write)', async () => {
    const db = new FakeDb();
    seedLink(db);
    const out = await syncItemPrices(asDb(db), CONTA, ITEM, {
      resolveContext: ctxFor([stdEntry(45.9)], { tabelaNormalOuterRef: null }),
      now: () => NOW,
    });
    expect(out).toBe('sem-tabela');
    expect(db.updates).toEqual([]);
  });

  it('no applicable standard entry → sem-preco-standard with ZERO writes (promo included)', async () => {
    const db = new FakeDb();
    seedLink(db);
    const out = await syncItemPrices(asDb(db), CONTA, ITEM, {
      resolveContext: ctxFor([promoEntry(39.9)]),
      now: () => NOW,
    });
    expect(out).toBe('sem-preco-standard');
    expect(db.updates).toEqual([]);
    expect(db.docData(LINK_PATH, 'link1')).not.toHaveProperty('ultimaModificacao');
  });
});

describe('syncItemPrices — transport errors', () => {
  it('404 (deleted listing) → item-gone, no throw', async () => {
    const db = new FakeDb();
    seedLink(db);
    const out = await syncItemPrices(asDb(db), CONTA, ITEM, {
      resolveContext: failingCtx(new MercadoLivreHttpError('ML 404', 404, null)),
      now: () => NOW,
    });
    expect(out).toBe('item-gone');
    expect(db.updates).toEqual([]);
  });

  it('5xx → throws (queue/sweep retry)', async () => {
    const db = new FakeDb();
    seedLink(db);
    await expect(
      syncItemPrices(asDb(db), CONTA, ITEM, {
        resolveContext: failingCtx(new MercadoLivreHttpError('ML 500', 500, null)),
        now: () => NOW,
      }),
    ).rejects.toThrow(MercadoLivreHttpError);
  });

  it('network failure → throws', async () => {
    const db = new FakeDb();
    seedLink(db);
    await expect(
      syncItemPrices(asDb(db), CONTA, ITEM, {
        resolveContext: failingCtx(new MercadoLivreNetworkError('offline')),
        now: () => NOW,
      }),
    ).rejects.toThrow(MercadoLivreNetworkError);
  });
});
