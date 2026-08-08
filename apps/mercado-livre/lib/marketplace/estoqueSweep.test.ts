import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  type MercadoLivreApi,
  type MlUser,
} from '@delfrance/integrations-mercado-livre';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  estoqueMercadoLivreSyncCollection,
  integracaoCollection,
} from '@delfrance/data/admin/collections';

import type { MlStockTaskScheduler } from './mlStockTasks';
import {
  STOCK_SYNC_FLAG_ENV,
  type FamilyMember,
  type FetchMovimentosArgs,
  type FetchMovimentosDaJanela,
  type MovimentosDaJanela,
  chaveMovimento,
  type FetchStockFamilies,
  type FetchStockFamiliesArgs,
  type RawStockLinkRow,
  type StockFamilyPage,
  type StockFamilyRow,
} from './estoquePlan';

const h = vi.hoisted(() => ({
  loadCtx: vi.fn(),
  createApi: vi.fn(),
}));

// The sweep builds its ML API via the exact runner chain
// (loadMercadoLivreContext → resolveChannelContext → createMercadoLivreApi);
// both seams are mocked partially so the error classes stay real.
vi.mock('./mercadoLivre', async (importActual) => {
  const actual = await importActual<typeof import('./mercadoLivre')>();
  return { ...actual, loadMercadoLivreContext: h.loadCtx };
});
vi.mock('@delfrance/integrations-mercado-livre', async (importActual) => {
  const actual = await importActual<typeof import('@delfrance/integrations-mercado-livre')>();
  return { ...actual, createMercadoLivreApi: h.createApi };
});

import {
  MAX_PAGES_PER_SWEEP,
  type StockSweepDeps,
  type StockSweepMode,
  isSlotDoDaily,
  janelaDoSweep,
  runStockSweep,
} from './estoqueSweep';

/* ------------------------------ fake Firestore ---------------------------- */
// Trimmed copy of orderBackfill.test.ts's FakeDb: chained `where().get()` on a
// collection (the integração enumeration) + doc get/set with `{ merge: true }`.

type DocData = Record<string, unknown>;
type OpKind = 'get' | 'set';

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

interface FakeQuery {
  where: (field: string, op: string, value: unknown) => FakeQuery;
  limit: (n: number) => FakeQuery;
  get: () => Promise<{ docs: FakeQueryDoc[]; empty: boolean }>;
}

interface FakeCollection {
  doc: (id?: string) => FakeDocRef;
  where: (field: string, op: string, value: unknown) => FakeQuery;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly opLog: Array<{ op: OpKind; path: string }> = [];
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

  private makeQuery(entries: Array<{ id: string; data: DocData }>): FakeQuery {
    const clauses: Array<[string, unknown]> = [];
    let lim: number | null = null;
    const self = this;
    const q: FakeQuery = {
      where(field, _op, value) {
        clauses.push([field, value]);
        return q;
      },
      limit(n) {
        lim = n;
        return q;
      },
      async get() {
        self.opLog.push({ op: 'get', path: 'query' });
        let rows = entries.filter((e) => clauses.every(([f, v]) => e.data[f] === v));
        if (lim != null) rows = rows.slice(0, lim);
        return {
          docs: rows.map((e) => ({ id: e.id, data: () => e.data, exists: true as const })),
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
    const col = this.col(path);
    return {
      doc(id?: string) {
        return self.makeDocRef(path, id ?? `auto-${++self.autoN}`);
      },
      where(field, op, value) {
        const entries = [...col.entries()].map(([id, d]) => ({ id, data: d }));
        return self.makeQuery(entries).where(field, op, value);
      },
    };
  }
}

/* --------------------------------- helpers -------------------------------- */

const INTEGRACAO_PATH = integracaoCollection.resolvePath({});
const SYNC_PATH = estoqueMercadoLivreSyncCollection.resolvePath({});

const NOW_MS = Date.parse('2026-07-24T12:00:00.000Z');
const NOW_US = NOW_MS * 1000;
const DEP_REF = 'documents/depositos/dep-1';

function seedConta(db: FakeDb, id: string, depositoOuterRef: string | null = DEP_REF): void {
  db.seed(INTEGRACAO_PATH, id, {
    tipo: INTEGRACAO_TIPO.mercadoLivre,
    ativo: true,
    depositoOuterRef,
    nome: `Conta ${id}`,
  });
}

function makeScheduler() {
  const enqueue = vi.fn(async () => {});
  const scheduler: MlStockTaskScheduler = { enqueue };
  return { scheduler, enqueue };
}

/** Wire the mocked context→api chain; `getMe` feeds the DEFAULT guard seam. */
function wireCtx(getMe: () => Promise<MlUser> = async () => ({ id: 1, tags: [] })) {
  h.loadCtx.mockImplementation(async (_db: Firestore, integracaoId: string) => ({
    integracaoId,
    conta: {},
    channel: {},
    store: {},
    resolveChannelContext: async () => ({
      integracaoId,
      accessToken: `tok-${integracaoId}`,
      account: {},
    }),
    exchangeAndPersist: async () => {},
  }));
  const getMeMock = vi.fn(getMe);
  h.createApi.mockReturnValue({ getMe: getMeMock } as unknown as MercadoLivreApi);
  return { getMeMock };
}

/** Record-and-replay fetchStockFamilies stub (last page repeats when drained). */
function makeFetch(pages: StockFamilyPage[] | ((args: FetchStockFamiliesArgs) => StockFamilyPage)) {
  const calls: FetchStockFamiliesArgs[] = [];
  const fetchFamilies: FetchStockFamilies = async (_db, args) => {
    calls.push(args);
    if (typeof pages === 'function') return pages(args);
    return pages[calls.length - 1] ?? { rows: [], nextAfterAnchorId: null };
  };
  return { fetchFamilies, calls };
}

/**
 * Recording `fetchMovimentosDaJanela` stub — the ledger pre-pass seam.
 * The default is an EMPTY map, i.e. "nothing moved in the window", which makes
 * every family `anterior === atual` and therefore SKIPPED. Tests that expect a
 * send hand it a movement (see `movimentou`).
 */
function makeMovimentos(result: MovimentosDaJanela = new Map()) {
  const calls: FetchMovimentosArgs[] = [];
  const fetchMovimentos: FetchMovimentosDaJanela = async (_db, args) => {
    calls.push(args);
    return new Map(result);
  };
  return { fetchMovimentos, calls };
}

/** A ledger map saying `produtoId` moved by `dq` at the default depósito. */
function movimentou(produtoId: string, dq: number, depositoId = 'dep-1'): MovimentosDaJanela {
  return new Map([[chaveMovimento(produtoId, depositoId), { dq, dr: 0, desconhecido: false }]]);
}

/** Every anchor id the multi-row fixtures use, all reported as having moved. */
function movimentouTodos(depositoId = 'dep-1'): MovimentosDaJanela {
  return new Map(
    ['PROD-1', 'PROD-2', 'PROD-3', 'CH-1'].map((id) => [
      chaveMovimento(id, depositoId),
      { dq: 1, dr: 0, desconhecido: false },
    ]),
  );
}

function member(produtoId: string, over: Partial<FamilyMember> = {}): FamilyMember {
  return {
    produtoId,
    ehKit: false,
    ehKitVirtual: false,
    publicado: true,
    componentesKit: null,
    timestampMs: null,
    // disponivel = 10 − 2 = 8. `parentId` is what the ledger pre-pass keys on,
    // and the real projection always selects it.
    estoque: { parentId: produtoId, quantidade: 10, quantidadeReservada: 2 },
    componentEstoques: [],
    ...over,
  };
}

function link(over: Partial<RawStockLinkRow> = {}): RawStockLinkRow {
  return {
    id: 'MLB1',
    estado: 'A',
    status: 'active',
    sub_status: [],
    isUserProductModel: false,
    linkDocId: 'link-1',
    ...over,
  };
}

function familyRow(over: Partial<StockFamilyRow> = {}): StockFamilyRow {
  const anchorId = over.anchorId ?? 'PROD-1';
  return {
    anchorId,
    anchor: member(anchorId),
    integracoesComProduto: ['INT-A', 'INT-B'],
    links: [link()],
    children: [],
    ...over,
  };
}

/**
 * A family the incremental tier will send: its stock is low enough that the
 * high-stock skip cannot apply (disponivel 8 ≤ the default limiar of 100), so it
 * only needs the ledger stub to report a movement — which `run` does by default.
 */
function activeRow(over: Partial<StockFamilyRow> = {}): StockFamilyRow {
  return familyRow(over);
}

function run(
  db: FakeDb,
  mode: StockSweepMode,
  deps: Partial<StockSweepDeps> & Pick<StockSweepDeps, 'scheduler'>,
) {
  // Tests not exercising the ledger seam get a stub reporting a movement on the
  // default anchor (the production default would try to run a real pipeline
  // against the FakeDb, and an empty map would make every family unchanged →
  // skipped, which is not what the wiring specs are about).
  return runStockSweep(db as unknown as Firestore, mode, {
    nowMs: NOW_MS,
    fetchMovimentos: makeMovimentos(movimentouTodos()).fetchMovimentos,
    ...deps,
  });
}

/** The exact draft the sweep must enqueue for the default single-link family. */
function expectedDraft(mode: StockSweepMode, integracaoId: string): Record<string, unknown> {
  return {
    integracaoId,
    produtoId: 'PROD-1',
    variacaoProdutoId: null,
    kind: 'item',
    itemId: 'MLB1',
    linkDocId: 'link-1',
    quantidade: 8,
    variations: null,
    sweepId: `${mode}-${integracaoId}-${NOW_MS}`,
    sweepComputedAtMs: NOW_MS,
    reenqueues: 0,
  };
}

beforeEach(() => {
  process.env[STOCK_SYNC_FLAG_ENV] = '1';
  h.loadCtx.mockReset();
  h.createApi.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env[STOCK_SYNC_FLAG_ENV];
  delete process.env.MERCADO_LIVRE_STOCK_MAX_TASKS_PER_SWEEP;
  vi.restoreAllMocks();
});

/* ------------------------------ janelaDoSweep ------------------------------ */

describe('isSlotDoDaily', () => {
  // São Paulo is fixed UTC-3 (Brazil abolished DST in 2019): 02:MM local =
  // 05:MM UTC. The guard must flag ONLY the 02:00–02:14 slot.
  it('flags only the 02:00 São Paulo slot', () => {
    expect(isSlotDoDaily(Date.parse('2026-07-28T05:00:00Z'))).toBe(true); // 02:00
    expect(isSlotDoDaily(Date.parse('2026-07-28T05:00:41Z'))).toBe(true); // 02:00 + jitter
    expect(isSlotDoDaily(Date.parse('2026-07-28T05:14:59Z'))).toBe(true); // still the slot
    expect(isSlotDoDaily(Date.parse('2026-07-28T05:15:00Z'))).toBe(false); // 02:15 RUNS (owner call)
    expect(isSlotDoDaily(Date.parse('2026-07-28T05:30:00Z'))).toBe(false); // 02:30 runs
    expect(isSlotDoDaily(Date.parse('2026-07-28T04:45:00Z'))).toBe(false); // 01:45 runs
    expect(isSlotDoDaily(Date.parse('2026-07-28T06:00:00Z'))).toBe(false); // 03:00 runs
    expect(isSlotDoDaily(Date.parse('2026-07-28T14:00:00Z'))).toBe(false); // 11:00 runs
  });
});

describe('janelaDoSweep', () => {
  it('incremental, no cursor → default window minus overlap, modo incremental', () => {
    const janela = janelaDoSweep('incremental', NOW_MS, {});
    expect(janela.changedSinceMs).toBe(NOW_MS - 15 * 60_000 - 20_000);
    expect(janela.modo).toBe('incremental');
  });

  it('incremental, recent cursor → window starts at the cursor (ms) minus overlap', () => {
    const cursorMs = NOW_MS - 3_600_000; // 1h ago — inside the 24h cap
    const janela = janelaDoSweep('incremental', NOW_MS, { cursorUs: cursorMs * 1000 });
    expect(janela.changedSinceMs).toBe(cursorMs - 20_000);
  });

  it('incremental, stale cursor → capped at cursorMaxLookbackHours', () => {
    const cursorMs = NOW_MS - 48 * 3_600_000; // 48h ago — past the 24h cap
    const janela = janelaDoSweep('incremental', NOW_MS, { cursorUs: cursorMs * 1000 });
    expect(janela.changedSinceMs).toBe(NOW_MS - 24 * 3_600_000 - 20_000);
  });

  it('incremental, junk cursor field → treated as no cursor', () => {
    const janela = janelaDoSweep('incremental', NOW_MS, { cursorUs: 'abc' });
    expect(janela.changedSinceMs).toBe(NOW_MS - 15 * 60_000 - 20_000);
  });

  it('daily → flat dailyWindowHours lookback, modo daily (cursor ignored)', () => {
    const janela = janelaDoSweep('daily', NOW_MS, { cursorUs: 123_000 });
    expect(janela.changedSinceMs).toBe(NOW_MS - 24 * 3_600_000 - 20_000);
    expect(janela.modo).toBe('daily');
  });
});

/* -------------------------------- flag gate -------------------------------- */

describe('runStockSweep — flag gate', () => {
  it('flag off → { enabled: false }, zero Firestore/context/fetch/enqueue calls', async () => {
    delete process.env[STOCK_SYNC_FLAG_ENV];
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    wireCtx();
    const { fetchFamilies, calls } = makeFetch([]);
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(result).toEqual({ enabled: false, contas: [] });
    expect(db.opLog).toHaveLength(0);
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('flag set to anything but "1" stays off', async () => {
    process.env[STOCK_SYNC_FLAG_ENV] = 'true';
    const db = new FakeDb();
    const { scheduler } = makeScheduler();
    const { fetchFamilies } = makeFetch([]);
    expect(await run(db, 'daily', { scheduler, fetchFamilies })).toEqual({
      enabled: false,
      contas: [],
    });
    expect(db.opLog).toHaveLength(0);
  });
});

/* ------------------------------- enumeration ------------------------------- */

describe('runStockSweep — conta enumeration', () => {
  it('only ACTIVE mercadoLivre contas are swept (inactive/other-tipo filtered out)', async () => {
    const db = new FakeDb();
    db.seed(INTEGRACAO_PATH, 'INT-OFF', {
      tipo: INTEGRACAO_TIPO.mercadoLivre,
      ativo: false,
      depositoOuterRef: DEP_REF,
    });
    db.seed(INTEGRACAO_PATH, 'INT-SHOPEE', {
      tipo: INTEGRACAO_TIPO.shopee,
      ativo: true,
      depositoOuterRef: DEP_REF,
    });
    wireCtx();
    const { fetchFamilies, calls } = makeFetch([]);
    const { scheduler } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(result).toEqual({ enabled: true, contas: [] });
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('conta without depósito → lastError stamped, NO context load, NO fetch', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A', null);
    wireCtx();
    const { fetchFamilies, calls } = makeFetch([]);
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(result.contas).toEqual([
      {
        integracaoId: 'INT-A',
        enqueued: 0,
        skipped: 0,
        pages: 0,
        truncated: false,
        paused: false,
        error: 'integração sem depósito — configure o depósito da conta',
      },
    ]);
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
    // lastError + lastErrorAtUs stamped; cursorUs NOT created.
    expect(db.docs(SYNC_PATH).get('INT-A')).toEqual({
      lastError: 'integração sem depósito — configure o depósito da conta',
      lastErrorAtUs: NOW_US,
    });
  });
});

/* ---------------------------- multiorigin guard ---------------------------- */

describe('runStockSweep — multiorigin guard', () => {
  it('warehouse_management tag (via the DEFAULT api.getMe) → loud refusal, no fetch', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    const { getMeMock } = wireCtx(async () => ({ id: 9, tags: ['warehouse_management'] }));
    const { fetchFamilies, calls } = makeFetch([]);
    const { scheduler, enqueue } = makeScheduler();
    const errorSpy = vi.spyOn(console, 'error').mockClear();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(getMeMock).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(result.contas).toHaveLength(1);
    expect(result.contas[0]!.error).toContain('multiorigem');
    expect(result.contas[0]!.error).toContain('warehouse_management');
    const doc = db.docs(SYNC_PATH).get('INT-A');
    expect(doc?.lastError).toContain('multiorigem');
    expect(doc?.lastErrorAtUs).toBe(NOW_US);
    expect(doc?.cursorUs).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('multiorigem'),
      expect.objectContaining({ integracaoId: 'INT-A' }),
    );
  });

  it('deps.getMe seam overrides the api probe', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    const { getMeMock } = wireCtx(); // api.getMe would say tags: []
    const { fetchFamilies, calls } = makeFetch([]);
    const { scheduler } = makeScheduler();

    const result = await run(db, 'incremental', {
      scheduler,
      fetchFamilies,
      getMe: async () => ({ id: 9, tags: ['warehouse_management'] }),
    });

    expect(getMeMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(result.contas[0]!.error).toContain('multiorigem');
  });

  it('null tags → not multiorigin, sweep proceeds', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    wireCtx(async () => ({ id: 9, tags: null }));
    const { fetchFamilies, calls } = makeFetch([{ rows: [], nextAfterAnchorId: null }]);
    const { scheduler } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(calls).toHaveLength(1);
    expect(result.contas[0]!.error).toBeNull();
  });
});

/* -------------------------- happy path + windows --------------------------- */

describe('runStockSweep — happy path', () => {
  it('incremental: exact fetch args, real draft enqueued verbatim, cursor advanced', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    wireCtx();
    const { fetchFamilies, calls } = makeFetch([{ rows: [activeRow()], nextAfterAnchorId: null }]);
    const { fetchMovimentos, calls: movCalls } = makeMovimentos(movimentou('PROD-1', 1));
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies, fetchMovimentos });

    // THE query got the derived window.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      integracaoId: 'INT-A',
      depositoId: 'dep-1',
      changedSinceMs: NOW_MS - 15 * 60_000 - 20_000,
      afterAnchorId: null,
    });

    // The ledger pre-pass ran ONCE, over the SAME window THE query used and
    // scoped to the conta's depósito.
    expect(movCalls).toEqual([{ desdeMs: NOW_MS - 15 * 60_000 - 20_000, depositoId: 'dep-1' }]);

    // A REAL buildSendTasks draft rode through, verbatim, with the
    // deterministic sweepId and NO enqueue options (no scheduleDelaySeconds).
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expectedDraft('incremental', 'INT-A'));
    expect(enqueue.mock.calls[0]).toHaveLength(1);

    expect(result.contas).toEqual([
      {
        integracaoId: 'INT-A',
        enqueued: 1,
        skipped: 0,
        pages: 1,
        truncated: false,
        paused: false,
        error: null,
      },
    ]);
    // Success merge: cursor advanced to now (µs), lastError cleared, and
    // `continuacao` defensively cleared (nothing is left to resume).
    expect(db.docs(SYNC_PATH).get('INT-A')).toEqual({
      cursorUs: NOW_US,
      lastSweepAtUs: NOW_US,
      lastError: null,
      continuacao: null,
    });
  });

  it('incremental window derives from a seeded cursor (state doc read once)', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    const cursorMs = NOW_MS - 2 * 3_600_000;
    db.seed(SYNC_PATH, 'INT-A', { cursorUs: cursorMs * 1000 });
    wireCtx();
    const { fetchFamilies, calls } = makeFetch([{ rows: [], nextAfterAnchorId: null }]);
    const { scheduler } = makeScheduler();

    await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(calls[0]!.changedSinceMs).toBe(cursorMs - 20_000);
    const stateGets = db.opLog.filter((o) => o.op === 'get' && o.path === `${SYNC_PATH}/INT-A`);
    expect(stateGets).toHaveLength(1);
  });

  it('daily: flat window, NO sold-ids pass, lastDailyAtUs stamped, cursor untouched', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    const cursorUs = (NOW_MS - 3_600_000) * 1000;
    db.seed(SYNC_PATH, 'INT-A', { cursorUs });
    wireCtx();
    const { fetchFamilies, calls } = makeFetch([
      { rows: [familyRow()], nextAfterAnchorId: null }, // inactive family — daily still sends
    ]);
    const { fetchMovimentos, calls: movCalls } = makeMovimentos(movimentou('PROD-1', 1));
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, 'daily', { scheduler, fetchFamilies, fetchMovimentos });

    expect(calls[0]).toEqual({
      integracaoId: 'INT-A',
      depositoId: 'dep-1',
      changedSinceMs: NOW_MS - 24 * 3_600_000 - 20_000,
      afterAnchorId: null,
    });
    // The daily tier still needs `anterior` — it skips UNCHANGED families too;
    // what it does not apply is the high-stock skip.
    expect(movCalls).toEqual([{ desdeMs: NOW_MS - 24 * 3_600_000 - 20_000, depositoId: 'dep-1' }]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expectedDraft('daily', 'INT-A'));
    expect(result.contas).toEqual([
      {
        integracaoId: 'INT-A',
        enqueued: 1,
        skipped: 0,
        pages: 1,
        truncated: false,
        paused: false,
        error: null,
      },
    ]);
    // Daily merge: lastDailyAtUs only — the seeded cursor is untouched.
    expect(db.docs(SYNC_PATH).get('INT-A')).toEqual({
      cursorUs,
      lastDailyAtUs: NOW_US,
      lastError: null,
      continuacao: null,
    });
  });
});

/* ------------------------------ send policy -------------------------------- */

describe('runStockSweep — send policy', () => {
  it('drops a family whose published number did not move (counted as skipped)', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    wireCtx();
    // Nothing moved in the window ⇒ anterior === atual ⇒ no task (#695).
    const { fetchFamilies } = makeFetch([{ rows: [familyRow()], nextAfterAnchorId: null }]);
    const { fetchMovimentos } = makeMovimentos(new Map());
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies, fetchMovimentos });

    expect(enqueue).not.toHaveBeenCalled();
    expect(result.contas).toEqual([
      {
        integracaoId: 'INT-A',
        enqueued: 0,
        skipped: 1,
        pages: 1,
        truncated: false,
        paused: false,
        error: null,
      },
    ]);
    // A clean (empty) sweep still advances the cursor.
    expect(db.docs(SYNC_PATH).get('INT-A')).toEqual({
      cursorUs: NOW_US,
      lastSweepAtUs: NOW_US,
      lastError: null,
      continuacao: null,
    });
  });

  it('buildSendTasks skips are counted (link without item id)', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    wireCtx();
    const row = activeRow({ links: [link({ id: null })] });
    const { fetchFamilies } = makeFetch([{ rows: [row], nextAfterAnchorId: null }]);
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(enqueue).not.toHaveBeenCalled();
    expect(result.contas[0]).toMatchObject({ enqueued: 0, skipped: 1 });
  });
});

/* --------------------------- movement pre-pass ----------------------------- */

describe('runStockSweep — ledger pre-pass wiring', () => {
  const PARENT_LINK_REF = 'documents/produtos/PROD-1/produtoMercadoLivre/link-1';

  it('called ONCE per TICK — the memo is shared across contas and pages', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    seedConta(db, 'INT-B');
    wireCtx();
    let fetches = 0;
    // Two pages per conta: page 1 full (feeds a keyset), page 2 short.
    const fetchFamilies: FetchStockFamilies = async (_db, args) => {
      fetches += 1;
      return args.afterAnchorId == null
        ? { rows: [activeRow()], nextAfterAnchorId: 'PROD-1' }
        : { rows: [], nextAfterAnchorId: null };
    };
    const { fetchMovimentos, calls: movCalls } = makeMovimentos(movimentou('PROD-1', 1));
    const { scheduler } = makeScheduler();

    await run(db, 'incremental', { scheduler, fetchFamilies, fetchMovimentos });

    expect(fetches).toBe(4); // 2 pages × 2 contas
    // Both contas derive the SAME window from the one tick clock and share a
    // depósito here, so conta B reuses conta A's in-flight pass.
    expect(movCalls).toEqual([{ desdeMs: NOW_MS - 15 * 60_000 - 20_000, depositoId: 'dep-1' }]);
  });

  it('LAZY: a tick whose contas return NO family rows never runs the pass', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    seedConta(db, 'INT-B');
    wireCtx();
    const { fetchFamilies, calls } = makeFetch(() => ({ rows: [], nextAfterAnchorId: null }));
    const { fetchMovimentos, calls: movCalls } = makeMovimentos(movimentou('PROD-1', 1));
    const { scheduler } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies, fetchMovimentos });

    // THE query still ran per conta; the ledger pass cost NOTHING — the idle
    // 15-minute tick is exactly this shape.
    expect(calls).toHaveLength(2);
    expect(movCalls).toHaveLength(0);
    expect(result.contas.map((c) => c.error)).toEqual([null, null]);
  });

  it('a RESUMED conta keys its own memo entry (frozen window ≠ the derived one)', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    seedConta(db, 'INT-B');
    const FROZEN_CHANGED_MS = NOW_MS - 5 * 3_600_000;
    // A resumes a frozen window; B runs its own freshly derived one.
    db.seed(SYNC_PATH, 'INT-A', {
      continuacao: {
        afterAnchorId: 'PROD-9',
        changedSinceMs: FROZEN_CHANGED_MS,
        modo: 'incremental',
        startedAtUs: NOW_US - 5 * 3_600_000_000,
      },
    });
    wireCtx();
    const { fetchFamilies } = makeFetch(() => ({
      rows: [activeRow()],
      nextAfterAnchorId: null,
    }));
    const { fetchMovimentos, calls: movCalls } = makeMovimentos(movimentou('PROD-1', 1));
    const { scheduler } = makeScheduler();

    await run(db, 'incremental', { scheduler, fetchFamilies, fetchMovimentos });

    // Two DIFFERENT windows ⇒ two memo keys ⇒ two passes, in conta order.
    expect(movCalls).toEqual([
      { desdeMs: FROZEN_CHANGED_MS, depositoId: 'dep-1' },
      { desdeMs: NOW_MS - 15 * 60_000 - 20_000, depositoId: 'dep-1' },
    ]);
  });

  it('daily runs the pass too — it skips UNCHANGED families, just not high ones', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    wireCtx();
    const { fetchFamilies } = makeFetch(() => ({
      rows: [familyRow()],
      nextAfterAnchorId: null,
    }));
    // Nothing moved in the window ⇒ anterior === atual ⇒ nothing to send, even
    // on the daily tier. This is the #695 ask, and it is not incremental-only.
    const { fetchMovimentos, calls: movCalls } = makeMovimentos(new Map());
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, 'daily', { scheduler, fetchFamilies, fetchMovimentos });

    expect(movCalls).toHaveLength(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(result.contas[0]).toMatchObject({ enqueued: 0, skipped: 1 });
  });

  it('a moved ANCHOR sends the family', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    wireCtx();
    const { fetchFamilies } = makeFetch([{ rows: [familyRow()], nextAfterAnchorId: null }]);
    const { fetchMovimentos } = makeMovimentos(movimentou('PROD-1', 1));
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies, fetchMovimentos });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(result.contas[0]).toMatchObject({ enqueued: 1, skipped: 0, error: null });
  });

  it('a moved CHILD sends the family too (the whole bulk rides one task)', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    wireCtx();
    const row = familyRow({
      children: [
        {
          ...member('CH-1'),
          varLinks: [{ id: 101, produtoMercadoLivreOuterRef: PARENT_LINK_REF }],
        },
      ],
    });
    const { fetchFamilies } = makeFetch([{ rows: [row], nextAfterAnchorId: null }]);
    const { fetchMovimentos } = makeMovimentos(movimentou('CH-1', 1));
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies, fetchMovimentos });

    expect(enqueue).toHaveBeenCalledTimes(1); // the old-model bulk task
    expect(result.contas[0]).toMatchObject({ enqueued: 1, skipped: 0, error: null });
  });

  it('movement on an UNRELATED produto leaves this family unchanged ⇒ skipped', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    wireCtx();
    const { fetchFamilies } = makeFetch([{ rows: [familyRow()], nextAfterAnchorId: null }]);
    const { fetchMovimentos } = makeMovimentos(movimentou('OUTRO-PROD', 1));
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies, fetchMovimentos });

    expect(enqueue).not.toHaveBeenCalled();
    expect(result.contas[0]).toMatchObject({ enqueued: 0, skipped: 1, error: null });
  });
});

/* --------------------------------- paging ---------------------------------- */

describe('runStockSweep — page loop', () => {
  it('feeds nextAfterAnchorId back, stops on the short page', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    wireCtx();
    const rowB = activeRow({
      anchorId: 'PROD-2',
      anchor: member('PROD-2'),
      links: [link({ id: 'MLB2', linkDocId: 'link-2' })],
    });
    const { fetchFamilies, calls } = makeFetch([
      { rows: [activeRow()], nextAfterAnchorId: 'PROD-1' },
      { rows: [rowB], nextAfterAnchorId: null },
    ]);
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.afterAnchorId).toBeNull();
    expect(calls[1]!.afterAnchorId).toBe('PROD-1');
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(result.contas[0]).toMatchObject({ enqueued: 2, pages: 2, truncated: false });
    expect(db.docs(SYNC_PATH).get('INT-A')).toEqual({
      cursorUs: NOW_US,
      lastSweepAtUs: NOW_US,
      lastError: null,
      continuacao: null,
    });
  });

  it('page cap → truncated, loud warn, cursor HELD, continuation PERSISTED', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    const cursorUs = (NOW_MS - 3_600_000) * 1000;
    db.seed(SYNC_PATH, 'INT-A', { cursorUs });
    wireCtx();
    // Endless backlog: every page comes back with a next-page cursor.
    const { fetchFamilies, calls } = makeFetch(() => ({
      rows: [activeRow()],
      nextAfterAnchorId: 'PROD-1',
    }));
    const { scheduler, enqueue } = makeScheduler();
    const warnSpy = vi.spyOn(console, 'warn').mockClear();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(calls).toHaveLength(MAX_PAGES_PER_SWEEP);
    expect(enqueue).toHaveBeenCalledTimes(MAX_PAGES_PER_SWEEP);
    expect(result.contas[0]).toMatchObject({
      enqueued: MAX_PAGES_PER_SWEEP,
      pages: MAX_PAGES_PER_SWEEP,
      truncated: true,
      error: null,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('TRUNCADO'),
      expect.objectContaining({ integracaoId: 'INT-A', pages: MAX_PAGES_PER_SWEEP }),
    );
    // Cursor NOT advanced; the frozen window + keyset position are PERSISTED
    // so the next tick RESUMES this sweep instead of restarting page 1.
    expect(db.docs(SYNC_PATH).get('INT-A')).toEqual({
      cursorUs,
      lastError: null,
      continuacao: {
        afterAnchorId: 'PROD-1',
        changedSinceMs: cursorUs / 1000 - 20_000,
        modo: 'incremental',
        startedAtUs: NOW_US,
      },
    });
  });

  it('maxTasksPerSweep cap → stops enqueueing, truncated, cursor held', async () => {
    process.env.MERCADO_LIVRE_STOCK_MAX_TASKS_PER_SWEEP = '1';
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    wireCtx();
    const rowB = activeRow({
      anchorId: 'PROD-2',
      anchor: member('PROD-2'),
      links: [link({ id: 'MLB2', linkDocId: 'link-2' })],
    });
    const { fetchFamilies, calls } = makeFetch([
      { rows: [activeRow(), rowB], nextAfterAnchorId: null },
    ]);
    const { scheduler, enqueue } = makeScheduler();
    const warnSpy = vi.spyOn(console, 'warn').mockClear();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(calls).toHaveLength(1); // the cap breaks the page loop too
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expectedDraft('incremental', 'INT-A'));
    expect(result.contas[0]).toMatchObject({ enqueued: 1, truncated: true, error: null });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('limite de tasks'),
      expect.objectContaining({ integracaoId: 'INT-A', maxTasks: 1 }),
    );
    // Truncated → no cursorUs written; the resume position is the LAST anchor
    // whose drafts all went out (PROD-1), so the cut family (PROD-2) is
    // re-processed by the continuation rather than skipped.
    expect(db.docs(SYNC_PATH).get('INT-A')).toEqual({
      lastError: null,
      continuacao: {
        afterAnchorId: 'PROD-1',
        changedSinceMs: NOW_MS - 15 * 60_000 - 20_000,
        modo: 'incremental',
        startedAtUs: NOW_US,
      },
    });
  });

  it('task cap on the FIRST family of page 1 → no position to freeze, nothing persisted', async () => {
    process.env.MERCADO_LIVRE_STOCK_MAX_TASKS_PER_SWEEP = '0';
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    wireCtx();
    const { fetchFamilies } = makeFetch([{ rows: [activeRow()], nextAfterAnchorId: null }]);
    const { scheduler, enqueue } = makeScheduler();
    const warnSpy = vi.spyOn(console, 'warn').mockClear();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(enqueue).not.toHaveBeenCalled();
    expect(result.contas[0]).toMatchObject({ enqueued: 0, truncated: true, error: null });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('sem posição de retomada'),
      expect.objectContaining({ integracaoId: 'INT-A' }),
    );
    // No continuacao (there is no anchor to resume after) and no cursor move.
    expect(db.docs(SYNC_PATH).get('INT-A')).toEqual({ lastError: null });
  });
});

/* ------------------------- truncation continuation ------------------------- */

describe('runStockSweep — persistent continuation', () => {
  // A frozen INCREMENTAL continuation: window + keyset + the ORIGINAL start.
  const STARTED_US = NOW_US - 2 * 3_600_000_000; // the sweep that truncated, 2h ago
  const FROZEN_CHANGED_MS = NOW_MS - 2 * 3_600_000 - 20_000;
  const contInc = {
    afterAnchorId: 'PROD-9',
    changedSinceMs: FROZEN_CHANGED_MS,
    modo: 'incremental' as const,
    startedAtUs: STARTED_US,
  };

  it('RESUMES the frozen window + keyset verbatim and runs ONLY the continuation', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    // A cursor that would derive a DIFFERENT window if the continuation were
    // ignored — proving the frozen values (not the cursor) drove the query.
    db.seed(SYNC_PATH, 'INT-A', { cursorUs: (NOW_MS - 600_000) * 1000, continuacao: contInc });
    wireCtx();
    const { fetchFamilies, calls } = makeFetch([{ rows: [activeRow()], nextAfterAnchorId: null }]);
    const { fetchMovimentos, calls: movCalls } = makeMovimentos(movimentou('PROD-1', 1));
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies, fetchMovimentos });

    // ONE execution: the continuation only — this tick does NOT also run its
    // own re-derived window (that waits for the next tick, caps stay honest).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      integracaoId: 'INT-A',
      depositoId: 'dep-1',
      changedSinceMs: FROZEN_CHANGED_MS,
      afterAnchorId: 'PROD-9',
    });
    // The resumed ledger pass ran ONCE over the FROZEN window — never the
    // cursor-derived one this tick would otherwise compute.
    expect(movCalls).toEqual([{ desdeMs: FROZEN_CHANGED_MS, depositoId: 'dep-1' }]);
    // Tasks carry the `-cont-` sweep id (log correlation).
    expect(enqueue).toHaveBeenCalledWith({
      ...expectedDraft('incremental', 'INT-A'),
      sweepId: `incremental-cont-INT-A-${NOW_MS}`,
    });
    expect(result.contas[0]).toMatchObject({ enqueued: 1, pages: 1, truncated: false });
  });

  it('an incremental continuation that DRAINS advances cursorUs to startedAtUs', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    db.seed(SYNC_PATH, 'INT-A', { cursorUs: STARTED_US - 999, continuacao: contInc });
    wireCtx();
    const { fetchFamilies } = makeFetch([{ rows: [], nextAfterAnchorId: null }]);
    const { scheduler } = makeScheduler();

    await run(db, 'incremental', { scheduler, fetchFamilies });

    // The frozen window is covered up to the ORIGINAL sweep's start — never to
    // `now` (the tail of that window was only just swept).
    expect(db.docs(SYNC_PATH).get('INT-A')).toEqual({
      cursorUs: STARTED_US,
      lastSweepAtUs: NOW_US,
      lastError: null,
      continuacao: null,
    });
  });

  it('re-truncation moves afterAnchorId forward but PRESERVES startedAtUs', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    db.seed(SYNC_PATH, 'INT-A', { continuacao: contInc });
    wireCtx();
    // Endless backlog → the page cap truncates the continuation again. The
    // page's keyset IS its last row (the fetchStockFamilies contract).
    const { fetchFamilies, calls } = makeFetch(() => ({
      rows: [activeRow({ anchorId: 'PROD-77', anchor: member('PROD-77') })],
      nextAfterAnchorId: 'PROD-77',
    }));
    const { scheduler } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(calls[0]!.afterAnchorId).toBe('PROD-9'); // resumed where it stopped
    expect(result.contas[0]).toMatchObject({ truncated: true, pages: MAX_PAGES_PER_SWEEP });
    expect(db.docs(SYNC_PATH).get('INT-A')).toEqual({
      lastError: null,
      continuacao: { ...contInc, afterAnchorId: 'PROD-77' }, // startedAtUs kept
    });
  });

  it('a DAILY continuation resumed by an incremental tick keeps daily semantics', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    const cursorUs = (NOW_MS - 600_000) * 1000;
    const contDaily = {
      afterAnchorId: 'PROD-3',
      changedSinceMs: NOW_MS - 24 * 3_600_000 - 20_000,
      modo: 'daily' as const,
      startedAtUs: NOW_US - 900_000_000,
    };
    db.seed(SYNC_PATH, 'INT-A', { cursorUs, continuacao: contDaily });
    wireCtx();
    // A family sitting HIGH on both sides of its movement: the incremental tier
    // would skip it, so it only survives if the frozen daily policy is honoured.
    const alto = familyRow({
      anchor: member('PROD-1', {
        estoque: { parentId: 'PROD-1', quantidade: 500, quantidadeReservada: 0 },
      }),
    });
    const { fetchFamilies } = makeFetch([{ rows: [alto], nextAfterAnchorId: null }]);
    const { fetchMovimentos, calls: movCalls } = makeMovimentos(movimentou('PROD-1', 1));
    const { scheduler, enqueue } = makeScheduler();

    await run(db, 'incremental', { scheduler, fetchFamilies, fetchMovimentos });

    // The pass still runs (the daily tier needs `anterior` too) — what it does
    // NOT do is apply the high-stock skip.
    expect(movCalls).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1); // 500 → 499 sent on daily semantics
    // Drained as a DAILY sweep: lastDailyAtUs stamped, cursor untouched.
    expect(db.docs(SYNC_PATH).get('INT-A')).toEqual({
      cursorUs,
      lastDailyAtUs: NOW_US,
      lastError: null,
      continuacao: null,
    });
  });

  it('a MALFORMED continuacao is ignored — normal window, then overwritten', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    // Missing every key but one → not a resumable position.
    db.seed(SYNC_PATH, 'INT-A', { continuacao: { afterAnchorId: 'PROD-9' } });
    wireCtx();
    const { fetchFamilies, calls } = makeFetch([{ rows: [], nextAfterAnchorId: null }]);
    const { scheduler } = makeScheduler();

    await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(calls[0]).toMatchObject({
      changedSinceMs: NOW_MS - 15 * 60_000 - 20_000, // the fresh default window
      afterAnchorId: null,
    });
    expect(db.docs(SYNC_PATH).get('INT-A')).toEqual({
      cursorUs: NOW_US,
      lastSweepAtUs: NOW_US,
      lastError: null,
      continuacao: null, // the junk is cleared
    });
  });
});

/* ------------------------------- pause gate -------------------------------- */

describe('runStockSweep — 429 pause gate', () => {
  it('a paused conta is skipped whole: no probe, no fetch, no state write', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    const seeded = {
      cursorUs: (NOW_MS - 3_600_000) * 1000,
      pausedUntilUs: NOW_US + 60_000_000,
      continuacao: {
        afterAnchorId: 'PROD-9',
        changedSinceMs: NOW_MS - 7_200_000,
        modo: 'incremental',
        startedAtUs: NOW_US - 7_200_000_000,
      },
    };
    db.seed(SYNC_PATH, 'INT-A', { ...seeded });
    const { getMeMock } = wireCtx();
    const { fetchFamilies, calls } = makeFetch([]);
    const { scheduler, enqueue } = makeScheduler();
    const infoSpy = vi.spyOn(console, 'info').mockClear();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(calls).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(getMeMock).not.toHaveBeenCalled();
    expect(result.contas).toEqual([
      {
        integracaoId: 'INT-A',
        enqueued: 0,
        skipped: 0,
        pages: 0,
        truncated: false,
        paused: true,
        error: null,
      },
    ]);
    // Cursor AND continuation untouched — nothing was written at all.
    expect(db.opLog.filter((o) => o.op === 'set')).toHaveLength(0);
    expect(db.docs(SYNC_PATH).get('INT-A')).toEqual(seeded);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('pausada por 429'),
      expect.objectContaining({ integracaoId: 'INT-A' }),
    );
  });

  it('an EXPIRED pause does not gate — the sweep runs normally', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    db.seed(SYNC_PATH, 'INT-A', { pausedUntilUs: NOW_US - 1 });
    wireCtx();
    const { fetchFamilies, calls } = makeFetch([{ rows: [activeRow()], nextAfterAnchorId: null }]);
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(calls).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(result.contas[0]).toMatchObject({ enqueued: 1, paused: false, error: null });
  });

  it('a paused conta never starves the healthy ones', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    seedConta(db, 'INT-B');
    db.seed(SYNC_PATH, 'INT-A', { pausedUntilUs: NOW_US + 1 });
    wireCtx();
    const { fetchFamilies, calls } = makeFetch(() => ({
      rows: [activeRow()],
      nextAfterAnchorId: null,
    }));
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.integracaoId).toBe('INT-B');
    expect(enqueue).toHaveBeenCalledWith(expectedDraft('incremental', 'INT-B'));
    expect(result.contas.map((c) => c.paused)).toEqual([true, false]);
  });
});

/* ------------------------------- containment ------------------------------- */

describe('runStockSweep — per-conta failure isolation', () => {
  it('gRPC-coded error on conta A is contained — conta B still fully runs', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    seedConta(db, 'INT-B');
    const cursorA = (NOW_MS - 3_600_000) * 1000;
    db.seed(SYNC_PATH, 'INT-A', { cursorUs: cursorA });
    wireCtx();
    const { fetchFamilies } = makeFetch((args) => {
      if (args.integracaoId === 'INT-A') {
        throw Object.assign(new Error('14 UNAVAILABLE: connection dropped'), { code: 14 });
      }
      return { rows: [activeRow()], nextAfterAnchorId: null };
    });
    const { scheduler, enqueue } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(result.contas).toEqual([
      {
        integracaoId: 'INT-A',
        enqueued: 0,
        skipped: 0,
        pages: 0,
        truncated: false,
        paused: false,
        error: '14 UNAVAILABLE: connection dropped',
      },
      {
        integracaoId: 'INT-B',
        enqueued: 1,
        skipped: 0,
        pages: 1,
        truncated: false,
        paused: false,
        error: null,
      },
    ]);
    // A: lastError + lastErrorAtUs stamped, cursor UNCHANGED.
    expect(db.docs(SYNC_PATH).get('INT-A')).toEqual({
      cursorUs: cursorA,
      lastError: '14 UNAVAILABLE: connection dropped',
      lastErrorAtUs: NOW_US,
    });
    // B: fully processed with the exact draft + advanced cursor.
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expectedDraft('incremental', 'INT-B'));
    expect(db.docs(SYNC_PATH).get('INT-B')).toEqual({
      cursorUs: NOW_US,
      lastSweepAtUs: NOW_US,
      lastError: null,
      continuacao: null,
    });
  });

  it('a MercadoLivreError from the multiorigin probe is contained', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    wireCtx(async () => {
      throw new MercadoLivreHttpError('ML caiu (500)', 500, {});
    });
    const { fetchFamilies, calls } = makeFetch([]);
    const { scheduler } = makeScheduler();

    const result = await run(db, 'incremental', { scheduler, fetchFamilies });

    expect(calls).toHaveLength(0);
    expect(result.contas[0]!.error).toBe('ML caiu (500)');
    expect(db.docs(SYNC_PATH).get('INT-A')).toEqual({
      lastError: 'ML caiu (500)',
      lastErrorAtUs: NOW_US,
    });
  });

  it('an Error with a numeric code OUTSIDE the gRPC range (1–16) RETHROWS', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    wireCtx();
    const { fetchFamilies } = makeFetch(() => {
      throw Object.assign(new Error('unexpected: 404-coded non-plugin error'), { code: 404 });
    });
    const { scheduler } = makeScheduler();

    await expect(run(db, 'incremental', { scheduler, fetchFamilies })).rejects.toThrow('404-coded');
    // Nothing recorded for the conta — the tick failed loudly.
    expect(db.docs(SYNC_PATH).has('INT-A')).toBe(false);
  });

  it('an unclassifiable plain Error (a coding bug) RETHROWS', async () => {
    const db = new FakeDb();
    seedConta(db, 'INT-A');
    wireCtx();
    const { fetchFamilies } = makeFetch(() => {
      throw new Error('boom — coding bug');
    });
    const { scheduler } = makeScheduler();

    await expect(run(db, 'incremental', { scheduler, fetchFamilies })).rejects.toThrow(
      'boom — coding bug',
    );
  });
});
