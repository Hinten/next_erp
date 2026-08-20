import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  type MlItem,
  type MlUserProductStock,
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
// opLog. The handler makes NO collection queries anymore — payloads carry the
// sweep-computed quantities AND the writeback target — so the only Firestore
// surface it touches is the pause-state doc get and the two merge writebacks.

type DocData = Record<string, unknown>;

interface FakeSnap {
  exists: boolean;
  id: string;
  data: () => DocData | undefined;
}

interface FakeDocRef {
  id: string;
  get: () => Promise<FakeSnap>;
  set: (data: DocData, opts?: { merge?: boolean }) => void;
  update: (data: DocData) => Promise<void>;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly opLog: Array<{ op: 'get' | 'set' | 'update'; path: string }> = [];

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

  collection(path: string): { doc: (id: string) => FakeDocRef } {
    const self = this;
    return {
      doc(id: string): FakeDocRef {
        const col = self.col(path);
        return {
          id,
          get: async () => {
            self.opLog.push({ op: 'get', path: `${path}/${id}` });
            return { exists: col.has(id), id, data: () => col.get(id) };
          },
          set: (data: DocData, opts?: { merge?: boolean }) => {
            self.opLog.push({ op: 'set', path: `${path}/${id}` });
            if (opts?.merge) col.set(id, { ...(col.get(id) ?? {}), ...data });
            else col.set(id, { ...data });
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
          },
        };
      },
    };
  }
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
    userProductId: null,
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
  /** #706 multiorigem: the read-before-write. Default: one seller_warehouse, version '7'. */
  getUserProductStock?: (
    userProductId: string,
  ) => Promise<{ stock: MlUserProductStock; version: string | null }>;
  putUserProductSellerWarehouseStock?: (
    userProductId: string,
    version: string,
    locations: ReadonlyArray<{ store_id: string; network_node_id: string; quantity: number }>,
  ) => Promise<MlUserProductStock>;
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
  const getUserProductStock = vi.fn(
    opts.getUserProductStock ??
      (async (userProductId: string) => ({
        stock: {
          id: userProductId,
          locations: [
            {
              type: 'seller_warehouse',
              store_id: 'STORE-1',
              network_node_id: 'NODE-1',
              quantity: 3,
            },
          ],
        } as MlUserProductStock,
        version: '7' as string | null,
      })),
  );
  const putUserProductSellerWarehouseStock = vi.fn(
    opts.putUserProductSellerWarehouseStock ??
      (async (
        userProductId: string,
        _version: string,
        locations: ReadonlyArray<{ store_id: string; network_node_id: string; quantity: number }>,
      ) =>
        ({
          id: userProductId,
          locations: locations.map((l) => ({ ...l, type: 'seller_warehouse' })),
        }) as MlUserProductStock),
  );
  const apiFactory = vi.fn((_cfg: { getAccessToken: () => Promise<string> }) => ({
    updateItem,
    getItem,
    getUserProductStock,
    putUserProductSellerWarehouseStock,
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
  return {
    db,
    deps,
    enqueue,
    updateItem,
    getItem,
    getUserProductStock,
    putUserProductSellerWarehouseStock,
    apiFactory,
    jitterSec,
  };
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

describe('processStockSendTask — multiorigem / seller_warehouse (#706)', () => {
  const UP = payload({ kind: 'userProductStock', userProductId: 'MLBU-1', quantidade: 12 });

  function seedLink(db: FakeDb, over: DocData = {}): void {
    db.seed(LINK_PATH, 'link1', {
      id: 'MLB111',
      estado: 'p',
      status: 'active',
      errors: ['falha anterior'],
      ...over,
    });
  }

  it('reads the stock for the version, then PUTs the ECHOED identifiers with the new quantity', async () => {
    const h = makeHarness();
    seedLink(h.db);

    await expect(run(h, UP)).resolves.toEqual({ outcome: 'sent', reason: null });

    expect(h.getUserProductStock).toHaveBeenCalledWith('MLBU-1');
    // ⚠️ `locations` REPLACES the seller_warehouse set, so the identifiers must
    // come back verbatim from the read — inventing or omitting them zeroes a
    // warehouse nobody asked to touch.
    expect(h.putUserProductSellerWarehouseStock).toHaveBeenCalledWith('MLBU-1', '7', [
      { store_id: 'STORE-1', network_node_id: 'NODE-1', quantity: 12 },
    ]);
    // …and never through the item endpoint, which ML would silently discard.
    expect(h.updateItem).not.toHaveBeenCalled();
  });

  it('the writeback clears the diagnosis but writes NO listing status — the PUT does not return one', async () => {
    const h = makeHarness();
    seedLink(h.db, { estado: 'E' });

    await run(h, UP);

    const link = h.db.docs(LINK_PATH).get('link1');
    expect(link).toMatchObject({ errors: [], ultimaModificacao: NOW_MS });
    // Inventing a status here would feed `podeEnviarEstoque` next tick. The
    // `items` webhook and the daily sweep own that data.
    expect(link?.status).toBe('active'); // untouched, as seeded
    expect(link?.estado).toBe('E'); // untouched — only clearFalha() applies
  });

  it('resolves an unstamped User Product from the item ONCE and stamps it into the same writeback', async () => {
    const h = makeHarness({
      getItem: async () => ({ id: 'MLB111', user_product_id: 'MLBU-RESOLVED' }),
    });
    seedLink(h.db);

    await expect(run(h, payload({ kind: 'userProductStock', quantidade: 4 }))).resolves.toEqual({
      outcome: 'sent',
      reason: null,
    });

    expect(h.getItem).toHaveBeenCalledWith('MLB111');
    expect(h.getUserProductStock).toHaveBeenCalledWith('MLBU-RESOLVED');
    // The stamp is what makes the resolve a ONE-TIME cost rather than per tick,
    // and it rides the writeback that was happening anyway — zero extra writes.
    expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({ userProductId: 'MLBU-RESOLVED' });
  });

  it('an already-stamped task never pays the resolve GET', async () => {
    const h = makeHarness();
    seedLink(h.db);
    await run(h, UP);
    expect(h.getItem).not.toHaveBeenCalled();
    expect(h.db.docs(LINK_PATH).get('link1')).not.toHaveProperty('userProductId');
  });

  it('an item ML gives no user_product_id is stopped terminally — no retry can fix it', async () => {
    const h = makeHarness({ getItem: async () => ({ id: 'MLB111' }) });
    seedLink(h.db);

    const res = await run(h, payload({ kind: 'userProductStock', quantidade: 4 }));

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'sem-user-product' });
    expect(h.getUserProductStock).not.toHaveBeenCalled();
    // `estado 'E'` is what makes the sweep's gate skip it next tick instead of
    // re-earning this 96 times a day.
    expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({ estado: 'E' });
  });

  it('⚠️ a Fulfillment listing is SKIPPED, not sent — a seller_warehouse write there succeeds and does nothing', async () => {
    const h = makeHarness({
      getUserProductStock: async (id) => ({
        stock: { id, locations: [{ type: 'meli_facility', quantity: 9 }] } as MlUserProductStock,
        version: '3',
      }),
    });
    seedLink(h.db);

    const res = await run(h, UP);

    expect(res).toEqual({ outcome: 'skipped', reason: 'estoque-full-gerenciado-pelo-ml' });
    expect(h.putUserProductSellerWarehouseStock).not.toHaveBeenCalled();
    // A skip, not a failure: the listing is healthy, its stock is simply ML's.
    expect(h.db.docs(LINK_PATH).get('link1')).not.toMatchObject({ estado: 'E' });
  });

  it('a User Product with NO locations at all is an operator-actionable error', async () => {
    const h = makeHarness({
      getUserProductStock: async (id) => ({
        stock: { id, locations: [] } as MlUserProductStock,
        version: '3',
      }),
    });
    seedLink(h.db);

    const res = await run(h, UP);

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'sem-deposito-no-ml' });
    expect(h.putUserProductSellerWarehouseStock).not.toHaveBeenCalled();
    expect((h.db.docs(LINK_PATH).get('link1')?.errors as string[])[0]).toContain(
      'painel do Mercado Livre',
    );
  });

  it('⚠️ more than one seller_warehouse REFUSES rather than guessing which building the stock is in', async () => {
    const h = makeHarness({
      getUserProductStock: async (id) => ({
        stock: {
          id,
          locations: [
            { type: 'seller_warehouse', store_id: 'A', network_node_id: 'NA', quantity: 1 },
            { type: 'seller_warehouse', store_id: 'B', network_node_id: 'NB', quantity: 2 },
          ],
        } as MlUserProductStock,
        version: '3',
      }),
    });
    seedLink(h.db);

    const res = await run(h, UP);

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'multi-deposito-nao-suportado' });
    expect(h.putUserProductSellerWarehouseStock).not.toHaveBeenCalled();
  });

  it('a missing x-version fails fast instead of burning the retry ladder on a guaranteed 400', async () => {
    const h = makeHarness({
      getUserProductStock: async (id) => ({
        stock: {
          id,
          locations: [
            { type: 'seller_warehouse', store_id: 'A', network_node_id: 'NA', quantity: 1 },
          ],
        } as MlUserProductStock,
        version: null,
      }),
    });
    seedLink(h.db);

    const res = await run(h, UP);

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'sem-x-version' });
    expect(h.putUserProductSellerWarehouseStock).not.toHaveBeenCalled();
  });

  it('a location without store_id / network_node_id is refused, never sent as empty strings', async () => {
    const h = makeHarness({
      getUserProductStock: async (id) => ({
        stock: {
          id,
          locations: [{ type: 'seller_warehouse', quantity: 1 }],
        } as MlUserProductStock,
        version: '3',
      }),
    });
    seedLink(h.db);

    const res = await run(h, UP);

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'deposito-sem-identificadores' });
    expect(h.putUserProductSellerWarehouseStock).not.toHaveBeenCalled();
  });

  it('a 409 re-reads the version and retries ONCE — the ordinary outcome of a read-before-write', async () => {
    let version = '7';
    const put = vi.fn(async (id: string, v: string) => {
      if (v !== '9') throw new MercadoLivreHttpError('version mismatch', 409, null);
      return { id, locations: [] } as MlUserProductStock;
    });
    const h = makeHarness({
      getUserProductStock: async (id) => {
        const v = version;
        version = '9'; // the second read sees the winner's version
        return {
          stock: {
            id,
            locations: [
              { type: 'seller_warehouse', store_id: 'S', network_node_id: 'N', quantity: 1 },
            ],
          } as MlUserProductStock,
          version: v,
        };
      },
      putUserProductSellerWarehouseStock: put,
    });
    seedLink(h.db);

    await expect(run(h, UP)).resolves.toEqual({ outcome: 'sent', reason: null });

    expect(h.getUserProductStock).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenNthCalledWith(1, 'MLBU-1', '7', expect.anything());
    expect(put).toHaveBeenNthCalledWith(2, 'MLBU-1', '9', expect.anything());
  });

  it('⚠️ the 409 retry RE-DERIVES its body — a warehouse that appeared meanwhile must not be zeroed', async () => {
    // The body REPLACES the seller_warehouse set. Re-sending the pre-conflict
    // one-element body would zero the newcomer AND skip the `> 1 depósito`
    // refusal that exists to prevent exactly that. Root CLAUDE.md rule 7:
    // re-derive from the read that won.
    let leituras = 0;
    const put = vi.fn(async () => {
      throw new MercadoLivreHttpError('version mismatch', 409, null);
    });
    const h = makeHarness({
      getUserProductStock: async (id) => {
        leituras += 1;
        const locations =
          leituras === 1
            ? [{ type: 'seller_warehouse', store_id: 'S1', network_node_id: 'N1', quantity: 1 }]
            : [
                { type: 'seller_warehouse', store_id: 'S1', network_node_id: 'N1', quantity: 1 },
                { type: 'seller_warehouse', store_id: 'S2', network_node_id: 'N2', quantity: 4 },
              ];
        return { stock: { id, locations } as MlUserProductStock, version: `v${leituras}` };
      },
      putUserProductSellerWarehouseStock: put,
    });
    seedLink(h.db);

    const res = await run(h, UP);

    // The retry saw two warehouses and REFUSED instead of writing one of them.
    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'multi-deposito-nao-suportado' });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('⚠️ a SECOND 409 rethrows for the queue and must NOT latch the listing with estado E', async () => {
    // The generic 4xx ladder would spend all three attempts and then mark a
    // perfectly healthy listing as failed, which only an `items` webhook or a
    // human clears. A version conflict is not evidence of anything being wrong.
    const h = makeHarness({
      putUserProductSellerWarehouseStock: async () => {
        throw new MercadoLivreHttpError('version mismatch', 409, null);
      },
      retryCount: LAST_ATTEMPT,
    });
    seedLink(h.db, { errors: [] });

    await expect(run(h, UP)).rejects.toMatchObject({
      constructor: MercadoLivreHttpError,
      status: 409,
    });

    expect(h.db.docs(LINK_PATH).get('link1')?.estado).toBe('p');
    expect(h.getItem).not.toHaveBeenCalled(); // the #781 verification never ran
  });

  it('a 429 still pauses the conta on this path too', async () => {
    const h = makeHarness({
      putUserProductSellerWarehouseStock: async () => {
        throw new MercadoLivreHttpError('rate limited', 429, null, 60);
      },
    });
    seedLink(h.db);

    await expect(run(h, UP)).rejects.toMatchObject({ status: 429 });
    expect(h.db.docs(STATE_PATH).get(CONTA)?.pausedUntilUs).toBe((NOW_MS + 60_000) * 1000);
  });

  it('a task with no quantity is dropped, never sent as 0', async () => {
    const h = makeHarness();
    seedLink(h.db);
    const res = await run(h, payload({ kind: 'userProductStock', quantidade: null }));
    expect(res).toEqual({ outcome: 'dropped', reason: 'payload-sem-quantidade' });
    expect(h.getUserProductStock).not.toHaveBeenCalled();
  });

  it('quantity 0 IS sent — ML re-activates an out_of_stock listing by itself on the next positive value', async () => {
    const h = makeHarness();
    seedLink(h.db);
    await run(h, payload({ kind: 'userProductStock', userProductId: 'MLBU-1', quantidade: 0 }));
    expect(h.putUserProductSellerWarehouseStock).toHaveBeenCalledWith('MLBU-1', '7', [
      { store_id: 'STORE-1', network_node_id: 'NODE-1', quantity: 0 },
    ]);
  });

  it('the master flag still gates this path', async () => {
    vi.stubEnv(STOCK_SYNC_FLAG_ENV, '');
    const h = makeHarness();
    const res = await run(h, UP);
    expect(res.outcome).toBe('skipped');
    expect(h.getUserProductStock).not.toHaveBeenCalled();
  });
});
