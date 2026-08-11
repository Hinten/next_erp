import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MercadoLivreHttpError, type MercadoLivreApi } from '@delfrance/integrations-mercado-livre';

// Isolate this handler's own orchestration from `resolvePrazoDespacho`'s
// internal decision tree (SLA fetch / schedule search) — that module has its
// own dedicated test file (`orderPrazoDespacho.test.ts`). Everything else
// (`orderImport.ts`'s `loadContaBag`/`mergeFreteInicial`/
// `resolveMercadoEnviosIntFreteOuterRef`, `orderShipmentMapping.ts`'s real
// mapper + `mergeEstadoFretePreservando`) runs FOR REAL against the FakeDb
// below, since several cases here assert on their actual merge output.
vi.mock('./orderPrazoDespacho', () => ({
  resolvePrazoDespacho: vi.fn(async () => null),
}));

import { resolvePrazoDespacho } from './orderPrazoDespacho';
import { importShipmentMercadoLivre, type ShipmentImportDeps } from './orderShipmentImport';
import {
  OccEngine,
  type OccOpKind,
  type OccTransaction,
  type OccWriteKind,
} from './testing/occTransaction';

/* ------------------------------ fake Firestore ---------------------------- */
// Own copy of the STORE (a concurrent agent owns `orderPaymentImport.test.ts`);
// the transaction semantics are the SHARED `OccEngine` (`./testing/occTransaction`),
// because a per-file OCC model that drifts is worse than none.
// Scoped to what `orderShipmentImport.ts` touches: `integracao`, `int_frete`,
// `pedidos/{pedidoId}/orderML` (collectionGroup, docs carry `ref.parent.parent.id`
// — same pattern as `import.test.ts`), and `pedidos` (doc get/update inside the
// one transaction). `opLog` + the engine's reads-before-writes guard back this
// handler's own "exactly one read" contract — it relies on the guard being
// real, not decorative.

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
  update: (patch: DocData) => Promise<void>;
}

function parentDocId(colPath: string): string {
  const segs = colPath.split('/').filter(Boolean);
  return segs[segs.length - 2] ?? '';
}

class FakeDb {
  readonly cols = new Map<string, Map<string, DocData>>();
  readonly opLog: Array<{ op: OccOpKind; path: string }> = [];
  private readonly patches = new Map<string, DocData>();
  private autoN = 0;

  /** Exposed so a test can set `db.occ.beforeCommit` / read `db.occ.txLog`. */
  readonly occ = new OccEngine({
    applyWrite: (kind, path, data) => this.applyWrite(kind, path, data),
    logWrite: (op, path) => this.opLog.push({ op, path }),
    // `lastPatch` means "the patch actually stored", so it is recorded at
    // COMMIT — an attempt that aborts must not leave its patch behind.
    recordPatch: (path, patch) => this.patches.set(path, patch),
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
  /** The last `update()` patch object written at `path/id` — for asserting the write's exact shape. */
  lastPatch(path: string, id: string): DocData | undefined {
    return this.patches.get(`${path}/${id}`);
  }

  private query(entries: Array<[string, DocData, string]>) {
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
        let rows = entries.filter(([, d]) => clauses.every(([f, v]) => d[f] === v));
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
      update: async (patch: DocData) => {
        self.opLog.push({ op: 'update', path: `${path}/${id}` });
        self.patches.set(`${path}/${id}`, patch);
        self.applyWrite('update', `${path}/${id}`, patch);
      },
    };
  }

  collection(path: string) {
    const self = this;
    const col = this.col(path);
    return {
      path,
      doc: (id?: string) => self.makeDocRef(path, id ?? `auto-${++self.autoN}`),
      where: (field: string, op: string, value: unknown) =>
        self.query([...col.entries()].map(([id, d]) => [id, d, path])).where(field, op, value),
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

  async runTransaction<T>(fn: (tx: OccTransaction) => Promise<T>): Promise<T> {
    return this.occ.runTransaction(fn);
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* --------------------------------- fixtures ------------------------------- */

const INTEGRACAO_ID = 'conta-A';
const SELLER_USER_ID = 555;
const NOW_US = Date.parse('2026-02-01T00:00:00.000Z') * 1000;

function seedConta(db: FakeDb, over: DocData = {}): void {
  db.seed('integracao', INTEGRACAO_ID, {
    tipo: 1,
    nome: 'Loja ML',
    ativo: true,
    user_id: SELLER_USER_ID,
    cpf_cnpj: '11222333000144',
    operacaoOuterRef: 'documents/operacao/op1',
    tabelaNormalOuterRef: 'documents/tabelasDePrecos/tabNormal',
    modalidadeFreteImportacao: null,
    ...over,
  });
}

/**
 * ⚠️ The back-ref is seeded in the BARE `integracao/<id>` form on purpose: since #782
 * `resolveMercadoEnviosIntFreteOuterRef` first tries an indexed equality on the
 * canonical `documents/integracao/<id>`, and this fixture is what keeps the tolerant
 * fallback scan honest. `seedIntFreteCanonico` below covers the indexed path.
 */
function seedIntFrete(db: FakeDb, id = 'if-1'): void {
  db.seed('int_frete', id, {
    tipo: 'mercadoLivre',
    ativo: true,
    contaMercadoLivreMercadoEnviosOuterRef: `integracao/${INTEGRACAO_ID}`,
    dataCadastro: 1000,
  });
}

/** The shape the #782 trigger actually writes — resolved by the indexed equality. */
function seedIntFreteCanonico(db: FakeDb, id = 'if-1'): void {
  db.seed('int_frete', id, {
    tipo: 'mercadoLivre',
    ativo: true,
    contaMercadoLivreMercadoEnviosOuterRef: `documents/integracao/${INTEGRACAO_ID}`,
    dataCadastro: 1000,
  });
}

function seedOrderMl(
  db: FakeDb,
  pedidoId: string,
  orderId: number,
  opts: { packId?: number | null } = {},
): void {
  db.seed(`pedidos/${pedidoId}/orderML`, String(orderId), {
    id: orderId,
    pack_id: opts.packId ?? null,
    last_updated: '2026-01-01T00:00:00.000-03:00',
  });
}

function makeShipment(opts: {
  id: number;
  orderId?: number | null;
  status?: string;
  lastUpdated?: string | null;
  trackingNumber?: string | null;
}): DocData {
  return {
    id: opts.id,
    // `order_id` is DISCONTINUED in the `x-format-new` body (#957) — kept here
    // only so the "still sent" branch of `resolveShipmentOrderId` is exercised;
    // pass `orderId: null` to force the `getShipmentOrders` fallback.
    order_id: opts.orderId === undefined ? 1 : opts.orderId,
    status: opts.status ?? 'shipped',
    substatus: null,
    tracking_number: opts.trackingNumber ?? null,
    last_updated:
      opts.lastUpdated === undefined ? '2026-01-15T00:00:00.000-03:00' : opts.lastUpdated,
    logistic: { mode: 'me2', type: 'drop_off', direction: 'forward' },
    lead_time: { cost: 10, list_cost: 20 },
  };
}

function makeApi(over: Partial<Record<keyof MercadoLivreApi, unknown>> = {}): MercadoLivreApi {
  return {
    getShipment: vi.fn(async (id: number | string) => makeShipment({ id: Number(id) })),
    getShipmentPayments: vi.fn(async () => []),
    // The documented replacement for the discontinued `shipment.order_id`.
    // Empty by default: the fixture still carries the legacy field, so the
    // fallback only fires for the tests that null it out.
    getShipmentOrders: vi.fn(async () => []),
    ...over,
  } as unknown as MercadoLivreApi;
}

function deps(db: FakeDb, api: MercadoLivreApi): ShipmentImportDeps {
  return { db: asDb(db), api, integracaoId: INTEGRACAO_ID, nowUs: NOW_US };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePrazoDespacho).mockResolvedValue(null);
});

/* ----------------------------------- tests --------------------------------- */

describe('importShipmentMercadoLivre — order/orderML resolution', () => {
  it('skips when neither the legacy field nor /shipments/{id}/orders yields an order', async () => {
    const db = new FakeDb();
    seedConta(db);
    const api = makeApi({
      getShipment: vi.fn(async () => makeShipment({ id: 777, orderId: null })),
    });

    const result = await importShipmentMercadoLivre(deps(db, api), 777);

    expect(result).toEqual({ pedidoId: null, skipped: 'sem-order-id' });
    expect(api.getShipmentOrders).toHaveBeenCalledWith(777);
  });

  it('resolves the order via /shipments/{id}/orders once ML drops shipment.order_id', async () => {
    // The migrated body carries no `order_id` at all (#957). Without the
    // fallback this path would skip with `sem-order-id` on EVERY shipments
    // notification — warn-logged, non-fatal, and easy to miss.
    const db = new FakeDb();
    seedConta(db);
    seedOrderMl(db, 'pedido-1', 1);
    db.seed('pedidos', 'pedido-1', {
      estado: 'iniciado',
      enderecoFiscalOuterRef: null,
      freteInicial: null,
    });
    const api = makeApi({
      getShipment: vi.fn(async () => makeShipment({ id: 777, orderId: null })),
      getShipmentOrders: vi.fn(async () => [{ order_id: '1', item_id: 'MLB1' }]),
    });

    const result = await importShipmentMercadoLivre(deps(db, api), 777);

    // Resolution SUCCEEDED — it stops later, at the frete guard, which is a
    // different skip entirely. `sem-order-id` would mean the fallback failed.
    expect(result).toEqual({ pedidoId: 'pedido-1', skipped: 'sem-frete-inicial' });
    expect(api.getShipmentOrders).toHaveBeenCalledWith(777);
  });

  it('skips (and logs) when no orderML doc matches the order id by pack_id nor id', async () => {
    const db = new FakeDb();
    seedConta(db);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = makeApi({
      getShipment: vi.fn(async () => makeShipment({ id: 777, orderId: 42 })),
    });

    const result = await importShipmentMercadoLivre(deps(db, api), 777);

    expect(result).toEqual({ pedidoId: null, skipped: 'pedido-nao-encontrado' });
    expect(warn).toHaveBeenCalled();
  });

  it('prefers a pack_id match over an id match (pack_id-then-id two-step resolve)', async () => {
    const db = new FakeDb();
    seedConta(db);
    // Seeded FIRST so an (incorrect) id-only resolve would return this one.
    seedOrderMl(db, 'pedido-standalone', 55, { packId: null });
    // Seeded SECOND, but the ONLY doc whose pack_id matches — must win.
    seedOrderMl(db, 'pedido-pack', 55, { packId: 55 });
    db.seed('pedidos', 'pedido-pack', { estado: 'iniciado', freteInicial: null });

    const api = makeApi({
      getShipment: vi.fn(async () => makeShipment({ id: 900, orderId: 55 })),
    });

    const result = await importShipmentMercadoLivre(deps(db, api), 900);

    expect(result.pedidoId).toBe('pedido-pack');
  });
});

describe('importShipmentMercadoLivre — frete guards', () => {
  it('skips with ZERO writes when the pedido has no freteInicial yet', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedIntFrete(db);
    seedOrderMl(db, 'pedido-1', 1);
    db.seed('pedidos', 'pedido-1', {
      estado: 'iniciado',
      enderecoFiscalOuterRef: null,
      freteInicial: null,
    });
    const api = makeApi({
      getShipment: vi.fn(async () => makeShipment({ id: 777, orderId: 1 })),
    });

    const result = await importShipmentMercadoLivre(deps(db, api), 777);

    expect(result).toEqual({ pedidoId: 'pedido-1', skipped: 'sem-frete-inicial' });
    expect(db.opLog.some((e) => e.op === 'update' && e.path.startsWith('pedidos/'))).toBe(false);
    expect(db.docs('pedidos').get('pedido-1')).toEqual({
      estado: 'iniciado',
      enderecoFiscalOuterRef: null,
      freteInicial: null,
    });
  });
});

describe('importShipmentMercadoLivre — staleness', () => {
  function seedFreteInicial(db: FakeDb, over: DocData = {}): void {
    seedOrderMl(db, 'pedido-1', 1);
    db.seed('pedidos', 'pedido-1', {
      estado: 'emProcessamento',
      enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
      freteInicial: {
        estado: 'iniciado',
        externalId: '777',
        ultimaModificacao: Date.parse('2026-01-10T00:00:00.000Z') * 1000,
        ...over,
      },
    });
  }

  it('skips as stale when the stored ultimaModificacao is NOT older than the incoming one', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedIntFrete(db);
    seedFreteInicial(db); // stored 2026-01-10
    const api = makeApi({
      getShipment: vi.fn(async () =>
        makeShipment({ id: 777, orderId: 1, lastUpdated: '2026-01-05T00:00:00.000-03:00' }),
      ), // OLDER than stored
    });

    const result = await importShipmentMercadoLivre(deps(db, api), 777);

    expect(result).toEqual({ pedidoId: 'pedido-1', skipped: 'stale' });
  });

  it('skips as stale when the stored ultimaModificacao is null — the OPPOSITE default from the payments gate', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedIntFrete(db);
    seedFreteInicial(db, { ultimaModificacao: null });
    const api = makeApi({
      // A fresh, well-formed incoming timestamp — would otherwise clearly win.
      getShipment: vi.fn(async () => makeShipment({ id: 777, orderId: 1 })),
    });

    const result = await importShipmentMercadoLivre(deps(db, api), 777);

    expect(result).toEqual({ pedidoId: 'pedido-1', skipped: 'stale' });
  });

  it('skips as stale when the mapped ultimaModificacao cannot be computed (shipment.last_updated absent)', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedIntFrete(db);
    seedFreteInicial(db); // valid stored timestamp
    const api = makeApi({
      getShipment: vi.fn(async () => makeShipment({ id: 777, orderId: 1, lastUpdated: null })),
    });

    const result = await importShipmentMercadoLivre(deps(db, api), 777);

    expect(result).toEqual({ pedidoId: 'pedido-1', skipped: 'stale' });
  });
});

describe('importShipmentMercadoLivre — happy path write', () => {
  it('merges freteInicial (preserving unmapped + null-mapped fields and estado) and writes EXACTLY {freteInicial, ultimaModificacao}', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedIntFrete(db);
    seedOrderMl(db, 'pedido-1', 1);
    db.seed('pedidos', 'pedido-1', {
      estado: 'emProcessamento', // must stay untouched by this handler
      enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
      freteInicial: {
        estado: 'despachoAutorizado',
        externalId: '777',
        printLabelId: 'label-123',
        externalOptionId: 'opt-9',
        externalOptionData: { foo: 'bar' },
        codRastreio: 'BR123456789',
        ultimaModificacao: Date.parse('2026-01-01T00:00:00.000Z') * 1000, // OLDER than incoming
      },
    });
    const api = makeApi({
      getShipment: vi.fn(async () =>
        makeShipment({
          id: 777,
          orderId: 1,
          status: 'pending', // base map -> 'iniciado'; must NOT regress despachoAutorizado
          lastUpdated: '2026-01-15T00:00:00.000-03:00',
          trackingNumber: null, // must NOT clobber the stored codRastreio
        }),
      ),
    });

    const result = await importShipmentMercadoLivre(deps(db, api), 777);

    expect(result).toEqual({ pedidoId: 'pedido-1', skipped: null });

    // Reads-before-writes: exactly one get, then one update, on the pedido doc.
    const pedidoOps = db.opLog.filter((e) => e.path === 'pedidos/pedido-1');
    expect(pedidoOps.map((e) => e.op)).toEqual(['get', 'update']);

    const patch = db.lastPatch('pedidos', 'pedido-1')!;
    expect(Object.keys(patch).sort()).toEqual(['freteInicial', 'ultimaModificacao']);
    expect(patch.ultimaModificacao).toBe(NOW_US);

    const freteInicial = patch.freteInicial as DocData;
    expect(freteInicial.estado).toBe('despachoAutorizado'); // preserved, not regressed to 'iniciado'
    expect(freteInicial.printLabelId).toBe('label-123'); // unmapped field, preserved
    expect(freteInicial.externalOptionId).toBe('opt-9'); // unmapped field, preserved
    expect(freteInicial.externalOptionData).toEqual({ foo: 'bar' }); // unmapped field, preserved
    expect(freteInicial.codRastreio).toBe('BR123456789'); // incoming tracking_number null -> preserved

    // pedido.estado (the TOP-LEVEL field) is never part of the patch.
    expect(db.docs('pedidos').get('pedido-1')!.estado).toBe('emProcessamento');
  });

  it('warns on an externalId mismatch but still processes the merge', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedIntFrete(db);
    seedOrderMl(db, 'pedido-1', 1);
    db.seed('pedidos', 'pedido-1', {
      estado: 'emProcessamento',
      enderecoFiscalOuterRef: null,
      freteInicial: {
        estado: 'iniciado',
        externalId: '999', // MISMATCH vs the incoming shipment.id (777)
        ultimaModificacao: Date.parse('2026-01-01T00:00:00.000Z') * 1000,
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = makeApi({
      getShipment: vi.fn(async () =>
        makeShipment({ id: 777, orderId: 1, lastUpdated: '2026-01-15T00:00:00.000-03:00' }),
      ),
    });

    const result = await importShipmentMercadoLivre(deps(db, api), 777);

    expect(result).toEqual({ pedidoId: 'pedido-1', skipped: null });
    const messages = warn.mock.calls.map((c) => c[0]);
    expect(messages.some((m) => typeof m === 'string' && m.includes('externalId divergente'))).toBe(
      true,
    );
  });

  // #782: the freight doc is now a server-owned companion of the conta, and its
  // back-ref is written in the canonical `documents/integracao/<id>` form — which
  // `resolveMercadoEnviosIntFreteOuterRef` resolves through an INDEXED equality.
  // The other cases here seed the bare form on purpose, exercising the tolerant
  // fallback; this one pins the shape the trigger actually produces.
  it('resolves the int_frete doc from the canonical back-ref the #782 trigger writes', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedIntFreteCanonico(db, 'if-canon');
    seedOrderMl(db, 'pedido-1', 1);
    db.seed('pedidos', 'pedido-1', {
      estado: 'emProcessamento',
      enderecoFiscalOuterRef: null,
      freteInicial: {
        estado: 'iniciado',
        externalId: '777',
        // OLDER than the incoming last_updated — a null here is treated as stale.
        ultimaModificacao: Date.parse('2026-01-01T00:00:00.000Z') * 1000,
      },
    });
    const api = makeApi({
      getShipment: vi.fn(async () =>
        makeShipment({ id: 777, orderId: 1, lastUpdated: '2026-01-15T00:00:00.000-03:00' }),
      ),
    });

    await importShipmentMercadoLivre(deps(db, api), 777);

    const freteInicial = db.lastPatch('pedidos', 'pedido-1')!.freteInicial as DocData;
    expect(freteInicial.integracaoFreteOuterRef).toBe('documents/int_frete/if-canon');
  });

  it('calls resolvePrazoDespacho with fallbackUs null and the account sellerId', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedIntFrete(db);
    seedOrderMl(db, 'pedido-1', 1);
    db.seed('pedidos', 'pedido-1', {
      estado: 'iniciado',
      enderecoFiscalOuterRef: null,
      freteInicial: null,
    });
    const shipment = makeShipment({ id: 777, orderId: 1 });
    const api = makeApi({ getShipment: vi.fn(async () => shipment) });

    await importShipmentMercadoLivre(deps(db, api), 777);

    expect(resolvePrazoDespacho).toHaveBeenCalledWith(
      expect.objectContaining({ api, shipment, sellerId: SELLER_USER_ID, fallbackUs: null }),
    );
  });
});

describe('importShipmentMercadoLivre — error policy', () => {
  it('returns shipment-404 on a 404 from the primary getShipment call', async () => {
    const db = new FakeDb();
    seedConta(db);
    const api = makeApi({
      getShipment: vi.fn(async () => {
        throw new MercadoLivreHttpError('ML 404: not found', 404, null);
      }),
    });

    const result = await importShipmentMercadoLivre(deps(db, api), 777);

    expect(result).toEqual({ pedidoId: null, skipped: 'shipment-404' });
  });

  it('propagates a non-404 MercadoLivreHttpError', async () => {
    const db = new FakeDb();
    seedConta(db);
    const api = makeApi({
      getShipment: vi.fn(async () => {
        throw new MercadoLivreHttpError('ML 500: server error', 500, null);
      }),
    });

    await expect(importShipmentMercadoLivre(deps(db, api), 777)).rejects.toBeInstanceOf(
      MercadoLivreHttpError,
    );
  });

  it('propagates a network/generic error instead of swallowing it', async () => {
    const db = new FakeDb();
    seedConta(db);
    const api = makeApi({
      getShipment: vi.fn(async () => {
        throw new Error('network down');
      }),
    });

    await expect(importShipmentMercadoLivre(deps(db, api), 777)).rejects.toThrow('network down');
  });
});
