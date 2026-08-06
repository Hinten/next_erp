import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  type MercadoLivreApi,
  type MlOrder,
} from '@delfrance/integrations-mercado-livre';

import { OrderItemsIncompleteError } from './orderMapping';

/* -------------------------------------------------------------------------- */
/*                                   Mocks                                    */
/* -------------------------------------------------------------------------- */
// A3 composes A1 (orderCliente)/A2 (orderPedidoTx)/A4 (orderPrazoDespacho) —
// all separately-owned Step 9 modules with their own test suites. This file
// tests A3's OWN orchestration (guards, pack fan-out, branch selection,
// pago-advance/downgrade decisions) against controlled doubles for those three
// plus the order-line produto resolution (`./orderProdutoResolve`, whose own
// cascade is covered by `orderProdutoResolve.test.ts`) — not their internals.

vi.mock('./orderProdutoResolve', () => ({
  resolveOrderLineProduto: vi.fn(async () => null),
}));
vi.mock('./orderCliente', () => {
  class MlBillingInfoUnsupportedError extends Error {}
  return {
    MlBillingInfoUnsupportedError,
    billingInfoToClienteFields: vi.fn(),
    billingInfoToEnderecoFields: vi.fn(() => ({ kind: 'sem-cep', cepRaw: null })),
    shipmentToEnderecoFields: vi.fn(() => ({ kind: 'sem-cep', cepRaw: null })),
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

import { resolveOrderLineProduto } from './orderProdutoResolve';
import {
  MlBillingInfoUnsupportedError,
  billingInfoToClienteFields,
  billingInfoToEnderecoFields,
  ensureEndereco,
  findOrCreateCliente,
  shipmentToEnderecoFields,
} from './orderCliente';
import { discoverPedidoMercadoLivre } from './orderPedidoTx';
import { resolvePrazoDespacho } from './orderPrazoDespacho';
import { importPedidoMercadoLivre, mergeFreteInicial, type OrderImportDeps } from './orderImport';
import { makeItemEnsureUniqueId } from './orderIds';
import type { MappedFreteInicialFields } from './orderShipmentMapping';
import {
  TIPO_CLIENTE,
  INTEGRACAO_FRETE,
  ESTADO_FRETE,
  ORIGEM_INCIDENTE,
  TIPO_INCIDENTE,
  UF_SIGLA,
} from '@delfrance/schemas';
import type { EnderecoBuildOutcome, EnderecoForcado, FreteDoPedido } from '@delfrance/schemas';
import type { EnderecoViaCep, ViaCepClient } from '@delfrance/core/cep';

/* --------------------------- endereço test doubles ------------------------- */

const SEM_CEP = { kind: 'sem-cep', cepRaw: null } as const satisfies EnderecoBuildOutcome;

const ENDERECO_SP: EnderecoForcado = {
  idExterno: null,
  cep: '01310100',
  logradouro: 'Av. Paulista',
  numero: '1000',
  bairro: 'Bela Vista',
  complemento: null,
  codigoMunicipio: null,
  cidade: 'São Paulo',
  estado: UF_SIGLA.SP,
  cPais: null,
  pais: null,
  nome: null,
  cpf_cnpj: null,
  rg: null,
  ie: null,
  imun: null,
  email: null,
  telefone: null,
};

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
          // Create-only, rejecting like the real gRPC ALREADY_EXISTS (code 6) so
          // the #792 incidente writer's idempotency guard is exercised for real.
          create: async (data: DocData) => {
            if (col.has(docId)) {
              throw Object.assign(new Error(`ALREADY_EXISTS: ${docId}`), { code: 6 });
            }
            col.set(docId, { ...data });
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
  const base: Record<string, unknown> = {
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
  };

  // The import fetches orders through `getOrderResponse` (it needs 200-vs-206 to
  // decide replace-vs-merge on the orderML mirror — #793). Derive it from
  // whatever `getOrder` the test supplied and report a complete 200, which is
  // the normal case; a test that needs a partial answer overrides it directly.
  if (base.getOrderResponse == null) {
    const getOrder = base.getOrder as (id: number | string) => Promise<MlOrder>;
    base.getOrderResponse = vi.fn(async (id: number | string) => ({
      order: await getOrder(id),
      complete: true,
    }));
  }
  return base as unknown as MercadoLivreApi;
}

function deps(db: FakeDb, api: MercadoLivreApi, viaCep?: ViaCepClient): OrderImportDeps {
  // `viaCep` defaults to a client that answers nothing rather than to the
  // process-wide one: a shared memo would leak one case's answer into the next
  // and let an "unreachable" assertion pass off a stale cached hit.
  return {
    db: asDb(db),
    api,
    integracaoId: INTEGRACAO_ID,
    nowUs: NOW_US,
    nowMs: NOW_MS,
    viaCep: viaCep ?? stubViaCep(null),
  };
}

function stubViaCep(resposta: EnderecoViaCep | null): ViaCepClient {
  return { buscarCep: vi.fn(async () => resposta) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveOrderLineProduto).mockResolvedValue(null);
  vi.mocked(resolvePrazoDespacho).mockResolvedValue(null);
  vi.mocked(discoverPedidoMercadoLivre).mockResolvedValue({ pedidoId: 'pedido-1', created: true });
  // Harmless defaults for tests that don't seed a pedido doc (so the
  // pedido-not-found → clientePedidoOuterRef-reads-undefined path doesn't
  // crash on an unconfigured mock) — tests exercising the cliente/endereço
  // steps directly override these per-case.
  vi.mocked(billingInfoToClienteFields).mockReturnValue({
    tipo: TIPO_CLIENTE.pessoaFisica,
    nome: 'Comprador Padrão',
    cpf_cnpj: '00000000000',
    idEstrangeiro: null,
    ie: null,
    telefone: null,
    email: null,
  });
  vi.mocked(findOrCreateCliente).mockResolvedValue({ clienteId: 'cli-default', created: true });
  // `mockClear` (above) doesn't reset a mock's implementation — restore the
  // module factory's "no endereço" default explicitly so a test overriding it
  // doesn't leak into whichever test runs next.
  vi.mocked(billingInfoToEnderecoFields).mockReturnValue(SEM_CEP);
  vi.mocked(shipmentToEnderecoFields).mockReturnValue(SEM_CEP);
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
    // Both fetches answered a complete 200 (the makeApi default).
    expect([...(args.completeOrderIds ?? [])].sort()).toEqual([11, 12]);
  });

  it('reports completeness PER ORDER — one sibling answering 206 does not taint the others', async () => {
    // Every order of the pack is its own `GET /orders/{id}`, so a partial answer
    // for one must not license replacing the others' orderML mirrors (#793).
    const db = new FakeDb();
    seedConta(db);
    const initial = makeOrder({ id: 11, packId: 100 });
    const sibling = makeOrder({ id: 12, packId: 100 });
    const api = makeApi({
      getPack: vi.fn(async () => ({ id: 100, status: 'ready', orders: [{ id: 11 }, { id: 12 }] })),
      getOrderResponse: vi.fn(async (id: number) =>
        id === 11 ? { order: initial, complete: true } : { order: sibling, complete: false },
      ),
    });

    await importPedidoMercadoLivre(deps(db, api), 11);

    const args = vi.mocked(discoverPedidoMercadoLivre).mock.calls[0]![0];
    expect(args.orders.map((o) => o.id)).toEqual([11, 12]);
    expect([...(args.completeOrderIds ?? [])]).toEqual([11]);
  });

  it('leaves completeOrderIds empty when the initiating fetch is a 206', async () => {
    const db = new FakeDb();
    seedConta(db);
    const order = makeOrder({ id: 1 });
    const api = makeApi({
      getOrderResponse: vi.fn(async () => ({ order, complete: false })),
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    const args = vi.mocked(discoverPedidoMercadoLivre).mock.calls[0]![0];
    expect([...(args.completeOrderIds ?? [])]).toEqual([]);
  });
});

describe('importPedidoMercadoLivre — produto resolution per line (#792)', () => {
  /** An order whose single line is a size/colour variation of a parent listing. */
  function makeVariationOrder(opts: {
    id: number;
    packId?: number | null;
    itemId?: string;
    variationId?: number | string | null;
    sku?: string | null;
  }): DocData {
    const base = makeOrder({ id: opts.id, packId: opts.packId ?? null });
    return {
      ...base,
      order_items: [
        {
          item: {
            id: opts.itemId ?? `MLB${opts.id}`,
            title: 'Camiseta',
            variation_id: opts.variationId ?? null,
            seller_sku: opts.sku ?? null,
          },
          quantity: 1,
          unit_price: 100,
        },
      ],
    };
  }

  it('forwards variation_id (stringified) and seller_sku, and keys the item on the resolved CHILD', async () => {
    const db = new FakeDb();
    seedConta(db);
    const order = makeVariationOrder({ id: 70, variationId: 456, sku: 'CAM-P-AZUL' });
    const api = makeApi({ getOrder: vi.fn(async () => order) });
    vi.mocked(resolveOrderLineProduto).mockResolvedValue({
      produtoId: 'filho-1',
      via: 'variation-link',
    });

    await importPedidoMercadoLivre(deps(db, api), 70);

    expect(resolveOrderLineProduto).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolveOrderLineProduto).mock.calls[0]![1]).toEqual({
      itemId: 'MLB70',
      variationId: '456', // number on the wire, string for the query
      sku: 'CAM-P-AZUL',
      integracaoId: INTEGRACAO_ID,
    });
    const args = vi.mocked(discoverPedidoMercadoLivre).mock.calls[0]![0];
    const item = args.itensByOrderId.get(70)![0]!;
    expect(item.produtoUid).toBe('filho-1'); // the CHILD, not the parent listing
    expect(item.mktplaceId).toBe('456'); // unchanged: the variation id
  });

  it('passes variationId null for a simple line', async () => {
    const db = new FakeDb();
    seedConta(db);
    const api = makeApi({ getOrder: vi.fn(async () => makeVariationOrder({ id: 71 })) });

    await importPedidoMercadoLivre(deps(db, api), 71);

    expect(vi.mocked(resolveOrderLineProduto).mock.calls[0]![1]).toMatchObject({
      itemId: 'MLB71',
      variationId: null,
    });
  });

  it('memoizes per (itemId, variationId) across a pack — one resolve for a repeated line', async () => {
    const db = new FakeDb();
    seedConta(db);
    // Two sibling orders of the same pack selling the SAME variation.
    const initial = makeVariationOrder({ id: 81, packId: 800, itemId: 'MLB9', variationId: 5 });
    const sibling = makeVariationOrder({ id: 82, packId: 800, itemId: 'MLB9', variationId: 5 });
    const api = makeApi({
      getOrder: vi.fn(async (id: number) => (id === 81 ? initial : sibling)),
      getPack: vi.fn(async () => ({ id: 800, status: 'ready', orders: [{ id: 81 }, { id: 82 }] })),
    });
    vi.mocked(resolveOrderLineProduto).mockResolvedValue({
      produtoId: 'filho-9',
      via: 'variation-link',
    });

    await importPedidoMercadoLivre(deps(db, api), 81);

    expect(resolveOrderLineProduto).toHaveBeenCalledTimes(1);
    const args = vi.mocked(discoverPedidoMercadoLivre).mock.calls[0]![0];
    expect(args.itensByOrderId.get(81)![0]!.produtoUid).toBe('filho-9');
    expect(args.itensByOrderId.get(82)![0]!.produtoUid).toBe('filho-9');
  });

  it('records ONE incidente at a deterministic id when the line resolves to no produto', async () => {
    const db = new FakeDb();
    seedConta(db);
    const order = makeVariationOrder({ id: 90, variationId: 77, sku: 'SEM-VINCULO' });
    const api = makeApi({ getOrder: vi.fn(async () => order) });
    vi.mocked(resolveOrderLineProduto).mockResolvedValue(null);

    await importPedidoMercadoLivre(deps(db, api), 90);

    const args = vi.mocked(discoverPedidoMercadoLivre).mock.calls[0]![0];
    const item = args.itensByOrderId.get(90)![0]!;
    expect(item.produtoUid).toBeNull(); // inert for stock — never the parent

    const incidentes = db.docs('pedidos/pedido-1/incidentes');
    expect(incidentes.size).toBe(1);
    const expectedId = `ml-prod-${makeItemEnsureUniqueId(90, '77', 0)}`;
    const row = incidentes.get(expectedId)!;
    expect(row).toBeDefined();
    expect(row.origem).toBe(ORIGEM_INCIDENTE.pedidoMercadoLivre);
    expect(row.tipo).toBe(TIPO_INCIDENTE.outros);
    expect(row.subtipo).toBe('ml-produto-nao-vinculado');
    expect(row.externalId).toBe('77');
    expect(row.timestamp).toBe(NOW_US); // microseconds — the pedido-family unit
    expect(row.motivoDoIncidente).toContain('SEM-VINCULO');
    // The LISTING id and the VARIATION id are named separately: `mktplaceId` is
    // `variation_id ?? item.id`, so calling it "anúncio" would be wrong here, and
    // the listing id is the one that opens the anúncio on ML.
    expect(row.motivoDoIncidente).toContain('anúncio MLB90');
    expect(row.motivoDoIncidente).toContain('variação 77');
  });

  it('omits the variação clause for a simple line, and still names the anúncio', async () => {
    const db = new FakeDb();
    seedConta(db);
    const api = makeApi({ getOrder: vi.fn(async () => makeVariationOrder({ id: 94 })) });
    vi.mocked(resolveOrderLineProduto).mockResolvedValue(null);

    await importPedidoMercadoLivre(deps(db, api), 94);

    const motivo = [...db.docs('pedidos/pedido-1/incidentes').values()][0]!
      .motivoDoIncidente as string;
    expect(motivo).toContain('anúncio MLB94');
    expect(motivo).not.toContain('variação');
  });

  it('records NO incidente when every line resolved', async () => {
    const db = new FakeDb();
    seedConta(db);
    const api = makeApi({ getOrder: vi.fn(async () => makeVariationOrder({ id: 91 })) });
    vi.mocked(resolveOrderLineProduto).mockResolvedValue({
      produtoId: 'prod-ok',
      via: 'parent-link',
    });

    await importPedidoMercadoLivre(deps(db, api), 91);

    expect(db.docs('pedidos/pedido-1/incidentes').size).toBe(0);
  });

  it('records NO incidente for a line the STORED pedido already has bound (Flutter dual-run)', async () => {
    const db = new FakeDb();
    seedConta(db);
    const order = makeVariationOrder({ id: 93, variationId: 34 });
    // Flutter imported this same order first and resolved the child itself;
    // `orderPedidoTx` dedups by ensureUniqueId and keeps that stored line.
    db.seed('pedidos', 'pedido-1', {
      estado: 'iniciado',
      itens: {
        'filho-flutter': [
          {
            produtoUid: 'filho-flutter',
            ensureUniqueId: makeItemEnsureUniqueId(93, '34', 0),
            quantidade: 1,
            precoDeVenda: 100,
          },
        ],
      },
    });
    const api = makeApi({ getOrder: vi.fn(async () => order) });
    vi.mocked(resolveOrderLineProduto).mockResolvedValue(null); // our cascade misses

    await importPedidoMercadoLivre(deps(db, api), 93);

    expect(db.docs('pedidos/pedido-1/incidentes').size).toBe(0);
  });

  it('is idempotent on a redelivery — the second import keeps the first row untouched', async () => {
    const db = new FakeDb();
    seedConta(db);
    const order = makeVariationOrder({ id: 92, variationId: 12 });
    const api = makeApi({ getOrder: vi.fn(async () => order) });
    vi.mocked(resolveOrderLineProduto).mockResolvedValue(null);

    await importPedidoMercadoLivre(deps(db, api), 92);
    const id = `ml-prod-${makeItemEnsureUniqueId(92, '12', 0)}`;
    const first = { ...db.docs('pedidos/pedido-1/incidentes').get(id)! };

    // Same payload re-driven by the sweep, one hour later.
    await importPedidoMercadoLivre({ ...deps(db, api), nowUs: NOW_US + 3_600_000_000 }, 92);

    const incidentes = db.docs('pedidos/pedido-1/incidentes');
    expect(incidentes.size).toBe(1); // ALREADY_EXISTS swallowed, no duplicate
    expect(incidentes.get(id)!.timestamp).toBe(first.timestamp); // not re-dated
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
      tipo: TIPO_CLIENTE.pessoaFisica,
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
    vi.mocked(billingInfoToEnderecoFields).mockReturnValue({ kind: 'ok', fields: ENDERECO_SP });
    vi.mocked(ensureEndereco).mockResolvedValue('end-99');

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({
      clientePedidoOuterRef: 'documents/clientes/cli-77',
      enderecoFiscalOuterRef: 'documents/clientes/cli-77/enderecos/end-99',
    });
  });

  it('logs the order and both rejected CEPs instead of dropping the endereço in silence', async () => {
    // Pre-#789 this returned with no log at all, and the pedido was left unable
    // to reach `pago` or be fiscalizado with nothing to diagnose it by.
    const db = new FakeDb();
    seedConta(db);
    db.seed('pedidos', 'pedido-1', { estado: 'iniciado', clientePedidoOuterRef: null, itens: {} });
    const api = makeApi({ getOrder: vi.fn(async () => makeOrder({ id: 1 })) });

    vi.mocked(findOrCreateCliente).mockResolvedValue({ clienteId: 'cli-77', created: true });
    vi.mocked(billingInfoToEnderecoFields).mockReturnValue({ kind: 'sem-cep', cepRaw: '123' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await importPedidoMercadoLivre(deps(db, api), 1);

    expect(ensureEndereco).not.toHaveBeenCalled();
    expect(db.docs('pedidos').get('pedido-1')).not.toHaveProperty('enderecoFiscalOuterRef');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('endereço não construído'),
      expect.objectContaining({ orderId: 1, pedidoId: 'pedido-1', cepBilling: '123' }),
    );
    // The pedido itself still imported — the endereço miss is not a skip.
    expect(result).toEqual({ pedidoId: 'pedido-1', created: true, skipped: null });
    error.mockRestore();
  });

  it('attributes each rejected CEP to its own source when BOTH are unusable', async () => {
    // The diagnostic is the whole point of the log, so it has to survive the
    // two mappers returning value-equal outcomes: attributing by object
    // identity reported `cepShipment: null` here even though the shipment was
    // tried and rejected — and this suite's own shared `SEM_CEP` constant was
    // already enough to trigger it.
    const db = new FakeDb();
    seedConta(db);
    db.seed('pedidos', 'pedido-1', { estado: 'iniciado', clientePedidoOuterRef: null, itens: {} });
    const api = makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, shippingId: 555 })),
      getShipment: vi.fn(async () => ({ id: 555 }) as never),
    });

    vi.mocked(findOrCreateCliente).mockResolvedValue({ clienteId: 'cli-77', created: true });
    vi.mocked(billingInfoToEnderecoFields).mockReturnValue({ kind: 'sem-cep', cepRaw: '123' });
    vi.mocked(shipmentToEnderecoFields).mockReturnValue({ kind: 'sem-cep', cepRaw: '456' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('endereço não construído'),
      expect.objectContaining({ cepBilling: '123', cepShipment: '456' }),
    );
    error.mockRestore();
  });

  it('reports the shipment CEP even when both mappers return the SAME object', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('pedidos', 'pedido-1', { estado: 'iniciado', clientePedidoOuterRef: null, itens: {} });
    const api = makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, shippingId: 555 })),
      getShipment: vi.fn(async () => ({ id: 555 }) as never),
    });

    // One object, both mappers — the exact shape that defeated the identity
    // check. `cepRaw` is non-null so the two implementations disagree: the old
    // one logged `cepShipment: null`, this one logs '999'.
    const compartilhado = {
      kind: 'sem-cep',
      cepRaw: '999',
    } as const satisfies EnderecoBuildOutcome;
    vi.mocked(findOrCreateCliente).mockResolvedValue({ clienteId: 'cli-77', created: true });
    vi.mocked(billingInfoToEnderecoFields).mockReturnValue(compartilhado);
    vi.mocked(shipmentToEnderecoFields).mockReturnValue(compartilhado);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(shipmentToEnderecoFields).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('endereço não construído'),
      expect.objectContaining({ cepBilling: '999', cepShipment: '999' }),
    );
    error.mockRestore();
  });

  it('falls back to the shipment receiver_address only when billing yields no CEP', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('pedidos', 'pedido-1', { estado: 'iniciado', clientePedidoOuterRef: null, itens: {} });
    const api = makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, shippingId: 555 })),
      getShipment: vi.fn(async () => ({ id: 555 }) as never),
    });

    vi.mocked(findOrCreateCliente).mockResolvedValue({ clienteId: 'cli-77', created: true });
    vi.mocked(billingInfoToEnderecoFields).mockReturnValue({ kind: 'sem-cep', cepRaw: null });
    vi.mocked(shipmentToEnderecoFields).mockReturnValue({ kind: 'ok', fields: ENDERECO_SP });
    vi.mocked(ensureEndereco).mockResolvedValue('end-88');

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(shipmentToEnderecoFields).toHaveBeenCalled();
    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({
      enderecoFiscalOuterRef: 'documents/clientes/cli-77/enderecos/end-88',
    });
  });

  it('resolves an unmappable estado from the CEP rather than falling through to the shipment', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('pedidos', 'pedido-1', { estado: 'iniciado', clientePedidoOuterRef: null, itens: {} });
    const api = makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, shippingId: 555 })),
      getShipment: vi.fn(async () => ({ id: 555 }) as never),
    });

    vi.mocked(findOrCreateCliente).mockResolvedValue({ clienteId: 'cli-77', created: true });
    vi.mocked(billingInfoToEnderecoFields).mockReturnValue({
      kind: 'uf-desconhecida',
      fields: { ...ENDERECO_SP, estado: UF_SIGLA.AC },
      estadoRaw: 'Sao Paulo',
    });
    vi.mocked(ensureEndereco).mockResolvedValue('end-77');

    const viaCep = stubViaCep({
      logradouro: 'Avenida Paulista',
      bairro: 'Bela Vista',
      cidade: 'São Paulo',
      estado: 'SP',
      codigoMunicipio: '3550308',
    });

    await importPedidoMercadoLivre(deps(db, api, viaCep), 1);

    expect(viaCep.buscarCep).toHaveBeenCalledWith('01310100');
    // A recoverable estado is NOT a reason to prefer the shipment address.
    expect(shipmentToEnderecoFields).not.toHaveBeenCalled();
    expect(vi.mocked(ensureEndereco).mock.calls[0]?.[2]).toMatchObject({ estado: UF_SIGLA.SP });
  });

  it('stores the endereço with AC and warns when ViaCEP cannot answer', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('pedidos', 'pedido-1', { estado: 'iniciado', clientePedidoOuterRef: null, itens: {} });
    const api = makeApi({ getOrder: vi.fn(async () => makeOrder({ id: 1 })) });

    vi.mocked(findOrCreateCliente).mockResolvedValue({ clienteId: 'cli-77', created: true });
    vi.mocked(billingInfoToEnderecoFields).mockReturnValue({
      kind: 'uf-desconhecida',
      fields: { ...ENDERECO_SP, estado: UF_SIGLA.AC },
      estadoRaw: 'Freedonia',
    });
    vi.mocked(ensureEndereco).mockResolvedValue('end-66');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await importPedidoMercadoLivre(deps(db, api, stubViaCep(null)), 1);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('UF não resolvida'),
      expect.objectContaining({ estadoRecebido: 'Freedonia', cep: '01310100' }),
    );
    // Still linked: a wrong UF cannot reach a signed XML (cMun is null, so
    // emission throws), but no endereço at all strands the pedido forever.
    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({
      enderecoFiscalOuterRef: 'documents/clientes/cli-77/enderecos/end-66',
    });
    warn.mockRestore();
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

describe('mergeFreteInicial', () => {
  function makeMappedFrete(over: Partial<MappedFreteInicialFields> = {}): MappedFreteInicialFields {
    return {
      externalId: '777',
      externalOptionIntegracao: INTEGRACAO_FRETE.mercadoLivre,
      estado: ESTADO_FRETE.postado,
      integracaoFreteOuterRef: null,
      enderecoFreteOuterReference: null,
      modalidade: '1',
      codRastreio: null,
      valorCobrado: 20,
      custoCalculado: 15,
      custoFinal: 25,
      dataPrevisaoEntrega: null,
      ultimaModificacao: NOW_US,
      prazoDespacho: null,
      ...over,
    };
  }

  it('preserves existing codRastreio/prazoDespacho when mapped carries nulls, but replaces them when mapped is non-null', () => {
    const existing = {
      estado: 'postado',
      externalId: '777',
      codRastreio: 'BR000STORED',
      prazoDespacho: Date.parse('2026-01-05T00:00:00.000Z') * 1000,
    } as unknown as FreteDoPedido;

    const mergedWithNulls = mergeFreteInicial(
      existing,
      makeMappedFrete({ codRastreio: null, prazoDespacho: null }),
    );
    expect(mergedWithNulls.codRastreio).toBe('BR000STORED'); // preserved — mapped is null
    expect(mergedWithNulls.prazoDespacho).toBe(existing.prazoDespacho); // preserved — mapped is null

    const newPrazo = Date.parse('2026-02-01T00:00:00.000Z') * 1000;
    const mergedWithValues = mergeFreteInicial(
      existing,
      makeMappedFrete({ codRastreio: 'BR999NEW', prazoDespacho: newPrazo }),
    );
    expect(mergedWithValues.codRastreio).toBe('BR999NEW'); // replaced — mapped is non-null
    expect(mergedWithValues.prazoDespacho).toBe(newPrazo); // replaced — mapped is non-null
  });
});
