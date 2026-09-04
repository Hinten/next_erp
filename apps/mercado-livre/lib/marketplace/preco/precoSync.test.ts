import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  MercadoLivreReauthRequiredError,
  estadoFromMlStatus,
} from '@delfrance/integrations-mercado-livre';
import {
  type EnvioPrecoFilaItem,
  type EnvioPrecoSkip,
  RELATORIO_ENVIO_PRECO_SHARD_SIZE,
} from '@delfrance/schemas';

import {
  type PrecoFamilyRow,
  buildPrecoDrafts,
  podeEnviarPreco,
  precoItemsPerDispatch,
  precoPageLimit,
  precoRatePauseMin,
} from './precoPlan';
// NOT part of the `./precoPlan` module mock above — the reconciliation phase
// lives in its own module precisely because that mock is wholesale.
import { PRECO_RECON_MAX_PAGES, type PrecoReconPage } from './precoReconciliacao';
import {
  PRICE_SYNC_MAX_ATTEMPTS,
  PRICE_SYNC_STALE_RUNNING_MS,
  PriceSyncAlreadyRunningError,
  type PriceSyncApi,
  type PriceSyncRunDeps,
  cancelPriceSyncJob,
  finalizePriceSyncJob,
  processPriceSyncJob,
  startPriceSyncJob,
} from './precoSync';

// precoPlan is module-mocked to the PR-C contract: this suite pins precoSync's
// ORCHESTRATION (plan/drain/pause/complete + the per-item gate wiring), while
// precoPlan.test.ts pins the real planner/gate semantics behind these names.
vi.mock('./precoPlan', () => ({
  PRICE_SYNC_SKIPS_CAP: 200,
  PRICE_SYNC_FAILURES_CAP: 100,
  PRICE_SYNC_MAX_PAUSES: 50,
  PLAN_PAGE_DRAFTS_CAP: 2000,
  fetchPrecoPage: vi.fn(),
  buildPrecoDrafts: vi.fn(),
  podeEnviarPreco: vi.fn(),
  precoPageLimit: vi.fn(),
  precoItemsPerDispatch: vi.fn(),
  precoRatePauseMin: vi.fn(),
}));

/* ------------------------------ fake Firestore ---------------------------- */
// Adapted from massImport.test.ts's FakeDb, trimmed to this suite's surface:
// equality `where` chains (the one-running-job guard), doc get/set-merge (the
// job checkpoints + link writebacks) and `add` (startPriceSyncJob's auto-id).

type DocData = Record<string, unknown>;

/** A plain `{}` — not an array, not a Date/Timestamp, not null. */
function isPlainObject(v: unknown): v is DocData {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && v.constructor === Object;
}

/**
 * ⚠️ Firestore's `{merge: true}` DEEP-merges map fields — a nested `{linhas: {k: row}}`
 * adds the key and keeps the ones already stored. A shallow spread (what this
 * fake did) would REPLACE `linhas` on every shard write, so each checkpoint
 * would drop every row before it and the specs would happily encode that.
 *
 * ⚠️ This models the behaviour; it does not prove it. `precoRelatorio.firestore.test.ts`
 * is what asserts the real thing against a real Firestore, because a fake can
 * only ever agree with whoever wrote it. Arrays REPLACE (Firestore does too).
 */
function mergeDeep(base: DocData, patch: DocData): DocData {
  const out: DocData = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const atual = out[k];
    out[k] = isPlainObject(v) && isPlainObject(atual) ? mergeDeep(atual, v) : v;
  }
  return out;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
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

  collection(path: string) {
    const col = this.col(path);
    const self = this;
    const query = () => {
      const clauses: Array<[string, unknown]> = [];
      let lim: number | null = null;
      const q = {
        where(field: string, _op: string, value: unknown) {
          clauses.push([field, value]);
          return q;
        },
        limit(n: number) {
          lim = n;
          return q;
        },
        async get() {
          let rows = [...col.entries()].filter(([, d]) => clauses.every(([f, v]) => d[f] === v));
          if (lim != null) rows = rows.slice(0, lim);
          return {
            docs: rows.map(([id, d]) => ({ id, data: () => d, exists: true })),
            empty: rows.length === 0,
          };
        },
      };
      return q;
    };
    return {
      doc: (id?: string) => {
        const docId = id ?? `auto-${++self.autoN}`;
        return {
          id: docId,
          get: async () => ({ exists: col.has(docId), id: docId, data: () => col.get(docId) }),
          set: async (data: DocData, opts?: { merge?: boolean }) => {
            col.set(docId, opts?.merge ? mergeDeep(col.get(docId) ?? {}, data) : { ...data });
          },
          // Backs `mergeIfExists` on the link writebacks. The missing-doc
          // failure MUST carry gRPC code 5 — that is what `isNotFound` narrows
          // on, and it is what keeps a deleted link from being resurrected as a
          // ghost holding only the writeback keys.
          update: async (data: DocData) => {
            if (!col.has(docId)) {
              throw Object.assign(new Error(`NOT_FOUND: ${path}/${docId}`), { code: 5 });
            }
            col.set(docId, { ...(col.get(docId) ?? {}), ...data });
          },
        };
      },
      add: async (data: DocData) => {
        const docId = `auto-${++self.autoN}`;
        col.set(docId, { ...data });
        return { id: docId };
      },
      where: (field: string, op: string, value: unknown) => query().where(field, op, value),
      limit: (n: number) => query().limit(n),
    };
  }

  /**
   * Enough of `WriteBatch` for the checkpoint, which now commits the job doc and
   * the report shards together.
   *
   * ⚠️ Ops are BUFFERED and applied only on `commit()`. That is what lets a spec
   * model a crash mid-dispatch — drop the batch without committing and neither
   * the rows nor the counter advanced, which is the property the whole
   * idempotency argument rests on.
   */
  batch() {
    const ops: Array<() => Promise<void>> = [];
    const b = {
      set(
        ref: { set: (d: DocData, o?: { merge?: boolean }) => Promise<void> },
        data: DocData,
        opts?: { merge?: boolean },
      ) {
        ops.push(() => ref.set(data, opts));
        return b;
      },
      async commit() {
        for (const op of ops) await op();
      },
    };
    return b;
  }

  /**
   * Enough of `runTransaction` for `finalizePriceSyncJob` — a PASS-THROUGH, as
   * in `massImport.test.ts`'s FakeDb: `tx.get`/`tx.set` delegate straight to the
   * ref, with no OCC and no retry.
   *
   * ⚠️ So the race specs below prove the guard's LOGIC — that the decision is
   * re-derived from a read taken inside the callback, and that the loser becomes
   * a no-op — and NOT that Firestore's OCC would abort and retry. Reading a
   * green run here as evidence about real contention is the mistake; what makes
   * the logic sufficient is that the read and the write are in one transaction,
   * which only a real Firestore can demonstrate.
   */
  async runTransaction<T>(
    fn: (tx: {
      get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
      set: (
        ref: { set: (d: DocData, o?: { merge?: boolean }) => Promise<void> },
        data: DocData,
        opts?: { merge?: boolean },
      ) => void;
    }) => Promise<T>,
  ): Promise<T> {
    const pendentes: Array<() => Promise<void>> = [];
    const resultado = await fn({
      get: (ref) => ref.get(),
      set: (ref, data, opts) => {
        pendentes.push(() => ref.set(data, opts));
      },
    });
    for (const op of pendentes) await op();
    return resultado;
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/**
 * A skip in the shape the job now records it. `linkDocId` names WHICH link
 * produced it (two links can yield the same produto+code) and `precoAnterior` is
 * null wherever no ML call was made — every plan-time and reconciliation skip.
 */
function skipFixture(e: {
  produtoId: string;
  code: string;
  itemId?: string | null;
  linkDocId?: string | null;
  precoAnterior?: number | null;
}): EnvioPrecoSkip {
  return {
    itemId: e.itemId ?? null,
    produtoId: e.produtoId,
    code: e.code,
    linkDocId: e.linkDocId ?? null,
    precoAnterior: e.precoAnterior ?? null,
  };
}

/* --------------------------------- fixtures ------------------------------- */

const CLOCK_NOW = 1_700_000_000_000;
const CONTA = 'conta-A';
const JOBS_PATH = 'enviosPrecoMercadoLivre';
const TAB_REF = 'documents/tabelasDePrecos/tabNormal';

const linkPath = (produtoId: string) => `produtos/${produtoId}/produtoMercadoLivre`;

/**
 * Seed the writeback-target link doc for `draft(itemId)`'s conventions. The
 * writebacks go through `mergeIfExists`, so an unseeded target is a no-op by
 * design (a link deleted mid-job is never resurrected) — a spec that asserts a
 * writeback must therefore seed the doc it expects to be updated.
 */
function seedLink(db: FakeDb, itemId: string, data: DocData = {}): void {
  db.seed(linkPath(`prod-${itemId}`), `lnk-${itemId}`, { estado: 'p', ...data });
}

function draft(itemId: string, over: Partial<EnvioPrecoFilaItem> = {}): EnvioPrecoFilaItem {
  return {
    kind: 'item',
    itemId,
    produtoId: `prod-${itemId}`,
    variacaoProdutoId: null,
    linkDocId: `lnk-${itemId}`,
    preco: 50,
    ...over,
  };
}

/** A fresh `GET /items/{id}` fixture — active, currently priced 40 (send-worthy vs preco 50). */
function mlItem(id: string, over: DocData = {}): DocData {
  return {
    id,
    price: 40,
    base_price: 40,
    status: 'active',
    sub_status: [],
    tags: [],
    variations: null,
    ...over,
  };
}

function makeApi(items: Record<string, DocData> = {}) {
  return {
    getItem: vi.fn(async (id: string): Promise<DocData> => {
      const it = items[id];
      if (!it) throw new MercadoLivreHttpError(`item não encontrado: ${id}`, 404, null);
      return it;
    }),
    // Happy-path echo: the fresh item with the PUT's price(s) applied.
    updateItem: vi.fn(async (id: string, body: Record<string, unknown>): Promise<DocData> => {
      const it = items[id] ?? mlItem(id);
      if (Array.isArray(body.variations)) {
        const vars = body.variations as Array<Record<string, unknown>>;
        return { ...it, variations: vars.map((v) => ({ ...v })) };
      }
      if (typeof body.price === 'number') {
        return { ...it, price: body.price, base_price: body.price };
      }
      return it;
    }),
  };
}

function runDeps(
  db: FakeDb,
  api: ReturnType<typeof makeApi>,
  over: Partial<PriceSyncRunDeps> = {},
): PriceSyncRunDeps {
  return {
    db: asDb(db),
    scheduler: { enqueue: vi.fn(async () => {}) },
    resolveContext: async () => ({
      api: api as unknown as PriceSyncApi,
      tabelaNormalOuterRef: TAB_REF,
    }),
    fetchPage: vi.fn(async () => ({ rows: [], nextAfterAnchorId: null })),
    // Stubbed by default so a test that flips the reconciliation flag can never
    // reach the real collection-group walk — this FakeDb has no
    // `collectionGroup`, so that would fail for the wrong reason.
    fetchReconPage: vi.fn(async () => ({
      naoEnumerados: [],
      inspecionados: 0,
      nextAfterLinkPath: null,
    })),
    now: () => CLOCK_NOW,
    ...over,
  };
}

function seedJob(db: FakeDb, jobId: string, patch: DocData = {}): void {
  db.seed(JOBS_PATH, jobId, {
    integracaoId: CONTA,
    status: 'running',
    baixarPreco: false,
    startedBy: 'user-1',
    fila: [],
    afterAnchorId: null,
    planejamentoConcluido: false,
    planejados: 0,
    enviados: 0,
    pulados: 0,
    falhas: 0,
    pausas: 0,
    skips: [],
    failures: [],
    startedAt: CLOCK_NOW - 1000,
    updatedAt: CLOCK_NOW - 1000,
    finishedAt: null,
    erro: null,
    ...patch,
  });
}

/** The PR-C contract mapping `podeEnviarPreco` implements (pinned in precoPlan.test.ts). */
const contractPodeEnviarPreco = (
  status: string | null | undefined,
  subStatus: readonly string[] | null | undefined,
): { ok: true } | { ok: false; code: string } => {
  if (status === 'active' || status === 'paused') return { ok: true };
  if (status === 'under_review') {
    return (subStatus ?? []).includes('forbidden')
      ? { ok: false, code: 'FORBIDDEN' }
      : { ok: true };
  }
  if (status === 'closed') return { ok: false, code: 'CLOSED' };
  if (status == null || status === '') return { ok: false, code: 'STATUS_desconhecido' };
  return { ok: false, code: `STATUS_${status}` };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(precoPageLimit).mockReturnValue(25);
  vi.mocked(precoItemsPerDispatch).mockReturnValue(10);
  vi.mocked(precoRatePauseMin).mockReturnValue(5);
  vi.mocked(buildPrecoDrafts).mockReturnValue({ drafts: [], skips: [] });
  vi.mocked(podeEnviarPreco).mockImplementation(contractPodeEnviarPreco);
});

/* -------------------------------------------------------------------------- */

describe('startPriceSyncJob', () => {
  it('creates a fresh running job carrying the run flags', async () => {
    const db = new FakeDb();
    const { jobId } = await startPriceSyncJob(asDb(db), {
      integracaoId: CONTA,
      baixarPreco: true,
      startedBy: 'user-1',
    });

    expect(db.docs(JOBS_PATH).get(jobId)).toMatchObject({
      integracaoId: CONTA,
      status: 'running',
      baixarPreco: true,
      startedBy: 'user-1',
      fila: [],
    });
  });

  it('throws PriceSyncAlreadyRunningError while a job is running for the conta', async () => {
    const db = new FakeDb();
    await startPriceSyncJob(asDb(db), { integracaoId: CONTA, baixarPreco: false, startedBy: 'u' });

    await expect(
      startPriceSyncJob(asDb(db), { integracaoId: CONTA, baixarPreco: false, startedBy: 'u' }),
    ).rejects.toBeInstanceOf(PriceSyncAlreadyRunningError);
  });

  it('a running job checkpointed within the staleness bound still blocks', async () => {
    const db = new FakeDb();
    seedJob(db, 'fresh1', { updatedAt: Date.now() - 1000 });

    await expect(
      startPriceSyncJob(asDb(db), { integracaoId: CONTA, baixarPreco: false, startedBy: 'u' }),
    ).rejects.toBeInstanceOf(PriceSyncAlreadyRunningError);
    expect(db.docs(JOBS_PATH).get('fresh1')!.status).toBe('running'); // untouched
  });

  it('a STALE running job (updatedAt past PRICE_SYNC_STALE_RUNNING_MS) is stamped failed and the new job proceeds', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = new FakeDb();
    seedJob(db, 'orphan1', { updatedAt: Date.now() - PRICE_SYNC_STALE_RUNNING_MS - 1 });

    const { jobId } = await startPriceSyncJob(asDb(db), {
      integracaoId: CONTA,
      baixarPreco: false,
      startedBy: 'u',
    });

    expect(jobId).not.toBe('orphan1');
    expect(db.docs(JOBS_PATH).get('orphan1')).toMatchObject({
      status: 'failed',
      erro: 'job órfão — superado por um novo envio',
    });
    expect(typeof db.docs(JOBS_PATH).get('orphan1')!.finishedAt).toBe('number');
    expect(db.docs(JOBS_PATH).get(jobId)).toMatchObject({ status: 'running' });
    expect(warnSpy).not.toHaveBeenCalled(); // the stamp succeeded — nothing to tolerate
    warnSpy.mockRestore();
  });

  it('allows a new job once the previous one has completed', async () => {
    const db = new FakeDb();
    const first = await startPriceSyncJob(asDb(db), {
      integracaoId: CONTA,
      baixarPreco: false,
      startedBy: 'u',
    });
    db.docs(JOBS_PATH).set(first.jobId, {
      ...db.docs(JOBS_PATH).get(first.jobId)!,
      status: 'completed',
    });

    const second = await startPriceSyncJob(asDb(db), {
      integracaoId: CONTA,
      baixarPreco: false,
      startedBy: 'u',
    });
    expect(second.jobId).not.toBe(first.jobId);
  });

  it('does not block a running job for a DIFFERENT integração', async () => {
    const db = new FakeDb();
    await startPriceSyncJob(asDb(db), { integracaoId: CONTA, baixarPreco: false, startedBy: 'u' });
    const other = await startPriceSyncJob(asDb(db), {
      integracaoId: 'conta-B',
      baixarPreco: false,
      startedBy: 'u',
    });
    expect(db.docs(JOBS_PATH).get(other.jobId)).toMatchObject({ integracaoId: 'conta-B' });
  });
});

describe('processPriceSyncJob — plan phase', () => {
  it('plans one page: appends drafts, folds plan skips, advances the cursor, and drains in the SAME dispatch', async () => {
    const db = new FakeDb();
    seedJob(db, 'job1');
    seedLink(db, 'MLB1');
    const rowA = { anchorId: 'A' } as unknown as PrecoFamilyRow;
    const rowB = { anchorId: 'B' } as unknown as PrecoFamilyRow;
    vi.mocked(buildPrecoDrafts).mockImplementation((row) =>
      row === rowA
        ? { drafts: [draft('MLB1')], skips: [] }
        : {
            drafts: [],
            skips: [skipFixture({ produtoId: 'prod-X', code: 'PRECO_NAO_ENCONTRADO' })],
          },
    );
    const api = makeApi({ MLB1: mlItem('MLB1') });
    const deps = runDeps(db, api, {
      fetchPage: vi.fn(async () => ({ rows: [rowA, rowB], nextAfterAnchorId: 'anchor-2' })),
    });

    const outcome = await processPriceSyncJob(deps, { jobId: 'job1', integracaoId: CONTA }, 0);

    expect(outcome).toBe('continued'); // cursor non-null → planning not concluded
    expect(deps.fetchPage).toHaveBeenCalledWith(deps.db, {
      integracaoId: CONTA,
      afterAnchorId: null,
      pageLimit: 25,
    });
    expect(buildPrecoDrafts).toHaveBeenCalledWith(rowA, {
      integracaoId: CONTA,
      tabelaNormalId: 'tabNormal', // idFromRef(tabelaNormalOuterRef)
    });
    expect(deps.scheduler.enqueue).toHaveBeenCalledWith({ jobId: 'job1', integracaoId: CONTA });

    const job = db.docs(JOBS_PATH).get('job1')!;
    expect(job).toMatchObject({
      planejados: 1,
      pulados: 1,
      enviados: 1, // MLB1 drained in this same dispatch
      falhas: 0,
      afterAnchorId: 'anchor-2',
      planejamentoConcluido: false,
      fila: [],
      skips: [skipFixture({ produtoId: 'prod-X', code: 'PRECO_NAO_ENCONTRADO' })],
    });
    expect(db.docs(linkPath('prod-MLB1')).get('lnk-MLB1')).toMatchObject({
      precoPublicado: 50,
      estado: estadoFromMlStatus('active'),
      status: 'active',
      sub_status: [],
      ultimaModificacao: CLOCK_NOW,
    });
  });

  it('a null nextAfterAnchorId concludes planning and the same dispatch completes once everything drains', async () => {
    const db = new FakeDb();
    seedJob(db, 'job2');
    const rowA = { anchorId: 'A' } as unknown as PrecoFamilyRow;
    vi.mocked(buildPrecoDrafts).mockReturnValue({ drafts: [draft('MLB1')], skips: [] });
    const api = makeApi({ MLB1: mlItem('MLB1') });
    const deps = runDeps(db, api, {
      fetchPage: vi.fn(async () => ({ rows: [rowA], nextAfterAnchorId: null })),
    });

    const outcome = await processPriceSyncJob(deps, { jobId: 'job2', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    expect(db.docs(JOBS_PATH).get('job2')).toMatchObject({
      status: 'completed',
      planejamentoConcluido: true,
      afterAnchorId: null,
      enviados: 1,
      finishedAt: CLOCK_NOW,
    });
  });

  it('completes immediately when the conta has nothing to plan', async () => {
    const db = new FakeDb();
    seedJob(db, 'job3');
    const deps = runDeps(db, makeApi());

    const outcome = await processPriceSyncJob(deps, { jobId: 'job3', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    expect(buildPrecoDrafts).not.toHaveBeenCalled();
    expect(db.docs(JOBS_PATH).get('job3')).toMatchObject({ status: 'completed', enviados: 0 });
  });

  it('stops planning mid-page at PLAN_PAGE_DRAFTS_CAP: cursor parks on the last consumed anchor, nothing lost or duplicated', async () => {
    const db = new FakeDb();
    seedJob(db, 'jobCap1');
    const rowA = { produtoId: 'anchor-A' } as unknown as PrecoFamilyRow;
    const rowB = { produtoId: 'anchor-B' } as unknown as PrecoFamilyRow;
    const draftsA = Array.from({ length: 1500 }, (_, i) => draft(`A${i}`));
    const draftsB = Array.from({ length: 800 }, (_, i) => draft(`B${i}`));
    vi.mocked(buildPrecoDrafts).mockImplementation((row) =>
      row === rowA
        ? { drafts: draftsA, skips: [] }
        : { drafts: draftsB, skips: [skipFixture({ produtoId: 'anchor-B', code: 'SEM_LINK' })] },
    );
    vi.mocked(precoItemsPerDispatch).mockReturnValue(1);
    // Every GET already sees the target price → the drain is one cheap skip.
    const api = makeApi();
    api.getItem.mockImplementation(async (id: string) => mlItem(id, { base_price: 50, price: 50 }));
    const deps = runDeps(db, api, {
      fetchPage: vi.fn(async () => ({ rows: [rowA, rowB], nextAfterAnchorId: 'anchor-B' })),
    });

    const outcome = await processPriceSyncJob(deps, { jobId: 'jobCap1', integracaoId: CONTA }, 0);

    expect(outcome).toBe('continued');
    const job = db.docs(JOBS_PATH).get('jobCap1')!;
    // Row B was NOT consumed: neither its 800 drafts nor its skip landed, and
    // the cursor rewinds to the last CONSUMED anchor for a mid-page resume.
    expect(job.planejados).toBe(1500);
    expect(job.afterAnchorId).toBe('anchor-A');
    expect(job.planejamentoConcluido).toBe(false);
    // A SEND-time skip, so unlike a plan-time one it carries what the gate read
    // off the listing — the value the job used to compute and throw away.
    expect(job.skips).toEqual([
      skipFixture({
        itemId: 'A0',
        produtoId: 'prod-A0',
        code: 'PRECO_ANTIGO_IGUAL',
        linkDocId: 'lnk-A0',
        precoAnterior: 50,
      }),
    ]);
    const fila = job.fila as Array<{ itemId: string }>;
    expect(fila.length).toBe(1499); // 1500 planned − the 1 drained, none from B
    expect(fila.every((d) => d.itemId.startsWith('A'))).toBe(true);
  });

  it('resumes a mid-page stop from the parked cursor and plans the held-back row exactly once', async () => {
    const db = new FakeDb();
    seedJob(db, 'jobCap2', { afterAnchorId: 'anchor-A', planejados: 1500 });
    const rowB = { produtoId: 'anchor-B' } as unknown as PrecoFamilyRow;
    vi.mocked(buildPrecoDrafts).mockReturnValue({ drafts: [draft('B0')], skips: [] });
    const api = makeApi({ B0: mlItem('B0') });
    const deps = runDeps(db, api, {
      fetchPage: vi.fn(async () => ({ rows: [rowB], nextAfterAnchorId: null })),
    });

    const outcome = await processPriceSyncJob(deps, { jobId: 'jobCap2', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    expect(deps.fetchPage).toHaveBeenCalledWith(deps.db, {
      integracaoId: CONTA,
      afterAnchorId: 'anchor-A',
      pageLimit: 25,
    });
    expect(db.docs(JOBS_PATH).get('jobCap2')).toMatchObject({
      status: 'completed',
      planejamentoConcluido: true,
      planejados: 1501,
      enviados: 1,
    });
  });

  it('a FIRST family past the page cap still lands whole (MAX_DRAFTS_PER_FAMILY governs that)', async () => {
    const db = new FakeDb();
    seedJob(db, 'jobCap3');
    const rowBig = { produtoId: 'anchor-BIG' } as unknown as PrecoFamilyRow;
    const rowNext = { produtoId: 'anchor-NEXT' } as unknown as PrecoFamilyRow;
    vi.mocked(buildPrecoDrafts).mockImplementation((row) =>
      row === rowBig
        ? { drafts: Array.from({ length: 2200 }, (_, i) => draft(`G${i}`)), skips: [] }
        : { drafts: [draft('N0')], skips: [] },
    );
    vi.mocked(precoItemsPerDispatch).mockReturnValue(1);
    const api = makeApi();
    api.getItem.mockImplementation(async (id: string) => mlItem(id, { base_price: 50, price: 50 }));
    const deps = runDeps(db, api, {
      fetchPage: vi.fn(async () => ({ rows: [rowBig, rowNext], nextAfterAnchorId: null })),
    });

    const outcome = await processPriceSyncJob(deps, { jobId: 'jobCap3', integracaoId: CONTA }, 0);

    expect(outcome).toBe('continued');
    const job = db.docs(JOBS_PATH).get('jobCap3')!;
    expect(job.planejados).toBe(2200); // the over-cap family landed whole, NEXT held back
    expect(job.afterAnchorId).toBe('anchor-BIG');
    expect(job.planejamentoConcluido).toBe(false);
  });
});

describe('processPriceSyncJob — per-item gates', () => {
  it('walks every gate in one dispatch: equal / closed / forbidden skip, paused sends, decrease blocked', async () => {
    const db = new FakeDb();
    seedJob(db, 'job4', {
      planejamentoConcluido: true,
      fila: [draft('EQ'), draft('CLOSED'), draft('FORB'), draft('PAUSED'), draft('DOWN')],
    });
    const api = makeApi({
      EQ: mlItem('EQ', { base_price: 50, price: 50 }), // gate 2: already at 50
      CLOSED: mlItem('CLOSED', { status: 'closed' }), // gate 3
      FORB: mlItem('FORB', { status: 'under_review', sub_status: ['forbidden'] }), // gate 3
      PAUSED: mlItem('PAUSED', { status: 'paused' }), // paused is send-worthy
      DOWN: mlItem('DOWN', { base_price: 60, price: 60 }), // gate 4: 50 < 60
    });
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'job4', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    expect(api.updateItem).toHaveBeenCalledTimes(1);
    expect(api.updateItem).toHaveBeenCalledWith('PAUSED', { price: 50 });
    const job = db.docs(JOBS_PATH).get('job4')!;
    expect(job).toMatchObject({ status: 'completed', enviados: 1, pulados: 4, falhas: 0 });
    expect((job.skips as Array<{ code: string }>).map((s) => s.code)).toEqual([
      'PRECO_ANTIGO_IGUAL',
      'CLOSED',
      'FORBIDDEN',
      'PRECO_ANTIGO_MAIOR',
    ]);
  });

  it('baixarPreco allows the decrease the default run blocks', async () => {
    const db = new FakeDb();
    seedJob(db, 'job5', { planejamentoConcluido: true, baixarPreco: true, fila: [draft('DOWN')] });
    seedLink(db, 'DOWN');
    const api = makeApi({ DOWN: mlItem('DOWN', { base_price: 60, price: 60 }) });
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'job5', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    expect(api.updateItem).toHaveBeenCalledWith('DOWN', { price: 50 });
    expect(db.docs(JOBS_PATH).get('job5')).toMatchObject({ enviados: 1, pulados: 0 });
    expect(db.docs(linkPath('prod-DOWN')).get('lnk-DOWN')).toMatchObject({ precoPublicado: 50 });
  });

  it('gate 2 is variations-aware: ONE drifted variation price defeats the skip and gets the variations-body PUT', async () => {
    const db = new FakeDb();
    seedJob(db, 'jobDrift', { planejamentoConcluido: true, fila: [draft('DRIFT')] });
    const api = makeApi({
      DRIFT: mlItem('DRIFT', {
        base_price: 50, // item-level ALREADY equal — must not shortcut the skip
        price: 50,
        variations: [
          { id: 1, price: 50 },
          { id: 2, price: 49 }, // drifted — must be corrected
        ],
      }),
    });
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'jobDrift', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    expect(api.updateItem).toHaveBeenCalledWith('DRIFT', {
      variations: [
        { id: 1, price: 50 },
        { id: 2, price: 50 },
      ],
    });
    expect(db.docs(JOBS_PATH).get('jobDrift')).toMatchObject({ enviados: 1, pulados: 0 });
  });

  it('gate 2 skips an item draft only when EVERY fresh variation sits at the target price', async () => {
    const db = new FakeDb();
    seedJob(db, 'jobVarEq', { planejamentoConcluido: true, fila: [draft('VAREQ')] });
    const api = makeApi({
      VAREQ: mlItem('VAREQ', {
        base_price: 40, // item-level DIFFERS — the variations are authoritative
        price: 40,
        variations: [
          { id: 1, price: 50 },
          { id: 2, price: 50 },
        ],
      }),
    });
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'jobVarEq', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    expect(api.updateItem).not.toHaveBeenCalled();
    const job = db.docs(JOBS_PATH).get('jobVarEq')!;
    expect((job.skips as Array<{ code: string }>).map((s) => s.code)).toEqual([
      'PRECO_ANTIGO_IGUAL',
    ]);
  });

  it('a mid-migration tagged listing skips AGUARDANDO_MIGRACAO without a PUT', async () => {
    const db = new FakeDb();
    seedJob(db, 'job6', { planejamentoConcluido: true, fila: [draft('MIG')] });
    const api = makeApi({ MIG: mlItem('MIG', { tags: ['variations_migration_source'] }) });
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'job6', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    expect(api.updateItem).not.toHaveBeenCalled();
    const job = db.docs(JOBS_PATH).get('job6')!;
    expect((job.skips as Array<{ code: string }>).map((s) => s.code)).toEqual([
      'AGUARDANDO_MIGRACAO',
    ]);
  });
});

describe('processPriceSyncJob — body shapes', () => {
  it('a legacy variations listing PUTs a per-variation price-only body built from FRESH ids', async () => {
    const db = new FakeDb();
    seedJob(db, 'job7', { planejamentoConcluido: true, fila: [draft('VAR')] });
    const api = makeApi({
      VAR: mlItem('VAR', {
        variations: [
          { id: 111, price: 40 },
          { id: 222, price: 40 },
          { id: null, price: 40 }, // id-less entry must be dropped, never sent
        ],
      }),
    });
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'job7', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    expect(api.updateItem).toHaveBeenCalledWith('VAR', {
      variations: [
        { id: 111, price: 50 },
        { id: 222, price: 50 },
      ],
    });
    expect(db.docs(JOBS_PATH).get('job7')).toMatchObject({ enviados: 1, falhas: 0 });
  });

  /**
   * ⚠️ #1252 CHANGED what this asserts, and the old expectation was the bug.
   *
   * It used to require the writeback to "carry status fields only, never
   * `precoPublicado`". The `precoPublicado` half was right and still holds. The
   * status half was not: `resp` describes ONE MEMBER (`draft.itemId` is the
   * member's own MLB item) while `draft.linkDocId` names the FAMILY's parent
   * link, so stamping it published one member's lifecycle as the family's.
   *
   * That is the same over-reach `estoqueSend.ts` guards with `ehMembro`, and the
   * consequence is not confined to price: `estado` feeds `linkHasLiveListing` →
   * `integracoesComProduto`, the anchor pre-filter BOTH sweeps open with, so one
   * member coming back `paused` on an otherwise accepted PUT could silently drop
   * a produto whose siblings were still selling.
   *
   * A member send now writes `ultimaModificacao` and nothing else.
   */
  it('a variationItem draft PUTs price-only AND writes no family state at all', async () => {
    const db = new FakeDb();
    seedJob(db, 'job8', {
      planejamentoConcluido: true,
      fila: [draft('UPV', { kind: 'variationItem', variacaoProdutoId: 'child-1' })],
    });
    // Seeded `paused` on purpose: ML answers `active` for the member below, so a
    // writeback that leaked the member's status would visibly overwrite this.
    seedLink(db, 'UPV', { estado: 'pa', status: 'paused', sub_status: ['x'] });
    const api = makeApi({ UPV: mlItem('UPV') });
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'job8', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    expect(api.updateItem).toHaveBeenCalledWith('UPV', { price: 50 });

    // ⚠️ Exact match, not `toMatchObject`: the claim is the ABSENCE of keys, and
    // a partial match would pass with every one of them written.
    expect(db.docs(linkPath('prod-UPV')).get('lnk-UPV')).toEqual({
      estado: 'pa',
      status: 'paused',
      sub_status: ['x'],
      ultimaModificacao: CLOCK_NOW,
    });
  });

  /**
   * #1252. The parent-draft half of the same rule: an `item` draft DOES own the
   * family's state, so it writes the status pair — and, with it, ML's verdict on
   * moderation, read off the response it already holds.
   */
  it("an 'item' draft clears a moderação ML has stopped reporting", async () => {
    const db = new FakeDb();
    seedJob(db, 'job8c', { planejamentoConcluido: true, fila: [draft('PLAIN')] });
    seedLink(db, 'PLAIN', { moderacoes: [{ nome: 'WATERMARK', motivo: "Marca d'água" }] });
    const api = makeApi({ PLAIN: mlItem('PLAIN') });

    await processPriceSyncJob(runDeps(db, api), { jobId: 'job8c', integracaoId: CONTA }, 0);

    // One object carrying both — the reason and the status it explains move in
    // the same patch, so asserting them apart would pass on a writer that split
    // them.
    expect(db.docs(linkPath('prod-PLAIN')).get('lnk-PLAIN')).toMatchObject({
      status: 'active',
      moderacoes: [],
    });
  });

  /**
   * ⚠️ The case the clear must not swallow. `poor_quality_thumbnail` leaves the
   * listing `active`, so the price send succeeds while the moderation is still
   * in force — and the gate matches that sub_status, so the key is omitted and
   * the stored reason survives.
   */
  it("an 'item' draft leaves a moderação ML is still reporting", async () => {
    const moderacao = { nome: 'WATERMARK', motivo: "Marca d'água" };
    const db = new FakeDb();
    seedJob(db, 'job8d', { planejamentoConcluido: true, fila: [draft('PLAIN')] });
    seedLink(db, 'PLAIN', { moderacoes: [moderacao] });
    const api = makeApi({
      PLAIN: mlItem('PLAIN', { sub_status: ['poor_quality_thumbnail'] }),
    });

    await processPriceSyncJob(runDeps(db, api), { jobId: 'job8d', integracaoId: CONTA }, 0);

    expect(db.docs(linkPath('prod-PLAIN')).get('lnk-PLAIN')).toMatchObject({
      sub_status: ['poor_quality_thumbnail'],
      moderacoes: [moderacao],
    });
  });

  it("an 'item' draft's success writeback DOES carry precoPublicado", async () => {
    const db = new FakeDb();
    seedJob(db, 'job8b', { planejamentoConcluido: true, fila: [draft('PLAIN')] });
    seedLink(db, 'PLAIN');
    const api = makeApi({ PLAIN: mlItem('PLAIN') });
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'job8b', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    expect(db.docs(linkPath('prod-PLAIN')).get('lnk-PLAIN')).toMatchObject({
      precoPublicado: 50,
      status: 'active',
      ultimaModificacao: CLOCK_NOW,
    });
  });
});

describe('processPriceSyncJob — PUT dispositions', () => {
  it('item.price.not_modifiable → terminal skip, NO link stamp, and the job continues', async () => {
    const db = new FakeDb();
    seedJob(db, 'job9', { planejamentoConcluido: true, fila: [draft('AUTO'), draft('OK')] });
    db.seed(linkPath('prod-AUTO'), 'lnk-AUTO', { estado: 'p', precoPublicado: 40 });
    const api = makeApi({ AUTO: mlItem('AUTO'), OK: mlItem('OK') });
    api.updateItem.mockImplementation(async (id: string, body: Record<string, unknown>) => {
      if (id === 'AUTO') {
        throw new MercadoLivreHttpError('preço não modificável', 400, {
          error: 'item.price.not_modifiable',
          message: 'price automation active',
        });
      }
      return { ...mlItem(id), price: body.price, base_price: body.price };
    });
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'job9', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    // The listing is healthy — the pre-existing link doc stays untouched.
    expect(db.docs(linkPath('prod-AUTO')).get('lnk-AUTO')).toEqual({
      estado: 'p',
      precoPublicado: 40,
    });
    const job = db.docs(JOBS_PATH).get('job9')!;
    expect(job).toMatchObject({ status: 'completed', enviados: 1, pulados: 1, falhas: 0 });
    expect((job.skips as Array<{ code: string }>).map((s) => s.code)).toEqual([
      'PRECO_NAO_MODIFICAVEL',
    ]);
  });

  it('any other 400 → UPDATE_PRECO_ERROR failure + the estado-E link stamp', async () => {
    const db = new FakeDb();
    seedJob(db, 'job10', { planejamentoConcluido: true, fila: [draft('BAD')] });
    seedLink(db, 'BAD');
    const api = makeApi({ BAD: mlItem('BAD') });
    api.updateItem.mockRejectedValue(
      new MercadoLivreHttpError('ML 400: Validation error', 400, {
        message: 'Validation error',
        error: 'validation_error',
        cause: [
          {
            type: 'error',
            code: 'item.price.invalid',
            message: 'Price must be less than 9999999999.',
          },
        ],
      }),
    );
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'job10', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    expect(db.docs(linkPath('prod-BAD')).get('lnk-BAD')).toMatchObject({
      estado: 'E',
      // The price sender shares the publish diagnosis: ML's `cause[]` lands on
      // the link doc here too, even though nothing is watching an HTTP response.
      errors: ['error · item.price.invalid — Price must be less than 9999999999.'],
      // No control in the listing form owns `price`, so this renders above it.
      causas: [expect.objectContaining({ code: 'item.price.invalid', campos: [] })],
      ultimaModificacao: CLOCK_NOW,
    });
    const job = db.docs(JOBS_PATH).get('job10')!;
    expect(job).toMatchObject({ falhas: 1, enviados: 0 });
    expect(job.failures).toMatchObject([{ itemId: 'BAD', code: 'UPDATE_PRECO_ERROR' }]);
  });

  it('an echo that did not keep the price → PRECO_NAO_ATUALIZADO, no link stamp', async () => {
    const db = new FakeDb();
    seedJob(db, 'job11', { planejamentoConcluido: true, fila: [draft('STALE')] });
    db.seed(linkPath('prod-STALE'), 'lnk-STALE', { estado: 'p' });
    const api = makeApi({ STALE: mlItem('STALE') });
    api.updateItem.mockResolvedValue(mlItem('STALE')); // 200, price still 40
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'job11', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    expect(db.docs(linkPath('prod-STALE')).get('lnk-STALE')).toEqual({ estado: 'p' });
    const job = db.docs(JOBS_PATH).get('job11')!;
    expect(job).toMatchObject({ falhas: 1, enviados: 0 });
    expect(job.failures).toMatchObject([{ itemId: 'STALE', code: 'PRECO_NAO_ATUALIZADO' }]);
  });

  it('a promo echo (base_price = sent preco, promo price lower) verifies — either-field match', async () => {
    const db = new FakeDb();
    seedJob(db, 'jobPromo', { planejamentoConcluido: true, fila: [draft('PROMO')] });
    seedLink(db, 'PROMO');
    const api = makeApi({ PROMO: mlItem('PROMO') });
    // The PUT lands, but an active ML promotion keeps the echoed `price` below
    // the standard price — base_price is the promo-independent confirmation.
    api.updateItem.mockResolvedValue(mlItem('PROMO', { base_price: 50, price: 45 }));
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'jobPromo', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    const job = db.docs(JOBS_PATH).get('jobPromo')!;
    expect(job).toMatchObject({ status: 'completed', enviados: 1, falhas: 0 });
    expect(db.docs(linkPath('prod-PROMO')).get('lnk-PROMO')).toMatchObject({
      precoPublicado: 50,
    });
  });

  it('a variations-body echo that OMITS variations verifies via the item-level fallback', async () => {
    const db = new FakeDb();
    seedJob(db, 'jobNoVarsEcho', { planejamentoConcluido: true, fila: [draft('VAR2')] });
    const api = makeApi({
      VAR2: mlItem('VAR2', {
        variations: [
          { id: 1, price: 40 },
          { id: 2, price: 40 },
        ],
      }),
    });
    api.updateItem.mockResolvedValue(
      mlItem('VAR2', { base_price: 50, price: 50, variations: null }),
    );
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(
      deps,
      { jobId: 'jobNoVarsEcho', integracaoId: CONTA },
      0,
    );

    expect(outcome).toBe('done');
    expect(api.updateItem).toHaveBeenCalledWith('VAR2', {
      variations: [
        { id: 1, price: 50 },
        { id: 2, price: 50 },
      ],
    });
    expect(db.docs(JOBS_PATH).get('jobNoVarsEcho')).toMatchObject({ enviados: 1, falhas: 0 });
  });
});

describe('processPriceSyncJob — 429 pause path', () => {
  it('a 429 on GET leaves the item queued and re-enqueues honouring Retry-After', async () => {
    const db = new FakeDb();
    seedJob(db, 'job12', { planejamentoConcluido: true, fila: [draft('RATE')] });
    const api = makeApi();
    api.getItem.mockRejectedValue(new MercadoLivreHttpError('rate limited', 429, null, 7));
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'job12', integracaoId: CONTA }, 0);

    expect(outcome).toBe('continued');
    expect(deps.scheduler.enqueue).toHaveBeenCalledWith(
      { jobId: 'job12', integracaoId: CONTA },
      { scheduleDelaySeconds: 7 },
    );
    const job = db.docs(JOBS_PATH).get('job12')!;
    expect(job.pausas).toBe(1);
    expect((job.fila as unknown[]).length).toBe(1); // NOT consumed — retried after the pause
    expect(job.status).toBe('running');
  });

  it('a 429 on PUT without Retry-After pauses for precoRatePauseMin() minutes', async () => {
    const db = new FakeDb();
    seedJob(db, 'job13', { planejamentoConcluido: true, fila: [draft('RATE')] });
    const api = makeApi({ RATE: mlItem('RATE') });
    api.updateItem.mockRejectedValue(new MercadoLivreHttpError('rate limited', 429, null));
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'job13', integracaoId: CONTA }, 0);

    expect(outcome).toBe('continued');
    expect(deps.scheduler.enqueue).toHaveBeenCalledWith(
      { jobId: 'job13', integracaoId: CONTA },
      { scheduleDelaySeconds: 5 * 60 },
    );
  });

  it('a pause beyond PRICE_SYNC_MAX_PAUSES fails the job instead of chaining forever', async () => {
    const db = new FakeDb();
    seedJob(db, 'job14', { planejamentoConcluido: true, fila: [draft('RATE')], pausas: 50 });
    const api = makeApi();
    api.getItem.mockRejectedValue(new MercadoLivreHttpError('rate limited', 429, null, 7));
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'job14', integracaoId: CONTA }, 0);

    expect(outcome).toBe('failed');
    expect(deps.scheduler.enqueue).not.toHaveBeenCalled();
    expect(db.docs(JOBS_PATH).get('job14')).toMatchObject({
      status: 'failed',
      erro: 'rate limit persistente',
      pausas: 51,
      finishedAt: CLOCK_NOW,
    });
  });
});

describe('processPriceSyncJob — credential + infra failures', () => {
  it('a dead credential fails the whole job (every remaining item would fail identically)', async () => {
    const db = new FakeDb();
    seedJob(db, 'job15', { planejamentoConcluido: true, fila: [draft('A'), draft('B')] });
    const api = makeApi();
    api.getItem.mockRejectedValue(new MercadoLivreReauthRequiredError('refresh_failed', 'morto'));
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'job15', integracaoId: CONTA }, 0);

    expect(outcome).toBe('failed');
    const job = db.docs(JOBS_PATH).get('job15')!;
    expect(job.status).toBe('failed');
    expect(job.erro).toMatch(/reconecte/);
  });

  it('rethrows a 5xx below the attempt cap — the prior item is already checkpointed', async () => {
    const db = new FakeDb();
    seedJob(db, 'job16', { planejamentoConcluido: true, fila: [draft('OK'), draft('CRASH')] });
    const api = makeApi({ OK: mlItem('OK') });
    api.getItem.mockImplementation(async (id: string) => {
      if (id === 'OK') return mlItem('OK');
      throw new MercadoLivreHttpError('quinhentos', 500, null);
    });
    const deps = runDeps(db, api);

    await expect(
      processPriceSyncJob(deps, { jobId: 'job16', integracaoId: CONTA }, 0),
    ).rejects.toThrow('quinhentos');

    const job = db.docs(JOBS_PATH).get('job16')!;
    expect(job.enviados).toBe(1); // OK's success survived the crash
    expect(job.fila).toMatchObject([{ itemId: 'CRASH' }]); // resumes exactly here on retry
    expect(job.status).toBe('running'); // not final attempt — never marked failed
  });

  it('marks the job failed on the FINAL attempt instead of throwing', async () => {
    const db = new FakeDb();
    seedJob(db, 'job17', { planejamentoConcluido: true, fila: [draft('CRASH')] });
    const api = makeApi();
    api.getItem.mockRejectedValue(new MercadoLivreHttpError('quinhentos', 500, null));
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(
      deps,
      { jobId: 'job17', integracaoId: CONTA },
      PRICE_SYNC_MAX_ATTEMPTS - 1, // final attempt (0-based)
    );

    expect(outcome).toBe('failed');
    expect(db.docs(JOBS_PATH).get('job17')).toMatchObject({
      status: 'failed',
      erro: 'quinhentos',
      finishedAt: CLOCK_NOW,
    });
  });

  it('a conta without a tabela normal fails deterministically', async () => {
    const db = new FakeDb();
    seedJob(db, 'job18', { planejamentoConcluido: true, fila: [draft('A')] });
    const api = makeApi();
    const deps = runDeps(db, api, {
      resolveContext: async () => ({
        api: api as unknown as PriceSyncApi,
        tabelaNormalOuterRef: null,
      }),
    });

    const outcome = await processPriceSyncJob(deps, { jobId: 'job18', integracaoId: CONTA }, 0);

    expect(outcome).toBe('failed');
    expect(db.docs(JOBS_PATH).get('job18')).toMatchObject({
      status: 'failed',
      erro: 'integração sem tabela de preços normal',
    });
  });
});

describe('processPriceSyncJob — resume + drain cap', () => {
  it('resumes an existing fila without re-planning once planning is concluded', async () => {
    const db = new FakeDb();
    seedJob(db, 'job19', { planejamentoConcluido: true, fila: [draft('A')] });
    const api = makeApi({ A: mlItem('A') });
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'job19', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    expect(deps.fetchPage).not.toHaveBeenCalled(); // resumed straight into the drain
    expect(db.docs(JOBS_PATH).get('job19')).toMatchObject({ status: 'completed', enviados: 1 });
  });

  it('caps the drain at precoItemsPerDispatch() and re-enqueues the remainder', async () => {
    const db = new FakeDb();
    seedJob(db, 'job20', {
      planejamentoConcluido: true,
      fila: [draft('A'), draft('B'), draft('C')],
    });
    vi.mocked(precoItemsPerDispatch).mockReturnValue(2);
    const api = makeApi({ A: mlItem('A'), B: mlItem('B'), C: mlItem('C') });
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'job20', integracaoId: CONTA }, 0);

    expect(outcome).toBe('continued');
    expect(deps.scheduler.enqueue).toHaveBeenCalledTimes(1);
    expect(deps.scheduler.enqueue).toHaveBeenCalledWith({ jobId: 'job20', integracaoId: CONTA });
    const job = db.docs(JOBS_PATH).get('job20')!;
    expect(job.enviados).toBe(2);
    expect(job.fila).toMatchObject([{ itemId: 'C' }]);
    expect(job.status).toBe('running');
  });

  it('a self-continuation enqueue failure below the attempt cap propagates — the job stays running for the queue retry', async () => {
    const db = new FakeDb();
    seedJob(db, 'job24', { planejamentoConcluido: true, fila: [draft('A'), draft('B')] });
    vi.mocked(precoItemsPerDispatch).mockReturnValue(1);
    const api = makeApi({ A: mlItem('A'), B: mlItem('B') });
    const deps = runDeps(db, api, {
      scheduler: {
        enqueue: vi.fn(async () => {
          throw new Error('fila indisponível');
        }),
      },
    });

    await expect(
      processPriceSyncJob(deps, { jobId: 'job24', integracaoId: CONTA }, 0),
    ).rejects.toThrow('fila indisponível');

    const job = db.docs(JOBS_PATH).get('job24')!;
    expect(job.status).toBe('running'); // the queue retry re-drives it
    expect(job.enviados).toBe(1); // the drained item's checkpoint survived
    expect(job.fila).toMatchObject([{ itemId: 'B' }]);
  });

  it('a self-continuation enqueue failure on the FINAL attempt stamps the job failed', async () => {
    const db = new FakeDb();
    seedJob(db, 'job25', { planejamentoConcluido: true, fila: [draft('A'), draft('B')] });
    vi.mocked(precoItemsPerDispatch).mockReturnValue(1);
    const api = makeApi({ A: mlItem('A'), B: mlItem('B') });
    const deps = runDeps(db, api, {
      scheduler: {
        enqueue: vi.fn(async () => {
          throw new Error('fila indisponível');
        }),
      },
    });

    const outcome = await processPriceSyncJob(
      deps,
      { jobId: 'job25', integracaoId: CONTA },
      PRICE_SYNC_MAX_ATTEMPTS - 1, // final attempt (0-based)
    );

    expect(outcome).toBe('failed');
    expect(db.docs(JOBS_PATH).get('job25')).toMatchObject({
      status: 'failed',
      erro: 'fila indisponível',
      finishedAt: CLOCK_NOW,
    });
  });
});

describe('processPriceSyncJob — noop', () => {
  it('returns noop and never resolves the context when the job doc is missing', async () => {
    const db = new FakeDb();
    const resolveContext = vi.fn();
    const deps = runDeps(db, makeApi(), { resolveContext });

    const outcome = await processPriceSyncJob(deps, { jobId: 'ghost', integracaoId: CONTA }, 0);

    expect(outcome).toBe('noop');
    expect(resolveContext).not.toHaveBeenCalled();
  });

  it('returns noop for an already-completed job (no re-drive)', async () => {
    const db = new FakeDb();
    seedJob(db, 'job21', { status: 'completed', finishedAt: CLOCK_NOW - 1 });
    const resolveContext = vi.fn();
    const deps = runDeps(db, makeApi(), { resolveContext });

    const outcome = await processPriceSyncJob(deps, { jobId: 'job21', integracaoId: CONTA }, 0);

    expect(outcome).toBe('noop');
    expect(resolveContext).not.toHaveBeenCalled();
  });
});

describe('processPriceSyncJob — capped detail lists', () => {
  it('the skips list stops at PRICE_SYNC_SKIPS_CAP while pulados keeps counting', async () => {
    const db = new FakeDb();
    seedJob(db, 'job22', {
      planejamentoConcluido: true,
      fila: [draft('EQ')],
      pulados: 200,
      skips: Array.from({ length: 200 }, (_, i) => ({
        itemId: `OLD${i}`,
        produtoId: `prod-OLD${i}`,
        code: 'PRECO_ANTIGO_IGUAL',
      })),
    });
    const api = makeApi({ EQ: mlItem('EQ', { base_price: 50, price: 50 }) });
    const deps = runDeps(db, api);

    const outcome = await processPriceSyncJob(deps, { jobId: 'job22', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    const job = db.docs(JOBS_PATH).get('job22')!;
    expect(job.pulados).toBe(201); // uncapped counter
    expect((job.skips as unknown[]).length).toBe(200); // capped list — the new entry did not fit
  });

  it('the failures list stops at PRICE_SYNC_FAILURES_CAP while falhas keeps counting', async () => {
    const db = new FakeDb();
    seedJob(db, 'job23', {
      planejamentoConcluido: true,
      fila: [draft('GONE1'), draft('GONE2')], // both 404 on GET
      falhas: 99,
      failures: Array.from({ length: 99 }, (_, i) => ({
        itemId: `OLD${i}`,
        produtoId: `prod-OLD${i}`,
        code: 'GET_PRODUTO_ERROR',
        error: 'falha antiga',
      })),
    });
    const deps = runDeps(db, makeApi()); // empty catalog → every GET 404s

    const outcome = await processPriceSyncJob(deps, { jobId: 'job23', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    const job = db.docs(JOBS_PATH).get('job23')!;
    expect(job.falhas).toBe(101); // uncapped counter: 99 + 2
    expect((job.failures as unknown[]).length).toBe(100); // capped: only ONE new entry fit
  });
});

describe('reconciliation phase (#1072)', () => {
  const FLAG = 'MERCADO_LIVRE_PRECO_RECONCILIACAO_ENABLED';
  beforeEach(() => {
    delete process.env[FLAG];
  });
  afterEach(() => {
    delete process.env[FLAG];
  });

  const reconPage = (over: Partial<PrecoReconPage> = {}): PrecoReconPage => ({
    naoEnumerados: [],
    inspecionados: 0,
    nextAfterLinkPath: null,
    ...over,
  });

  it('does not run while the flag is off — the job completes exactly as before', async () => {
    // The rollback proof: with the COLLECTION_GROUP index undeployed this phase
    // must be inert, because on Enterprise its query would silently full-scan.
    const db = new FakeDb();
    seedJob(db, 'r1', { planejamentoConcluido: true });
    const fetchReconPage = vi.fn(async () => reconPage());
    const deps = runDeps(db, makeApi(), { fetchReconPage });

    const outcome = await processPriceSyncJob(deps, { jobId: 'r1', integracaoId: CONTA }, 0);

    expect(outcome).toBe('done');
    expect(fetchReconPage).not.toHaveBeenCalled();
    expect(db.docs(JOBS_PATH).get('r1')!.status).toBe('completed');
  });

  it('does not run while planning is still open', async () => {
    process.env[FLAG] = '1';
    const db = new FakeDb();
    seedJob(db, 'r2');
    const fetchReconPage = vi.fn(async () => reconPage());
    const deps = runDeps(db, makeApi(), {
      fetchReconPage,
      // A FULL page → the plan cursor survives, planning stays open.
      fetchPage: vi.fn(async () => ({ rows: [], nextAfterAnchorId: 'A9' })),
    });

    const outcome = await processPriceSyncJob(deps, { jobId: 'r2', integracaoId: CONTA }, 0);

    expect(outcome).toBe('continued');
    expect(fetchReconPage).not.toHaveBeenCalled();
  });

  it('does not run while the fila still holds drafts', async () => {
    process.env[FLAG] = '1';
    // `precoItemsPerDispatch` is MODULE-MOCKED here, so the env var is inert —
    // the drain cap has to be set on the mock.
    vi.mocked(precoItemsPerDispatch).mockReturnValue(1);
    const db = new FakeDb();
    // Two drafts, one per dispatch → the drain cap stops with the fila non-empty.
    seedJob(db, 'r3', { planejamentoConcluido: true, fila: [draft('A'), draft('B')] });
    const fetchReconPage = vi.fn(async () => reconPage());
    const deps = runDeps(db, makeApi(), { fetchReconPage });

    const outcome = await processPriceSyncJob(deps, { jobId: 'r3', integracaoId: CONTA }, 0);

    expect(outcome).toBe('continued');
    expect(fetchReconPage).not.toHaveBeenCalled();
  });

  it('records findings as skips, counts them separately, and PERSISTS the cursor', async () => {
    process.env[FLAG] = '1';
    const db = new FakeDb();
    seedJob(db, 'r4', { planejamentoConcluido: true });
    const fetchReconPage = vi.fn(async () =>
      reconPage({
        naoEnumerados: [
          { produtoId: 'P1', itemId: 'MLB1', code: 'NAO_ENUMERADO_CONTA_FORA_DO_PRODUTO' },
          { produtoId: 'C1', itemId: 'MLB2', code: 'NAO_ENUMERADO_LINK_EM_VARIACAO' },
        ],
        inspecionados: 7,
        nextAfterLinkPath: 'produtos/P1/produtoMercadoLivre/link1',
      }),
    );
    const deps = runDeps(db, makeApi(), { fetchReconPage });

    const outcome = await processPriceSyncJob(deps, { jobId: 'r4', integracaoId: CONTA }, 0);

    expect(outcome).toBe('continued'); // a cursor came back → another page to walk
    // Assert the PERSISTED doc, never the locals: a field missing from the
    // checkpoint merge — or from the zod schema, which strips unknown keys —
    // leaves the phase re-reading its default and re-enqueueing forever.
    const job = db.docs(JOBS_PATH).get('r4')!;
    expect(job.afterLinkPath).toBe('produtos/P1/produtoMercadoLivre/link1');
    expect(job.reconciliacaoConcluida).toBe(false);
    expect(job.reconciliacaoPaginas).toBe(1);
    expect(job.naoEnumerados).toBe(2);
    expect(job.linksReconciliados).toBe(7);
    // They ride the shared skip list too, so the operator can read the rows.
    expect(job.pulados).toBe(2);
    expect(job.skips).toEqual([
      skipFixture({ itemId: 'MLB1', produtoId: 'P1', code: 'NAO_ENUMERADO_CONTA_FORA_DO_PRODUTO' }),
      skipFixture({ itemId: 'MLB2', produtoId: 'C1', code: 'NAO_ENUMERADO_LINK_EM_VARIACAO' }),
    ]);
  });

  it('resumes from the persisted cursor and completes when the walk drains', async () => {
    process.env[FLAG] = '1';
    const db = new FakeDb();
    seedJob(db, 'r5', {
      planejamentoConcluido: true,
      afterLinkPath: 'produtos/P1/produtoMercadoLivre/link1',
      reconciliacaoPaginas: 1,
      naoEnumerados: 2,
    });
    const fetchReconPage = vi.fn(async () => reconPage({ inspecionados: 3 }));
    const deps = runDeps(db, makeApi(), { fetchReconPage });

    const outcome = await processPriceSyncJob(deps, { jobId: 'r5', integracaoId: CONTA }, 0);

    expect(fetchReconPage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ afterLinkPath: 'produtos/P1/produtoMercadoLivre/link1' }),
    );
    expect(outcome).toBe('done');
    const job = db.docs(JOBS_PATH).get('r5')!;
    expect(job.reconciliacaoConcluida).toBe(true);
    expect(job.status).toBe('completed');
    expect(job.naoEnumerados).toBe(2); // carried across dispatches, never reset
  });

  it('walks ONE page per dispatch', async () => {
    process.env[FLAG] = '1';
    const db = new FakeDb();
    seedJob(db, 'r6', { planejamentoConcluido: true });
    const fetchReconPage = vi.fn(async () =>
      reconPage({ nextAfterLinkPath: 'produtos/P/produtoMercadoLivre/l' }),
    );
    const deps = runDeps(db, makeApi(), { fetchReconPage });

    await processPriceSyncJob(deps, { jobId: 'r6', integracaoId: CONTA }, 0);

    expect(fetchReconPage).toHaveBeenCalledTimes(1);
    expect(deps.scheduler.enqueue).toHaveBeenCalledTimes(1);
  });

  it('bails out past PRECO_RECON_MAX_PAGES rather than chaining tasks forever', async () => {
    // The failure this bounds: a cursor that stops advancing returns the same
    // page every dispatch. A truncated report must SAY it is truncated.
    process.env[FLAG] = '1';
    const db = new FakeDb();
    seedJob(db, 'r7', {
      planejamentoConcluido: true,
      reconciliacaoPaginas: PRECO_RECON_MAX_PAGES,
    });
    const fetchReconPage = vi.fn(async () =>
      reconPage({ nextAfterLinkPath: 'produtos/P/produtoMercadoLivre/l' }),
    );
    const deps = runDeps(db, makeApi(), { fetchReconPage });

    const outcome = await processPriceSyncJob(deps, { jobId: 'r7', integracaoId: CONTA }, 0);

    expect(fetchReconPage).not.toHaveBeenCalled();
    expect(outcome).toBe('done');
    const job = db.docs(JOBS_PATH).get('r7')!;
    expect(job.reconciliacaoConcluida).toBe(true);
    expect(job.skips).toEqual([
      skipFixture({ produtoId: CONTA, code: 'RECONCILIACAO_INCOMPLETA' }),
    ]);
  });

  it('an in-flight job written before the deploy simply gains the phase', async () => {
    // `seedJob` writes no reconciliation fields at all — the schema defaults
    // fill them on read, exactly as they already do for `afterAnchorId`.
    process.env[FLAG] = '1';
    const db = new FakeDb();
    seedJob(db, 'r8', { planejamentoConcluido: true, enviados: 5 });
    const fetchReconPage = vi.fn(async () => reconPage({ inspecionados: 1 }));
    const deps = runDeps(db, makeApi(), { fetchReconPage });

    const outcome = await processPriceSyncJob(deps, { jobId: 'r8', integracaoId: CONTA }, 0);

    expect(fetchReconPage).toHaveBeenCalledTimes(1);
    expect(outcome).toBe('done');
  });
});

/* --------------------------- the durable per-item report -------------------------- */

describe('processPriceSyncJob — the durable per-item report', () => {
  const relPath = (jobId: string) => `${JOBS_PATH}/${jobId}/relatorios`;

  /** Every row across every shard of one job, keyed as stored. */
  function linhasDe(db: FakeDb, jobId: string): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [, shard] of db.docs(relPath(jobId))) {
      Object.assign(out, (shard as { linhas?: Record<string, Record<string, unknown>> }).linhas);
    }
    return out;
  }

  it('⭐ records a SUCCESS with de → para, which the job never recorded at all', async () => {
    // Before this the success branch was a bare `enviados += 1`: a completed run
    // could say twelve prices moved and name none of them.
    const db = new FakeDb();
    seedJob(db, 'rel1', { fila: [draft('MLB1')], planejamentoConcluido: true });
    seedLink(db, 'MLB1');
    const api = makeApi({ MLB1: mlItem('MLB1') }); // priced 40, draft sends 50

    await processPriceSyncJob(runDeps(db, api), { jobId: 'rel1', integracaoId: CONTA }, 0);

    const linhas = Object.values(linhasDe(db, 'rel1'));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      produtoId: 'prod-MLB1',
      anuncioId: 'MLB1',
      linkDocId: 'lnk-MLB1',
      resultado: 'enviado',
      fase: 'envio',
      motivo: null,
      preco: 50,
      precoAnterior: 40,
    });
  });

  it('records a send-time SKIP with the price the gate read', async () => {
    const db = new FakeDb();
    seedJob(db, 'rel2', { fila: [draft('MLB1')], planejamentoConcluido: true });
    seedLink(db, 'MLB1');
    // Already at the target price → gate 2 skips PRECO_ANTIGO_IGUAL.
    const api = makeApi({ MLB1: mlItem('MLB1', { price: 50, base_price: 50 }) });

    await processPriceSyncJob(runDeps(db, api), { jobId: 'rel2', integracaoId: CONTA }, 0);

    expect(Object.values(linhasDe(db, 'rel2'))[0]).toMatchObject({
      resultado: 'pulado',
      fase: 'envio',
      motivo: 'PRECO_ANTIGO_IGUAL',
      precoAnterior: 50,
    });
  });

  it('records plan-time skips under the `plano` phase, with no price read', async () => {
    const db = new FakeDb();
    seedJob(db, 'rel4');
    const row = { anchorId: 'A' } as unknown as PrecoFamilyRow;
    vi.mocked(buildPrecoDrafts).mockReturnValue({
      drafts: [],
      skips: [skipFixture({ produtoId: 'prod-X', code: 'SEM_LINK', linkDocId: 'lnk-1' })],
    });
    const deps = runDeps(db, makeApi(), {
      fetchPage: vi.fn(async () => ({ rows: [row], nextAfterAnchorId: null })),
    });

    await processPriceSyncJob(deps, { jobId: 'rel4', integracaoId: CONTA }, 0);

    expect(Object.values(linhasDe(db, 'rel4'))[0]).toMatchObject({
      produtoId: 'prod-X',
      resultado: 'pulado',
      fase: 'plano',
      motivo: 'SEM_LINK',
      linkDocId: 'lnk-1',
      precoAnterior: null,
    });
  });

  it('⭐ a retried dispatch OVERWRITES its row instead of duplicating it', async () => {
    // The whole idempotency argument. The key is the row's IDENTITY, so a replay
    // — which gate 2 turns into PRECO_ANTIGO_IGUAL — lands on the same key. With
    // the outcome in the key this would be two rows disagreeing about one item.
    const db = new FakeDb();
    seedJob(db, 'rel5', { fila: [draft('MLB1')], planejamentoConcluido: true });
    seedLink(db, 'MLB1');
    await processPriceSyncJob(
      runDeps(db, makeApi({ MLB1: mlItem('MLB1') })),
      { jobId: 'rel5', integracaoId: CONTA },
      0,
    );
    const apos1 = linhasDe(db, 'rel5');
    expect(Object.keys(apos1)).toHaveLength(1);

    // Re-queue the SAME draft, as a retry of the in-flight item would.
    const job = db.docs(JOBS_PATH).get('rel5') as DocData;
    db.docs(JOBS_PATH).set('rel5', { ...job, fila: [draft('MLB1')], status: 'running' });
    await processPriceSyncJob(
      runDeps(db, makeApi({ MLB1: mlItem('MLB1', { price: 50, base_price: 50 }) })),
      { jobId: 'rel5', integracaoId: CONTA },
      0,
    );

    const apos2 = linhasDe(db, 'rel5');
    expect(Object.keys(apos2)).toEqual(Object.keys(apos1));
    // The replay's verdict wins — matching what `enviados`/`pulados` already do,
    // so the report and the counters cannot disagree.
    expect(Object.values(apos2)[0]).toMatchObject({ resultado: 'pulado' });
  });

  it('⚠️ a checkpoint whose commit throws writes NOTHING and leaves the counter put', async () => {
    // The control for the case above, and the reason the row and the `fila`
    // consumption share ONE batch: row-then-consume duplicates on retry,
    // consume-then-row loses the row entirely.
    const db = new FakeDb();
    seedJob(db, 'rel6', { fila: [draft('MLB1')], planejamentoConcluido: true });
    seedLink(db, 'MLB1');
    db.batch = () =>
      ({
        set() {
          return this;
        },
        commit: async () => {
          throw new Error('commit falhou');
        },
      }) as unknown as ReturnType<FakeDb['batch']>;

    await expect(
      processPriceSyncJob(
        runDeps(db, makeApi({ MLB1: mlItem('MLB1') })),
        { jobId: 'rel6', integracaoId: CONTA },
        0,
      ),
    ).rejects.toThrow('commit falhou');

    expect(db.docs(relPath('rel6')).size).toBe(0);
    expect((db.docs(JOBS_PATH).get('rel6') as DocData).relatorioLinhas ?? 0).toBe(0);
  });

  it('⭐ marks the report complete ONLY on a run that finished', async () => {
    const db = new FakeDb();
    seedJob(db, 'rel7', { planejamentoConcluido: true, reconciliacaoConcluida: true });

    const outcome = await processPriceSyncJob(
      runDeps(db, makeApi()),
      { jobId: 'rel7', integracaoId: CONTA },
      0,
    );

    expect(outcome).toBe('done');
    expect((db.docs(JOBS_PATH).get('rel7') as DocData).relatorioCompleto).toBe(true);
  });

  it('⚠️ a FAILED run leaves it false and says how much was never attempted', async () => {
    // The control: without this, "complete" is indistinguishable from "stopped
    // early", and a truncated CSV reads as a clean one.
    const db = new FakeDb();
    seedJob(db, 'rel8', { fila: [draft('MLB1'), draft('MLB2')], planejamentoConcluido: true });
    const api = makeApi();
    api.getItem.mockRejectedValue(
      new MercadoLivreReauthRequiredError('refresh_failed', 'grant morto'),
    );

    await processPriceSyncJob(runDeps(db, api), { jobId: 'rel8', integracaoId: CONTA }, 0);

    const job = db.docs(JOBS_PATH).get('rel8') as DocData;
    expect(job.status).toBe('failed');
    expect(job.relatorioCompleto).toBe(false);
    expect(job.filaRestante).toBe(2);
    // ONE synthetic row, not one per queued draft.
    const linhas = Object.values(linhasDe(db, 'rel8'));
    expect(linhas.filter((l) => l.motivo === 'JOB_INTERROMPIDO')).toHaveLength(1);
  });

  it('rolls over to a second shard at the size boundary', async () => {
    const db = new FakeDb();
    // Start one row short of the boundary so the next two rows straddle it.
    seedJob(db, 'rel9', {
      fila: [draft('MLB1'), draft('MLB2')],
      planejamentoConcluido: true,
      relatorioLinhas: RELATORIO_ENVIO_PRECO_SHARD_SIZE - 1,
      relatorioShards: 1,
    });
    seedLink(db, 'MLB1');
    seedLink(db, 'MLB2');
    const api = makeApi({ MLB1: mlItem('MLB1'), MLB2: mlItem('MLB2') });

    await processPriceSyncJob(runDeps(db, api), { jobId: 'rel9', integracaoId: CONTA }, 0);

    // Zero-padded ids, so lexical order IS shard order — what lets the download
    // page by `__name__` with no index.
    expect([...db.docs(relPath('rel9')).keys()].sort()).toEqual(['0000', '0001']);
    expect((db.docs(JOBS_PATH).get('rel9') as DocData).relatorioShards).toBe(2);
  });

  it('⭐ the FINAL-ATTEMPT catch reports the same way `failJob` does', async () => {
    // A persistent ML 5xx (getItem rethrows), a batch.commit() failure and an
    // enqueue failure all land in the catch, not on the `fatal` path. It used to
    // write only status/erro, so `filaRestante` stayed at its schema default 0
    // and no row named the cause — the CSV would then render a run that
    // abandoned two queued drafts as "0 itens não foram tentados".
    const db = new FakeDb();
    seedJob(db, 'term1', {
      fila: [draft('MLB1'), draft('MLB2')],
      planejamentoConcluido: true,
    });
    const api = makeApi();
    api.getItem.mockRejectedValue(new Error('ML 500 persistente'));

    const outcome = await processPriceSyncJob(
      runDeps(db, api),
      { jobId: 'term1', integracaoId: CONTA },
      PRICE_SYNC_MAX_ATTEMPTS - 1,
    );

    expect(outcome).toBe('failed');
    const job = db.docs(JOBS_PATH).get('term1') as DocData;
    expect(job.status).toBe('failed');
    expect(job.relatorioCompleto).toBe(false);
    expect(job.filaRestante).toBe(2);

    const linhas = Object.values(linhasDe(db, 'term1'));
    expect(linhas.filter((l) => l.motivo === 'JOB_INTERROMPIDO')).toHaveLength(1);
  });

  it('⚠️ a NON-final attempt rethrows and stamps nothing', async () => {
    // The control. Without it the case above would pass just as well if the
    // catch stamped on every attempt, which would end the job on the first blip
    // instead of letting Cloud Tasks retry it.
    const db = new FakeDb();
    seedJob(db, 'term2', { fila: [draft('MLB1')], planejamentoConcluido: true });
    const api = makeApi();
    api.getItem.mockRejectedValue(new Error('blip'));

    await expect(
      processPriceSyncJob(runDeps(db, api), { jobId: 'term2', integracaoId: CONTA }, 0),
    ).rejects.toThrow('blip');

    const job = db.docs(JOBS_PATH).get('term2') as DocData;
    expect(job.status).toBe('running');
    expect(db.docs(`${JOBS_PATH}/term2/relatorios`).size).toBe(0);
  });

  it('records the INTENDED price on a refused send, which is not the same as sent', async () => {
    // `preco` is the price the plan wanted; only `resultado: 'enviado'` means it
    // landed. Pinned here because a reader pairing precoAnterior → preco
    // unconditionally would claim a listing moved when it did not.
    const db = new FakeDb();
    seedJob(db, 'term3', { fila: [draft('MLB1')], planejamentoConcluido: true });
    seedLink(db, 'MLB1');
    // Listing at 90, draft wants 50, baixarPreco off ⇒ gate 4 refuses.
    const api = makeApi({ MLB1: mlItem('MLB1', { price: 90, base_price: 90 }) });

    await processPriceSyncJob(runDeps(db, api), { jobId: 'term3', integracaoId: CONTA }, 0);

    expect(Object.values(linhasDe(db, 'term3'))[0]).toMatchObject({
      resultado: 'pulado',
      motivo: 'PRECO_ANTIGO_MAIOR',
      preco: 50, // intended
      precoAnterior: 90, // still what the listing carries
    });
  });
});

/* ------------------------------ cancelPriceSyncJob ------------------------------ */

describe('cancelPriceSyncJob', () => {
  const relPath = (jobId: string) => `${JOBS_PATH}/${jobId}/relatorios`;

  /** Every row across every shard of one job, keyed as stored. */
  function linhasDe(db: FakeDb, jobId: string): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [, shard] of db.docs(relPath(jobId))) {
      Object.assign(out, (shard as { linhas?: Record<string, Record<string, unknown>> }).linhas);
    }
    return out;
  }

  it('⭐ clears a LIVE running job, which the staleness escape would make the operator wait 6h for', async () => {
    // The `updatedAt` here is deliberately fresh against the REAL clock —
    // `startPriceSyncJob` reads `Date.now()` directly, and `CLOCK_NOW` is a
    // fixed 2023 instant. Seeded stale, this test would pass on the pre-existing
    // 6h escape alone and prove nothing about the cancel.
    const db = new FakeDb();
    seedJob(db, 'job-vivo', { updatedAt: Date.now() - 1000 });

    await expect(
      startPriceSyncJob(asDb(db), { integracaoId: CONTA, baixarPreco: false, startedBy: 'u' }),
    ).rejects.toBeInstanceOf(PriceSyncAlreadyRunningError);

    const outcome = await cancelPriceSyncJob(asDb(db), {
      jobId: 'job-vivo',
      integracaoId: CONTA,
      now: CLOCK_NOW,
    });

    expect(outcome).toBe('stamped');
    expect(db.docs(JOBS_PATH).get('job-vivo')).toMatchObject({
      status: 'cancelled',
      erro: null,
      relatorioCompleto: false,
      finishedAt: CLOCK_NOW,
      updatedAt: CLOCK_NOW,
    });

    // And the button is free immediately, not six hours from now.
    await expect(
      startPriceSyncJob(asDb(db), { integracaoId: CONTA, baixarPreco: false, startedBy: 'u' }),
    ).resolves.toMatchObject({ jobId: expect.any(String) });
  });

  it('refuses a terminal job, a missing job and another conta’s job', async () => {
    const db = new FakeDb();
    seedJob(db, 'ja-terminado', { status: 'completed' });
    seedJob(db, 'de-outro', { integracaoId: 'conta-B' });

    await expect(
      cancelPriceSyncJob(asDb(db), { jobId: 'ja-terminado', integracaoId: CONTA }),
    ).resolves.toBe('not-running');
    await expect(
      cancelPriceSyncJob(asDb(db), { jobId: 'nao-existe', integracaoId: CONTA }),
    ).resolves.toBe('not-found');
    await expect(
      cancelPriceSyncJob(asDb(db), { jobId: 'de-outro', integracaoId: CONTA }),
    ).resolves.toBe('wrong-integracao');

    // The foreign job is untouched — the ownership check refuses BEFORE writing.
    expect(db.docs(JOBS_PATH).get('de-outro')).toMatchObject({ status: 'running' });
  });

  it('records the abandoned queue: filaRestante plus ONE JOB_CANCELADO row', async () => {
    // Without these the CSV's completeness trailer reads "0 itens não foram
    // tentados" on a run that dropped a full queue — the same defect the
    // failure stamp exists to have fixed.
    const db = new FakeDb();
    seedJob(db, 'job-fila', { fila: [draft('MLB1'), draft('MLB2'), draft('MLB3')] });

    await cancelPriceSyncJob(asDb(db), {
      jobId: 'job-fila',
      integracaoId: CONTA,
      now: CLOCK_NOW,
    });

    expect(db.docs(JOBS_PATH).get('job-fila')).toMatchObject({
      status: 'cancelled',
      filaRestante: 3,
      relatorioLinhas: 1,
      relatorioShards: 1,
    });
    const linhas = Object.values(linhasDe(db, 'job-fila'));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      resultado: 'nao-tentado',
      motivo: 'JOB_CANCELADO',
      // A cancel is not a fault, so the row carries no error text — that is what
      // distinguishes it from JOB_INTERROMPIDO at read time.
      erro: null,
    });
  });

  it('shards the row from the job’s OWN relatorioLinhas, not from zero', async () => {
    // The cursor is re-derived inside the transaction; a captured one would put
    // the row in the wrong shard and rewrite the counter backwards.
    const db = new FakeDb();
    seedJob(db, 'job-shard', {
      relatorioLinhas: RELATORIO_ENVIO_PRECO_SHARD_SIZE,
      relatorioShards: 1,
    });

    await cancelPriceSyncJob(asDb(db), { jobId: 'job-shard', integracaoId: CONTA });

    expect(db.docs(JOBS_PATH).get('job-shard')).toMatchObject({
      relatorioLinhas: RELATORIO_ENVIO_PRECO_SHARD_SIZE + 1,
      relatorioShards: 2,
    });
    expect(db.docs(relPath('job-shard')).size).toBe(1);
  });

  it('⭐ a cancel landing MID-DISPATCH is not overwritten by the completion stamp', async () => {
    const db = new FakeDb();
    seedJob(db, 'job-race', { planejamentoConcluido: true });
    const api = makeApi();
    const deps = runDeps(db, api, {
      // Fires AFTER the dispatch's opening status read and BEFORE its terminal
      // stamp — the exact window an unguarded merge() clobbered.
      resolveContext: async () => {
        await cancelPriceSyncJob(asDb(db), {
          jobId: 'job-race',
          integracaoId: CONTA,
          now: CLOCK_NOW,
        });
        return { api: api as unknown as PriceSyncApi, tabelaNormalOuterRef: TAB_REF };
      },
    });

    const outcome = await processPriceSyncJob(deps, { jobId: 'job-race', integracaoId: CONTA }, 0);

    expect(outcome).toBe('noop');
    expect(db.docs(JOBS_PATH).get('job-race')).toMatchObject({ status: 'cancelled' });
  });

  it('⭐ a cancel landing MID-DISPATCH stops the self-continuation too', async () => {
    // Same seam, but with work left over, so the dispatch WOULD re-enqueue.
    // Without the pre-enqueue re-check the cancel silently buys one more.
    const db = new FakeDb();
    seedJob(db, 'job-race2', { fila: [draft('MLB1')], planejamentoConcluido: false });
    const api = makeApi();
    const deps = runDeps(db, api, {
      resolveContext: async () => {
        await cancelPriceSyncJob(asDb(db), {
          jobId: 'job-race2',
          integracaoId: CONTA,
          now: CLOCK_NOW,
        });
        return { api: api as unknown as PriceSyncApi, tabelaNormalOuterRef: TAB_REF };
      },
    });

    const outcome = await processPriceSyncJob(deps, { jobId: 'job-race2', integracaoId: CONTA }, 0);

    expect(outcome).toBe('noop');
    expect(deps.scheduler.enqueue).not.toHaveBeenCalled();
    expect(db.docs(JOBS_PATH).get('job-race2')).toMatchObject({ status: 'cancelled' });
  });

  it('⭐ and the other direction: a cancel arriving after `completed` is a no-op', async () => {
    // "Whichever lands first wins" has to hold both ways, or the guard just
    // moves the lost update rather than removing it.
    const db = new FakeDb();
    seedJob(db, 'job-tarde', { planejamentoConcluido: true });

    const outcome = await processPriceSyncJob(
      runDeps(db, makeApi()),
      { jobId: 'job-tarde', integracaoId: CONTA },
      0,
    );
    expect(outcome).toBe('done');

    await expect(
      cancelPriceSyncJob(asDb(db), { jobId: 'job-tarde', integracaoId: CONTA }),
    ).resolves.toBe('not-running');
    expect(db.docs(JOBS_PATH).get('job-tarde')).toMatchObject({
      status: 'completed',
      relatorioCompleto: true,
    });
    // And the losing cancel wrote no report row either — the whole callback is
    // behind the same guard, not just the status field.
    expect(db.docs(relPath('job-tarde')).size).toBe(0);
  });

  it('finalizePriceSyncJob without expectIntegracaoId skips the ownership check', async () => {
    // The dispatch loop's own stamps pass no conta — they already know whose job
    // they are running — so the check has to be opt-in, not a silent default.
    const db = new FakeDb();
    seedJob(db, 'job-sem-dono', { integracaoId: 'conta-B' });

    await expect(
      finalizePriceSyncJob(asDb(db), 'job-sem-dono', {
        status: 'failed',
        erro: 'x',
        finishedAt: CLOCK_NOW,
        updatedAt: CLOCK_NOW,
      }),
    ).resolves.toBe('stamped');
  });
});
