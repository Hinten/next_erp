import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { MlOrder } from '@delfrance/integrations-mercado-livre';
import type { ItemDoPedido } from '@delfrance/schemas';

import { discoverPedidoMercadoLivre, type DiscoverPedidoArgs } from './orderPedidoTx';
import { makePagamentoIdMercadoLivre, makePedidoIdMercadoLivre } from './orderIds';
import { resolvePedidoIdByOrderId } from './orderPedidoResolve';

/* ------------------------------ fake Firestore ---------------------------- */
// Extends the established import.test.ts FakeDb shape with a real per-doc
// `.collection(name)` (needed for the `orderML` mirror child, addressed by a
// full path string exactly like every other FakeDb in this folder) and an
// `opLog` recording every get/set/create/update in call order — the
// "reads-before-writes" test asserts on it directly instead of inferring
// ordering from side effects. `collectionGroup` mirrors the sibling fake in
// `orderPaymentImport.test.ts` so the pack-first `resolvePedidoIdByOrderId`
// can be exercised against the very docs this module writes (#793).

type DocData = Record<string, unknown>;
type OpKind = 'get' | 'set' | 'create' | 'update';

interface FakeSnap {
  exists: boolean;
  id: string;
  data: () => DocData | undefined;
}

interface FakeQuery {
  get: () => Promise<{ docs: Array<{ id: string; ref: { parent: { parent: { id: string } } } }> }>;
  limit: (n: number) => FakeQuery;
  where: (field: string, op: string, value: unknown) => FakeQuery;
}

/** `pedidos/{pedidoId}/orderML` → `pedidoId` (second-to-last path segment). */
function parentDocId(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 2] ?? '';
}

interface FakeDocRef {
  id: string;
  get: () => Promise<FakeSnap>;
  set: (data: DocData) => void;
  create: (data: DocData) => void;
  update: (patch: DocData) => void;
}

interface FakeCollection {
  doc: (id?: string) => FakeDocRef;
}

interface FakeTransaction {
  get: (ref: FakeDocRef) => Promise<FakeSnap>;
  create: (ref: FakeDocRef, data: DocData) => void;
  set: (ref: FakeDocRef, data: DocData) => void;
  update: (ref: FakeDocRef, patch: DocData) => void;
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

  collection(path: string): FakeCollection {
    const self = this;
    return {
      doc(id?: string) {
        const docId = id ?? `auto-${++self.autoN}`;
        return self.makeDocRef(path, docId);
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
        self.opLog.push({ op: 'get', path: `${groupId}#group` });
        let rows = entries.filter((e) => clauses.every(([f, v]) => e.data[f] === v));
        if (lim != null) rows = rows.slice(0, lim);
        return {
          docs: rows.map((e) => ({
            id: e.id,
            ref: { parent: { parent: { id: parentDocId(e.path) } } },
          })),
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
      set: (data: DocData) => {
        self.opLog.push({ op: 'set', path: `${path}/${id}` });
        col.set(id, { ...data });
      },
      create: (data: DocData) => {
        self.opLog.push({ op: 'create', path: `${path}/${id}` });
        if (col.has(id)) throw Object.assign(new Error('already exists'), { code: 6 });
        col.set(id, { ...data });
      },
      update: (patch: DocData) => {
        self.opLog.push({ op: 'update', path: `${path}/${id}` });
        if (!col.has(id)) throw Object.assign(new Error('not found'), { code: 5 });
        col.set(id, { ...(col.get(id) ?? {}), ...patch });
      },
    };
  }

  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    // Admin SDK invariant: every read in a transaction must happen before its
    // first write. `wroteAlready` is scoped to THIS call (a fresh transaction),
    // not the FakeDb instance, so sequential transactions in the same test
    // don't bleed into each other.
    let wroteAlready = false;
    const guardRead = (): void => {
      if (wroteAlready) {
        throw new Error('read after write in transaction (Admin SDK invariant)');
      }
    };
    const tx: FakeTransaction = {
      get: (ref) => {
        guardRead();
        return ref.get();
      },
      create: (ref, data) => {
        ref.create(data);
        wroteAlready = true;
      },
      set: (ref, data) => {
        ref.set(data);
        wroteAlready = true;
      },
      update: (ref, patch) => {
        ref.update(patch);
        wroteAlready = true;
      },
    };
    return fn(tx);
  }
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* --------------------------------- fixtures ------------------------------- */

const CONTA_ID = 'conta-A';
const INTEGRACAO_OUTER_REF = 'documents/integracao/conta-A';
const NOW_US = Date.parse('2026-01-10T00:00:00.000Z') * 1000;

function makeOrder(opts: {
  id: number;
  packId?: number | null;
  lastUpdated: string;
  dateCreated?: string;
  status?: string;
  payments?: DocData[];
}): MlOrder {
  return {
    id: opts.id,
    status: opts.status ?? 'paid',
    date_created: opts.dateCreated ?? opts.lastUpdated,
    last_updated: opts.lastUpdated,
    pack_id: opts.packId ?? null,
    order_items: [],
    payments: opts.payments ?? [],
  } as unknown as MlOrder;
}

function makePayment(opts: {
  id: number;
  lastModified: string;
  transactionAmount: number;
  status?: string;
}): DocData {
  return {
    id: opts.id,
    status: opts.status ?? 'approved',
    transaction_amount: opts.transactionAmount,
    shipping_cost: 0,
    coupon_amount: 0,
    last_modified: opts.lastModified,
    date_last_updated: opts.lastModified,
    date_created: opts.lastModified,
    date_approved: opts.lastModified,
    payment_type: 'credit_card',
    payment_type_id: 'credit_card',
    payment_method_id: 'master',
    refunds: [],
  };
}

function makeItem(opts: {
  ensureUniqueId: string;
  produtoUid: string | null;
  ordem?: number;
}): ItemDoPedido {
  return {
    produtoUid: opts.produtoUid,
    ordem: opts.ordem ?? 0,
    ensureUniqueId: opts.ensureUniqueId,
    mktplaceId: opts.ensureUniqueId,
    sku: null,
    gtin: null,
    nomeDeVenda: 'Item teste',
    precoDeVenda: 10,
    descontoUnitario: 0,
    quantidade: 1,
    custo: null,
    timestamp: null,
    imposto: null,
  };
}

function baseArgs(db: FakeDb, over: Partial<DiscoverPedidoArgs> = {}): DiscoverPedidoArgs {
  return {
    db: asDb(db),
    contaId: CONTA_ID,
    contaOuterRef: INTEGRACAO_OUTER_REF,
    contaCpfCnpj: null,
    integracaoOuterRef: INTEGRACAO_OUTER_REF,
    operacaoOuterRef: null,
    listaDePrecosOuterRef: null,
    orders: [],
    packId: null,
    itensByOrderId: new Map(),
    nowUs: NOW_US,
    ...over,
  };
}

/* --------------------------------- tests ----------------------------------- */

describe('discoverPedidoMercadoLivre — create', () => {
  it('creates a fresh pedido at the standalone deterministic id, with items + orderML mirror', async () => {
    const db = new FakeDb();
    const order = makeOrder({ id: 1001, lastUpdated: '2026-01-01T00:00:00.000Z', status: 'paid' });
    const items = [makeItem({ ensureUniqueId: 'u1', produtoUid: 'prod1' })];

    const res = await discoverPedidoMercadoLivre(
      baseArgs(db, { orders: [order], itensByOrderId: new Map([[1001, items]]) }),
    );

    expect(res.created).toBe(true);
    expect(res.pedidoId).toBe(makePedidoIdMercadoLivre(CONTA_ID, 1001));

    const pedido = db.docs('pedidos').get(res.pedidoId);
    expect(pedido).toMatchObject({
      ehSaida: true,
      estado: 'emProcessamento', // 'paid' → emProcessamento
      numero: '1001',
      itensIds: ['prod1'],
      integracaoPedidoOuterRef: INTEGRACAO_OUTER_REF,
    });
    expect(pedido!.itens).toMatchObject({ prod1: [{ ensureUniqueId: 'u1' }] });
    // estoqueAplicado is server-owned — absent input defaults to null, never a value.
    expect(pedido!.estoqueAplicado).toBeNull();

    const orderMl = db.docs(`pedidos/${res.pedidoId}/orderML`).get('1001');
    expect(orderMl).toMatchObject({ id: 1001, status: 'paid' });
  });

  it('reads-before-writes: every get() happens before the first write in the transaction', async () => {
    const db = new FakeDb();
    const order = makeOrder({ id: 1002, lastUpdated: '2026-01-01T00:00:00.000Z' });
    await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [order],
        itensByOrderId: new Map([[1002, [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })]]]),
      }),
    );

    const firstWriteIdx = db.opLog.findIndex((o) => o.op !== 'get');
    expect(firstWriteIdx).toBeGreaterThan(-1);
    const readsAfterFirstWrite = db.opLog.slice(firstWriteIdx).some((o) => o.op === 'get');
    expect(readsAfterFirstWrite).toBe(false);
  });
});

describe('discoverPedidoMercadoLivre — redelivery / staleness', () => {
  it('a byte-identical redelivery (same last_updated) is a full no-op: created=false, no duplicate items', async () => {
    const db = new FakeDb();
    const order = makeOrder({ id: 2001, lastUpdated: '2026-01-01T00:00:00.000Z' });
    const items = [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })];
    const args = baseArgs(db, { orders: [order], itensByOrderId: new Map([[2001, items]]) });

    const first = await discoverPedidoMercadoLivre(args);
    expect(first.created).toBe(true);

    const second = await discoverPedidoMercadoLivre(args);
    expect(second.created).toBe(false);
    expect(second.pedidoId).toBe(first.pedidoId);
    expect(db.docs('pedidos').get(first.pedidoId)!.itensIds).toEqual(['p1']);
    expect(db.docs(`pedidos/${first.pedidoId}/orderML`).size).toBe(1);
  });

  it('an OLDER redelivery (stale last_updated) never touches the pedido or its orderML mirror', async () => {
    const db = new FakeDb();
    const fresh = makeOrder({ id: 2002, lastUpdated: '2026-01-05T00:00:00.000Z' });
    const args1 = baseArgs(db, {
      orders: [fresh],
      itensByOrderId: new Map([[2002, [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })]]]),
    });
    const first = await discoverPedidoMercadoLivre(args1);

    const stale = makeOrder({ id: 2002, lastUpdated: '2026-01-01T00:00:00.000Z' }); // OLDER
    const args2 = baseArgs(db, {
      orders: [stale],
      itensByOrderId: new Map([
        [
          2002,
          [
            makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' }),
            makeItem({ ensureUniqueId: 'u2', produtoUid: 'p2' }),
          ],
        ],
      ]),
    });
    const second = await discoverPedidoMercadoLivre(args2);

    expect(second.created).toBe(false);
    expect(second.pedidoId).toBe(first.pedidoId);
    // the stale delivery's extra item (u2) never merges in.
    expect(db.docs('pedidos').get(first.pedidoId)!.itensIds).toEqual(['p1']);
  });

  it('item merge appends ONLY the missing ensureUniqueId lines on a fresher redelivery', async () => {
    const db = new FakeDb();
    const orderV1 = makeOrder({ id: 2003, lastUpdated: '2026-01-01T00:00:00.000Z' });
    const first = await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [orderV1],
        itensByOrderId: new Map([[2003, [makeItem({ ensureUniqueId: 'uA', produtoUid: 'p1' })]]]),
      }),
    );

    const orderV2 = makeOrder({ id: 2003, lastUpdated: '2026-01-02T00:00:00.000Z' }); // NEWER
    const second = await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [orderV2],
        itensByOrderId: new Map([
          [
            2003,
            [
              makeItem({ ensureUniqueId: 'uA', produtoUid: 'p1' }), // already present — must not duplicate
              makeItem({ ensureUniqueId: 'uB', produtoUid: 'p1' }), // new — must append
            ],
          ],
        ]),
      }),
    );

    expect(second.pedidoId).toBe(first.pedidoId);
    const pedido = db.docs('pedidos').get(first.pedidoId)!;
    const linesForP1 = pedido.itens as Record<string, ItemDoPedido[]>;
    expect(linesForP1.p1).toHaveLength(2);
    expect(linesForP1.p1!.map((i) => i.ensureUniqueId).sort()).toEqual(['uA', 'uB']);
    expect(pedido.ultimaModificacao).toBeGreaterThan(0);
  });
});

describe('discoverPedidoMercadoLivre — multi-order pack create', () => {
  it("a fresh pack pedido carries the LATEST processed order's ultimaModificacao, not just firstOrder's", async () => {
    const db = new FakeDb();
    const packId = 7000;
    // order2 (processed SECOND) is the fresher one — the create doc's
    // ultimaModificacao/lastMarketplaceUpdate must reflect IT, mirroring
    // legacy's per-iteration `.copyWith(ultimaModificacao: orderInstance.last_updated)`
    // unconditionally overwriting on every order processed, not just the first.
    const order1 = makeOrder({ id: 7001, packId, lastUpdated: '2026-01-01T00:00:00.000Z' });
    const order2 = makeOrder({ id: 7002, packId, lastUpdated: '2026-01-09T00:00:00.000Z' });

    const res = await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [order1, order2],
        packId,
        itensByOrderId: new Map([
          [7001, [makeItem({ ensureUniqueId: 'u7001', produtoUid: 'pA' })]],
          [7002, [makeItem({ ensureUniqueId: 'u7002', produtoUid: 'pB' })]],
        ]),
      }),
    );

    const target = db.docs('pedidos').get(res.pedidoId)!;
    const expectedUs = Date.parse('2026-01-09T00:00:00.000Z') * 1000;
    expect(target.ultimaModificacao).toBe(expectedUs);
    expect(target.lastMarketplaceUpdate).toBe(expectedUs);
  });
});

describe('discoverPedidoMercadoLivre — pack absorption', () => {
  it('cancels an existing standalone pedido absorbed into a new pack pedido, with an Incidente', async () => {
    const db = new FakeDb();
    const packId = 5000;
    const order1 = makeOrder({ id: 2001, packId, lastUpdated: '2026-01-01T00:00:00.000Z' });
    const order2 = makeOrder({ id: 2002, packId, lastUpdated: '2026-01-01T00:00:00.000Z' });

    // order2 was PREVIOUSLY imported standalone (before ML packed it) and has
    // stock movement/reserva stamped — the estado membership `pago` qualifies.
    const standaloneId = makePedidoIdMercadoLivre(CONTA_ID, 2002);
    db.seed('pedidos', standaloneId, {
      ehSaida: true,
      estado: 'pago',
      numero: '2002',
      itens: {},
      itensIds: [],
    });

    const res = await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [order1, order2],
        packId,
        itensByOrderId: new Map([
          [2001, [makeItem({ ensureUniqueId: 'u2001', produtoUid: 'pA' })]],
          [2002, [makeItem({ ensureUniqueId: 'u2002', produtoUid: 'pB' })]],
        ]),
      }),
    );

    expect(res.created).toBe(true);
    expect(res.pedidoId).toBe(makePedidoIdMercadoLivre(CONTA_ID, 2001, packId));
    expect(res.pedidoId).not.toBe(standaloneId);

    // the target pedido carries BOTH orders' items.
    const target = db.docs('pedidos').get(res.pedidoId)!;
    expect((target.itensIds as string[]).sort()).toEqual(['pA', 'pB']);

    // the OLD standalone pedido got cancelled — never rewritten as a full doc.
    const standalone = db.docs('pedidos').get(standaloneId)!;
    expect(standalone.estado).toBe('cancelado');
    expect(standalone.numero).toBe('2002'); // untouched field proves this was a TARGETED patch

    const incidentes = db.docs(`pedidos/${standaloneId}/incidentes`);
    expect(incidentes.size).toBe(1);
    const incidente = [...incidentes.values()][0]!;
    expect(incidente).toMatchObject({
      tipo: 't',
      origem: 99,
      motivoDoIncidente: `Pedido cancelado por ter sido incluído no pacote ${packId}`,
    });
  });

  it('does NOT cancel the standalone doc that itself became the target (self-cancel guard)', async () => {
    const db = new FakeDb();
    const packId = 6000;
    // order1's OWN standalone pedido already exists (no pack-pedido yet) — it
    // becomes the target; must survive un-cancelled even though its estado
    // qualifies for absorption.
    const standaloneId = makePedidoIdMercadoLivre(CONTA_ID, 3001);
    db.seed('pedidos', standaloneId, {
      ehSaida: true,
      estado: 'pago',
      numero: '3001',
      itens: {},
      itensIds: [],
    });
    const order1 = makeOrder({ id: 3001, packId, lastUpdated: '2026-01-01T00:00:00.000Z' });

    const res = await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [order1],
        packId,
        itensByOrderId: new Map([
          [3001, [makeItem({ ensureUniqueId: 'u3001', produtoUid: 'pA' })]],
        ]),
      }),
    );

    expect(res.pedidoId).toBe(standaloneId);
    expect(res.created).toBe(false);
    const target = db.docs('pedidos').get(standaloneId)!;
    expect(target.estado).toBe('pago'); // never flipped to cancelado
    expect(db.docs(`pedidos/${standaloneId}/incidentes`).size).toBe(0);
  });
});

describe('discoverPedidoMercadoLivre — embedded payments upsert', () => {
  it('creates a pagamento at the deterministic id for a new embedded payment', async () => {
    const db = new FakeDb();
    const order = makeOrder({
      id: 4001,
      lastUpdated: '2026-01-01T00:00:00.000Z',
      payments: [
        makePayment({ id: 555, lastModified: '2026-01-01T00:00:00.000Z', transactionAmount: 100 }),
      ],
    });

    const res = await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [order],
        itensByOrderId: new Map([[4001, [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })]]]),
      }),
    );

    const pagId = makePagamentoIdMercadoLivre(CONTA_ID, 555);
    const pag = db.docs(`pedidos/${res.pedidoId}/pagamentos`).get(pagId);
    expect(pag).toMatchObject({ id: '555', valor: 100, status_pagamento: 4 /* aprovado */ });
  });

  it('overwrites an existing pagamento when the incoming payment is NEWER (ultimaModificacao)', async () => {
    const db = new FakeDb();
    const order1 = makeOrder({
      id: 4002,
      lastUpdated: '2026-01-01T00:00:00.000Z',
      payments: [
        makePayment({ id: 777, lastModified: '2026-01-01T00:00:00.000Z', transactionAmount: 100 }),
      ],
    });
    const first = await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [order1],
        itensByOrderId: new Map([[4002, [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })]]]),
      }),
    );

    // A fresher order (newer last_updated) carries a fresher payment revision.
    const order2 = makeOrder({
      id: 4002,
      lastUpdated: '2026-01-02T00:00:00.000Z',
      payments: [
        makePayment({ id: 777, lastModified: '2026-01-02T00:00:00.000Z', transactionAmount: 150 }),
      ],
    });
    await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [order2],
        itensByOrderId: new Map([[4002, [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })]]]),
      }),
    );

    const pagId = makePagamentoIdMercadoLivre(CONTA_ID, 777);
    const pag = db.docs(`pedidos/${first.pedidoId}/pagamentos`).get(pagId);
    expect(pag).toMatchObject({ valor: 150 });
  });

  it('skips an existing pagamento when the incoming payment is OLDER (stored ultimaModificacao wins)', async () => {
    const db = new FakeDb();
    const order1 = makeOrder({
      id: 4003,
      lastUpdated: '2026-01-01T00:00:00.000Z',
      payments: [
        makePayment({ id: 888, lastModified: '2026-01-01T00:00:00.000Z', transactionAmount: 100 }),
      ],
    });
    const first = await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [order1],
        itensByOrderId: new Map([[4003, [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })]]]),
      }),
    );
    // Bump to a NEWER payment revision (stores ultimaModificacao at 01-02).
    const order2 = makeOrder({
      id: 4003,
      lastUpdated: '2026-01-02T00:00:00.000Z',
      payments: [
        makePayment({ id: 888, lastModified: '2026-01-02T00:00:00.000Z', transactionAmount: 150 }),
      ],
    });
    await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [order2],
        itensByOrderId: new Map([[4003, [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })]]]),
      }),
    );

    // A THIRD, order-level-fresher delivery (passes the order/pedido gates)
    // but carries the payment's OLD revision (last_modified back at 01-01) —
    // the payment-level staleness guard must skip it, independent of the
    // order-level gates having passed.
    const order3 = makeOrder({
      id: 4003,
      lastUpdated: '2026-01-03T00:00:00.000Z',
      payments: [
        makePayment({ id: 888, lastModified: '2026-01-01T00:00:00.000Z', transactionAmount: 999 }),
      ],
    });
    await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [order3],
        itensByOrderId: new Map([[4003, [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })]]]),
      }),
    );

    const pagId = makePagamentoIdMercadoLivre(CONTA_ID, 888);
    const pag = db.docs(`pedidos/${first.pedidoId}/pagamentos`).get(pagId);
    // still the SECOND call's value (150) — the third call's stale 999 never lands.
    expect(pag).toMatchObject({ valor: 150 });
  });

  it('merges (not overwrites) an existing pagamento — a stored field the mapper never sets survives', async () => {
    // Parity fix: the UPDATE branch now goes through `mergePagamentoUpdate`
    // (legacy `Pagamento.update`, models.odm.g.dart:11786-11813) instead of a
    // full-object overwrite — see the module doc's ⚠️ note.
    const db = new FakeDb();
    const order1 = makeOrder({
      id: 4004,
      lastUpdated: '2026-01-01T00:00:00.000Z',
      payments: [
        makePayment({ id: 999, lastModified: '2026-01-01T00:00:00.000Z', transactionAmount: 100 }),
      ],
    });
    const first = await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [order1],
        itensByOrderId: new Map([[4004, [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })]]]),
      }),
    );

    const pagId = makePagamentoIdMercadoLivre(CONTA_ID, 999);
    // Simulate a field a DIFFERENT code path stamped onto the stored doc —
    // `mlPaymentToPagamento` never sets `metodoPagamentoOuterRef`.
    const stored = db.docs(`pedidos/${first.pedidoId}/pagamentos`).get(pagId)!;
    db.seed(`pedidos/${first.pedidoId}/pagamentos`, pagId, {
      ...stored,
      metodoPagamentoOuterRef: 'documents/metodo_pgto/manual',
    });

    // A fresher order carries a fresher revision of the SAME payment.
    const order2 = makeOrder({
      id: 4004,
      lastUpdated: '2026-01-02T00:00:00.000Z',
      payments: [
        makePayment({ id: 999, lastModified: '2026-01-02T00:00:00.000Z', transactionAmount: 250 }),
      ],
    });
    await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [order2],
        itensByOrderId: new Map([[4004, [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })]]]),
      }),
    );

    const pag = db.docs(`pedidos/${first.pedidoId}/pagamentos`).get(pagId)!;
    // the manually-stamped field survives the merge...
    expect(pag.metodoPagamentoOuterRef).toBe('documents/metodo_pgto/manual');
    // ...while the mapped fields DID advance (proving this was a real update,
    // not a stale skip that happened to leave the manual field untouched).
    expect(pag.valor).toBe(250);
  });
});

/* ------------------ orderML mirror: replace vs. merge (#793) --------------- */
// The mirror is REPLACED whenever ML spoke in full — a fresh create, or a
// refresh whose `GET /orders/{id}` answered a complete 200 (reported through
// `completeOrderIds`). That keeps it a real mirror: a field ML cleared clears
// here too. Anything we can't call complete goes through the presence-keyed
// merge instead, so a `206 Partial Content` body — which OMITS fields rather
// than nulling them — can't destroy what it stayed silent about.
//
// `pack_id` is why this matters: `resolvePedidoIdByOrderId` matches it FIRST,
// so a mirror that loses it strands every later payments/shipments/claims
// notification for that cart on `pedido-nao-encontrado`. And
// `resolvePackOrders` re-fetches EVERY order of the pack on every refresh
// (`orderImport.ts`), so each of those fetches is an independent chance to
// answer partially.

const PACK_ID = 9001;

/** A `206 Partial Content` refresh: fresher, but the omitted keys are genuinely
 * ABSENT — not nulled. That absence is the whole discriminator. */
function makePartialRefresh(orderId: number): MlOrder {
  return {
    id: orderId,
    status: 'paid',
    date_created: '2026-01-01T00:00:00.000Z',
    last_updated: '2026-01-02T00:00:00.000Z',
    order_items: [],
    payments: [],
    // NOTE: no `pack_id`, `status_detail`, `tags` or `comment` keys at all.
  } as unknown as MlOrder;
}

/** A full order as first imported — every writeNotNull key populated. */
function makeFullOrder(id: number, packId: number | null): MlOrder {
  return {
    ...makeOrder({ id, packId, lastUpdated: '2026-01-01T00:00:00.000Z' }),
    status_detail: 'accredited',
    tags: ['pack_order', 'paid'],
    comment: 'entregar na portaria',
  } as unknown as MlOrder;
}

const PACK_ITENS = new Map([
  [1001, [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })]],
  [1002, [makeItem({ ensureUniqueId: 'u2', produtoUid: 'p2' })]],
]);

/** Full first import of a two-order pack, then a refresh of both. `complete`
 * decides whether that refresh is reported as a 200 or left unknown (206). */
async function importPackThenRefresh(
  db: FakeDb,
  refresh: MlOrder[],
  complete: boolean,
): Promise<string> {
  const first = await discoverPedidoMercadoLivre(
    baseArgs(db, {
      orders: [makeFullOrder(1001, PACK_ID), makeFullOrder(1002, PACK_ID)],
      packId: PACK_ID,
      itensByOrderId: PACK_ITENS,
    }),
  );
  expect(first.created).toBe(true);

  const refreshed = await discoverPedidoMercadoLivre(
    baseArgs(db, {
      orders: refresh,
      packId: PACK_ID,
      itensByOrderId: PACK_ITENS,
      completeOrderIds: complete ? new Set(refresh.map((o) => o.id)) : undefined,
    }),
  );
  // Same pedido — the refresh must land on the docs the first import wrote.
  expect(refreshed.created).toBe(false);
  expect(refreshed.pedidoId).toBe(first.pedidoId);
  return first.pedidoId;
}

/** The two-order pack refreshed from partial (206-shaped) payloads. */
function refreshPackPartially(db: FakeDb): Promise<string> {
  return importPackThenRefresh(db, [makePartialRefresh(1001), makePartialRefresh(1002)], false);
}

describe('discoverPedidoMercadoLivre — orderML refresh from a PARTIAL payload (#793)', () => {
  it('a payload that omits pack_id leaves the stored pack_id intact', async () => {
    const db = new FakeDb();
    const pedidoId = await refreshPackPartially(db);

    const mirrors = db.docs(`pedidos/${pedidoId}/orderML`);
    expect(mirrors.get('1001')!.pack_id).toBe(PACK_ID);
    expect(mirrors.get('1002')!.pack_id).toBe(PACK_ID);
  });

  it('a payments notification for that cart still resolves to the pedido afterwards', async () => {
    const db = new FakeDb();
    const pedidoId = await refreshPackPartially(db);

    // The pack-first branch of the shared resolver — what the payments,
    // shipments and claims handlers all call.
    await expect(resolvePedidoIdByOrderId(asDb(db), PACK_ID)).resolves.toBe(pedidoId);
  });

  it('keeps the writeNotNull keys (status_detail / tags / comment) it omits', async () => {
    const db = new FakeDb();
    const pedidoId = await refreshPackPartially(db);

    const mirror = db.docs(`pedidos/${pedidoId}/orderML`).get('1001')!;
    expect(mirror.status_detail).toBe('accredited');
    expect(mirror.tags).toEqual(['pack_order', 'paid']);
    expect(mirror.comment).toBe('entregar na portaria');
  });

  it('still applies every value the partial payload DOES carry', async () => {
    const db = new FakeDb();
    const pedidoId = await refreshPackPartially(db);

    const mirror = db.docs(`pedidos/${pedidoId}/orderML`).get('1001')!;
    expect(mirror.last_updated).toBe(Date.parse('2026-01-02T00:00:00.000Z'));
  });
});

describe('discoverPedidoMercadoLivre — orderML refresh from a COMPLETE 200', () => {
  it('replaces the doc wholesale, clearing what ML no longer sends', async () => {
    // `makeOrder` names `pack_id` explicitly and omits the writeNotNull keys the
    // first import had set — a complete answer, so the mirror must follow it
    // rather than keep the stale values.
    const db = new FakeDb();
    const pedidoId = await importPackThenRefresh(
      db,
      [
        makeOrder({ id: 1001, packId: PACK_ID, lastUpdated: '2026-01-02T00:00:00.000Z' }),
        makeOrder({ id: 1002, packId: PACK_ID, lastUpdated: '2026-01-02T00:00:00.000Z' }),
      ],
      true,
    );

    const mirror = db.docs(`pedidos/${pedidoId}/orderML`).get('1001')!;
    expect(mirror.pack_id).toBe(PACK_ID); // ML still says it belongs to the pack
    expect(mirror).not.toHaveProperty('status_detail'); // cleared, not preserved
    expect(mirror).not.toHaveProperty('tags');
    expect(mirror).not.toHaveProperty('comment');
  });

  it('honours a complete payload that nulls pack_id — the order left the pack', async () => {
    const db = new FakeDb();
    const pedidoId = await importPackThenRefresh(
      db,
      [
        makeOrder({ id: 1001, packId: null, lastUpdated: '2026-01-02T00:00:00.000Z' }),
        makeOrder({ id: 1002, packId: null, lastUpdated: '2026-01-02T00:00:00.000Z' }),
      ],
      true,
    );

    expect(db.docs(`pedidos/${pedidoId}/orderML`).get('1001')!).toHaveProperty('pack_id', null);
  });

  it('is per-order: one sibling answering 200 never licenses replacing the other', async () => {
    // Only 1001 came back complete; 1002's partial answer must still merge.
    const db = new FakeDb();
    const first = await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [makeFullOrder(1001, PACK_ID), makeFullOrder(1002, PACK_ID)],
        packId: PACK_ID,
        itensByOrderId: PACK_ITENS,
      }),
    );

    await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [
          makeOrder({ id: 1001, packId: PACK_ID, lastUpdated: '2026-01-02T00:00:00.000Z' }),
          makePartialRefresh(1002),
        ],
        packId: PACK_ID,
        itensByOrderId: PACK_ITENS,
        completeOrderIds: new Set([1001]),
      }),
    );

    const mirrors = db.docs(`pedidos/${first.pedidoId}/orderML`);
    expect(mirrors.get('1001')!).not.toHaveProperty('tags'); // replaced
    expect(mirrors.get('1002')!.tags).toEqual(['pack_order', 'paid']); // merged
    expect(mirrors.get('1002')!.pack_id).toBe(PACK_ID);
  });
});

describe('discoverPedidoMercadoLivre — orders with no pack at all', () => {
  // Mercado Livre still documents `pack_id` as present only "se estiver
  // associado a um pacote" (the every-order-gets-a-pack rollout is gradual), so
  // a stored `null` is a valid steady state — neither path may invent one, and
  // the `id ==` fallback must keep working.
  const ITENS = new Map([[2001, [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })]]]);

  it.each([
    ['a partial refresh', false],
    ['a complete 200 refresh', true],
  ])('keeps pack_id null and resolves via the id fallback after %s', async (_label, complete) => {
    const db = new FakeDb();
    const first = await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [makeOrder({ id: 2001, lastUpdated: '2026-01-01T00:00:00.000Z' })],
        itensByOrderId: ITENS,
      }),
    );
    expect(first.pedidoId).toBe(makePedidoIdMercadoLivre(CONTA_ID, 2001));

    const refresh = complete
      ? makeOrder({ id: 2001, lastUpdated: '2026-01-02T00:00:00.000Z' })
      : makePartialRefresh(2001);
    await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [refresh],
        itensByOrderId: ITENS,
        completeOrderIds: complete ? new Set([2001]) : undefined,
      }),
    );

    const mirror = db.docs(`pedidos/${first.pedidoId}/orderML`).get('2001')!;
    expect(mirror).toHaveProperty('pack_id', null);
    await expect(resolvePedidoIdByOrderId(asDb(db), 2001)).resolves.toBe(first.pedidoId);
  });
});
