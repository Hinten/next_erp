import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MercadoLivreError, type MercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import type { MassImportOptions } from '@delfrance/schemas';

import {
  cancelMassImportJob,
  MASS_IMPORT_FAILURES_CAP,
  MASS_IMPORT_ITEMS_PER_DISPATCH,
  MASS_IMPORT_MAX_ATTEMPTS,
  MassImportAlreadyRunningError,
  type MassImportRunDeps,
  processMassImportJob,
  startMassImportJob,
} from './massImport';

/* ------------------------------ fake Firestore ---------------------------- */
// Adapted from import.test.ts's FakeDb: `where()` here is operator-aware (adds
// `'in'` support, needed by the skip-filter's chunked `where('id', 'in', chunk)`
// lookup) — the original only ever did `===` equality.

type DocData = Record<string, unknown>;

function matchClause(fieldValue: unknown, op: string, value: unknown): boolean {
  if (op === 'in') return Array.isArray(value) && value.includes(fieldValue);
  return fieldValue === value; // '==' — the only other operator this suite needs
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

  private query(entries: Array<[string, DocData, string]>) {
    const clauses: Array<[string, string, unknown]> = [];
    let lim: number | null = null;
    const q = {
      where(field: string, op: string, value: unknown) {
        clauses.push([field, op, value]);
        return q;
      },
      limit(n: number) {
        lim = n;
        return q;
      },
      async get() {
        let rows = entries.filter(([, d]) =>
          clauses.every(([f, op, v]) => matchClause(d[f], op, v)),
        );
        if (lim != null) rows = rows.slice(0, lim);
        return {
          docs: rows.map(([id, d, colPath]) => ({
            id,
            data: () => d,
            exists: true,
            ref: { parent: { parent: { id: parentDocId(colPath) } } },
          })),
          empty: rows.length === 0,
        };
      },
    };
    return q;
  }

  collection(path: string) {
    const col = this.col(path);
    const self = this;
    return {
      doc: (id?: string) => {
        const docId = id ?? `auto-${++self.autoN}`;
        return {
          id: docId,
          get: async () => ({ exists: col.has(docId), id: docId, data: () => col.get(docId) }),
          set: async (data: DocData, opts?: { merge?: boolean }) => {
            col.set(docId, opts?.merge ? { ...(col.get(docId) ?? {}), ...data } : { ...data });
          },
          create: async (data: DocData) => {
            if (col.has(docId)) throw Object.assign(new Error('already exists'), { code: 6 });
            col.set(docId, { ...data });
          },
          update: async (patch: DocData) => {
            col.set(docId, { ...(col.get(docId) ?? {}), ...patch });
          },
        };
      },
      where: (field: string, op: string, value: unknown) =>
        self.query([...col.entries()].map(([id, d]) => [id, d, path])).where(field, op, value),
      limit: (n: number) => self.query([...col.entries()].map(([id, d]) => [id, d, path])).limit(n),
      get: async () => ({
        docs: [...col.entries()].map(([id, d]) => ({ id, data: () => d, exists: true })),
      }),
    };
  }

  collectionGroup(groupId: string) {
    const entries: Array<[string, DocData, string]> = [];
    for (const [path, col] of this.cols) {
      if (path.split('/').pop() === groupId) {
        for (const [id, d] of col) entries.push([id, d, path]);
      }
    }
    return this.query(entries);
  }

  // Minimal transaction fake for the taxonomy resolver `importProduto` exercises
  // internally for a variations/User-Products item — unused by this suite's
  // simple-item fixtures, kept for parity with import.test.ts's FakeDb.
  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    const tx: FakeTransaction = {
      get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
      create: async (ref: { create: (d: DocData) => Promise<void> }, data: DocData) => {
        await ref.create(data);
      },
      set: async (
        ref: { set: (d: DocData, o?: { merge?: boolean }) => Promise<void> },
        data: DocData,
        opts?: { merge?: boolean },
      ) => {
        await ref.set(data, opts);
      },
      update: async (ref: { update: (d: DocData) => Promise<void> }, patch: DocData) => {
        await ref.update(patch);
      },
    };
    return fn(tx);
  }
}

interface FakeTransaction {
  get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
  create: (ref: { create: (d: DocData) => Promise<void> }, data: DocData) => Promise<void>;
  set: (
    ref: { set: (d: DocData, o?: { merge?: boolean }) => Promise<void> },
    data: DocData,
    opts?: { merge?: boolean },
  ) => Promise<void>;
  update: (ref: { update: (d: DocData) => Promise<void> }, patch: DocData) => Promise<void>;
}

function parentDocId(colPath: string): string {
  const segs = colPath.split('/').filter(Boolean);
  return segs[segs.length - 2] ?? '';
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* --------------------------------- fixtures ------------------------------- */

const CLOCK_NOW = 1_700_000_000_000;

const BASE_OPTIONS: MassImportOptions = {
  importarEstoque: true,
  sobrescreverEstoque: false,
  importarPreco: true,
  sobrescreverPreco: true,
  atualizarProdutoPai: true,
  sobrescreverDadosProduto: false,
  importarFotos: false,
  importarCategorias: false,
  atualizarCadastrados: false,
};

function simpleItem(id: string, overrides: DocData = {}): DocData {
  return {
    id,
    title: `Produto ${id}`,
    category_id: 'MLB1430',
    base_price: 10,
    price: 10,
    available_quantity: 1,
    condition: 'new',
    status: 'active',
    listing_type_id: 'gold_special',
    seller_id: 55,
    attributes: [],
    ...overrides,
  };
}

function makeApi(opts: { scan?: DocData; items?: Record<string, DocData> }): MercadoLivreApi {
  return {
    scanSellerItems: vi.fn(async () => opts.scan ?? { results: [] }),
    getItem: vi.fn(async (id: string) => {
      const it = opts.items?.[id];
      if (!it) throw new MercadoLivreError(`item não encontrado: ${id}`);
      return it;
    }),
    getItemDescription: vi.fn(async () => ({ plain_text: 'Descrição' })),
    getCategory: vi.fn(async () => ({ id: 'MLB1430', name: 'Roupas' })),
    // #1087 — present so an accidental call is observable rather than a
    // `is not a function` crash. The mass path must never reach it.
    getLastModeration: vi.fn(async () => []),
    // Present so a regression that STOPS passing `lerPesoEnvio: false` shows up
    // as a call count, not as a crash — see the mass-path test below.
    getFreeShippingOptions: vi.fn(async () => ({ coverage: { all_country: {} } })),
  } as unknown as MercadoLivreApi;
}

function runDeps(
  db: FakeDb,
  api: MercadoLivreApi,
  over: Partial<MassImportRunDeps> = {},
): MassImportRunDeps {
  return {
    db: asDb(db),
    resolveImportDeps: async () => ({
      api,
      sellerUserId: 55,
      tabelaNormalOuterRef: 'documents/tabelasDePrecos/tabNormal',
      depositoOuterRef: 'documents/depositos/dep1',
    }),
    scheduler: { enqueue: vi.fn(async () => {}) },
    now: () => CLOCK_NOW,
    ...over,
  };
}

function seedJob(db: FakeDb, jobId: string, patch: DocData = {}): void {
  db.seed('importacoesMercadoLivre', jobId, {
    integracaoId: 'conta-A',
    status: 'running',
    scrollId: null,
    fila: [],
    scanned: 0,
    imported: 0,
    created: 0,
    skipped: 0,
    failureCount: 0,
    failures: [],
    options: BASE_OPTIONS,
    startedAt: CLOCK_NOW - 1000,
    updatedAt: CLOCK_NOW - 1000,
    finishedAt: null,
    erro: null,
    ...patch,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

/* ---------------------------------------------------------------------------- */

describe('processMassImportJob — scan + skip-filter', () => {
  it('scans a page, filters already-registered ids across TWO where-in chunks, and drains the rest', async () => {
    const db = new FakeDb();
    seedJob(db, 'job1');
    const ids = Array.from({ length: 35 }, (_, i) => `MLB${i}`);
    // Every id already registered EXCEPT MLB5 (chunk 1: ids 0-29) and MLB32
    // (chunk 2: ids 30-34) — proves BOTH chunks get queried and filtered.
    for (const id of ids) {
      if (id === 'MLB5' || id === 'MLB32') continue;
      db.seed(`produtos/prod-${id}/produtoMercadoLivre`, `lnk-${id}`, {
        id,
        contaOuterRef: 'documents/integracao/conta-A',
      });
    }
    const api = makeApi({
      scan: { results: ids, scroll_id: 'SCROLL-1' },
      items: { MLB5: simpleItem('MLB5'), MLB32: simpleItem('MLB32') },
    });
    const deps = runDeps(db, api);

    const outcome = await processMassImportJob(deps, { jobId: 'job1', integracaoId: 'conta-A' }, 0);

    expect(outcome).toBe('continued'); // scroll_id non-null → scan not exhausted
    expect(deps.scheduler!.enqueue).toHaveBeenCalledWith({
      jobId: 'job1',
      integracaoId: 'conta-A',
    });

    const job = db.docs('importacoesMercadoLivre').get('job1')!;
    expect(job.scanned).toBe(35);
    expect(job.skipped).toBe(33);
    expect(job.fila).toEqual([]); // both unregistered ids fit under the drain cap
    expect(job.imported).toBe(2);
    expect(job.created).toBe(2);
    expect(job.scrollId).toBe('SCROLL-1');
  });

  it('atualizarCadastrados=true bypasses the skip-filter entirely (already-registered ids are re-driven)', async () => {
    const db = new FakeDb();
    seedJob(db, 'job2', { options: { ...BASE_OPTIONS, atualizarCadastrados: true } });
    db.seed('produtos', 'prodX', { nome: 'Já registrado', sku: 'OLD-SKU' });
    db.seed('produtos/prodX/produtoMercadoLivre', 'lnkX', {
      id: 'MLB1',
      contaOuterRef: 'documents/integracao/conta-A',
    });
    const api = makeApi({
      scan: { results: ['MLB1', 'MLB2'], scroll_id: null },
      items: { MLB1: simpleItem('MLB1'), MLB2: simpleItem('MLB2') },
    });
    const deps = runDeps(db, api);

    const outcome = await processMassImportJob(deps, { jobId: 'job2', integracaoId: 'conta-A' }, 0);

    expect(outcome).toBe('done');
    const job = db.docs('importacoesMercadoLivre').get('job2')!;
    expect(job.skipped).toBe(0); // filter never ran
    expect(job.imported).toBe(2); // MLB1 re-driven despite the pre-existing link
    expect(job.status).toBe('completed');
  });

  it('completes immediately when the seller has no listings at all', async () => {
    const db = new FakeDb();
    seedJob(db, 'job7');
    const api = makeApi({ scan: { results: [], scroll_id: null } });
    const deps = runDeps(db, api);

    const outcome = await processMassImportJob(deps, { jobId: 'job7', integracaoId: 'conta-A' }, 0);

    expect(outcome).toBe('done');
    const job = db.docs('importacoesMercadoLivre').get('job7')!;
    expect(job).toMatchObject({ status: 'completed', scanned: 0, imported: 0, fila: [] });
    expect(job.finishedAt).toBe(CLOCK_NOW);
  });
});

describe('processMassImportJob — ML moderations (#1087)', () => {
  /**
   * The mass path deliberately does NOT spend a `/moderations` call: it drains a
   * whole catalogue, and the reason is a diagnostic the operator can pull
   * per-listing with "Reverificar anúncio". `lerModeracoes: false` suppresses the
   * CALL, never the write — which is the distinction these two pin.
   */
  function linkOf(db: FakeDb, produtoId: string): DocData {
    return [...db.docs(`produtos/${produtoId}/produtoMercadoLivre`).values()][0]!;
  }

  it('⚠️ never calls /moderations, even for a listing ML has moderated', async () => {
    const db = new FakeDb();
    seedJob(db, 'jobMod');
    const api = makeApi({
      scan: { results: ['MLB9'], scroll_id: null },
      items: {
        MLB9: simpleItem('MLB9', { status: 'paused', sub_status: ['moderation_penalty'] }),
      },
    });

    await processMassImportJob(runDeps(db, api), { jobId: 'jobMod', integracaoId: 'conta-A' }, 0);

    expect(api.getLastModeration).not.toHaveBeenCalled();
    const produtoId = [...db.docs('produtos').keys()][0]!;
    // "Never asked" — NOT `[]`, which on disk is byte-identical to a healthy
    // listing and would record "not moderated" about one nobody asked about.
    expect(linkOf(db, produtoId).moderacoes ?? null).toBeNull();
    expect(linkOf(db, produtoId).status).toBe('paused');
  });

  it('still clears a stale reason off a HEALTHY listing — that verdict is free', async () => {
    // The half of the invariant the mass path keeps: the item already fetched
    // says there is nothing to explain, so any stored reason is stale. No call.
    const db = new FakeDb();
    seedJob(db, 'jobLimpo', { options: { ...BASE_OPTIONS, atualizarCadastrados: true } });
    db.seed('produtos', 'prodM', { nome: 'Camiseta', sku: 'SKU-M' });
    db.seed('produtos/prodM/produtoMercadoLivre', 'lnkM', {
      id: 'MLB9',
      title: 'Camiseta',
      contaOuterRef: 'documents/integracao/conta-A',
      status: 'paused',
      moderacoes: [{ nome: 'POOR_QUALITY_THUMBNAIL', motivo: 'Foto ruim' }],
    });
    const api = makeApi({
      scan: { results: ['MLB9'], scroll_id: null },
      items: { MLB9: simpleItem('MLB9') },
    });

    await processMassImportJob(runDeps(db, api), { jobId: 'jobLimpo', integracaoId: 'conta-A' }, 0);

    expect(api.getLastModeration).not.toHaveBeenCalled();
    expect(db.docs('produtos/prodM/produtoMercadoLivre').get('lnkM')).toMatchObject({
      status: 'active',
      moderacoes: [],
    });
  });

  it('⚠️ never calls /shipping_options/free, even for a listing with no weight', async () => {
    // The mass path passes `lerPesoEnvio: false`, and this is what holds it to
    // that promise. A flag the caller stops sending is invisible in `import.ts`'s
    // own tests — they set it themselves — so the assertion has to live HERE,
    // where the real caller runs. Unlike a category or a domain the answer is per
    // ITEM, so a drain would pay one extra ML round trip per listing.
    const db = new FakeDb();
    seedJob(db, 'jobPeso');
    const api = makeApi({
      scan: { results: ['MLB9'], scroll_id: null },
      items: { MLB9: simpleItem('MLB9') },
    });

    await processMassImportJob(runDeps(db, api), { jobId: 'jobPeso', integracaoId: 'conta-A' }, 0);

    expect(api.getFreeShippingOptions).not.toHaveBeenCalled();
    const produtoId = [...db.docs('produtos').keys()][0]!;
    expect(db.docs('produtos').get(produtoId)!.pesoBrutoKg).toBeNull();
  });
});

describe('processMassImportJob — drain cap', () => {
  it('caps the drain at MASS_IMPORT_ITEMS_PER_DISPATCH and re-enqueues the remainder even though the scan itself is exhausted', async () => {
    const db = new FakeDb();
    seedJob(db, 'job3');
    const count = MASS_IMPORT_ITEMS_PER_DISPATCH + 3;
    const ids = Array.from({ length: count }, (_, i) => `MLB${i}`);
    const items: Record<string, DocData> = {};
    for (const id of ids) items[id] = simpleItem(id);
    const api = makeApi({ scan: { results: ids, scroll_id: null }, items });
    const deps = runDeps(db, api);

    const outcome = await processMassImportJob(deps, { jobId: 'job3', integracaoId: 'conta-A' }, 0);

    expect(outcome).toBe('continued');
    expect(deps.scheduler!.enqueue).toHaveBeenCalledTimes(1);
    const job = db.docs('importacoesMercadoLivre').get('job3')!;
    expect(job.imported).toBe(MASS_IMPORT_ITEMS_PER_DISPATCH);
    expect((job.fila as string[]).length).toBe(3);
    expect(job.scrollId).toBeNull(); // scan itself WAS exhausted — only the drain cap forced 'continued'
  });
});

describe('processMassImportJob — resume + per-item containment', () => {
  it('resumes mid-fila without re-scanning, contains per-item failures, and caps the failures list while failureCount stays uncapped', async () => {
    const db = new FakeDb();
    const preExistingFailures = Array.from({ length: MASS_IMPORT_FAILURES_CAP - 1 }, (_, i) => ({
      itemId: `OLD${i}`,
      error: 'falha antiga',
    }));
    seedJob(db, 'job4', {
      fila: ['MLB-CLOSED-1', 'MLB-CLOSED-2'],
      scrollId: null, // a prior dispatch already exhausted the scan
      scanned: 500,
      failureCount: MASS_IMPORT_FAILURES_CAP - 1,
      failures: preExistingFailures,
    });
    const api = makeApi({
      items: {
        'MLB-CLOSED-1': simpleItem('MLB-CLOSED-1', { status: 'closed' }),
        'MLB-CLOSED-2': simpleItem('MLB-CLOSED-2', { status: 'closed' }),
      },
    });
    const deps = runDeps(db, api);

    const outcome = await processMassImportJob(deps, { jobId: 'job4', integracaoId: 'conta-A' }, 0);

    expect(outcome).toBe('done'); // both fail, but the fila still drains to empty
    expect(api.scanSellerItems).not.toHaveBeenCalled(); // resumed straight into the drain
    const job = db.docs('importacoesMercadoLivre').get('job4')!;
    expect(job.failureCount).toBe(MASS_IMPORT_FAILURES_CAP + 1); // uncapped counter: (cap-1) + 2
    expect((job.failures as unknown[]).length).toBe(MASS_IMPORT_FAILURES_CAP); // capped: only ONE new entry fit
    expect(job.imported).toBe(0);
    expect(job.status).toBe('completed');
  });
});

describe('processMassImportJob — infra failure handling', () => {
  it('rethrows a non-per-item error below the attempt cap, but the prior successful item is already checkpointed', async () => {
    const db = new FakeDb();
    seedJob(db, 'job5', { fila: ['MLB-OK', 'MLB-CRASH'], scrollId: null });
    const api = {
      scanSellerItems: vi.fn(),
      getItem: vi.fn(async (id: string) => {
        if (id === 'MLB-OK') return simpleItem('MLB-OK');
        throw new Error('firestore indisponível'); // NOT a MercadoLivreError — infra failure
      }),
      getItemDescription: vi.fn(async () => ({ plain_text: 'Descrição' })),
      getCategory: vi.fn(async () => ({ id: 'MLB1430', name: 'Roupas' })),
    } as unknown as MercadoLivreApi;
    const deps = runDeps(db, api);

    await expect(
      processMassImportJob(deps, { jobId: 'job5', integracaoId: 'conta-A' }, 0),
    ).rejects.toThrow('firestore indisponível');

    const job = db.docs('importacoesMercadoLivre').get('job5')!;
    expect(job.imported).toBe(1); // MLB-OK's success survived the crash
    expect(job.fila).toEqual(['MLB-CRASH']); // resumes exactly here on retry
    expect(job.status).toBe('running'); // not final attempt — never marked failed
  });

  it('marks the job failed on the FINAL attempt instead of throwing', async () => {
    const db = new FakeDb();
    seedJob(db, 'job6', { fila: ['MLB-CRASH'], scrollId: null });
    const api = {
      scanSellerItems: vi.fn(),
      getItem: vi.fn(async () => {
        throw new Error('firestore indisponível');
      }),
      getItemDescription: vi.fn(async () => ({ plain_text: 'Descrição' })),
      getCategory: vi.fn(async () => ({ id: 'MLB1430', name: 'Roupas' })),
    } as unknown as MercadoLivreApi;
    const deps = runDeps(db, api);

    const outcome = await processMassImportJob(
      deps,
      { jobId: 'job6', integracaoId: 'conta-A' },
      MASS_IMPORT_MAX_ATTEMPTS - 1, // final attempt (0-based)
    );

    expect(outcome).toBe('failed');
    const job = db.docs('importacoesMercadoLivre').get('job6')!;
    expect(job.status).toBe('failed');
    expect(job.erro).toBe('firestore indisponível');
    expect(job.finishedAt).toBe(CLOCK_NOW);
  });

  it('cannot scan without a sellerUserId — final attempt marks the job failed with a clear message', async () => {
    const db = new FakeDb();
    seedJob(db, 'job9');
    const api = makeApi({});
    const deps = runDeps(db, api, {
      resolveImportDeps: async () => ({
        api,
        sellerUserId: null,
        tabelaNormalOuterRef: null,
        depositoOuterRef: null,
      }),
    });

    const outcome = await processMassImportJob(
      deps,
      { jobId: 'job9', integracaoId: 'conta-A' },
      MASS_IMPORT_MAX_ATTEMPTS - 1,
    );

    expect(outcome).toBe('failed');
    const job = db.docs('importacoesMercadoLivre').get('job9')!;
    expect(job.erro).toMatch(/user_id/);
  });
});

describe('processMassImportJob — noop', () => {
  it('returns noop and never resolves import deps when the job doc is missing', async () => {
    const db = new FakeDb();
    const resolveImportDeps = vi.fn();
    const deps: MassImportRunDeps = {
      db: asDb(db),
      resolveImportDeps,
      scheduler: { enqueue: vi.fn(async () => {}) },
    };

    const outcome = await processMassImportJob(
      deps,
      { jobId: 'ghost', integracaoId: 'conta-A' },
      0,
    );

    expect(outcome).toBe('noop');
    expect(resolveImportDeps).not.toHaveBeenCalled();
  });

  it('returns noop for an already-completed job (no re-drive)', async () => {
    const db = new FakeDb();
    seedJob(db, 'job8', { status: 'completed', finishedAt: CLOCK_NOW - 1 });
    const resolveImportDeps = vi.fn();
    const deps: MassImportRunDeps = {
      db: asDb(db),
      resolveImportDeps,
      scheduler: { enqueue: vi.fn(async () => {}) },
    };

    const outcome = await processMassImportJob(deps, { jobId: 'job8', integracaoId: 'conta-A' }, 0);

    expect(outcome).toBe('noop');
    expect(resolveImportDeps).not.toHaveBeenCalled();
  });
});

describe('startMassImportJob', () => {
  it('creates a fresh running job with the given options', async () => {
    const db = new FakeDb();
    const jobId = await startMassImportJob(asDb(db), {
      integracaoId: 'conta-A',
      options: BASE_OPTIONS,
    });

    const job = db.docs('importacoesMercadoLivre').get(jobId)!;
    expect(job).toMatchObject({
      integracaoId: 'conta-A',
      status: 'running',
      scrollId: null,
      fila: [],
      scanned: 0,
      options: BASE_OPTIONS,
    });
  });

  it('throws MassImportAlreadyRunningError when a running job already exists for the conta', async () => {
    const db = new FakeDb();
    await startMassImportJob(asDb(db), { integracaoId: 'conta-A', options: BASE_OPTIONS });

    await expect(
      startMassImportJob(asDb(db), { integracaoId: 'conta-A', options: BASE_OPTIONS }),
    ).rejects.toBeInstanceOf(MassImportAlreadyRunningError);
  });

  it('allows a new job once the previous one has completed', async () => {
    const db = new FakeDb();
    const firstId = await startMassImportJob(asDb(db), {
      integracaoId: 'conta-A',
      options: BASE_OPTIONS,
    });
    db.docs('importacoesMercadoLivre').set(firstId, {
      ...db.docs('importacoesMercadoLivre').get(firstId)!,
      status: 'completed',
    });

    const secondId = await startMassImportJob(asDb(db), {
      integracaoId: 'conta-A',
      options: BASE_OPTIONS,
    });
    expect(secondId).not.toBe(firstId);
  });

  it('does not block a running job for a DIFFERENT integração', async () => {
    const db = new FakeDb();
    await startMassImportJob(asDb(db), { integracaoId: 'conta-A', options: BASE_OPTIONS });
    const otherId = await startMassImportJob(asDb(db), {
      integracaoId: 'conta-B',
      options: BASE_OPTIONS,
    });
    expect(db.docs('importacoesMercadoLivre').get(otherId)).toMatchObject({
      integracaoId: 'conta-B',
    });
  });
});

/* ------------------------------- cancelamento ------------------------------ */

describe('cancelMassImportJob', () => {
  const IMPORT_CTX = {
    sellerUserId: 55,
    tabelaNormalOuterRef: 'documents/tabelasDePrecos/tabNormal',
    depositoOuterRef: 'documents/depositos/dep1',
  };

  it('unblocks a job stuck `running` with no worker — the whole reason it exists', async () => {
    const db = new FakeDb();
    seedJob(db, 'job-stuck');

    // An enqueue that succeeded and then never dispatched (a queue/function
    // region mismatch, a missing run.invoker grant) leaves exactly this: a
    // `running` job no worker will ever finish. The already-running guard has
    // no staleness bound, so the button stays 409 until someone clears it.
    await expect(
      startMassImportJob(asDb(db), { integracaoId: 'conta-A', options: BASE_OPTIONS }),
    ).rejects.toBeInstanceOf(MassImportAlreadyRunningError);

    const outcome = await cancelMassImportJob(asDb(db), {
      jobId: 'job-stuck',
      integracaoId: 'conta-A',
      now: CLOCK_NOW,
    });

    expect(outcome).toBe('stamped');
    expect(db.docs('importacoesMercadoLivre').get('job-stuck')).toMatchObject({
      status: 'cancelled',
      finishedAt: CLOCK_NOW,
      updatedAt: CLOCK_NOW,
    });
    await expect(
      startMassImportJob(asDb(db), { integracaoId: 'conta-A', options: BASE_OPTIONS }),
    ).resolves.toEqual(expect.any(String));
  });

  it('refuses a terminal job, a missing job and another conta’s job', async () => {
    const db = new FakeDb();
    seedJob(db, 'job-done', { status: 'completed', finishedAt: CLOCK_NOW });
    seedJob(db, 'job-de-outra-conta');

    await expect(
      cancelMassImportJob(asDb(db), { jobId: 'job-done', integracaoId: 'conta-A' }),
    ).resolves.toBe('not-running');
    await expect(
      cancelMassImportJob(asDb(db), { jobId: 'nao-existe', integracaoId: 'conta-A' }),
    ).resolves.toBe('not-found');
    // The ownership check is what lets the route 404 without revealing whether
    // the id belongs to somebody else's account.
    await expect(
      cancelMassImportJob(asDb(db), { jobId: 'job-de-outra-conta', integracaoId: 'conta-B' }),
    ).resolves.toBe('wrong-integracao');
    expect(db.docs('importacoesMercadoLivre').get('job-de-outra-conta')).toMatchObject({
      status: 'running',
    });
  });

  it('a cancel landing MID-DISPATCH is not overwritten by the completion stamp', async () => {
    const db = new FakeDb();
    seedJob(db, 'job-race');
    const api = makeApi({ scan: { results: [], scroll_id: null } });
    const deps = runDeps(db, api, {
      // Fires AFTER the dispatch's opening status read and BEFORE its terminal
      // stamp — the exact window an unguarded merge() clobbered.
      resolveImportDeps: async () => {
        await cancelMassImportJob(asDb(db), {
          jobId: 'job-race',
          integracaoId: 'conta-A',
          now: CLOCK_NOW,
        });
        return { api, ...IMPORT_CTX };
      },
    });

    const outcome = await processMassImportJob(
      deps,
      { jobId: 'job-race', integracaoId: 'conta-A' },
      0,
    );

    expect(outcome).toBe('noop');
    expect(db.docs('importacoesMercadoLivre').get('job-race')).toMatchObject({
      status: 'cancelled',
    });
  });

  it('a cancel landing MID-DISPATCH stops the self-continuation too', async () => {
    const db = new FakeDb();
    seedJob(db, 'job-race2');
    // Already linked, so the page drains to nothing and no import runs; the
    // non-null scroll_id is what would otherwise re-enqueue.
    db.seed('produtos/prod-MLB1/produtoMercadoLivre', 'lnk-MLB1', {
      id: 'MLB1',
      contaOuterRef: 'documents/integracao/conta-A',
    });
    const api = makeApi({ scan: { results: ['MLB1'], scroll_id: 'SCROLL-1' } });
    const deps = runDeps(db, api, {
      resolveImportDeps: async () => {
        await cancelMassImportJob(asDb(db), {
          jobId: 'job-race2',
          integracaoId: 'conta-A',
          now: CLOCK_NOW,
        });
        return { api, ...IMPORT_CTX };
      },
    });

    const outcome = await processMassImportJob(
      deps,
      { jobId: 'job-race2', integracaoId: 'conta-A' },
      0,
    );

    expect(outcome).toBe('noop');
    expect(deps.scheduler!.enqueue).not.toHaveBeenCalled();
    expect(db.docs('importacoesMercadoLivre').get('job-race2')).toMatchObject({
      status: 'cancelled',
    });
  });
});
