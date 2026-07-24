import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

// Mock the admin Pipelines subpath with tagged-object builders (the
// firestore-pipelines skill pattern): the pipeline is NEVER executed in unit
// tests — assertions target the stages/expressions the code builds, via a fake
// `db.pipeline()` chain below. Chainable methods live on prototypes so
// `toEqual` structural assertions see only the tag data.
const { mockPipelinesExports, FakeChain } = vi.hoisted(() => {
  class Expr {
    constructor(props: Record<string, unknown>) {
      Object.assign(this, props);
    }
    as(name: string): Expr {
      return new Expr({ kind: 'as', name, of: this });
    }
    equal(r: unknown): Expr {
      return new Expr({ kind: 'equal', l: this, r });
    }
    equalAny(values: unknown): Expr {
      return new Expr({ kind: 'equalAny', l: this, values });
    }
    length(): Expr {
      return new Expr({ kind: 'length', of: this });
    }
    greaterThan(r: unknown): Expr {
      return new Expr({ kind: 'gt', l: this, r });
    }
  }

  type Stage = { stage: string; args: unknown[] };

  // One recorder for every pipeline shape: `db.pipeline()` chains carry an
  // executor (canned pages); embedded subqueries (`subcollection(...)` and
  // nested `db.pipeline()` chains) are terminated by the to*Expression()
  // calls, freezing their recorded stages into a tagged expression.
  class FakeChain {
    readonly stages: Stage[] = [];
    constructor(private readonly exec: ((stages: Stage[]) => Promise<unknown>) | null = null) {}
    private push(stage: string, args: unknown[]): this {
      this.stages.push({ stage, args });
      return this;
    }
    collection(path: string): this {
      return this.push('collection', [path]);
    }
    collectionGroup(id: string): this {
      return this.push('collectionGroup', [id]);
    }
    documents(refs: unknown[]): this {
      return this.push('documents', [refs]);
    }
    where(condition: unknown): this {
      return this.push('where', [condition]);
    }
    sort(...orderings: unknown[]): this {
      return this.push('sort', orderings);
    }
    limit(n: number): this {
      return this.push('limit', [n]);
    }
    define(...bindings: unknown[]): this {
      return this.push('define', bindings);
    }
    addFields(...fields: unknown[]): this {
      return this.push('addFields', fields);
    }
    select(...selections: unknown[]): this {
      return this.push('select', selections);
    }
    toScalarExpression(): Expr {
      return new Expr({ kind: 'scalarSubquery', stages: this.stages });
    }
    toArrayExpression(): Expr {
      return new Expr({ kind: 'arraySubquery', stages: this.stages });
    }
    async execute(): Promise<unknown> {
      if (!this.exec) throw new Error('FakeChain: only db.pipeline() chains are executable');
      return this.exec(this.stages);
    }
  }

  const mockPipelinesExports = {
    field: (name: string) => new Expr({ kind: 'field', name }),
    variable: (name: string) => new Expr({ kind: 'variable', name }),
    constant: (v: unknown) => new Expr({ kind: 'constant', v }),
    equal: (l: unknown, r: unknown) => new Expr({ kind: 'equal', l, r }),
    greaterThan: (l: unknown, r: unknown) => new Expr({ kind: 'gt', l, r }),
    greaterThanOrEqual: (l: unknown, r: unknown) => new Expr({ kind: 'gte', l, r }),
    arrayContains: (arr: unknown, v: unknown) => new Expr({ kind: 'arrayContains', arr, v }),
    and: (...xs: unknown[]) => new Expr({ kind: 'and', xs }),
    or: (...xs: unknown[]) => new Expr({ kind: 'or', xs }),
    ascending: (f: unknown) => new Expr({ kind: 'asc', f }),
    documentId: (e: unknown) => new Expr({ kind: 'documentId', of: e }),
    parent: (e: unknown) => new Expr({ kind: 'parent', of: e }),
    subcollection: (path: string) => {
      const chain = new FakeChain();
      chain.stages.push({ stage: 'subcollection', args: [path] });
      return chain;
    },
  } as Record<string, unknown>;

  return { mockPipelinesExports, FakeChain };
});

vi.mock('@google-cloud/firestore/pipelines', () => mockPipelinesExports);

import {
  type BundleChild,
  ESTOQUE_MIN,
  type EstoqueChangeRow,
  MERCADO_LIVRE_STOCK_SEND_QUEUE,
  PAUSE_REENQUEUE_JITTER_MAX_S,
  type ResolutionAnchor,
  type ResolutionBundle,
  type ResolveFromBundleArgs,
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
  fetchChangedEstoquesJoined,
  fetchResolutionBundle,
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
  resolveSendUnitsFromBundle,
  windowOverlapSec,
} from './estoquePlan';

/* ------------------------------ fake Firestore ----------------------------- */
// Extension of orderBackfill.test.ts's FakeDb: chained
// `where().orderBy().limit().get()` with real op support + a plain `.get()` on
// a collection + doc get/set, PLUS a `pipeline()` surface answering from a
// queue of pre-canned pages while recording every execution's stage list.

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

type RecordedStage = { stage: string; args: unknown[] };

function clauseMatches(data: DocData, c: Clause): boolean {
  if (c.op === '==') return data[c.field] === c.value;
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
  readonly pipelineExecutions: RecordedStage[][] = [];
  private readonly pipelinePages: Array<Array<{ path: string; data: DocData }>> = [];
  private autoN = 0;

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }

  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }

  queuePipelinePage(rows: Array<{ path: string; data: DocData }>): void {
    this.pipelinePages.push(rows);
  }

  pipeline(): InstanceType<typeof FakeChain> {
    return new FakeChain(async (stages) => {
      this.pipelineExecutions.push(stages);
      const rows = this.pipelinePages.shift() ?? [];
      return { results: rows.map((r) => ({ ref: { path: r.path }, data: () => r.data })) };
    });
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

function asDb(db: FakeDb | Record<string, unknown>): Firestore {
  return db as unknown as Firestore;
}

/* --------------------------------- helpers --------------------------------- */

const DEP = 'documents/depositos/DEP';
const DEPOSITO_ID = 'DEP';
const CONTA = 'conta-A';
const FROM_MS = Date.parse('2026-07-24T10:00:00.000Z');
const CUTOFF_MS = Date.parse('2026-06-24T10:00:00.000Z');
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

const estoquePath = (produtoId: string) =>
  `produtos/${produtoId}/estoques/est-${produtoId}-${DEPOSITO_ID}`;

/** One canned Q1 execution row (an estoque doc with its joined fields). */
function estoquePage(produtoId: string, ms: number, data: DocData = {}) {
  return { path: estoquePath(produtoId), data: { ultimaModificacao: ms, produto: {}, ...data } };
}

/** One already-mapped Q1 row (the seam's output shape) for discovery tests. */
function changeRow(
  produtoId: string,
  ms: number,
  quantidade = 0,
  quantidadeReservada = 0,
  extra: Partial<EstoqueChangeRow> = {},
): EstoqueChangeRow {
  return {
    produtoId,
    estoqueDocPath: estoquePath(produtoId),
    ultimaModificacaoMs: ms,
    quantidade,
    quantidadeReservada,
    produto: {},
    kitParentIds: [],
    temVenda30d: false,
    ...extra,
  };
}

const PARENT_LINK_REF = 'documents/produtos/PROD/produtoMercadoLivre/link1';

/* Expected-tree builders (plain objects — the mock Exprs compare structurally). */
const f = (name: string) => ({ kind: 'field', name });
const vr = (name: string) => ({ kind: 'variable', name });
const alias = (name: string, of: unknown) => ({ kind: 'as', name, of });
const eq = (l: unknown, r: unknown) => ({ kind: 'equal', l, r });
const gt = (l: unknown, r: unknown) => ({ kind: 'gt', l, r });
const gte = (l: unknown, r: unknown) => ({ kind: 'gte', l, r });
const AND = (...xs: unknown[]) => ({ kind: 'and', xs });
const OR = (...xs: unknown[]) => ({ kind: 'or', xs });
const asc = (name: string) => ({ kind: 'asc', f: f(name) });
const docId = (of: unknown) => ({ kind: 'documentId', of });
const parentOf = (of: unknown) => ({ kind: 'parent', of });

/** The Q1 outer `where`: both depósito *OuterRef forms AND'ed with the range term. */
const q1Where = (range: unknown) =>
  AND(
    OR(eq(f('depositoOuterRef'), DEP), eq(f('depositoOuterRef'), DEP.replace(/^documents\//, ''))),
    range,
  );

/** Keyset tuple predicate carrying the previous page's last row. */
const keyset = (ms: number, path: string) =>
  OR(
    gt(f('ultimaModificacao'), ms),
    AND(eq(f('ultimaModificacao'), ms), gt(f('__name__'), { kind: 'constant', v: { path } })),
  );

/** The full documented Q1 stage tree for one page. */
function q1ExpectedStages(where: unknown, limit: number): RecordedStage[] {
  return [
    { stage: 'collectionGroup', args: ['estoques'] },
    { stage: 'where', args: [where] },
    { stage: 'sort', args: [asc('ultimaModificacao'), asc('__name__')] },
    { stage: 'limit', args: [limit] },
    {
      stage: 'define',
      args: [
        alias('produtoRef', parentOf(f('__name__'))),
        alias('produtoId', docId(parentOf(f('__name__')))),
      ],
    },
    {
      stage: 'addFields',
      args: [
        alias('produto', {
          kind: 'scalarSubquery',
          stages: [
            { stage: 'collection', args: ['produtos'] },
            { stage: 'where', args: [eq(f('__name__'), vr('produtoRef'))] },
            {
              stage: 'select',
              args: [
                'paiId',
                'publicado',
                'ehKit',
                'ehKitVirtual',
                'integracoesComProduto',
                'timestamp',
              ],
            },
          ],
        }),
        alias('kitParents', {
          kind: 'arraySubquery',
          stages: [
            { stage: 'collection', args: ['produtos'] },
            {
              stage: 'where',
              args: [{ kind: 'arrayContains', arr: f('componentesKitKeys'), v: vr('produtoId') }],
            },
            { stage: 'select', args: [alias('kitId', docId(f('__name__')))] },
          ],
        }),
        alias(
          'temVenda30d',
          gt(
            {
              kind: 'length',
              of: {
                kind: 'arraySubquery',
                stages: [
                  { stage: 'subcollection', args: ['historicoEstoque'] },
                  {
                    stage: 'where',
                    args: [
                      AND(
                        { kind: 'equalAny', l: f('tipo'), values: [...TIPOS_VENDA] },
                        gte(f('timestamp'), CUTOFF_MS),
                      ),
                    ],
                  },
                  { stage: 'limit', args: [1] },
                  { stage: 'select', args: ['tipo'] },
                ],
              },
            },
            0,
          ),
        ),
      ],
    },
  ];
}

/** The documented Q2 stage tree after the `documents()` source. */
function q2ExpectedTailStages(): RecordedStage[] {
  return [
    { stage: 'define', args: [alias('anchorId', docId(f('__name__')))] },
    {
      stage: 'addFields',
      args: [
        alias('link', {
          kind: 'scalarSubquery',
          stages: [
            { stage: 'subcollection', args: ['produtoMercadoLivre'] },
            {
              stage: 'where',
              args: [
                OR(
                  eq(f('contaOuterRef'), `documents/integracao/${CONTA}`),
                  eq(f('contaOuterRef'), `integracao/${CONTA}`),
                ),
              ],
            },
            { stage: 'limit', args: [1] },
            {
              stage: 'select',
              args: [
                'id',
                'estado',
                'status',
                'sub_status',
                'isUserProductModel',
                alias('linkDocId', docId(f('__name__'))),
              ],
            },
          ],
        }),
        alias('children', {
          kind: 'arraySubquery',
          stages: [
            { stage: 'collection', args: ['produtos'] },
            { stage: 'where', args: [eq(f('paiId'), vr('anchorId'))] },
            {
              stage: 'select',
              args: [
                alias('childId', docId(f('__name__'))),
                alias('varLinks', {
                  kind: 'arraySubquery',
                  stages: [
                    { stage: 'subcollection', args: ['variacaoMercadoLivre'] },
                    { stage: 'select', args: ['itemId', 'id', 'produtoMercadoLivreOuterRef'] },
                  ],
                }),
              ],
            },
          ],
        }),
      ],
    },
  ];
}

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

describe('fetchChangedEstoquesJoined — stage tree, keyset paging, row mapping', () => {
  const Q1_ARGS = {
    integracaoId: CONTA,
    depositoOuterRef: DEP,
    fromMs: FROM_MS,
    tipoVendaCutoffMs: CUTOFF_MS,
  };

  it('single short page: the full documented stage tree + joined-row mapping', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([
      estoquePage('PROD-1', T1, {
        quantidade: 5,
        quantidadeReservada: 2,
        produto: { publicado: true, ehKit: false },
        kitParents: ['KIT-1', 42], // non-strings filtered out
        temVenda30d: true,
      }),
      // Produto deleted mid-sweep (scalar join → null); legacy doc without
      // quantities → 0; joins absent → [] / false.
      { path: estoquePath('PROD-2'), data: { ultimaModificacao: T2 } },
    ]);

    const rows = await fetchChangedEstoquesJoined(asDb(db), { ...Q1_ARGS, pageLimit: 10 });

    expect(rows).toEqual([
      {
        produtoId: 'PROD-1',
        estoqueDocPath: estoquePath('PROD-1'),
        ultimaModificacaoMs: T1,
        quantidade: 5,
        quantidadeReservada: 2,
        produto: { publicado: true, ehKit: false },
        kitParentIds: ['KIT-1'],
        temVenda30d: true,
      },
      {
        produtoId: 'PROD-2',
        estoqueDocPath: estoquePath('PROD-2'),
        ultimaModificacaoMs: T2,
        quantidade: 0,
        quantidadeReservada: 0,
        produto: null,
        kitParentIds: [],
        temVenda30d: false,
      },
    ]);

    expect(db.pipelineExecutions).toHaveLength(1);
    expect(db.pipelineExecutions[0]).toEqual(
      q1ExpectedStages(q1Where(gt(f('ultimaModificacao'), FROM_MS)), 10),
    );
  });

  it('keyset drain: full pages advance the (ultimaModificacao, ref) tuple, no re-fetch', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([estoquePage('A', T1), estoquePage('B', T2)]); // full
    db.queuePipelinePage([estoquePage('C', T3), estoquePage('D', T3)]); // full — in-page tie is fine
    db.queuePipelinePage([estoquePage('E', T4)]); // short → drained

    const rows = await fetchChangedEstoquesJoined(asDb(db), { ...Q1_ARGS, pageLimit: 2 });

    expect(rows.map((r) => r.produtoId)).toEqual(['A', 'B', 'C', 'D', 'E']); // no dups, no drops
    expect(db.pipelineExecutions).toHaveLength(3);
    // Page 1: strict `>` on the window start; later pages: the keyset tuple.
    expect(db.pipelineExecutions[0]![1]).toEqual({
      stage: 'where',
      args: [q1Where(gt(f('ultimaModificacao'), FROM_MS))],
    });
    expect(db.pipelineExecutions[1]![1]).toEqual({
      stage: 'where',
      args: [q1Where(keyset(T2, estoquePath('B')))],
    });
    expect(db.pipelineExecutions[2]![1]).toEqual({
      stage: 'where',
      args: [q1Where(keyset(T3, estoquePath('D')))],
    });
  });

  it('an all-one-timestamp page boundary drains via the __name__ tiebreaker (no loss)', async () => {
    // The old `>=`-re-cover design could not advance past a page-crossing
    // timestamp tie; the keyset tuple walks straight through it.
    const db = new FakeDb();
    db.queuePipelinePage([estoquePage('A', T1), estoquePage('B', T1)]); // full, single ts
    db.queuePipelinePage([estoquePage('C', T1)]); // short — same ts, past B by ref

    const rows = await fetchChangedEstoquesJoined(asDb(db), { ...Q1_ARGS, pageLimit: 2 });

    expect(rows.map((r) => r.produtoId)).toEqual(['A', 'B', 'C']);
    expect(db.pipelineExecutions).toHaveLength(2);
    expect(db.pipelineExecutions[1]![1]).toEqual({
      stage: 'where',
      args: [q1Where(keyset(T1, estoquePath('B')))],
    });
  });

  it('default page size comes from MERCADO_LIVRE_STOCK_CANDIDATE_PAGE_LIMIT, lazily', async () => {
    process.env.MERCADO_LIVRE_STOCK_CANDIDATE_PAGE_LIMIT = '3';
    const db = new FakeDb();
    db.queuePipelinePage([estoquePage('A', T1)]);

    await fetchChangedEstoquesJoined(asDb(db), Q1_ARGS);

    expect(db.pipelineExecutions[0]![3]).toEqual({ stage: 'limit', args: [3] });
  });
});

describe('discoverStockCandidates — direct + kit expansion from joined rows', () => {
  const dummyDb = asDb({});
  const ARGS = {
    integracaoId: CONTA,
    depositoOuterRef: DEP,
    fromMs: FROM_MS,
    tipoVendaCutoffMs: CUTOFF_MS,
  };

  it('direct candidates carry the joined produto + temVenda30d, ehExpansaoDeKit false', async () => {
    const rows = [
      changeRow('A', T1, 3, 1, { produto: { publicado: true }, temVenda30d: true }),
      changeRow('B', T2, 8, 0),
    ];
    const fetchChanged = vi.fn(async () => rows);

    const map = await discoverStockCandidates(dummyDb, ARGS, { fetchChanged });

    expect(fetchChanged).toHaveBeenCalledWith(dummyDb, ARGS);
    expect([...map.keys()]).toEqual(['A', 'B']);
    expect(map.get('A')).toEqual({
      produtoId: 'A',
      estoqueDocPath: estoquePath('A'),
      ultimaModificacaoMs: T1,
      quantidade: 3,
      quantidadeReservada: 1,
      ehExpansaoDeKit: false,
      produto: { publicado: true },
      temVenda30d: true,
    });
  });

  it('kit parents expand with the TRIGGERING row estoque fields, produto null, flag passthrough', async () => {
    const rows = [
      changeRow('A', T1, 2, 0, { kitParentIds: ['X-KIT', 'KIT'], temVenda30d: true }),
      // A second trigger listing KIT must NOT overwrite the first expansion.
      changeRow('B', T2, 9, 0, { kitParentIds: ['KIT'] }),
    ];
    const fetchChanged = vi.fn(async () => rows);

    const map = await discoverStockCandidates(dummyDb, ARGS, { fetchChanged });

    expect(map.get('KIT')).toEqual({
      produtoId: 'KIT',
      estoqueDocPath: estoquePath('A'), // the component's doc — provenance documented
      ultimaModificacaoMs: T1,
      quantidade: 2,
      quantidadeReservada: 0,
      ehExpansaoDeKit: true,
      produto: null,
      temVenda30d: true,
    });
    expect(map.get('X-KIT')?.ehExpansaoDeKit).toBe(true);
  });

  it('a parent whose OWN estoque also changed stays a direct candidate', async () => {
    const rows = [
      changeRow('A', T1, 2, 0, { kitParentIds: ['KIT'] }),
      changeRow('KIT', T2, 6, 1, { produto: { ehKit: true } }),
    ];
    const fetchChanged = vi.fn(async () => rows);

    const map = await discoverStockCandidates(dummyDb, ARGS, { fetchChanged });

    expect(map.get('KIT')).toEqual({
      produtoId: 'KIT',
      estoqueDocPath: estoquePath('KIT'),
      ultimaModificacaoMs: T2,
      quantidade: 6,
      quantidadeReservada: 1,
      ehExpansaoDeKit: false,
      produto: { ehKit: true },
      temVenda30d: false,
    });
    expect(map.size).toBe(2);
  });

  it('a produto-null row yields NO direct candidate; its kit parents still expand', async () => {
    const rows = [changeRow('A', T1, 2, 0, { produto: null, kitParentIds: ['KIT'] })];
    const fetchChanged = vi.fn(async () => rows);

    const map = await discoverStockCandidates(dummyDb, ARGS, { fetchChanged });

    expect(map.has('A')).toBe(false);
    expect(map.get('KIT')?.ehExpansaoDeKit).toBe(true);
  });

  it('no changed rows → empty map', async () => {
    const fetchChanged = vi.fn(async () => []);
    const map = await discoverStockCandidates(dummyDb, ARGS, { fetchChanged });
    expect(map.size).toBe(0);
  });
});

describe('fetchResolutionBundle — Q2 stage tree + assembly', () => {
  it('builds the documented stage tree (documents → define anchorId → link + children)', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);

    await fetchResolutionBundle(asDb(db), { integracaoId: CONTA, anchorRefsOrIds: ['PROD'] });

    expect(db.pipelineExecutions).toHaveLength(1);
    const stages = db.pipelineExecutions[0]!;
    expect(stages[0]!.stage).toBe('documents');
    const refs = stages[0]!.args[0] as Array<{ id: string }>;
    expect(refs.map((r) => r.id)).toEqual(['PROD']);
    expect(stages.slice(1)).toEqual(q2ExpectedTailStages());
  });

  it('documents() guards: empty anchor set → no pipeline; duplicate ids de-duped', async () => {
    const db = new FakeDb();
    expect(
      await fetchResolutionBundle(asDb(db), { integracaoId: CONTA, anchorRefsOrIds: [] }),
    ).toEqual(new Map());
    expect(db.pipelineExecutions).toHaveLength(0);

    db.queuePipelinePage([]);
    await fetchResolutionBundle(asDb(db), {
      integracaoId: CONTA,
      anchorRefsOrIds: ['PROD', 'PROD'],
    });
    const refs = db.pipelineExecutions[0]![0]!.args[0] as Array<{ id: string }>;
    expect(refs.map((r) => r.id)).toEqual(['PROD']);
  });

  it('assembles anchors: link map/null, children sorted by childId, missing docs omitted', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([
      {
        path: 'produtos/PROD',
        data: {
          publicado: true,
          link: { id: 'MLB111', linkDocId: 'link1' },
          children: [
            {
              childId: 'CH2',
              varLinks: [{ itemId: 'MLB-CH2', produtoMercadoLivreOuterRef: PARENT_LINK_REF }],
            },
            { childId: 'CH1', varLinks: [] },
            { childId: '', varLinks: [] }, // junk rows dropped
            'garbage',
          ],
        },
      },
      { path: 'produtos/OTHER', data: {} },
    ]);

    const bundle = await fetchResolutionBundle(asDb(db), {
      integracaoId: CONTA,
      anchorRefsOrIds: ['PROD', 'OTHER', 'GONE'],
    });

    expect([...bundle.keys()]).toEqual(['PROD', 'OTHER']);
    const prod = bundle.get('PROD')!;
    expect(prod.anchorId).toBe('PROD');
    expect(prod.produto.publicado).toBe(true);
    expect(prod.link).toEqual({ id: 'MLB111', linkDocId: 'link1' });
    expect(prod.children).toEqual([
      { childId: 'CH1', varLinks: [] },
      {
        childId: 'CH2',
        varLinks: [{ itemId: 'MLB-CH2', produtoMercadoLivreOuterRef: PARENT_LINK_REF }],
      },
    ]);
    const other = bundle.get('OTHER')!;
    expect(other.link).toBeNull(); // scalar subquery with 0 rows → null → no conta link
    expect(other.children).toEqual([]);
    expect(bundle.has('GONE')).toBe(false); // documents() silently omits missing docs
  });
});

describe('resolveSendUnitsFromBundle — decision ladder', () => {
  interface AnchorSpec {
    anchorId?: string;
    produto?: DocData;
    link?: DocData | null;
    children?: BundleChild[];
  }

  function makeAnchor(spec: AnchorSpec = {}): ResolutionAnchor {
    const anchorId = spec.anchorId ?? 'PROD';
    return {
      anchorId,
      produto: {
        nome: `Produto ${anchorId}`,
        paiId: null,
        publicado: true,
        ehKit: false,
        ehKitVirtual: false,
        integracoesComProduto: [CONTA],
        ...spec.produto,
      },
      link:
        spec.link === null
          ? null
          : {
              id: 'MLB111',
              estado: 'p',
              status: 'active',
              sub_status: null,
              isUserProductModel: false,
              linkDocId: 'link1',
              ...spec.link,
            },
      children: spec.children ?? [],
    };
  }

  function makeBundle(...anchors: ResolutionAnchor[]): ResolutionBundle {
    return new Map(anchors.map((a) => [a.anchorId, a]));
  }

  function runBundle(bundle: ResolutionBundle, over: Partial<ResolveFromBundleArgs> = {}) {
    return resolveSendUnitsFromBundle(bundle, {
      integracaoId: CONTA,
      produtoId: 'PROD',
      anchorId: 'PROD',
      anchorProduto: null,
      ...over,
    });
  }

  it('old model happy path → ONE family item unit', () => {
    expect(runBundle(makeBundle(makeAnchor()))).toEqual({
      units: [{ kind: 'item', itemId: 'MLB111', produtoId: 'PROD', variacaoProdutoId: null }],
      skips: [],
    });
  });

  it('old model with variation children STILL yields one family unit', () => {
    const bundle = makeBundle(
      makeAnchor({
        children: [
          {
            childId: 'CH1',
            varLinks: [{ itemId: 'MLB-CH1', produtoMercadoLivreOuterRef: PARENT_LINK_REF }],
          },
        ],
      }),
    );
    expect(runBundle(bundle).units).toEqual([
      { kind: 'item', itemId: 'MLB111', produtoId: 'PROD', variacaoProdutoId: null },
    ]);
  });

  it('paused + out_of_stock is enviável (ML auto-reactivates on qty > 0)', () => {
    const res = runBundle(
      makeBundle(makeAnchor({ link: { status: 'paused', sub_status: ['out_of_stock'] } })),
    );
    expect(res.units).toHaveLength(1);
    expect(res.skips).toEqual([]);
  });

  it('missing anchor entry → sem-link (produto deleted mid-sweep)', () => {
    expect(runBundle(makeBundle(), { anchorId: 'GONE', produtoId: 'GONE' })).toEqual({
      units: [],
      skips: [{ produtoId: 'GONE', reason: 'sem-link' }],
    });
  });

  it('no link for this conta → sem-link', () => {
    expect(runBundle(makeBundle(makeAnchor({ link: null }))).skips).toEqual([
      { produtoId: 'PROD', reason: 'sem-link' },
    ]);
  });

  it('link never published (id null) → sem-item-id', () => {
    expect(runBundle(makeBundle(makeAnchor({ link: { id: null } }))).skips).toEqual([
      { produtoId: 'PROD', reason: 'sem-item-id' },
    ]);
  });

  it("estado 'am' (mid-UP-migration, Flutter-driven) → aguardando-migracao", () => {
    expect(runBundle(makeBundle(makeAnchor({ link: { estado: 'am' } }))).skips).toEqual([
      { produtoId: 'PROD', reason: 'aguardando-migracao' },
    ]);
  });

  it('non-enviável documented status → status-nao-enviavel, NO warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockClear();
    const res = runBundle(
      makeBundle(makeAnchor({ link: { status: 'paused', sub_status: ['paused_by_seller'] } })),
    );
    expect(res.skips).toEqual([{ produtoId: 'PROD', reason: 'status-nao-enviavel' }]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('undocumented status → status-nao-enviavel + loud warn (status tracking)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockClear();
    const res = runBundle(
      makeBundle(makeAnchor({ link: { status: 'brand_new_status', sub_status: null } })),
    );
    expect(res.skips).toEqual([{ produtoId: 'PROD', reason: 'status-nao-enviavel' }]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('status'),
      expect.objectContaining({ produtoId: 'PROD', itemId: 'MLB111', status: 'brand_new_status' }),
    );
  });

  it('ehKitVirtual anchor → kit-virtual', () => {
    expect(runBundle(makeBundle(makeAnchor({ produto: { ehKitVirtual: true } }))).skips).toEqual([
      { produtoId: 'PROD', reason: 'kit-virtual' },
    ]);
  });

  it('unpublished anchor → nao-publicado', () => {
    expect(runBundle(makeBundle(makeAnchor({ produto: { publicado: false } }))).skips).toEqual([
      { produtoId: 'PROD', reason: 'nao-publicado' },
    ]);
  });

  it('conta not in integracoesComProduto → conta-fora-do-produto', () => {
    expect(
      runBundle(makeBundle(makeAnchor({ produto: { integracoesComProduto: ['outra-conta'] } })))
        .skips,
    ).toEqual([{ produtoId: 'PROD', reason: 'conta-fora-do-produto' }]);
  });

  it('an explicit anchorProduto (Q1-joined) wins over the bundle row gate fields', () => {
    // The bundle row says published; the Q1-joined produto the caller already
    // holds says unpublished — the caller's copy must drive the gates.
    const res = runBundle(makeBundle(makeAnchor()), {
      anchorProduto: { publicado: false, ehKitVirtual: false, integracoesComProduto: [CONTA] },
    });
    expect(res.skips).toEqual([{ produtoId: 'PROD', reason: 'nao-publicado' }]);
  });

  it('skip reasons follow the documented evaluation order', () => {
    // Link-level reasons before produto-level gates: estado 'am' wins over an
    // unknown status AND over kit-virtual/nao-publicado.
    expect(
      runBundle(
        makeBundle(
          makeAnchor({
            produto: { ehKitVirtual: true, publicado: false },
            link: { estado: 'am', status: 'weird' },
          }),
        ),
      ).skips,
    ).toEqual([{ produtoId: 'PROD', reason: 'aguardando-migracao' }]);

    // status gate before the produto-level gates.
    expect(
      runBundle(
        makeBundle(
          makeAnchor({
            produto: { ehKitVirtual: true },
            link: { status: 'paused', sub_status: [] },
          }),
        ),
      ).skips,
    ).toEqual([{ produtoId: 'PROD', reason: 'status-nao-enviavel' }]);
  });

  it('UP model: one variationItem unit per child, in bundle (childId) order', () => {
    const bundle = makeBundle(
      makeAnchor({
        link: { isUserProductModel: true },
        children: [
          {
            childId: 'CH1',
            varLinks: [{ itemId: 'MLB-CH1', produtoMercadoLivreOuterRef: PARENT_LINK_REF }],
          },
          {
            childId: 'CH2',
            varLinks: [
              // A stale link pointing at ANOTHER parent link must be ignored.
              {
                itemId: 'MLB-OLD',
                produtoMercadoLivreOuterRef: 'documents/produtos/OTHER/produtoMercadoLivre/linkX',
              },
              { itemId: 'MLB-CH2', produtoMercadoLivreOuterRef: PARENT_LINK_REF },
            ],
          },
        ],
      }),
    );
    expect(runBundle(bundle)).toEqual({
      units: [
        { kind: 'variationItem', itemId: 'MLB-CH1', produtoId: 'PROD', variacaoProdutoId: 'CH1' },
        { kind: 'variationItem', itemId: 'MLB-CH2', produtoId: 'PROD', variacaoProdutoId: 'CH2' },
      ],
      skips: [],
    });
  });

  it('UP child without a matching variação link → per-child sem-link, siblings sent', () => {
    const bundle = makeBundle(
      makeAnchor({
        link: { isUserProductModel: true },
        children: [
          {
            childId: 'CH1',
            varLinks: [{ itemId: 'MLB-CH1', produtoMercadoLivreOuterRef: PARENT_LINK_REF }],
          },
          { childId: 'CH2', varLinks: [] },
        ],
      }),
    );
    const res = runBundle(bundle);
    expect(res.units).toEqual([
      { kind: 'variationItem', itemId: 'MLB-CH1', produtoId: 'PROD', variacaoProdutoId: 'CH1' },
    ]);
    expect(res.skips).toEqual([{ produtoId: 'CH2', reason: 'sem-link' }]);
  });

  it('UP child link without itemId → per-child sem-item-id skip', () => {
    const bundle = makeBundle(
      makeAnchor({
        link: { isUserProductModel: true },
        children: [
          {
            childId: 'CH1',
            varLinks: [{ itemId: null, produtoMercadoLivreOuterRef: PARENT_LINK_REF }],
          },
        ],
      }),
    );
    expect(runBundle(bundle).skips).toEqual([{ produtoId: 'CH1', reason: 'sem-item-id' }]);
  });

  it('UP link without a linkDocId cannot match variação links → per-child sem-link', () => {
    const bundle = makeBundle(
      makeAnchor({
        link: { isUserProductModel: true, linkDocId: null },
        children: [
          {
            childId: 'CH1',
            varLinks: [{ itemId: 'MLB-CH1', produtoMercadoLivreOuterRef: PARENT_LINK_REF }],
          },
        ],
      }),
    );
    expect(runBundle(bundle).skips).toEqual([{ produtoId: 'CH1', reason: 'sem-link' }]);
  });

  it('childless UP family degenerates to a single item unit', () => {
    expect(runBundle(makeBundle(makeAnchor({ link: { isUserProductModel: true } })))).toEqual({
      units: [{ kind: 'item', itemId: 'MLB111', produtoId: 'PROD', variacaoProdutoId: null }],
      skips: [],
    });
  });
});

describe('resolveSendUnits — single-family wrapper wiring', () => {
  function seedProduto(db: FakeDb, id: string, extra: DocData = {}): void {
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

  function bundleRow(anchorId: string, extra: DocData = {}) {
    return {
      path: `produtos/${anchorId}`,
      data: {
        link: {
          id: 'MLB111',
          estado: 'p',
          status: 'active',
          sub_status: null,
          isUserProductModel: false,
          linkDocId: 'link1',
        },
        children: [],
        ...extra,
      },
    };
  }

  function run(db: FakeDb, produtoId = 'PROD') {
    return resolveSendUnits(asDb(db), { integracaoId: CONTA, produtoId });
  }

  it('anchor read → Q2 for that single anchor → the bundle ladder', async () => {
    const db = new FakeDb();
    seedProduto(db, 'PROD');
    db.queuePipelinePage([bundleRow('PROD')]);

    expect(await run(db)).toEqual({
      units: [{ kind: 'item', itemId: 'MLB111', produtoId: 'PROD', variacaoProdutoId: null }],
      skips: [],
    });
    expect(db.pipelineExecutions).toHaveLength(1);
    const docsStage = db.pipelineExecutions[0]![0]!;
    expect(docsStage.stage).toBe('documents');
    expect((docsStage.args[0] as Array<{ id: string }>).map((r) => r.id)).toEqual(['PROD']);
  });

  it('a variation-child candidate anchors on its parent via paiId', async () => {
    const db = new FakeDb();
    seedProduto(db, 'PROD');
    db.seed('produtos', 'CHILD', { nome: 'Child', paiId: 'PROD' });
    db.queuePipelinePage([bundleRow('PROD')]);

    expect(await run(db, 'CHILD')).toEqual({
      units: [{ kind: 'item', itemId: 'MLB111', produtoId: 'PROD', variacaoProdutoId: null }],
      skips: [],
    });
    const docsStage = db.pipelineExecutions[0]![0]!;
    expect((docsStage.args[0] as Array<{ id: string }>).map((r) => r.id)).toEqual(['PROD']);
  });

  it('missing produto doc → sem-link, no pipeline executed', async () => {
    const db = new FakeDb();
    expect(await run(db, 'GONE')).toEqual({
      units: [],
      skips: [{ produtoId: 'GONE', reason: 'sem-link' }],
    });
    expect(db.pipelineExecutions).toHaveLength(0);
  });

  it('paiId pointing at a missing parent → sem-link on the PARENT id, no pipeline', async () => {
    const db = new FakeDb();
    db.seed('produtos', 'CHILD', { nome: 'Child', paiId: 'GONE-PARENT' });
    expect((await run(db, 'CHILD')).skips).toEqual([
      { produtoId: 'GONE-PARENT', reason: 'sem-link' },
    ]);
    expect(db.pipelineExecutions).toHaveLength(0);
  });

  it("the wrapper's own anchor read drives the gates (anchorProduto wins)", async () => {
    const db = new FakeDb();
    seedProduto(db, 'PROD', { publicado: false });
    // The bundle row (the raw anchor doc, as Q2 would return it) claims
    // published — the wrapper's classic read must win via anchorProduto.
    db.queuePipelinePage([bundleRow('PROD', { publicado: true })]);
    expect((await run(db)).skips).toEqual([{ produtoId: 'PROD', reason: 'nao-publicado' }]);
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
