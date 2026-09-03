/**
 * #824 / ADR 0011 tier 3 — `saveRecord` is the ERP's UNIVERSAL save (every
 * `ObjectView` screen: clientes, produtos, filiais, operação, depósito, listas
 * de preço, tabelas de medidas…), and its transaction used to contain ZERO
 * `tx.get` calls.
 *
 * A client-SDK transaction with an empty read set has no version to compare at
 * commit, so it can never abort — it was a `WriteBatch` with extra latency.
 * Every value written was computed outside it: the dirty patch, the ref, the
 * siblings, the stamps.
 *
 * The concrete loss the guard has to catch is a MAP field, because `pickDirty`
 * copies the whole top-level value when react-hook-form marks any descendant
 * dirty. `produtoSchema.precos` is one key holding a map keyed by lista id, so
 * two operators editing two different price lists collide on it:
 *
 *   T0  A and B both open produto P — precos { varejo: 100, atacado: 80 }
 *   T1  A edits `varejo`  → commits { varejo: 120, atacado: 80 }
 *   T2  B edits `atacado` → commits { varejo: 100, atacado: 90 }
 *   ⇒   A's 120 is silently reverted; no error, no toast, and A's onSnapshot
 *       repaints 100.
 *
 * And the second writer is not only human: `onProdutoChanged` propagates a
 * parent's `precos` onto every variation child, its own comment conceding that
 * a child edit racing it loses.
 *
 * The FakeDb is a browser-SDK adapter (`runTransaction(db, cb)`,
 * `snap.exists()` as a METHOD) over the shared `OccEngine`
 * (`@delfrance/data/testing`) — the same engine the Mercado Livre and WhatsApp
 * fakes use, so the OCC semantics cannot drift between them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OccEngine, type OccTransaction } from '@delfrance/data/testing';
import type { CollectionHandle } from '@delfrance/data';

const DOC_PATH = 'produtos/P1';

type Doc = Record<string, unknown>;

class FakeDb {
  private readonly docs = new Map<string, Doc>();

  readonly occ = new OccEngine({
    applyWrite: (kind, path, data) => {
      const prev = this.docs.get(path) ?? {};
      this.docs.set(path, kind === 'update' ? { ...prev, ...data } : { ...data });
    },
    applyDelete: (path) => void this.docs.delete(path),
  });

  seed(path: string, doc: Doc): void {
    this.docs.set(path, doc);
  }
  read(path: string): Doc | undefined {
    return this.docs.get(path);
  }

  docRef(path: string) {
    return {
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      get: async () => ({
        exists: () => this.docs.has(path),
        data: () => this.docs.get(path),
      }),
    };
  }
}

const h = vi.hoisted(() => ({
  runTransaction: vi.fn(),
  doc: vi.fn(),
  collection: vi.fn(),
}));

vi.mock('firebase/firestore', () => ({
  runTransaction: (_db: unknown, fn: (tx: OccTransaction) => Promise<unknown>) =>
    h.runTransaction(fn),
  doc: (...a: unknown[]) => h.doc(...a),
  collection: (...a: unknown[]) => h.collection(...a),
}));

const { RecordConflictError, saveRecord } = await import('./saveRecord');

const _schema = z.object({
  nome: z.string().nullable().optional(),
  precos: z.record(z.string(), z.number()).nullable().optional(),
  ultimaModificacao: z.number().nullable().optional(),
});

let db: FakeDb;

function fakeCollection(): CollectionHandle<typeof _schema> {
  return {
    resolvePath: () => 'produtos',
    ref: () => 'COLLECTION_REF' as never,
    docRef: () => db.docRef(DOC_PATH) as never,
    converter: {} as never,
    merge: () => Promise.resolve(),
  };
}

function save(over: Record<string, unknown> = {}) {
  return saveRecord({
    db: {} as never,
    collection: fakeCollection(),
    pathContext: {},
    recordId: 'P1',
    values: { nome: 'P', precos: { varejo: 100, atacado: 90 } },
    dirtyFields: { precos: true },
    currentUserUid: 'u1',
    modifiedAtField: false,
    createdAtField: false,
    ...over,
  } as never);
}

const BASELINE = { nome: 'P', precos: { varejo: 100, atacado: 80 } };

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  db.seed(DOC_PATH, { ...BASELINE });
  h.runTransaction.mockImplementation((fn: (tx: OccTransaction) => Promise<unknown>) =>
    db.occ.runTransaction(fn),
  );
});

describe('saveRecord — tier 3 concurrency guard (#824)', () => {
  it('refuses when another writer changed a field this save writes', async () => {
    // A got there first: `varejo` is now 120.
    db.seed(DOC_PATH, { nome: 'P', precos: { varejo: 120, atacado: 80 } });

    await expect(save({ baseline: BASELINE })).rejects.toBeInstanceOf(RecordConflictError);
    // Nothing was written — A's 120 survives.
    expect(db.read(DOC_PATH)).toEqual({ nome: 'P', precos: { varejo: 120, atacado: 80 } });
  });

  it('carries the remote doc and the colliding field names', async () => {
    db.seed(DOC_PATH, { nome: 'P', precos: { varejo: 120, atacado: 80 } });

    const err = (await save({ baseline: BASELINE }).catch((e: unknown) => e)) as InstanceType<
      typeof RecordConflictError
    >;

    expect(err.fields).toEqual(['precos']);
    expect(err.current).toMatchObject({ precos: { varejo: 120, atacado: 80 } });
    expect(err.missing).toBe(false);
  });

  it('WITHOUT a baseline the same sequence silently reverts the other writer', async () => {
    // The negative control — the pre-#824 behaviour, and the reason the
    // argument is load-bearing rather than decorative.
    db.seed(DOC_PATH, { nome: 'P', precos: { varejo: 120, atacado: 80 } });

    await save();

    expect(db.read(DOC_PATH)).toMatchObject({ precos: { varejo: 100, atacado: 90 } });
  });

  it('commits normally when nobody raced it', async () => {
    await save({ baseline: BASELINE });
    expect(db.read(DOC_PATH)).toMatchObject({ precos: { varejo: 100, atacado: 90 } });
  });

  it('ignores a remote change to a field this save does not write', async () => {
    // Disjointness: `nome` moved, but this patch only carries `precos`.
    db.seed(DOC_PATH, { nome: 'RENOMEADO', precos: { varejo: 100, atacado: 80 } });

    await save({ baseline: BASELINE });

    expect(db.read(DOC_PATH)).toMatchObject({ nome: 'RENOMEADO' });
  });

  it('ignores the stamp fields — the operator never types those', async () => {
    db.seed(DOC_PATH, { ...BASELINE, ultimaModificacao: 999, timestamp: 999 });

    await expect(
      save({ baseline: { ...BASELINE, ultimaModificacao: 1, timestamp: 1 } }),
    ).resolves.toMatchObject({ id: 'P1' });
  });

  it('honours a caller-supplied ignore set (a trigger write-back)', async () => {
    db.seed(DOC_PATH, { nome: 'P', precos: { varejo: 120, atacado: 80 } });

    await expect(
      save({ baseline: BASELINE, ignoreFields: new Set(['precos']) }),
    ).resolves.toMatchObject({ id: 'P1' });
  });

  it('reports a deleted record as missing rather than recreating it', async () => {
    db.seed(DOC_PATH, { ...BASELINE });
    const dbAny = db as unknown as { docs: Map<string, Doc> };
    dbAny.docs.delete(DOC_PATH);

    const err = (await save({ baseline: BASELINE }).catch((e: unknown) => e)) as InstanceType<
      typeof RecordConflictError
    >;

    expect(err).toBeInstanceOf(RecordConflictError);
    expect(err.missing).toBe(true);
    // ⚠️ A `set` would have RESURRECTED it (ADR 0011 trap 6).
    expect(db.read(DOC_PATH)).toBeUndefined();
  });

  it('gives the transaction a real read set — a concurrent commit forces a retry', async () => {
    // The quieter half of the fix. With zero reads the transaction could never
    // abort; now a doc this attempt read, committed by someone else before our
    // commit, makes the engine re-run the callback.
    //
    // ⚠️ The competitor commits THROUGH the engine. A direct `db.seed` would
    // change the stored data without bumping the version the engine checks, so
    // the attempt would sail through and this test would assert nothing.
    let fired = false;
    db.occ.beforeCommit = async () => {
      if (fired) return;
      fired = true;
      db.occ.beforeCommit = null; // …or the competitor re-enters this hook.
      await db.occ.runTransaction(async (tx) => {
        tx.update(db.docRef(DOC_PATH) as never, { outro: 1 });
      });
    };

    await save({ baseline: BASELINE });

    expect(db.occ.txLog.some((e) => e.phase === 'abort')).toBe(true);
    expect(db.read(DOC_PATH)).toMatchObject({ precos: { varejo: 100, atacado: 90 } });
  });
});
