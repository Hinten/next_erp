import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  type MlItem,
} from '@delfrance/integrations-mercado-livre';
import { estoqueMercadoLivreSyncCollection } from '@delfrance/data/admin/collections';

import {
  PAUSE_REENQUEUE_JITTER_MAX_S,
  STOCK_SEND_MAX_ATTEMPTS,
  STOCK_SYNC_FLAG_ENV,
  type StockFamilyRow,
  buildSendTasks,
} from './bulkEstoquePlan';
import { MlTasksDisabledError } from './mlTasks';
import {
  type MlStockSendTask,
  type StockContextLoader,
  type StockSendDeps,
  mlStockSendTaskSchema,
  processStockSendTask,
} from './estoqueSend';

/* ------------------------------ fake Firestore ----------------------------- */
// Doc-level fake: `collection(path).doc(id)` with get / set({ merge }) + an
// opLog. The handler makes no collection queries on the HAPPY path — payloads
// carry the sweep-computed quantities AND the writeback target — so the only
// Firestore surface a successful send touches is the pause-state doc get and the
// two merge writebacks.
//
// The TERMINAL 4xx branch is the exception, and it needs three more capabilities
// (mirroring the fake in itemsStatusSync.test.ts): a whole-collection read (the
// UP member lookup), a collectionGroup query whose docs carry
// `ref.parent.parent.id` (the family sibling read), and a transaction with REAL
// optimistic concurrency — a pass-through would report green for exactly the
// unguarded read-modify-write #707's prune runs inside a transaction to avoid.

type DocData = Record<string, unknown>;

interface FakeSnap {
  exists: boolean;
  id: string;
  data: () => DocData | undefined;
}

interface FakeRef {
  id: string;
  __path: string;
}

interface FakeQuery {
  __isQuery: true;
  get(): Promise<{ docs: FakeQueryDoc[]; empty: boolean; size: number }>;
}

interface FakeQueryDoc {
  id: string;
  __path: string;
  exists: boolean;
  data: () => DocData;
  ref: { id: string; __path: string; parent: { parent: { id: string } } };
}

interface FakeTx {
  get(target: FakeRef | FakeQuery): Promise<unknown>;
  set(ref: FakeRef, data: DocData, opts?: { merge?: boolean }): void;
  update(ref: FakeRef, patch: DocData): void;
}

/** `produtos/<id>/variacaoMercadoLivre` → `<id>`. */
function parentDocId(colPath: string): string {
  const segs = colPath.split('/').filter(Boolean);
  return segs[segs.length - 2] ?? '';
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly opLog: Array<{ op: 'get' | 'set' | 'update'; path: string }> = [];
  /** Document versions — what makes `runTransaction` below a real OCC loop. */
  readonly versions = new Map<string, number>();
  /** Runs inside the read→commit window, so a test can interleave a competing writer. */
  onBeforeCommit: (() => void | Promise<void>) | null = null;

  col(path: string): Map<string, DocData> {
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
  /**
   * A competing writer, for the `onBeforeCommit` race hook: merges a patch AND
   * bumps the version, which is what makes the reading transaction lose at
   * commit. `seed()` deliberately does neither — a seed is initial state, and
   * bumping there would make every transaction retry once.
   */
  raceWrite(path: string, id: string, patch: DocData): void {
    this.col(path).set(id, { ...(this.col(path).get(id) ?? {}), ...patch });
    this.bump(path, id);
  }
  private bump(path: string, id: string): void {
    const k = `${path}/${id}`;
    this.versions.set(k, (this.versions.get(k) ?? 0) + 1);
  }

  private snapOf(entries: Array<[string, DocData, string]>) {
    return {
      docs: entries.map(([id, d, colPath]) => ({
        id,
        __path: colPath,
        exists: true,
        data: () => d,
        ref: { id, __path: colPath, parent: { parent: { id: parentDocId(colPath) } } },
      })),
      empty: entries.length === 0,
      size: entries.length,
    };
  }

  collection(path: string): {
    doc: (id: string) => FakeDocRef;
    get: () => Promise<{ docs: FakeQueryDoc[]; empty: boolean; size: number }>;
  } {
    const self = this;
    return {
      // The UP member lookup reads the CHILD's whole `variacaoMercadoLivre`
      // subcollection and filters in code — no `where`, hence no index.
      get: async () => {
        self.opLog.push({ op: 'get', path });
        return self.snapOf([...self.col(path)].map(([id, d]) => [id, d, path]));
      },
      doc(id: string): FakeDocRef {
        const col = self.col(path);
        return {
          id,
          __path: path,
          get: async () => {
            self.opLog.push({ op: 'get', path: `${path}/${id}` });
            return { exists: col.has(id), id, data: () => col.get(id) };
          },
          set: (data: DocData, opts?: { merge?: boolean }) => {
            self.opLog.push({ op: 'set', path: `${path}/${id}` });
            if (opts?.merge) col.set(id, { ...(col.get(id) ?? {}), ...data });
            else col.set(id, { ...data });
            self.bump(path, id);
          },
          // `update()` backs both the parent-denorm arm of `applyItemStatusToLink`
          // and every `mergeIfExists` link writeback. The missing-doc failure
          // MUST carry gRPC code 5, because that is what `isNotFound` narrows on
          // — a bare Error would make `mergeIfExists` rethrow instead of
          // resolving false, and the ghost-doc regression would go unnoticed.
          // FieldValue sentinels are stored verbatim (the denorm's own semantics
          // are covered in itemsStatusSync.test.ts).
          update: async (data: DocData) => {
            self.opLog.push({ op: 'update', path: `${path}/${id}` });
            if (!col.has(id)) {
              throw Object.assign(new Error(`NOT_FOUND: ${path}/${id}`), { code: 5 });
            }
            col.set(id, { ...(col.get(id) ?? {}), ...data });
            self.bump(path, id);
          },
        };
      },
    };
  }

  collectionGroup(groupId: string): FakeQuery {
    const self = this;
    const clauses: Array<[string, unknown]> = [];
    let cap: number | null = null;
    const q: FakeQuery & {
      where: (f: string, op: string, v: unknown) => FakeQuery;
      limit: (n: number) => FakeQuery;
    } = {
      __isQuery: true,
      where(field: string, _op: string, value: unknown) {
        clauses.push([field, value]);
        return q;
      },
      limit(n: number) {
        cap = n;
        return q;
      },
      // ⚠️ Re-evaluated per call, never captured. A transaction retry MUST see
      // what the winning writer committed; a frozen snapshot would make an OCC
      // guard look broken and, worse, make a missing one look fine.
      async get() {
        const entries: Array<[string, DocData, string]> = [];
        for (const [path, col] of self.cols) {
          if (path.split('/').pop() !== groupId) continue;
          for (const [id, d] of col) {
            if (clauses.every(([f, v]) => d[f] === v)) entries.push([id, d, path]);
          }
        }
        return self.snapOf(cap == null ? entries : entries.slice(0, cap));
      },
    };
    return q;
  }

  /**
   * A transaction fake with REAL optimistic concurrency, not a pass-through.
   * Records the version of every document the callback READS and re-checks them
   * at commit; a competing write re-runs the callback against the new state,
   * which is what makes #707's "re-derive the plan from `tx.get`" guard testable
   * rather than decorative. Copied from the fake in itemsStatusSync.test.ts.
   */
  async runTransaction<T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const readVersions = new Map<string, number>();
      const writes: Array<() => void> = [];
      const self = this;
      const note = (path: string, id: string) =>
        readVersions.set(`${path}/${id}`, self.versions.get(`${path}/${id}`) ?? 0);
      const tx: FakeTx = {
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
            const col = self.col(ref.__path);
            col.set(ref.id, opts?.merge ? { ...(col.get(ref.id) ?? {}), ...data } : { ...data });
            self.opLog.push({ op: 'set', path: `${ref.__path}/${ref.id}` });
            self.bump(ref.__path, ref.id);
          });
        },
        update: (ref: FakeRef, patch: DocData) => {
          writes.push(() => {
            const col = self.col(ref.__path);
            if (!col.has(ref.id)) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
            col.set(ref.id, { ...(col.get(ref.id) ?? {}), ...patch });
            self.opLog.push({ op: 'update', path: `${ref.__path}/${ref.id}` });
            self.bump(ref.__path, ref.id);
          });
        },
      };
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
}

interface FakeDocRef {
  id: string;
  __path: string;
  get: () => Promise<FakeSnap>;
  set: (data: DocData, opts?: { merge?: boolean }) => void;
  update: (data: DocData) => Promise<void>;
}

function asDb(db: FakeDb): Firestore {
  return db as unknown as Firestore;
}

/* --------------------------------- helpers --------------------------------- */

const CONTA = 'conta-A';
const DEP_REF = 'documents/depositos/DEP';
const NOW_MS = Date.parse('2026-07-24T12:00:00.000Z');
const NOW_US = NOW_MS * 1000;
/** The 0-based attempt index on which the 4xx branch stops retrying and records. */
const LAST_ATTEMPT = STOCK_SEND_MAX_ATTEMPTS - 1;
/** When "the sweep" computed the payload's quantities — 42s before NOW. */
const SWEEP_MS = NOW_MS - 42_000;

const STATE_PATH = estoqueMercadoLivreSyncCollection.resolvePath({});
const LINK_PATH = 'produtos/PROD/produtoMercadoLivre';

function payload(over: Partial<MlStockSendTask> = {}): MlStockSendTask {
  return {
    integracaoId: CONTA,
    produtoId: 'PROD',
    itemId: 'MLB111',
    kind: 'item',
    variacaoProdutoId: null,
    linkDocId: 'link1',
    quantidade: 10,
    variations: null,
    sweepComputedAtMs: SWEEP_MS,
    sweepId: 'sweep-1',
    reenqueues: 0,
    ...over,
  };
}

/** Seed the writeback-target link doc (only the writeback/error tests need it). */
function seedLink(db: FakeDb, extra: DocData = {}): void {
  db.seed(LINK_PATH, 'link1', {
    contaOuterRef: `documents/integracao/${CONTA}`,
    id: 'MLB111',
    estado: 'p',
    status: 'active',
    sub_status: null,
    isUserProductModel: false,
    ...extra,
  });
}

interface HarnessOpts {
  /** The integração doc the context loader resolves (default: has the depósito). */
  conta?: DocData;
  updateItem?: (id: string, body: Record<string, unknown>) => Promise<MlItem>;
  /** Only the terminal 4xx branch calls this — default: a healthy listing. */
  getItem?: (id: string) => Promise<MlItem>;
  resolveChannelContext?: () => Promise<{ accessToken: string }>;
  jitterSec?: (maxS: number) => number;
  /**
   * Cloud Tasks attempt index. Defaults to 0 — the FIRST attempt, exactly as a
   * fresh dispatch arrives — so a spec that wants the terminal branch has to say
   * `retryCount: LAST_ATTEMPT` out loud.
   */
  retryCount?: number;
}

function makeHarness(opts: HarnessOpts = {}) {
  const db = new FakeDb();
  const updateItem = vi.fn(
    opts.updateItem ??
      (async (_id: string, _body: Record<string, unknown>): Promise<MlItem> => ({
        id: 'MLB111',
        status: 'active',
        sub_status: [],
      })),
  );
  const getItem = vi.fn(
    opts.getItem ??
      (async (_id: string): Promise<MlItem> => ({
        id: 'MLB111',
        status: 'active',
        sub_status: [],
      })),
  );
  const apiFactory = vi.fn((_cfg: { getAccessToken: () => Promise<string> }) => ({
    updateItem,
    getItem,
  }));
  const contextLoader: StockContextLoader = vi.fn(async () => ({
    conta: opts.conta ?? { depositoOuterRef: DEP_REF },
    resolveChannelContext: opts.resolveChannelContext ?? (async () => ({ accessToken: 'tok' })),
  }));
  const enqueue = vi.fn(async () => {});
  const jitterSec = vi.fn(opts.jitterSec ?? ((_maxS: number) => 0));
  const deps: StockSendDeps = {
    scheduler: { enqueue },
    nowMs: NOW_MS,
    contextLoader,
    apiFactory,
    jitterSec,
    retryCount: opts.retryCount ?? 0,
  };
  return { db, deps, enqueue, updateItem, getItem, apiFactory, jitterSec };
}

type Harness = ReturnType<typeof makeHarness>;

function run(h: Harness, p: unknown = payload()) {
  return processStockSendTask(asDb(h.db), p, h.deps);
}

beforeEach(() => {
  // The handler is gated on the master flag (#805), which is unset in this
  // process — without this every spec below would short-circuit into the gate.
  vi.stubEnv(STOCK_SYNC_FLAG_ENV, '1');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // `restoreAllMocks` does NOT unstub envs — both calls are required.
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* ---------------------------------- tests ---------------------------------- */

describe('mlStockSendTaskSchema', () => {
  it('fills the defaults and rejects junk', () => {
    const parsed = mlStockSendTaskSchema.parse({
      integracaoId: CONTA,
      produtoId: 'PROD',
      itemId: 'MLB111',
      kind: 'item',
      linkDocId: 'link1',
      sweepComputedAtMs: SWEEP_MS,
      sweepId: 'sweep-1',
    });
    expect(parsed).toEqual(payload({ quantidade: null }));
    expect(() => mlStockSendTaskSchema.parse({ integracaoId: CONTA })).toThrow();
    expect(() => mlStockSendTaskSchema.parse(payload({ kind: 'family' as never }))).toThrow();
    expect(() => mlStockSendTaskSchema.parse(payload({ quantidade: 1.5 }))).toThrow();
    expect(() =>
      mlStockSendTaskSchema.parse(
        payload({ quantidade: null, variations: [{ id: 101, available_quantity: -1 }] }),
      ),
    ).toThrow();
  });

  it('accepts a buildSendTasks draft verbatim (the sweep-side wire contract)', () => {
    const row: StockFamilyRow = {
      anchorId: 'PROD',
      anchor: {
        produtoId: 'PROD',
        ehKit: false,
        ehKitVirtual: false,
        publicado: true,
        componentesKit: null,
        timestampMs: null,
        estoque: null,
        componentEstoques: [],
      },
      integracoesComProduto: [CONTA],
      links: [
        {
          id: 'MLB111',
          estado: 'p',
          status: 'active',
          sub_status: [],
          isUserProductModel: false,
          linkDocId: 'link1',
        },
      ],
      children: [],
    };
    const built = buildSendTasks(row, new Map([['PROD', 7]]), {
      integracaoId: CONTA,
      sweepId: 'sweep-1',
      sweepComputedAtMs: SWEEP_MS,
    });
    expect(built.skips).toEqual([]);
    expect(built.tasks).toHaveLength(1);
    // The compile-time half of the contract: a draft IS a valid schema input
    // (field names/nullability drift fails typecheck on this assignment).
    const drafts: Array<z.input<typeof mlStockSendTaskSchema>> = built.tasks;
    expect(mlStockSendTaskSchema.parse(drafts[0])).toEqual(payload({ quantidade: 7 }));
  });
});

describe('processStockSendTask — payload parse', () => {
  it('malformed payload → dropped, nothing read, nothing enqueued, no ML call', async () => {
    const h = makeHarness();
    const res = await run(h, { integracaoId: CONTA, topic: 'not-a-stock-task' });
    expect(res).toEqual({ outcome: 'dropped', reason: 'payload-invalido' });
    expect(h.db.opLog).toHaveLength(0);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.apiFactory).not.toHaveBeenCalled();
    expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
  });
});

describe('processStockSendTask — master flag (#805)', () => {
  // '0' is the acceptance criterion's own wording ("flipping the flag to 0");
  // unset is the DEPLOYED steady state, since the flag ships off. `envFlag` is
  // true only on exactly '1', so both are off — and an already-enqueued backlog
  // must reach ML on neither.
  for (const [label, value] of [
    ['flipped to 0', '0'],
    ['unset', undefined],
  ] as const) {
    it(`${label} → skipped, zero Firestore reads, no token resolve, no ML call`, async () => {
      vi.stubEnv(STOCK_SYNC_FLAG_ENV, value);
      const h = makeHarness();

      const res = await run(h);

      expect(res).toEqual({ outcome: 'skipped', reason: 'sync-desabilitado' });
      // The gate sits before the pause-gate get, so a drained task reads nothing.
      expect(h.db.opLog).toHaveLength(0);
      // No API client is ever built ⇒ no access token is resolved or refreshed.
      expect(h.apiFactory).not.toHaveBeenCalled();
      expect(h.updateItem).not.toHaveBeenCalled();
      expect(h.enqueue).not.toHaveBeenCalled();
      // The conta has to be identifiable in the log — an operator draining a
      // backlog needs to know WHICH conta went quiet.
      expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
        expect.stringContaining(STOCK_SYNC_FLAG_ENV),
        expect.objectContaining({ integracaoId: CONTA, itemId: 'MLB111', sweepId: 'sweep-1' }),
      );
    });
  }

  it("stays enabled on exactly '1' — the gate does not swallow a live send", async () => {
    vi.stubEnv(STOCK_SYNC_FLAG_ENV, '1');
    const h = makeHarness();
    seedLink(h.db);

    const res = await run(h);

    expect(res).toEqual({ outcome: 'sent', reason: null });
    expect(h.updateItem).toHaveBeenCalledWith('MLB111', { available_quantity: 10 });
  });
});

describe('processStockSendTask — pause gate', () => {
  it('paused conta → re-enqueues itself past the pause with the injected jitter', async () => {
    const h = makeHarness({ jitterSec: () => 7 });
    // 90.5s of pause remaining → ceil = 91s, + 7s jitter = 98s.
    h.db.seed(STATE_PATH, CONTA, { pausedUntilUs: NOW_US + 90_500_000 });

    const res = await run(h, payload({ reenqueues: 2 }));

    expect(res).toEqual({ outcome: 'paused-requeued', reason: null });
    expect(h.jitterSec).toHaveBeenCalledWith(PAUSE_REENQUEUE_JITTER_MAX_S);
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(payload({ reenqueues: 3 }), {
      scheduleDelaySeconds: 98,
    });
    expect(h.apiFactory).not.toHaveBeenCalled();
    expect(h.updateItem).not.toHaveBeenCalled();
  });

  it('re-enqueue cap (default 10) → dropped loudly, next sweep re-covers', async () => {
    const h = makeHarness();
    h.db.seed(STATE_PATH, CONTA, { pausedUntilUs: NOW_US + 60_000_000 });

    const res = await run(h, payload({ reenqueues: 10 }));

    expect(res).toEqual({ outcome: 'dropped', reason: 'pausa-reenqueues-esgotados' });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.updateItem).not.toHaveBeenCalled();
    expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
  });

  it('paused + MERCADO_LIVRE_TASKS_DISABLED → clean drop, never a retry-looping throw', async () => {
    const h = makeHarness();
    h.db.seed(STATE_PATH, CONTA, { pausedUntilUs: NOW_US + 60_000_000 });
    h.enqueue.mockRejectedValueOnce(new MlTasksDisabledError());

    const res = await run(h, payload({ reenqueues: 1 }));

    expect(res).toEqual({ outcome: 'dropped', reason: 'tasks-desabilitadas' });
    expect(h.updateItem).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
  });

  it('an EXPIRED pause does not gate — the task sends normally', async () => {
    const h = makeHarness();
    h.db.seed(STATE_PATH, CONTA, { pausedUntilUs: NOW_US - 1 });

    const res = await run(h);

    expect(res).toEqual({ outcome: 'sent', reason: null });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.updateItem).toHaveBeenCalledExactlyOnceWith('MLB111', { available_quantity: 10 });
  });
});

describe('processStockSendTask — deterministic skips', () => {
  it('integração sem depósito → skipped before any token/ML work', async () => {
    const h = makeHarness({ conta: { nome: 'sem depósito' } });

    const res = await run(h);

    expect(res).toEqual({ outcome: 'skipped', reason: 'sem-deposito' });
    expect(h.apiFactory).not.toHaveBeenCalled();
    expect(h.updateItem).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringContaining('sem depósito'), {
      integracaoId: CONTA,
      itemId: 'MLB111',
    });
  });
});

describe('processStockSendTask — request bodies (payload verbatim)', () => {
  it('quantidade → exactly { available_quantity }, and ONLY the state-doc read', async () => {
    const h = makeHarness();
    seedLink(h.db);

    const res = await run(h, payload({ quantidade: 7 }));

    expect(res).toEqual({ outcome: 'sent', reason: null });
    expect(h.updateItem).toHaveBeenCalledExactlyOnceWith('MLB111', { available_quantity: 7 });
    // The WHOLE Firestore op log: the pause-state get before the call, then
    // the link writeback — no produto/link/children/estoque read anywhere. The
    // writeback is an `update` (mergeIfExists), never a `set`: a link deleted
    // mid-flight must not be resurrected as a ghost.
    expect(h.db.opLog).toEqual([
      { op: 'get', path: `${STATE_PATH}/${CONTA}` },
      { op: 'update', path: `${LINK_PATH}/link1` },
    ]);
  });

  it('variations → the array passes through untouched', async () => {
    const h = makeHarness();
    const variations = [
      { id: 101, available_quantity: 5 },
      { id: 102, available_quantity: 0 },
    ];

    const res = await run(h, payload({ quantidade: null, variations }));

    expect(res).toEqual({ outcome: 'sent', reason: null });
    expect(h.updateItem).toHaveBeenCalledExactlyOnceWith('MLB111', { variations });
  });

  it('quantidade AND variations both null → dropped, no ML call', async () => {
    const h = makeHarness();

    const res = await run(h, payload({ quantidade: null, variations: null }));

    expect(res).toEqual({ outcome: 'dropped', reason: 'payload-sem-quantidade' });
    expect(h.updateItem).not.toHaveBeenCalled();
    expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
  });

  it('quantidade AND variations both non-null → variations win, loudly', async () => {
    const h = makeHarness();
    const variations = [{ id: 101, available_quantity: 3 }];

    const res = await run(h, payload({ quantidade: 9, variations }));

    expect(res).toEqual({ outcome: 'sent', reason: null });
    expect(h.updateItem).toHaveBeenCalledExactlyOnceWith('MLB111', { variations });
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      expect.stringContaining('variations vence'),
      expect.objectContaining({ integracaoId: CONTA, itemId: 'MLB111' }),
    );
  });

  it("every 'sent' logs ageMs = now − sweepComputedAtMs (staleness observability)", async () => {
    const h = makeHarness();

    await run(h, payload({ sweepComputedAtMs: NOW_MS - 90_000 }));

    expect(vi.mocked(console.info)).toHaveBeenCalledWith(
      expect.stringContaining('enviado'),
      expect.objectContaining({ ageMs: 90_000, itemId: 'MLB111', sweepId: 'sweep-1' }),
    );
  });
});

describe('processStockSendTask — writeback', () => {
  it('a SUCCESSFUL member send writes no status to the family link', () => {
    // The same one-member-speaks-for-the-family failure as the terminal branch,
    // in the success direction: `resp` describes ONE member while `linkDocId`
    // names the FAMILY. Writing `resp.status` there means a member coming back
    // `paused` on an accepted PUT makes the next sweep skip EVERY sibling as
    // `status-nao-enviavel`.
    const h = makeHarness({
      updateItem: async (): Promise<MlItem> => ({
        id: 'MLB-MEMBER-1',
        status: 'paused',
        sub_status: [],
      }),
    });
    h.db.seed(LINK_PATH, 'link1', {
      contaOuterRef: `documents/integracao/${CONTA}`,
      id: 'FAM-9',
      estado: 'p',
      status: 'active',
      sub_status: [],
      isUserProductModel: true,
      errors: ['uma falha antiga'],
    });

    return run(
      h,
      payload({
        kind: 'variationItem',
        itemId: 'MLB-MEMBER-1',
        variacaoProdutoId: 'CHILD-1',
        quantidade: 7,
      }),
    ).then((res) => {
      expect(res).toEqual({ outcome: 'sent', reason: null });
      const link = h.db.docs(LINK_PATH).get('link1');
      // The family keeps whatever the fold last concluded — one member's `paused`
      // does not become the family's.
      expect(link).toMatchObject({ estado: 'p', status: 'active' });
      // ...but the heal and the stamp are legitimately family-wide.
      expect(link).toMatchObject({ errors: [], causas: [], ultimaModificacao: NOW_MS });
    });
  });

  it('a successful SIMPLE send still writes the status through (unchanged)', async () => {
    const h = makeHarness({
      updateItem: async (): Promise<MlItem> => ({
        id: 'MLB111',
        status: 'paused',
        sub_status: ['out_of_stock'],
      }),
    });
    seedLink(h.db);

    const res = await run(h);

    expect(res).toEqual({ outcome: 'sent', reason: null });
    expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({
      estado: 'pa',
      status: 'paused',
      sub_status: ['out_of_stock'],
    });
  });

  it('merges the fresh ML status onto the payload-addressed link doc', async () => {
    const h = makeHarness({
      updateItem: async (): Promise<MlItem> => ({
        id: 'MLB111',
        status: 'paused',
        sub_status: ['out_of_stock'],
      }),
    });
    seedLink(h.db, { title: 'Produto PROD' });

    await run(h);

    expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({
      estado: 'pa', // estadoFromMlStatus('paused')
      status: 'paused',
      sub_status: ['out_of_stock'],
      ultimaModificacao: NOW_MS,
      // Merge discipline: untouched fields survive.
      contaOuterRef: `documents/integracao/${CONTA}`,
      title: 'Produto PROD',
      id: 'MLB111',
    });
  });

  it('the target comes from the payload — linkDocId under produtoId, never re-resolved', async () => {
    const h = makeHarness();
    h.db.seed('produtos/OTHER/produtoMercadoLivre', 'lk9', {
      contaOuterRef: `documents/integracao/${CONTA}`,
      id: 'MLB111',
      estado: 'p',
    });

    await run(h, payload({ produtoId: 'OTHER', linkDocId: 'lk9' }));

    expect(h.db.docs('produtos/OTHER/produtoMercadoLivre').get('lk9')).toMatchObject({
      estado: 'p',
      status: 'active',
      ultimaModificacao: NOW_MS,
    });
  });

  it('a link deleted mid-flight is NOT recreated — the writeback resolves to nothing', async () => {
    const h = makeHarness();
    // No seedLink: the sweep enqueued this task, then the link doc was deleted
    // (produto delete cascade, an operator unlinking, the UP-migration prune).
    const res = await run(h, payload({ quantidade: 7 }));

    // The send itself still succeeded — only the writeback had nowhere to land.
    expect(res).toEqual({ outcome: 'sent', reason: null });
    // The ghost regression: `merge` would have CREATED this doc holding only
    // the writeback keys — no contaOuterRef, no title, no id.
    expect(h.db.docs(LINK_PATH).has('link1')).toBe(false);
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      expect.stringContaining('link removido durante o envio'),
      expect.objectContaining({ linkDocId: 'link1', produtoId: 'PROD' }),
    );
  });

  it('a response without sub_status writes [] (never undefined on the wire)', async () => {
    const h = makeHarness({
      updateItem: async (): Promise<MlItem> => ({ id: 'MLB111', status: 'active' }),
    });
    seedLink(h.db);

    await run(h);

    expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({
      estado: 'p',
      status: 'active',
      sub_status: [],
      ultimaModificacao: NOW_MS,
    });
  });
});

describe('processStockSendTask — error policy', () => {
  it('429 WITH Retry-After → pause stamped from the header, counter bumped, RETHROW', async () => {
    const boom = new MercadoLivreHttpError('rate limited', 429, {}, 17);
    const h = makeHarness({
      updateItem: async (): Promise<MlItem> => {
        throw boom;
      },
    });
    seedLink(h.db);
    h.db.seed(STATE_PATH, CONTA, { pauseCount: 3 });

    await expect(run(h)).rejects.toBe(boom);

    expect(h.db.docs(STATE_PATH).get(CONTA)).toMatchObject({
      pausedUntilUs: (NOW_MS + 17_000) * 1000,
      pauseCount: 4,
      lastError: 'rate limited',
      lastErrorAtUs: NOW_US,
    });
    // The link is NOT error-stamped on a 429 (transient, not deterministic).
    expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({ estado: 'p' });
  });

  it('429 WITHOUT Retry-After → default ratePauseMin (5 min) pause, RETHROW', async () => {
    const boom = new MercadoLivreHttpError('rate limited', 429, {});
    const h = makeHarness({
      updateItem: async (): Promise<MlItem> => {
        throw boom;
      },
    });
    seedLink(h.db);

    await expect(run(h)).rejects.toBe(boom);

    expect(h.db.docs(STATE_PATH).get(CONTA)).toMatchObject({
      pausedUntilUs: (NOW_MS + 5 * 60 * 1000) * 1000,
      pauseCount: 1,
    });
  });

  it('4xx before the last attempt → RETHROW, nothing written, no verification GET', async () => {
    const boom = new MercadoLivreHttpError('ML 400: invalid', 400, null);
    for (const retryCount of [0, LAST_ATTEMPT - 1]) {
      const h = makeHarness({
        retryCount,
        updateItem: async (): Promise<MlItem> => {
          throw boom;
        },
      });
      seedLink(h.db);

      await expect(run(h)).rejects.toBe(boom);

      // ML answers 4xx for transient reasons too — one sample latches nothing.
      expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({ estado: 'p', status: 'active' });
      expect(h.db.docs(LINK_PATH).get('link1')).not.toHaveProperty('errors');
      // ...and it must not burn a quota call verifying something it will retry.
      expect(h.getItem).not.toHaveBeenCalled();
    }
  });

  it('5xx → RETHROW, nothing stamped anywhere', async () => {
    const boom = new MercadoLivreHttpError('ML 500: boom', 500, null);
    const h = makeHarness({
      updateItem: async (): Promise<MlItem> => {
        throw boom;
      },
    });
    seedLink(h.db);

    await expect(run(h)).rejects.toBe(boom);

    expect(h.db.docs(STATE_PATH).has(CONTA)).toBe(false);
    expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({ estado: 'p' });
  });

  it('network error → RETHROW (transient, queue retries)', async () => {
    const boom = new MercadoLivreNetworkError('fetch falhou');
    const h = makeHarness({
      updateItem: async (): Promise<MlItem> => {
        throw boom;
      },
    });
    seedLink(h.db);

    await expect(run(h)).rejects.toBe(boom);
  });

  it('reauth (dead credential) → NO rethrow, lastError on the state doc', async () => {
    const h = makeHarness({
      resolveChannelContext: async () => {
        throw new MercadoLivreReauthRequiredError('refresh_failed', 'reconecte a conta');
      },
    });
    seedLink(h.db);

    const res = await run(h);

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'reauth' });
    expect(h.db.docs(STATE_PATH).get(CONTA)).toMatchObject({
      lastError: 'reconecte a conta',
      lastErrorAtUs: NOW_US,
    });
    expect(h.updateItem).not.toHaveBeenCalled();
    expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
  });
});

/**
 * #781. The old handler answered every 4xx by writing `estado: 'E'` and nothing
 * else — leaving `status: 'active'` on the link, which is the value the sweep's
 * gate reads. So the next tick rebuilt the identical payload and re-sent it, 96×
 * a day, forever. The fix asks ML what the listing actually IS and records THAT,
 * so the existing status whitelist can do its job.
 */
describe('processStockSendTask — terminal 4xx (last attempt verifies with ML)', () => {
  /** A 4xx from the PUT, with whatever the verification GET should then answer. */
  function terminal(getItem: HarnessOpts['getItem'], linkExtra: DocData = {}) {
    const h = makeHarness({
      retryCount: LAST_ATTEMPT,
      updateItem: async (): Promise<MlItem> => {
        throw new MercadoLivreHttpError('ML 400: invalid quantity', 400, null);
      },
      getItem,
    });
    seedLink(h.db, linkExtra);
    return h;
  }

  it("ML says the listing is HEALTHY → our payload is the problem → estado 'E'", async () => {
    const h = terminal(async () => ({ id: 'MLB111', status: 'active', sub_status: [] }));

    const res = await run(h);

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'payload-rejeitado' });
    expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({
      // The one case that genuinely needs a latch: ML is fine, we are not.
      estado: 'E',
      status: 'active',
      errors: ['ML 400: invalid quantity'],
      ultimaModificacao: NOW_MS,
    });
  });

  it.each([
    ['closed', 'c', null],
    ['under_review', 'v', null],
    ['inactive', 'E', null],
    ['paused', 'pa', null],
  ])(
    'ML says %s → the REAL status is recorded (estado %s), no payload latch',
    async (mlStatus, estado, subStatus) => {
      const h = terminal(async () => ({
        id: 'MLB111',
        status: mlStatus,
        sub_status: subStatus ?? [],
      }));

      const res = await run(h);

      expect(res).toEqual({ outcome: 'erro-registrado', reason: 'anuncio-nao-enviavel' });
      expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({
        estado,
        status: mlStatus,
        errors: ['ML 400: invalid quantity'],
      });
    },
  );

  it('a listing ML still reports as sendable via paused+out_of_stock IS latched', async () => {
    // `podeEnviarEstoque` sends to this one, so leaving it unlatched would loop.
    const h = terminal(async () => ({
      id: 'MLB111',
      status: 'paused',
      sub_status: ['out_of_stock'],
    }));

    const res = await run(h);

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'payload-rejeitado' });
    expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({ estado: 'E', status: 'paused' });
  });

  it('the verification GET 404s (listing gone) → recorded as closed, NOT left active', async () => {
    // syncItemStatus answers 'item-gone' and writes nothing; doing that here
    // would leave `status: 'active'` standing and the sweep looping.
    const h = terminal(async () => {
      throw new MercadoLivreHttpError('ML 404: item not found', 404, null);
    });

    const res = await run(h);

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'anuncio-inexistente' });
    expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({
      estado: 'c',
      status: 'closed',
      sub_status: [],
      errors: ['ML 400: invalid quantity'],
    });
  });

  it('the verification GET itself fails → conservative stop, never a false verdict', async () => {
    const h = terminal(async () => {
      throw new MercadoLivreHttpError('ML 503: unavailable', 503, null);
    });

    const res = await run(h);

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'verificacao-indisponivel' });
    const link = h.db.docs(LINK_PATH).get('link1');
    // `estado 'E'` still stops the loop, but nothing was CONFIRMED, so the
    // unverified status must not be overwritten with a guess.
    expect(link).toMatchObject({ estado: 'E', errors: ['ML 400: invalid quantity'] });
    expect(link).toMatchObject({ status: 'active' });
  });

  it('a non-ML failure during verification RETHROWS (Firestore / coding bug)', async () => {
    const boom = new TypeError('db exploded');
    const h = terminal(async () => {
      throw boom;
    });

    await expect(run(h)).rejects.toBe(boom);
  });
});

/* -------------------- #707 phantom-variation self-heal --------------------- */

/** The canonical outer ref of the payload's parent link — the sibling join key. */
const PARENT_REF = `documents/${LINK_PATH}/link1`;
const varPath = (childId: string) => `produtos/${childId}/variacaoMercadoLivre`;

/** ML's refusal when the `variations[]` we sent name an id it no longer has. */
function variationsInvalidError(): MercadoLivreHttpError {
  return new MercadoLivreHttpError('ML 400: Validation error', 400, {
    message: 'Validation error',
    error: 'validation_error',
    cause: [
      {
        department: 'catalog',
        cause_id: 100,
        type: 'error',
        code: 'item.variations.invalid',
        references: ['item.variations'],
        message: 'The variations are invalid',
      },
    ],
  });
}

/** Seed one legacy-model member link under its own child produto. */
function seedMembro(db: FakeDb, childId: string, docId: string, raw: DocData = {}): void {
  db.seed(varPath(childId), docId, {
    id: 101,
    itemId: null,
    produtoMercadoLivreOuterRef: PARENT_REF,
    produtoVariacaoOuterRef: `documents/produtos/${childId}`,
    ...raw,
  });
}

describe('processStockSendTask — terminal 4xx, item.variations.invalid (#707)', () => {
  /** A bulk send that ML refuses with `item.variations.invalid`. */
  function bulkTerminal(getItem: HarnessOpts['getItem']) {
    const h = makeHarness({
      retryCount: LAST_ATTEMPT,
      updateItem: async (): Promise<MlItem> => {
        throw variationsInvalidError();
      },
      getItem,
    });
    seedLink(h.db);
    return h;
  }

  const bulkPayload = () =>
    payload({
      quantidade: null,
      variations: [
        { id: 101, available_quantity: 3 },
        { id: 999, available_quantity: 4 },
      ],
    });

  it('marks the phantom member closed, leaves the live one, and does NOT latch', async () => {
    // ML still lists 101; 999 is gone. Legacy pruned exactly this difference.
    const h = bulkTerminal(async () => ({
      id: 'MLB111',
      status: 'active',
      sub_status: [],
      variations: [{ id: 101 }],
    }));
    seedMembro(h.db, 'C1', 'v1', { id: 101 });
    seedMembro(h.db, 'C2', 'v2', { id: 999 });

    const res = await run(h, bulkPayload());

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'variacoes-podadas' });
    expect(h.db.docs(varPath('C2')).get('v2')).toMatchObject({
      status: 'closed',
      sub_status: ['deleted'],
    });
    // The LIVE member is untouched — no status field invented for it.
    expect(h.db.docs(varPath('C1')).get('v1')).not.toHaveProperty('status');
    // ⚠️ The whole point of the prune: `estado 'E'` is what `buildSendTasks`
    // skips on, so latching a payload we just repaired would leave the corrected
    // send unmade until a human clicks "Reverificar anúncio".
    const link = h.db.docs(LINK_PATH).get('link1');
    expect(link).toMatchObject({
      status: 'active',
      errors: ['error · item.variations.invalid — The variations are invalid [item.variations]'],
    });
    expect(link?.estado).not.toBe('E');
  });

  it('prunes NOTHING when every id we sent is still live → #781 latch stands', async () => {
    // The cause named variations but the diff finds no phantom, so the payload
    // was refused for some other reason. Re-sending it unchanged only re-earns
    // the rejection, which is exactly what the latch exists to stop.
    const h = bulkTerminal(async () => ({
      id: 'MLB111',
      status: 'active',
      sub_status: [],
      variations: [{ id: 101 }, { id: 999 }],
    }));
    seedMembro(h.db, 'C1', 'v1', { id: 101 });
    seedMembro(h.db, 'C2', 'v2', { id: 999 });

    const res = await run(h, bulkPayload());

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'payload-rejeitado' });
    expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({ estado: 'E' });
    expect(h.db.docs(varPath('C2')).get('v2')).not.toHaveProperty('status');
  });

  it('a User-Products family is NEVER pruned — legacy returns on family_name', async () => {
    // `.old/…/produtos.dart:454` opens with `if (consulta['family_name'] != null)
    // return;`. Under UP there is no `variations[]` at all and members are keyed
    // by `itemId`, so a legacy-shaped diff would mark live members closed.
    const h = bulkTerminal(async () => ({
      id: 'MLB111',
      status: 'active',
      sub_status: [],
      family_name: 'Camiseta',
      variations: [],
    }));
    seedMembro(h.db, 'C2', 'v2', { id: 999 });

    const res = await run(h, bulkPayload());

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'payload-rejeitado' });
    expect(h.db.docs(varPath('C2')).get('v2')).not.toHaveProperty('status');
  });

  it('a rejection naming a DIFFERENT cause prunes nothing', async () => {
    const h = makeHarness({
      retryCount: LAST_ATTEMPT,
      updateItem: async (): Promise<MlItem> => {
        throw new MercadoLivreHttpError('ML 400: Validation error', 400, {
          error: 'validation_error',
          cause: [{ code: 'item.variations.not_updatable', message: 'nope' }],
        });
      },
      getItem: async () => ({ id: 'MLB111', status: 'active', sub_status: [] }),
    });
    seedLink(h.db);
    seedMembro(h.db, 'C2', 'v2', { id: 999 });

    const res = await run(h, bulkPayload());

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'payload-rejeitado' });
    expect(h.db.docs(varPath('C2')).get('v2')).not.toHaveProperty('status');
  });

  it('a SINGLE-item payload never prunes — only a bulk send carries variations', async () => {
    const h = bulkTerminal(async () => ({
      id: 'MLB111',
      status: 'active',
      sub_status: [],
      variations: [],
    }));
    seedMembro(h.db, 'C2', 'v2', { id: 999 });

    // `quantidade`, not `variations` — this shape cannot earn the cause.
    const res = await run(h, payload({ quantidade: 5, variations: null }));

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'payload-rejeitado' });
    expect(h.db.docs(varPath('C2')).get('v2')).not.toHaveProperty('status');
  });

  it('re-derives the plan inside the transaction — a racing writer is not lost', async () => {
    // Rule 7 / ADR 0011, class B: ML's live id set crosses the network, so the
    // STORED half must come from `tx.get`. A publish landing in the window
    // re-points v2 at a variation that IS live; a plan captured before the
    // transaction would mark it closed and silently stop its stock.
    const h = bulkTerminal(async () => ({
      id: 'MLB111',
      status: 'active',
      sub_status: [],
      variations: [{ id: 101 }],
    }));
    seedMembro(h.db, 'C1', 'v1', { id: 101 });
    seedMembro(h.db, 'C2', 'v2', { id: 999 });
    h.db.onBeforeCommit = () => {
      h.db.raceWrite(varPath('C2'), 'v2', { id: 101 });
    };

    const res = await run(h, bulkPayload());

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'payload-rejeitado' });
    // The retry re-read v2, found it live, and planned nothing.
    expect(h.db.docs(varPath('C2')).get('v2')).not.toHaveProperty('status');
  });
});

it('THE SEAM: what the prune writes is what the next sweep leaves out', () => {
  // Every other prune spec asserts the mark is WRITTEN. None of them proved the
  // planner READS it — and it did not: the gate first landed on the UP branch
  // while the prune only ever marks LEGACY links, so the phantom went straight
  // back into `variations[]` and the self-heal healed nothing. This spec joins
  // the two halves, so a gate on the wrong branch can never pass again.
  const marcado = { id: 999, status: 'closed', sub_status: ['deleted'] };
  const row: StockFamilyRow = {
    anchorId: 'PROD',
    anchor: {
      produtoId: 'PROD',
      ehKit: false,
      ehKitVirtual: false,
      publicado: true,
      componentesKit: null,
      timestampMs: null,
      estoque: null,
      componentEstoques: [],
    },
    integracoesComProduto: [CONTA],
    links: [
      {
        id: 'MLB111',
        estado: 'p',
        status: 'active',
        sub_status: [],
        isUserProductModel: false,
        linkDocId: 'link1',
      },
    ],
    children: [
      {
        produtoId: 'C1',
        ehKit: false,
        ehKitVirtual: false,
        publicado: true,
        componentesKit: null,
        timestampMs: null,
        estoque: null,
        componentEstoques: [],
        varLinks: [{ id: 101, produtoMercadoLivreOuterRef: PARENT_REF }],
      },
      {
        produtoId: 'C2',
        ehKit: false,
        ehKitVirtual: false,
        publicado: true,
        componentesKit: null,
        timestampMs: null,
        estoque: null,
        componentEstoques: [],
        // ⚠️ Exactly the patch `podarVariacoesFantasma` merges — spelled as the
        // stored doc, so a change to either side breaks this.
        varLinks: [{ ...marcado, produtoMercadoLivreOuterRef: PARENT_REF }],
      },
    ],
  };

  const built = buildSendTasks(
    row,
    new Map([
      ['C1', 3],
      ['C2', 4],
    ]),
    { integracaoId: CONTA, sweepId: 'sweep-2', sweepComputedAtMs: SWEEP_MS },
  );

  // The phantom is gone; the live sibling still ships.
  expect(built.tasks).toHaveLength(1);
  expect(built.tasks[0]?.variations).toEqual([{ id: 101, available_quantity: 3 }]);
  expect(built.skips).toEqual([
    { produtoId: 'C2', reason: 'status-nao-enviavel', itemId: 'MLB111', linkDocId: 'link1' },
  ]);
});

/* ------------- terminal 4xx on ONE User-Products family member ------------- */

describe('processStockSendTask — terminal 4xx on a UP family member (#1142)', () => {
  const CHILD = 'CHILD-1';
  const MEMBER_ITEM = 'MLB-MEMBER-1';

  /** The task the sweep emits per UP member: parent link + the MEMBER's item. */
  const memberPayload = () =>
    payload({
      kind: 'variationItem',
      itemId: MEMBER_ITEM,
      variacaoProdutoId: CHILD,
      quantidade: 7,
    });

  function memberTerminal(getItem: HarnessOpts['getItem']) {
    const h = makeHarness({
      retryCount: LAST_ATTEMPT,
      updateItem: async (): Promise<MlItem> => {
        throw new MercadoLivreHttpError('ML 400: invalid quantity', 400, null);
      },
      getItem,
    });
    // The parent link carries the FAMILY id, never a member's (publish.ts).
    seedLink(h.db, { id: 'FAM-9', isUserProductModel: true });
    return h;
  }

  /** One UP member link under its own child produto. */
  function seedUpMember(db: FakeDb, childId: string, docId: string, raw: DocData = {}): void {
    db.seed(varPath(childId), docId, {
      id: null,
      itemId: `MLB-${docId}`,
      produtoMercadoLivreOuterRef: PARENT_REF,
      produtoVariacaoOuterRef: `documents/produtos/${childId}`,
      ...raw,
    });
  }

  it('a 404 on ONE member closes THAT member — never the family (silent-outage guard)', async () => {
    // The regression this whole block exists for: writing the member's verdict
    // to the parent gives it `estado 'c'`, which fails `linkHasLiveListing` and
    // drops the conta from `integracoesComProduto` — the anchor pre-filter BOTH
    // sweeps open with. The produto simply stops being selected, silently.
    const h = memberTerminal(async () => {
      throw new MercadoLivreHttpError('ML 404: not found', 404, null);
    });
    seedUpMember(h.db, CHILD, 'm1', { itemId: MEMBER_ITEM, status: 'active' });
    seedUpMember(h.db, 'CHILD-2', 'm2', { itemId: 'MLB-m2', status: 'active' });

    const res = await run(h, memberPayload());

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'membro-inexistente' });
    expect(h.db.docs(varPath(CHILD)).get('m1')).toMatchObject({ status: 'closed' });
    const link = h.db.docs(LINK_PATH).get('link1');
    // The sibling is still `active`, so the fold keeps the family live.
    expect(link).toMatchObject({ status: 'active', errors: ['ML 400: invalid quantity'] });
    expect(link?.estado).not.toBe('c');
  });

  it('the family DOES close once its last member is gone', async () => {
    // The other half of the fold's contract: `closed` ranks last, but when it is
    // all that is left it must still win — otherwise a dead family stays selected.
    const h = memberTerminal(async () => {
      throw new MercadoLivreHttpError('ML 404: not found', 404, null);
    });
    seedUpMember(h.db, CHILD, 'm1', { itemId: MEMBER_ITEM, status: 'active' });
    seedUpMember(h.db, 'CHILD-2', 'm2', { itemId: 'MLB-m2', status: 'closed' });

    await run(h, memberPayload());

    expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({ estado: 'c', status: 'closed' });
  });

  it('a healthy member latches the FAMILY, but never with a member-keyed denorm', async () => {
    const h = memberTerminal(async () => ({ id: MEMBER_ITEM, status: 'active', sub_status: [] }));
    seedUpMember(h.db, CHILD, 'm1', { itemId: MEMBER_ITEM, status: null });

    const res = await run(h, memberPayload());

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'payload-rejeitado' });
    expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({ estado: 'E' });
    // The member's own status is backfilled from the verification GET (#780's
    // "the send is its own backfill", now true for members too).
    expect(h.db.docs(varPath(CHILD)).get('m1')).toMatchObject({ status: 'active' });
    // ⚠️ The denorm key is the parent's own `id`. A member id reaching
    // `updateParentDenorm` would arrayUnion an entry nothing can ever remove.
    expect(h.db.docs('produtos').get('PROD')).toBeUndefined();
    expect(h.db.opLog.filter((o) => o.path === 'produtos/PROD')).toEqual([]);
  });

  it('a member ML reports as NOT sendable records its status without latching', async () => {
    const h = memberTerminal(async () => ({ id: MEMBER_ITEM, status: 'under_review' }));
    seedUpMember(h.db, CHILD, 'm1', { itemId: MEMBER_ITEM, status: 'active' });
    seedUpMember(h.db, 'CHILD-2', 'm2', { itemId: 'MLB-m2', status: 'active' });

    const res = await run(h, memberPayload());

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'anuncio-nao-enviavel' });
    expect(h.db.docs(varPath(CHILD)).get('m1')).toMatchObject({ status: 'under_review' });
    expect(h.db.docs(LINK_PATH).get('link1')?.estado).not.toBe('E');
  });

  it('an unresolvable member takes the conservative stop, never the family cancel', async () => {
    // No member link matches (a cascade deleted it mid-flight, or the ref drifted).
    // `estado 'E'` stops the loop and stays visible; `estado 'c'` would be silent.
    const h = memberTerminal(async () => {
      throw new MercadoLivreHttpError('ML 404: not found', 404, null);
    });

    const res = await run(h, memberPayload());

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'membro-nao-encontrado' });
    expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({ estado: 'E' });
  });

  it('a member link belonging to ANOTHER listing is not mistaken for this one', async () => {
    const h = memberTerminal(async () => ({ id: MEMBER_ITEM, status: 'active', sub_status: [] }));
    seedUpMember(h.db, CHILD, 'm1', {
      itemId: MEMBER_ITEM,
      produtoMercadoLivreOuterRef: 'documents/produtos/OUTRO/produtoMercadoLivre/link9',
    });

    const res = await run(h, memberPayload());

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'membro-nao-encontrado' });
    expect(h.db.docs(varPath(CHILD)).get('m1')).not.toHaveProperty('status');
  });
});

describe('processStockSendTask — success clears the previous diagnosis', () => {
  it('a landed send wipes the errors a past failure left on the link', async () => {
    const h = makeHarness();
    seedLink(h.db, { estado: 'E', errors: ['ML 400: invalid quantity'] });

    await run(h);

    expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({
      estado: 'p',
      status: 'active',
      errors: [],
    });
  });
});
