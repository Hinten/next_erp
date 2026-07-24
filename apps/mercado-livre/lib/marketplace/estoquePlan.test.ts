import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

// Mock the admin Pipelines subpath with tagged-object builders (the
// firestore-pipelines skill pattern): the pipeline is NEVER executed in unit
// tests — assertions target the stages/expressions the code builds, via a fake
// `db.pipeline()` chain below.
const { mockPipelinesExports } = vi.hoisted(() => ({
  mockPipelinesExports: {
    field: (name: string) => ({ kind: 'field', name }),
    equal: (l: unknown, r: unknown) => ({ kind: 'equal', l, r }),
    greaterThan: (l: unknown, r: unknown) => ({ kind: 'gt', l, r }),
    greaterThanOrEqual: (l: unknown, r: unknown) => ({ kind: 'gte', l, r }),
    and: (...xs: unknown[]) => ({ kind: 'and', xs }),
    ascending: (f: unknown) => ({ kind: 'asc', f }),
  } as Record<string, unknown>,
}));

vi.mock('@google-cloud/firestore/pipelines', () => mockPipelinesExports);

import {
  type ChangedEstoque,
  ESTOQUE_MIN,
  KIT_PARENT_CHUNK,
  MERCADO_LIVRE_STOCK_SEND_QUEUE,
  PAUSE_REENQUEUE_JITTER_MAX_S,
  STOCK_SYNC_FLAG_ENV,
  TIPOS_VENDA,
  atividadeLookbackDays,
  candidatePageLimit,
  computeQuantidades,
  concurrentDispatches,
  cursorMaxLookbackHours,
  dailyWindowHours,
  discoverStockCandidates,
  dispatchesPerSecond,
  envFlag,
  envInt,
  estoqueMax,
  fetchChangedEstoquesPipeline,
  fetchKitParentsQuery,
  incrementalWindowMin,
  isStockSyncEnabled,
  kitIncluiEstoqueProprio,
  limiarEstoqueBaixo,
  maxPauseReenqueues,
  maxTasksPerSweep,
  podeEnviarEstoque,
  quantidadeParaEnvio,
  ratePauseMin,
  resolveSendUnits,
  windowOverlapSec,
} from './estoquePlan';

/* ------------------------------ fake Firestore ----------------------------- */
// Extension of orderBackfill.test.ts's FakeDb: chained
// `where().orderBy().limit().get()` with real op support (`==`,
// `array-contains-any`) + a plain `.get()` on a collection (subcollection
// reads) + doc get/set. Queries are logged so chunking can be asserted.

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
  if (c.op === 'array-contains-any') {
    const arr = data[c.field];
    const wanted = c.value as unknown[];
    return Array.isArray(arr) && wanted.some((w) => arr.includes(w));
  }
  throw new Error(`FakeDb: unsupported op ${c.op}`);
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly opLog: Array<{ op: 'get' | 'set'; path: string }> = [];
  readonly queryLog: Array<{
    path: string;
    clauses: Clause[];
    orderBy: Array<[string, string]>;
    limit: number | null;
  }> = [];
  private autoN = 0;

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }

  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
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
        self.queryLog.push({ path, clauses: [...clauses], orderBy: [...order], limit: lim });
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
}

function asDb(db: FakeDb | FakePipelineDb | Record<string, unknown>): Firestore {
  return db as unknown as Firestore;
}

/* ------------------------------ fake pipeline ------------------------------ */
// Chainable `db.pipeline()` recording each execution's stages and answering
// from a queue of pre-canned pages. Rows expose `{ ref: { path }, data() }` —
// the exact PipelineResult surface the code touches.

interface PipelineCall {
  collectionGroup: string | null;
  where: unknown;
  sort: unknown;
  limit: number | null;
}

interface FakePipelineStage {
  collectionGroup: (id: string) => FakePipelineStage;
  where: (expr: unknown) => FakePipelineStage;
  sort: (o: unknown) => FakePipelineStage;
  limit: (n: number) => FakePipelineStage;
  execute: () => Promise<{ results: Array<{ ref: { path: string }; data: () => DocData }> }>;
}

class FakePipelineDb {
  readonly calls: PipelineCall[] = [];
  private readonly pages: Array<Array<{ path: string; data: DocData }>> = [];

  queuePage(rows: Array<{ path: string; data: DocData }>): void {
    this.pages.push(rows);
  }

  pipeline(): FakePipelineStage {
    const self = this;
    const call: PipelineCall = { collectionGroup: null, where: null, sort: null, limit: null };
    const stage: FakePipelineStage = {
      collectionGroup(id: string) {
        call.collectionGroup = id;
        return stage;
      },
      where(expr: unknown) {
        call.where = expr;
        return stage;
      },
      sort(o: unknown) {
        call.sort = o;
        return stage;
      },
      limit(n: number) {
        call.limit = n;
        return stage;
      },
      async execute() {
        self.calls.push({ ...call });
        const rows = self.pages.shift() ?? [];
        return {
          results: rows.map((r) => ({ ref: { path: r.path }, data: () => r.data })),
        };
      },
    };
    return stage;
  }
}

/* --------------------------------- helpers --------------------------------- */

const DEP = 'documents/depositos/DEP';
const DEPOSITO_ID = 'DEP';
const CONTA = 'conta-A';
const FROM_MS = Date.parse('2026-07-24T10:00:00.000Z');
const T1 = Date.parse('2026-07-24T10:05:00.000Z');
const T2 = Date.parse('2026-07-24T10:10:00.000Z');
const T3 = Date.parse('2026-07-24T10:15:00.000Z');
const T4 = Date.parse('2026-07-24T10:20:00.000Z');

/** Every env var the tests mutate — cleared after each test. */
const TOUCHED_ENV = [
  STOCK_SYNC_FLAG_ENV,
  'MERCADO_LIVRE_STOCK_INCREMENTAL_WINDOW_MIN',
  'MERCADO_LIVRE_STOCK_LIMIAR',
  'MERCADO_LIVRE_STOCK_MAX',
  'MERCADO_LIVRE_STOCK_KIT_INCLUI_PROPRIO',
  'MERCADO_LIVRE_STOCK_CANDIDATE_PAGE_LIMIT',
  'MERCADO_LIVRE_STOCK_RATE_PAUSE_MIN',
  'ESTOQUE_PLAN_TEST_INT',
  'ESTOQUE_PLAN_TEST_FLAG',
];

function estoqueRow(
  produtoId: string,
  ms: number,
  quantidade = 0,
  quantidadeReservada = 0,
): ChangedEstoque {
  return {
    produtoId,
    estoqueDocPath: `produtos/${produtoId}/estoques/est-${produtoId}-${DEPOSITO_ID}`,
    ultimaModificacaoMs: ms,
    quantidade,
    quantidadeReservada,
  };
}

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

const PARENT_LINK_REF = 'documents/produtos/PROD/produtoMercadoLivre/link1';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of TOUCHED_ENV) delete process.env[k];
  vi.restoreAllMocks();
});

/* ---------------------------------- tests ---------------------------------- */

describe('constants', () => {
  it('pure code constants keep their spec values', () => {
    expect(ESTOQUE_MIN).toBe(0);
    expect(TIPOS_VENDA).toEqual(['reserva', 'saida']);
    expect(KIT_PARENT_CHUNK).toBe(10);
    expect(PAUSE_REENQUEUE_JITTER_MAX_S).toBe(30);
    expect(MERCADO_LIVRE_STOCK_SEND_QUEUE).toBe('sendMercadoLivreStock');
    expect(STOCK_SYNC_FLAG_ENV).toBe('MERCADO_LIVRE_STOCK_SYNC_ENABLED');
  });
});

describe('env helpers', () => {
  it('envInt: unset → fallback; valid override wins; read lazily at call time', () => {
    expect(envInt('ESTOQUE_PLAN_TEST_INT', 42)).toBe(42);
    process.env.ESTOQUE_PLAN_TEST_INT = '7';
    expect(envInt('ESTOQUE_PLAN_TEST_INT', 42)).toBe(7);
    process.env.ESTOQUE_PLAN_TEST_INT = '0';
    expect(envInt('ESTOQUE_PLAN_TEST_INT', 42)).toBe(0);
  });

  it('envInt: bad values (non-numeric, negative, fractional, blank) → fallback', () => {
    for (const bad of ['abc', '-3', '1.5', '', '  ']) {
      process.env.ESTOQUE_PLAN_TEST_INT = bad;
      expect(envInt('ESTOQUE_PLAN_TEST_INT', 42), `value ${JSON.stringify(bad)}`).toBe(42);
    }
  });

  it("envFlag: true only on exactly '1'", () => {
    expect(envFlag('ESTOQUE_PLAN_TEST_FLAG')).toBe(false);
    process.env.ESTOQUE_PLAN_TEST_FLAG = 'true';
    expect(envFlag('ESTOQUE_PLAN_TEST_FLAG')).toBe(false);
    process.env.ESTOQUE_PLAN_TEST_FLAG = '1';
    expect(envFlag('ESTOQUE_PLAN_TEST_FLAG')).toBe(true);
  });

  it('config getters expose the documented defaults', () => {
    expect(isStockSyncEnabled()).toBe(false);
    expect(incrementalWindowMin()).toBe(15);
    expect(windowOverlapSec()).toBe(20);
    expect(cursorMaxLookbackHours()).toBe(24);
    expect(dailyWindowHours()).toBe(24);
    expect(atividadeLookbackDays()).toBe(30);
    expect(limiarEstoqueBaixo()).toBe(5);
    expect(estoqueMax()).toBe(99999);
    expect(kitIncluiEstoqueProprio()).toBe(false);
    expect(candidatePageLimit()).toBe(1000);
    expect(maxTasksPerSweep()).toBe(2000);
    expect(ratePauseMin()).toBe(5);
    expect(maxPauseReenqueues()).toBe(10);
    expect(dispatchesPerSecond()).toBe(2);
    expect(concurrentDispatches()).toBe(2);
  });

  it('getters re-read the env on every call (no module-load caching)', () => {
    expect(limiarEstoqueBaixo()).toBe(5);
    process.env.MERCADO_LIVRE_STOCK_LIMIAR = '9';
    expect(limiarEstoqueBaixo()).toBe(9);
    process.env[STOCK_SYNC_FLAG_ENV] = '1';
    expect(isStockSyncEnabled()).toBe(true);
    process.env.MERCADO_LIVRE_STOCK_INCREMENTAL_WINDOW_MIN = '30';
    expect(incrementalWindowMin()).toBe(30);
    process.env.MERCADO_LIVRE_STOCK_RATE_PAUSE_MIN = '10';
    expect(ratePauseMin()).toBe(10);
  });
});

describe('podeEnviarEstoque — listing-status whitelist', () => {
  it('covers every documented status × sub_status plus unknown/null', () => {
    const cases: Array<{
      status: string | null | undefined;
      sub: string[] | null;
      enviar: boolean;
      desconhecido: boolean;
    }> = [
      { status: 'active', sub: null, enviar: true, desconhecido: false },
      { status: 'active', sub: [], enviar: true, desconhecido: false },
      { status: 'active', sub: ['whatever'], enviar: true, desconhecido: false },
      { status: 'paused', sub: ['out_of_stock'], enviar: true, desconhecido: false },
      { status: 'paused', sub: ['paused_by_seller'], enviar: false, desconhecido: false },
      {
        status: 'paused',
        sub: ['picture_downloading_pending'],
        enviar: false,
        desconhecido: false,
      },
      { status: 'paused', sub: null, enviar: false, desconhecido: false },
      { status: 'paused', sub: [], enviar: false, desconhecido: false },
      {
        status: 'paused',
        sub: ['paused_by_seller', 'out_of_stock'],
        enviar: true,
        desconhecido: false,
      },
      { status: 'under_review', sub: ['warning'], enviar: false, desconhecido: false },
      { status: 'under_review', sub: ['waiting_for_patch'], enviar: false, desconhecido: false },
      { status: 'under_review', sub: ['held'], enviar: false, desconhecido: false },
      {
        status: 'under_review',
        sub: ['pending_documentation'],
        enviar: false,
        desconhecido: false,
      },
      { status: 'under_review', sub: ['forbidden'], enviar: false, desconhecido: false },
      { status: 'closed', sub: ['expired'], enviar: false, desconhecido: false },
      { status: 'closed', sub: ['deleted'], enviar: false, desconhecido: false },
      { status: 'closed', sub: ['suspended'], enviar: false, desconhecido: false },
      { status: 'closed', sub: ['freezed'], enviar: false, desconhecido: false },
      // The whitelist is status-scoped: out_of_stock does NOT rescue non-paused.
      { status: 'closed', sub: ['out_of_stock'], enviar: false, desconhecido: false },
      { status: 'inactive', sub: null, enviar: false, desconhecido: false },
      { status: 'payment_required', sub: null, enviar: false, desconhecido: false },
      // Outside the documented set → desconhecido, never enviar.
      { status: 'some_future_status', sub: null, enviar: false, desconhecido: true },
      { status: 'some_future_status', sub: ['out_of_stock'], enviar: false, desconhecido: true },
      { status: null, sub: null, enviar: false, desconhecido: true },
      { status: undefined, sub: ['out_of_stock'], enviar: false, desconhecido: true },
    ];
    for (const c of cases) {
      expect(
        podeEnviarEstoque(c.status, c.sub),
        `status=${String(c.status)} sub=${JSON.stringify(c.sub)}`,
      ).toEqual({ enviar: c.enviar, desconhecido: c.desconhecido });
    }
  });
});

describe('quantidadeParaEnvio — kit math + clamps', () => {
  const base = {
    ehKit: false,
    ehKitVirtual: false,
    componentesKit: null,
    ownDisponivel: 0,
    disponivelByProdutoId: {},
  };

  it('kit virtual → null, regardless of any available stock', () => {
    expect(
      quantidadeParaEnvio({
        ...base,
        ehKit: true,
        ehKitVirtual: true,
        componentesKit: { A: { quantidade: 1, limitarEstoque: true, timestamp: null } },
        ownDisponivel: 50,
        disponivelByProdutoId: { A: 50 },
      }),
    ).toBeNull();
  });

  it('non-kit: own disponivel floored', () => {
    expect(quantidadeParaEnvio({ ...base, ownDisponivel: 7.9 })).toBe(7);
  });

  it('non-kit: negative clamps to ESTOQUE_MIN (0)', () => {
    expect(quantidadeParaEnvio({ ...base, ownDisponivel: -3.2 })).toBe(0);
  });

  it('non-kit: clamps to the 99999 ceiling, env-overridable', () => {
    expect(quantidadeParaEnvio({ ...base, ownDisponivel: 250000 })).toBe(99999);
    process.env.MERCADO_LIVRE_STOCK_MAX = '500';
    expect(quantidadeParaEnvio({ ...base, ownDisponivel: 250000 })).toBe(500);
  });

  it('kit: min over constraining components of disponivel/quantidade', () => {
    expect(
      quantidadeParaEnvio({
        ...base,
        ehKit: true,
        componentesKit: {
          A: { quantidade: 2, limitarEstoque: true, timestamp: null },
          B: { quantidade: 3, limitarEstoque: true, timestamp: null },
        },
        ownDisponivel: 100,
        disponivelByProdutoId: { A: 10, B: 9 },
      }),
    ).toBe(3); // min(10/2 = 5, 9/3 = 3), own stock NOT added by default
  });

  it('kit: limitarEstoque:false components do not constrain', () => {
    expect(
      quantidadeParaEnvio({
        ...base,
        ehKit: true,
        componentesKit: {
          A: { quantidade: 1, limitarEstoque: false, timestamp: null },
          B: { quantidade: 2, limitarEstoque: true, timestamp: null },
        },
        ownDisponivel: 0,
        disponivelByProdutoId: { A: 0, B: 8 },
      }),
    ).toBe(4);
  });

  it('kit: a component with no resolvable disponivel counts as 0 (#238)', () => {
    expect(
      quantidadeParaEnvio({
        ...base,
        ehKit: true,
        componentesKit: {
          A: { quantidade: 2, limitarEstoque: true, timestamp: null },
          B: { quantidade: 1, limitarEstoque: true, timestamp: null },
        },
        ownDisponivel: 100,
        disponivelByProdutoId: { A: 10 }, // B missing → 0
      }),
    ).toBe(0);
  });

  it('kit: unconstrained (all limitarEstoque:false / empty map) falls back to own stock', () => {
    expect(
      quantidadeParaEnvio({
        ...base,
        ehKit: true,
        componentesKit: { A: { quantidade: 1, limitarEstoque: false, timestamp: null } },
        ownDisponivel: 6.7,
        disponivelByProdutoId: { A: 100 },
      }),
    ).toBe(6);
    expect(
      quantidadeParaEnvio({ ...base, ehKit: true, componentesKit: null, ownDisponivel: 6 }),
    ).toBe(6);
  });

  it('kit: fractional min floors (unrounded min, floored only at the end)', () => {
    expect(
      quantidadeParaEnvio({
        ...base,
        ehKit: true,
        componentesKit: { A: { quantidade: 3, limitarEstoque: true, timestamp: null } },
        ownDisponivel: 0,
        disponivelByProdutoId: { A: 10 },
      }),
    ).toBe(3); // 10/3 = 3.33…
  });

  it('kit: negative min clamps to 0', () => {
    expect(
      quantidadeParaEnvio({
        ...base,
        ehKit: true,
        componentesKit: { A: { quantidade: 1, limitarEstoque: true, timestamp: null } },
        ownDisponivel: 100,
        disponivelByProdutoId: { A: -5 },
      }),
    ).toBe(0);
  });

  it('kit own-stock hook: explicit option wins, env flag sets the default', () => {
    const args = {
      ...base,
      ehKit: true,
      componentesKit: { A: { quantidade: 2, limitarEstoque: true, timestamp: null } },
      ownDisponivel: 4,
      disponivelByProdutoId: { A: 10 },
    };
    expect(quantidadeParaEnvio(args)).toBe(5); // default OFF → min only
    expect(quantidadeParaEnvio({ ...args, incluirEstoqueProprioDoKit: true })).toBe(9);
    expect(quantidadeParaEnvio({ ...args, incluirEstoqueProprioDoKit: false })).toBe(5);
    process.env.MERCADO_LIVRE_STOCK_KIT_INCLUI_PROPRIO = '1';
    expect(quantidadeParaEnvio(args)).toBe(9); // env default ON
    expect(quantidadeParaEnvio({ ...args, incluirEstoqueProprioDoKit: false })).toBe(5);
  });
});

describe('fetchChangedEstoquesPipeline — stages, paging, tie de-dup', () => {
  it('single short page: exact stages + mapped rows (produtoId from the doc path)', async () => {
    const fake = new FakePipelineDb();
    fake.queuePage([
      {
        path: 'produtos/PROD-1/estoques/est-PROD-1-DEP',
        data: { ultimaModificacao: T1, quantidade: 5, quantidadeReservada: 2 },
      },
      // Missing quantities tolerate legacy docs → 0.
      { path: 'produtos/PROD-2/estoques/est-PROD-2-DEP', data: { ultimaModificacao: T2 } },
    ]);

    const rows = await fetchChangedEstoquesPipeline(asDb(fake), {
      depositoOuterRef: DEP,
      fromMs: FROM_MS,
      pageLimit: 10,
    });

    expect(rows).toEqual([
      {
        produtoId: 'PROD-1',
        estoqueDocPath: 'produtos/PROD-1/estoques/est-PROD-1-DEP',
        ultimaModificacaoMs: T1,
        quantidade: 5,
        quantidadeReservada: 2,
      },
      {
        produtoId: 'PROD-2',
        estoqueDocPath: 'produtos/PROD-2/estoques/est-PROD-2-DEP',
        ultimaModificacaoMs: T2,
        quantidade: 0,
        quantidadeReservada: 0,
      },
    ]);

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.collectionGroup).toBe('estoques');
    expect(call.where).toEqual({
      kind: 'and',
      xs: [
        { kind: 'equal', l: { kind: 'field', name: 'depositoOuterRef' }, r: DEP },
        { kind: 'gt', l: { kind: 'field', name: 'ultimaModificacao' }, r: FROM_MS },
      ],
    });
    expect(call.sort).toEqual({ kind: 'asc', f: { kind: 'field', name: 'ultimaModificacao' } });
    expect(call.limit).toBe(10);
  });

  it('drains a >2-page backlog: full re-cover pages keep paging until a short page', async () => {
    // Regression guard: termination MUST be on RAW page size, not de-duplicated
    // new-row count — every `>=` re-cover re-fetches its boundary doc, so a
    // new-row-based break would hard-cap the scan at 2 pages and drop D.
    const fake = new FakePipelineDb();
    fake.queuePage([
      { path: 'produtos/A/estoques/est-A-DEP', data: { ultimaModificacao: T1 } },
      { path: 'produtos/B/estoques/est-B-DEP', data: { ultimaModificacao: T2 } },
    ]);
    // `>= T2` re-cover: boundary dup + one new row — still a FULL page.
    fake.queuePage([
      { path: 'produtos/B/estoques/est-B-DEP', data: { ultimaModificacao: T2 } },
      { path: 'produtos/C/estoques/est-C-DEP', data: { ultimaModificacao: T3 } },
    ]);
    // `>= T3` re-cover: boundary dup + the tail row — short page ends the scan.
    fake.queuePage([
      { path: 'produtos/C/estoques/est-C-DEP', data: { ultimaModificacao: T3 } },
      { path: 'produtos/D/estoques/est-D-DEP', data: { ultimaModificacao: T4 } },
    ]);
    fake.queuePage([{ path: 'produtos/D/estoques/est-D-DEP', data: { ultimaModificacao: T4 } }]);

    const rows = await fetchChangedEstoquesPipeline(asDb(fake), {
      depositoOuterRef: DEP,
      fromMs: FROM_MS,
      pageLimit: 2,
    });

    expect(rows.map((r) => r.produtoId)).toEqual(['A', 'B', 'C', 'D']); // no dups, no drops
    // Page 3 was full (dup + D), so one final `>= T4` re-cover comes back
    // all-dups-short and drains; the 4th queued page proves the loop got there.
    expect(fake.calls).toHaveLength(4);
    // Page 1: strict `>` on the window start; re-covers: inclusive `>=` on the tie.
    expect(fake.calls[0]!.where).toEqual({
      kind: 'and',
      xs: [
        { kind: 'equal', l: { kind: 'field', name: 'depositoOuterRef' }, r: DEP },
        { kind: 'gt', l: { kind: 'field', name: 'ultimaModificacao' }, r: FROM_MS },
      ],
    });
    expect(fake.calls[1]!.where).toEqual({
      kind: 'and',
      xs: [
        { kind: 'equal', l: { kind: 'field', name: 'depositoOuterRef' }, r: DEP },
        { kind: 'gte', l: { kind: 'field', name: 'ultimaModificacao' }, r: T2 },
      ],
    });
    expect(fake.calls[2]!.where).toEqual({
      kind: 'and',
      xs: [
        { kind: 'equal', l: { kind: 'field', name: 'depositoOuterRef' }, r: DEP },
        { kind: 'gte', l: { kind: 'field', name: 'ultimaModificacao' }, r: T3 },
      ],
    });
    expect(fake.calls[3]!.where).toEqual({
      kind: 'and',
      xs: [
        { kind: 'equal', l: { kind: 'field', name: 'depositoOuterRef' }, r: DEP },
        { kind: 'gte', l: { kind: 'field', name: 'ultimaModificacao' }, r: T4 },
      ],
    });
  });

  it('a FULL re-cover page of only already-seen rows truncates loudly instead of spinning', async () => {
    // > pageLimit docs sharing one ultimaModificacao: the `>=` bound cannot
    // advance, so the loop must warn and stop rather than loop forever.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fake = new FakePipelineDb();
      fake.queuePage([{ path: 'produtos/A/estoques/est-A-DEP', data: { ultimaModificacao: T1 } }]);
      fake.queuePage([{ path: 'produtos/A/estoques/est-A-DEP', data: { ultimaModificacao: T1 } }]);

      const rows = await fetchChangedEstoquesPipeline(asDb(fake), {
        depositoOuterRef: DEP,
        fromMs: FROM_MS,
        pageLimit: 1,
      });

      expect(rows.map((r) => r.produtoId)).toEqual(['A']);
      expect(fake.calls).toHaveLength(2); // full page → one re-cover → all dups → stop
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('truncating scan');
    } finally {
      warn.mockRestore();
    }
  });

  it('default page size comes from MERCADO_LIVRE_STOCK_CANDIDATE_PAGE_LIMIT, lazily', async () => {
    process.env.MERCADO_LIVRE_STOCK_CANDIDATE_PAGE_LIMIT = '3';
    const fake = new FakePipelineDb();
    fake.queuePage([{ path: 'produtos/A/estoques/est-A-DEP', data: { ultimaModificacao: T1 } }]);

    await fetchChangedEstoquesPipeline(asDb(fake), { depositoOuterRef: DEP, fromMs: FROM_MS });

    expect(fake.calls[0]!.limit).toBe(3);
  });
});

describe('fetchKitParentsQuery — chunking + dedup', () => {
  it('chunks at KIT_PARENT_CHUNK and de-dups parents matched by several chunks', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'KIT-A', { componentesKitKeys: ['c0'] });
    db.seed('produtos', 'KIT-B', { componentesKitKeys: ['c15'] });
    // Matched by chunk 1 (c0) AND chunk 3 (c24) → must come back once.
    db.seed('produtos', 'KIT-C', { componentesKitKeys: ['c24', 'c0'] });
    db.seed('produtos', 'NOT-KIT', { componentesKitKeys: ['other'] });

    const componentIds = Array.from({ length: 25 }, (_, i) => `c${i}`);
    const parents = await fetchKitParentsQuery(asDb(db), componentIds);

    expect(parents.map((p) => p.produtoId).sort()).toEqual(['KIT-A', 'KIT-B', 'KIT-C']);
    expect(db.queryLog).toHaveLength(3); // ceil(25 / 10)
    const chunks = db.queryLog.map((q) => q.clauses[0]!);
    expect(chunks.every((c) => c.field === 'componentesKitKeys')).toBe(true);
    expect(chunks.every((c) => c.op === 'array-contains-any')).toBe(true);
    expect((chunks[0]!.value as string[]).length).toBe(KIT_PARENT_CHUNK);
    expect((chunks[1]!.value as string[]).length).toBe(KIT_PARENT_CHUNK);
    expect(chunks[2]!.value).toEqual(['c20', 'c21', 'c22', 'c23', 'c24']);
  });

  it('de-dups input component ids before chunking', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'KIT-A', { componentesKitKeys: ['c1'] });
    await fetchKitParentsQuery(asDb(db), ['c1', 'c1', 'c2']);
    expect(db.queryLog).toHaveLength(1);
    expect(db.queryLog[0]!.clauses[0]!.value).toEqual(['c1', 'c2']);
  });

  it('empty input → no query at all', async () => {
    const db = new FakeDb();
    expect(await fetchKitParentsQuery(asDb(db), [])).toEqual([]);
    expect(db.queryLog).toHaveLength(0);
  });

  it('filters non-string entries out of the returned componentesKitKeys', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'KIT-A', { componentesKitKeys: ['c1', 42, null] });
    const parents = await fetchKitParentsQuery(asDb(db), ['c1']);
    expect(parents).toEqual([{ produtoId: 'KIT-A', componentesKitKeys: ['c1'] }]);
  });
});

describe('discoverStockCandidates — direct + kit expansion', () => {
  const dummyDb = asDb({});

  it('direct candidates carry the estoque fields with ehExpansaoDeKit false', async () => {
    const changed = [estoqueRow('A', T1, 3, 1), estoqueRow('B', T2, 8, 0)];
    const fetchChanged = vi.fn(async () => changed);
    const fetchKitParents = vi.fn(async () => []);

    const map = await discoverStockCandidates(
      dummyDb,
      { depositoOuterRef: DEP, fromMs: FROM_MS },
      { fetchChanged, fetchKitParents },
    );

    expect(fetchChanged).toHaveBeenCalledWith(dummyDb, { depositoOuterRef: DEP, fromMs: FROM_MS });
    expect(fetchKitParents).toHaveBeenCalledWith(dummyDb, ['A', 'B']);
    expect([...map.keys()]).toEqual(['A', 'B']);
    expect(map.get('A')).toEqual({ ...estoqueRow('A', T1, 3, 1), ehExpansaoDeKit: false });
  });

  it('kit parents join with the TRIGGERING component estoque fields, flagged', async () => {
    const changed = [estoqueRow('A', T1, 2, 0)];
    const fetchChanged = vi.fn(async () => changed);
    const fetchKitParents = vi.fn(async () => [
      { produtoId: 'KIT', componentesKitKeys: ['X', 'A'] },
    ]);

    const map = await discoverStockCandidates(
      dummyDb,
      { depositoOuterRef: DEP, fromMs: FROM_MS },
      { fetchChanged, fetchKitParents },
    );

    expect(map.get('KIT')).toEqual({
      ...estoqueRow('A', T1, 2, 0), // the component's doc — provenance documented
      produtoId: 'KIT',
      ehExpansaoDeKit: true,
    });
  });

  it('a parent whose OWN estoque also changed stays a direct candidate', async () => {
    const changed = [estoqueRow('A', T1, 2, 0), estoqueRow('KIT', T2, 6, 1)];
    const fetchChanged = vi.fn(async () => changed);
    const fetchKitParents = vi.fn(async () => [{ produtoId: 'KIT', componentesKitKeys: ['A'] }]);

    const map = await discoverStockCandidates(
      dummyDb,
      { depositoOuterRef: DEP, fromMs: FROM_MS },
      { fetchChanged, fetchKitParents },
    );

    expect(map.get('KIT')).toEqual({ ...estoqueRow('KIT', T2, 6, 1), ehExpansaoDeKit: false });
    expect(map.size).toBe(2);
  });

  it('no changed estoques → no kit-parent query, empty map', async () => {
    const fetchChanged = vi.fn(async () => []);
    const fetchKitParents = vi.fn(async () => []);
    const map = await discoverStockCandidates(
      dummyDb,
      { depositoOuterRef: DEP, fromMs: FROM_MS },
      { fetchChanged, fetchKitParents },
    );
    expect(map.size).toBe(0);
    expect(fetchKitParents).not.toHaveBeenCalled();
  });

  it('a seam-returned parent triggered by none of the changed rows is dropped', async () => {
    const fetchChanged = vi.fn(async () => [estoqueRow('A', T1)]);
    const fetchKitParents = vi.fn(async () => [
      { produtoId: 'KIT', componentesKitKeys: ['unrelated'] },
    ]);
    const map = await discoverStockCandidates(
      dummyDb,
      { depositoOuterRef: DEP, fromMs: FROM_MS },
      { fetchChanged, fetchKitParents },
    );
    expect(map.has('KIT')).toBe(false);
  });
});

describe('resolveSendUnits', () => {
  function run(db: FakeDb, produtoId = 'PROD') {
    return resolveSendUnits(asDb(db), { integracaoId: CONTA, produtoId });
  }

  it('old model happy path → ONE family item unit', async () => {
    const db = new FakeDb();
    seedAnchor(db);
    seedLink(db);
    expect(await run(db)).toEqual({
      units: [{ kind: 'item', itemId: 'MLB111', produtoId: 'PROD', variacaoProdutoId: null }],
      skips: [],
    });
  });

  it('old model with variation children STILL yields one family unit', async () => {
    const db = new FakeDb();
    seedAnchor(db);
    seedLink(db);
    db.seed('produtos', 'CH1', { nome: 'Child 1', paiId: 'PROD' });
    db.seed('produtos', 'CH2', { nome: 'Child 2', paiId: 'PROD' });
    const res = await run(db);
    expect(res.units).toEqual([
      { kind: 'item', itemId: 'MLB111', produtoId: 'PROD', variacaoProdutoId: null },
    ]);
  });

  it('paused + out_of_stock is enviável (ML auto-reactivates on qty > 0)', async () => {
    const db = new FakeDb();
    seedAnchor(db);
    seedLink(db, 'PROD', { status: 'paused', sub_status: ['out_of_stock'] });
    const res = await run(db);
    expect(res.units).toHaveLength(1);
    expect(res.skips).toEqual([]);
  });

  it('missing produto doc → sem-link (produto deleted mid-sweep)', async () => {
    const db = new FakeDb();
    expect(await run(db, 'GONE')).toEqual({
      units: [],
      skips: [{ produtoId: 'GONE', reason: 'sem-link' }],
    });
  });

  it('no link doc at all → sem-link', async () => {
    const db = new FakeDb();
    seedAnchor(db);
    expect((await run(db)).skips).toEqual([{ produtoId: 'PROD', reason: 'sem-link' }]);
  });

  it("another conta's link does not count → sem-link", async () => {
    const db = new FakeDb();
    seedAnchor(db);
    seedLink(db, 'PROD', { contaOuterRef: 'documents/integracao/conta-OUTRA' });
    expect((await run(db)).skips).toEqual([{ produtoId: 'PROD', reason: 'sem-link' }]);
  });

  it('link never published (id null) → sem-item-id', async () => {
    const db = new FakeDb();
    seedAnchor(db);
    seedLink(db, 'PROD', { id: null });
    expect((await run(db)).skips).toEqual([{ produtoId: 'PROD', reason: 'sem-item-id' }]);
  });

  it("estado 'am' (mid-UP-migration, Flutter-driven) → aguardando-migracao", async () => {
    const db = new FakeDb();
    seedAnchor(db);
    seedLink(db, 'PROD', { estado: 'am' });
    expect((await run(db)).skips).toEqual([{ produtoId: 'PROD', reason: 'aguardando-migracao' }]);
  });

  it('non-enviável documented status → status-nao-enviavel, NO warn', async () => {
    const db = new FakeDb();
    seedAnchor(db);
    seedLink(db, 'PROD', { status: 'paused', sub_status: ['paused_by_seller'] });
    const warnSpy = vi.spyOn(console, 'warn').mockClear();
    expect((await run(db)).skips).toEqual([{ produtoId: 'PROD', reason: 'status-nao-enviavel' }]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('undocumented status → status-nao-enviavel + loud warn (status tracking)', async () => {
    const db = new FakeDb();
    seedAnchor(db);
    seedLink(db, 'PROD', { status: 'brand_new_status', sub_status: null });
    const warnSpy = vi.spyOn(console, 'warn').mockClear();
    expect((await run(db)).skips).toEqual([{ produtoId: 'PROD', reason: 'status-nao-enviavel' }]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('status'),
      expect.objectContaining({ produtoId: 'PROD', itemId: 'MLB111', status: 'brand_new_status' }),
    );
  });

  it('ehKitVirtual anchor → kit-virtual', async () => {
    const db = new FakeDb();
    seedAnchor(db, 'PROD', { ehKitVirtual: true });
    seedLink(db);
    expect((await run(db)).skips).toEqual([{ produtoId: 'PROD', reason: 'kit-virtual' }]);
  });

  it('unpublished anchor → nao-publicado', async () => {
    const db = new FakeDb();
    seedAnchor(db, 'PROD', { publicado: false });
    seedLink(db);
    expect((await run(db)).skips).toEqual([{ produtoId: 'PROD', reason: 'nao-publicado' }]);
  });

  it('conta not in integracoesComProduto → conta-fora-do-produto', async () => {
    const db = new FakeDb();
    seedAnchor(db, 'PROD', { integracoesComProduto: ['outra-conta'] });
    seedLink(db);
    expect((await run(db)).skips).toEqual([{ produtoId: 'PROD', reason: 'conta-fora-do-produto' }]);
  });

  it('skip reasons follow the documented evaluation order', async () => {
    // Link-level reasons before produto-level gates: estado 'am' wins over an
    // unknown status AND over kit-virtual/nao-publicado.
    const db = new FakeDb();
    seedAnchor(db, 'PROD', { ehKitVirtual: true, publicado: false });
    seedLink(db, 'PROD', { estado: 'am', status: 'weird' });
    expect((await run(db)).skips).toEqual([{ produtoId: 'PROD', reason: 'aguardando-migracao' }]);

    // status gate before the produto-level gates.
    const db2 = new FakeDb();
    seedAnchor(db2, 'PROD', { ehKitVirtual: true });
    seedLink(db2, 'PROD', { status: 'paused', sub_status: [] });
    expect((await run(db2)).skips).toEqual([{ produtoId: 'PROD', reason: 'status-nao-enviavel' }]);
  });

  it('UP model: one variationItem unit per child, ordered by nome', async () => {
    const db = new FakeDb();
    seedAnchor(db);
    seedLink(db, 'PROD', { isUserProductModel: true });
    // Insertion order is CH1 then CH2; nome order is CH2 ('Alpha') first.
    db.seed('produtos', 'CH1', { nome: 'Beta', paiId: 'PROD' });
    db.seed('produtos', 'CH2', { nome: 'Alpha', paiId: 'PROD' });
    db.seed('produtos/CH1/variacaoMercadoLivre', 'v1', {
      itemId: 'MLB-CH1',
      produtoMercadoLivreOuterRef: PARENT_LINK_REF,
    });
    db.seed('produtos/CH2/variacaoMercadoLivre', 'v2', {
      itemId: 'MLB-CH2',
      produtoMercadoLivreOuterRef: PARENT_LINK_REF,
    });
    // A stale link pointing at ANOTHER parent link must be ignored.
    db.seed('produtos/CH2/variacaoMercadoLivre', 'v-old', {
      itemId: 'MLB-OLD',
      produtoMercadoLivreOuterRef: 'documents/produtos/OTHER/produtoMercadoLivre/linkX',
    });

    const res = await run(db);
    expect(res).toEqual({
      units: [
        { kind: 'variationItem', itemId: 'MLB-CH2', produtoId: 'PROD', variacaoProdutoId: 'CH2' },
        { kind: 'variationItem', itemId: 'MLB-CH1', produtoId: 'PROD', variacaoProdutoId: 'CH1' },
      ],
      skips: [],
    });
    // The children query rides the (paiId, nome) index → orderBy nome present.
    const childrenQuery = db.queryLog.find((q) =>
      q.clauses.some((c) => c.field === 'paiId' && c.value === 'PROD'),
    );
    expect(childrenQuery?.orderBy).toEqual([['nome', 'asc']]);
  });

  it('UP child without a variação link → per-child sem-link skip, siblings sent', async () => {
    const db = new FakeDb();
    seedAnchor(db);
    seedLink(db, 'PROD', { isUserProductModel: true });
    db.seed('produtos', 'CH1', { nome: 'A', paiId: 'PROD' });
    db.seed('produtos', 'CH2', { nome: 'B', paiId: 'PROD' });
    db.seed('produtos/CH1/variacaoMercadoLivre', 'v1', {
      itemId: 'MLB-CH1',
      produtoMercadoLivreOuterRef: PARENT_LINK_REF,
    });

    const res = await run(db);
    expect(res.units).toEqual([
      { kind: 'variationItem', itemId: 'MLB-CH1', produtoId: 'PROD', variacaoProdutoId: 'CH1' },
    ]);
    expect(res.skips).toEqual([{ produtoId: 'CH2', reason: 'sem-link' }]);
  });

  it('UP child link without itemId → per-child sem-item-id skip', async () => {
    const db = new FakeDb();
    seedAnchor(db);
    seedLink(db, 'PROD', { isUserProductModel: true });
    db.seed('produtos', 'CH1', { nome: 'A', paiId: 'PROD' });
    db.seed('produtos/CH1/variacaoMercadoLivre', 'v1', {
      itemId: null,
      produtoMercadoLivreOuterRef: PARENT_LINK_REF,
    });
    expect((await run(db)).skips).toEqual([{ produtoId: 'CH1', reason: 'sem-item-id' }]);
  });

  it('childless UP family degenerates to a single item unit', async () => {
    const db = new FakeDb();
    seedAnchor(db);
    seedLink(db, 'PROD', { isUserProductModel: true });
    expect(await run(db)).toEqual({
      units: [{ kind: 'item', itemId: 'MLB111', produtoId: 'PROD', variacaoProdutoId: null }],
      skips: [],
    });
  });

  it('a variation-child candidate anchors on its parent via paiId', async () => {
    const db = new FakeDb();
    seedAnchor(db);
    seedLink(db);
    db.seed('produtos', 'CHILD', { nome: 'Child', paiId: 'PROD' });
    expect(await run(db, 'CHILD')).toEqual({
      units: [{ kind: 'item', itemId: 'MLB111', produtoId: 'PROD', variacaoProdutoId: null }],
      skips: [],
    });
  });

  it('paiId pointing at a missing parent → sem-link on the PARENT id', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'CHILD', { nome: 'Child', paiId: 'GONE-PARENT' });
    expect((await run(db, 'CHILD')).skips).toEqual([
      { produtoId: 'GONE-PARENT', reason: 'sem-link' },
    ]);
  });
});

describe('computeQuantidades', () => {
  function seedEstoque(db: FakeDb, produtoId: string, quantidade: number, reservada = 0): void {
    db.seed(`produtos/${produtoId}/estoques`, `est-${produtoId}-${DEPOSITO_ID}`, {
      depositoOuterRef: DEP,
      quantidade,
      quantidadeReservada: reservada,
    });
  }

  function run(db: FakeDb, produtoId: string) {
    return computeQuantidades(asDb(db), { produtoId, depositoId: DEPOSITO_ID });
  }

  it('non-kit: quantidade − reservada, floored', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'P1', { ehKit: false, ehKitVirtual: false });
    seedEstoque(db, 'P1', 10, 3);
    expect(await run(db, 'P1')).toBe(7);

    const db2 = new FakeDb();
    db2.seed('produtos', 'P1', { ehKit: false, ehKitVirtual: false });
    seedEstoque(db2, 'P1', 7.5);
    expect(await run(db2, 'P1')).toBe(7);
  });

  it('missing estoque doc → own disponivel 0', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'P1', { ehKit: false, ehKitVirtual: false });
    expect(await run(db, 'P1')).toBe(0);
  });

  it('missing produto doc → null (do not send)', async () => {
    const db = new FakeDb();
    expect(await run(db, 'GONE')).toBeNull();
  });

  it('ehKitVirtual → null', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'V1', { ehKit: true, ehKitVirtual: true });
    seedEstoque(db, 'V1', 50);
    expect(await run(db, 'V1')).toBeNull();
  });

  it('kit: component-min over deterministic estoque doc reads', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'KIT', {
      ehKit: true,
      ehKitVirtual: false,
      componentesKit: {
        A: { quantidade: 2, limitarEstoque: true, timestamp: null },
        B: { quantidade: 3, limitarEstoque: true, timestamp: null },
      },
    });
    seedEstoque(db, 'KIT', 5, 1);
    seedEstoque(db, 'A', 10);
    seedEstoque(db, 'B', 9);

    expect(await run(db, 'KIT')).toBe(3); // min(10/2, 9/3); own 4 NOT added by default
    // Direct doc gets by the deterministic makeEstoqueUid id — no query.
    const paths = db.opLog.filter((e) => e.op === 'get').map((e) => e.path);
    expect(paths).toContain('produtos/KIT/estoques/est-KIT-DEP');
    expect(paths).toContain('produtos/A/estoques/est-A-DEP');
    expect(paths).toContain('produtos/B/estoques/est-B-DEP');
    expect(db.queryLog).toHaveLength(0);
  });

  it('kit: missing component estoque doc counts as 0 (#238)', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'KIT', {
      ehKit: true,
      ehKitVirtual: false,
      componentesKit: {
        A: { quantidade: 1, limitarEstoque: true, timestamp: null },
        B: { quantidade: 1, limitarEstoque: true, timestamp: null },
      },
    });
    seedEstoque(db, 'A', 10);
    // B has no estoque doc at this depósito.
    expect(await run(db, 'KIT')).toBe(0);
  });

  it('kit: unconstrained components fall back to own stock', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'KIT', {
      ehKit: true,
      ehKitVirtual: false,
      componentesKit: { A: { quantidade: 1, limitarEstoque: false, timestamp: null } },
    });
    seedEstoque(db, 'KIT', 6, 2);
    seedEstoque(db, 'A', 100);
    expect(await run(db, 'KIT')).toBe(4);
  });

  it('kit: the env own-stock hook adds own disponivel to the min', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'KIT', {
      ehKit: true,
      ehKitVirtual: false,
      componentesKit: { A: { quantidade: 2, limitarEstoque: true, timestamp: null } },
    });
    seedEstoque(db, 'KIT', 4);
    seedEstoque(db, 'A', 10);
    expect(await run(db, 'KIT')).toBe(5); // hook OFF → min only
    process.env.MERCADO_LIVRE_STOCK_KIT_INCLUI_PROPRIO = '1';
    expect(await run(db, 'KIT')).toBe(9); // min 5 + own 4
  });
});
