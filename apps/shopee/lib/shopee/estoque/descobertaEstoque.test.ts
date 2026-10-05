import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';

// The admin Pipelines subpath is mocked with tagged-object builders (the
// `firestore-pipelines` skill pattern, copied from
// `apps/mercado-livre/lib/marketplace/estoque/bulkEstoquePlan.test.ts`): a
// pipeline is NEVER executed in a unit test — it cannot be, not here and not in
// the emulator — so every assertion targets the STAGES and EXPRESSIONS the code
// builds, through a fake `db.pipeline()` chain. Chainable methods live on
// prototypes so a structural `toEqual` sees only the tag data.
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
    /**
     * The by-ids SOURCE stage — a batch KEY read. References are recorded by
     * PATH: a real admin `DocumentReference` carries a live Firestore handle, so
     * a structural `toEqual` on the raw object would compare the client rather
     * than the query.
     */
    documents(refs: ReadonlyArray<{ refPath?: string; path?: string }>): this {
      return this.push('documents', [refs.map((r) => r.refPath ?? r.path ?? String(r))]);
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

import { chaveMovimento } from '@delfrance/data/admin/estoque';

import { anchorPageLimit } from './constantesEstoque';
import {
  buscarFamiliasShopee,
  buscarFamiliasShopeePorIds,
  buscarMovimentosDaJanela,
} from './descobertaEstoque';

/* ------------------------------ fake Firestore ----------------------------- */

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

  // The classic surface the keyset cursor needs: `produtoCollection.docRef`
  // resolves the path and then addresses the document, so the double answers a
  // plain tagged object and the stage-tree assertions stay structural. (Spelled
  // without naming the accessor, which the folder's raw-text discipline bans.)
  collection(path: string): { doc: (id: string) => { refPath: string } } {
    return { doc: (id: string) => ({ refPath: `${path}/${id}` }) };
  }
}

function asDb(db: FakeDb): Firestore {
  return db as unknown as Firestore;
}

/**
 * `noUncheckedIndexedAccess` is on in this app, and an `!` would turn a MISSING
 * execution into a null-deref five lines later. These two say what was expected
 * at the point the expectation fails.
 */
function naoNulo<T>(valor: T | undefined, oQue: string): T {
  if (valor === undefined) throw new Error(`ausente: ${oQue}`);
  return valor;
}

function execucao(db: FakeDb, i: number): RecordedStage[] {
  return naoNulo(db.pipelineExecutions[i], `execução ${i}`);
}

function estagio(db: FakeDb, i: number, j: number): RecordedStage {
  return naoNulo(execucao(db, i)[j], `estágio ${j} da execução ${i}`);
}

/* --------------------------------- fixtures -------------------------------- */

const DEPOSITO_ID = 'dep-1';
const CONTA = 'int-1';
const DESDE_MS = Date.parse('2026-09-21T10:00:00.000Z');
const PAGE_LIMIT_ENV = 'SHOPEE_STOCK_ANCHOR_PAGE_LIMIT';

/* Expected-tree builders — the mock Exprs compare structurally. */
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
const cond = (c: unknown, t: unknown, e: unknown) => ({ kind: 'conditional', c, t, e });
const len = (of: unknown) => ({ kind: 'length', of });

/** Both accepted depósito `*OuterRef` encodings — the shared `depMatch`. */
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
    {
      stage: 'select',
      args: [
        alias('estoqueDocId', docId(f('__name__'))),
        'quantidade',
        'quantidadeReservada',
        'ultimaModificacao',
      ],
    },
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
          args: [
            alias('estoqueDocId', docId(f('__name__'))),
            'parentId',
            'quantidade',
            'quantidadeReservada',
            'ultimaModificacao',
          ],
        },
      ],
    },
    arr([]),
  );

const kitKeysDef = (name: string) => alias(name, coal(f('componentesKitKeys'), arr([])));

const maxChildrenSub = () => ({
  kind: 'scalarSubquery',
  stages: [
    { stage: 'collection', args: ['produtos'] },
    { stage: 'where', args: [eq(f('paiId'), vr('anchorId'))] },
    { stage: 'select', args: [alias('m', ownEstoqueMaxSub())] },
    { stage: 'aggregate', args: [alias('max', maxOf('m'))] },
  ],
});

/** The parent-link probe: NO `where` — the conta is compared in memory. */
const linksSub = () => ({
  kind: 'arraySubquery',
  stages: [
    { stage: 'subcollection', args: ['prodshopee'] },
    {
      stage: 'select',
      args: [
        'contaProdutoShopeeOuterRef',
        'item_id',
        'item_status',
        'estadoAnuncio',
        'pausadoPeloErp',
        'category_id',
        'kitNativo',
        'estoqueRecusaEm',
        'estoqueRecusaAte',
        'estoqueRecusaEstado',
        'estoqueRecusaItemStatus',
        'estoqueEnviadoEm',
        alias('linkDocId', docId(f('__name__'))),
      ],
    },
  ],
});

/** The model-link probe: NO `where` either, and `produtoShopeeOuterRef` present. */
const varLinksSub = () => ({
  kind: 'arraySubquery',
  stages: [
    { stage: 'subcollection', args: ['variashopee'] },
    {
      stage: 'select',
      args: [
        'contaVariacaoShopeeOuterRef',
        'produtoShopeeOuterRef',
        'model_id',
        'tier_index',
        'model_status',
        'modeloAusenteEm',
        alias('varLinkDocId', docId(f('__name__'))),
      ],
    },
  ],
});

const filhosSub = () => ({
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
        alias('varLinks', varLinksSub()),
      ],
    },
  ],
});

/**
 * THE query's S1 base terms.
 *
 * ⚠️ EXACTLY two terms, and this list is the ONLY thing standing between a
 * re-added `publicado == true` and a silent regression on both axes: every row
 * assertion in this file stays green with the term back in place, and Firestore
 * Enterprise does not throw on a missing index — it full-scans and bills the
 * bytes. Re-adding the term costs money and coverage at once, with nothing red.
 */
const s1Termos = () => [eq(f('paiId'), null), contains(f('integracoesComProduto'), CONTA)];
const s1Pagina1 = () => AND(...s1Termos());
const s1Depois = (anchorId: string) =>
  AND(
    ...s1Termos(),
    gt(f('__name__'), { kind: 'constant', v: { refPath: `produtos/${anchorId}` } }),
  );

const projecaoS6 = () => [
  alias('anchorId', vr('anchorId')),
  'ehKit',
  'ehKitVirtual',
  'publicado',
  'componentesKit',
  'integracoesComProduto',
  'timestamp',
  alias('estoque', ownEstoqueSub()),
  alias('componentEstoques', compEstoquesSub('anchorKitKeys')),
  alias('links', linksSub()),
  alias('children', filhosSub()),
];

function estagiosEsperados(s1: unknown, limit: number, changedSinceMs = DESDE_MS): RecordedStage[] {
  return [
    { stage: 'collection', args: ['produtos'] },
    { stage: 'where', args: [s1] },
    {
      stage: 'define',
      args: [alias('anchorId', docId(f('__name__'))), kitKeysDef('anchorKitKeys')],
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
    { stage: 'select', args: projecaoS6() },
  ];
}

const ARGS = {
  integracaoId: CONTA,
  depositoId: DEPOSITO_ID,
  changedSinceMs: DESDE_MS,
} as const;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env[PAGE_LIMIT_ENV];
  vi.restoreAllMocks();
});

/* ========================================================================== */

describe('buscarFamiliasShopee — a árvore de estágios', () => {
  it('1 · uma página curta executa UMA pipeline com a árvore documentada S1→S6', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([{ anchorId: 'prod-1' }]);

    await buscarFamiliasShopee(asDb(db), { ...ARGS, pageLimit: 3 });

    expect(db.pipelineExecutions).toHaveLength(1);
    expect(execucao(db, 0)).toEqual(estagiosEsperados(s1Pagina1(), 3));
  });

  it('2 · S1 tem EXATAMENTE paiId==null + arrayContains — e NENHUM termo publicado (#804)', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);

    await buscarFamiliasShopee(asDb(db), { ...ARGS, pageLimit: 3 });

    const where = estagio(db, 0, 1);
    expect(where).toEqual({ stage: 'where', args: [AND(...s1Termos())] });
    // The near-miss stated as data: a third term of ANY shape fails the equality
    // above, and this spells out the one a future "optimisation" would add.
    const comPublicado = AND(...s1Termos(), eq(f('publicado'), true));
    expect(where.args[0]).not.toEqual(comPublicado);
  });

  it('3 · um produto com publicado:false É descoberto e chega com publicado:false', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([{ anchorId: 'prod-1', publicado: false }]);

    const { rows } = await buscarFamiliasShopee(asDb(db), ARGS);

    expect(rows).toHaveLength(1);
    expect(naoNulo(rows[0], 'linha 0').anchor.publicado).toBe(false);
  });

  it('4 · S2 usa coalesce (não uma tolerância que deixa passar um campo AUSENTE)', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);

    await buscarFamiliasShopee(asDb(db), ARGS);

    expect(estagio(db, 0, 2)).toEqual({
      stage: 'define',
      args: [alias('anchorId', docId(f('__name__'))), kitKeysDef('anchorKitKeys')],
    });
  });

  it('5 · S3 define maxOwn e maxChildren — e NENHUM braço de componente (ADR 0014)', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);

    await buscarFamiliasShopee(asDb(db), ARGS);

    const addFields = estagio(db, 0, 3);
    expect(addFields.args).toHaveLength(2);
    expect(addFields).toEqual({
      stage: 'addFields',
      args: [alias('maxOwn', ownEstoqueMaxSub()), alias('maxChildren', maxChildrenSub())],
    });
    const nomes = (addFields.args as Array<{ name: string }>).map((a) => a.name);
    expect(nomes).toEqual(['maxOwn', 'maxChildren']);
  });

  it('6 · S4 compara coalesce(logicalMaximum(...), 0) com a janela', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);

    await buscarFamiliasShopee(asDb(db), ARGS);

    expect(estagio(db, 0, 4)).toEqual({
      stage: 'where',
      args: [gt(coal(logicalMax(f('maxOwn'), f('maxChildren')), 0), DESDE_MS)],
    });
  });

  it('7 · changedSinceMs -1 (force-all) sobrevive a QUALQUER âncora, inclusive sem estoque', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);

    await buscarFamiliasShopee(asDb(db), { ...ARGS, changedSinceMs: -1 });

    // `coalesce(..., 0) > -1` is true for a family with no estoque at all, which
    // is exactly what the reconciliação tier needs: it force-sends.
    expect(estagio(db, 0, 4)).toEqual({
      stage: 'where',
      args: [gt(coal(logicalMax(f('maxOwn'), f('maxChildren')), 0), -1)],
    });
  });

  it('8 · o termo de keyset aparece SÓ quando afterAnchorId é dado', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);
    await buscarFamiliasShopee(asDb(db), { ...ARGS, afterAnchorId: null, pageLimit: 2 });
    expect(estagio(db, 0, 1)).toEqual({ stage: 'where', args: [s1Pagina1()] });

    db.queuePipelinePage([]);
    await buscarFamiliasShopee(asDb(db), { ...ARGS, afterAnchorId: 'prod-9', pageLimit: 2 });
    expect(estagio(db, 1, 1)).toEqual({ stage: 'where', args: [s1Depois('prod-9')] });
  });

  it('9 · as DUAS sondas de link não carregam where algum (C-p)', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);

    await buscarFamiliasShopee(asDb(db), ARGS);

    const select = estagio(db, 0, 7);
    const links = (select.args as Array<{ name?: string; of?: { stages?: RecordedStage[] } }>).find(
      (a) => a.name === 'links',
    );
    const filhos = (
      select.args as Array<{ name?: string; of?: { stages?: RecordedStage[] } }>
    ).find((a) => a.name === 'children');
    expect(links?.of?.stages?.map((s) => s.stage)).toEqual(['subcollection', 'select']);

    const selectDoFilho = filhos?.of?.stages?.[3];
    const varLinks = (
      (selectDoFilho?.args ?? []) as Array<{ name?: string; of?: { stages?: RecordedStage[] } }>
    ).find((a) => a.name === 'varLinks');
    expect(varLinks?.of?.stages?.map((s) => s.stage)).toEqual(['subcollection', 'select']);
  });

  it('10 · a projeção S6 é exatamente esta lista de campos, nesta ordem', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);

    await buscarFamiliasShopee(asDb(db), ARGS);

    const select = estagio(db, 0, 7);
    const nomes = (select.args as Array<string | { name?: string }>).map((a) =>
      typeof a === 'string' ? a : (a.name ?? '?'),
    );
    expect(nomes).toEqual([
      'anchorId',
      'ehKit',
      'ehKitVirtual',
      'publicado',
      'componentesKit',
      'integracoesComProduto',
      'timestamp',
      'estoque',
      'componentEstoques',
      'links',
      'children',
    ]);
  });

  it('11 · o link do MODELO projeta produtoShopeeOuterRef — dois prodshopee não trocam modelos', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);

    await buscarFamiliasShopee(asDb(db), ARGS);

    const select = estagio(db, 0, 7);
    const filhos = (
      select.args as Array<{ name?: string; of?: { stages?: RecordedStage[] } }>
    ).find((a) => a.name === 'children');
    const selectDoFilho = filhos?.of?.stages?.[3];
    const varLinks = (
      (selectDoFilho?.args ?? []) as Array<{ name?: string; of?: { stages?: RecordedStage[] } }>
    ).find((a) => a.name === 'varLinks');
    expect(varLinks?.of?.stages?.[1]).toEqual({
      stage: 'select',
      args: [
        'contaVariacaoShopeeOuterRef',
        'produtoShopeeOuterRef',
        'model_id',
        'tier_index',
        'model_status',
        'modeloAusenteEm',
        alias('varLinkDocId', docId(f('__name__'))),
      ],
    });
  });

  it('12 · varLinks é projetado para TODO filho — nunca uma lista ausente (para o planner)', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);

    await buscarFamiliasShopee(asDb(db), ARGS);

    const select = estagio(db, 0, 7);
    const filhos = (
      select.args as Array<{ name?: string; of?: { stages?: RecordedStage[] } }>
    ).find((a) => a.name === 'children');
    const nomes = ((filhos?.of?.stages?.[3]?.args ?? []) as Array<string | { name?: string }>).map(
      (a) => (typeof a === 'string' ? a : (a.name ?? '?')),
    );
    expect(nomes).toContain('varLinks');
    // `sem-modelos` vs the no-model `model_id: 0` write is a DATA distinction the
    // planner cannot make if this projection ever goes missing — it would read an
    // absent list as "this listing has no models" and write the simple-item shape.
    expect(nomes).toEqual([
      'childId',
      'ehKit',
      'ehKitVirtual',
      'publicado',
      'componentesKit',
      'timestamp',
      'estoque',
      'componentEstoques',
      'varLinks',
    ]);
  });

  it('13 · PAR: as duas codificações de depositoOuterRef são O MESMO depósito', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);

    await buscarFamiliasShopee(asDb(db), ARGS);

    const select = estagio(db, 0, 7);
    const estoque = (select.args as Array<{ name?: string; of?: { stages?: RecordedStage[] } }>)
      .find((a) => a.name === 'estoque')
      ?.of?.stages?.find((s) => s.stage === 'where');
    expect(estoque?.args[0]).toEqual(depOr);
  });

  it('14 · QUASE-IGUAL: outro id de depósito produz outro predicado, não o mesmo', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);

    await buscarFamiliasShopee(asDb(db), { ...ARGS, depositoId: 'dep-2' });

    const select = estagio(db, 0, 7);
    const estoque = (select.args as Array<{ name?: string; of?: { stages?: RecordedStage[] } }>)
      .find((a) => a.name === 'estoque')
      ?.of?.stages?.find((s) => s.stage === 'where');
    expect(estoque?.args[0]).not.toEqual(depOr);
    expect(estoque?.args[0]).toEqual(
      OR(
        eq(f('depositoOuterRef'), 'documents/depositos/dep-2'),
        eq(f('depositoOuterRef'), 'depositos/dep-2'),
      ),
    );
  });
});

describe('buscarFamiliasShopee — paginação e mapeamento', () => {
  it('15 · página CHEIA devolve o último anchorId como cursor; página curta devolve null', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([{ anchorId: 'a' }, { anchorId: 'b' }]);
    const cheia = await buscarFamiliasShopee(asDb(db), { ...ARGS, pageLimit: 2 });
    expect(cheia.nextAfterAnchorId).toBe('b');

    db.queuePipelinePage([{ anchorId: 'a' }]);
    const curta = await buscarFamiliasShopee(asDb(db), { ...ARGS, pageLimit: 2 });
    expect(curta.nextAfterAnchorId).toBeNull();
  });

  it('16 · o tamanho de página padrão vem de anchorPageLimit(), lido PREGUIÇOSAMENTE', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);
    await buscarFamiliasShopee(asDb(db), ARGS);
    expect(estagio(db, 0, 6)).toEqual({ stage: 'limit', args: [anchorPageLimit()] });

    process.env[PAGE_LIMIT_ENV] = '7';
    db.queuePipelinePage([]);
    await buscarFamiliasShopee(asDb(db), ARGS);
    expect(estagio(db, 1, 6)).toEqual({ stage: 'limit', args: [7] });
  });

  it('17 · mapeia a linha projetada: membros coagidos, filhos ordenados, lixo filtrado', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([
      {
        anchorId: 'prod-1',
        ehKit: true,
        ehKitVirtual: 'sim',
        publicado: true,
        componentesKit: { 'comp-1': { quantidade: 2 } },
        integracoesComProduto: [CONTA, 42, 'int-2'],
        timestamp: 1_700_000_000_000,
        estoque: { estoqueDocId: 'e1', quantidade: 9, quantidadeReservada: 1 },
        componentEstoques: [{ parentId: 'comp-1', quantidade: 4 }, 'lixo', null],
        links: [{ linkDocId: 'l1', item_id: 2500139861 }, 7, ['x']],
        children: [
          { childId: 'prod-z', varLinks: [{ model_id: 2000458802, varLinkDocId: 'v1' }, null] },
          { childId: 'prod-a', varLinks: 'nao-e-lista' },
          { childId: '', varLinks: [] },
          'nao-e-objeto',
        ],
      },
    ]);

    const { rows } = await buscarFamiliasShopee(asDb(db), ARGS);

    expect(rows).toHaveLength(1);
    const linha = naoNulo(rows[0], 'linha 0');
    expect(linha.anchorId).toBe('prod-1');
    expect(linha.anchor.ehKit).toBe(true);
    // Coerced with `=== true`: a truthy STRING is not a boolean true.
    expect(linha.anchor.ehKitVirtual).toBe(false);
    expect(linha.anchor.timestampMs).toBe(1_700_000_000_000);
    expect(linha.anchor.estoque).toEqual({
      estoqueDocId: 'e1',
      quantidade: 9,
      quantidadeReservada: 1,
    });
    expect(linha.anchor.componentEstoques).toEqual([{ parentId: 'comp-1', quantidade: 4 }]);
    expect(linha.integracoesComProduto).toEqual([CONTA, 'int-2']);
    expect(linha.links).toEqual([{ linkDocId: 'l1', item_id: 2500139861 }]);
    // Children sorted by produtoId (output determinism); the id-less one is gone.
    expect(linha.children.map((c) => c.produtoId)).toEqual(['prod-a', 'prod-z']);
    expect(naoNulo(linha.children[0], 'filho 0').varLinks).toEqual([]);
    expect(naoNulo(linha.children[1], 'filho 1').varLinks).toEqual([
      { model_id: 2000458802, varLinkDocId: 'v1' },
    ]);
  });

  it('18 · uma linha sem anchorId legível é descartada, não derruba a página', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([
      { anchorId: '' },
      null,
      { anchorId: 'prod-1' },
      { naoTem: true },
    ] as unknown as Record<string, unknown>[]);

    const { rows } = await buscarFamiliasShopee(asDb(db), ARGS);

    expect(rows.map((r) => r.anchorId)).toEqual(['prod-1']);
  });

  it('19 · campos ausentes leem como o valor neutro (publicado false, estoque null)', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([{ anchorId: 'prod-1' }]);

    const { rows } = await buscarFamiliasShopee(asDb(db), ARGS);

    const linha = naoNulo(rows[0], 'linha 0');
    expect(linha.anchor).toEqual({
      produtoId: 'prod-1',
      ehKit: false,
      ehKitVirtual: false,
      publicado: false,
      componentesKit: null,
      timestampMs: null,
      estoque: null,
      componentEstoques: [],
    });
    expect(linha.links).toEqual([]);
    expect(linha.children).toEqual([]);
    expect(linha.integracoesComProduto).toEqual([]);
  });
});

describe('buscarFamiliasShopeePorIds — o empurrão manual', () => {
  it('20 · usa documents() como estágio FONTE, com a MESMA projeção S6 e sem janela', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([{ anchorId: 'prod-1' }]);

    await buscarFamiliasShopeePorIds(asDb(db), {
      integracaoId: CONTA,
      depositoId: DEPOSITO_ID,
      produtoIds: ['prod-1', 'prod-2'],
    });

    expect(db.pipelineExecutions).toHaveLength(1);
    expect(execucao(db, 0)).toEqual([
      { stage: 'documents', args: [['produtos/prod-1', 'produtos/prod-2']] },
      {
        stage: 'define',
        args: [alias('anchorId', docId(f('__name__'))), kitKeysDef('anchorKitKeys')],
      },
      { stage: 'sort', args: [asc('__name__')] },
      { stage: 'select', args: projecaoS6() },
    ]);
  });

  it('21 · NENHUM termo de âncora e NENHUM addFields — é força-envio por definição', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);

    await buscarFamiliasShopeePorIds(asDb(db), {
      integracaoId: CONTA,
      depositoId: DEPOSITO_ID,
      produtoIds: ['prod-1'],
    });

    const estagios = execucao(db, 0).map((s) => s.stage);
    expect(estagios).not.toContain('addFields');
    expect(estagios).not.toContain('where');
    expect(estagios).not.toContain('collection');
  });

  it('22 · DEDUPLICA os ids — documents() exige uma lista sem repetição', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);

    await buscarFamiliasShopeePorIds(asDb(db), {
      integracaoId: CONTA,
      depositoId: DEPOSITO_ID,
      produtoIds: ['prod-1', 'prod-2', 'prod-1'],
    });

    expect(estagio(db, 0, 0)).toEqual({
      stage: 'documents',
      args: [['produtos/prod-1', 'produtos/prod-2']],
    });
  });

  it('23 · RECUSA uma lista vazia em vez de deixar uma fonte de coleção varrer tudo', async () => {
    const db = new FakeDb();

    await expect(
      buscarFamiliasShopeePorIds(asDb(db), {
        integracaoId: CONTA,
        depositoId: DEPOSITO_ID,
        produtoIds: [],
      }),
    ).rejects.toThrow('produtoIds vazio');
    expect(db.pipelineExecutions).toHaveLength(0);
  });

  it('24 · um documento inexistente simplesmente não volta — a linha some, sem erro', async () => {
    // `documents()` silently omits a missing document; the caller reports the
    // requested anchor that came back with no row.
    const db = new FakeDb();
    db.queuePipelinePage([{ anchorId: 'prod-1' }]);

    const rows = await buscarFamiliasShopeePorIds(asDb(db), {
      integracaoId: CONTA,
      depositoId: DEPOSITO_ID,
      produtoIds: ['prod-1', 'prod-sumido'],
    });

    expect(rows.map((r) => r.anchorId)).toEqual(['prod-1']);
  });
});

describe('buscarMovimentosDaJanela — a pré-passagem do ledger', () => {
  const ARGS_MOV = { desdeMs: DESDE_MS, depositoId: DEPOSITO_ID };
  const DEP_REF = `documents/depositos/${DEPOSITO_ID}`;

  it('25 · UMA execução: where → aggregate agrupado, com o contador de falha-aberta', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([{ parentId: 'prod-1', depositoOuterRef: DEP_REF, dq: -2, dr: 0 }]);

    await buscarMovimentosDaJanela(asDb(db), ARGS_MOV);

    expect(db.pipelineExecutions).toHaveLength(1);
    expect(execucao(db, 0)).toEqual([
      { stage: 'collectionGroup', args: ['historicoEstoque'] },
      { stage: 'where', args: [AND(gte(f('timestamp'), DESDE_MS), depOr)] },
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

  it('26 · PAR: os dois grupos de UM mesmo par são ACUMULADOS, nunca sobrescritos', async () => {
    // The filter accepts both encodings but the aggregate groups on the RAW
    // value, so one pair can come back as two groups. A `set` would drop
    // whichever arrived first and reconstruct a confidently wrong `anterior`.
    const db = new FakeDb();
    db.queuePipelinePage([
      { parentId: 'prod-1', depositoOuterRef: DEP_REF, dq: -2, dr: 1, nDesconhecido: 0 },
      {
        parentId: 'prod-1',
        depositoOuterRef: `depositos/${DEPOSITO_ID}`,
        dq: -5,
        dr: 2,
        nDesconhecido: 0,
      },
    ]);

    const movimentos = await buscarMovimentosDaJanela(asDb(db), ARGS_MOV);

    expect(movimentos.size).toBe(1);
    expect(movimentos.get(chaveMovimento('prod-1', DEPOSITO_ID))).toEqual({
      dq: -7,
      dr: 3,
      desconhecido: false,
    });
  });

  it('27 · QUASE-IGUAL: dois produtos DIFERENTES no mesmo depósito ficam separados', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([
      { parentId: 'prod-1', depositoOuterRef: DEP_REF, dq: -2, dr: 1, nDesconhecido: 0 },
      {
        parentId: 'prod-2',
        depositoOuterRef: `depositos/${DEPOSITO_ID}`,
        dq: -5,
        dr: 2,
        nDesconhecido: 0,
      },
    ]);

    const movimentos = await buscarMovimentosDaJanela(asDb(db), ARGS_MOV);

    expect(movimentos.size).toBe(2);
    expect(movimentos.get(chaveMovimento('prod-1', DEPOSITO_ID))?.dq).toBe(-2);
    expect(movimentos.get(chaveMovimento('prod-2', DEPOSITO_ID))?.dq).toBe(-5);
  });

  it('28 · nDesconhecido > 0 marca o par como desconhecido — mesmo chegando ANTES do grupo legível', async () => {
    // ⚠️ The ORDER is the whole test. The unknown group arrives FIRST and a
    // readable one follows, so a reducer that SETS instead of OR-ing loses the
    // flag — and a lost flag is the fail-CLOSED direction: the pair would read
    // as a known movement, `anterior` would be reconstructed from a sum that
    // silently skipped rows, and the policy would SKIP a real change. Shopee's
    // aggregate documents no group ordering, so both arrival orders are live.
    const db = new FakeDb();
    db.queuePipelinePage([
      { parentId: 'prod-1', depositoOuterRef: DEP_REF, dq: 0, dr: 0, nDesconhecido: 4 },
      {
        parentId: 'prod-1',
        depositoOuterRef: `depositos/${DEPOSITO_ID}`,
        dq: -2,
        dr: 0,
        nDesconhecido: 0,
      },
      { parentId: 'prod-2', depositoOuterRef: DEP_REF, dq: -4, dr: 0, nDesconhecido: 0 },
    ]);

    const movimentos = await buscarMovimentosDaJanela(asDb(db), ARGS_MOV);

    expect(movimentos.get(chaveMovimento('prod-1', DEPOSITO_ID))?.desconhecido).toBe(true);
    expect(movimentos.get(chaveMovimento('prod-2', DEPOSITO_ID))?.desconhecido).toBe(false);
  });

  it('29 · a chave é o depósito do ARGUMENTO, então qualquer codificação guardada mapeia igual', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([
      { parentId: 'prod-1', depositoOuterRef: `depositos/${DEPOSITO_ID}`, dq: 3, dr: 0 },
    ]);

    const movimentos = await buscarMovimentosDaJanela(asDb(db), ARGS_MOV);

    expect(movimentos.get(chaveMovimento('prod-1', DEPOSITO_ID))).toEqual({
      dq: 3,
      dr: 0,
      desconhecido: false,
    });
  });

  it('30 · linhas sem parentId usável somem, e somas ilegíveis leem 0 (nunca NaN)', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([
      { parentId: null, depositoOuterRef: DEP_REF, dq: 9, dr: 9 },
      { parentId: '', depositoOuterRef: DEP_REF, dq: 9, dr: 9 },
      'nao-e-objeto',
      { parentId: 'prod-1', depositoOuterRef: DEP_REF, dq: 'x', dr: undefined },
    ] as unknown as Record<string, unknown>[]);

    const movimentos = await buscarMovimentosDaJanela(asDb(db), ARGS_MOV);

    expect(movimentos.size).toBe(1);
    expect(movimentos.get(chaveMovimento('prod-1', DEPOSITO_ID))).toEqual({
      dq: 0,
      dr: 0,
      desconhecido: false,
    });
  });

  it('31 · uma janela sem movimento devolve um mapa vazio (nada mudou)', async () => {
    const db = new FakeDb();
    db.queuePipelinePage([]);
    expect((await buscarMovimentosDaJanela(asDb(db), ARGS_MOV)).size).toBe(0);
  });

  it('32 · o predicado de depósito do ledger é O MESMO objeto de predicado do join', async () => {
    // The template declares this disjunction TWICE — once in the joins, once in
    // the ledger — and asserts in a comment that the two agree. This is that
    // claim as a structural fact instead: both call sites are compared against
    // each other, so a change to one that is not a change to the other reds
    // here. The failure it prevents is silent and fails CLOSED: a bare-form
    // `depositoOuterRef` stops matching ONE reader, the window then sees no
    // movement for that pair, and the send policy skips a real change.
    const db = new FakeDb();
    db.queuePipelinePage([]);
    await buscarFamiliasShopee(asDb(db), ARGS);
    db.queuePipelinePage([]);
    await buscarMovimentosDaJanela(asDb(db), ARGS_MOV);

    const doJoin = (
      estagio(db, 0, 7).args as Array<{ name?: string; of?: { stages?: RecordedStage[] } }>
    )
      .find((a) => a.name === 'estoque')
      ?.of?.stages?.find((s) => s.stage === 'where')?.args[0];
    const doLedger = (estagio(db, 1, 1).args[0] as { xs: unknown[] }).xs[1];

    expect(doJoin).toEqual(doLedger);
    // …and it really is the shared fold, not two independently-correct copies
    // that happen to agree on THIS depósito id.
    expect(doJoin).toEqual(depOr);
  });
});
