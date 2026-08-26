import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  type MlModeration,
} from '@delfrance/integrations-mercado-livre';

import {
  applyFamilyStatusAndFold,
  applyItemStatusToLink,
  type ItemsApiResolver,
  type ItemsSyncApi,
  syncItemStatus,
} from './itemsStatusSync';
import { parseItemIdFromResource } from '../core/linkRefs';

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

  private query(entriesOf: () => Array<[string, DocData, string]>) {
    const clauses: Array<[string, unknown]> = [];
    let cap: number | null = null;
    const q = {
      // Tagged so the transaction fake can tell a query from a doc ref.
      __isQuery: true as const,
      where(field: string, _op: string, value: unknown) {
        clauses.push([field, value]);
        return q;
      },
      // The UP member lookup bounds its scan with `.limit(10)`; without this the
      // chain throws and every caller reports a resolution failure it never had.
      limit(n: number) {
        cap = n;
        return q;
      },
      async get() {
        // ⚠️ Re-evaluated per call, never captured. A transaction retry MUST see
        // what the winning writer committed; a frozen snapshot would make an OCC
        // guard look broken and, worse, make a missing one look fine.
        const matched = entriesOf().filter(([, d]) => clauses.every(([f, v]) => d[f] === v));
        const rows = cap == null ? matched : matched.slice(0, cap);
        return {
          docs: rows.map(([id, d, colPath]) => ({
            id,
            __path: colPath,
            data: () => d,
            exists: true,
            ref: { id, __path: colPath, parent: { parent: { id: parentDocId(colPath) } } },
          })),
          empty: rows.length === 0,
          size: rows.length,
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
        __path: path,
        get: async () => ({ exists: col.has(id), id, data: () => col.get(id) }),
        set: async (data: DocData, opts?: { merge?: boolean }) => {
          col.set(id, opts?.merge ? { ...(col.get(id) ?? {}), ...data } : { ...data });
          self.versions.set(`${path}/${id}`, (self.versions.get(`${path}/${id}`) ?? 0) + 1);
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
          self.versions.set(full, (self.versions.get(full) ?? 0) + 1);
        },
      }),
    };
  }

  collectionGroup(groupId: string) {
    return this.query(() => {
      const entries: Array<[string, DocData, string]> = [];
      for (const [path, col] of this.cols) {
        if (path.split('/').pop() === groupId) {
          for (const [id, d] of col) entries.push([id, d, path]);
        }
      }
      return entries;
    });
  }

  /**
   * A transaction fake with REAL optimistic concurrency, not a pass-through.
   *
   * A pass-through would make the family fold's race test vacuous — it would
   * report green for the exact unguarded read-modify-write the transaction was
   * added to prevent. So this records the version of every document the callback
   * READS and, at commit, re-checks them: if another writer touched one in the
   * meantime the callback is re-run against the new state, which is what Firestore
   * does and what makes the concurrent-member test meaningful.
   */
  async runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const readVersions = new Map<string, number>();
      const writes: Array<() => void> = [];
      const tx = this.makeTx(readVersions, writes);
      const out = await fn(tx);
      // The race window: a competing writer commits after our reads and before
      // our commit. Fires ONCE so a retry is not itself raced forever.
      const hook = this.onBeforeCommit;
      this.onBeforeCommit = null;
      if (hook) await hook();
      const stale = [...readVersions].some(([k, v]) => (this.versions.get(k) ?? 0) !== v);
      if (stale) continue; // OCC conflict → re-run against fresh state
      for (const w of writes) w();
      return out;
    }
    throw new Error('transaction failed after 5 attempts');
  }

  /** Bump a doc's version so readers that saw the old one lose at commit. */
  private bump(path: string, id: string): void {
    const k = `${path}/${id}`;
    this.versions.set(k, (this.versions.get(k) ?? 0) + 1);
  }

  readonly versions = new Map<string, number>();
  /** Runs inside the read→commit window, so a test can interleave a competing writer. */
  onBeforeCommit: (() => void | Promise<void>) | null = null;

  private makeTx(readVersions: Map<string, number>, writes: Array<() => void>): FakeTx {
    const self = this;
    const note = (path: string, id: string) =>
      readVersions.set(`${path}/${id}`, self.versions.get(`${path}/${id}`) ?? 0);
    return {
      get: async (target: FakeRef | FakeQuery) => {
        if ('__isQuery' in target) {
          const snap = await target.get();
          for (const d of snap.docs) note(d.__path, d.id);
          return snap;
        }
        note(target.__path, target.id);
        const col = self.cols.get(target.__path);
        return {
          exists: col?.has(target.id) ?? false,
          id: target.id,
          data: () => col?.get(target.id),
        };
      },
      set: (ref: FakeRef, data: DocData, opts?: { merge?: boolean }) => {
        writes.push(() => {
          const col = self.colOf(ref.__path);
          col.set(ref.id, opts?.merge ? { ...(col.get(ref.id) ?? {}), ...data } : { ...data });
          self.updates.push({ path: `${ref.__path}/${ref.id}`, patch: data });
          self.bump(ref.__path, ref.id);
        });
      },
      update: (ref: FakeRef, patch: DocData) => {
        writes.push(() => {
          const col = self.colOf(ref.__path);
          if (!col.has(ref.id)) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
          col.set(ref.id, { ...(col.get(ref.id) ?? {}), ...patch });
          self.updates.push({ path: `${ref.__path}/${ref.id}`, patch });
          self.bump(ref.__path, ref.id);
        });
      },
    };
  }

  colOf(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }
}

interface FakeRef {
  id: string;
  __path: string;
}
interface FakeQueryDoc {
  id: string;
  __path: string;
  data: () => DocData;
  ref: unknown;
}
interface FakeQuery {
  __isQuery: true;
  get(): Promise<{ docs: FakeQueryDoc[] }>;
}
interface FakeDocSnap {
  exists: boolean;
  id: string;
  data: () => DocData | undefined;
}
interface FakeTx {
  get(target: FakeRef | FakeQuery): Promise<{ docs: FakeQueryDoc[] } | FakeDocSnap>;
  set(ref: FakeRef, data: DocData, opts?: { merge?: boolean }): void;
  update(ref: FakeRef, patch: DocData): void;
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

/**
 * The moderation half of the fake ML API (#1087).
 *
 * ⚠️ The DEFAULT throws a 404, and that is not laziness — it is what ML answers
 * for a listing with no active moderation, so every test that does not opt in is
 * exercising the real "not moderated" path rather than a convenient `[]` that
 * could never happen. A test wanting a moderation passes one explicitly.
 */
type ModeracaoStub = MlModeration[] | Error;
const SEM_MODERACAO = new MercadoLivreHttpError('ML 404: not found', 404, null);

function api(item: DocData, moderacao: ModeracaoStub = SEM_MODERACAO): ItemsSyncApi {
  return {
    getItem: vi.fn(async () => item),
    getLastModeration: vi.fn(async () => {
      if (moderacao instanceof Error) throw moderacao;
      return moderacao;
    }),
  } as unknown as ItemsSyncApi;
}
function failingApi(err: Error): ItemsSyncApi {
  return {
    getItem: vi.fn(async () => {
      throw err;
    }),
    getLastModeration: vi.fn(async () => {
      throw new Error('getLastModeration must not be reached when getItem failed');
    }),
  } as unknown as ItemsSyncApi;
}
/**
 * A lazy resolver that yields a fake API returning `item` (link-first contract).
 *
 * Returns the SAME api object every call so a test can assert on its mocks —
 * `apiDo(resolve).getLastModeration` is how the "never called for a healthy
 * listing" guarantee is checked.
 */
function resolverFor(item: DocData, moderacao: ModeracaoStub = SEM_MODERACAO): ItemsApiResolver {
  const fake = api(item, moderacao);
  return vi.fn(async () => fake);
}
function failingResolver(err: Error): ItemsApiResolver {
  return vi.fn(async () => failingApi(err));
}

/** The fake API a resolver hands out, with its mocks reachable. */
async function apiDo(resolve: ItemsApiResolver): Promise<{
  getItem: ReturnType<typeof vi.fn>;
  getLastModeration: ReturnType<typeof vi.fn>;
}> {
  return (await resolve(asDb(new FakeDb()), CONTA)) as unknown as {
    getItem: ReturnType<typeof vi.fn>;
    getLastModeration: ReturnType<typeof vi.fn>;
  };
}

/** ML's documented `last_moderation` entry, trimmed to what the mapper reads. */
function moderacaoMl(over: Partial<MlModeration> = {}): MlModeration {
  return {
    name: 'POOR_QUALITY_THUMBNAIL',
    id: '7123400815',
    date_created: '2021-04-14T10:47:05.270-0400',
    evidences: [{ text_matched: '604505-MLA82848669458_022025', section_name: 'pictures' }],
    wordings: [
      { type: 'REASON', value: 'Pausamos o anúncio porque ele infringe nossas políticas.' },
      { type: 'REMEDY', value: 'Ajuste o título e/ou substitua as fotos.' },
    ],
    ...over,
  } as MlModeration;
}

/** What {@link moderacaoMl} maps to on the link doc. */
const MODERACAO_ARMAZENADA = {
  nome: 'POOR_QUALITY_THUMBNAIL',
  dataCriacao: '2021-04-14T10:47:05.270-0400',
  motivo: 'Pausamos o anúncio porque ele infringe nossas políticas.',
  remedio: 'Ajuste o título e/ou substitua as fotos.',
  secoes: ['pictures'],
  evidencias: ['604505-MLA82848669458_022025'],
};

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

/* ---- User-Products family fixtures (#1142) ----
 * A family's PARENT link carries the FAMILY id, so no member's item id matches it.
 * Members live on their own CHILD produtos under `variacaoMercadoLivre`, keyed to
 * the parent by `produtoMercadoLivreOuterRef`. */

const FAMILY = 'FAM-9'; // the parent link's `id` — NOT any member's item id
const MEMBER_A = 'MLB-A';
const MEMBER_B = 'MLB-B';
const FAMILY_PML_REF = `documents/produtos/${PRODUTO}/produtoMercadoLivre/link1`;

/** Seed a UP family: one parent link at `FAMILY`, plus the given members. */
function seedFamily(
  db: FakeDb,
  members: Array<{
    itemId: string;
    child: string;
    status?: string | null;
    sub?: string[] | null;
    moderacoes?: DocData[];
  }>,
  link: DocData = {},
  produto: DocData = {},
): void {
  db.seed('produtos', PRODUTO, {
    nome: 'Camiseta',
    marketplace: [{ integracaoUid: CONTA, externalId: FAMILY }],
    marketplaceIds: [FAMILY],
    integracoesComProduto: [CONTA],
    ...produto,
  });
  db.seed(LINK_PATH, 'link1', {
    id: FAMILY,
    contaOuterRef: `documents/integracao/${CONTA}`,
    title: 'Camiseta',
    estado: 'p',
    status: 'active',
    sub_status: null,
    isUserProductModel: true,
    ...link,
  });
  for (const m of members) {
    db.seed(`produtos/${m.child}/variacaoMercadoLivre`, `v-${m.child}`, {
      itemId: m.itemId,
      produtoMercadoLivreOuterRef: FAMILY_PML_REF,
      produtoVariacaoOuterRef: `documents/produtos/${m.child}`,
      // Deliberately absent unless asked for: `contaOuterRef` is null on every
      // pre-#920 row, and the resolver must not depend on it.
      status: m.status === undefined ? 'active' : m.status,
      sub_status: m.sub ?? null,
      // Absent unless asked for: a member link written before #1087 has no such
      // key, and the fold must read that as "no moderation" rather than throw.
      ...(m.moderacoes ? { moderacoes: m.moderacoes } : {}),
    });
  }
}

const memberVarPath = (child: string) => `produtos/${child}/variacaoMercadoLivre`;

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
    // #920: not in the patch any more — the same estado change that gets here
    // also merges onto the link doc, and `onProdutoMercadoLivreLinkChanged`
    // derives the array from that.
    expect(denorm!.patch).not.toHaveProperty('integracoesComProduto');
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

/**
 * #781. The stock sender latches a listing it cannot update; this webhook is the
 * automatic way out. The subtle part is the `unchanged` short-circuit above —
 * without counting `errors` as a change, a link whose estado/status already match
 * ML would return early and stay latched forever.
 */
describe('syncItemStatus — re-arms a latched listing (#781)', () => {
  it('a healthy listing clears the latch even when estado/status already match', async () => {
    const db = new FakeDb();
    seedLink(db, {
      estado: 'p',
      status: 'active',
      sub_status: ['x'],
      errors: ['ML 400: invalid quantity'],
    });

    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'active', sub_status: ['x'] }),
    );

    // Identical estado/status/sub_status — only the stale errors differ.
    expect(out).toBe('synced');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'p', errors: [] });
  });

  it("clears the sender's estado 'E' back to the real ML state", async () => {
    const db = new FakeDb();
    seedLink(db, { estado: 'E', status: 'active', errors: ['ML 400: invalid quantity'] });

    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'active', sub_status: [] }),
    );

    expect(out).toBe('synced');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({
      estado: 'p',
      status: 'active',
      errors: [],
    });
  });

  it('a listing that still cannot take stock KEEPS its diagnosis on screen', async () => {
    const db = new FakeDb();
    seedLink(db, { estado: 'p', status: 'active', errors: ['ML 400: invalid quantity'] });

    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'under_review', sub_status: [] }),
    );

    expect(out).toBe('synced');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({
      estado: 'v',
      errors: ['ML 400: invalid quantity'],
    });
  });

  it('converges: a non-sendable listing with errors settles on unchanged', async () => {
    const db = new FakeDb();
    // Gating the clear on `enviar` is what keeps this terminating — an
    // unconditional "errors present ⇒ changed" would never return unchanged.
    seedLink(db, { estado: 'v', status: 'under_review', sub_status: [], errors: ['boom'] });

    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'under_review', sub_status: [] }),
    );

    expect(out).toBe('unchanged');
    expect(db.updates).toEqual([]);
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
    // `integracoesComProduto` is deliberately UNTOUCHED (#920): dropping the
    // conta is the link trigger's call, made from the surviving links inside a
    // transaction, not this function's from the `marketplace` array.
    expect(db.docData('produtos', PRODUTO)).toMatchObject({
      marketplace: [],
      marketplaceIds: [],
      integracoesComProduto: [CONTA],
    });
  });

  // Since #920 this only pins the `marketplace`/`marketplaceIds` filtering —
  // `integracoesComProduto` is untouched here either way. The equivalent
  // "keep the conta while another listing survives" rule now lives in
  // `sobrevivemLinksDoProduto` (integracoesComProduto.test.ts).
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
      integracoesComProduto: [CONTA], // link-trigger-owned since #920
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

describe('applyItemStatusToLink — the link is the anchor', () => {
  const target = { produtoId: PRODUTO, linkDocId: 'link1', itemId: ITEM };

  it('a deleted link stops the write BEFORE the parent denorm is touched', async () => {
    const db = new FakeDb();
    // The produto survives with its denorm arrays already emptied (an operator
    // unlinked the listing); the link doc is gone. The denorm must stay empty —
    // `updateParentDenorm` would otherwise arrayUnion the entries straight back,
    // advertising a listing whose link no longer exists.
    db.seed('produtos', PRODUTO, {
      nome: 'Camiseta',
      marketplace: [],
      marketplaceIds: [],
      integracoesComProduto: [],
    });

    const applied = await applyItemStatusToLink(
      asDb(db),
      CONTA,
      target,
      { status: 'active', sub_status: null },
      { nowMs: 1_700_000_000_000 },
    );

    expect(applied).toBe(false);
    expect(db.docData('produtos', PRODUTO)).toMatchObject({
      marketplace: [],
      marketplaceIds: [],
      integracoesComProduto: [],
    });
    // And no ghost link doc was created on the way out.
    expect(db.docData(LINK_PATH, 'link1')).toBeUndefined();
  });

  it('a live link writes both halves and resolves true', async () => {
    const db = new FakeDb();
    seedLink(db, { estado: 'pa', status: 'paused' });

    const applied = await applyItemStatusToLink(
      asDb(db),
      CONTA,
      target,
      { status: 'active', sub_status: null },
      { nowMs: 1_700_000_000_000 },
    );

    expect(applied).toBe(true);
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'p', status: 'active' });
  });

  it('skipDenorm still guards the link — no ghost, and still false', async () => {
    const db = new FakeDb();
    db.seed('produtos', PRODUTO, { nome: 'Camiseta', marketplace: [] });

    const applied = await applyItemStatusToLink(
      asDb(db),
      CONTA,
      target,
      { status: 'active', sub_status: null },
      { nowMs: 1_700_000_000_000, skipDenorm: true },
    );

    expect(applied).toBe(false);
    expect(db.docData(LINK_PATH, 'link1')).toBeUndefined();
  });
});

describe('syncItemStatus — the ERP owns estado (no dual-run)', () => {
  // The reported defect (#1087): `isUserProductModel` is true for EVERY listing
  // a `user_product_seller` publishes, so deferring on it skipped the whole
  // catalogue while reporting success. ML said `under_review`; the ERP kept the
  // estado it had at publish time, for a full day, with no error anywhere.
  it('User-Products link → syncs like any other listing (the #1087 regression)', async () => {
    const db = new FakeDb();
    seedLink(db, { isUserProductModel: true });
    const resolve = resolverFor({ status: 'under_review' });
    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolve);
    expect(out).toBe('synced');
    expect(resolve).toHaveBeenCalled();
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({
      estado: 'v',
      status: 'under_review',
      // The writeback must not disturb the model flag: publish, the importer and
      // the UPtin takeover own it, and `resolveListingModel` reads it to pick
      // which payload shape a republish sends.
      isUserProductModel: true,
    });
  });

  // Nothing in this repo writes 'am' — it only ever arrived from Flutter, so
  // with Flutter gone this was a value no writer could ever clear.
  it('link left at estado "am" by Flutter → heals to the real ML status', async () => {
    const db = new FakeDb();
    seedLink(db, { estado: 'am' });
    const resolve = resolverFor({ status: 'active' });
    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolve);
    expect(out).toBe('synced');
    expect(resolve).toHaveBeenCalled();
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'p', status: 'active' });
  });

  // The old guard's worst consequence, and the one nothing reported: it returned
  // BEFORE the fetch, so an 'am' link could never reach the tag check below —
  // the #441 takeover was unreachable for exactly the rows it exists to migrate.
  it('an "am" link that is a closed migration source reaches the #441 takeover', async () => {
    const db = new FakeDb();
    seedLink(db, { estado: 'am' });
    const migrationRunner = vi.fn(async () => {});
    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'closed', tags: ['variations_migration_source'] }),
      migrationRunner,
    );
    expect(out).toBe('migrated');
    expect(migrationRunner).toHaveBeenCalledWith(asDb(db), CONTA, ITEM, {
      produtoId: PRODUTO,
      linkDocId: 'link1',
      raw: expect.objectContaining({ estado: 'am' }),
    });
    expect(db.updates).toEqual([]);
  });
});

describe('syncItemStatus — migration deferrals each name themselves (#441)', () => {
  // The deferral is not just logged — it is RECORDED. `'am'` has no other
  // producer in this repo (it only ever came from Flutter), and publishCore,
  // precoPlan and bulkEstoquePlan all gate on it. Of the send paths only the
  // price one re-reads ML's tags itself, so without this stamp a mid-migration
  // listing would still be published to and stock-pushed.
  it('source-tagged item still open → deferred AND stamped estado "am"', async () => {
    const db = new FakeDb();
    seedLink(db);
    const resolve = resolverFor({ status: 'active', tags: ['variations_migration_source'] });
    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolve);
    expect(out).toBe('deferred-migration-source');
    expect(resolve).toHaveBeenCalled(); // the tag is only visible after fetching
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'am' });
    // The listing's own status is NOT touched — we did not sync it, and claiming
    // otherwise is the failure mode this whole outcome union exists to prevent.
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ status: 'active' });
    // No parent denorm write: 'am' is not a cancel and those arrays are dead weight.
    expect(db.updates.map((u) => u.path)).toEqual([`${LINK_PATH}/link1`]);
  });

  it('uptin-tagged item → deferred-migration-uptin, a DIFFERENT outcome, also stamped', async () => {
    const db = new FakeDb();
    seedLink(db);
    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'active', tags: ['variations_migration_uptin'] }),
    );
    expect(out).toBe('deferred-migration-uptin');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'am' });
  });

  // Idempotence: a redelivery of the same notification must cost no write.
  it('a link ALREADY at "am" is not rewritten on redelivery', async () => {
    const db = new FakeDb();
    seedLink(db, { estado: 'am' });
    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'active', tags: ['variations_migration_source'] }),
    );
    expect(out).toBe('deferred-migration-source');
    expect(db.updates).toEqual([]);
  });

  // Both tags at once: the destination reading wins, so a listing ML has already
  // migrated is never reported as a source still waiting to close.
  it('both tags → uptin wins (the destination reading, never "still waiting")', async () => {
    const db = new FakeDb();
    seedLink(db);
    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({
        status: 'active',
        tags: ['variations_migration_source', 'variations_migration_uptin'],
      }),
    );
    expect(out).toBe('deferred-migration-uptin');
  });
});

describe('syncItemStatus — #441 migration takeover', () => {
  it('source tag + closed + a runner supplied → migrated, runner gets the resolved link, no estado merge', async () => {
    const db = new FakeDb();
    seedLink(db);
    const migrationRunner = vi.fn(async () => {});
    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'closed', tags: ['variations_migration_source'] }),
      migrationRunner,
    );
    expect(out).toBe('migrated');
    expect(migrationRunner).toHaveBeenCalledWith(asDb(db), CONTA, ITEM, {
      produtoId: PRODUTO,
      linkDocId: 'link1',
      raw: expect.objectContaining({ id: ITEM }),
    });
    // the takeover branch REPLACES the normal estado merge — no link/parent write here.
    expect(db.updates).toEqual([]);
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'p', status: 'active' });
  });

  // The takeover was DUE and could not run. That is a wiring defect, not a
  // listing state, so it must not share an outcome with ML's own in-flight
  // migrations — production always defaults a runner in, and this value is how a
  // regression that drops the default would announce itself instead of
  // degrading into a permanent, plausible-looking deferral.
  it('source tag + closed but NO runner supplied → no-migration-runner, not a migration deferral', async () => {
    const db = new FakeDb();
    seedLink(db);
    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'closed', tags: ['variations_migration_source'] }),
    );
    expect(out).toBe('no-migration-runner');
    // Still a mid-migration listing, so it is still stamped — the send paths must
    // hold off whether or not the takeover was wired.
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'am' });
  });

  it('source tag but NOT yet closed, even with a runner supplied → deferred, runner never invoked', async () => {
    const db = new FakeDb();
    seedLink(db);
    const migrationRunner = vi.fn(async () => {});
    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'active', tags: ['variations_migration_source'] }),
      migrationRunner,
    );
    expect(out).toBe('deferred-migration-source');
    expect(migrationRunner).not.toHaveBeenCalled();
  });

  it('uptin tag (the OTHER migration tag) never takes over, even closed + a runner supplied', async () => {
    const db = new FakeDb();
    seedLink(db);
    const migrationRunner = vi.fn(async () => {});
    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'closed', tags: ['variations_migration_uptin'] }),
      migrationRunner,
    );
    expect(out).toBe('deferred-migration-uptin');
    expect(migrationRunner).not.toHaveBeenCalled();
  });

  it('a migrationRunner throw propagates (pipeline retries) instead of being swallowed', async () => {
    const db = new FakeDb();
    seedLink(db);
    const migrationRunner = vi.fn(async () => {
      throw new Error('old variação not found');
    });
    await expect(
      syncItemStatus(
        asDb(db),
        CONTA,
        ITEM,
        resolverFor({ status: 'closed', tags: ['variations_migration_source'] }),
        migrationRunner,
      ),
    ).rejects.toThrow('old variação not found');
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

/* -------------------------------------------------------------------------- */
/*        User-Products FAMILY member status (#1142)                          */
/* -------------------------------------------------------------------------- */

describe('syncItemStatus — User-Products family members (#1142)', () => {
  it('a MEMBER item resolves its family and syncs the parent link', async () => {
    // The regression: the parent link carries FAMILY, so matching on `id` alone
    // found nothing and the delivery reported `no-link`.
    const db = new FakeDb();
    seedFamily(db, [
      { itemId: MEMBER_A, child: 'childA' },
      { itemId: MEMBER_B, child: 'childB', status: 'paused' },
    ]);
    const resolve = resolverFor({ status: 'paused', sub_status: ['out_of_stock'] });

    const out = await syncItemStatus(asDb(db), CONTA, MEMBER_A, resolve);

    expect(out).toBe('synced-family');
    // Every member is now paused, so the family summarises as paused.
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'pa', status: 'paused' });
  });

  it("records the member's own status on ITS link, not on the family's", async () => {
    const db = new FakeDb();
    seedFamily(db, [
      { itemId: MEMBER_A, child: 'childA' },
      { itemId: MEMBER_B, child: 'childB' },
    ]);

    await syncItemStatus(
      asDb(db),
      CONTA,
      MEMBER_A,
      resolverFor({ status: 'paused', sub_status: ['out_of_stock'] }),
    );

    expect(db.docData(memberVarPath('childA'), 'v-childA')).toMatchObject({
      status: 'paused',
      sub_status: ['out_of_stock'],
    });
    // The sibling is untouched — one notification speaks for one listing.
    expect(db.docData(memberVarPath('childB'), 'v-childB')).toMatchObject({ status: 'active' });
    // And no `estado` leaks onto a member: it is a FAMILY summary.
    expect(db.docData(memberVarPath('childA'), 'v-childA')).not.toHaveProperty('estado');
  });

  it('ONE member closing does NOT cancel a family whose sibling is still live', async () => {
    // The whole point of the fold. `estado 'c'` would drop the produto from
    // `integracoesComProduto` and so from both sweeps' anchor query — silently.
    const db = new FakeDb();
    seedFamily(db, [
      { itemId: MEMBER_A, child: 'childA' },
      { itemId: MEMBER_B, child: 'childB', status: 'active' },
    ]);

    const out = await syncItemStatus(asDb(db), CONTA, MEMBER_A, resolverFor({ status: 'closed' }));

    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'p', status: 'active' });
    expect(out).toBe('synced-member'); // recorded, family summary unmoved
    // The produto keeps its denorm entry: nothing was cancelled.
    expect(db.docData('produtos', PRODUTO)).toMatchObject({ marketplaceIds: [FAMILY] });
  });

  it('the LAST member closing cancels the family and removes the FAMILY-keyed denorm entry', async () => {
    const db = new FakeDb();
    seedFamily(db, [
      { itemId: MEMBER_A, child: 'childA' },
      { itemId: MEMBER_B, child: 'childB', status: 'closed' },
    ]);

    const out = await syncItemStatus(asDb(db), CONTA, MEMBER_A, resolverFor({ status: 'closed' }));

    expect(out).toBe('synced-family');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'c', status: 'closed' });
    // ⚠️ Keyed on the FAMILY id — publish/import stamped it that way. Keying on the
    // member id would leave this array untouched and the removal a silent no-op.
    expect(db.docData('produtos', PRODUTO)).toMatchObject({ marketplace: [], marketplaceIds: [] });
  });

  it('a never-observed member blocks the cancel — unknown is not dead', async () => {
    const db = new FakeDb();
    seedFamily(db, [
      { itemId: MEMBER_A, child: 'childA' },
      { itemId: MEMBER_B, child: 'childB', status: null },
    ]);

    const out = await syncItemStatus(asDb(db), CONTA, MEMBER_A, resolverFor({ status: 'closed' }));

    expect(out).toBe('synced-member');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'p' });
  });

  it('a member of ANOTHER conta never resolves (ownership comes from the parent link)', async () => {
    const db = new FakeDb();
    seedFamily(db, [{ itemId: MEMBER_A, child: 'childA' }], {
      contaOuterRef: `documents/integracao/outra-conta`,
    });
    const resolve = resolverFor({ status: 'paused' });

    expect(await syncItemStatus(asDb(db), CONTA, MEMBER_A, resolve)).toBe('no-link');
    expect(resolve).not.toHaveBeenCalled();
    expect(db.updates).toEqual([]);
  });

  it('the parent-id match still wins first — a simple listing never touches the member query', async () => {
    // Stage 2 must stay a fallback: it is pure cost for the common case.
    const db = new FakeDb();
    seedLink(db);
    // A member link that would ALSO match this id, on a different produto. If
    // stage 2 ran first (or at all here) the sync would resolve the wrong parent.
    db.seed('produtos/childX/variacaoMercadoLivre', 'v-childX', {
      itemId: ITEM,
      produtoMercadoLivreOuterRef: 'documents/produtos/OTHER/produtoMercadoLivre/linkX',
      produtoVariacaoOuterRef: 'documents/produtos/childX',
      status: 'closed',
    });

    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolverFor({ status: 'paused' }));

    expect(out).toBe('synced'); // the SIMPLE outcome, not a family one
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'pa' });
    // The stray member link was never written to.
    expect(db.docData('produtos/childX/variacaoMercadoLivre', 'v-childX')).toMatchObject({
      status: 'closed',
    });
  });

  it('a redelivery of an unchanged member is a no-op', async () => {
    const db = new FakeDb();
    seedFamily(db, [
      { itemId: MEMBER_A, child: 'childA' },
      { itemId: MEMBER_B, child: 'childB' },
    ]);

    const out = await syncItemStatus(asDb(db), CONTA, MEMBER_A, resolverFor({ status: 'active' }));

    expect(out).toBe('unchanged');
    expect(db.updates).toEqual([]);
  });
});

describe('syncItemStatus — concurrent family members (rule 7)', () => {
  /**
   * The queue runs `maxConcurrentDispatches: 3`, and ML fans out ONE notification
   * per member item — so a family-wide pause/close/reactivate is precisely when two
   * members are processed at once. The fold reads every sibling and writes the
   * parent, which is a read-modify-write across documents: without a guard the
   * loser re-applies a decision made against a view that has since moved.
   *
   * Reported interleaving: stored A `active`, B `closed`; on ML, A has closed and
   * B has been reactivated. A folds against B's STALE `closed`, concludes
   * all-closed, and its write lands last — cancelling a family whose member B is
   * live, dropping the FAMILY denorm entry, and (in production) taking the conta
   * out of `integracoesComProduto`, the anchor pre-filter both sweeps open with.
   */
  it('a sibling reactivated mid-flight does NOT let the other member cancel the family', async () => {
    const db = new FakeDb();
    seedFamily(db, [
      { itemId: MEMBER_A, child: 'childA', status: 'active' },
      { itemId: MEMBER_B, child: 'childB', status: 'closed' },
    ]);

    // B commits inside A's read→commit window: it records itself active and
    // re-folds. A must not then re-apply its stale all-closed conclusion.
    db.onBeforeCommit = async () => {
      await syncItemStatus(asDb(db), CONTA, MEMBER_B, resolverFor({ status: 'active' }));
    };

    const aOut = await syncItemStatus(asDb(db), CONTA, MEMBER_A, resolverFor({ status: 'closed' }));

    // Both members' own readings are recorded truthfully.
    expect(db.docData(memberVarPath('childA'), 'v-childA')).toMatchObject({ status: 'closed' });
    expect(db.docData(memberVarPath('childB'), 'v-childB')).toMatchObject({ status: 'active' });

    // And the family reflects the LIVE member, not the stale all-closed view.
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'p', status: 'active' });
    expect(aOut).not.toBe('link-removido');

    // The denorm entry survives: nothing was cancelled.
    expect(db.docData('produtos', PRODUTO)).toMatchObject({ marketplaceIds: [FAMILY] });
  });

  it('the LAST member closing still cancels, even when a sibling commits mid-flight', async () => {
    // The mirror case — the guard must not make a legitimate cancel unreachable.
    const db = new FakeDb();
    seedFamily(db, [
      { itemId: MEMBER_A, child: 'childA', status: 'active' },
      { itemId: MEMBER_B, child: 'childB', status: 'active' },
    ]);

    db.onBeforeCommit = async () => {
      await syncItemStatus(asDb(db), CONTA, MEMBER_B, resolverFor({ status: 'closed' }));
    };

    await syncItemStatus(asDb(db), CONTA, MEMBER_A, resolverFor({ status: 'closed' }));

    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'c', status: 'closed' });
    expect(db.docData('produtos', PRODUTO)).toMatchObject({ marketplace: [], marketplaceIds: [] });
  });
});

describe('syncItemStatus — a family member never speaks for the family un-folded', () => {
  it("a MEMBER's migration tags do not stamp `estado 'am'` on the family", async () => {
    // Under stage-2 resolution `link` is the family PARENT. A tag branch reaching
    // it would block publish and make BOTH planners skip every sibling because one
    // member is tagged. The member goes to the fold instead.
    const db = new FakeDb();
    seedFamily(db, [
      { itemId: MEMBER_A, child: 'childA' },
      { itemId: MEMBER_B, child: 'childB', status: 'paused' },
    ]);

    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      MEMBER_A,
      resolverFor({ status: 'paused', tags: ['variations_migration_uptin'] }),
    );

    expect(out).not.toBe('deferred-migration-uptin');
    expect(db.docData(LINK_PATH, 'link1')).not.toMatchObject({ estado: 'am' });
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'pa' });
  });

  it('a MEMBER never triggers the #441 takeover against the family link', async () => {
    // The takeover prunes its source. Handing it a member item id with the
    // FAMILY's parent link would point that prune at a live family. A UPtin
    // migration's source is a LEGACY listing, which resolves through stage 1.
    const db = new FakeDb();
    seedFamily(db, [{ itemId: MEMBER_A, child: 'childA' }]);
    const migrationRunner = vi.fn(async () => {});

    await syncItemStatus(
      asDb(db),
      CONTA,
      MEMBER_A,
      resolverFor({ status: 'closed', tags: ['variations_migration_source'] }),
      migrationRunner,
    );

    expect(migrationRunner).not.toHaveBeenCalled();
  });

  it('a member row with no itemId is not a listing, so it cannot block a cancel forever', async () => {
    // The legacy `variations[]` branch leaves `itemId` null. Counted as "never
    // observed" it would make `'c'` unreachable for the family for all time — no
    // notification can arrive for something that was never published.
    const db = new FakeDb();
    seedFamily(db, [{ itemId: MEMBER_A, child: 'childA' }]);
    db.seed('produtos/childZ/variacaoMercadoLivre', 'v-childZ', {
      itemId: null,
      produtoMercadoLivreOuterRef: FAMILY_PML_REF,
      produtoVariacaoOuterRef: 'documents/produtos/childZ',
      status: null,
    });

    const out = await syncItemStatus(asDb(db), CONTA, MEMBER_A, resolverFor({ status: 'closed' }));

    expect(out).toBe('synced-family');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'c' });
  });
});

/**
 * The `family_id`-less family — the half of #1142 that survived #1155.
 *
 * `publish.ts` writes the parent's `id` as `familyId ?? itemIds[0]`, so when ML
 * omits `family_id` the parent carries MEMBER 0's item id. That member's
 * delivery then matches `resolveLink` STAGE 1, which used to mean `member:
 * undefined` and the simple write-through path: member 0's status straight onto
 * the parent un-folded, and member 0's OWN link never written — which left every
 * sibling's later fold reading a stale member 0 forever.
 */
describe('syncItemStatus — a family whose parent carries a MEMBER id (#1142)', () => {
  /** The `family_id`-less shape: the parent's `id` IS member A's item id. */
  function seedFamilySemFamilyId(db: FakeDb, link: DocData = {}): void {
    seedFamily(
      db,
      [
        { itemId: MEMBER_A, child: 'childA' },
        { itemId: MEMBER_B, child: 'childB' },
      ],
      { id: MEMBER_A, ...link },
      { marketplace: [{ integracaoUid: CONTA, externalId: MEMBER_A }], marketplaceIds: [MEMBER_A] },
    );
  }

  it("records member 0's status on ITS OWN link instead of writing through", async () => {
    const db = new FakeDb();
    seedFamilySemFamilyId(db);

    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      MEMBER_A,
      resolverFor({ status: 'paused', sub_status: ['out_of_stock'] }),
    );

    expect(out).toBe('synced-member');
    // THE regression: without the member attach this doc is never written, and
    // every sibling's fold reads a stale member A for the life of the listing.
    expect(db.docData(memberVarPath('childA'), 'v-childA')).toMatchObject({
      status: 'paused',
      sub_status: ['out_of_stock'],
    });
    // The family is still live (member B is active), so the summary must not move.
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'p', status: 'active' });
  });

  it('member 0 closing cannot cancel the family while a sibling is live', async () => {
    // The silent outage this whole module exists to prevent: `estado 'c'` fails
    // `linkHasLiveListing`, drops the conta from `integracoesComProduto`, and the
    // produto leaves BOTH sweeps with nothing logged.
    const db = new FakeDb();
    seedFamilySemFamilyId(db);

    await syncItemStatus(asDb(db), CONTA, MEMBER_A, resolverFor({ status: 'closed' }));

    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'p', status: 'active' });
    expect(db.docData('produtos', PRODUTO)).toMatchObject({ marketplaceIds: [MEMBER_A] });
  });

  it('folds to the family summary once every member agrees', async () => {
    const db = new FakeDb();
    seedFamily(
      db,
      [
        { itemId: MEMBER_A, child: 'childA' },
        { itemId: MEMBER_B, child: 'childB', status: 'paused', sub: ['out_of_stock'] },
      ],
      { id: MEMBER_A },
    );

    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      MEMBER_A,
      resolverFor({ status: 'paused', sub_status: ['out_of_stock'] }),
    );

    expect(out).toBe('synced-family');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'pa', status: 'paused' });
  });

  it('⚠️ migration TAGS still outrank the fold on this path, unlike stage 2', async () => {
    // The ordering that makes the stage-1 attach safe. A stage-2 member cannot be
    // a migration SOURCE (a UPtin source is a legacy `variations[]` listing, which
    // resolves through stage 1) — but THIS member matched exactly the way a legacy
    // listing does, so its tags must be read before anything else.
    const db = new FakeDb();
    seedFamilySemFamilyId(db);
    const migrationRunner = vi.fn(async () => {});

    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      MEMBER_A,
      resolverFor({ status: 'closed', tags: ['variations_migration_source'] }),
      migrationRunner,
    );

    expect(out).toBe('migrated');
    expect(migrationRunner).toHaveBeenCalledTimes(1);
    // And the fold never ran: the member's own link keeps its stored reading.
    expect(db.docData(memberVarPath('childA'), 'v-childA')).toMatchObject({ status: 'active' });
  });

  it('a UP SINGLE-ITEM listing has no member link, so it keeps the simple path', async () => {
    // The other half of the discriminator. `isUserProductModel` alone would send
    // every UP listing down the fold; only an actual member link may.
    const db = new FakeDb();
    db.seed('produtos', PRODUTO, { nome: 'Camiseta' });
    db.seed(LINK_PATH, 'link1', {
      id: ITEM,
      contaOuterRef: `documents/integracao/${CONTA}`,
      estado: 'E',
      status: 'active',
      isUserProductModel: true,
    });

    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolverFor({ status: 'paused' }));

    expect(out).toBe('synced');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'pa', status: 'paused' });
  });
});

describe('syncItemStatus — userProductId self-heal (multiorigem, #706)', () => {
  it('stamps userProductId on a SIMPLE listing, whose item IS the stock unit', async () => {
    const db = new FakeDb();
    seedLink(db);
    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'paused', sub_status: ['out_of_stock'], user_product_id: 'MLBU-1' }),
    );
    expect(out).toBe('synced');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ userProductId: 'MLBU-1' });
  });

  it('a NEW userProductId is a change on its own — an otherwise-unchanged listing still heals', async () => {
    // This is what makes the sync the catalogue-wide backfill: a listing whose
    // status never moves would short-circuit on `unchanged` and never gain the
    // field, and nothing else re-reads every listing on its own schedule.
    const db = new FakeDb();
    seedLink(db, { estado: 'p', status: 'active', sub_status: null });
    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'active', sub_status: null, user_product_id: 'MLBU-1' }),
    );
    expect(out).toBe('synced');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ userProductId: 'MLBU-1' });
  });

  it('is fill-only: a response that omits user_product_id never nulls a stored id', async () => {
    const db = new FakeDb();
    seedLink(db, { userProductId: 'MLBU-KEEP' });
    await syncItemStatus(asDb(db), CONTA, ITEM, resolverFor({ status: 'paused' }));
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ userProductId: 'MLBU-KEEP' });
  });

  it('re-syncing an already-stamped listing reports `unchanged` (no write amplification)', async () => {
    const db = new FakeDb();
    seedLink(db, { status: 'active', sub_status: null, userProductId: 'MLBU-1' });
    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({ status: 'active', sub_status: null, user_product_id: 'MLBU-1' }),
    );
    expect(out).toBe('unchanged');
  });

  it('⚠️ NEVER stamps a legacy variations[] listing — its stock units are the variations', async () => {
    const db = new FakeDb();
    seedLink(db);
    await syncItemStatus(
      asDb(db),
      CONTA,
      ITEM,
      resolverFor({
        status: 'paused',
        user_product_id: 'MLBU-ITEM',
        variations: [{ id: 1, available_quantity: 3 }],
      }),
    );
    expect(db.docData(LINK_PATH, 'link1')).not.toHaveProperty('userProductId');
  });

  it("⚠️ a MEMBER's userProductId lands on the MEMBER's own link, never on the family's (#1142)", async () => {
    const db = new FakeDb();
    seedFamily(db, [
      { itemId: MEMBER_A, child: 'childA' },
      { itemId: MEMBER_B, child: 'childB', status: 'paused' },
    ]);

    await syncItemStatus(
      asDb(db),
      CONTA,
      MEMBER_A,
      resolverFor({ status: 'paused', family_name: 'Camiseta Lisa', user_product_id: 'MLBU-A' }),
    );

    expect(db.docData(memberVarPath('childA'), 'v-childA')).toMatchObject({
      userProductId: 'MLBU-A',
    });
    expect(db.docData(LINK_PATH, 'link1')).not.toHaveProperty('userProductId');
    // And it must not leak onto the SIBLING either.
    expect(db.docData(memberVarPath('childB'), 'v-childB')).not.toHaveProperty('userProductId');
  });

  it('a member userProductId alone makes the member changed, even with an identical status', async () => {
    const db = new FakeDb();
    seedFamily(db, [
      { itemId: MEMBER_A, child: 'childA' },
      { itemId: MEMBER_B, child: 'childB' },
    ]);

    const out = await syncItemStatus(
      asDb(db),
      CONTA,
      MEMBER_A,
      resolverFor({ status: 'active', family_name: 'Camiseta Lisa', user_product_id: 'MLBU-A' }),
    );

    // The family summary did not move (both members already active), but the
    // member's identity was recorded.
    expect(out).toBe('synced-member');
    expect(db.docData(memberVarPath('childA'), 'v-childA')).toMatchObject({
      userProductId: 'MLBU-A',
    });
  });
});

/**
 * #1087. The complaint: ML pauses a listing for a policy reason, the ERP records
 * `status: 'paused'` and nothing else, and the operator sees a dead anúncio with
 * no idea what to fix — while ML published the reason the whole time.
 *
 * The invariant every test here defends: `moderacoes` is written in the SAME
 * patch as the status it explains, on every status write, value or `[]`. A
 * reason cannot outlive the state it describes, because they are one write.
 */
describe('syncItemStatus — ML moderations (#1087)', () => {
  it('persists the reason AND the remedy when ML has moderated the listing', async () => {
    const db = new FakeDb();
    seedLink(db);
    const resolve = resolverFor({ status: 'under_review', sub_status: ['waiting_for_patch'] }, [
      moderacaoMl(),
    ]);

    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolve);

    expect(out).toBe('synced');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({
      estado: 'v',
      status: 'under_review',
      moderacoes: [MODERACAO_ARMAZENADA],
    });
    // The reference is the item id plus ML's element suffix, never a bare id.
    expect((await apiDo(resolve)).getLastModeration).toHaveBeenCalledWith(`${ITEM}-ITM`);
  });

  /**
   * ⚠️ THE HOT-PATH GUARANTEE. `items` fires for every change to every listing
   * the seller owns; if a healthy one started costing a second ML call, this
   * change would have doubled the traffic of the busiest topic in the channel.
   */
  it('spends NO moderation call on a healthy listing', async () => {
    const db = new FakeDb();
    seedLink(db, { status: 'paused' });
    const resolve = resolverFor({ status: 'active', sub_status: [] });

    expect(await syncItemStatus(asDb(db), CONTA, ITEM, resolve)).toBe('synced');
    expect((await apiDo(resolve)).getLastModeration).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ The case that made this a separate field instead of a reuse of `errors`.
   * `active` + `poor_quality_thumbnail` is LIVE and sendable, so the #781 re-arm
   * fires on the same write — and `errors` is cleared by it. A moderation stored
   * there would have been wiped by the very write that produced it. Here BOTH
   * happen and neither destroys the other.
   */
  it('keeps the moderation on an ACTIVE listing while still clearing the stock latch', async () => {
    const db = new FakeDb();
    seedLink(db, { estado: 'E', status: 'active', errors: ['ML 400: invalid quantity'] });
    const resolve = resolverFor({ status: 'active', sub_status: ['poor_quality_thumbnail'] }, [
      moderacaoMl({ name: 'WATERMARK' }),
    ]);

    expect(await syncItemStatus(asDb(db), CONTA, ITEM, resolve)).toBe('synced');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({
      estado: 'p',
      errors: [], // the latch cleared…
      causas: [],
      moderacoes: [{ ...MODERACAO_ARMAZENADA, nome: 'WATERMARK' }], // …and the reason survived
    });
  });

  it('reads a 404 from last_moderation as "not moderated", not as item-gone', async () => {
    const db = new FakeDb();
    seedLink(db);
    // `SEM_MODERACAO` is the default; naming it here is the point of the test.
    const resolve = resolverFor(
      { status: 'under_review', sub_status: ['held'] },
      new MercadoLivreHttpError('ML 404: not found', 404, null),
    );

    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolve);

    expect(out).toBe('synced'); // NOT 'item-gone' — the ITEM is fine
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'v', moderacoes: [] });
  });

  /**
   * Nothing was confirmed, so nothing may be recorded. Writing `moderacoes: []`
   * after a failed read would persist "not moderated" — indistinguishable from a
   * healthy listing, which is exactly the state this feature exists to end.
   */
  it('a transient moderation failure THROWS and writes nothing at all', async () => {
    const db = new FakeDb();
    seedLink(db);
    const resolve = resolverFor(
      { status: 'under_review', sub_status: [] },
      new MercadoLivreHttpError('ML 500: boom', 500, null),
    );

    await expect(syncItemStatus(asDb(db), CONTA, ITEM, resolve)).rejects.toThrow(/500/);
    expect(db.updates).toEqual([]);
    // Not even the status half landed — the two move together or not at all.
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'p', status: 'active' });
  });

  /**
   * ⚠️ THE FAILURE MODE THAT MATTERS. A stale reason on a healthy listing is
   * indistinguishable from a real one, so it is WORSE than no reason at all —
   * the operator edits a listing that has nothing wrong with it.
   *
   * Note what this test would look like without the `moderacoesChanged` term in
   * `linkChanged`: estado/status/sub_status all already match, so the sync would
   * short-circuit on `unchanged` and the moderation would stand forever.
   */
  it('CLEARS a lifted moderation even when nothing else about the listing moved', async () => {
    const db = new FakeDb();
    seedLink(db, {
      estado: 'p',
      status: 'active',
      sub_status: ['x'],
      moderacoes: [MODERACAO_ARMAZENADA],
    });
    const resolve = resolverFor({ status: 'active', sub_status: ['x'] });

    const out = await syncItemStatus(asDb(db), CONTA, ITEM, resolve);

    expect(out).toBe('synced');
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ moderacoes: [] });
  });

  it('converges: a moderated listing re-delivered unchanged writes nothing', async () => {
    // The counterpart of the clearing test. A naive "moderations present ⇒
    // changed" would rewrite the doc on every single `items` delivery.
    const db = new FakeDb();
    seedLink(db, {
      estado: 'v',
      status: 'under_review',
      sub_status: ['waiting_for_patch'],
      moderacoes: [MODERACAO_ARMAZENADA],
    });
    const resolve = resolverFor({ status: 'under_review', sub_status: ['waiting_for_patch'] }, [
      moderacaoMl(),
    ]);

    expect(await syncItemStatus(asDb(db), CONTA, ITEM, resolve)).toBe('unchanged');
    expect(db.updates).toEqual([]);
  });

  it('a removed listing stores the REASON with remedio null — no fix is implied', async () => {
    const db = new FakeDb();
    seedLink(db);
    const resolve = resolverFor({ status: 'under_review', sub_status: ['forbidden'] }, [
      moderacaoMl({
        name: 'DENYLIST',
        wordings: [{ type: 'REASON', value: 'Seu anúncio foi cancelado por falsificação.' }],
      }),
    ]);

    await syncItemStatus(asDb(db), CONTA, ITEM, resolve);

    const stored = db.docData(LINK_PATH, 'link1')?.moderacoes as Array<Record<string, unknown>>;
    expect(stored[0]).toMatchObject({ nome: 'DENYLIST', remedio: null });
  });

  it('a migration-tagged listing is never charged for a moderation it cannot store', async () => {
    // Those branches stamp `estado: 'am'` and return without a status merge, so
    // a moderation would have nowhere to go.
    const db = new FakeDb();
    seedLink(db);
    const resolve = resolverFor({
      status: 'under_review',
      sub_status: ['waiting_for_patch'],
      tags: ['variations_migration_uptin'],
    });

    expect(await syncItemStatus(asDb(db), CONTA, ITEM, resolve)).toBe('deferred-migration-uptin');
    expect((await apiDo(resolve)).getLastModeration).not.toHaveBeenCalled();
  });
});

/**
 * #1087 × #1142. A family's `moderacoes` must describe the SAME listing its
 * `status` does. The member's own reading lands on its own link; the parent takes
 * the fold WINNER's — never a union, and never one member speaking for all.
 */
describe('syncItemStatus — moderations on a User-Products family', () => {
  it("records the notified member's moderation on ITS link, and folds it up", async () => {
    const db = new FakeDb();
    seedFamily(db, [
      { itemId: MEMBER_A, child: 'childA' },
      { itemId: MEMBER_B, child: 'childB', status: 'closed' },
    ]);
    const resolve = resolverFor({ status: 'active', sub_status: ['poor_quality_thumbnail'] }, [
      moderacaoMl(),
    ]);

    const out = await syncItemStatus(asDb(db), CONTA, MEMBER_A, resolve);

    expect(out).toBe('synced-family');
    // The member's own link carries it…
    expect(db.docData(memberVarPath('childA'), 'v-childA')).toMatchObject({
      moderacoes: [MODERACAO_ARMAZENADA],
    });
    // …and the family takes it, because this member won the fold (active > closed).
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({
      status: 'active',
      moderacoes: [MODERACAO_ARMAZENADA],
    });
  });

  /**
   * The notified member is NOT the winner here: it is under review while a
   * sibling is active. Its moderation is still recorded on its own link — that is
   * real information about that listing — but must not reach the parent, which is
   * reporting the sibling.
   */
  it("does NOT give the family a losing member's moderation", async () => {
    const db = new FakeDb();
    seedFamily(db, [
      { itemId: MEMBER_A, child: 'childA' },
      { itemId: MEMBER_B, child: 'childB', status: 'active' },
    ]);
    const resolve = resolverFor({ status: 'under_review', sub_status: ['forbidden'] }, [
      moderacaoMl({ name: 'DENYLIST' }),
    ]);

    const out = await syncItemStatus(asDb(db), CONTA, MEMBER_A, resolve);

    expect(db.docData(memberVarPath('childA'), 'v-childA')).toMatchObject({
      status: 'under_review',
      moderacoes: [{ nome: 'DENYLIST' }],
    });
    // The sibling is `active` and outranks `under_review`, so the family reports
    // the sibling — and therefore the sibling's (absent) moderation.
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ status: 'active' });
    expect(db.docData(LINK_PATH, 'link1')?.moderacoes ?? []).toEqual([]);
    // ⚠️ `synced-member`, not `synced-family`, and the distinction is the proof:
    // it means the family's summary did not move AT ALL. Had the losing member's
    // DENYLIST leaked upward, the parent would have changed and this would read
    // `synced-family`. The outcome union is doing the assertion work here.
    expect(out).toBe('synced-member');
  });

  it("folds a SIBLING's stored moderation up without any extra ML call", async () => {
    // The whole reason moderations are stored per member: the family's answer is
    // assembled from values already on disk, one notification reads one moderation.
    const db = new FakeDb();
    seedFamily(db, [
      { itemId: MEMBER_A, child: 'childA', status: 'closed' },
      {
        itemId: MEMBER_B,
        child: 'childB',
        status: 'active',
        sub: ['poor_quality_thumbnail'],
        moderacoes: [MODERACAO_ARMAZENADA],
      },
    ]);
    const resolve = resolverFor({ status: 'closed', sub_status: null });

    await syncItemStatus(asDb(db), CONTA, MEMBER_A, resolve);

    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({
      status: 'active',
      moderacoes: [MODERACAO_ARMAZENADA],
    });
    // One notification, one moderation read — and it was for the NOTIFIED member,
    // which here is `closed` and needed none at all.
    expect((await apiDo(resolve)).getLastModeration).not.toHaveBeenCalled();
  });

  it('a lifted moderation clears off BOTH the member and the family', async () => {
    const db = new FakeDb();
    seedFamily(
      db,
      [
        {
          itemId: MEMBER_A,
          child: 'childA',
          sub: ['poor_quality_thumbnail'],
          moderacoes: [MODERACAO_ARMAZENADA],
        },
      ],
      { sub_status: ['poor_quality_thumbnail'], moderacoes: [MODERACAO_ARMAZENADA] },
    );
    const resolve = resolverFor({ status: 'active', sub_status: [] });

    await syncItemStatus(asDb(db), CONTA, MEMBER_A, resolve);

    expect(db.docData(memberVarPath('childA'), 'v-childA')?.moderacoes).toEqual([]);
    expect(db.docData(LINK_PATH, 'link1')?.moderacoes).toEqual([]);
  });
});

/**
 * `reverificarAnuncio`'s guarantee, which the fold does NOT share by default.
 *
 * A re-verification is the operator saying "tell me the truth now", so a stale
 * diagnosis must not survive the button press. The webhook has no such promise —
 * it fires unprompted and only re-arms a listing ML says can take stock again —
 * so the family path inherited the wrong rule until this flag existed.
 */
describe('applyFamilyStatusAndFold — limparFalhaSempre (#1142)', () => {
  const membroObservado = (status: string, subStatus: string[] = []) => ({
    memberProdutoId: 'childA',
    memberDocId: 'v-childA',
    status,
    subStatus,
    moderacoes: null,
    userProductId: null,
  });

  const alvo = { produtoId: PRODUTO, linkDocId: 'link1', pmlOuterRef: FAMILY_PML_REF };

  it('clears a stale diagnosis the WEBHOOK rule would have left standing', async () => {
    // `paused` WITHOUT `out_of_stock` is not sendable, so the webhook's
    // `errorsToClear` is false and the operator would keep reading the old fault.
    const db = new FakeDb();
    seedFamily(db, [{ itemId: MEMBER_A, child: 'childA' }], {
      estado: 'E',
      errors: ['ML 400: invalid quantity'],
      causas: [{ mensagem: 'algo' }],
    });

    await applyFamilyStatusAndFold(asDb(db), CONTA, alvo, [membroObservado('paused')], {
      limparFalhaSempre: true,
    });

    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ errors: [], causas: [] });
  });

  it('⚠️ clears it even when the fold CANNOT conclude and writes nothing else', async () => {
    // The case the early return used to swallow: an unobserved sibling means no
    // summary, so without forcing the write the clear never lands at all.
    const db = new FakeDb();
    seedFamily(db, [
      { itemId: MEMBER_A, child: 'childA' },
      // Never observed, and closed-only observations cannot conclude.
      { itemId: MEMBER_B, child: 'childB', status: null },
    ]);
    db.seed(LINK_PATH, 'link1', {
      ...db.docData(LINK_PATH, 'link1'),
      estado: 'E',
      errors: ['ML 400: invalid quantity'],
      causas: [{ mensagem: 'algo' }],
    });

    await applyFamilyStatusAndFold(asDb(db), CONTA, alvo, [membroObservado('closed')], {
      limparFalhaSempre: true,
    });

    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ errors: [], causas: [] });
    // …and the family is NOT cancelled on one member's closed reading.
    expect(db.docData(LINK_PATH, 'link1')).toMatchObject({ estado: 'E' });
  });

  it('⚠️ WITHOUT the flag the webhook rule is unchanged — a stale fault survives', async () => {
    // The inverse, and what keeps the flag from being a silent behaviour change
    // for the `items` webhook: same family, same reading, no flag.
    const db = new FakeDb();
    seedFamily(db, [{ itemId: MEMBER_A, child: 'childA' }], {
      estado: 'E',
      errors: ['ML 400: invalid quantity'],
    });

    await applyFamilyStatusAndFold(asDb(db), CONTA, alvo, [membroObservado('paused')]);

    expect(db.docData(LINK_PATH, 'link1')?.errors).toEqual(['ML 400: invalid quantity']);
  });
});
