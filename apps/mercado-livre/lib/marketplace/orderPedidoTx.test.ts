import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { MlOrder } from '@delfrance/integrations-mercado-livre';
import type { ItemDoPedido } from '@delfrance/schemas';

import { discoverPedidoMercadoLivre, type DiscoverPedidoArgs } from './orderPedidoTx';
import { makePagamentoIdMercadoLivre, makePedidoIdMercadoLivre } from './orderIds';
import {
  OccEngine,
  deferred,
  type OccOpKind,
  type OccTransaction,
  type OccWriteKind,
} from './testing/occTransaction';

/* ------------------------------ fake Firestore ---------------------------- */
// Extends the established import.test.ts FakeDb shape with a real per-doc
// `.collection(name)` (needed for the `orderML` mirror child, addressed by a
// full path string exactly like every other FakeDb in this folder) and an
// `opLog` recording every get/set/create/update in call order — the
// "reads-before-writes" test asserts on it directly instead of inferring
// ordering from side effects.
//
// `runTransaction` delegates to the SHARED `OccEngine` (`./testing/occTransaction`)
// — the one piece the four FakeDbs in this folder do not duplicate, because a
// per-file OCC model that drifts is worse than none. Everything else stays this
// file's own, which is what the "own copy" comments were always about.

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

interface FakeCollection {
  path: string;
  doc: (id?: string) => FakeDocRef;
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

  collection(path: string): FakeCollection {
    const self = this;
    return {
      path,
      doc(id?: string) {
        const docId = id ?? `auto-${++self.autoN}`;
        return self.makeDocRef(path, docId);
      },
    };
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

  async runTransaction<T>(fn: (tx: OccTransaction) => Promise<T>): Promise<T> {
    return this.occ.runTransaction(fn);
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

  it('an OLDER redelivery never regresses the orderML mirror or the order-clock watermark', async () => {
    const db = new FakeDb();
    const freshIso = '2026-01-05T00:00:00.000Z';
    const first = await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [makeOrder({ id: 2002, lastUpdated: freshIso })],
        itensByOrderId: new Map([[2002, [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })]]]),
      }),
    );

    const second = await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [makeOrder({ id: 2002, lastUpdated: '2026-01-01T00:00:00.000Z' })], // OLDER
        itensByOrderId: new Map([[2002, [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })]]]),
      }),
    );

    expect(second.created).toBe(false);
    expect(second.pedidoId).toBe(first.pedidoId);
    // The mirror keeps update-if-newer semantics: it holds the LATEST known
    // state of this order, so an older payload must not overwrite it.
    expect(db.docs(`pedidos/${first.pedidoId}/orderML`).get('2002')!.last_updated).toBe(
      Date.parse(freshIso),
    );
    // And the pedido's ML order-clock watermark does not move backwards.
    expect(db.docs('pedidos').get(first.pedidoId)!.lastMarketplaceUpdate).toBe(
      Date.parse(freshIso) * 1000,
    );
  });

  it('an OLDER redelivery still contributes a line the pedido has never seen', async () => {
    // Deliberate #791 change: the item merge is no longer gated on the order
    // clock. It is append-only by `ensureUniqueId`, so re-running it can only
    // add lines that are genuinely absent — and "this payload is older" says
    // nothing about whether we already applied THIS line. The old gate dropped
    // the line outright, which is the "items stop syncing" failure the issue is
    // about; convergence beats a gate that has nothing to protect.
    const db = new FakeDb();
    const first = await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [makeOrder({ id: 2003, lastUpdated: '2026-01-05T00:00:00.000Z' })],
        itensByOrderId: new Map([[2003, [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })]]]),
      }),
    );

    await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [makeOrder({ id: 2003, lastUpdated: '2026-01-01T00:00:00.000Z' })], // OLDER
        itensByOrderId: new Map([
          [
            2003,
            [
              makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' }),
              makeItem({ ensureUniqueId: 'u2', produtoUid: 'p2' }),
            ],
          ],
        ]),
      }),
    );

    expect((db.docs('pedidos').get(first.pedidoId)!.itensIds as string[]).sort()).toEqual([
      'p1',
      'p2',
    ]);
    // u1 was NOT duplicated — dedup by ensureUniqueId is what makes the
    // ungated merge safe to re-run.
    const itens = db.docs('pedidos').get(first.pedidoId)!.itens as Record<string, unknown[]>;
    expect(itens.p1).toHaveLength(1);
  });

  it('a byte-identical redelivery writes nothing at all', async () => {
    const db = new FakeDb();
    const order = makeOrder({ id: 2004, lastUpdated: '2026-01-05T00:00:00.000Z' });
    const itens = new Map([[2004, [makeItem({ ensureUniqueId: 'u1', produtoUid: 'p1' })]]]);
    const first = await discoverPedidoMercadoLivre(
      baseArgs(db, { orders: [order], itensByOrderId: itens }),
    );

    const before = db.opLog.length;
    await discoverPedidoMercadoLivre(baseArgs(db, { orders: [order], itensByOrderId: itens }));

    // Retiring the clock gates must not turn every redelivery into a write:
    // nothing moved, so nothing is written.
    const writes = db.opLog.slice(before).filter((o) => o.op !== 'get');
    expect(writes).toEqual([]);
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
  it.each([
    ['fresher order LAST', '2026-01-01T00:00:00.000Z', '2026-01-09T00:00:00.000Z'],
    ['fresher order FIRST', '2026-01-09T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
  ])(
    'a fresh pack pedido takes the MAX order clock across the pack (%s)',
    async (_label, iso1, iso2) => {
      const db = new FakeDb();
      const packId = 7000;
      // Legacy ASSIGNED `ultimaModificacao` on every iteration, so the pack's
      // watermark ended up as "the last order processed" — which is the wrong
      // one whenever the fresher sibling is not last. #791 takes the MAX, so
      // processing order no longer changes the result.
      const order1 = makeOrder({ id: 7001, packId, lastUpdated: iso1 });
      const order2 = makeOrder({ id: 7002, packId, lastUpdated: iso2 });

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
      // The ML ORDER clock — the max of the two, whichever order they arrived in.
      expect(target.lastMarketplaceUpdate).toBe(Date.parse('2026-01-09T00:00:00.000Z') * 1000);
      // The wall-clock "last modified" stamp, which is what `saveRecord`, the
      // recency sort and the TableView update-monitor all read.
      expect(target.ultimaModificacao).toBe(NOW_US);
    },
  );
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

/* --------------------------- concurrency (real OCC) ------------------------ */
// These exercise the shared `OccEngine`'s retry path — the one the previous
// non-isolated fake could not model at all. See `./testing/occTransaction.ts`.

describe('discoverPedidoMercadoLivre — concurrent pack siblings', () => {
  /**
   * Two `orders_v2` notifications for two orders of the SAME pack land at once.
   * Both resolve to the same pedido id (`makePedidoIdMercadoLivre` keys on the
   * PACK id), so both transactions read and write the same document.
   *
   * The loser must ABORT, re-run its callback against the winner's committed
   * state, and APPEND — never replace. If the callback's item list were
   * captured outside the transaction and re-applied verbatim on retry, the
   * winner's line would be lost; that is the lost-update shape ADR 0011 names.
   */
  async function raceTwoPackOrders(secondOrderLastUpdated: string): Promise<{
    db: FakeDb;
    pedidoId: string;
  }> {
    const db = new FakeDb();
    const gate = deferred();
    let heldOne = false;
    // Hold whichever transaction reaches commit FIRST; the other then commits
    // ahead of it and forces the held one through the abort/retry path.
    db.occ.beforeCommit = () => {
      if (heldOne) return undefined;
      heldOne = true;
      return gate.promise;
    };

    const runA = discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [makeOrder({ id: 11, packId: 100, lastUpdated: '2026-01-05T00:00:00.000Z' })],
        packId: 100,
        itensByOrderId: new Map([[11, [makeItem({ ensureUniqueId: 'uA', produtoUid: 'pA' })]]]),
      }),
    );
    const runB = discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [makeOrder({ id: 12, packId: 100, lastUpdated: secondOrderLastUpdated })],
        packId: 100,
        itensByOrderId: new Map([[12, [makeItem({ ensureUniqueId: 'uB', produtoUid: 'pB' })]]]),
      }),
    );

    // The un-held run settles on its own; releasing the gate then lets the held
    // one discover it lost. Racing avoids depending on WHICH one got held,
    // which is an artefact of await ordering rather than of the test's intent.
    await Promise.race([runA, runB]);
    gate.resolve();
    const [resA, resB] = await Promise.all([runA, runB]);

    expect(resA.pedidoId).toBe(resB.pedidoId);
    return { db, pedidoId: resA.pedidoId };
  }

  it('converge on ONE pedido carrying BOTH orders items, and the loser retries', async () => {
    const { db, pedidoId } = await raceTwoPackOrders('2026-01-06T00:00:00.000Z');

    expect(pedidoId).toBe(makePedidoIdMercadoLivre(CONTA_ID, 11, 100));
    const pedido = db.docs('pedidos').get(pedidoId)!;
    expect((pedido.itensIds as string[]).sort()).toEqual(['pA', 'pB']);
    // Proof the retry actually happened — without it the second write would
    // have silently clobbered the first instead of appending to it.
    expect(db.occ.txLog.some((e) => e.phase === 'abort')).toBe(true);
    // Exactly one order mirror per order, both present.
    expect([...db.docs(`pedidos/${pedidoId}/orderML`).keys()].sort()).toEqual(['11', '12']);
  });

  it('keeps the second orders items even when its own clock is OLDER than the first', async () => {
    // A pack sibling that ML stamped EARLIER still has to contribute its lines:
    // it is a different ML resource, so "older" says nothing about whether we
    // have already applied it. What answers that is its own orderML mirror,
    // which does not exist yet on this pedido.
    const { db, pedidoId } = await raceTwoPackOrders('2026-01-01T00:00:00.000Z');

    const pedido = db.docs('pedidos').get(pedidoId)!;
    expect((pedido.itensIds as string[]).sort()).toEqual(['pA', 'pB']);
  });
});

/* ---------------- clock model: units and the wrong-field trap -------------- */
// Issue #791 (O3 + O15). These pin the two properties the guards depend on:
// the ML order clock lives in `lastMarketplaceUpdate` and nowhere else, and
// every stored watermark is read through `coerceToMicros` so a legacy Flutter
// value compares as the same instant.

describe('discoverPedidoMercadoLivre — clock model', () => {
  it('a human ultimaModificacao bump does NOT stall the ML item sync', async () => {
    // THE regression this issue exists to prevent. `ultimaModificacao` is
    // stamped with the WALL CLOCK by `saveRecord` on every human save, by the
    // Mercado Pago reconcile, and by the Flutter app. While it was the item
    // merge's gate, one operator edit dropped every ML order payload older than
    // that save — silently, and for as long as ML's clock stayed behind it.
    const db = new FakeDb();
    const pedidoId = makePedidoIdMercadoLivre(CONTA_ID, 9100);
    const humanSaveUs = Date.parse('2026-01-09T18:30:00.000Z') * 1000; // a human saved
    const mlClockUs = Date.parse('2026-01-01T00:00:00.000Z') * 1000; // ML is behind

    db.seed('pedidos', pedidoId, {
      ehSaida: true,
      estado: 'pago',
      numero: '9100',
      itens: { p1: [makeItem({ ensureUniqueId: 'uA', produtoUid: 'p1' })] },
      itensIds: ['p1'],
      ultimaModificacao: humanSaveUs,
      lastMarketplaceUpdate: mlClockUs,
    });
    db.seed(`pedidos/${pedidoId}/orderML`, '9100', {
      id: 9100,
      last_updated: Date.parse('2026-01-01T00:00:00.000Z'),
    });

    // Newer than the ML clock, OLDER than the human save — the exact window the
    // old gate swallowed.
    await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [makeOrder({ id: 9100, lastUpdated: '2026-01-05T00:00:00.000Z' })],
        itensByOrderId: new Map([
          [
            9100,
            [
              makeItem({ ensureUniqueId: 'uA', produtoUid: 'p1' }),
              makeItem({ ensureUniqueId: 'uB', produtoUid: 'p2' }), // must land
            ],
          ],
        ]),
      }),
    );

    const pedido = db.docs('pedidos').get(pedidoId)!;
    expect((pedido.itensIds as string[]).sort()).toEqual(['p1', 'p2']);
    expect(pedido.lastMarketplaceUpdate).toBe(Date.parse('2026-01-05T00:00:00.000Z') * 1000);
    // The wall-clock stamp only ever moves FORWARD — never onto a payload clock.
    expect(pedido.ultimaModificacao as number).toBeGreaterThanOrEqual(humanSaveUs);
  });

  it('reads a legacy MILLISECOND lastMarketplaceUpdate as the same instant', async () => {
    const db = new FakeDb();
    const pedidoId = makePedidoIdMercadoLivre(CONTA_ID, 9001);
    const storedMs = Date.parse('2026-01-20T00:00:00.000Z'); // legacy Flutter wire format

    db.seed('pedidos', pedidoId, {
      ehSaida: true,
      estado: 'pago',
      numero: '9001',
      itens: { p1: [makeItem({ ensureUniqueId: 'uA', produtoUid: 'p1' })] },
      itensIds: ['p1'],
      lastMarketplaceUpdate: storedMs,
    });
    db.seed(`pedidos/${pedidoId}/orderML`, '9001', {
      id: 9001,
      last_updated: Date.parse('2026-01-01T00:00:00.000Z'),
    });

    // Older than the stored watermark once both are in the same unit.
    await discoverPedidoMercadoLivre(
      baseArgs(db, {
        orders: [makeOrder({ id: 9001, lastUpdated: '2026-01-10T00:00:00.000Z' })],
        itensByOrderId: new Map([[9001, [makeItem({ ensureUniqueId: 'uA', produtoUid: 'p1' })]]]),
      }),
    );

    // Read RAW, `1.769e12 < 1.768e15` would look "older" and the watermark would
    // be dragged backwards. Coerced, the stored value wins and stays put.
    expect(db.docs('pedidos').get(pedidoId)!.lastMarketplaceUpdate).toBe(storedMs);
  });

  it('reads a legacy ISO-STRING pagamento ultimaModificacao as a real timestamp', async () => {
    const db = new FakeDb();
    const pagId = makePagamentoIdMercadoLivre(CONTA_ID, 555);
    const order = makeOrder({
      id: 9002,
      lastUpdated: '2026-01-10T00:00:00.000Z',
      payments: [
        makePayment({ id: 555, lastModified: '2026-01-05T00:00:00.000Z', transactionAmount: 999 }),
      ],
    });
    const pedidoId = makePedidoIdMercadoLivre(CONTA_ID, 9002);
    db.seed('pedidos', pedidoId, {
      ehSaida: true,
      estado: 'pago',
      numero: '9002',
      itens: {},
      itensIds: [],
      lastMarketplaceUpdate: Date.parse('2026-01-01T00:00:00.000Z') * 1000,
    });
    db.seed(`pedidos/${pedidoId}/pagamentos`, pagId, {
      id: '555',
      valor: 100,
      ultimaModificacao: '2026-01-08T00:00:00.000Z', // legacy Flutter wire: ISO string
    });

    await discoverPedidoMercadoLivre(
      baseArgs(db, { orders: [order], itensByOrderId: new Map([[9002, []]]) }),
    );

    // A raw numeric read returns null for a string, and null means PROCEED — so
    // the stale 999 used to land. Coerced, the stored (newer) row is kept.
    expect(db.docs(`pedidos/${pedidoId}/pagamentos`).get(pagId)!.valor).toBe(100);
  });
});
