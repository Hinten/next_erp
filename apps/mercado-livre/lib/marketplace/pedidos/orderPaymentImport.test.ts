import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  MercadoLivreHttpError,
  type MercadoLivreApi,
  type MlPayment,
} from '@delfrance/integrations-mercado-livre';
import {
  ESTADOS_PEDIDO_RESERVA,
  FORMA_PAGAMENTO,
  STATUS_PAGAMENTO,
  type EstadoPedido,
} from '@delfrance/schemas';

import {
  PEDIDO_BOOTSTRAP_MAX_FUTURE_SKEW_MS,
  decidirBootstrapPedido,
  importPagamentoMercadoLivre,
  pedidoBootstrapMaxAgeMs,
  type PaymentImportDeps,
} from './orderPaymentImport';
import { makePagamentoIdMercadoLivre } from './orderIds';
import {
  OccEngine,
  type OccOpKind,
  type OccTransaction,
  type OccWriteKind,
} from '@delfrance/data/testing';

/* ------------------------------ fake Firestore ---------------------------- */
// `runTransaction` delegates to the SHARED `OccEngine` (`@delfrance/data/testing`),
// which supplies the read-after-write guard, snapshot reads, buffered writes and
// retry. Everything below stays this file's own.
//
// Extends orderPedidoTx.test.ts's FakeDb (opLog) with: a whole-collection
// `.get()` (the in-tx all-pagamentos read), chained `where('==')/limit/get`
// on a plain collection, and `db.collectionGroup(name)` scanning every seeded
// path whose last segment matches — the `orderML` resolve reaches it via
// `orderMLCollection.groupQuery(db)`. Docs carry `ref.parent.parent.id` (the
// owning pedido id), same convention as `import.test.ts`'s FakeDb.

type DocData = Record<string, unknown>;

interface FakeSnap {
  exists: boolean;
  id: string;
  data: () => DocData | undefined;
}

interface FakeDocRef {
  id: string;
  /** Firestore path — the engine's version key. Real refs carry this too. */
  path: string;
  get: () => Promise<FakeSnap>;
  set: (data: DocData) => void;
  create: (data: DocData) => void;
  update: (patch: DocData) => void;
}

interface FakeQueryDoc {
  id: string;
  data: () => DocData;
  exists: true;
  ref: { id: string; parent: { parent: { id: string | null } } };
}

interface FakeQuery {
  where: (field: string, op: string, value: unknown) => FakeQuery;
  limit: (n: number) => FakeQuery;
  get: () => Promise<{ docs: FakeQueryDoc[]; empty: boolean }>;
}

interface FakeCollection {
  /** Firestore path — the in-tx whole-collection read is version-keyed on it. */
  path: string;
  doc: (id?: string) => FakeDocRef;
  get: () => Promise<{ docs: FakeQueryDoc[] }>;
  where: (field: string, op: string, value: unknown) => FakeQuery;
}

/** `pedidos/{pedidoId}/orderML` → `pedidoId` (second-to-last path segment). */
function parentDocId(path: string): string | null {
  const parts = path.split('/');
  return parts.length >= 2 ? (parts[parts.length - 2] ?? null) : null;
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly opLog: Array<{ op: OccOpKind; path: string }> = [];
  private autoN = 0;

  /** Exposed so a test can set `db.occ.beforeCommit` / read `db.occ.txLog`. */
  readonly occ = new OccEngine({
    applyWrite: (kind, path, data) => this.applyWrite(kind, path, data),
    logWrite: (op, path) => this.opLog.push({ op, path }),
  });

  private col(path: string): Map<string, DocData> {
    let c = this.cols.get(path);
    if (!c) this.cols.set(path, (c = new Map()));
    return c;
  }

  /** Commit-time write. Never logs — the engine logged it at call time. */
  private applyWrite(kind: OccWriteKind, docPath: string, data: DocData): void {
    const cut = docPath.lastIndexOf('/');
    const col = this.col(docPath.slice(0, cut));
    const id = docPath.slice(cut + 1);
    if (kind === 'create' && col.has(id)) {
      throw Object.assign(new Error('already exists'), { code: 6 });
    }
    if (kind === 'update' && !col.has(id)) {
      throw Object.assign(new Error('not found'), { code: 5 });
    }
    col.set(id, kind === 'update' ? { ...(col.get(id) ?? {}), ...data } : { ...data });
  }

  seed(path: string, id: string, data: DocData): void {
    this.col(path).set(id, data);
  }
  docs(path: string): Map<string, DocData> {
    return this.col(path);
  }

  private makeQuery(entries: Array<{ id: string; data: DocData; path: string }>): FakeQuery {
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
          docs: rows.map((e) => ({
            id: e.id,
            data: () => e.data,
            exists: true as const,
            ref: { id: e.id, parent: { parent: { id: parentDocId(e.path) } } },
          })),
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
      path: `${path}/${id}`,
      get: async () => {
        self.opLog.push({ op: 'get', path: `${path}/${id}` });
        return { exists: col.has(id), id, data: () => col.get(id) };
      },
      set: (data: DocData) => {
        self.opLog.push({ op: 'set', path: `${path}/${id}` });
        self.applyWrite('set', `${path}/${id}`, data);
      },
      create: (data: DocData) => {
        self.opLog.push({ op: 'create', path: `${path}/${id}` });
        self.applyWrite('create', `${path}/${id}`, data);
      },
      update: (patch: DocData) => {
        self.opLog.push({ op: 'update', path: `${path}/${id}` });
        self.applyWrite('update', `${path}/${id}`, patch);
      },
    };
  }

  collection(path: string): FakeCollection {
    const self = this;
    const col = this.col(path);
    return {
      path,
      doc(id?: string) {
        const docId = id ?? `auto-${++self.autoN}`;
        return self.makeDocRef(path, docId);
      },
      async get() {
        self.opLog.push({ op: 'get', path: `${path}#all` });
        return {
          docs: [...col.entries()].map(([id, d]) => ({
            id,
            data: () => d,
            exists: true as const,
            ref: { id, parent: { parent: { id: parentDocId(path) } } },
          })),
        };
      },
      where(field, op, value) {
        const entries = [...col.entries()].map(([id, d]) => ({ id, data: d, path }));
        return self.makeQuery(entries).where(field, op, value);
      },
    };
  }

  collectionGroup(groupId: string): FakeQuery {
    const entries: Array<{ id: string; data: DocData; path: string }> = [];
    for (const [path, col] of this.cols) {
      if (path.split('/').pop() === groupId) {
        for (const [id, d] of col) entries.push({ id, data: d, path });
      }
    }
    return this.makeQuery(entries);
  }

  async runTransaction<T>(fn: (tx: OccTransaction) => Promise<T>): Promise<T> {
    return this.occ.runTransaction(fn);
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/**
 * The WRITES a run performed. `opLog` also records reads, and the bootstrap
 * guards necessarily run the `orderML` lookup first — so `opLog.length === 0`
 * would be asserting the lookup never happened, not that nothing was written.
 */
const escritas = (db: FakeDb) => db.opLog.filter((o) => o.op !== 'get');

/* --------------------------------- fixtures ------------------------------- */

const CONTA_ID = 'conta-A';
const NOW_US = Date.parse('2026-07-23T00:00:00.000Z') * 1000;

function makeDb(): FakeDb {
  const db = new FakeDb();
  // Minimal `integracao` doc — `loadContaBag` soft-reads it; an absent doc
  // would ALSO work (parseSoftRead tolerates a missing/invalid doc and
  // returns `{}`), but seeding it keeps `console.warn` quiet in test output.
  db.seed('integracao', CONTA_ID, { cpf_cnpj: null });
  return db;
}

function seedPedido(db: FakeDb, pedidoId: string, over: DocData = {}): void {
  db.seed('pedidos', pedidoId, {
    estado: 'aguardandoConfirmacaoDePagamento',
    valorCobrado: null,
    // The `pago` prerequisites (#791): this path now shares ONE definition with
    // the order import (`podeAvancarParaPago`), so a pedido used to exercise the
    // SUM logic has to be otherwise eligible. Tests that probe the guard itself
    // override these to null.
    clientePedidoOuterRef: 'documents/clientes/cli-1',
    enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
    freteInicial: { estado: 'iniciado' },
    ...over,
  });
}

function seedOrderMl(db: FakeDb, pedidoId: string, orderMlId: string, over: DocData = {}): void {
  db.seed(`pedidos/${pedidoId}/orderML`, orderMlId, {
    id: Number(orderMlId),
    pack_id: null,
    ...over,
  });
}

/** Local `MlPayment` factory — casts through `unknown` for the fields A4
 * (`marketplace`/`external_reference`/`order_id`) adds to `mlPaymentSchema`
 * concurrently with this PR (cross-agent contract; see the task notes). */
function payment(over: Record<string, unknown> = {}): MlPayment {
  return {
    id: 900001,
    status: 'approved',
    marketplace: 'MELI',
    external_reference: null,
    order_id: null,
    transaction_amount: 100,
    installments: 1,
    payment_type: 'credit_card',
    payment_method_id: 'master',
    last_modified: '2026-07-20T10:00:00.000Z',
    date_last_updated: '2026-07-20T10:00:00.000Z',
    date_created: '2026-07-20T10:00:00.000Z',
    date_approved: '2026-07-20T10:00:05.000Z',
    refunds: [],
    ...over,
  } as unknown as MlPayment;
}

function makeApi(payments: Record<number, MlPayment>): MercadoLivreApi {
  return {
    getPayment: async (id: number | string) => {
      const key = typeof id === 'string' ? Number(id) : id;
      const p = payments[key];
      if (!p) throw new MercadoLivreHttpError('not found', 404, null);
      return p;
    },
  } as unknown as MercadoLivreApi;
}

function baseDeps(
  db: FakeDb,
  api: MercadoLivreApi,
  over: Partial<PaymentImportDeps> = {},
): PaymentImportDeps {
  return { db: asDb(db), api, contaId: CONTA_ID, nowUs: NOW_US, ...over };
}

// `loadContaBag` now shares a module-scope cache keyed by the document PATH, so
// a fresh `FakeDb` per test does NOT isolate it and every test here uses the
// same `CONTA_ID`.
beforeEach(() => {
  __resetAllReadCaches();
});

afterEach(() => {
  __resetAllReadCaches();
});

/* --------------------------------- tests ----------------------------------- */

describe('importPagamentoMercadoLivre — primary GET + pure guards', () => {
  it('skips with payment-404 on a 404 from getPayment', async () => {
    const db = makeDb();
    const api = makeApi({});
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 12345);
    expect(res).toEqual({ pedidoId: null, orderId: null, skipped: 'payment-404' });
  });

  it('propagates a non-404 / network error from getPayment (transient — no swallow)', async () => {
    const db = makeDb();
    const api: MercadoLivreApi = {
      getPayment: async () => {
        throw new Error('ECONNRESET');
      },
    } as unknown as MercadoLivreApi;
    await expect(importPagamentoMercadoLivre(baseDeps(db, api), 1)).rejects.toThrow('ECONNRESET');
  });

  it('skips with marketplace-none and ZERO Firestore ops for a non-marketplace payment', async () => {
    const db = makeDb();
    const api = makeApi({ 706: payment({ id: 706, marketplace: 'NONE' }) });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 706);
    expect(res).toEqual({ pedidoId: null, orderId: null, skipped: 'marketplace-none' });
    expect(db.opLog.length).toBe(0);
  });

  it('skips with sem-order-key when both external_reference and order_id are null', async () => {
    const db = makeDb();
    const api = makeApi({ 707: payment({ id: 707, external_reference: null, order_id: null }) });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 707);
    expect(res).toEqual({ pedidoId: null, orderId: null, skipped: 'sem-order-key' });
    expect(db.opLog.length).toBe(0);
  });

  it('skips with sem-order-key when external_reference is non-numeric', async () => {
    const db = makeDb();
    const api = makeApi({ 708: payment({ id: 708, external_reference: 'abc-not-a-number' }) });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 708);
    expect(res).toEqual({ pedidoId: null, orderId: null, skipped: 'sem-order-key' });
  });
});

describe('importPagamentoMercadoLivre — orderML resolution', () => {
  it('external_reference wins over order_id when both are present', async () => {
    const db = makeDb();
    seedPedido(db, 'PED-EXT');
    seedOrderMl(db, 'PED-EXT', '4321', { id: 4321 });

    // order_id points at an id with NO orderML doc at all — external_reference must win.
    const api = makeApi({
      709: payment({ id: 709, external_reference: '4321', order_id: 999999 }),
    });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 709);
    expect(res.pedidoId).toBe('PED-EXT');
    expect(res.skipped).toBeNull();
  });

  it('resolves via orderML pack_id match', async () => {
    const db = makeDb();
    seedPedido(db, 'PED-PACK');
    seedOrderMl(db, 'PED-PACK', '5001', { id: 5001, pack_id: 9000 });

    const api = makeApi({ 710: payment({ id: 710, order_id: 9000 }) });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 710);
    expect(res.pedidoId).toBe('PED-PACK');
  });

  it('falls back to orderML id match when no pack_id hit exists', async () => {
    const db = makeDb();
    seedPedido(db, 'PED-ID');
    seedOrderMl(db, 'PED-ID', '8001', { id: 8001, pack_id: null });

    const api = makeApi({ 711: payment({ id: 711, order_id: 8001 }) });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 711);
    expect(res.pedidoId).toBe('PED-ID');
  });

  it('reports pedido-nao-encontrado WITH the orderId when no orderML doc matches (#1087)', async () => {
    const db = makeDb();
    const api = makeApi({ 712: payment({ id: 712, order_id: 424242 }) });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 712);
    // The SEAM still holds — this handler creates NO pedido and writes nothing.
    // What changed is that it now hands the caller the order key, so the
    // dispatcher can ask the `orders_v2` topic to import it.
    expect(res).toEqual({ pedidoId: null, orderId: 424242, skipped: 'pedido-nao-encontrado' });
    expect(escritas(db)).toEqual([]);
  });
});

/**
 * #1087 (review) — the RELEASE arm. A pedido this channel bootstrapped sits at
 * `aguardandoConfirmacaoDePagamento`, which HOLDS a stock reservation. When the
 * payment then dies, this topic is the surface that reliably arrives: a
 * never-seller-visible order fires no `orders_v2` even to say it was cancelled.
 * Without this the unit stays reserved forever.
 */
describe('importPagamentoMercadoLivre — releases the reserva when the sale dies', () => {
  const CASOS: ReadonlyArray<readonly [string, string]> = [
    ['rejected', 'pagamentoNaoRealizado'],
    ['cancelled', 'cancelado'],
    ['refunded', 'estornadoIntegralmente'],
    ['charged_back', 'estornadoIntegralmente'],
  ];

  it.each(CASOS)('a %s payment moves the pedido to %s', async (statusMl, esperado) => {
    const db = makeDb();
    seedPedido(db, 'PED-REL', { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 100 });
    seedOrderMl(db, 'PED-REL', '900', { id: 900 });
    const api = makeApi({ 950: payment({ id: 950, order_id: 900, status: statusMl }) });

    await importPagamentoMercadoLivre(baseDeps(db, api), 950);

    expect(db.docs('pedidos').get('PED-REL')).toMatchObject({ estado: esperado });
  });

  it('the released estado is OUT of the reserva set — that is the whole point', async () => {
    const db = makeDb();
    seedPedido(db, 'PED-REL', { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 100 });
    seedOrderMl(db, 'PED-REL', '900', { id: 900 });
    const api = makeApi({ 951: payment({ id: 951, order_id: 900, status: 'cancelled' }) });

    await importPagamentoMercadoLivre(baseDeps(db, api), 951);

    const estado = db.docs('pedidos').get('PED-REL')!.estado as EstadoPedido;
    expect(ESTADOS_PEDIDO_RESERVA.has(estado)).toBe(false);
  });

  it('REFUSES to release while another pagamento is aprovado — still a live sale', async () => {
    // A partially-paid pedido whose SECOND payment was rejected has real money on
    // it. Releasing there would drop a reservation the sale still needs.
    const db = makeDb();
    seedPedido(db, 'PED-REL', { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 500 });
    seedOrderMl(db, 'PED-REL', '900', { id: 900 });
    db.seed('pedidos/PED-REL/pagamentos', 'outro', {
      id: '111',
      valor: 100,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });
    const api = makeApi({ 952: payment({ id: 952, order_id: 900, status: 'rejected' }) });

    await importPagamentoMercadoLivre(baseDeps(db, api), 952);

    expect(db.docs('pedidos').get('PED-REL')).toMatchObject({
      estado: 'aguardandoConfirmacaoDePagamento',
    });
  });

  it('never touches an estado the business owns — pago is off the FROM-set', async () => {
    const db = makeDb();
    seedPedido(db, 'PED-REL', { estado: 'pago', valorCobrado: 100 });
    seedOrderMl(db, 'PED-REL', '900', { id: 900 });
    const api = makeApi({ 953: payment({ id: 953, order_id: 900, status: 'cancelled' }) });

    await importPagamentoMercadoLivre(baseDeps(db, api), 953);

    expect(db.docs('pedidos').get('PED-REL')).toMatchObject({ estado: 'pago' });
  });

  it('leaves a LIVE payment alone', async () => {
    const db = makeDb();
    seedPedido(db, 'PED-REL', { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 500 });
    seedOrderMl(db, 'PED-REL', '900', { id: 900 });
    const api = makeApi({ 954: payment({ id: 954, order_id: 900, status: 'pending' }) });

    await importPagamentoMercadoLivre(baseDeps(db, api), 954);

    expect(db.docs('pedidos').get('PED-REL')).toMatchObject({
      estado: 'aguardandoConfirmacaoDePagamento',
    });
  });
});

describe('importPagamentoMercadoLivre — pedido bootstrap guards (#1087)', () => {
  /**
   * ⚠️ The default fixture is 62h old against `NOW_US` (`date_created`
   * 2026-07-20T10:00Z vs 2026-07-23T00:00Z) — INSIDE the 72h bound. Every
   * "expired" case must therefore override `date_created` explicitly; relying on
   * the default would assert nothing.
   */
  const AGORA = new Date(NOW_US / 1000).toISOString();
  const HORAS = (h: number) => new Date(NOW_US / 1000 - h * 3_600_000).toISOString();

  it('refuses the bootstrap when the payment is older than the max age', async () => {
    const db = makeDb();
    const api = makeApi({ 720: payment({ id: 720, order_id: 555, date_created: HORAS(73) }) });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 720);
    expect(res).toEqual({
      pedidoId: null,
      orderId: 555,
      skipped: 'pedido-nao-encontrado-expirado',
    });
    expect(escritas(db)).toEqual([]);
  });

  it('allows the bootstrap just inside the max age', async () => {
    const db = makeDb();
    const api = makeApi({ 721: payment({ id: 721, order_id: 556, date_created: HORAS(71) }) });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 721);
    expect(res.skipped).toBe('pedido-nao-encontrado');
  });

  it('refuses a payment dated FAR in the future — the skew half of the bound', async () => {
    // Without an upper bound `now - created` stays negative and can never exceed
    // the max age, so a forward-dated payment would be immortal. This is the bug
    // `@delfrance/data/admin/oauth-state` documents as `MAX_FUTURE_SKEW_MS`.
    const db = makeDb();
    const api = makeApi({ 722: payment({ id: 722, order_id: 557, date_created: HORAS(-24) }) });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 722);
    expect(res.skipped).toBe('pedido-nao-encontrado-expirado');
  });

  it('tolerates a small forward skew', async () => {
    const db = makeDb();
    const api = makeApi({
      723: payment({ id: 723, order_id: 558, date_created: HORAS(-1 / 60) }),
    });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 723);
    expect(res.skipped).toBe('pedido-nao-encontrado');
  });

  it.each(['rejected', 'cancelled', 'refunded', 'charged_back'])(
    'refuses the bootstrap for a terminally dead payment (%s) — nothing to reserve',
    async (status) => {
      const db = makeDb();
      const api = makeApi({ 730: payment({ id: 730, order_id: 559, status }) });
      const res = await importPagamentoMercadoLivre(baseDeps(db, api), 730);
      expect(res).toEqual({
        pedidoId: null,
        orderId: 559,
        skipped: 'pedido-nao-encontrado-pagamento-morto',
      });
      expect(escritas(db)).toEqual([]);
    },
  );

  it.each(['pending', 'in_process', 'authorized', 'approved'])(
    'bootstraps for a live payment status (%s)',
    async (status) => {
      const db = makeDb();
      const api = makeApi({ 731: payment({ id: 731, order_id: 560, status }) });
      const res = await importPagamentoMercadoLivre(baseDeps(db, api), 731);
      expect(res.skipped).toBe('pedido-nao-encontrado');
    },
  );

  it('bootstraps on an ML status this port has not catalogued — conservative toward stock', async () => {
    const db = makeDb();
    const api = makeApi({ 732: payment({ id: 732, order_id: 561, status: 'quantum_pending' }) });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 732);
    expect(res.skipped).toBe('pedido-nao-encontrado');
  });

  it('FAILS OPEN on an unreadable date_created — null is not age 0', async () => {
    // `coerceToMicros` returns null for three distinct reasons (absent,
    // unparseable, or a bare number in the ms/µs dead zone) and none of them
    // means "brand new". Failing open is the house convention AND the direction
    // that holds stock.
    const db = makeDb();
    const api = makeApi({ 733: payment({ id: 733, order_id: 562, date_created: null }) });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 733);
    expect(res.skipped).toBe('pedido-nao-encontrado');
  });

  it('decidirBootstrapPedido is pure and honours an injected horizon', () => {
    const umaHoraUs = 3_600_000_000;
    expect(
      decidirBootstrapPedido({
        criadoUs: NOW_US - 2 * umaHoraUs,
        statusMl: 'pending',
        nowUs: NOW_US,
        maxAgeMs: 60 * 60 * 1000,
      }),
    ).toBe('pedido-nao-encontrado-expirado');
    expect(
      decidirBootstrapPedido({
        criadoUs: NOW_US - umaHoraUs / 2,
        statusMl: 'pending',
        nowUs: NOW_US,
        maxAgeMs: 60 * 60 * 1000,
      }),
    ).toBe('bootstrap');
    // A dead payment is refused regardless of how fresh it is.
    expect(decidirBootstrapPedido({ criadoUs: NOW_US, statusMl: 'cancelled', nowUs: NOW_US })).toBe(
      'pedido-nao-encontrado-pagamento-morto',
    );
    expect(AGORA).toContain('2026-07-23');
  });

  it('pins the default horizon at 72h and the skew tolerance', () => {
    // The env override is the operator knob; the DEFAULT is the promise.
    delete process.env.MERCADO_LIVRE_PEDIDO_BOOTSTRAP_MAX_AGE_H;
    expect(pedidoBootstrapMaxAgeMs()).toBe(72 * 60 * 60 * 1000);
    process.env.MERCADO_LIVRE_PEDIDO_BOOTSTRAP_MAX_AGE_H = '6';
    expect(pedidoBootstrapMaxAgeMs()).toBe(6 * 60 * 60 * 1000);
    // A junk override falls back rather than collapsing the window to zero.
    process.env.MERCADO_LIVRE_PEDIDO_BOOTSTRAP_MAX_AGE_H = 'nonsense';
    expect(pedidoBootstrapMaxAgeMs()).toBe(72 * 60 * 60 * 1000);
    delete process.env.MERCADO_LIVRE_PEDIDO_BOOTSTRAP_MAX_AGE_H;
    expect(PEDIDO_BOOTSTRAP_MAX_FUTURE_SKEW_MS).toBe(5 * 60 * 1000);
  });
});

describe('importPagamentoMercadoLivre — create + staleness', () => {
  it('creates a pagamento at the deterministic sha256 id', async () => {
    const db = makeDb();
    seedPedido(db, 'PED-CREATE');
    seedOrderMl(db, 'PED-CREATE', '500', { id: 500 });

    const api = makeApi({ 1200: payment({ id: 1200, order_id: 500, transaction_amount: 77 }) });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 1200);

    expect(res).toEqual({ pedidoId: 'PED-CREATE', orderId: 500, skipped: null });
    const expectedId = makePagamentoIdMercadoLivre(CONTA_ID, 1200);
    const stored = db.docs('pedidos/PED-CREATE/pagamentos').get(expectedId);
    expect(stored).toBeTruthy();
    expect(stored!.valor).toBe(77);
  });

  it('skips with stale + zero writes when the stored pagamento is at least as fresh', async () => {
    const db = makeDb();
    seedPedido(db, 'PED-STALE');
    seedOrderMl(db, 'PED-STALE', '111', { id: 111 });
    const pagId = makePagamentoIdMercadoLivre(CONTA_ID, 800);
    db.seed('pedidos/PED-STALE/pagamentos', pagId, {
      id: '800',
      valor: 999,
      ultimaModificacao: Date.parse('2026-07-22T00:00:00.000Z') * 1000,
    });

    const api = makeApi({
      800: payment({ id: 800, order_id: 111, last_modified: '2026-07-20T00:00:00.000Z' }),
    });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 800);

    expect(res).toEqual({ pedidoId: 'PED-STALE', orderId: 111, skipped: 'stale' });
    expect(db.docs('pedidos/PED-STALE/pagamentos').get(pagId)!.valor).toBe(999); // untouched
  });

  it('proceeds when the stored pagamento has a null ultimaModificacao (null-tolerant)', async () => {
    const db = makeDb();
    seedPedido(db, 'PED-NULLSTALE');
    seedOrderMl(db, 'PED-NULLSTALE', '112', { id: 112 });
    const pagId = makePagamentoIdMercadoLivre(CONTA_ID, 801);
    db.seed('pedidos/PED-NULLSTALE/pagamentos', pagId, {
      id: '801',
      valor: 50,
      ultimaModificacao: null,
    });

    const api = makeApi({ 801: payment({ id: 801, order_id: 112, transaction_amount: 200 }) });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 801);

    expect(res.skipped).toBeNull();
    expect(db.docs('pedidos/PED-NULLSTALE/pagamentos').get(pagId)!.valor).toBe(200);
  });

  it('every read inside the transaction happens before the first write', async () => {
    const db = makeDb();
    seedPedido(db, 'PED-ORDER');
    seedOrderMl(db, 'PED-ORDER', '400', { id: 400 });

    const api = makeApi({ 1100: payment({ id: 1100, order_id: 400, transaction_amount: 100 }) });
    await importPagamentoMercadoLivre(baseDeps(db, api), 1100);

    const firstWriteIdx = db.opLog.findIndex((o) => o.op !== 'get');
    expect(firstWriteIdx).toBeGreaterThan(-1);
    const readsAfterFirstWrite = db.opLog.slice(firstWriteIdx).some((o) => o.op === 'get');
    expect(readsAfterFirstWrite).toBe(false);
  });
});

describe('importPagamentoMercadoLivre — update-merge (existing pagamento)', () => {
  it('unconditional fields take the new value; nullable mapped fields fall back; untouched fields survive', async () => {
    const db = makeDb();
    seedPedido(db, 'PED-MERGE');
    seedOrderMl(db, 'PED-MERGE', '222', { id: 222 });
    const pagId = makePagamentoIdMercadoLivre(CONTA_ID, 900);
    db.seed('pedidos/PED-MERGE/pagamentos', pagId, {
      id: '900',
      forma_de_pagamento: FORMA_PAGAMENTO.outros,
      valor: 1,
      parcelas: 9,
      aVista: false,
      duplicata: true,
      status_pagamento: STATUS_PAGAMENTO.pendente,
      cartao: { tpIntegra: '2', bandeira: 5, numeroCartao: 'OLD-CARD' },
      descricaoPagamento: 'old desc',
      // Realistic µs values — pagamentoSchema's tolerant datetime reader
      // normalizes small numbers as ms (×1000), so a toy value like `12345`
      // would NOT round-trip through `pagamentoCollection.parse` unchanged.
      dataAprovacao: Date.parse('2026-06-15T00:00:00.000Z') * 1000,
      metodoPagamentoOuterRef: 'documents/metodo_pgto/abc',
      juros: 3.5,
      nFat: 'NF-1',
      vencimento: Date.parse('2026-08-01T00:00:00.000Z') * 1000,
      ultimaModificacao: Date.parse('2026-07-01T00:00:00.000Z') * 1000, // OLDER than incoming
    });

    // account_money → mapped.cartao is null; date_approved null → mapped.dataAprovacao is null.
    const api = makeApi({
      900: payment({
        id: 900,
        order_id: 222,
        payment_type: 'account_money',
        payment_method_id: 'account_money',
        date_approved: null,
        transaction_amount: 250,
        installments: 1,
        last_modified: '2026-07-20T00:00:00.000Z',
      }),
    });

    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 900);
    expect(res.skipped).toBeNull();

    const stored = db.docs('pedidos/PED-MERGE/pagamentos').get(pagId)!;
    // unconditional fields: new value wins even though the "stale-looking" stored values differed.
    expect(stored.forma_de_pagamento).toBe(FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria);
    expect(stored.valor).toBe(250);
    expect(stored.parcelas).toBe(1);
    expect(stored.aVista).toBe(true);
    expect(stored.duplicata).toBe(false);
    // nullable mapped fields: mapped is null here → the stored value survives.
    expect(stored.cartao).toEqual({ tpIntegra: '2', bandeira: 5, numeroCartao: 'OLD-CARD' });
    expect(stored.dataAprovacao).toBe(Date.parse('2026-06-15T00:00:00.000Z') * 1000);
    // fields the mapper never sets at all: untouched.
    expect(stored.metodoPagamentoOuterRef).toBe('documents/metodo_pgto/abc');
    expect(stored.juros).toBe(3.5);
    expect(stored.nFat).toBe('NF-1');
    expect(stored.vencimento).toBe(Date.parse('2026-08-01T00:00:00.000Z') * 1000);
  });
});

describe('importPagamentoMercadoLivre — estado advance', () => {
  it('advances pedido to pago when total approved (target + others, excluding the target stored copy) meets valorCobrado', async () => {
    const db = makeDb();
    seedPedido(db, 'PED-ADV', { estado: 'emProcessamento', valorCobrado: 150, numero: 'X' });
    seedOrderMl(db, 'PED-ADV', '333', { id: 333 });

    const targetPagId = makePagamentoIdMercadoLivre(CONTA_ID, 1000);
    // A stale STORED copy of the target itself — its OLD status/valor must be
    // EXCLUDED from the "other pagamentos" sum (the target's contribution
    // comes from the freshly-mapped incoming payment, not this stored row).
    db.seed('pedidos/PED-ADV/pagamentos', targetPagId, {
      id: '1000',
      valor: 1,
      status_pagamento: STATUS_PAGAMENTO.pendente,
      ultimaModificacao: 0,
    });
    // another approved payment — contributes 50.
    db.seed('pedidos/PED-ADV/pagamentos', 'other-1', {
      id: '2000',
      valor: 50,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });
    // a non-approved payment — must NOT count.
    db.seed('pedidos/PED-ADV/pagamentos', 'other-2', {
      id: '3000',
      valor: 500,
      status_pagamento: STATUS_PAGAMENTO.pendente,
    });

    // target's mapped valor = 100, aprovado → contributes 100. 100 + 50 = 150 >= 150.
    const api = makeApi({
      1000: payment({ id: 1000, order_id: 333, status: 'approved', transaction_amount: 100 }),
    });
    const nowUs = Date.parse('2026-07-23T12:00:00.000Z') * 1000;
    const res = await importPagamentoMercadoLivre(baseDeps(db, api, { nowUs }), 1000);

    expect(res.skipped).toBeNull();
    const pedido = db.docs('pedidos').get('PED-ADV')!;
    expect(pedido.estado).toBe('pago');
    expect(pedido.ultimaModificacao).toBe(nowUs);
    // `lastMarketplaceUpdate` is the ML ORDER-clock watermark and the order
    // import is its single writer — the payments topic must not touch it.
    expect(pedido.lastMarketplaceUpdate).toBeUndefined();
    expect(pedido.numero).toBe('X'); // untouched field proves a TARGETED patch
  });

  it('does NOT advance when the approved sum is below valorCobrado', async () => {
    const db = makeDb();
    seedPedido(db, 'PED-BELOW', { estado: 'emProcessamento', valorCobrado: 1000 });
    seedOrderMl(db, 'PED-BELOW', '334', { id: 334 });

    const api = makeApi({ 1001: payment({ id: 1001, order_id: 334, transaction_amount: 10 }) });
    await importPagamentoMercadoLivre(baseDeps(db, api), 1001);

    expect(db.docs('pedidos').get('PED-BELOW')!.estado).toBe('emProcessamento');
  });

  it('does NOT advance when the pedido estado is not emProcessamento', async () => {
    const db = makeDb();
    seedPedido(db, 'PED-WRONGSTATE', { estado: 'pago', valorCobrado: 1 });
    seedOrderMl(db, 'PED-WRONGSTATE', '335', { id: 335 });

    const api = makeApi({ 1002: payment({ id: 1002, order_id: 335, transaction_amount: 999 }) });
    const res = await importPagamentoMercadoLivre(baseDeps(db, api), 1002);

    expect(res.skipped).toBeNull();
    expect(db.docs('pedidos').get('PED-WRONGSTATE')!.estado).toBe('pago');
  });

  it('does NOT advance when valorCobrado is null', async () => {
    const db = makeDb();
    seedPedido(db, 'PED-NOVALOR', { estado: 'emProcessamento', valorCobrado: null });
    seedOrderMl(db, 'PED-NOVALOR', '336', { id: 336 });

    const api = makeApi({ 1003: payment({ id: 1003, order_id: 336, transaction_amount: 999 }) });
    await importPagamentoMercadoLivre(baseDeps(db, api), 1003);

    expect(db.docs('pedidos').get('PED-NOVALOR')!.estado).toBe('emProcessamento');
  });

  it('does NOT advance when the target payment itself is not aprovado (its contribution is 0)', async () => {
    const db = makeDb();
    seedPedido(db, 'PED-NOTAPPROVED', { estado: 'emProcessamento', valorCobrado: 10 });
    seedOrderMl(db, 'PED-NOTAPPROVED', '337', { id: 337 });

    const api = makeApi({
      1004: payment({ id: 1004, order_id: 337, status: 'pending', transaction_amount: 100 }),
    });
    await importPagamentoMercadoLivre(baseDeps(db, api), 1004);

    expect(db.docs('pedidos').get('PED-NOTAPPROVED')!.estado).toBe('emProcessamento');
  });
});
