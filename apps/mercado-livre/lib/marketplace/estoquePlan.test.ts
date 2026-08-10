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
    equalAny(values: unknown): Expr {
      return new Expr({ kind: 'equalAny', l: this, values });
    }
    arrayContains(v: unknown): Expr {
      return new Expr({ kind: 'arrayContains', l: this, v });
    }
    arrayContainsAny(values: unknown): Expr {
      return new Expr({ kind: 'arrayContainsAny', l: this, values });
    }
    greaterThanOrEqual(r: unknown): Expr {
      return new Expr({ kind: 'gte', l: this, r });
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
    aggregate(...accumulators: unknown[]): this {
      return this.push('aggregate', accumulators);
    }
    unnest(selectable: unknown, indexField?: unknown): this {
      return this.push(
        'unnest',
        indexField === undefined ? [selectable] : [selectable, indexField],
      );
    }
    distinct(...groups: unknown[]): this {
      return this.push('distinct', groups);
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
    and: (...xs: unknown[]) => new Expr({ kind: 'and', xs }),
    or: (...xs: unknown[]) => new Expr({ kind: 'or', xs }),
    ascending: (f: unknown) => new Expr({ kind: 'asc', f }),
    documentId: (e: unknown) => new Expr({ kind: 'documentId', of: e }),
    coalesce: (...xs: unknown[]) => new Expr({ kind: 'coalesce', xs }),
    conditional: (c: unknown, t: unknown, e: unknown) => new Expr({ kind: 'conditional', c, t, e }),
    array: (elements: unknown[]) => new Expr({ kind: 'array', elements }),
    arrayConcat: (...xs: unknown[]) => new Expr({ kind: 'arrayConcat', xs }),
    logicalMaximum: (...xs: unknown[]) => new Expr({ kind: 'logicalMaximum', xs }),
    maximum: (f: unknown) => new Expr({ kind: 'maximum', f }),
    sum: (f: unknown) => new Expr({ kind: 'sum', f }),
    countIf: (b: unknown) => new Expr({ kind: 'countIf', b }),
    not: (b: unknown) => new Expr({ kind: 'not', b }),
    exists: (f: unknown) => new Expr({ kind: 'exists', f }),
    subcollection: (path: string) => {
      const chain = new FakeChain();
      chain.stages.push({ stage: 'subcollection', args: [path] });
      return chain;
    },
  } as Record<string, unknown>;

  return { mockPipelinesExports, FakeChain };
});

vi.mock('@google-cloud/firestore/pipelines', () => mockPipelinesExports);

import { ESTADO_PUBLICACAO_ML } from '@delfrance/schemas';

import {
  ESTOQUE_MIN,
  type FamilyChild,
  type FamilyMember,
  MAX_VARIATIONS_PER_TASK,
  MERCADO_LIVRE_STOCK_SEND_QUEUE,
  PAUSE_REENQUEUE_JITTER_MAX_S,
  type RawVarLinkRow,
  STOCK_SYNC_FLAG_ENV,
  type StockFamilyRow,
  anchorPageLimit,
  buildSendTasks,
  concurrentDispatches,
  cursorMaxLookbackHours,
  dailyWindowHours,
  deveEnviarFamilia,
  dispatchesPerSecond,
  disponivelByProdutoIdFrom,
  envFlag,
  envInt,
  estoqueMax,
  fetchMovimentosDaJanela,
  fetchStockFamilies,
  incrementalWindowMin,
  isStockSyncEnabled,
  kitIncluiEstoqueProprio,
  limiarEstoqueAlto,
  maxPauseReenqueues,
  maxTasksPerSweep,
  podeEnviarEstoque,
  quantidadeDoMembro,
  quantidadeParaEnvio,
  quantidadesDaFamilia,
  ratePauseMin,
  quantidadesAnteriores,
  chaveMovimento,
  windowOverlapSec,
} from './estoquePlan';

/* ------------------------------ fake Firestore ----------------------------- */
// THE query never runs in unit tests: `db.pipeline()` answers from a queue of
// pre-canned pages while recording every execution's stage list; the only
// classic surface needed is `collection().doc()` (the keyset cursor ref built
// through produtoCollection.docRef), which returns a plain tagged object so
// the stage-tree assertions stay structural.

type DocData = Record<string, unknown>;

type RecordedStage = { stage: string; args: unknown[] };

class FakeDb {
  readonly pipelineExecutions: RecordedStage[][] = [];
  private readonly pipelinePages: DocData[][] = [];

  queuePipelinePage(rows: DocData[]): void {
    this.pipelinePages.push(rows);
  }

  pipeline(): InstanceType<typeof FakeChain> {
    return new FakeChain(async (stages) => {
      this.pipelineExecutions.push(stages);
      const rows = this.pipelinePages.shift() ?? [];
      return { results: rows.map((d) => ({ data: () => d })) };
    });
  }

  collection(path: string): { doc: (id: string) => { refPath: string } } {
    return { doc: (id: string) => ({ refPath: `${path}/${id}` }) };
  }
}

function asDb(db: FakeDb | Record<string, unknown>): Firestore {
  return db as unknown as Firestore;
}

/* --------------------------------- helpers --------------------------------- */

const DEPOSITO_ID = 'DEP';
const CONTA = 'conta-A';
const FROM_MS = Date.parse('2026-07-24T10:00:00.000Z');
const T1 = Date.parse('2026-07-24T10:05:00.000Z');
const T2 = Date.parse('2026-07-24T10:10:00.000Z');
const T4 = Date.parse('2026-07-24T10:20:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Every env var the tests mutate — cleared after each test. */
const TOUCHED_ENV = [
  STOCK_SYNC_FLAG_ENV,
  'MERCADO_LIVRE_STOCK_INCREMENTAL_WINDOW_MIN',
  'MERCADO_LIVRE_STOCK_LIMIAR_ALTO',
  'MERCADO_LIVRE_STOCK_MAX',
  'MERCADO_LIVRE_STOCK_KIT_INCLUI_PROPRIO',
  'MERCADO_LIVRE_STOCK_ANCHOR_PAGE_LIMIT',
  'MERCADO_LIVRE_STOCK_RATE_PAUSE_MIN',
  'ESTOQUE_PLAN_TEST_INT',
  'ESTOQUE_PLAN_TEST_FLAG',
];

const PARENT_LINK_REF = 'documents/produtos/PROD/produtoMercadoLivre/link1';
const PARENT_LINK_REF2 = 'documents/produtos/PROD/produtoMercadoLivre/link2';

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
const coal = (...xs: unknown[]) => ({ kind: 'coalesce', xs });
const arr = (elements: unknown[]) => ({ kind: 'array', elements });
const logicalMax = (...xs: unknown[]) => ({ kind: 'logicalMaximum', xs });
const maxOf = (fld: string) => ({ kind: 'maximum', f: fld });
const sumOf = (fld: string) => ({ kind: 'sum', f: fld });
const countIfOf = (b: unknown) => ({ kind: 'countIf', b });
const notOf = (b: unknown) => ({ kind: 'not', b });
const existsOf = (fld: string) => ({ kind: 'exists', f: fld });
const contains = (l: unknown, v: unknown) => ({ kind: 'arrayContains', l, v });
const inAny = (l: unknown, values: unknown) => ({ kind: 'equalAny', l, values });
const cnst = (v: unknown) => ({ kind: 'constant', v });
const cond = (c: unknown, t: unknown, e: unknown) => ({ kind: 'conditional', c, t, e });
const len = (of: unknown) => ({ kind: 'length', of });

/** Both accepted depósito *OuterRef forms — the shared `depMatch` predicate. */
const depOr = OR(
  eq(f('depositoOuterRef'), `documents/depositos/${DEPOSITO_ID}`),
  eq(f('depositoOuterRef'), `depositos/${DEPOSITO_ID}`),
);

const ownEstoqueSub = () => ({
  kind: 'scalarSubquery',
  stages: [
    { stage: 'subcollection', args: ['estoques'] },
    { stage: 'where', args: [depOr] },
    { stage: 'limit', args: [1] },
    { stage: 'select', args: ['quantidade', 'quantidadeReservada', 'ultimaModificacao'] },
  ],
});

const ownEstoqueMaxSub = () => ({
  kind: 'scalarSubquery',
  stages: [
    { stage: 'subcollection', args: ['estoques'] },
    { stage: 'where', args: [depOr] },
    { stage: 'aggregate', args: [alias('max', maxOf('ultimaModificacao'))] },
  ],
});

// Both kit joins are guarded: empty-IN semantics for equalAny are
// undocumented, so a `conditional` short-circuits the empty-key-list
// (non-kit, dominant) path — array fallback `[]`, scalar fallback null.
const compEstoquesSub = (keysVar: string) =>
  cond(
    gt(len(vr(keysVar)), 0),
    {
      kind: 'arraySubquery',
      stages: [
        { stage: 'collectionGroup', args: ['estoques'] },
        { stage: 'where', args: [AND(inAny(f('parentId'), vr(keysVar)), depOr)] },
        {
          stage: 'select',
          args: ['parentId', 'quantidade', 'quantidadeReservada', 'ultimaModificacao'],
        },
      ],
    },
    arr([]),
  );

const kitKeysDef = (name: string) => alias(name, coal(f('componentesKitKeys'), arr([])));

// Children's OWN estoques only — the component arm that used to nest here is
// gone (ADR 0014), which also removes this subquery's `define` and with it the
// repo's only third-level correlated nesting.
const maxChildrenSub = () => ({
  kind: 'scalarSubquery',
  stages: [
    { stage: 'collection', args: ['produtos'] },
    { stage: 'where', args: [eq(f('paiId'), vr('anchorId'))] },
    { stage: 'select', args: [alias('m', ownEstoqueMaxSub())] },
    { stage: 'aggregate', args: [alias('max', maxOf('m'))] },
  ],
});

// ARRAY join, no limit(1): a produto can hold SEVERAL live listings on ONE
// conta and every one receives stock (functions.dart:275-282).
const linkSub = () => ({
  kind: 'arraySubquery',
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
});

const childrenSub = () => ({
  kind: 'arraySubquery',
  stages: [
    { stage: 'collection', args: ['produtos'] },
    { stage: 'where', args: [eq(f('paiId'), vr('anchorId'))] },
    { stage: 'define', args: [kitKeysDef('childKitKeys')] },
    {
      stage: 'select',
      args: [
        alias('childId', docId(f('__name__'))),
        'ehKit',
        'ehKitVirtual',
        'publicado',
        'componentesKit',
        'timestamp',
        alias('estoque', ownEstoqueSub()),
        alias('componentEstoques', compEstoquesSub('childKitKeys')),
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
});

/** THE query's S1 base terms (page 1 of a fresh sweep). */
const s1Terms = () => [
  eq(f('paiId'), null),
  eq(f('publicado'), true),
  contains(f('integracoesComProduto'), CONTA),
];
const s1Page1 = () => AND(...s1Terms());
const s1After = (anchorId: string) =>
  AND(
    ...s1Terms(),
    gt(f('__name__'), { kind: 'constant', v: { refPath: `produtos/${anchorId}` } }),
  );

/**
 * The full documented THE-query stage tree for ONE page (one execution):
 * S1 where → S2 define (plain) → S3 addFields (the subquery-embed site) →
 * S4 where over the added FIELDS → S5 sort+limit → S6 select. Neither the sales
 * signal NOR the component window arm is here: a kit sale stamps the kit's own
 * estoque doc, and "did the number change" is answered by the uncorrelated
 * ledger pre-pass (its own describe below). ADR 0014.
 */
function expectedStages(s1: unknown, limit: number, changedSinceMs = FROM_MS): RecordedStage[] {
  return [
    { stage: 'collection', args: ['produtos'] },
    { stage: 'where', args: [s1] },
    {
      stage: 'define',
      args: [
        alias('anchorId', docId(f('__name__'))),
        alias('anchorKitKeys', coal(f('componentesKitKeys'), arr([]))),
      ],
    },
    {
      stage: 'addFields',
      args: [alias('maxOwn', ownEstoqueMaxSub()), alias('maxChildren', maxChildrenSub())],
    },
    {
      stage: 'where',
      args: [gt(coal(logicalMax(f('maxOwn'), f('maxChildren')), 0), changedSinceMs)],
    },
    { stage: 'sort', args: [asc('__name__')] },
    { stage: 'limit', args: [limit] },
    {
      stage: 'select',
      args: [
        alias('anchorId', vr('anchorId')),
        'ehKit',
        'ehKitVirtual',
        'publicado',
        'componentesKit',
        'integracoesComProduto',
        'timestamp',
        alias('estoque', ownEstoqueSub()),
        alias('componentEstoques', compEstoquesSub('anchorKitKeys')),
        alias('links', linkSub()),
        alias('children', childrenSub()),
      ],
    },
  ];
}

/** A fully-defaulted family member for the pure-reducer fixtures. */
function member(produtoId: string, extra: Partial<FamilyMember> = {}): FamilyMember {
  return {
    produtoId,
    ehKit: false,
    ehKitVirtual: false,
    publicado: true,
    componentesKit: null,
    timestampMs: null,
    estoque: null,
    componentEstoques: [],
    ...extra,
  };
}

function child(
  produtoId: string,
  varLinks: RawVarLinkRow[] = [],
  extra: Partial<FamilyMember> = {},
): FamilyChild {
  return { ...member(produtoId, extra), varLinks };
}

interface FamilyRowSpec {
  anchor?: Partial<FamilyMember>;
  integracoes?: string[];
  /** Each entry merges over the default listing; `[]` = conta has no listings. */
  links?: Array<Record<string, unknown>>;
  children?: FamilyChild[];
}

function familyRow(spec: FamilyRowSpec = {}): StockFamilyRow {
  return {
    anchorId: 'PROD',
    anchor: member('PROD', spec.anchor),
    integracoesComProduto: spec.integracoes ?? [CONTA],
    links: (spec.links ?? [{}]).map((link) => ({
      id: 'MLB111',
      estado: 'p',
      status: 'active',
      sub_status: null,
      isUserProductModel: false,
      linkDocId: 'link1',
      ...link,
    })),
    children: spec.children ?? [],
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of TOUCHED_ENV) delete process.env[k];
  vi.restoreAllMocks();
});

/* ---------------------------------- tests ---------------------------------- */

describe('constants', () => {
  it('pure code constants keep their spec values', () => {
    expect(ESTOQUE_MIN).toBe(0);
    expect(PAUSE_REENQUEUE_JITTER_MAX_S).toBe(30);
    expect(MAX_VARIATIONS_PER_TASK).toBe(2000);
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
    expect(limiarEstoqueAlto()).toBe(100);
    expect(estoqueMax()).toBe(99999);
    expect(kitIncluiEstoqueProprio()).toBe(false);
    expect(anchorPageLimit()).toBe(250);
    expect(maxTasksPerSweep()).toBe(2000);
    expect(ratePauseMin()).toBe(5);
    expect(maxPauseReenqueues()).toBe(10);
    expect(dispatchesPerSecond()).toBe(2);
    expect(concurrentDispatches()).toBe(2);
  });

  it('getters re-read the env on every call (no module-load caching)', () => {
    expect(limiarEstoqueAlto()).toBe(100);
    process.env.MERCADO_LIVRE_STOCK_LIMIAR_ALTO = '9';
    expect(limiarEstoqueAlto()).toBe(9);
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

  // #780 — the contract that keeps the legacy arm confined to `buildSendTasks`.
  // Three of this gate's four callers hand it a LIVE `GET /items` response
  // (#781's send-time verification, the `items` re-arm in `itemsStatusSync`,
  // and the `reverificar-anuncio` route), and `MlItem.status` is
  // `z.string().nullable().optional()` — so a null CAN arrive from ML, meaning
  // "ML reported no status". Answering `enviar: true` there would let
  // `itemsStatusSync`'s `errorsToClear` re-arm a listing #781 had just latched,
  // restarting the very loop it closed. The legacy-doc question is asked in
  // `buildSendTasks` instead, where a null comes from a stored Flutter-written
  // link and means something else entirely.
  it('answers enviar:false for a null status — a live-ML null is NOT a legacy doc', () => {
    for (const status of [null, undefined]) {
      expect(podeEnviarEstoque(status, null), `status=${String(status)}`).toEqual({
        enviar: false,
        desconhecido: true,
      });
      // Not even out_of_stock rescues it: that sub_status is only meaningful
      // alongside `paused`, and here there is no status to scope it to.
      expect(podeEnviarEstoque(status, ['out_of_stock']), `status=${String(status)}`).toEqual({
        enviar: false,
        desconhecido: true,
      });
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

describe('fetchStockFamilies — stage tree, keyset paging, row mapping', () => {
  const FS_ARGS = {
    integracaoId: CONTA,
    depositoId: DEPOSITO_ID,
    changedSinceMs: FROM_MS,
  };

  it('single short page: the full documented stage tree (THE query), ONE execution', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([{ anchorId: 'PROD' }]);

    const page = await fetchStockFamilies(asDb(db), { ...FS_ARGS, pageLimit: 10 });

    expect(db.pipelineExecutions).toHaveLength(1);
    expect(db.pipelineExecutions[0]).toEqual(expectedStages(s1Page1(), 10));
    expect(page.nextAfterAnchorId).toBeNull(); // short page → drained
  });

  it('changedSinceMs -1 (force-all): the S4 where is gt(coalesce(...), -1)', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);

    await fetchStockFamilies(asDb(db), { ...FS_ARGS, changedSinceMs: -1, pageLimit: 10 });

    expect(db.pipelineExecutions[0]![4]).toEqual({
      stage: 'where',
      args: [gt(coal(logicalMax(f('maxOwn'), f('maxChildren')), 0), -1)],
    });
  });

  it('no pedidos subquery anywhere in THE query (the sales signal moved to the pre-pass)', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([{ anchorId: 'PROD' }]);

    await fetchStockFamilies(asDb(db), { ...FS_ARGS, pageLimit: 10 });

    expect(JSON.stringify(db.pipelineExecutions[0])).not.toContain('pedidos');
    expect(JSON.stringify(db.pipelineExecutions[0])).not.toContain('temVenda30d');
    expect(JSON.stringify(db.pipelineExecutions[0])).not.toContain('childIds');
  });

  it('maps projected rows: members coerced, children sorted, junk filtered', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([
      {
        anchorId: 'PROD',
        ehKit: true,
        ehKitVirtual: false,
        publicado: true,
        componentesKit: { A: { quantidade: 2, limitarEstoque: true, timestamp: null } },
        integracoesComProduto: [CONTA, 42], // non-strings filtered out
        timestamp: T1,
        estoque: { quantidade: 5, quantidadeReservada: 2, ultimaModificacao: T1 },
        componentEstoques: [
          { parentId: 'A', quantidade: 10, quantidadeReservada: 0, ultimaModificacao: T2 },
          'junk',
          null,
        ],
        links: [{ id: 'MLB111', linkDocId: 'link1' }, 'junk', null], // non-objects filtered
        children: [
          {
            childId: 'CH2',
            publicado: true,
            timestamp: T2,
            estoque: { quantidade: 3, quantidadeReservada: 1 },
            componentEstoques: [],
            varLinks: [
              { itemId: 'MLB-CH2', produtoMercadoLivreOuterRef: PARENT_LINK_REF },
              ['array-junk'], // arrays are objects — filtered explicitly
            ],
          },
          { childId: 'CH1', varLinks: 'junk' }, // legacy doc — defaults everywhere
          { childId: '', varLinks: [] }, // junk rows dropped
          'garbage',
        ],
      },
      { anchorId: 'PROD2' }, // minimal row → coerced defaults, joins absent
      { publicado: true }, // no anchorId → skipped (defensive)
    ]);

    const { rows } = await fetchStockFamilies(asDb(db), { ...FS_ARGS, pageLimit: 10 });

    expect(rows).toEqual([
      {
        anchorId: 'PROD',
        anchor: {
          produtoId: 'PROD',
          ehKit: true,
          ehKitVirtual: false,
          publicado: true,
          componentesKit: { A: { quantidade: 2, limitarEstoque: true, timestamp: null } },
          timestampMs: T1,
          estoque: { quantidade: 5, quantidadeReservada: 2, ultimaModificacao: T1 },
          componentEstoques: [
            { parentId: 'A', quantidade: 10, quantidadeReservada: 0, ultimaModificacao: T2 },
          ],
        },
        integracoesComProduto: [CONTA],
        links: [{ id: 'MLB111', linkDocId: 'link1' }],
        children: [
          {
            produtoId: 'CH1',
            ehKit: false,
            ehKitVirtual: false,
            publicado: false,
            componentesKit: null,
            timestampMs: null,
            estoque: null,
            componentEstoques: [],
            varLinks: [],
          },
          {
            produtoId: 'CH2',
            ehKit: false,
            ehKitVirtual: false,
            publicado: true,
            componentesKit: null,
            timestampMs: T2,
            estoque: { quantidade: 3, quantidadeReservada: 1 },
            componentEstoques: [],
            varLinks: [{ itemId: 'MLB-CH2', produtoMercadoLivreOuterRef: PARENT_LINK_REF }],
          },
        ],
      },
      {
        anchorId: 'PROD2',
        anchor: {
          produtoId: 'PROD2',
          ehKit: false,
          ehKitVirtual: false,
          publicado: false,
          componentesKit: null,
          timestampMs: null,
          estoque: null,
          componentEstoques: [],
        },
        integracoesComProduto: [],
        links: [],
        children: [],
      },
    ]);
  });

  it('a FULL page returns the last anchorId as nextAfterAnchorId — one execution, no drain', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([{ anchorId: 'A' }, { anchorId: 'B' }]); // full (pageLimit 2)
    db.queuePipelinePage([{ anchorId: 'C' }]); // must NOT be consumed

    const page = await fetchStockFamilies(asDb(db), { ...FS_ARGS, pageLimit: 2 });

    expect(page.rows.map((r) => r.anchorId)).toEqual(['A', 'B']);
    expect(page.nextAfterAnchorId).toBe('B');
    expect(db.pipelineExecutions).toHaveLength(1); // page-aware: never drains internally
  });

  it('a SHORT page returns nextAfterAnchorId null (backlog drained)', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([{ anchorId: 'C' }]);

    const page = await fetchStockFamilies(asDb(db), { ...FS_ARGS, pageLimit: 2 });

    expect(page.rows.map((r) => r.anchorId)).toEqual(['C']);
    expect(page.nextAfterAnchorId).toBeNull();
  });

  it('afterAnchorId (the fed-back cursor) adds the __name__ > docRef term to S1', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([{ anchorId: 'Y' }]);

    await fetchStockFamilies(asDb(db), { ...FS_ARGS, pageLimit: 10, afterAnchorId: 'X' });

    expect(db.pipelineExecutions).toHaveLength(1);
    // The keyset cursor is rebuilt as a produtos docRef (select drops refs).
    expect(db.pipelineExecutions[0]![1]).toEqual({ stage: 'where', args: [s1After('X')] });
  });

  it('default page size comes from MERCADO_LIVRE_STOCK_ANCHOR_PAGE_LIMIT, lazily', async () => {
    process.env.MERCADO_LIVRE_STOCK_ANCHOR_PAGE_LIMIT = '3';
    const db = new FakeDb();
    db.queuePipelinePage([{ anchorId: 'A' }]);

    await fetchStockFamilies(asDb(db), FS_ARGS);

    expect(db.pipelineExecutions[0]![6]).toEqual({ stage: 'limit', args: [3] });
  });
});

describe('fetchMovimentosDaJanela — the uncorrelated ledger pre-pass', () => {
  const MOV_ARGS = { desdeMs: FROM_MS, depositoId: DEPOSITO_ID };
  const DEP_REF = `documents/depositos/${DEPOSITO_ID}`;

  it('single execution: the documented stage tree (where → grouped aggregate)', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([{ parentId: 'A', depositoOuterRef: DEP_REF, dq: -2, dr: 0 }]);

    await fetchMovimentosDaJanela(asDb(db), MOV_ARGS);

    expect(db.pipelineExecutions).toHaveLength(1);
    expect(db.pipelineExecutions[0]).toEqual([
      { stage: 'collectionGroup', args: ['historicoEstoque'] },
      { stage: 'where', args: [AND(gte(f('timestamp'), FROM_MS), depOr)] },
      {
        stage: 'aggregate',
        args: [
          {
            accumulators: [
              alias('dq', sumOf('movimento')),
              alias('dr', sumOf('movimentoReservada')),
              alias('nDesconhecido', countIfOf(notOf(existsOf('movimento')))),
            ],
            groups: ['parentId', 'depositoOuterRef'],
          },
        ],
      },
    ]);
  });

  it('maps rows into a (produto, depósito)-keyed map', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([
      { parentId: 'A', depositoOuterRef: DEP_REF, dq: -2, dr: 1 },
      { parentId: 'B', depositoOuterRef: DEP_REF, dq: 5, dr: 0 },
    ]);

    const movimentos = await fetchMovimentosDaJanela(asDb(db), MOV_ARGS);

    expect(movimentos.get(chaveMovimento('A', DEPOSITO_ID))).toEqual({
      dq: -2,
      dr: 1,
      desconhecido: false,
    });
    expect(movimentos.get(chaveMovimento('B', DEPOSITO_ID))).toEqual({
      dq: 5,
      dr: 0,
      desconhecido: false,
    });
    expect(movimentos.size).toBe(2);
  });

  it('keys on the ARG depósito, so either stored *OuterRef form maps the same', async () => {
    // Readers tolerate the bare form (outerRef.ts invariant); the aggregate is
    // already scoped to one depósito, so the echoed group value is irrelevant.
    const db = new FakeDb();
    db.queuePipelinePage([
      { parentId: 'A', depositoOuterRef: `depositos/${DEPOSITO_ID}`, dq: 3, dr: 0 },
    ]);

    const movimentos = await fetchMovimentosDaJanela(asDb(db), MOV_ARGS);

    expect(movimentos.get(chaveMovimento('A', DEPOSITO_ID))).toEqual({
      dq: 3,
      dr: 0,
      desconhecido: false,
    });
  });

  it('drops rows with no usable parentId, and reads junk sums as 0', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([
      { parentId: null, depositoOuterRef: DEP_REF, dq: 9, dr: 9 },
      { parentId: '', depositoOuterRef: DEP_REF, dq: 9, dr: 9 },
      { parentId: 'A', depositoOuterRef: DEP_REF, dq: 'x', dr: undefined },
    ]);

    const movimentos = await fetchMovimentosDaJanela(asDb(db), MOV_ARGS);

    expect(movimentos.size).toBe(1);
    // A group that cannot be summed contributes nothing rather than a wrong
    // delta — `anterior` then equals `atual` for that pair, and the family is
    // judged on its other members.
    expect(movimentos.get(chaveMovimento('A', DEPOSITO_ID))).toEqual({
      dq: 0,
      dr: 0,
      desconhecido: false,
    });
  });

  it('ACCUMULATES the two *OuterRef encodings of one pair instead of overwriting', async () => {
    // The filter accepts both forms, but the aggregate groups by the RAW value,
    // so a produto whose rows carry a mix comes back as TWO groups. Overwriting
    // would drop one arm and reconstruct a confidently wrong `anterior`.
    const db = new FakeDb();
    db.queuePipelinePage([
      { parentId: 'A', depositoOuterRef: DEP_REF, dq: -2, dr: 1, nDesconhecido: 0 },
      {
        parentId: 'A',
        depositoOuterRef: `depositos/${DEPOSITO_ID}`,
        dq: -5,
        dr: 2,
        nDesconhecido: 0,
      },
    ]);

    const movimentos = await fetchMovimentosDaJanela(asDb(db), MOV_ARGS);

    expect(movimentos.size).toBe(1);
    expect(movimentos.get(chaveMovimento('A', DEPOSITO_ID))).toEqual({
      dq: -7,
      dr: 3,
      desconhecido: false,
    });
  });

  it('an unknown-movement group survives accumulation with the readable one', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([
      { parentId: 'A', depositoOuterRef: DEP_REF, dq: -2, dr: 0, nDesconhecido: 0 },
      {
        parentId: 'A',
        depositoOuterRef: `depositos/${DEPOSITO_ID}`,
        dq: 0,
        dr: 0,
        nDesconhecido: 4,
      },
    ]);

    const movimentos = await fetchMovimentosDaJanela(asDb(db), MOV_ARGS);

    expect(movimentos.get(chaveMovimento('A', DEPOSITO_ID))?.desconhecido).toBe(true);
  });

  it('flags a group whose window holds a row with NO `movimento` key', async () => {
    // A legacy Flutter v1 row: `sum` skips it, so without this counter the
    // window would look like it moved nothing and the sweep would SKIP a real
    // movement. Flutter is a live writer during the dual run.
    const db = new FakeDb();
    db.queuePipelinePage([
      { parentId: 'A', depositoOuterRef: DEP_REF, dq: 0, dr: 0, nDesconhecido: 1 },
      { parentId: 'B', depositoOuterRef: DEP_REF, dq: -4, dr: 0, nDesconhecido: 0 },
    ]);

    const movimentos = await fetchMovimentosDaJanela(asDb(db), MOV_ARGS);

    expect(movimentos.get(chaveMovimento('A', DEPOSITO_ID))?.desconhecido).toBe(true);
    expect(movimentos.get(chaveMovimento('B', DEPOSITO_ID))?.desconhecido).toBe(false);
  });

  it('an empty window yields an empty map (no rows moved)', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);
    expect((await fetchMovimentosDaJanela(asDb(db), MOV_ARGS)).size).toBe(0);
  });
});

describe('sweep-time quantities — pure reducers', () => {
  it('disponivelByProdutoIdFrom: keyed by parentId, disponivel math, junk skipped', () => {
    expect(
      disponivelByProdutoIdFrom([
        { parentId: 'A', quantidade: 10, quantidadeReservada: 3 },
        { parentId: 'B', quantidade: 5 }, // missing reservada → 0
        { parentId: '', quantidade: 1 }, // junk key skipped
        { quantidade: 2 }, // no parentId skipped
        { parentId: 'C', quantidade: 'x' }, // non-finite → 0
      ]),
    ).toEqual({ A: 7, B: 5, C: 0 });
  });

  it('quantidadeDoMembro: non-kit own disponivel (quantidade − reservada), floored', () => {
    expect(
      quantidadeDoMembro(member('P1', { estoque: { quantidade: 10, quantidadeReservada: 3 } })),
    ).toBe(7);
    expect(quantidadeDoMembro(member('P1', { estoque: { quantidade: 7.5 } }))).toBe(7);
  });

  it('quantidadeDoMembro: missing own estoque reads as 0', () => {
    expect(quantidadeDoMembro(member('P1'))).toBe(0);
  });

  it('quantidadeDoMembro: ehKitVirtual → null (never send)', () => {
    expect(
      quantidadeDoMembro(
        member('V1', { ehKit: true, ehKitVirtual: true, estoque: { quantidade: 50 } }),
      ),
    ).toBeNull();
  });

  it('quantidadeDoMembro: kit min over the joined component rows; missing component = 0', () => {
    const kit = member('KIT', {
      ehKit: true,
      componentesKit: {
        A: { quantidade: 2, limitarEstoque: true, timestamp: null },
        B: { quantidade: 3, limitarEstoque: true, timestamp: null },
      },
      estoque: { quantidade: 5, quantidadeReservada: 1 },
      componentEstoques: [
        { parentId: 'A', quantidade: 10, quantidadeReservada: 0 },
        { parentId: 'B', quantidade: 9, quantidadeReservada: 0 },
      ],
    });
    expect(quantidadeDoMembro(kit)).toBe(3); // min(10/2, 9/3); own 4 NOT added by default

    // B's estoque row missing at this depósito → counts as 0 (#238).
    expect(
      quantidadeDoMembro({
        ...kit,
        componentEstoques: [{ parentId: 'A', quantidade: 10, quantidadeReservada: 0 }],
      }),
    ).toBe(0);
  });

  it('quantidadesDaFamilia: anchor + children keyed by produto id, virtuals omitted', () => {
    const row = familyRow({
      anchor: { estoque: { quantidade: 7, quantidadeReservada: 0 } },
      children: [
        child('CH1', [], { estoque: { quantidade: 4, quantidadeReservada: 1 } }),
        child('CHV', [], { ehKit: true, ehKitVirtual: true, estoque: { quantidade: 9 } }),
      ],
    });
    expect(quantidadesDaFamilia(row)).toEqual(
      new Map([
        ['PROD', 7],
        ['CH1', 3],
      ]),
    );
  });
});

describe('quantidadesAnteriores + deveEnviarFamilia — the send policy (ADR 0014)', () => {
  const DEP = DEPOSITO_ID;
  const mov = (entries: Array<[string, number]>) =>
    new Map(
      entries.map(([id, dq]) => [chaveMovimento(id, DEP), { dq, dr: 0, desconhecido: false }]),
    );

  /**
   * A plain produto holding 10 − 2 = 8 available.
   *
   * ⚠️ The own estoque row carries **no `parentId`**, because `ownEstoque()`'s
   * `select` does not project one — this fixture mirrors the real projection.
   * It used to hand-write the field, which is precisely what hid #932: the
   * reconstruction was keying off a value production never returns.
   */
  const simples = () =>
    familyRow({
      anchor: { estoque: { quantidade: 10, quantidadeReservada: 2 } },
    });

  it('reconstructs a simple produto: anterior = atual − Σmovimento', () => {
    // atual disponivel = 8; the window took 3 out ⇒ it was 11.
    const anteriores = quantidadesAnteriores(simples(), DEP, mov([['PROD', -3]]));
    expect(anteriores.get('PROD')).toBe(11);
  });

  it('a pair that never moved reconstructs to its current value', () => {
    const anteriores = quantidadesAnteriores(simples(), DEP, new Map());
    expect(anteriores.get('PROD')).toBe(8);
    expect(deveEnviarFamilia(quantidadesDaFamilia(simples()), anteriores, true)).toBe(false);
  });

  it('undoes the RESERVA arm too (disponivel = quantidade − reservada)', () => {
    const anteriores = quantidadesAnteriores(
      simples(),
      DEP,
      new Map([[chaveMovimento('PROD', DEP), { dq: 0, dr: 2, desconhecido: false }]]),
    );
    // The window added 2 to the reservation, so disponivel used to be 8 + 2.
    expect(anteriores.get('PROD')).toBe(10);
  });

  it('OMITS a member whose own movement is unknown, so the policy fails OPEN', () => {
    // A Flutter v1 row landed in this window: the sums cannot account for it,
    // so there is no honest `anterior`. Leaving the member out is what makes
    // `deveEnviarFamilia` send; a fallback to the current value would read as
    // "unchanged" and silently skip a real movement.
    const desconhecido = new Map([
      [chaveMovimento('PROD', DEP), { dq: 0, dr: 0, desconhecido: true }],
    ]);
    const anteriores = quantidadesAnteriores(simples(), DEP, desconhecido);
    expect(anteriores.has('PROD')).toBe(false);
    expect(deveEnviarFamilia(quantidadesDaFamilia(simples()), anteriores, true)).toBe(true);
  });

  it('OMITS a kit whose COMPONENT moved by an unknown amount', () => {
    // The kit's floor is computed from its components, so an unreadable
    // component movement makes the kit's own `anterior` unknowable too.
    const kitRow = familyRow({
      anchor: {
        ehKit: true,
        componentesKit: { COMP: { quantidade: 1, limitarEstoque: true, timestamp: null } },
        // No `parentId` on the own row — the real projection has none (#932).
        estoque: { quantidade: 0, quantidadeReservada: 0 },
        componentEstoques: [{ parentId: 'COMP', quantidade: 10, quantidadeReservada: 0 }],
      },
    });
    const desconhecido = new Map([
      [chaveMovimento('COMP', DEP), { dq: 0, dr: 0, desconhecido: true }],
    ]);
    expect(quantidadesAnteriores(kitRow, DEP, desconhecido).has('PROD')).toBe(false);
    expect(quantidadesAnteriores(kitRow, DEP, mov([['COMP', -1]])).has('PROD')).toBe(true);
  });

  it('⚠️ #932: an own-stock movement is reconstructed and SENT', () => {
    // The regression test for the silent skip. The fixture carries no
    // `parentId` on the own row (production projects none), so this passes ONLY
    // because the reconstruction keys by `member.produtoId`. Reading the row's
    // denorm instead makes `anterior === atual`, and every ordinary produto's
    // stock change is dropped on every tier.
    const atuais = quantidadesDaFamilia(simples());
    const anteriores = quantidadesAnteriores(simples(), DEP, mov([['PROD', -3]]));
    expect(atuais.get('PROD')).toBe(8);
    expect(anteriores.get('PROD')).toBe(11);
    expect(deveEnviarFamilia(atuais, anteriores, true)).toBe(true);
  });

  it('a COMPONENT row with no parentId is unresolvable → the kit SENDS its 0', () => {
    // The denorm is legal-null at rest (#238) and the component join is the one
    // consumer that keys on it. Such a row is invisible twice over: it resolves
    // to no `disponivel` (so the kit floors to 0) AND it cannot be attributed a
    // movement. Reconstructing would rebuild `anterior` from the same broken set
    // and read "unchanged" — so the member is OMITTED and the 0 goes out.
    const kitSemDenorm = familyRow({
      anchor: {
        ehKit: true,
        componentesKit: { COMP: { quantidade: 1, limitarEstoque: true, timestamp: null } },
        estoque: null,
        componentEstoques: [{ quantidade: 10, quantidadeReservada: 0 }],
      },
    });
    const atuais = quantidadesDaFamilia(kitSemDenorm);
    const anteriores = quantidadesAnteriores(kitSemDenorm, DEP, mov([['COMP', -3]]));
    expect(atuais.get('PROD')).toBe(0);
    expect(anteriores.has('PROD')).toBe(false);
    expect(deveEnviarFamilia(atuais, anteriores, true)).toBe(true);
  });

  it('THE #695 case: a component movement that does not change the kit floor', () => {
    // Kit of 1× C1 + 1× C2. C2 is abundant (10 000); C1 is the binding one.
    // A SIBLING kit sold, moving C2 by −1 — this kit's floor is unchanged.
    const kit = familyRow({
      anchor: {
        ehKit: true,
        componentesKit: {
          C1: { quantidade: 1, limitarEstoque: true, timestamp: null },
          C2: { quantidade: 1, limitarEstoque: true, timestamp: null },
        },
        estoque: null,
        componentEstoques: [
          { parentId: 'C1', quantidade: 15, quantidadeReservada: 0 },
          { parentId: 'C2', quantidade: 9_999, quantidadeReservada: 0 },
        ],
      },
    });
    const atuais = quantidadesDaFamilia(kit);
    const anteriores = quantidadesAnteriores(kit, DEP, mov([['C2', -1]]));

    expect(atuais.get('PROD')).toBe(15);
    expect(anteriores.get('PROD')).toBe(15); // min(15, 10 000) either way
    expect(deveEnviarFamilia(atuais, anteriores, true)).toBe(false);
    expect(deveEnviarFamilia(atuais, anteriores, false)).toBe(false); // daily too
  });

  /* ------------- #806 S12: an unverifiable kit publishes 0 ------------------ */

  it('⚠️ an UNVERIFIABLE kit sends 0 even though the ledger says nothing moved', () => {
    // The regression test for the masking, and the one most likely to be
    // "optimized" back into a skip. The kit declares a constraining component
    // that the join never returned (stale `componentesKitKeys`), so it floors to
    // 0 — and the reconstruction, run over the SAME broken component set, would
    // land on 0 too and call it unchanged. Skipping would leave whatever
    // quantity ML already holds; if that is positive, it oversells.
    const kit = familyRow({
      anchor: {
        ehKit: true,
        componentesKit: { COMP: { quantidade: 1, limitarEstoque: true, timestamp: null } },
        estoque: null,
        componentEstoques: [], // the denorm never named COMP, so nothing was fetched
      },
    });
    const atuais = quantidadesDaFamilia(kit);
    const anteriores = quantidadesAnteriores(kit, DEP, new Map()); // ledger: nothing moved

    expect(atuais.get('PROD')).toBe(0);
    expect(anteriores.has('PROD')).toBe(false); // omitted ⇒ unknown ⇒ sends
    expect(deveEnviarFamilia(atuais, anteriores, true)).toBe(true);
    expect(deveEnviarFamilia(atuais, anteriores, false)).toBe(true);
  });

  it('a kit whose component resolved to a real 0 still sends through the normal path', () => {
    // The legitimate out-of-stock case must survive the guard: the component IS
    // resolvable, it just holds nothing. Here the ledger explains the movement,
    // so `anterior` is real (1 before the −1) and the change is what triggers
    // the send — not the unverifiable arm.
    const kit = familyRow({
      anchor: {
        ehKit: true,
        componentesKit: { COMP: { quantidade: 1, limitarEstoque: true, timestamp: null } },
        estoque: null,
        componentEstoques: [{ parentId: 'COMP', quantidade: 0, quantidadeReservada: 0 }],
      },
    });
    const atuais = quantidadesDaFamilia(kit);
    const anteriores = quantidadesAnteriores(kit, DEP, mov([['COMP', -1]]));

    expect(atuais.get('PROD')).toBe(0);
    expect(anteriores.get('PROD')).toBe(1);
    expect(deveEnviarFamilia(atuais, anteriores, true)).toBe(true);
  });

  it('a kit constrained by NOTHING is not "unverifiable" — it falls back to own stock', () => {
    // Every entry is `limitarEstoque: false`, so `kitEstoqueDisponivel` returns
    // null and the kit publishes its OWN stock. There is no floor to verify, so
    // the guard must not fire and steal the family's normal change detection.
    const kit = familyRow({
      anchor: {
        ehKit: true,
        componentesKit: { COMP: { quantidade: 1, limitarEstoque: false, timestamp: null } },
        estoque: { quantidade: 4, quantidadeReservada: 0 },
        componentEstoques: [],
      },
    });
    const atuais = quantidadesDaFamilia(kit);
    const anteriores = quantidadesAnteriores(kit, DEP, new Map());

    expect(atuais.get('PROD')).toBe(4);
    expect(anteriores.get('PROD')).toBe(4); // reconstructed, not omitted
    expect(deveEnviarFamilia(atuais, anteriores, true)).toBe(false);
  });

  it('a PARTIALLY resolved kit is still verifiable — the min is knowable', () => {
    // One of two constraining components came back. The floor is min(0, 5) = 0
    // either way, so the quantity is derivable and the guard must not fire:
    // "unverifiable" means NOT ONE component resolved.
    const kit = familyRow({
      anchor: {
        ehKit: true,
        componentesKit: {
          C1: { quantidade: 1, limitarEstoque: true, timestamp: null },
          C2: { quantidade: 1, limitarEstoque: true, timestamp: null },
        },
        estoque: null,
        componentEstoques: [{ parentId: 'C1', quantidade: 5, quantidadeReservada: 0 }],
      },
    });
    const anteriores = quantidadesAnteriores(kit, DEP, new Map());
    expect(anteriores.get('PROD')).toBe(0); // present ⇒ reconstructed, not omitted
  });

  it('a component movement that DOES change the floor still sends', () => {
    const kit = familyRow({
      anchor: {
        ehKit: true,
        componentesKit: { C1: { quantidade: 1, limitarEstoque: true, timestamp: null } },
        estoque: null,
        componentEstoques: [{ parentId: 'C1', quantidade: 9, quantidadeReservada: 0 }],
      },
    });
    const atuais = quantidadesDaFamilia(kit);
    const anteriores = quantidadesAnteriores(kit, DEP, mov([['C1', -1]]));
    expect(atuais.get('PROD')).toBe(9);
    expect(anteriores.get('PROD')).toBe(10);
    expect(deveEnviarFamilia(atuais, anteriores, true)).toBe(true);
  });

  /* -------------------- the high-stock rule and its guard ------------------- */

  it('incremental: 200 → 199 waits for the daily pass; daily sends it', () => {
    const atuais = new Map([['PROD', 199]]);
    const anteriores = new Map([['PROD', 200]]);
    expect(deveEnviarFamilia(atuais, anteriores, true)).toBe(false);
    expect(deveEnviarFamilia(atuais, anteriores, false)).toBe(true);
  });

  it('the threshold is STRICT: landing exactly on it still sends', () => {
    // The rule is "skip while min(...) > LIMIAR", so a value equal to the
    // threshold is treated as inside the danger zone, not outside it.
    expect(deveEnviarFamilia(new Map([['PROD', 100]]), new Map([['PROD', 101]]), true)).toBe(true);
  });

  it('⚠️ 110 → 95 SENDS on the incremental tier — the crossing guard', () => {
    // This is why the rule is min(anterior, atual) and not `atual` alone:
    // gating on the current value would skip the movement that walks a listing
    // INTO the danger zone, and the next sale oversells.
    expect(deveEnviarFamilia(new Map([['PROD', 95]]), new Map([['PROD', 110]]), true)).toBe(true);
  });

  it('95 → 110 sends too — the guard is symmetric', () => {
    expect(deveEnviarFamilia(new Map([['PROD', 110]]), new Map([['PROD', 95]]), true)).toBe(true);
  });

  it('the threshold is env-tunable and read lazily', () => {
    const atuais = new Map([['PROD', 40]]);
    const anteriores = new Map([['PROD', 41]]);
    expect(deveEnviarFamilia(atuais, anteriores, true)).toBe(true); // 40 <= 100 ⇒ sends
    process.env.MERCADO_LIVRE_STOCK_LIMIAR_ALTO = '10';
    expect(deveEnviarFamilia(atuais, anteriores, true)).toBe(false); // now comfortably high
  });

  it('one LOW sibling justifies the whole send even when another is high', () => {
    const atuais = new Map([
      ['PROD', 999],
      ['CH1', 3],
    ]);
    const anteriores = new Map([
      ['PROD', 1000],
      ['CH1', 4],
    ]);
    expect(deveEnviarFamilia(atuais, anteriores, true)).toBe(true);
  });

  /* ------------------------------- fail open ------------------------------- */

  it('no reconstruction at all → send (first sweep after deploy)', () => {
    expect(deveEnviarFamilia(new Map([['PROD', 8]]), null, true)).toBe(true);
  });

  it('a member missing from the reconstruction → send (unknown, never skip)', () => {
    expect(deveEnviarFamilia(new Map([['PROD', 8]]), new Map(), true)).toBe(true);
  });

  it('nothing to send at all → skip', () => {
    expect(deveEnviarFamilia(new Map(), new Map(), true)).toBe(false);
  });
});

describe('buildSendTasks — decision ladder + task shapes', () => {
  const OPTS = { integracaoId: CONTA, sweepId: 'sweep-1', sweepComputedAtMs: T4 };
  const BASE_TASK = {
    integracaoId: CONTA,
    produtoId: 'PROD',
    linkDocId: 'link1',
    sweepId: 'sweep-1',
    sweepComputedAtMs: T4,
    reenqueues: 0,
  };

  function run(row: StockFamilyRow, qty: ReadonlyMap<string, number> = new Map([['PROD', 7]])) {
    return buildSendTasks(row, qty, OPTS);
  }

  it('childless old model happy path → ONE item task carrying the anchor quantity', () => {
    expect(run(familyRow())).toEqual({
      tasks: [
        {
          ...BASE_TASK,
          kind: 'item',
          itemId: 'MLB111',
          variacaoProdutoId: null,
          quantidade: 7,
          variations: null,
        },
      ],
      skips: [],
    });
  });

  it('paused + out_of_stock is enviável (ML auto-reactivates on qty > 0)', () => {
    const res = run(familyRow({ links: [{ status: 'paused', sub_status: ['out_of_stock'] }] }));
    expect(res.tasks).toHaveLength(1);
    expect(res.skips).toEqual([]);
  });

  it('⚠️ an unverifiable kit EMITS its 0 and is logged — it is never skipped', () => {
    // #806 S12 asked for a skip here; that is inverted on purpose (ADR 0014).
    // Publishing 0 pauses the listing, which ML undoes by itself on the next
    // positive quantity; skipping leaves a stale positive number selling stock
    // the ERP cannot account for, which nothing undoes.
    const errorSpy = vi.spyOn(console, 'error').mockClear();
    const kit = familyRow({
      anchor: {
        ehKit: true,
        componentesKit: { COMP: { quantidade: 1, limitarEstoque: true, timestamp: null } },
        estoque: null,
        componentEstoques: [],
      },
    });

    const res = run(kit, new Map([['PROD', 0]]));

    expect(res.skips).toEqual([]);
    expect(res.tasks).toEqual([
      {
        ...BASE_TASK,
        kind: 'item',
        itemId: 'MLB111',
        variacaoProdutoId: null,
        quantidade: 0,
        variations: null,
      },
    ]);
    // …and the stale denorm is named, since the 0 is legitimate but its cause
    // is a data defect nothing else surfaces.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[1]).toMatchObject({
      produtoId: 'PROD',
      componentes: ['COMP'],
    });
  });

  it('conta with no listings (links: []) → single sem-link skip', () => {
    expect(run(familyRow({ links: [] }))).toEqual({
      tasks: [],
      skips: [{ produtoId: 'PROD', reason: 'sem-link' }],
    });
  });

  it('link without a doc id (defensive — server-projected) → sem-link', () => {
    expect(run(familyRow({ links: [{ linkDocId: null }] })).skips).toEqual([
      { produtoId: 'PROD', reason: 'sem-link' },
    ]);
  });

  it('link never published (id null) → sem-item-id', () => {
    expect(run(familyRow({ links: [{ id: null }] })).skips).toEqual([
      { produtoId: 'PROD', reason: 'sem-item-id' },
    ]);
  });

  it("estado 'am' (mid-UP-migration, Flutter-driven) → aguardando-migracao", () => {
    expect(run(familyRow({ links: [{ estado: 'am' }] })).skips).toEqual([
      { produtoId: 'PROD', reason: 'aguardando-migracao' },
    ]);
  });

  // #781: the send handler stamps 'E' only after ML has CONFIRMED the anúncio is
  // healthy — i.e. it was our payload that was refused. Rebuilding that same
  // payload every tick just re-earns the rejection, 96×/day.
  it("estado 'E' (payload refused by a healthy anúncio) → anuncio-em-erro", () => {
    expect(run(familyRow({ links: [{ estado: 'E' }] })).skips).toEqual([
      { produtoId: 'PROD', reason: 'anuncio-em-erro' },
    ]);
  });

  it("estado 'E' is skipped even while ML still reports the listing active", () => {
    // The exact shape the bug produced: a latched estado next to a status the
    // whitelist happily sends to. Before the rung, this row rebuilt a task.
    const res = run(familyRow({ links: [{ estado: 'E', status: 'active', sub_status: [] }] }));
    expect(res.tasks).toEqual([]);
    expect(res.skips).toEqual([{ produtoId: 'PROD', reason: 'anuncio-em-erro' }]);
  });

  it("a healthy estado 'p' on an active listing still sends (the rung is narrow)", () => {
    const res = run(familyRow({ links: [{ estado: 'p', status: 'active' }] }));
    expect(res.tasks).toHaveLength(1);
    expect(res.skips).toEqual([]);
  });

  it('non-enviável documented status → status-nao-enviavel, NO warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockClear();
    const res = run(familyRow({ links: [{ status: 'paused', sub_status: ['paused_by_seller'] }] }));
    expect(res.skips).toEqual([{ produtoId: 'PROD', reason: 'status-nao-enviavel' }]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('undocumented status → status-nao-enviavel + loud warn (status tracking)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockClear();
    const res = run(familyRow({ links: [{ status: 'brand_new_status', sub_status: null }] }));
    expect(res.skips).toEqual([{ produtoId: 'PROD', reason: 'status-nao-enviavel' }]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('status'),
      expect.objectContaining({ produtoId: 'PROD', itemId: 'MLB111', status: 'brand_new_status' }),
    );
  });

  // #780 — THE regression this issue is about: before the fix a legacy link
  // (`status == null`, every doc the Flutter app authored) was skipped, so
  // flipping MERCADO_LIVRE_STOCK_SYNC_ENABLED enqueued nothing at all.
  it('legacy link (status == null) IS enqueued — the send backfills the status', () => {
    const res = run(
      familyRow({
        links: [{ status: null, sub_status: null, estado: ESTADO_PUBLICACAO_ML.publicado }],
      }),
    );
    expect(res.skips).toEqual([]);
    expect(res.tasks).toHaveLength(1);
    expect(res.tasks[0]).toMatchObject({ itemId: 'MLB111', linkDocId: 'link1' });
  });

  // Loop termination for a legacy link is #781's, not the legacy arm's: a
  // rejected send is verified against ML on the last attempt and stamps either
  // the listing's real status or `estado: 'E'`, and BOTH are already skipped
  // before the legacy arm is reached. Pinned here because it is the reason the
  // arm needs no `'E'` trim of its own.
  it('legacy link stamped `estado: E` by #781 → anuncio-em-erro, before the legacy arm', () => {
    const res = run(
      familyRow({ links: [{ status: null, sub_status: null, estado: ESTADO_PUBLICACAO_ML.erro }] }),
    );
    expect(res.tasks).toEqual([]);
    expect(res.skips).toEqual([{ produtoId: 'PROD', reason: 'anuncio-em-erro' }]);
  });

  // The other #781 outcome: the verification recorded the listing's real status,
  // so the link is no longer legacy at all and the whitelist handles it.
  it('legacy link whose real status #781 recorded → whitelist, not the legacy arm', () => {
    const res = run(
      familyRow({ links: [{ status: 'closed', sub_status: ['deleted'], estado: 'c' }] }),
    );
    expect(res.tasks).toEqual([]);
    expect(res.skips).toEqual([{ produtoId: 'PROD', reason: 'status-nao-enviavel' }]);
  });

  it('legacy link on a closed listing (`estado: c`) → skipped, no doomed PUT', () => {
    const res = run(
      familyRow({
        links: [{ status: null, sub_status: null, estado: ESTADO_PUBLICACAO_ML.cancelado }],
      }),
    );
    expect(res.tasks).toEqual([]);
    expect(res.skips).toEqual([{ produtoId: 'PROD', reason: 'status-nao-enviavel' }]);
  });

  // Log-noise guard: a missing status is the EXPECTED legacy shape, so it must
  // NOT take the loud `warn` path — at one line per listing per tick it would
  // bury the tick summary on the first sweeps after the cutover. The warn is
  // reserved for a status that is PRESENT and undocumented (the test above).
  it('legacy link does not emit the undocumented-status warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockClear();
    run(familyRow({ links: [{ status: null, sub_status: null }] }));
    expect(warnSpy).not.toHaveBeenCalled();
    // …including on the trimmed path, where the listing is skipped.
    run(familyRow({ links: [{ status: null, estado: ESTADO_PUBLICACAO_ML.cancelado }] }));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // `estado: 'am'` keeps winning over the legacy arm — a listing awaiting
  // migration is Flutter-driven and must not be touched (#441).
  it('estado `am` still wins over the legacy arm', () => {
    expect(
      run(familyRow({ links: [{ estado: ESTADO_PUBLICACAO_ML.aguardandoMigracao, status: null }] }))
        .skips,
    ).toEqual([{ produtoId: 'PROD', reason: 'aguardando-migracao' }]);
  });

  it('ehKitVirtual anchor → kit-virtual', () => {
    expect(run(familyRow({ anchor: { ehKitVirtual: true } })).skips).toEqual([
      { produtoId: 'PROD', reason: 'kit-virtual' },
    ]);
  });

  it('unpublished anchor → nao-publicado', () => {
    // DEFENSIVE-ONLY rung: S1 already filters `publicado` server-side.
    expect(run(familyRow({ anchor: { publicado: false } })).skips).toEqual([
      { produtoId: 'PROD', reason: 'nao-publicado' },
    ]);
  });

  it('conta not in integracoesComProduto → conta-fora-do-produto', () => {
    // DEFENSIVE-ONLY rung: S1 already filters the conta server-side.
    expect(run(familyRow({ integracoes: ['outra-conta'] })).skips).toEqual([
      { produtoId: 'PROD', reason: 'conta-fora-do-produto' },
    ]);
  });

  it('skip reasons follow the documented evaluation order', () => {
    // Anchor-level rungs run ONCE before the per-listing loop: kit-virtual
    // wins over nao-publicado AND over every per-listing reason (estado 'am',
    // unknown status) — ONE family skip, never one per listing.
    expect(
      run(
        familyRow({
          anchor: { ehKitVirtual: true, publicado: false },
          links: [{ estado: 'am', status: 'weird' }],
        }),
      ).skips,
    ).toEqual([{ produtoId: 'PROD', reason: 'kit-virtual' }]);

    expect(
      run(
        familyRow({
          anchor: { ehKitVirtual: true },
          links: [{ status: 'paused', sub_status: [] }],
        }),
      ).skips,
    ).toEqual([{ produtoId: 'PROD', reason: 'kit-virtual' }]);

    // Inside the loop the per-listing rungs keep their order: estado 'am'
    // wins over an unknown status.
    expect(run(familyRow({ links: [{ estado: 'am', status: 'weird' }] })).skips).toEqual([
      { produtoId: 'PROD', reason: 'aguardando-migracao' },
    ]);
  });

  it('old model + children → ONE bulk item task with numeric variation ids', () => {
    const row = familyRow({
      children: [
        child('CH1', [{ id: 101, produtoMercadoLivreOuterRef: PARENT_LINK_REF }]),
        child('CH2', [
          // A stale link pointing at ANOTHER parent link must be ignored.
          {
            id: 999,
            produtoMercadoLivreOuterRef: 'documents/produtos/OTHER/produtoMercadoLivre/linkX',
          },
          { id: 102, produtoMercadoLivreOuterRef: PARENT_LINK_REF },
        ]),
      ],
    });
    const qty = new Map([
      ['PROD', 7],
      ['CH1', 3],
      ['CH2', 4],
    ]);
    expect(buildSendTasks(row, qty, OPTS)).toEqual({
      tasks: [
        {
          ...BASE_TASK,
          kind: 'item',
          itemId: 'MLB111',
          variacaoProdutoId: null,
          quantidade: null,
          variations: [
            { id: 101, available_quantity: 3 },
            { id: 102, available_quantity: 4 },
          ],
        },
      ],
      skips: [],
    });
  });

  it('old bulk: unmatched / non-numeric-id / quantity-less children skip, siblings ride', () => {
    const row = familyRow({
      children: [
        child('CH1', [{ id: 101, produtoMercadoLivreOuterRef: PARENT_LINK_REF }]),
        child('CH2', []), // no varLink for this parent → sem-link
        child('CH3', [{ id: 'MLB-STRING', produtoMercadoLivreOuterRef: PARENT_LINK_REF }]), // → sem-item-id
        child('CHV', [{ id: 104, produtoMercadoLivreOuterRef: PARENT_LINK_REF }]), // no qty → kit-virtual
      ],
    });
    const qty = new Map([
      ['PROD', 7],
      ['CH1', 3],
      ['CH3', 5],
    ]);
    const res = buildSendTasks(row, qty, OPTS);
    expect(res.tasks).toEqual([
      {
        ...BASE_TASK,
        kind: 'item',
        itemId: 'MLB111',
        variacaoProdutoId: null,
        quantidade: null,
        variations: [{ id: 101, available_quantity: 3 }],
      },
    ]);
    expect(res.skips).toEqual([
      { produtoId: 'CH2', reason: 'sem-link' },
      { produtoId: 'CH3', reason: 'sem-item-id' },
      { produtoId: 'CHV', reason: 'kit-virtual' },
    ]);
  });

  it('old bulk: > 1000 variations (below the cap) still builds ONE task + early warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockClear();
    const errorSpy = vi.spyOn(console, 'error').mockClear();
    const children: FamilyChild[] = [];
    const qty = new Map<string, number>([['PROD', 7]]);
    for (let i = 1; i <= 1001; i++) {
      children.push(child(`CH${i}`, [{ id: i, produtoMercadoLivreOuterRef: PARENT_LINK_REF }]));
      qty.set(`CH${i}`, 1);
    }
    const res = buildSendTasks(familyRow({ children }), qty, OPTS);
    expect(res.tasks).toHaveLength(1);
    expect(res.tasks[0]!.variations).toHaveLength(1001);
    expect(res.skips).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('variations'),
      expect.objectContaining({ produtoId: 'PROD', itemId: 'MLB111', variations: 1001 }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('old bulk: variations past MAX_VARIATIONS_PER_TASK → NO task, skip + console.error', () => {
    // Past the cap the Cloud Tasks enqueue itself would reject the ~100 KB+
    // payload and the sweep would re-attempt the same family forever.
    const warnSpy = vi.spyOn(console, 'warn').mockClear();
    const errorSpy = vi.spyOn(console, 'error').mockClear();
    const children: FamilyChild[] = [];
    const qty = new Map<string, number>([['PROD', 7]]);
    for (let i = 1; i <= MAX_VARIATIONS_PER_TASK + 1; i++) {
      children.push(child(`CH${i}`, [{ id: i, produtoMercadoLivreOuterRef: PARENT_LINK_REF }]));
      qty.set(`CH${i}`, 1);
    }
    const res = buildSendTasks(familyRow({ children }), qty, OPTS);
    expect(res.tasks).toEqual([]);
    expect(res.skips).toEqual([{ produtoId: 'PROD', reason: 'variations-excede-limite' }]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('variations'),
      expect.objectContaining({
        produtoId: 'PROD',
        itemId: 'MLB111',
        variations: MAX_VARIATIONS_PER_TASK + 1,
        max: MAX_VARIATIONS_PER_TASK,
      }),
    );
    expect(warnSpy).not.toHaveBeenCalled(); // the hard guard runs BEFORE the early warn
  });

  it('old bulk: EVERY child excluded → no task, only the skips', () => {
    const row = familyRow({ children: [child('CH1', []), child('CH2', [])] });
    expect(buildSendTasks(row, new Map([['PROD', 7]]), OPTS)).toEqual({
      tasks: [],
      skips: [
        { produtoId: 'CH1', reason: 'sem-link' },
        { produtoId: 'CH2', reason: 'sem-link' },
      ],
    });
  });

  it('UP model: one variationItem task per child, deduped by itemId', () => {
    const row = familyRow({
      links: [{ isUserProductModel: true }],
      children: [
        child('CH1', [{ itemId: 'MLB-CH1', produtoMercadoLivreOuterRef: PARENT_LINK_REF }]),
        child('CH2', [{ itemId: 'MLB-CH2', produtoMercadoLivreOuterRef: PARENT_LINK_REF }]),
        // Duplicate ML item (two children pointing at the same listing) — one call only.
        child('CH3', [{ itemId: 'MLB-CH1', produtoMercadoLivreOuterRef: PARENT_LINK_REF }]),
      ],
    });
    const qty = new Map([
      ['PROD', 7],
      ['CH1', 3],
      ['CH2', 4],
      ['CH3', 5],
    ]);
    expect(buildSendTasks(row, qty, OPTS)).toEqual({
      tasks: [
        {
          ...BASE_TASK,
          kind: 'variationItem',
          itemId: 'MLB-CH1',
          variacaoProdutoId: 'CH1',
          quantidade: 3,
          variations: null,
        },
        {
          ...BASE_TASK,
          kind: 'variationItem',
          itemId: 'MLB-CH2',
          variacaoProdutoId: 'CH2',
          quantidade: 4,
          variations: null,
        },
      ],
      skips: [],
    });
  });

  it('UP model: per-child sem-link / sem-item-id / kit-virtual skips, siblings sent', () => {
    const row = familyRow({
      links: [{ isUserProductModel: true }],
      children: [
        child('CH1', [{ itemId: 'MLB-CH1', produtoMercadoLivreOuterRef: PARENT_LINK_REF }]),
        child('CH2', []),
        child('CH3', [{ itemId: null, produtoMercadoLivreOuterRef: PARENT_LINK_REF }]),
        child('CHV', [{ itemId: 'MLB-CHV', produtoMercadoLivreOuterRef: PARENT_LINK_REF }]),
      ],
    });
    const qty = new Map([
      ['PROD', 7],
      ['CH1', 3],
      ['CH3', 5],
    ]);
    const res = buildSendTasks(row, qty, OPTS);
    expect(res.tasks).toEqual([
      {
        ...BASE_TASK,
        kind: 'variationItem',
        itemId: 'MLB-CH1',
        variacaoProdutoId: 'CH1',
        quantidade: 3,
        variations: null,
      },
    ]);
    expect(res.skips).toEqual([
      { produtoId: 'CH2', reason: 'sem-link' },
      { produtoId: 'CH3', reason: 'sem-item-id' },
      { produtoId: 'CHV', reason: 'kit-virtual' },
    ]);
  });

  it('childless UP family degenerates to a single item task with the anchor quantity', () => {
    expect(run(familyRow({ links: [{ isUserProductModel: true }] }))).toEqual({
      tasks: [
        {
          ...BASE_TASK,
          kind: 'item',
          itemId: 'MLB111',
          variacaoProdutoId: null,
          quantidade: 7,
          variations: null,
        },
      ],
      skips: [],
    });
  });

  /* ------------- multi-listing: the legacy per-listing loop --------------- */

  it('two ACTIVE listings on one conta (old model) → one item task PER listing, per-link matching', () => {
    // Each listing carries its OWN itemId/linkDocId, and each child variation
    // is matched against THAT listing's docPath (PARENT_LINK_REF vs _REF2).
    const row = familyRow({
      links: [{}, { id: 'MLB222', linkDocId: 'link2' }],
      children: [
        child('CH1', [
          { id: 101, produtoMercadoLivreOuterRef: PARENT_LINK_REF },
          { id: 201, produtoMercadoLivreOuterRef: PARENT_LINK_REF2 },
        ]),
        child('CH2', [
          { id: 102, produtoMercadoLivreOuterRef: PARENT_LINK_REF },
          { id: 202, produtoMercadoLivreOuterRef: PARENT_LINK_REF2 },
        ]),
      ],
    });
    const qty = new Map([
      ['PROD', 7],
      ['CH1', 3],
      ['CH2', 4],
    ]);
    expect(buildSendTasks(row, qty, OPTS)).toEqual({
      tasks: [
        {
          ...BASE_TASK,
          kind: 'item',
          itemId: 'MLB111',
          variacaoProdutoId: null,
          quantidade: null,
          variations: [
            { id: 101, available_quantity: 3 },
            { id: 102, available_quantity: 4 },
          ],
        },
        {
          ...BASE_TASK,
          linkDocId: 'link2',
          kind: 'item',
          itemId: 'MLB222',
          variacaoProdutoId: null,
          quantidade: null,
          variations: [
            { id: 201, available_quantity: 3 },
            { id: 202, available_quantity: 4 },
          ],
        },
      ],
      skips: [],
    });
  });

  it('per-listing status gate: a paused listing skips ALONE, the active sibling still sends', () => {
    const res = run(
      familyRow({
        links: [
          { status: 'paused', sub_status: ['paused_by_seller'] },
          { id: 'MLB222', linkDocId: 'link2' },
        ],
      }),
    );
    expect(res.tasks).toEqual([
      {
        ...BASE_TASK,
        linkDocId: 'link2',
        kind: 'item',
        itemId: 'MLB222',
        variacaoProdutoId: null,
        quantidade: 7,
        variations: null,
      },
    ]);
    expect(res.skips).toEqual([{ produtoId: 'PROD', reason: 'status-nao-enviavel' }]);
  });

  it('UP dedup across listings: two links resolving the SAME variation itemId emit once', () => {
    // The cycle-wide emittedItemIds set spans the whole per-listing loop —
    // the duplicate drops silently (legacy debug print, no skip).
    const row = familyRow({
      links: [
        { isUserProductModel: true },
        { id: 'MLB222', linkDocId: 'link2', isUserProductModel: true },
      ],
      children: [
        child('CH1', [
          { itemId: 'MLB-CH1', produtoMercadoLivreOuterRef: PARENT_LINK_REF },
          { itemId: 'MLB-CH1', produtoMercadoLivreOuterRef: PARENT_LINK_REF2 },
        ]),
      ],
    });
    const qty = new Map([
      ['PROD', 7],
      ['CH1', 3],
    ]);
    expect(buildSendTasks(row, qty, OPTS)).toEqual({
      tasks: [
        {
          ...BASE_TASK,
          kind: 'variationItem',
          itemId: 'MLB-CH1',
          variacaoProdutoId: 'CH1',
          quantidade: 3,
          variations: null,
        },
      ],
      skips: [],
    });
  });
});
