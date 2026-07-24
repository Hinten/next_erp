import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  type MlItem,
} from '@delfrance/integrations-mercado-livre';
import { estoqueMercadoLivreSyncCollection } from '@delfrance/data/admin/collections';

import { PAUSE_REENQUEUE_JITTER_MAX_S } from './estoquePlan';
import { MlTasksDisabledError } from './mlTasks';
import {
  type MlStockSendTask,
  type StockContextLoader,
  type StockSendDeps,
  mlStockSendTaskSchema,
  processStockSendTask,
} from './estoqueSend';

/* ------------------------------ fake Firestore ----------------------------- */
// Copy of estoquePlan.test.ts's FakeDb: chained `where().orderBy().limit().get()`
// with real `==` support + a plain `.get()` on a collection (subcollection
// reads) + doc get/set with `{ merge: true }` (the admin handle's `merge()`).

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
}

interface FakeQueryDoc {
  id: string;
  data: () => DocData;
  exists: true;
}

interface Clause {
  field: string;
  op: string;
  value: unknown;
}

interface FakeQuery {
  where: (field: string, op: string, value: unknown) => FakeQuery;
  orderBy: (field: string, dir?: string) => FakeQuery;
  limit: (n: number) => FakeQuery;
  get: () => Promise<{ docs: FakeQueryDoc[]; empty: boolean }>;
}

type FakeCollection = FakeQuery & { doc: (id?: string) => FakeDocRef };

function clauseMatches(data: DocData, c: Clause): boolean {
  if (c.op === '==') return data[c.field] === c.value;
  throw new Error(`FakeDb: unsupported op ${c.op}`);
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly opLog: Array<{ op: 'get' | 'set'; path: string }> = [];
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

  private makeQuery(path: string): FakeQuery {
    const self = this;
    const clauses: Clause[] = [];
    const order: Array<[string, string]> = [];
    let lim: number | null = null;
    const q: FakeQuery = {
      where(field, op, value) {
        clauses.push({ field, op, value });
        return q;
      },
      orderBy(field, dir = 'asc') {
        order.push([field, dir]);
        return q;
      },
      limit(n) {
        lim = n;
        return q;
      },
      async get() {
        let rows = [...self.col(path).entries()].map(([id, data]) => ({ id, data }));
        rows = rows.filter((r) => clauses.every((c) => clauseMatches(r.data, c)));
        for (const [field, dir] of [...order].reverse()) {
          rows.sort((a, b) => {
            const av = String(a.data[field] ?? '');
            const bv = String(b.data[field] ?? '');
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return dir === 'desc' ? -cmp : cmp;
          });
        }
        if (lim != null) rows = rows.slice(0, lim);
        return {
          docs: rows.map((r) => ({ id: r.id, data: () => r.data, exists: true as const })),
          empty: rows.length === 0,
        };
      },
    };
    return q;
  }

  private makeDocRef(path: string, id: string): FakeDocRef {
    const self = this;
    const col = this.col(path);
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
    };
  }

  collection(path: string): FakeCollection {
    const self = this;
    return Object.assign(this.makeQuery(path), {
      doc(id?: string) {
        return self.makeDocRef(path, id ?? `auto-${++self.autoN}`);
      },
    });
  }

  // Semantic stand-in for estoquePlan's Q2 resolution pipeline: answers the
  // `documents(anchors) + link/children subqueries` shape from the SAME seeded
  // collections the tests already use, so the handler exercises the REAL
  // resolveSendUnits without per-test bundle fixtures. Stage args are ignored
  // — the Q2 stage tree itself is pinned by estoquePlan.test.ts.
  pipeline(): unknown {
    const self = this;
    // Inert chainable expression stub for the subquery terminators.
    const inertExpr: Record<string, unknown> = {};
    for (const m of ['as', 'length', 'greaterThan', 'equal']) inertExpr[m] = () => inertExpr;
    let anchorIds: string[] = [];
    const chain = {
      documents(refs: Array<{ id: string }>) {
        anchorIds = refs.map((r) => r.id);
        return chain;
      },
      define: () => chain,
      addFields: () => chain,
      // Inert absorbers for the NESTED subquery builder chains (their stage
      // trees are pinned by estoquePlan.test.ts; here only execute() matters).
      collection: () => chain,
      collectionGroup: () => chain,
      where: () => chain,
      select: () => chain,
      sort: () => chain,
      limit: () => chain,
      toArrayExpression: () => inertExpr,
      toScalarExpression: () => inertExpr,
      async execute() {
        const results = anchorIds.flatMap((id) => {
          const produto = self.docs('produtos').get(id);
          if (!produto) return []; // documents() silently omits missing docs
          const link =
            [...self.docs(`produtos/${id}/produtoMercadoLivre`).entries()]
              .map(([docId, raw]): DocData => ({ ...raw, linkDocId: docId }))
              .find(
                (l) =>
                  l.contaOuterRef === `documents/integracao/${CONTA}` ||
                  l.contaOuterRef === `integracao/${CONTA}`,
              ) ?? null;
          const children = [...self.docs('produtos').entries()]
            .filter(([, d]) => d.paiId === id)
            .map(([childId]) => ({
              childId,
              varLinks: [...self.docs(`produtos/${childId}/variacaoMercadoLivre`).values()],
            }));
          return [
            { ref: { path: `produtos/${id}` }, data: () => ({ ...produto, link, children }) },
          ];
        });
        return { results };
      },
    };
    return chain;
  }
}

function asDb(db: FakeDb): Firestore {
  return db as unknown as Firestore;
}

/* --------------------------------- helpers --------------------------------- */

const CONTA = 'conta-A';
const DEPOSITO_ID = 'DEP';
const DEP_REF = 'documents/depositos/DEP';
const NOW_MS = Date.parse('2026-07-24T12:00:00.000Z');
const NOW_US = NOW_MS * 1000;

const STATE_PATH = estoqueMercadoLivreSyncCollection.resolvePath({});
const LINK_PATH = 'produtos/PROD/produtoMercadoLivre';
const PARENT_LINK_REF = 'documents/produtos/PROD/produtoMercadoLivre/link1';

function seedAnchor(db: FakeDb, id = 'PROD', extra: DocData = {}): void {
  db.seed('produtos', id, {
    nome: `Produto ${id}`,
    paiId: null,
    publicado: true,
    ehKit: false,
    ehKitVirtual: false,
    integracoesComProduto: [CONTA],
    ...extra,
  });
}

function seedLink(db: FakeDb, produtoId = 'PROD', extra: DocData = {}): void {
  db.seed(`produtos/${produtoId}/produtoMercadoLivre`, 'link1', {
    contaOuterRef: `documents/integracao/${CONTA}`,
    id: 'MLB111',
    estado: 'p',
    status: 'active',
    sub_status: null,
    isUserProductModel: false,
    ...extra,
  });
}

function seedEstoque(db: FakeDb, produtoId: string, quantidade: number, reservada = 0): void {
  db.seed(`produtos/${produtoId}/estoques`, `est-${produtoId}-${DEPOSITO_ID}`, {
    depositoOuterRef: DEP_REF,
    quantidade,
    quantidadeReservada: reservada,
  });
}

function payload(over: Partial<MlStockSendTask> = {}): MlStockSendTask {
  return {
    integracaoId: CONTA,
    produtoId: 'PROD',
    itemId: 'MLB111',
    kind: 'item',
    variacaoProdutoId: null,
    sweepId: 'sweep-1',
    reenqueues: 0,
    ...over,
  };
}

/** UP-model variationItem payload targeting child CH1's item. */
function variationPayload(over: Partial<MlStockSendTask> = {}): MlStockSendTask {
  return payload({ kind: 'variationItem', itemId: 'MLB-CH1', variacaoProdutoId: 'CH1', ...over });
}

interface HarnessOpts {
  /** The integração doc the context loader resolves (default: has the depósito). */
  conta?: DocData;
  updateItem?: (id: string, body: Record<string, unknown>) => Promise<MlItem>;
  resolveChannelContext?: () => Promise<{ accessToken: string }>;
  jitterSec?: (maxS: number) => number;
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
  const apiFactory = vi.fn((_cfg: { getAccessToken: () => Promise<string> }) => ({ updateItem }));
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
  };
  return { db, deps, enqueue, updateItem, apiFactory, jitterSec };
}

type Harness = ReturnType<typeof makeHarness>;

function run(h: Harness, p: unknown = payload()) {
  return processStockSendTask(asDb(h.db), p, h.deps);
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ---------------------------------- tests ---------------------------------- */

describe('mlStockSendTaskSchema', () => {
  it('fills the defaults and rejects junk (targets only — no quantity field)', () => {
    const parsed = mlStockSendTaskSchema.parse({
      integracaoId: CONTA,
      produtoId: 'PROD',
      itemId: 'MLB111',
      kind: 'item',
      sweepId: 'sweep-1',
    });
    expect(parsed).toEqual(payload());
    expect(() => mlStockSendTaskSchema.parse({ integracaoId: CONTA })).toThrow();
    expect(() => mlStockSendTaskSchema.parse(payload({ kind: 'family' as never }))).toThrow();
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
    seedAnchor(h.db);
    seedLink(h.db);
    seedEstoque(h.db, 'PROD', 10);

    const res = await run(h);

    expect(res).toEqual({ outcome: 'sent', reason: null });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.updateItem).toHaveBeenCalledExactlyOnceWith('MLB111', { available_quantity: 10 });
  });
});

describe('processStockSendTask — deterministic skips', () => {
  it('integração sem depósito → skipped before any token/ML work', async () => {
    const h = makeHarness({ conta: { nome: 'sem depósito' } });
    seedAnchor(h.db);
    seedLink(h.db);

    const res = await run(h);

    expect(res).toEqual({ outcome: 'skipped', reason: 'sem-deposito' });
    expect(h.apiFactory).not.toHaveBeenCalled();
    expect(h.updateItem).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.stringContaining('sem depósito'), {
      integracaoId: CONTA,
      itemId: 'MLB111',
    });
  });

  it('gate closed since the sweep (fresh resolveSendUnits finds no unit) → skipped', async () => {
    const h = makeHarness();
    seedAnchor(h.db);
    seedLink(h.db, 'PROD', { status: 'paused', sub_status: ['paused_by_seller'] });

    const res = await run(h);

    expect(res).toEqual({ outcome: 'skipped', reason: 'unidade-ausente' });
    expect(h.updateItem).not.toHaveBeenCalled();
  });

  it('fresh quantity unavailable (kit-virtual child) → skipped, no ML call', async () => {
    const h = makeHarness();
    seedAnchor(h.db);
    seedLink(h.db, 'PROD', { isUserProductModel: true });
    // The child is send-unit-resolvable but computeQuantidades says never send.
    h.db.seed('produtos', 'CH1', { nome: 'A', paiId: 'PROD', ehKit: true, ehKitVirtual: true });
    h.db.seed('produtos/CH1/variacaoMercadoLivre', 'v1', {
      itemId: 'MLB-CH1',
      produtoMercadoLivreOuterRef: PARENT_LINK_REF,
    });

    const res = await run(h, variationPayload());

    expect(res).toEqual({ outcome: 'skipped', reason: 'quantidade-indisponivel' });
    expect(h.updateItem).not.toHaveBeenCalled();
  });
});

describe('processStockSendTask — request bodies (fresh quantities)', () => {
  it('variationItem (UP model) → single available_quantity for the child', async () => {
    const h = makeHarness({
      updateItem: async (): Promise<MlItem> => ({ id: 'MLB-CH1', status: 'active' }),
    });
    seedAnchor(h.db);
    seedLink(h.db, 'PROD', { isUserProductModel: true });
    h.db.seed('produtos', 'CH1', { nome: 'A', paiId: 'PROD' });
    h.db.seed('produtos/CH1/variacaoMercadoLivre', 'v1', {
      itemId: 'MLB-CH1',
      produtoMercadoLivreOuterRef: PARENT_LINK_REF,
    });
    seedEstoque(h.db, 'CH1', 6, 2);

    const res = await run(h, variationPayload());

    expect(res).toEqual({ outcome: 'sent', reason: null });
    expect(h.updateItem).toHaveBeenCalledExactlyOnceWith('MLB-CH1', { available_quantity: 4 });
  });

  it('old-model family → ONE bulk PUT; linkless/id-less children warn + drop out', async () => {
    const h = makeHarness();
    seedAnchor(h.db);
    seedLink(h.db); // old model (isUserProductModel false)
    h.db.seed('produtos', 'CH1', { nome: 'A', paiId: 'PROD' });
    h.db.seed('produtos', 'CH2', { nome: 'B', paiId: 'PROD' });
    h.db.seed('produtos', 'CH3', { nome: 'C', paiId: 'PROD' }); // link without a numeric id
    h.db.seed('produtos', 'CH4', { nome: 'D', paiId: 'PROD' }); // no link at all
    h.db.seed('produtos/CH1/variacaoMercadoLivre', 'v1', {
      id: 101,
      produtoMercadoLivreOuterRef: PARENT_LINK_REF,
    });
    h.db.seed('produtos/CH2/variacaoMercadoLivre', 'v2', {
      id: 102,
      produtoMercadoLivreOuterRef: PARENT_LINK_REF,
    });
    h.db.seed('produtos/CH3/variacaoMercadoLivre', 'v3', {
      id: null,
      itemId: 'MLB-UPISH',
      produtoMercadoLivreOuterRef: PARENT_LINK_REF,
    });
    seedEstoque(h.db, 'CH1', 5);
    seedEstoque(h.db, 'CH2', 9, 1);

    const res = await run(h);

    expect(res).toEqual({ outcome: 'sent', reason: null });
    // The numeric variação `id` (NOT the UP itemId), all linked children, fresh quantities.
    expect(h.updateItem).toHaveBeenCalledExactlyOnceWith('MLB111', {
      variations: [
        { id: 101, available_quantity: 5 },
        { id: 102, available_quantity: 8 },
      ],
    });
    // CH3 (no numeric id) + CH4 (no link) each warned — legacy sent what it could.
    const semLinkWarns = vi
      .mocked(console.warn)
      .mock.calls.filter((c) => String(c[0]).includes('sem link/id numérico'));
    expect(semLinkWarns).toHaveLength(2);
  });

  it('childless item → single available_quantity for the anchor', async () => {
    const h = makeHarness();
    seedAnchor(h.db);
    seedLink(h.db);
    seedEstoque(h.db, 'PROD', 12, 2);

    const res = await run(h);

    expect(res).toEqual({ outcome: 'sent', reason: null });
    expect(h.updateItem).toHaveBeenCalledExactlyOnceWith('MLB111', { available_quantity: 10 });
  });

  it('the 0..99999 clamp flows through computeQuantidades', async () => {
    const h = makeHarness();
    seedAnchor(h.db);
    seedLink(h.db);
    seedEstoque(h.db, 'PROD', 250_000);

    await run(h);

    expect(h.updateItem).toHaveBeenCalledExactlyOnceWith('MLB111', { available_quantity: 99999 });
  });
});

describe('processStockSendTask — writeback', () => {
  it('merges the fresh ML status onto the anchor link (itemsStatusSync shape)', async () => {
    const h = makeHarness({
      updateItem: async (): Promise<MlItem> => ({
        id: 'MLB111',
        status: 'paused',
        sub_status: ['out_of_stock'],
      }),
    });
    seedAnchor(h.db);
    seedLink(h.db, 'PROD', { title: 'Produto PROD' });
    seedEstoque(h.db, 'PROD', 0);

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

  it('a response without sub_status writes [] (never undefined on the wire)', async () => {
    const h = makeHarness({
      updateItem: async (): Promise<MlItem> => ({ id: 'MLB111', status: 'active' }),
    });
    seedAnchor(h.db);
    seedLink(h.db);
    seedEstoque(h.db, 'PROD', 3);

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
  function seedHappy(h: Harness): void {
    seedAnchor(h.db);
    seedLink(h.db);
    seedEstoque(h.db, 'PROD', 10);
  }

  it('429 WITH Retry-After → pause stamped from the header, counter bumped, RETHROW', async () => {
    const boom = new MercadoLivreHttpError('rate limited', 429, {}, 17);
    const h = makeHarness({
      updateItem: async (): Promise<MlItem> => {
        throw boom;
      },
    });
    seedHappy(h);
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
    seedHappy(h);

    await expect(run(h)).rejects.toBe(boom);

    expect(h.db.docs(STATE_PATH).get(CONTA)).toMatchObject({
      pausedUntilUs: (NOW_MS + 5 * 60 * 1000) * 1000,
      pauseCount: 1,
    });
  });

  it("404 (deterministic 4xx) → estado 'E' stamped on the link, SUCCESS", async () => {
    const h = makeHarness({
      updateItem: async (): Promise<MlItem> => {
        throw new MercadoLivreHttpError('ML 404: item not found', 404, null);
      },
    });
    seedHappy(h);

    const res = await run(h);

    expect(res).toEqual({ outcome: 'erro-registrado', reason: 'http-4xx' });
    expect(h.db.docs(LINK_PATH).get('link1')).toMatchObject({
      estado: 'E',
      errors: ['ML 404: item not found'],
      ultimaModificacao: NOW_MS,
    });
    expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
  });

  it('5xx → RETHROW, nothing stamped anywhere', async () => {
    const boom = new MercadoLivreHttpError('ML 500: boom', 500, null);
    const h = makeHarness({
      updateItem: async (): Promise<MlItem> => {
        throw boom;
      },
    });
    seedHappy(h);

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
    seedHappy(h);

    await expect(run(h)).rejects.toBe(boom);
  });

  it('reauth (dead credential) → NO rethrow, lastError on the state doc', async () => {
    const h = makeHarness({
      resolveChannelContext: async () => {
        throw new MercadoLivreReauthRequiredError('refresh_failed', 'reconecte a conta');
      },
    });
    seedHappy(h);

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
