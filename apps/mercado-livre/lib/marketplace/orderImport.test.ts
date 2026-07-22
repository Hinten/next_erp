import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { MercadoLivreHttpError, type MercadoLivreApi } from '@delfrance/integrations-mercado-livre';

import { OrderItemsIncompleteError } from './orderMapping';

/* -------------------------------------------------------------------------- */
/*                                   Mocks                                    */
/* -------------------------------------------------------------------------- */
// A3 composes A1 (orderCliente)/A2 (orderPedidoTx)/A4 (orderPrazoDespacho) —
// all separately-owned Step 9 modules with their own test suites. This file
// tests A3's OWN orchestration (guards, pack fan-out, branch selection,
// pago-advance/downgrade decisions) against controlled doubles for those three
// plus the produto-link lookup (`./import`'s `resolveExistingProduto`, a
// sizable module with its own coverage) — not their internals.

vi.mock('./import', () => ({
  resolveExistingProduto: vi.fn(async () => null),
}));
vi.mock('./orderCliente', () => {
  class MlBillingInfoUnsupportedError extends Error {}
  return {
    MlBillingInfoUnsupportedError,
    billingInfoToClienteFields: vi.fn(),
    billingInfoToEnderecoFields: vi.fn(() => null),
    shipmentToEnderecoFields: vi.fn(() => null),
    findOrCreateCliente: vi.fn(),
    ensureEndereco: vi.fn(),
  };
});
vi.mock('./orderPedidoTx', () => ({
  discoverPedidoMercadoLivre: vi.fn(),
}));
vi.mock('./orderPrazoDespacho', () => ({
  resolvePrazoDespacho: vi.fn(async () => null),
}));

import { resolveExistingProduto } from './import';
import {
  MlBillingInfoUnsupportedError,
  billingInfoToClienteFields,
  billingInfoToEnderecoFields,
  ensureEndereco,
  findOrCreateCliente,
} from './orderCliente';
import { discoverPedidoMercadoLivre } from './orderPedidoTx';
import { resolvePrazoDespacho } from './orderPrazoDespacho';
import { importPedidoMercadoLivre, type OrderImportDeps } from './orderImport';

/* ------------------------------ fake Firestore ---------------------------- */
// Scoped to what orderImport.ts touches directly: `integracao`, `int_frete`,
// `pedidos`, `pedidos/{id}/pagamentos` — mirrors the established
// import.test.ts/orderPedidoTx.test.ts FakeDb shape (doc get/set/update/create,
// a chained where/limit/get query, and a non-isolated runTransaction).

type DocData = Record<string, unknown>;

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

  private query(entries: Array<[string, DocData]>) {
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
          docs: rows.map(([id, d]) => ({ id, data: () => d, exists: true })),
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
          update: async (patch: DocData) => {
            col.set(docId, { ...(col.get(docId) ?? {}), ...patch });
          },
        };
      },
      where: (field: string, op: string, value: unknown) =>
        self.query([...col.entries()]).where(field, op, value),
      get: async () => ({
        docs: [...col.entries()].map(([id, d]) => ({ id, data: () => d, exists: true })),
      }),
    };
  }

  // No real isolation/retry — enough for these single-threaded unit tests
  // (same simplification every FakeDb in this folder documents).
  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    const tx: FakeTransaction = {
      get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
      set: async (
        ref: { set: (d: DocData, o?: { merge?: boolean }) => Promise<void> },
        data: DocData,
      ) => {
        await ref.set(data);
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
  set: (ref: { set: (d: DocData) => Promise<void> }, data: DocData) => Promise<void>;
  update: (ref: { update: (d: DocData) => Promise<void> }, patch: DocData) => Promise<void>;
}

const asDb = (db: FakeDb) => db as unknown as Firestore;

/* --------------------------------- fixtures ------------------------------- */

const INTEGRACAO_ID = 'conta-A';
const SELLER_USER_ID = 555;
const NOW_US = Date.parse('2026-01-10T00:00:00.000Z') * 1000;
const NOW_MS = Math.floor(NOW_US / 1000);

function seedConta(db: FakeDb, over: DocData = {}): void {
  db.seed('integracao', INTEGRACAO_ID, {
    tipo: 1,
    nome: 'Loja ML',
    ativo: true,
    user_id: SELLER_USER_ID,
    cpf_cnpj: '11222333000144',
    operacaoOuterRef: 'documents/operacao/op1',
    tabelaNormalOuterRef: 'documents/tabelasDePrecos/tabNormal',
    ...over,
  });
}

function makeOrder(opts: {
  id: number;
  packId?: number | null;
  status?: string;
  lastUpdated?: string;
  shippingId?: number | null;
  itens?: boolean;
}): DocData {
  return {
    id: opts.id,
    status: opts.status ?? 'paid',
    date_created: opts.lastUpdated ?? '2026-01-01T00:00:00.000-03:00',
    last_updated: opts.lastUpdated ?? '2026-01-01T00:00:00.000-03:00',
    pack_id: opts.packId ?? null,
    order_items:
      opts.itens === false
        ? []
        : [
            {
              item: { id: `MLB${opts.id}`, title: 'Produto', seller_sku: null },
              quantity: 1,
              unit_price: 100,
            },
          ],
    total_amount: 100,
    buyer: { id: 900 },
    seller: { id: SELLER_USER_ID },
    shipping: opts.shippingId != null ? { id: opts.shippingId } : null,
    payments: [],
  };
}

function makeApi(over: Partial<Record<keyof MercadoLivreApi, unknown>> = {}): MercadoLivreApi {
  return {
    getOrder: vi.fn(),
    getPack: vi.fn(),
    searchOrders: vi.fn(),
    getPayment: vi.fn(async (id: number | string) => ({ id: Number(id), status: 'approved' })),
    getShipment: vi.fn(async (id: number | string) => ({
      id: Number(id),
      order_id: 1,
      status: 'shipped',
      last_updated: '2026-01-02T00:00:00.000-03:00',
      shipping_option: {},
    })),
    getShipmentPayments: vi.fn(async () => []),
    getShipmentSla: vi.fn(),
    getSellerShippingSchedule: vi.fn(),
    getOrderBillingInfo: vi.fn(async () => ({ site_id: 'MLB', buyer: {}, seller: {} })),
    ...over,
  } as unknown as MercadoLivreApi;
}

function deps(db: FakeDb, api: MercadoLivreApi): OrderImportDeps {
  return { db: asDb(db), api, integracaoId: INTEGRACAO_ID, nowUs: NOW_US, nowMs: NOW_MS };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveExistingProduto).mockResolvedValue(null);
  vi.mocked(resolvePrazoDespacho).mockResolvedValue(null);
  vi.mocked(discoverPedidoMercadoLivre).mockResolvedValue({ pedidoId: 'pedido-1', created: true });
  // Harmless defaults for tests that don't seed a pedido doc (so the
  // pedido-not-found → clientePedidoOuterRef-reads-undefined path doesn't
  // crash on an unconfigured mock) — tests exercising the cliente/endereço
  // steps directly override these per-case.
  vi.mocked(billingInfoToClienteFields).mockReturnValue({
    tipo: 'pf',
    nome: 'Comprador Padrão',
    cpf_cnpj: '00000000000',
    idEstrangeiro: null,
    ie: null,
    telefone: null,
    email: null,
  });
  vi.mocked(findOrCreateCliente).mockResolvedValue({ clienteId: 'cli-default', created: true });
  // `mockClear` (above) doesn't reset a mock's implementation — restore the
  // module factory's null default explicitly so a test overriding it doesn't
  // leak into whichever test runs next.
  vi.mocked(billingInfoToEnderecoFields).mockReturnValue(null);
});

/* ----------------------------------- tests --------------------------------- */

describe('importPedidoMercadoLivre — guards', () => {
  it('drops an order with no buyer', async () => {
    const db = new FakeDb();
    seedConta(db);
    const order = makeOrder({ id: 1 });
    delete order.buyer;
    const api = makeApi({ getOrder: vi.fn(async () => order) });

    const result = await importPedidoMercadoLivre(deps(db, api), 1);

    expect(result).toEqual({ pedidoId: null, created: false, skipped: 'no-buyer' });
    expect(discoverPedidoMercadoLivre).not.toHaveBeenCalled();
  });

  it('drops an order whose seller does not match the account', async () => {
    const db = new FakeDb();
    seedConta(db);
    const order = makeOrder({ id: 1 });
    order.seller = { id: 999 };
    const api = makeApi({ getOrder: vi.fn(async () => order) });

    const result = await importPedidoMercadoLivre(deps(db, api), 1);

    expect(result).toEqual({ pedidoId: null, created: false, skipped: 'seller-mismatch' });
    expect(discoverPedidoMercadoLivre).not.toHaveBeenCalled();
  });

  it('throws OrderItemsIncompleteError on an order with no order_items (206 partial)', async () => {
    const db = new FakeDb();
    seedConta(db);
    const order = makeOrder({ id: 1, itens: false });
    const api = makeApi({ getOrder: vi.fn(async () => order) });

    await expect(importPedidoMercadoLivre(deps(db, api), 1)).rejects.toThrow(
      OrderItemsIncompleteError,
    );
    expect(discoverPedidoMercadoLivre).not.toHaveBeenCalled();
  });
});

describe('importPedidoMercadoLivre — order/pack fetch', () => {
  it('falls back to get_pack on a 404, importing the pack first order', async () => {
    const db = new FakeDb();
    seedConta(db);
    const order = makeOrder({ id: 501, packId: 500 });
    const getOrder = vi
      .fn()
      .mockRejectedValueOnce(new MercadoLivreHttpError('ML 404: not found', 404, null))
      .mockResolvedValueOnce(order);
    const api = makeApi({
      getOrder,
      getPack: vi.fn(async () => ({ id: 500, status: 'ready', orders: [{ id: 501 }] })),
    });

    const result = await importPedidoMercadoLivre(deps(db, api), 500);

    expect(result).toEqual({ pedidoId: 'pedido-1', created: true, skipped: null });
    expect(getOrder).toHaveBeenNthCalledWith(1, 500);
    expect(getOrder).toHaveBeenNthCalledWith(2, 501);
  });

  it('fans out to every sibling order of a pack, feeding all of them to discoverPedidoMercadoLivre', async () => {
    const db = new FakeDb();
    seedConta(db);
    const initial = makeOrder({ id: 11, packId: 100 });
    const sibling = makeOrder({ id: 12, packId: 100 });
    const getOrder = vi.fn(async (id: number) => (id === 11 ? initial : sibling));
    const api = makeApi({
      getOrder,
      getPack: vi.fn(async () => ({ id: 100, status: 'ready', orders: [{ id: 11 }, { id: 12 }] })),
    });

    const result = await importPedidoMercadoLivre(deps(db, api), 11);

    expect(result.pedidoId).toBe('pedido-1');
    const args = vi.mocked(discoverPedidoMercadoLivre).mock.calls[0]![0];
    expect(args.packId).toBe(100);
    expect(args.orders.map((o) => o.id)).toEqual([11, 12]);
    expect(args.itensByOrderId.get(11)).toHaveLength(1);
    expect(args.itensByOrderId.get(12)).toHaveLength(1);
  });
});

describe('importPedidoMercadoLivre — cliente', () => {
  it('links a newly found cliente when clientePedidoOuterRef is null', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('pedidos', 'pedido-1', { estado: 'iniciado', clientePedidoOuterRef: null, itens: {} });
    const order = makeOrder({ id: 1 });
    const api = makeApi({ getOrder: vi.fn(async () => order) });

    vi.mocked(billingInfoToClienteFields).mockReturnValue({
      tipo: 'pf',
      nome: 'Fulano',
      cpf_cnpj: '11122233344',
      idEstrangeiro: null,
      ie: null,
      telefone: null,
      email: null,
    });
    vi.mocked(findOrCreateCliente).mockResolvedValue({ clienteId: 'cli-1', created: true });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({
      clientePedidoOuterRef: 'documents/clientes/cli-1',
    });
  });

  it('skips the cliente step (and continues the import) on MlBillingInfoUnsupportedError', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('pedidos', 'pedido-1', { estado: 'iniciado', clientePedidoOuterRef: null, itens: {} });
    const order = makeOrder({ id: 1 });
    const api = makeApi({ getOrder: vi.fn(async () => order) });

    vi.mocked(billingInfoToClienteFields).mockImplementation(() => {
      throw new MlBillingInfoUnsupportedError('tipo não suportado');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await importPedidoMercadoLivre(deps(db, api), 1);

    expect(result).toEqual({ pedidoId: 'pedido-1', created: true, skipped: null });
    expect(findOrCreateCliente).not.toHaveBeenCalled();
    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({ clientePedidoOuterRef: null });
    expect(warn).toHaveBeenCalled();
  });
});

describe('importPedidoMercadoLivre — endereço', () => {
  it('links the endereço resolved under the SAME clienteId findOrCreateCliente just returned', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('pedidos', 'pedido-1', { estado: 'iniciado', clientePedidoOuterRef: null, itens: {} });
    const order = makeOrder({ id: 1 });
    const api = makeApi({ getOrder: vi.fn(async () => order) });

    vi.mocked(findOrCreateCliente).mockResolvedValue({ clienteId: 'cli-77', created: true });
    vi.mocked(billingInfoToEnderecoFields).mockReturnValue({
      idExterno: null,
      cep: '01310100',
      logradouro: 'Av. Paulista',
      numero: '1000',
      bairro: 'Bela Vista',
      complemento: null,
      codigoMunicipio: null,
      cidade: 'São Paulo',
      estado: 'SP',
      cPais: null,
      pais: null,
      nome: null,
      cpf_cnpj: null,
      rg: null,
      ie: null,
      imun: null,
      email: null,
      telefone: null,
    });
    vi.mocked(ensureEndereco).mockResolvedValue('end-99');

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({
      clientePedidoOuterRef: 'documents/clientes/cli-77',
      enderecoFiscalOuterRef: 'documents/clientes/cli-77/enderecos/end-99',
    });
  });
});

describe('importPedidoMercadoLivre — frete', () => {
  it('runs the full-conference branch on a shipping id, mapping freteInicial and pinning ultimaModificacao to the ORDER timestamp', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('pedidos', 'pedido-1', {
      estado: 'iniciado',
      clientePedidoOuterRef: 'documents/clientes/cli-1',
      enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
      freteInicial: null,
      itens: {
        'produto-1': [
          {
            produtoUid: 'produto-1',
            ordem: 1,
            precoDeVenda: 100,
            quantidade: 1,
            descontoUnitario: 0,
          },
        ],
      },
    });
    const orderLastUpdated = '2026-01-05T10:00:00.000-03:00';
    const order = makeOrder({ id: 1, shippingId: 777, lastUpdated: orderLastUpdated });
    const api = makeApi({
      getOrder: vi.fn(async () => order),
      getShipment: vi.fn(async () => ({
        id: 777,
        order_id: 1,
        status: 'ready_to_ship',
        substatus: null,
        last_updated: '2026-01-02T00:00:00.000-03:00',
        base_cost: 15,
        shipping_option: {
          list_cost: 25,
          estimated_delivery_time: { date: '2026-01-15T00:00:00.000-03:00' },
        },
      })),
      getShipmentPayments: vi.fn(async () => [{ payment_id: 900, status: 'approved', amount: 20 }]),
    });
    const prazoDespachoUs = Date.parse('2026-01-08T00:00:00.000Z') * 1000;
    vi.mocked(resolvePrazoDespacho).mockResolvedValue(prazoDespachoUs);

    await importPedidoMercadoLivre(deps(db, api), 1);

    const written = db.docs('pedidos').get('pedido-1');
    expect(written).toMatchObject({
      valorCobrado: 120, // roundReais(totalItens 100 + valorFreteInicial 20)
      ultimaModificacao: Date.parse(orderLastUpdated) * 1000, // the ORDER's timestamp, not nowUs
    });
    expect(written!.freteInicial).toMatchObject({
      externalId: '777',
      estado: 'despachoAutorizado', // ready_to_ship + null substatus → base-status map
      valorCobrado: 20, // sum of approved shipping payments
      prazoDespacho: prazoDespachoUs,
    });
  });

  it('leaves an existing freteInicial untouched when the shipment read is not stale', async () => {
    const db = new FakeDb();
    seedConta(db);
    const freteInicial = {
      estado: 'postado',
      prazoDespacho: Date.parse('2026-01-03T00:00:00.000Z') * 1000,
      ultimaModificacao: Date.parse('2026-01-05T00:00:00.000Z') * 1000,
    };
    db.seed('pedidos', 'pedido-1', {
      // Not in ESTADOS_CONFERIR_PAGAMENTO — the staleness check alone must gate this no-op.
      estado: 'pago',
      clientePedidoOuterRef: 'documents/clientes/cli-1',
      enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
      freteInicial,
      itens: {},
    });
    const order = makeOrder({ id: 1, shippingId: 777, status: 'paid' });
    const getShipmentPayments = vi.fn(async () => []);
    const api = makeApi({
      getOrder: vi.fn(async () => order),
      getShipment: vi.fn(async () => ({
        id: 777,
        order_id: 1,
        status: 'shipped',
        last_updated: '2026-01-01T00:00:00.000-03:00', // OLDER than freteInicial.ultimaModificacao
        shipping_option: {},
      })),
      getShipmentPayments,
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(getShipmentPayments).not.toHaveBeenCalled();
    expect(db.docs('pedidos').get('pedido-1')!.freteInicial).toEqual(freteInicial);
  });
});

describe('importPedidoMercadoLivre — pago advance / downgrade', () => {
  it('advances emProcessamento → pago once registered pagamentos cover valorCobrado', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('pedidos', 'pedido-1', {
      estado: 'emProcessamento',
      clientePedidoOuterRef: 'documents/clientes/cli-1',
      enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
      freteInicial: { estado: 'iniciado' },
      valorCobrado: 100,
      itens: {},
    });
    db.seed('pedidos/pedido-1/pagamentos', 'pag-1', { id: '900', valor: 100, status_pagamento: 4 });
    const order = makeOrder({ id: 1 });
    const api = makeApi({ getOrder: vi.fn(async () => order) });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({ estado: 'pago' });
  });

  it('downgrades a pago pedido to fraude when the incoming order is invalid and payments no longer cover it', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('pedidos', 'pedido-1', {
      estado: 'pago',
      clientePedidoOuterRef: 'documents/clientes/cli-1',
      enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
      freteInicial: { estado: 'postado' },
      valorCobrado: 100,
      itens: {},
    });
    db.seed('pedidos/pedido-1/pagamentos', 'pag-1', { id: '900', valor: 40, status_pagamento: 4 });
    const order = makeOrder({ id: 1, status: 'invalid' });
    const api = makeApi({ getOrder: vi.fn(async () => order) });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({ estado: 'fraude' });
  });

  it('does NOT downgrade a pago pedido when approved payments already cover valorCobrado', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('pedidos', 'pedido-1', {
      estado: 'pago',
      clientePedidoOuterRef: 'documents/clientes/cli-1',
      enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
      freteInicial: { estado: 'postado' },
      valorCobrado: 100,
      itens: {},
    });
    db.seed('pedidos/pedido-1/pagamentos', 'pag-1', { id: '900', valor: 100, status_pagamento: 4 });
    const order = makeOrder({ id: 1, status: 'cancelled' });
    const api = makeApi({ getOrder: vi.fn(async () => order) });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({ estado: 'pago' });
  });
});
