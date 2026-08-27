import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { MercadoLivreError, type MercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import { toOuterRef } from '@delfrance/schemas';

import {
  type UptinMigrationDeps,
  type UptinSourceLink,
  handleUptinMigration,
} from './importMigration';
import { MercadoLivreImportError } from './importCore';

/* ------------------------------ fake Firestore ---------------------------- */
// Adapted from import.test.ts's FakeDb: adds `.delete()` and makes `.update()`
// throw NOT_FOUND (code 5) on a missing doc — real Admin-SDK `.update()`
// semantics, which `stampSourceError`'s tolerate-NOT_FOUND path depends on.

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
    const clauses: Array<[string, unknown]> = [];
    let lim: number | null = null;
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
      },
    };
    return q;
  }

  /**
   * Minimal WriteBatch fake for the atomic prune: queues update/delete thunks
   * against the same fake doc refs and applies them ALL on commit() (the fake
   * doesn't model rollback — atomicity itself is the real SDK's contract).
   */
  batch() {
    const ops: Array<() => Promise<void>> = [];
    return {
      update(ref: { update: (patch: DocData) => Promise<void> }, patch: DocData) {
        ops.push(() => ref.update(patch));
        return this;
      },
      delete(ref: { delete: () => Promise<void> }) {
        ops.push(() => ref.delete());
        return this;
      },
      commit: async () => {
        for (const op of ops) await op();
      },
    };
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
            if (!col.has(docId))
              throw Object.assign(new Error('no document to update'), { code: 5 });
            self.updates.push({ path: `${path}/${docId}`, patch });
            const current = col.get(docId) ?? {};
            const resolved: DocData = { ...current };
            for (const [k, v] of Object.entries(patch)) {
              resolved[k] = resolveFieldValue(current[k], v);
            }
            col.set(docId, resolved);
          },
          delete: async () => {
            col.delete(docId);
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

  // Minimal transaction fake for the taxonomy resolver (#519/#520/#521) that
  // `importProduto` exercises internally — no real isolation/retry, enough for
  // these single-threaded tests (same shape as import.test.ts's FakeDb).
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

/**
 * Resolve one patch field against the CURRENT stored value — expands a real
 * `FieldValue.arrayUnion(...)` sentinel (the legacy denorm writes `import.ts`
 * performs on the SAME produto this module later prunes) into an actual
 * array-union so both writers' effects compose correctly, instead of the
 * simpler import.test.ts FakeDb which only ever inspects the raw patch object
 * and never needs the merged array itself. Dedup is by VALUE (`JSON.stringify`
 * — sufficient for these plain-data fixtures), matching real Firestore
 * `arrayUnion` semantics. Anything else is a plain overwrite.
 */
function resolveFieldValue(existing: unknown, incoming: unknown): unknown {
  if (incoming instanceof FieldValue) {
    const elements = (incoming as unknown as { elements?: unknown[] }).elements;
    if (Array.isArray(elements)) {
      const base = Array.isArray(existing) ? existing : [];
      const next = [...base];
      for (const el of elements) {
        if (!next.some((e) => JSON.stringify(e) === JSON.stringify(el))) next.push(el);
      }
      return next;
    }
    return existing; // an unsupported sentinel — not needed by this module's writes
  }
  return incoming;
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* --------------------------------- fixtures ------------------------------- */

const CONTA = 'conta-A';
const SOURCE_ITEM_ID = 'MLB-SOURCE';
const FAMILY_ID = 'FAM1';
const MEMBER_1_ID = 'MLB-NEW-1';
const MEMBER_2_ID = 'MLB-NEW-2';
const TP1 = 'TP1'; // the source listing's own top-level parent produto
const CHILD_1 = 'childAzulP'; // old variation #1's own produto (SKU-AZUL-P)
const CHILD_2 = 'childVerdeM'; // old variation #2's own produto (SKU-VERDE-M)
const CHILD_3 = 'childRoxoG'; // old variation #3 — used by the partial-migration test only
const SOURCE_PML_DOC_ID = 'sourcePml1';
const OLD_LINK_1 = 'oldLink1';
const OLD_LINK_2 = 'oldLink2';
const OLD_LINK_3 = 'oldLink3';

const sourcePmlOuterRef = toOuterRef(`produtos/${TP1}/produtoMercadoLivre/${SOURCE_PML_DOC_ID}`);

const SOURCE_PML_RAW: DocData = {
  contaOuterRef: `documents/integracao/${CONTA}`,
  id: SOURCE_ITEM_ID,
  title: 'Camiseta Família (legado)',
  estado: 'p',
  status: 'closed',
};

function sourceLink(): UptinSourceLink {
  return { produtoId: TP1, linkDocId: SOURCE_PML_DOC_ID, raw: SOURCE_PML_RAW };
}

/** Seeds the source listing's parent + 2 (optionally 3) old variation children,
 * each with an old `variacaoMercadoLivre` link pointing at the source PML. */
function seedBaseline(db: FakeDb, opts: { withThirdChild?: boolean } = {}): void {
  db.seed('produtos', TP1, {
    nome: 'Camiseta Família (legado)',
    sku: null,
    paiId: null,
    marketplace: [{ integracaoUid: CONTA, externalId: SOURCE_ITEM_ID }],
    marketplaceIds: [SOURCE_ITEM_ID],
    integracoesComProduto: [CONTA],
    statusProdutosMarketplace: {},
  });
  db.seed(`produtos/${TP1}/produtoMercadoLivre`, SOURCE_PML_DOC_ID, { ...SOURCE_PML_RAW });

  db.seed('produtos', CHILD_1, { nome: 'Camiseta Azul P', sku: 'SKU-AZUL-P', paiId: TP1 });
  db.seed('produtos', CHILD_2, { nome: 'Camiseta Verde M', sku: 'SKU-VERDE-M', paiId: TP1 });
  db.seed(`produtos/${CHILD_1}/variacaoMercadoLivre`, OLD_LINK_1, {
    id: 1001,
    itemId: null,
    produtoVariacaoOuterRef: toOuterRef(`produtos/${CHILD_1}`),
    produtoMercadoLivreOuterRef: sourcePmlOuterRef,
    sku: 'SKU-AZUL-P',
  });
  db.seed(`produtos/${CHILD_2}/variacaoMercadoLivre`, OLD_LINK_2, {
    id: 1002,
    itemId: null,
    produtoVariacaoOuterRef: toOuterRef(`produtos/${CHILD_2}`),
    produtoMercadoLivreOuterRef: sourcePmlOuterRef,
    sku: 'SKU-VERDE-M',
  });

  if (opts.withThirdChild) {
    db.seed('produtos', CHILD_3, { nome: 'Camiseta Roxa G', sku: 'SKU-ROXO-G', paiId: TP1 });
    db.seed(`produtos/${CHILD_3}/variacaoMercadoLivre`, OLD_LINK_3, {
      id: 1003,
      itemId: null,
      produtoVariacaoOuterRef: toOuterRef(`produtos/${CHILD_3}`),
      produtoMercadoLivreOuterRef: sourcePmlOuterRef,
      sku: 'SKU-ROXO-G',
    });
  }
}

const MEMBER_1: DocData = {
  id: MEMBER_1_ID,
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
  attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-AZUL-P' }],
  attribute_combinations: [{ id: 'COLOR', name: 'Cor', value_id: '1', value_name: 'Azul' }],
};
const MEMBER_2: DocData = {
  ...MEMBER_1,
  id: MEMBER_2_ID,
  attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-VERDE-M' }],
  attribute_combinations: [{ id: 'COLOR', name: 'Cor', value_id: '2', value_name: 'Verde' }],
};

function makeMigrationApi(opts: {
  newItems: Array<{ new_item_id: string | number | null; variation_id: number | string | null }>;
  items?: Record<string, DocData>;
}): MercadoLivreApi {
  const items = opts.items ?? {};
  return {
    getMigrationLiveListing: vi.fn(async () => ({ new_items: opts.newItems })),
    getItem: vi.fn(async (id: string) => {
      const it = items[id];
      if (!it) throw new MercadoLivreError(`item não encontrado: ${id}`);
      return it;
    }),
    getItemDescription: vi.fn(async () => ({ plain_text: 'Descrição' })),
    getCategory: vi.fn(async () => ({ id: 'MLB1430', name: 'Roupas' })),
  } as unknown as MercadoLivreApi;
}

function migrationDeps(db: FakeDb, api: MercadoLivreApi): UptinMigrationDeps {
  return {
    db: asDb(db),
    api,
    integracaoId: CONTA,
    sellerUserId: 55,
    tabelaNormalOuterRef: 'documents/tabelasDePrecos/tabNormal',
    depositoOuterRef: 'documents/depositos/dep1',
  };
}

const expectedFamilyLinkId = `100000000000000000${FAMILY_ID}`;

beforeEach(() => {
  vi.restoreAllMocks();
});

/**
 * Every test below drives the REAL `importProduto` (via `handleUptinMigration`)
 * with `upParentOverride` set — `import.ts`'s `resolveUpParentOverride` (#441)
 * forces the UP family parent onto the override produto instead of running
 * `resolveExistingUpParent`'s cascade. See importMigration.ts's module doc for
 * the full derivation of why `upParentOverride.produtoId` must be
 * `sourceLink.produtoId` (the source listing's OWN top-level parent), not the
 * resolved OLD variation's own produto.
 */
describe('handleUptinMigration — fresh migration', () => {
  it('imports every new member onto the source listing’s own parent — continuity + full prune', async () => {
    const db = new FakeDb();
    seedBaseline(db);
    const api = makeMigrationApi({
      newItems: [
        { new_item_id: MEMBER_1_ID, variation_id: 1001 },
        { new_item_id: MEMBER_2_ID, variation_id: 1002 },
      ],
      items: { [MEMBER_1_ID]: MEMBER_1, [MEMBER_2_ID]: MEMBER_2 },
    });

    await handleUptinMigration(migrationDeps(db, api), SOURCE_ITEM_ID, sourceLink());

    // family PML minted UNDER the source listing's OWN parent produto (TP1) —
    // no brand-new "family" produto was created.
    expect(db.docs('produtos').size).toBe(3); // TP1 + CHILD_1 + CHILD_2, unchanged
    const familyPml = db.docs(`produtos/${TP1}/produtoMercadoLivre`).get(expectedFamilyLinkId);
    expect(familyPml).toMatchObject({ id: FAMILY_ID, isUserProductModel: true });

    // both old variation children reused as the new members' own child (SKU +
    // paiId==TP1 continuity) — asserted via the OLD produto ids still existing
    // and no additional produtos having been minted (checked above).
    expect(db.docs('produtos').get(CHILD_1)).toMatchObject({ sku: 'SKU-AZUL-P' });
    expect(db.docs('produtos').get(CHILD_2)).toMatchObject({ sku: 'SKU-VERDE-M' });

    // fully migrated → old links + source PML pruned.
    expect(db.docs(`produtos/${CHILD_1}/variacaoMercadoLivre`).has(OLD_LINK_1)).toBe(false);
    expect(db.docs(`produtos/${CHILD_2}/variacaoMercadoLivre`).has(OLD_LINK_2)).toBe(false);
    expect(db.docs(`produtos/${TP1}/produtoMercadoLivre`).has(SOURCE_PML_DOC_ID)).toBe(false);

    // parent denorm cleaned: the OLD (source-listing) marketplace entry is gone
    // and stamped deleted under the MATCHED entry's own key (models.dart's
    // `toStatusKey`) — but TP1's OWN entry for the family it now hosts (stamped
    // by `importProduto`'s own legacy denorm write, `relevantData.isUserProductModel`)
    // correctly SURVIVES the cleanup (a DIFFERENT externalId, no match).
    const tp1 = db.docs('produtos').get(TP1)!;
    const marketplace = tp1.marketplace as Array<Record<string, unknown>>;
    expect(marketplace).toHaveLength(1);
    expect(marketplace[0]).toMatchObject({
      integracaoUid: CONTA,
      externalId: FAMILY_ID,
      relevantData: { isUserProductModel: true },
    });
    expect(tp1.marketplaceIds).toEqual([FAMILY_ID]);
    // Unchanged, and since #920 for a different reason: the prune no longer
    // recomputes this array from `marketplace` (that derivation was #431 lock 2,
    // and it wrote path-form ids no reader could match). The value here is the
    // seeded one, passed through untouched — `onProdutoMercadoLivreLinkChanged`
    // reacts to the source link this prune deletes in the same batch.
    expect(tp1.integracoesComProduto).toEqual([CONTA]);
    expect(
      (tp1.statusProdutosMarketplace as Record<string, unknown>)[`${CONTA}_${SOURCE_ITEM_ID}`],
    ).toMatchObject({ deleted: true, error: false, enviarEstoque: false });
  });
});

describe('handleUptinMigration — partial migration', () => {
  it('does NOT prune the source PML/denorm while a sibling variation is still unmigrated, but still deletes the processed old links', async () => {
    const db = new FakeDb();
    seedBaseline(db, { withThirdChild: true }); // CHILD_3/OLD_LINK_3 (variation 1003) never appears in new_items
    const api = makeMigrationApi({
      newItems: [
        { new_item_id: MEMBER_1_ID, variation_id: 1001 },
        { new_item_id: MEMBER_2_ID, variation_id: 1002 },
      ],
      items: { [MEMBER_1_ID]: MEMBER_1, [MEMBER_2_ID]: MEMBER_2 },
    });

    await handleUptinMigration(migrationDeps(db, api), SOURCE_ITEM_ID, sourceLink());

    // processed old links (1001/1002) deleted regardless of the sibling being pending.
    expect(db.docs(`produtos/${CHILD_1}/variacaoMercadoLivre`).has(OLD_LINK_1)).toBe(false);
    expect(db.docs(`produtos/${CHILD_2}/variacaoMercadoLivre`).has(OLD_LINK_2)).toBe(false);

    // NOT fully migrated → source PML + its denorm entry SURVIVE, and the
    // still-pending sibling's old link is untouched.
    expect(db.docs(`produtos/${TP1}/produtoMercadoLivre`).has(SOURCE_PML_DOC_ID)).toBe(true);
    expect(db.docs(`produtos/${CHILD_3}/variacaoMercadoLivre`).has(OLD_LINK_3)).toBe(true);

    // no prune → the SOURCE listing's own denorm entry is untouched (still
    // present alongside the family entry `importProduto` added while importing
    // the two covered members).
    const tp1 = db.docs('produtos').get(TP1)!;
    const marketplace = tp1.marketplace as Array<Record<string, unknown>>;
    expect(marketplace).toContainEqual({ integracaoUid: CONTA, externalId: SOURCE_ITEM_ID });
  });
});

describe('handleUptinMigration — replay idempotency', () => {
  it('crash-retry: registered members with SURVIVING old links re-enqueue them and the prune converges', async () => {
    const db = new FakeDb();
    seedBaseline(db);
    // Simulate a PRIOR run that already imported both members under the family PML.
    db.seed(`produtos/${TP1}/produtoMercadoLivre`, expectedFamilyLinkId, {
      contaOuterRef: `documents/integracao/${CONTA}`,
      id: FAMILY_ID,
      title: 'Camiseta Família',
      estado: 'am',
      isUserProductModel: false,
    });
    const familyPmlOuterRef = toOuterRef(
      `produtos/${TP1}/produtoMercadoLivre/${expectedFamilyLinkId}`,
    );
    db.seed(`produtos/${CHILD_1}/variacaoMercadoLivre`, 'newLink1', {
      itemId: MEMBER_1_ID,
      id: null,
      produtoVariacaoOuterRef: toOuterRef(`produtos/${CHILD_1}`),
      produtoMercadoLivreOuterRef: familyPmlOuterRef,
      sku: 'SKU-AZUL-P',
    });
    db.seed(`produtos/${CHILD_2}/variacaoMercadoLivre`, 'newLink2', {
      itemId: MEMBER_2_ID,
      id: null,
      produtoVariacaoOuterRef: toOuterRef(`produtos/${CHILD_2}`),
      produtoMercadoLivreOuterRef: familyPmlOuterRef,
      sku: 'SKU-VERDE-M',
    });

    const api = makeMigrationApi({
      newItems: [
        { new_item_id: MEMBER_1_ID, variation_id: 1001 },
        { new_item_id: MEMBER_2_ID, variation_id: 1002 },
      ],
      items: { [MEMBER_1_ID]: MEMBER_1, [MEMBER_2_ID]: MEMBER_2 },
    });

    await handleUptinMigration(migrationDeps(db, api), SOURCE_ITEM_ID, sourceLink());

    // no import — every member was already registered.
    expect(api.getItem).not.toHaveBeenCalled();

    // family PML stamped publicado (ONE write — both members share it).
    expect(db.docs(`produtos/${TP1}/produtoMercadoLivre`).get(expectedFamilyLinkId)).toMatchObject({
      estado: 'p',
      isUserProductModel: true,
    });

    // CONVERGENCE (Copilot review, #617): this seeding IS the crash-retry
    // scenario — a prior run imported both members but died before the prune
    // batch (old links + source PML still present). The retry must re-locate
    // the stale old links off the registered members and finish the prune,
    // or `fullyMigrated` could never become true.
    expect(db.docs(`produtos/${CHILD_1}/variacaoMercadoLivre`).has(OLD_LINK_1)).toBe(false);
    expect(db.docs(`produtos/${CHILD_2}/variacaoMercadoLivre`).has(OLD_LINK_2)).toBe(false);
    expect(db.docs(`produtos/${TP1}/produtoMercadoLivre`).has(SOURCE_PML_DOC_ID)).toBe(false);
  });

  it('partial family: registered members whose old links are ALREADY gone stay stamp-only (no prune)', async () => {
    const db = new FakeDb();
    // Third child = a sibling variation NOT covered by new_items — the source
    // listing is genuinely not fully migrated yet.
    seedBaseline(db, { withThirdChild: true });
    // A prior PARTIAL run already imported member 1 AND deleted its old link
    // (the unconditional delete loop) — so the retry's best-effort re-locate
    // finds nothing for it: genuinely stamp-only, and the prune gate stays
    // closed because of the uncovered third sibling.
    db.docs(`produtos/${CHILD_1}/variacaoMercadoLivre`).delete(OLD_LINK_1);
    db.seed(`produtos/${TP1}/produtoMercadoLivre`, expectedFamilyLinkId, {
      contaOuterRef: `documents/integracao/${CONTA}`,
      id: FAMILY_ID,
      title: 'Camiseta Família',
      estado: 'am',
      isUserProductModel: false,
    });
    db.seed(`produtos/${CHILD_1}/variacaoMercadoLivre`, 'newLink1', {
      itemId: MEMBER_1_ID,
      id: null,
      produtoVariacaoOuterRef: toOuterRef(`produtos/${CHILD_1}`),
      produtoMercadoLivreOuterRef: toOuterRef(
        `produtos/${TP1}/produtoMercadoLivre/${expectedFamilyLinkId}`,
      ),
      sku: 'SKU-AZUL-P',
    });

    const api = makeMigrationApi({
      newItems: [{ new_item_id: MEMBER_1_ID, variation_id: 1001 }],
    });

    await handleUptinMigration(migrationDeps(db, api), SOURCE_ITEM_ID, sourceLink());

    expect(api.getItem).not.toHaveBeenCalled();
    expect(db.docs(`produtos/${TP1}/produtoMercadoLivre`).get(expectedFamilyLinkId)).toMatchObject({
      estado: 'p',
      isUserProductModel: true,
    });
    // No prune: nothing was queued (member 1's old link already gone) and the
    // third sibling's old link keeps the fully-migrated gate closed anyway.
    expect(db.docs(`produtos/${TP1}/produtoMercadoLivre`).has(SOURCE_PML_DOC_ID)).toBe(true);
    expect(db.docs(`produtos/${CHILD_2}/variacaoMercadoLivre`).has(OLD_LINK_2)).toBe(true);
  });
});

describe('handleUptinMigration — missing old variation', () => {
  it('throws MercadoLivreImportError and stamps the source PML estado=E', async () => {
    const db = new FakeDb();
    seedBaseline(db);
    const api = makeMigrationApi({
      newItems: [{ new_item_id: 'MLB-ORPHAN', variation_id: 9999 }], // no such old link
    });

    await expect(
      handleUptinMigration(migrationDeps(db, api), SOURCE_ITEM_ID, sourceLink()),
    ).rejects.toThrow(MercadoLivreImportError);

    expect(db.docs(`produtos/${TP1}/produtoMercadoLivre`).get(SOURCE_PML_DOC_ID)).toMatchObject({
      estado: 'E',
    });
  });

  it('still throws the ORIGINAL error when the source PML was already deleted (tolerates NOT_FOUND on the stamp)', async () => {
    const db = new FakeDb();
    seedBaseline(db);
    db.docs(`produtos/${TP1}/produtoMercadoLivre`).delete(SOURCE_PML_DOC_ID); // pre-deleted (e.g. a prior crashed attempt)
    const api = makeMigrationApi({
      newItems: [{ new_item_id: 'MLB-ORPHAN', variation_id: 9999 }],
    });

    await expect(
      handleUptinMigration(migrationDeps(db, api), SOURCE_ITEM_ID, sourceLink()),
    ).rejects.toThrow(MercadoLivreImportError);
  });

  it('a null/unparseable variation_id on a not-yet-imported item also throws MercadoLivreImportError', async () => {
    const db = new FakeDb();
    seedBaseline(db);
    const api = makeMigrationApi({
      newItems: [{ new_item_id: 'MLB-ORPHAN', variation_id: null }],
    });

    await expect(
      handleUptinMigration(migrationDeps(db, api), SOURCE_ITEM_ID, sourceLink()),
    ).rejects.toThrow(MercadoLivreImportError);
  });
});

describe('handleUptinMigration — unusable new_items entries', () => {
  it('skips an entry with no usable new_item_id without throwing', async () => {
    const db = new FakeDb();
    seedBaseline(db);
    const api = makeMigrationApi({
      newItems: [{ new_item_id: null, variation_id: 1001 }],
    });

    await expect(
      handleUptinMigration(migrationDeps(db, api), SOURCE_ITEM_ID, sourceLink()),
    ).resolves.toBeUndefined();
    // nothing imported, nothing pruned — the entry was simply skipped.
    expect(db.docs(`produtos/${TP1}/produtoMercadoLivre`).has(SOURCE_PML_DOC_ID)).toBe(true);
  });
});
