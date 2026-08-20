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

  /**
   * ⚠️ #1087, and it is the OPPOSITE of the rule above. A successful stock
   * update proves our payload was fine; it proves nothing about ML's POLICY
   * verdict on the listing. The case is real, not hypothetical: a
   * `poor_quality_thumbnail` moderation leaves the listing `active`, and an
   * active listing accepts stock updates — so a send lands on a moderated
   * listing routinely.
   *
   * Clearing `moderacoes` here would erase a live, still-true reason and show a
   * clean listing that is really still penalised. Hiding a real problem is worse
   * than the "no explanation" bug the field was added to fix, so this path — which
   * never called `/moderations` — must leave it exactly as it found it.
   */
  it('does NOT clear a live moderation it never asked ML about', async () => {
    const moderacao = {
      nome: 'WATERMARK',
      dataCriacao: null,
      motivo: "A foto de capa contém marcas d'água.",
      remedio: 'Corrija suas fotos de capa.',
      secoes: ['pictures'],
      evidencias: [],
    };
    const h = makeHarness();
    seedLink(h.db, {
      estado: 'p',
      errors: ['ML 400: invalid quantity'],
      moderacoes: [moderacao],
    });

    await run(h);

    const link = h.db.docs(LINK_PATH).get('link1');
    // The stock diagnosis cleared…
    expect(link).toMatchObject({ errors: [] });
    // …and the policy reason survived untouched.
    expect(link).toMatchObject({ moderacoes: [moderacao] });
  });
});
