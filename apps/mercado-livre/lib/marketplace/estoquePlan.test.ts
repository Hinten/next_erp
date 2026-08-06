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
  ESTADOS_VENDA,
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
  atividadeLookbackDays,
  buildSendTasks,
  concurrentDispatches,
  cursorMaxLookbackHours,
  dailyWindowHours,
  deveEnviarIncremental,
  dispatchesPerSecond,
  disponivelByProdutoIdFrom,
  envFlag,
  envInt,
  envioInalterado,
  estoqueMax,
  fetchSoldProdutoIds,
  fetchStockFamilies,
  fingerprintVariations,
  incrementalWindowMin,
  isStockSyncEnabled,
  kitIncluiEstoqueProprio,
  limiarEstoqueBaixo,
  maxPauseReenqueues,
  maxTasksPerSweep,
  podeEnviarEstoque,
  pularEnvioInalterado,
  quantidadeDoMembro,
  quantidadeParaEnvio,
  quantidadesDaFamilia,
  ratePauseMin,
  skipTtlHours,
  soldIdsLimit,
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
const CUTOFF_US = Date.parse('2026-06-24T10:00:00.000Z') * 1000;
const T1 = Date.parse('2026-07-24T10:05:00.000Z');
const T2 = Date.parse('2026-07-24T10:10:00.000Z');
const T4 = Date.parse('2026-07-24T10:20:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** Every env var the tests mutate — cleared after each test. */
const TOUCHED_ENV = [
  STOCK_SYNC_FLAG_ENV,
  'MERCADO_LIVRE_STOCK_INCREMENTAL_WINDOW_MIN',
  'MERCADO_LIVRE_STOCK_LIMIAR',
  'MERCADO_LIVRE_STOCK_MAX',
  'MERCADO_LIVRE_STOCK_KIT_INCLUI_PROPRIO',
  'MERCADO_LIVRE_STOCK_ANCHOR_PAGE_LIMIT',
  'MERCADO_LIVRE_STOCK_RATE_PAUSE_MIN',
  'MERCADO_LIVRE_STOCK_SOLD_IDS_LIMIT',
  'MERCADO_LIVRE_STOCK_SKIP_UNCHANGED_DISABLED',
  'MERCADO_LIVRE_STOCK_SKIP_TTL_H',
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

const compEstoquesMaxSub = (keysVar: string) =>
  cond(
    gt(len(vr(keysVar)), 0),
    {
      kind: 'scalarSubquery',
      stages: [
        { stage: 'collectionGroup', args: ['estoques'] },
        { stage: 'where', args: [AND(inAny(f('parentId'), vr(keysVar)), depOr)] },
        { stage: 'aggregate', args: [alias('max', maxOf('ultimaModificacao'))] },
      ],
    },
    cnst(null),
  );

const kitKeysDef = (name: string) => alias(name, coal(f('componentesKitKeys'), arr([])));

// The rollup binds `maxChildKitKeys`, NOT the childrenJoin's `childKitKeys` —
// sibling rebinding of one global variable name is an unverified assumption
// (spike a).
const maxChildrenSub = () => ({
  kind: 'scalarSubquery',
  stages: [
    { stage: 'collection', args: ['produtos'] },
    { stage: 'where', args: [eq(f('paiId'), vr('anchorId'))] },
    { stage: 'define', args: [kitKeysDef('maxChildKitKeys')] },
    {
      stage: 'select',
      args: [alias('m', logicalMax(ownEstoqueMaxSub(), compEstoquesMaxSub('maxChildKitKeys')))],
    },
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
        // Skip-if-unchanged state (#695) — three scalars, no `where` change.
        'ultimoEstoqueEnviado',
        'ultimoEstoqueEnviadoHash',
        'ultimoEnvioMs',
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
            {
              stage: 'select',
              args: [
                'itemId',
                'id',
                'produtoMercadoLivreOuterRef',
                // Skip-if-unchanged state (#695) + this doc's OWN id, the UP
                // writeback target. Still no `where` — the probe stays a
                // partition-bounded TableScan.
                'ultimoEstoqueEnviado',
                'ultimoEnvioMs',
                alias('varLinkDocId', docId(f('__name__'))),
              ],
            },
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
 * S4 where over the added FIELDS → S5 sort+limit → S6 select. The sales
 * signal is NOT here — it moved to the uncorrelated fetchSoldProdutoIds
 * pre-pass (its own describe below).
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
      args: [
        alias('maxOwn', ownEstoqueMaxSub()),
        alias('maxComp', compEstoquesMaxSub('anchorKitKeys')),
        alias('maxChildren', maxChildrenSub()),
      ],
    },
    {
      stage: 'where',
      args: [gt(coal(logicalMax(f('maxOwn'), f('maxComp'), f('maxChildren')), 0), changedSinceMs)],
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

/** The full documented sold-ids pre-pass stage tree (ONE execution). */
function expectedSoldStages(
  limit: number,
  estados: readonly unknown[] = [...ESTADOS_VENDA],
): RecordedStage[] {
  return [
    { stage: 'collection', args: ['pedidos'] },
    {
      stage: 'where',
      args: [
        AND(
          eq(f('ehSaida'), true),
          inAny(f('estado'), [...estados]),
          gte(f('timestamp'), CUTOFF_US),
        ),
      ],
    },
    { stage: 'unnest', args: [alias('pid', f('itensIds'))] },
    { stage: 'distinct', args: ['pid'] },
    { stage: 'limit', args: [limit] },
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
    expect(ESTADOS_VENDA).toEqual([
      'emAnalise',
      'emProcessamento',
      'pago',
      'finalizado',
      'estornadoParcialmente',
    ]);
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
    expect(atividadeLookbackDays()).toBe(30);
    expect(limiarEstoqueBaixo()).toBe(5);
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
      args: [gt(coal(logicalMax(f('maxOwn'), f('maxComp'), f('maxChildren')), 0), -1)],
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

describe('fetchSoldProdutoIds — the uncorrelated sales pre-pass', () => {
  const SOLD_ARGS = { vendaCutoffUs: CUTOFF_US, estadosVenda: ESTADOS_VENDA };

  it('single execution: the full documented stage tree (where → unnest → distinct → limit)', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([{ pid: 'A' }]);

    await fetchSoldProdutoIds(asDb(db), { ...SOLD_ARGS, limit: 50 });

    expect(db.pipelineExecutions).toHaveLength(1);
    expect(db.pipelineExecutions[0]).toEqual(expectedSoldStages(50));
  });

  it('carries exactly the estadosVenda ARG, not the constant', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);
    const SENTINEL = ['sentinel-estado-1', 'sentinel-estado-2'];

    await fetchSoldProdutoIds(asDb(db), { ...SOLD_ARGS, estadosVenda: SENTINEL, limit: 50 });

    expect(db.pipelineExecutions[0]).toEqual(expectedSoldStages(50, SENTINEL));
  });

  it('maps rows into a Set of string pids, junk filtered', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([
      { pid: 'PROD-A' },
      { pid: '' }, // empty string dropped
      { pid: 42 }, // non-string dropped
      {}, // absent pid dropped
      { pid: 'PROD-B' },
    ]);

    const soldIds = await fetchSoldProdutoIds(asDb(db), { ...SOLD_ARGS, limit: 50 });

    expect(soldIds).toEqual(new Set(['PROD-A', 'PROD-B']));
  });

  it('default cap comes from soldIdsLimit() (env-tunable, read lazily)', async () => {
    expect(soldIdsLimit()).toBe(10_000);
    const db = new FakeDb();
    db.queuePipelinePage([]);
    await fetchSoldProdutoIds(asDb(db), SOLD_ARGS);
    expect(db.pipelineExecutions[0]![4]).toEqual({ stage: 'limit', args: [10_000] });

    process.env.MERCADO_LIVRE_STOCK_SOLD_IDS_LIMIT = '7';
    const db2 = new FakeDb();
    db2.queuePipelinePage([]);
    await fetchSoldProdutoIds(asDb(db2), SOLD_ARGS);
    expect(db2.pipelineExecutions[0]![4]).toEqual({ stage: 'limit', args: [7] });
  });

  it('result size == limit → LOUD truncation warn (sold ids are missing)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockClear();
    const db = new FakeDb();
    db.queuePipelinePage([{ pid: 'A' }, { pid: 'B' }]);

    await fetchSoldProdutoIds(asDb(db), { ...SOLD_ARGS, limit: 2 });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('SOLD_IDS_LIMIT'),
      expect.objectContaining({ limit: 2 }),
    );
  });

  it('below the limit → no warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockClear();
    const db = new FakeDb();
    db.queuePipelinePage([{ pid: 'A' }]);

    await fetchSoldProdutoIds(asDb(db), { ...SOLD_ARGS, limit: 2 });

    expect(warnSpy).not.toHaveBeenCalled();
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

describe('deveEnviarIncremental — activity filter OR-arms', () => {
  const NOW = T4;
  const NO_SALES: ReadonlySet<string> = new Set();
  const quietRow = () =>
    familyRow({
      anchor: { timestampMs: NOW - 40 * DAY_MS },
      children: [child('CH1', [], { timestampMs: NOW - 35 * DAY_MS })],
    });
  const okQty = new Map([
    ['PROD', 10],
    ['CH1', 8],
  ]);

  it('the ANCHOR id in soldIds → send', () => {
    expect(deveEnviarIncremental(quietRow(), okQty, NOW, new Set(['PROD']))).toBe(true);
  });

  it('ANY child id in soldIds → send (legacy hasSales = own or any child)', () => {
    expect(deveEnviarIncremental(quietRow(), okQty, NOW, new Set(['CH1']))).toBe(true);
  });

  it('soldIds hits on OTHER produtos do not send this family', () => {
    expect(deveEnviarIncremental(quietRow(), okQty, NOW, new Set(['OUTRO-PROD']))).toBe(false);
  });

  it('any member created within the lookback → send (anchor or child)', () => {
    const recentAnchor = familyRow({ anchor: { timestampMs: NOW - DAY_MS } });
    expect(deveEnviarIncremental(recentAnchor, okQty, NOW, NO_SALES)).toBe(true);

    const recentChild = familyRow({
      anchor: { timestampMs: NOW - 40 * DAY_MS },
      children: [child('CH1', [], { timestampMs: NOW - DAY_MS })],
    });
    expect(deveEnviarIncremental(recentChild, okQty, NOW, NO_SALES)).toBe(true);
  });

  it('any quantity below the limiar → send; the limiar is env-tunable', () => {
    const lowQty = new Map([
      ['PROD', 10],
      ['CH1', 3], // < 5
    ]);
    expect(deveEnviarIncremental(quietRow(), lowQty, NOW, NO_SALES)).toBe(true);
    process.env.MERCADO_LIVRE_STOCK_LIMIAR = '2';
    expect(deveEnviarIncremental(quietRow(), lowQty, NOW, NO_SALES)).toBe(false); // 3 >= 2
  });

  it('no sale, nothing recent, all quantities healthy → skip', () => {
    expect(deveEnviarIncremental(quietRow(), okQty, NOW, NO_SALES)).toBe(false);
    expect(deveEnviarIncremental(familyRow(), new Map(), NOW, NO_SALES)).toBe(false); // null timestamps
  });
});

describe('skip-if-unchanged (#695) — pure core', () => {
  describe('fingerprintVariations', () => {
    it('is deterministic and 32 hex chars', () => {
      const fp = fingerprintVariations([
        { id: 2, available_quantity: 5 },
        { id: 1, available_quantity: 9 },
      ]);
      expect(fp).toMatch(/^[0-9a-f]{32}$/);
      expect(
        fingerprintVariations([
          { id: 2, available_quantity: 5 },
          { id: 1, available_quantity: 9 },
        ]),
      ).toBe(fp);
    });

    it('ignores CHILD ORDER — the children subquery has no sort, so order is noise', () => {
      const a = fingerprintVariations([
        { id: 1, available_quantity: 9 },
        { id: 2, available_quantity: 5 },
      ]);
      const b = fingerprintVariations([
        { id: 2, available_quantity: 5 },
        { id: 1, available_quantity: 9 },
      ]);
      expect(a).toBe(b);
    });

    it('changes when ONE variation quantity changes — the whole bulk must re-send', () => {
      const before = fingerprintVariations([
        { id: 1, available_quantity: 9 },
        { id: 2, available_quantity: 5 },
      ]);
      const after = fingerprintVariations([
        { id: 1, available_quantity: 9 },
        { id: 2, available_quantity: 4 },
      ]);
      expect(after).not.toBe(before);
    });

    it('distinguishes a REMOVED variation from a kept one', () => {
      expect(fingerprintVariations([{ id: 1, available_quantity: 9 }])).not.toBe(
        fingerprintVariations([
          { id: 1, available_quantity: 9 },
          { id: 2, available_quantity: 0 },
        ]),
      );
    });

    it('handles the empty list without throwing', () => {
      expect(fingerprintVariations([])).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('envioInalterado — fails OPEN on every doubt', () => {
    const NOW = 1_700_000_000_000;
    const FRESH = NOW - 60_000; // one minute old, well inside the 24h default

    it('true only when the value matches AND the stamp is fresh', () => {
      expect(envioInalterado(12, FRESH, 12, NOW)).toBe(true);
      expect(envioInalterado('abc', FRESH, 'abc', NOW)).toBe(true);
    });

    it('sends when the value differs', () => {
      expect(envioInalterado(12, FRESH, 13, NOW)).toBe(false);
    });

    it('sends on a TYPE mismatch — a stored "12" never satisfies a computed 12', () => {
      expect(envioInalterado('12', FRESH, 12, NOW)).toBe(false);
      expect(envioInalterado(12, FRESH, '12', NOW)).toBe(false);
    });

    it('never lets the hash arm satisfy the scalar arm (and vice versa)', () => {
      // A bulk listing that becomes childless reads its OWN stale hash against
      // a numeric quantity — different types, so it sends.
      const hash = fingerprintVariations([{ id: 1, available_quantity: 7 }]);
      expect(envioInalterado(hash, FRESH, 7, NOW)).toBe(false);
    });

    it('sends when there is no recorded value at all (first send)', () => {
      expect(envioInalterado(null, FRESH, 12, NOW)).toBe(false);
      expect(envioInalterado(undefined, FRESH, 12, NOW)).toBe(false);
    });

    it('sends when the value carries NO stamp, or a junk one', () => {
      expect(envioInalterado(12, null, 12, NOW)).toBe(false);
      expect(envioInalterado(12, undefined, 12, NOW)).toBe(false);
      expect(envioInalterado(12, 'ontem', 12, NOW)).toBe(false);
      expect(envioInalterado(12, Number.NaN, 12, NOW)).toBe(false);
    });

    it('sends on a FUTURE stamp — clock skew, or a µs value read as ms', () => {
      expect(envioInalterado(12, NOW + 1, 12, NOW)).toBe(false);
      expect(envioInalterado(12, NOW * 1000, 12, NOW)).toBe(false);
    });

    it('sends once the stamp is older than the TTL (boundary is exclusive)', () => {
      const ttlMs = 24 * 3_600_000;
      expect(envioInalterado(12, NOW - ttlMs + 1, 12, NOW)).toBe(true);
      expect(envioInalterado(12, NOW - ttlMs, 12, NOW)).toBe(false);
      expect(envioInalterado(12, NOW - ttlMs - 1, 12, NOW)).toBe(false);
    });

    it('honours MERCADO_LIVRE_STOCK_SKIP_TTL_H, and TTL 0 disables the skip', () => {
      process.env.MERCADO_LIVRE_STOCK_SKIP_TTL_H = '1';
      expect(envioInalterado(12, NOW - 30 * 60_000, 12, NOW)).toBe(true);
      expect(envioInalterado(12, NOW - 90 * 60_000, 12, NOW)).toBe(false);
      process.env.MERCADO_LIVRE_STOCK_SKIP_TTL_H = '0';
      expect(envioInalterado(12, FRESH, 12, NOW)).toBe(false);
    });
  });

  describe('config getters', () => {
    it('pularEnvioInalterado is a KILL switch — ON unless explicitly disabled', () => {
      expect(pularEnvioInalterado()).toBe(true);
      process.env.MERCADO_LIVRE_STOCK_SKIP_UNCHANGED_DISABLED = '1';
      expect(pularEnvioInalterado()).toBe(false);
      // envFlag only honours an exact '1' — anything else leaves the skip ON.
      process.env.MERCADO_LIVRE_STOCK_SKIP_UNCHANGED_DISABLED = 'true';
      expect(pularEnvioInalterado()).toBe(true);
    });

    it('skipTtlHours defaults to 24 and falls back on junk', () => {
      expect(skipTtlHours()).toBe(24);
      process.env.MERCADO_LIVRE_STOCK_SKIP_TTL_H = 'xx';
      expect(skipTtlHours()).toBe(24);
      process.env.MERCADO_LIVRE_STOCK_SKIP_TTL_H = '6';
      expect(skipTtlHours()).toBe(6);
    });
  });
});

describe('buildSendTasks — decision ladder + task shapes', () => {
  const OPTS = { integracaoId: CONTA, sweepId: 'sweep-1', sweepComputedAtMs: T4 };
  const BASE_TASK = {
    integracaoId: CONTA,
    produtoId: 'PROD',
    linkDocId: 'link1',
    // Only a UP `variationItem` whose varLink projected a doc id carries one
    // (#695); every other shape records on the anchor link.
    varLinkDocId: null,
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

  it('UP: each task carries its OWN varLinkDocId — the per-item writeback target (#695)', () => {
    // The anchor `linkDocId` is IDENTICAL across siblings, so it cannot hold a
    // per-item last-sent value; `varLinkDocId` is what makes the record 1:1
    // with the task. A varLink projecting no doc id degrades to null (the send
    // still happens, nothing is recorded, that variation never skips).
    const row = familyRow({
      links: [{ isUserProductModel: true }],
      children: [
        child('CH1', [
          {
            itemId: 'MLB-CH1',
            produtoMercadoLivreOuterRef: PARENT_LINK_REF,
            varLinkDocId: 'vl-1',
          },
        ]),
        child('CH2', [
          {
            itemId: 'MLB-CH2',
            produtoMercadoLivreOuterRef: PARENT_LINK_REF,
            varLinkDocId: '', // junk → null, not ''
          },
        ]),
        child('CH3', [{ itemId: 'MLB-CH3', produtoMercadoLivreOuterRef: PARENT_LINK_REF }]),
      ],
    });
    const { tasks } = run(
      row,
      new Map([
        ['CH1', 1],
        ['CH2', 2],
        ['CH3', 3],
      ]),
    );
    expect(tasks.map((t) => [t.itemId, t.linkDocId, t.varLinkDocId])).toEqual([
      ['MLB-CH1', 'link1', 'vl-1'],
      ['MLB-CH2', 'link1', null],
      ['MLB-CH3', 'link1', null],
    ]);
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
