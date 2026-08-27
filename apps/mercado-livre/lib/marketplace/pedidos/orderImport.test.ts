import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import type { Firestore } from 'firebase-admin/firestore';
import {
  MercadoLivreHttpError,
  type MercadoLivreApi,
  type MlOrder,
} from '@delfrance/integrations-mercado-livre';

import { OrderItemsIncompleteError, mlOrderToPedidoCoreFields } from './orderMapping';

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
  resolveOrderLineProduto: vi.fn(async () => ({ produtoId: null, via: 'unresolved' })),
}));
vi.mock('./orderCliente', () => {
  class MlBillingInfoUnsupportedError extends Error {}
  return {
    MlBillingInfoUnsupportedError,
    billingInfoToClienteFields: vi.fn(),
    billingInfoToEnderecoFields: vi.fn(() => ({ kind: 'sem-cep', cepRaw: null })),
    shipmentToEnderecoFields: vi.fn(() => ({ kind: 'sem-cep', cepRaw: null })),
    ensureEndereco: vi.fn(),
  };
});
// Promoted out of ./orderCliente by #786 — the resolution is shared with every
// other channel importer now.
vi.mock('@delfrance/data/admin/clientes', () => ({
  findOrCreateCliente: vi.fn(),
}));
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
  shipmentToEnderecoFields,
} from './orderCliente';
import { findOrCreateCliente } from '@delfrance/data/admin/clientes';
import { discoverPedidoMercadoLivre } from './orderPedidoTx';
import { resolvePrazoDespacho } from './orderPrazoDespacho';
import { POLITICA_FRESCOR_TOPICO_SHIPMENTS, freteRecebidoEhMaisNovo } from './orderShipmentMapping';
import { importPedidoMercadoLivre, mergeFreteInicial, type OrderImportDeps } from './orderImport';
import {
  OccEngine,
  deferred,
  type OccOpKind,
  type OccTransaction,
  type OccWriteKind,
} from '@delfrance/data/testing';
import { makeItemEnsureUniqueId } from './orderIds';
import type { MappedFreteInicialFields } from './orderShipmentMapping';
import {
  TIPO_CLIENTE,
  INTEGRACAO_FRETE,
  ESTADO_FRETE,
  STATUS_PAGAMENTO,
  ORIGEM_INCIDENTE,
  TIPO_INCIDENTE,
  UF_SIGLA,
} from '@delfrance/schemas';
import type {
  EnderecoBuildOutcome,
  EnderecoForcado,
  FreteDoPedido,
  ItemDoPedido,
} from '@delfrance/schemas';
import type { EnderecoViaCep, ViaCepClient } from '@delfrance/core/cep';
import { pedidoCollection } from '@delfrance/data/admin/collections';

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
// import.test.ts/orderPedidoTx.test.ts FakeDb shape (doc get/set/update/create
// and a chained where/limit/get query).
//
// `runTransaction` delegates to the SHARED `OccEngine`
// (`@delfrance/data/testing`), which replaces the non-isolated stand-in this
// file used to carry. That brings three things this file never had: a
// reads-before-writes guard (the other three FakeDbs in this folder already had
// one), an `opLog`, and `lastPatch` — plus the snapshot-read/retry semantics the
// concurrency tests below need.

type DocData = Record<string, unknown>;

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
  /** The last patch actually committed at `path/id` — asserts a write's exact shape. */
  lastPatch(path: string, id: string): DocData | undefined {
    return this.patches.get(`${path}/${id}`);
  }
  /**
   * Forget every recorded patch, keeping the documents. Lets a test assert "this
   * SECOND call wrote nothing" without a fresh db — `lastPatch` is last-write-wins,
   * so an earlier call's patch would otherwise still be sitting there and read as
   * a write that never happened. Needed wherever re-running the same import must
   * be proven inert rather than merely convergent: a stored value can be identical
   * after a redundant rewrite (`avancarWatermark(NOW_US, NOW_US)` is a no-op), so
   * comparing state cannot distinguish "did not write" from "wrote the same".
   */
  clearPatches(): void {
    this.patches.clear();
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
      path,
      doc: (id?: string) => {
        const docId = id ?? `auto-${++self.autoN}`;
        const docPath = `${path}/${docId}`;
        return {
          id: docId,
          path: docPath,
          get: async () => {
            self.opLog.push({ op: 'get', path: docPath });
            return { exists: col.has(docId), id: docId, data: () => col.get(docId) };
          },
          set: async (data: DocData, opts?: { merge?: boolean }) => {
            self.opLog.push({ op: 'set', path: docPath });
            self.applyWrite(opts?.merge ? 'update' : 'set', docPath, data);
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
            self.opLog.push({ op: 'update', path: docPath });
            self.applyWrite('update', docPath, patch);
          },
        };
      },
      where: (field: string, op: string, value: unknown) =>
        self.query([...col.entries()]).where(field, op, value),
      get: async () => {
        self.opLog.push({ op: 'get', path: `${path}#all` });
        return {
          docs: [...col.entries()].map(([id, d]) => ({ id, data: () => d, exists: true })),
        };
      },
    };
  }

  async runTransaction<T>(fn: (tx: OccTransaction) => Promise<T>): Promise<T> {
    return this.occ.runTransaction(fn);
  }
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
  /** ML order tags. `['no_shipping']` marks an order sold with no envio. */
  tags?: readonly string[];
  /**
   * ML's feedback "operação concretizada" flag. On a sem-envio order `true` is
   * the seller's delivery confirmation — the ONLY signal there is, since the
   * `delivered` tag is no longer added automatically. Defaults to `null` (the
   * shape ML sends before the seller confirms), never `undefined`, so a test
   * that omits it exercises the real pre-confirmation payload.
   */
  fulfilled?: boolean | null;
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
    tags: opts.tags ?? [],
    fulfilled: opts.fulfilled ?? null,
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
    // Default `[]` = "ML told us nothing", which the conference reports as
    // `indeterminado` and `applyFreteStep` treats as "not checked" — so every
    // test that predates the cross-check (#669) keeps its original behaviour and
    // only the tests that opt in by overriding this actually exercise the guard.
    getShipmentOrders: vi.fn(async () => []),
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
  // `loadContaBag` now shares a module-scope cache keyed by the document PATH,
  // so a fresh `FakeDb` per test does not isolate it and every test here seeds
  // the same `conta-A`.
  __resetAllReadCaches();
  vi.mocked(resolveOrderLineProduto).mockResolvedValue({ produtoId: null, via: 'unresolved' });
  vi.mocked(resolvePrazoDespacho).mockResolvedValue(null);
  // The double CREATES the doc it reports having created. Every step after
  // `discoverPedidoMercadoLivre` patches that pedido, and the Admin SDK rejects
  // an `update` of an absent document — a rule the shared `OccEngine` now
  // enforces, where the older non-isolated fake silently upserted. A test that
  // seeds its own richer pedido keeps it (the guard below).
  vi.mocked(discoverPedidoMercadoLivre).mockImplementation(async (args) => {
    const fake = args.db as unknown as FakeDb;
    if (!fake.docs('pedidos').has('pedido-1')) {
      // `ultimaModificacao: NOW_US` is what the REAL `discoverPedidoMercadoLivre`
      // stamps. Seeding it matters: without it the later steps compare against
      // `undefined` and every monotonic-watermark path takes its easy branch,
      // which is exactly how a bug that only fires when stored == nowUs slipped
      // past this suite.
      fake.seed('pedidos', 'pedido-1', {
        estado: 'iniciado',
        itens: {},
        itensIds: [],
        ultimaModificacao: NOW_US,
      });
    }
    return { pedidoId: 'pedido-1', created: true };
  });
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
  vi.mocked(findOrCreateCliente).mockResolvedValue({
    clienteId: 'cli-default',
    created: true,
    matchedBy: null,
    rejected: [],
    dropped: [],
  });
  // `mockClear` (above) doesn't reset a mock's implementation — restore the
  // module factory's "no endereço" default explicitly so a test overriding it
  // doesn't leak into whichever test runs next.
  vi.mocked(billingInfoToEnderecoFields).mockReturnValue(SEM_CEP);
  vi.mocked(shipmentToEnderecoFields).mockReturnValue(SEM_CEP);
});

afterEach(() => {
  __resetAllReadCaches();
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

    expect(result).toEqual({
      pedidoId: null,
      created: false,
      semEnvio: false,
      skipped: 'no-buyer',
    });
    expect(discoverPedidoMercadoLivre).not.toHaveBeenCalled();
  });

  it('drops an order whose seller does not match the account', async () => {
    const db = new FakeDb();
    seedConta(db);
    const order = makeOrder({ id: 1 });
    order.seller = { id: 999 };
    const api = makeApi({ getOrder: vi.fn(async () => order) });

    const result = await importPedidoMercadoLivre(deps(db, api), 1);

    expect(result).toEqual({
      pedidoId: null,
      created: false,
      semEnvio: false,
      skipped: 'seller-mismatch',
    });
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

    expect(result).toEqual({ pedidoId: 'pedido-1', created: true, semEnvio: false, skipped: null });
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
    vi.mocked(resolveOrderLineProduto).mockResolvedValue({ produtoId: null, via: 'unresolved' });

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
    vi.mocked(resolveOrderLineProduto).mockResolvedValue({ produtoId: null, via: 'unresolved' });

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

  it('records NO incidente for a line the STORED pedido already has bound (legacy corpus)', async () => {
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
    vi.mocked(resolveOrderLineProduto).mockResolvedValue({ produtoId: null, via: 'unresolved' }); // our cascade misses

    await importPedidoMercadoLivre(deps(db, api), 93);

    expect(db.docs('pedidos/pedido-1/incidentes').size).toBe(0);
  });

  it('is idempotent on a redelivery — the second import keeps the first row untouched', async () => {
    const db = new FakeDb();
    seedConta(db);
    const order = makeVariationOrder({ id: 92, variationId: 12 });
    const api = makeApi({ getOrder: vi.fn(async () => order) });
    vi.mocked(resolveOrderLineProduto).mockResolvedValue({ produtoId: null, via: 'unresolved' });

    await importPedidoMercadoLivre(deps(db, api), 92);
    const id = `ml-prod-${makeItemEnsureUniqueId(92, '12', 0)}`;
    const first = { ...db.docs('pedidos/pedido-1/incidentes').get(id)! };

    // Same payload re-driven by the sweep, one hour later.
    await importPedidoMercadoLivre({ ...deps(db, api), nowUs: NOW_US + 3_600_000_000 }, 92);

    const incidentes = db.docs('pedidos/pedido-1/incidentes');
    expect(incidentes.size).toBe(1); // ALREADY_EXISTS swallowed, no duplicate
    expect(incidentes.get(id)!.timestamp).toBe(first.timestamp); // not re-dated
  });

  /**
   * An AMBIGUOUS sku needs a different operator action from an absent one, so it
   * gets its own `subtipo` and wording. `tipo` stays `outros` — the wire enum is
   * shared with the Flutter app and must never be extended; a passthrough
   * `subtipo` is the established extension point (four exist today).
   */
  it('records an AMBIGUOUS-sku incidente, distinct from the not-found one', async () => {
    const db = new FakeDb();
    seedConta(db);
    const order = makeVariationOrder({ id: 95, variationId: 77, sku: 'DUP-SKU' });
    const api = makeApi({ getOrder: vi.fn(async () => order) });
    vi.mocked(resolveOrderLineProduto).mockResolvedValue({
      produtoId: null,
      via: 'ambiguous-sku',
    });

    await importPedidoMercadoLivre(deps(db, api), 95);

    const args = vi.mocked(discoverPedidoMercadoLivre).mock.calls[0]![0];
    expect(args.itensByOrderId.get(95)![0]!.produtoUid).toBeNull();

    const incidentes = db.docs('pedidos/pedido-1/incidentes');
    expect(incidentes.size).toBe(1);
    const row = incidentes.get(`ml-prod-${makeItemEnsureUniqueId(95, '77', 0)}`)!;
    expect(row.subtipo).toBe('ml-produto-sku-ambiguo');
    expect(row.tipo).toBe(TIPO_INCIDENTE.outros);
    expect(row.motivoDoIncidente).toContain('DUP-SKU');
    expect(row.motivoDoIncidente).toContain('anúncio MLB95');
    expect(row.motivoDoIncidente).toContain('variação 77');
    // Both remedies: de-duplicating the cadastro alone does NOT re-bind this
    // pedido, because the item merge is append-only.
    expect(row.motivoDoIncidente).toContain('mais de um produto');
    expect(row.motivoDoIncidente).toContain('corrija os SKUs duplicados');
  });

  it('leaves the not-found wording alone — the two branches must not converge', async () => {
    const db = new FakeDb();
    seedConta(db);
    const order = makeVariationOrder({ id: 96, variationId: 78, sku: 'SEM-VINCULO' });
    const api = makeApi({ getOrder: vi.fn(async () => order) });
    vi.mocked(resolveOrderLineProduto).mockResolvedValue({ produtoId: null, via: 'unresolved' });

    await importPedidoMercadoLivre(deps(db, api), 96);

    const row = db
      .docs('pedidos/pedido-1/incidentes')
      .get(`ml-prod-${makeItemEnsureUniqueId(96, '78', 0)}`)!;
    expect(row.subtipo).toBe('ml-produto-nao-vinculado');
    expect(row.motivoDoIncidente).toContain('não foi vinculado a nenhum produto do ERP');
    expect(row.motivoDoIncidente).not.toContain('mais de um produto');
  });

  it('carries the ambiguity reason across a pack — the memo caches the whole verdict', async () => {
    const db = new FakeDb();
    seedConta(db);
    const initial = makeVariationOrder({ id: 83, packId: 801, itemId: 'MLB9', variationId: 5 });
    const sibling = makeVariationOrder({ id: 84, packId: 801, itemId: 'MLB9', variationId: 5 });
    const api = makeApi({
      getOrder: vi.fn(async (id: number) => (id === 83 ? initial : sibling)),
      getPack: vi.fn(async () => ({ id: 801, status: 'ready', orders: [{ id: 83 }, { id: 84 }] })),
    });
    vi.mocked(resolveOrderLineProduto).mockResolvedValue({
      produtoId: null,
      via: 'ambiguous-sku',
    });

    await importPedidoMercadoLivre(deps(db, api), 83);

    // One resolve, two lines — and the SECOND line must not fall back to the
    // generic wording just because it was served from the memo.
    expect(resolveOrderLineProduto).toHaveBeenCalledTimes(1);
    const incidentes = db.docs('pedidos/pedido-1/incidentes');
    expect(incidentes.size).toBe(2);
    for (const orderId of [83, 84]) {
      const row = incidentes.get(`ml-prod-${makeItemEnsureUniqueId(orderId, '5', 0)}`)!;
      expect(row.subtipo).toBe('ml-produto-sku-ambiguo');
    }
  });

  it('keeps the FIRST verdict when a redelivery resolves differently (create-only, by design)', async () => {
    const db = new FakeDb();
    seedConta(db);
    const order = makeVariationOrder({ id: 98, variationId: 13, sku: 'DUP-SKU' });
    const api = makeApi({ getOrder: vi.fn(async () => order) });
    vi.mocked(resolveOrderLineProduto).mockResolvedValue({
      produtoId: null,
      via: 'ambiguous-sku',
    });
    await importPedidoMercadoLivre(deps(db, api), 98);

    // The duplicate SKU is fixed in the cadastro, then the sweep re-drives the
    // same order — now the SKU matches nothing at all.
    vi.mocked(resolveOrderLineProduto).mockResolvedValue({ produtoId: null, via: 'unresolved' });
    await importPedidoMercadoLivre({ ...deps(db, api), nowUs: NOW_US + 3_600_000_000 }, 98);

    // `.create()` + swallow ALREADY_EXISTS means the row is frozen at the first
    // verdict — the accepted cost of never re-dating an incidente on a replay.
    // If this ever has to change, it is a decision about the write mode.
    const incidentes = db.docs('pedidos/pedido-1/incidentes');
    expect(incidentes.size).toBe(1);
    expect(incidentes.get(`ml-prod-${makeItemEnsureUniqueId(98, '13', 0)}`)!.subtipo).toBe(
      'ml-produto-sku-ambiguo',
    );
  });

  it('records NO incidente when a SKU rung DID bind — the verdict is not the trigger', async () => {
    const db = new FakeDb();
    seedConta(db);
    const order = makeVariationOrder({ id: 97, variationId: 79, sku: 'OK' });
    const api = makeApi({ getOrder: vi.fn(async () => order) });
    vi.mocked(resolveOrderLineProduto).mockResolvedValue({ produtoId: 'prod-ok', via: 'sku-any' });

    await importPedidoMercadoLivre(deps(db, api), 97);

    expect(db.docs('pedidos/pedido-1/incidentes').size).toBe(0);
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
    vi.mocked(findOrCreateCliente).mockResolvedValue({
      clienteId: 'cli-1',
      created: true,
      matchedBy: null,
      rejected: [],
      dropped: [],
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({
      clientePedidoOuterRef: 'documents/clientes/cli-1',
    });
  });

  it('never writes a NULL ultimaModificacao, even when the stored stamp already equals nowUs', async () => {
    // Regression (review of #791). `avancarWatermark` used to return `null` to
    // mean "omit this key", but `parseMergePatch` deliberately KEEPS `null`
    // (`zodParse.ts` — "null is kept, it stores fine"), so inlining the result
    // ERASED the stamp. It bit exactly here: `discoverPedidoMercadoLivre` stamps
    // `nowUs`, and this step then compares that same `nowUs` against itself.
    //
    // The order carries NO shipping and cannot advance, so the cliente step is
    // the LAST writer — nothing downstream re-stamps the field and papers over
    // the null. That is what makes this a durable pin rather than a lucky one.
    const db = new FakeDb();
    seedConta(db);
    db.seed('pedidos', 'pedido-1', {
      estado: 'iniciado',
      clientePedidoOuterRef: null,
      itens: {},
      ultimaModificacao: NOW_US, // what discoverPedidoMercadoLivre just wrote
    });
    const order = makeOrder({ id: 1 });
    delete (order as { shipping?: unknown }).shipping;
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
    vi.mocked(findOrCreateCliente).mockResolvedValue({
      clienteId: 'cli-1',
      created: true,
      matchedBy: null,
      rejected: [],
      dropped: [],
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    const pedido = db.docs('pedidos').get('pedido-1')!;
    expect(pedido.clientePedidoOuterRef).toBe('documents/clientes/cli-1');
    // The stamp survives — and stays a real timestamp, never null.
    expect(pedido.ultimaModificacao).toBe(NOW_US);
    expect(db.lastPatch('pedidos', 'pedido-1')!.ultimaModificacao).not.toBeNull();
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

    expect(result).toEqual({ pedidoId: 'pedido-1', created: true, semEnvio: false, skipped: null });
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

    vi.mocked(findOrCreateCliente).mockResolvedValue({
      clienteId: 'cli-77',
      created: true,
      matchedBy: null,
      rejected: [],
      dropped: [],
    });
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

    vi.mocked(findOrCreateCliente).mockResolvedValue({
      clienteId: 'cli-77',
      created: true,
      matchedBy: null,
      rejected: [],
      dropped: [],
    });
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
    expect(result).toEqual({ pedidoId: 'pedido-1', created: true, semEnvio: false, skipped: null });
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

    vi.mocked(findOrCreateCliente).mockResolvedValue({
      clienteId: 'cli-77',
      created: true,
      matchedBy: null,
      rejected: [],
      dropped: [],
    });
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
    vi.mocked(findOrCreateCliente).mockResolvedValue({
      clienteId: 'cli-77',
      created: true,
      matchedBy: null,
      rejected: [],
      dropped: [],
    });
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

    vi.mocked(findOrCreateCliente).mockResolvedValue({
      clienteId: 'cli-77',
      created: true,
      matchedBy: null,
      rejected: [],
      dropped: [],
    });
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

    vi.mocked(findOrCreateCliente).mockResolvedValue({
      clienteId: 'cli-77',
      created: true,
      matchedBy: null,
      rejected: [],
      dropped: [],
    });
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

    vi.mocked(findOrCreateCliente).mockResolvedValue({
      clienteId: 'cli-77',
      created: true,
      matchedBy: null,
      rejected: [],
      dropped: [],
    });
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
  it('runs the full-conference branch on a shipping id, mapping freteInicial and valorCobrado', async () => {
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
            mktplaceId: 'MLB1',
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
      // A MATCHING conference (#669). Without it the default `[]` stub makes the
      // check indeterminate and this test would silently assert the skip path
      // instead of the full conference it is named for.
      getShipmentOrders: vi.fn(async () => [
        {
          order_id: '1',
          item_id: 'MLB1',
          variation_id: null,
          seller_id: 555,
          requested_quantity: 1,
        },
      ]),
    });
    const prazoDespachoUs = Date.parse('2026-01-08T00:00:00.000Z') * 1000;
    vi.mocked(resolvePrazoDespacho).mockResolvedValue(prazoDespachoUs);

    await importPedidoMercadoLivre(deps(db, api), 1);

    const written = db.docs('pedidos').get('pedido-1');
    expect(written).toMatchObject({
      valorCobrado: 120, // roundReais(totalItens 100 + valorFreteInicial 20)
      // Wall clock, monotonic (#791): this stamp is the display / recency-sort /
      // update-monitor field, so it is NOT the ML order clock. That clock lives
      // in `lastMarketplaceUpdate`, written by `discoverPedidoMercadoLivre`.
      ultimaModificacao: NOW_US,
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

    // The frete step early-outs before its three ML round-trips. `resolvePrazoDespacho`
    // is the one only IT calls, so it is the honest probe for "the frete step
    // did no work" — `getShipmentPayments` is no longer, because the pago step
    // now fetches it on every import that has a shipment (#791: registering
    // shipping payments is what keeps the paid-sum, and therefore the downgrade,
    // from under-counting).
    expect(resolvePrazoDespacho).not.toHaveBeenCalled();
    expect(db.docs('pedidos').get('pedido-1')!.freteInicial).toEqual(freteInicial);
    // Nothing was written to the pedido at all.
    expect(db.lastPatch('pedidos', 'pedido-1')).toBeUndefined();
  });
});

/**
 * #1087 — the PROMOTION arm, the mirror of the downgrade below.
 *
 * `estado` is written only on pedido CREATE (`orderPedidoTx.ts`), and
 * `podeAvancarParaPago` requires `emProcessamento`. That was harmless while
 * `orders_v2` fired only for seller-visible (paid) orders. The payments-topic
 * bootstrap changes it: a pedido born from a `payment_in_process` order sits at
 * `aguardandoConfirmacaoDePagamento`, which HOLDS a stock reservation — and with
 * no arm here it could never move, holding that reservation forever and never
 * reaching `pago`.
 */
describe('importPedidoMercadoLivre — estado promotion along the pre-payment ladder (#1087)', () => {
  function seedPedidoPrePagamento(db: FakeDb, estado: string, over: DocData = {}): void {
    db.seed('pedidos', 'pedido-1', {
      estado,
      clientePedidoOuterRef: 'documents/clientes/cli-1',
      enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
      freteInicial: { estado: 'iniciado' },
      valorCobrado: 100,
      itens: {},
      ...over,
    });
  }

  it('promotes aguardandoConfirmacaoDePagamento → emProcessamento once the order is paid', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPrePagamento(db, 'aguardandoConfirmacaoDePagamento');
    const api = makeApi({ getOrder: vi.fn(async () => makeOrder({ id: 1, status: 'paid' })) });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({ estado: 'emProcessamento' });
  });

  it('promotes escolhendoFormaDePagamento → aguardandoConfirmacaoDePagamento', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPrePagamento(db, 'escolhendoFormaDePagamento');
    const api = makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, status: 'payment_in_process' })),
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({
      estado: 'aguardandoConfirmacaoDePagamento',
    });
  });

  it('promotes AND advances to pago in one delivery when the payments already cover it', async () => {
    // A promotion to `emProcessamento` may also satisfy the pago advance, but
    // `freshPedido` still carries the OLD estado, so a naive fall-through would
    // need a second delivery to converge.
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPrePagamento(db, 'aguardandoConfirmacaoDePagamento');
    db.seed('pedidos/pedido-1/pagamentos', 'pag-1', { id: '900', valor: 100, status_pagamento: 4 });
    const api = makeApi({ getOrder: vi.fn(async () => makeOrder({ id: 1, status: 'paid' })) });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({ estado: 'pago' });
  });

  it('NEVER walks the ladder backwards FROM a rung that IS promotable', async () => {
    // ⚠️ The `emProcessamento` case below proves the FROM-set exclusion, which is
    // a DIFFERENT property — it short-circuits before the direction check ever
    // runs. Only a pedido sitting ON the ladder exercises the direction guard.
    // Reachable for real: ML can re-open an order after a failed payment, and an
    // out-of-order redelivery carrying the SAME `last_updated` slips past the
    // watermark (which is `>=`), leaving direction as the only guard.
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPrePagamento(db, 'aguardandoConfirmacaoDePagamento');
    const api = makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, status: 'payment_required' })),
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({
      estado: 'aguardandoConfirmacaoDePagamento',
    });
  });

  it('NEVER walks the ladder backwards — a payment_in_process payload on an emProcessamento pedido', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPrePagamento(db, 'emProcessamento');
    const api = makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, status: 'payment_in_process' })),
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({ estado: 'emProcessamento' });
  });

  it('refuses to promote on a payload OLDER than the ML order clock already applied', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPrePagamento(db, 'aguardandoConfirmacaoDePagamento', {
      lastMarketplaceUpdate: Date.parse('2026-02-01T00:00:00.000Z') * 1000,
    });
    const api = makeApi({
      getOrder: vi.fn(async () =>
        makeOrder({ id: 1, status: 'paid', lastUpdated: '2026-01-01T00:00:00.000Z' }),
      ),
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({
      estado: 'aguardandoConfirmacaoDePagamento',
    });
  });

  it('leaves an estado the business owns alone — pago is not on the ladder', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPrePagamento(db, 'pago');
    db.seed('pedidos/pedido-1/pagamentos', 'pag-1', { id: '900', valor: 100, status_pagamento: 4 });
    const api = makeApi({ getOrder: vi.fn(async () => makeOrder({ id: 1, status: 'paid' })) });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({ estado: 'pago' });
  });

  it.each([
    ['cancelled', 'cancelado'],
    ['invalid', 'fraude'],
    ['pending_cancel', 'estornadoIntegralmente'],
  ])('RELEASES the reservation when the order dies (%s -> %s)', async (status, esperado) => {
    // The mirror of the promotion: without this the pedido would sit at
    // `aguardandoConfirmacaoDePagamento` — which is in ESTADOS_PEDIDO_RESERVA —
    // forever, with no writer anywhere able to move it. #1087 pointed the other way.
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPrePagamento(db, 'aguardandoConfirmacaoDePagamento');
    const api = makeApi({ getOrder: vi.fn(async () => makeOrder({ id: 1, status })) });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({ estado: esperado });
  });

  it('does NOT release on a status ML has not documented — `iniciado` is not terminal', async () => {
    // ⚠️ The trap that makes the terminal set explicit rather than derived.
    // `estadoPedidoFromOrderStatus` returns `iniciado` for ANY unrecognised
    // status, and `iniciado` is off the ladder too — so a "not on the ladder ⇒
    // terminal" shortcut would drop a live pedido's reservation the first time ML
    // invented a status string.
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPrePagamento(db, 'aguardandoConfirmacaoDePagamento');
    const api = makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, status: 'quantum_superposition' })),
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({
      estado: 'aguardandoConfirmacaoDePagamento',
    });
  });

  it('does NOT release a LIVE pedido on a late-delivered cancelled payload', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPrePagamento(db, 'aguardandoConfirmacaoDePagamento', {
      lastMarketplaceUpdate: Date.parse('2026-02-01T00:00:00.000Z') * 1000,
    });
    const api = makeApi({
      getOrder: vi.fn(async () =>
        makeOrder({ id: 1, status: 'cancelled', lastUpdated: '2026-01-01T00:00:00.000Z' }),
      ),
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({
      estado: 'aguardandoConfirmacaoDePagamento',
    });
  });

  it('never releases an estado the business owns — a pago pedido is not on the FROM-set', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPrePagamento(db, 'pago');
    db.seed('pedidos/pedido-1/pagamentos', 'pag-1', { id: '900', valor: 100, status_pagamento: 4 });
    const api = makeApi({ getOrder: vi.fn(async () => makeOrder({ id: 1, status: 'cancelled' })) });

    await importPedidoMercadoLivre(deps(db, api), 1);

    // The pago DOWNGRADE owns this case and refuses it (payments still cover it).
    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({ estado: 'pago' });
  });

  it('writes nothing at all when there is nothing to promote', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPrePagamento(db, 'aguardandoConfirmacaoDePagamento');
    const api = makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, status: 'payment_in_process' })),
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')).toMatchObject({
      estado: 'aguardandoConfirmacaoDePagamento',
    });
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

/* -------------- shipment ↔ pedido item cross-check (#669) ------------------ */
// The guard `applyFreteStep`'s full conference runs before it prices a pedido.
// The pure matching rules live in `orderShipmentConference.test.ts`; these cases
// pin the CONSEQUENCES — what is written, what is withheld, what throws.

describe('importPedidoMercadoLivre — conferência de itens do envio (#669)', () => {
  const SHIPMENT_ID = 777;
  const INCIDENTE_PATH = 'pedidos/pedido-1/incidentes';
  const INCIDENTE_ID = `ml-envio-div-${SHIPMENT_ID}`;

  function seedPedidoConferivel(db: FakeDb, over: DocData = {}): void {
    db.seed('pedidos', 'pedido-1', {
      estado: 'iniciado',
      clientePedidoOuterRef: 'documents/clientes/cli-1',
      enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
      freteInicial: null,
      ultimaModificacao: NOW_US,
      itens: {
        'produto-1': [
          {
            produtoUid: 'produto-1',
            ordem: 1,
            ensureUniqueId: 'uid-1',
            mktplaceId: 'MLB1',
            precoDeVenda: 100,
            quantidade: 1,
            descontoUnitario: 0,
          },
        ],
      },
      ...over,
    });
  }

  function apiConferencia(linhas: DocData[] | (() => Promise<DocData[]>)): MercadoLivreApi {
    return makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, shippingId: SHIPMENT_ID })),
      getShipment: vi.fn(async () => ({
        id: SHIPMENT_ID,
        order_id: 1,
        status: 'ready_to_ship',
        substatus: null,
        last_updated: '2026-01-02T00:00:00.000-03:00',
        shipping_option: {},
      })),
      getShipmentPayments: vi.fn(async () => [{ payment_id: 900, status: 'approved', amount: 20 }]),
      getShipmentOrders: vi.fn(typeof linhas === 'function' ? linhas : async () => linhas),
    });
  }

  const linhaML = (over: DocData = {}): DocData => ({
    order_id: '1',
    pack_id: null,
    item_id: 'MLB1',
    variation_id: null,
    seller_id: SELLER_USER_ID,
    requested_quantity: 1,
    ...over,
  });

  it('prices the pedido normally when the shipment matches', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedPedidoConferivel(db);

    await importPedidoMercadoLivre(deps(db, apiConferencia([linhaML()])), 1);

    const written = db.docs('pedidos').get('pedido-1')!;
    expect(written.valorCobrado).toBe(120); // itens 100 + frete 20
    expect(written.estado).toBe('iniciado');
    // Scoped to OUR id: the subcollection also holds `recordItensSemProduto`'s
    // own `ml-prod-*` row for a line that resolved to no produto (#792).
    expect(db.docs(INCIDENTE_PATH).has(INCIDENTE_ID)).toBe(false);
  });

  it('BLOCKS on a surplus: estado error, no frete, no valorCobrado, an incidente, and it throws', async () => {
    const db = new FakeDb();
    seedConta(db);
    // ML sold 1 unit; the pedido carries 2. Shipping this would send goods the
    // buyer never bought — the case #669 exists for.
    seedPedidoConferivel(db, {
      itens: {
        'produto-1': [
          {
            produtoUid: 'produto-1',
            ordem: 1,
            ensureUniqueId: 'uid-1',
            mktplaceId: 'MLB1',
            precoDeVenda: 100,
            quantidade: 2,
            descontoUnitario: 0,
          },
        ],
      },
    });

    await expect(
      importPedidoMercadoLivre(deps(db, apiConferencia([linhaML()])), 1),
    ).rejects.toMatchObject({ name: 'MlEnvioItensDivergentesError' });

    const written = db.docs('pedidos').get('pedido-1')!;
    // The estado write COMMITS even though the call throws — the throw is
    // deliberately outside the transaction, or it would roll this back and the
    // pedido would strand at `emProcessamento` with nothing to show for it.
    expect(written.estado).toBe('error');
    // Nothing else is written: pricing a pedido we know is wrong is the failure
    // mode this guard exists to prevent.
    expect(written.freteInicial).toBeNull();
    expect(written.valorCobrado).toBeUndefined();
    const patch = db.lastPatch('pedidos', 'pedido-1')!;
    expect(patch).not.toHaveProperty('valorCobrado');
    expect(patch).not.toHaveProperty('freteInicial');

    const incidente = db.docs(INCIDENTE_PATH).get(INCIDENTE_ID)!;
    expect(incidente).toMatchObject({
      subtipo: 'ml-envio-itens-divergentes',
      externalId: String(SHIPMENT_ID),
      resolucao: null,
    });
    expect(incidente.motivoDoIncidente).toContain('MLB1');
  });

  it('BLOCKS on a line ML is not selling at all', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedPedidoConferivel(db, {
      itens: {
        'produto-1': [
          {
            produtoUid: 'produto-1',
            ordem: 1,
            ensureUniqueId: 'uid-1',
            mktplaceId: 'MLB-FANTASMA',
            precoDeVenda: 100,
            quantidade: 1,
            descontoUnitario: 0,
          },
        ],
      },
    });

    await expect(
      importPedidoMercadoLivre(deps(db, apiConferencia([linhaML()])), 1),
    ).rejects.toMatchObject({ name: 'MlEnvioItensDivergentesError' });
    expect(db.docs('pedidos').get('pedido-1')!.estado).toBe('error');
  });

  it('does NOT block when the pedido is merely INCOMPLETE — the pack-assembly race', async () => {
    // `pack_id` can be absent from a partial order payload (#793), so between
    // the first order's import and its siblings' the pedido legitimately holds a
    // subset of the sale. Blocking here would error a healthy pedido on a
    // routine race; pinned so nobody "symmetrises" the check later.
    const db = new FakeDb();
    seedConta(db);
    seedPedidoConferivel(db);

    await importPedidoMercadoLivre(
      deps(db, apiConferencia([linhaML(), linhaML({ item_id: 'MLB-IRMAO', order_id: '2' })])),
      1,
    );

    const written = db.docs('pedidos').get('pedido-1')!;
    expect(written.estado).toBe('iniciado');
    expect(written.valorCobrado).toBe(120);
    expect(written.freteInicial).not.toBeNull();
    // Scoped to OUR id: the subcollection also holds `recordItensSemProduto`'s
    // own `ml-prod-*` row for a line that resolved to no produto (#792).
    expect(db.docs(INCIDENTE_PATH).has(INCIDENTE_ID)).toBe(false);
  });

  it('skips the check entirely when hasUserInteraction is true — no ML call at all', async () => {
    // The operator's override, restored by the `apps/web` stamp. Reading it from
    // the PRE-transaction copy to skip the CALL is sound only because the flag is
    // monotonic (null → true, never back) — see the gate's docblock, and the
    // race test below for the direction that argument does NOT cover.
    const db = new FakeDb();
    seedConta(db);
    seedPedidoConferivel(db, {
      hasUserInteraction: true,
      itens: {
        'produto-1': [
          {
            produtoUid: 'produto-1',
            ordem: 1,
            ensureUniqueId: 'uid-1',
            mktplaceId: 'MLB-QUE-NAO-EXISTE-NO-ML',
            precoDeVenda: 100,
            quantidade: 7,
            descontoUnitario: 0,
          },
        ],
      },
    });
    const api = apiConferencia([linhaML()]);

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(api.getShipmentOrders).not.toHaveBeenCalled();
    const written = db.docs('pedidos').get('pedido-1')!;
    expect(written.estado).toBe('iniciado');
    expect(written.valorCobrado).toBe(720); // 7 × 100 + frete 20 — the pre-#669 behaviour
  });

  it('honours an override set DURING the ML round-trips, not the stale pre-read', async () => {
    // The race the pre-tx gate cannot see. An operator repairs the pedido —
    // stamping `hasUserInteraction` — while this step is still fetching from ML,
    // so the pre-read says `false` and the fetch happens, but the tx-fresh
    // document says `true`. Honouring the stale value would flip the very pedido
    // they just fixed to `error`. The verdict is re-derived inside the
    // transaction (root CLAUDE.md rule 7).
    const db = new FakeDb();
    seedConta(db);
    seedPedidoConferivel(db, {
      itens: {
        'produto-1': [
          {
            produtoUid: 'produto-1',
            ordem: 1,
            ensureUniqueId: 'uid-1',
            mktplaceId: 'MLB-ADICIONADO-PELO-OPERADOR',
            precoDeVenda: 100,
            quantidade: 3,
            descontoUnitario: 0,
          },
        ],
      },
    });
    // `getShipmentOrders` is awaited in exactly the window between the pre-read
    // and `runTransaction`, so it is the precise injection point for the save.
    const api = apiConferencia(async () => {
      db.seed('pedidos', 'pedido-1', {
        ...db.docs('pedidos').get('pedido-1')!,
        hasUserInteraction: true,
      });
      return [linhaML()]; // divergent — would block if the override were missed
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(api.getShipmentOrders).toHaveBeenCalled(); // the stale read did fetch
    const written = db.docs('pedidos').get('pedido-1')!;
    expect(written.estado).toBe('iniciado'); // …but the fresh read waived the check
    expect(written.valorCobrado).toBe(320); // 3 × 100 + frete 20
    expect(db.docs(INCIDENTE_PATH).has(INCIDENTE_ID)).toBe(false);
  });

  it('does NOT auto-release an error pedido once the override is set', async () => {
    // A waived conference yields `indeterminado`, never `ok`, so the recovery
    // branch cannot fire. Deliberate: with the check skipped there is no
    // evidence the divergence is gone, so releasing the block stays the
    // operator's call — which is what the incidente text tells them to do.
    const db = new FakeDb();
    seedConta(db);
    seedPedidoConferivel(db, { estado: 'error', hasUserInteraction: true });
    db.seed(INCIDENTE_PATH, INCIDENTE_ID, {
      subtipo: 'ml-envio-itens-divergentes',
      resolucao: null,
      timestamp: NOW_US - 1000,
    });

    await importPedidoMercadoLivre(deps(db, apiConferencia([linhaML()])), 1);

    expect(db.docs('pedidos').get('pedido-1')!.estado).toBe('error');
    expect(db.docs(INCIDENTE_PATH).get(INCIDENTE_ID)!.resolucao).toBeNull();
  });

  it('falls through to the pre-#669 behaviour on an empty (204) response', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedPedidoConferivel(db, {
      itens: {
        'produto-1': [
          {
            produtoUid: 'produto-1',
            ordem: 1,
            ensureUniqueId: 'uid-1',
            mktplaceId: 'MLB1',
            precoDeVenda: 100,
            quantidade: 5,
            descontoUnitario: 0,
          },
        ],
      },
    });

    await importPedidoMercadoLivre(deps(db, apiConferencia([])), 1);

    const written = db.docs('pedidos').get('pedido-1')!;
    expect(written.estado).toBe('iniciado');
    expect(written.valorCobrado).toBe(520);
  });

  it('PROPAGATES a 5xx from getShipmentOrders and writes nothing', async () => {
    // Transient: the queue retries. Degrading here would silently price the
    // pedido unchecked, which is exactly what the guard exists to prevent.
    const db = new FakeDb();
    seedConta(db);
    seedPedidoConferivel(db);
    const api = apiConferencia(async () => {
      throw new MercadoLivreHttpError('ML 500: boom', 500, null);
    });

    await expect(importPedidoMercadoLivre(deps(db, api), 1)).rejects.toBeInstanceOf(
      MercadoLivreHttpError,
    );
    const written = db.docs('pedidos').get('pedido-1')!;
    expect(written.freteInicial).toBeNull();
    expect(written.valorCobrado).toBeUndefined();
  });

  it('degrades a 404 from getShipmentOrders to "not checked"', async () => {
    // A 404 is an answer about the shipment, not a failure of ours — the same
    // narrow degrade `orderShipmentImport.ts` already applies to `getShipment`.
    const db = new FakeDb();
    seedConta(db);
    seedPedidoConferivel(db);
    const api = apiConferencia(async () => {
      throw new MercadoLivreHttpError('ML 404: not found', 404, null);
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    const written = db.docs('pedidos').get('pedido-1')!;
    expect(written.estado).toBe('iniciado');
    expect(written.valorCobrado).toBe(120);
  });

  it('RECOVERS: a re-validated pedido leaves error and its incidente is resolved', async () => {
    const db = new FakeDb();
    seedConta(db);
    // The state a previous blocking run left behind: estado error + an OPEN
    // incidente at our deterministic id. The items now agree with ML again.
    seedPedidoConferivel(db, { estado: 'error' });
    db.seed(INCIDENTE_PATH, INCIDENTE_ID, {
      subtipo: 'ml-envio-itens-divergentes',
      externalId: String(SHIPMENT_ID),
      resolucao: null,
      timestamp: NOW_US - 1000,
    });

    await importPedidoMercadoLivre(deps(db, apiConferencia([linhaML()])), 1);

    const written = db.docs('pedidos').get('pedido-1')!;
    // Re-derived from the LIVE ML status (`paid` → emProcessamento), not restored
    // from a snapshot — by the time a divergence clears the order has usually
    // moved on, so the current status is the more correct answer.
    expect(written.estado).toBe('emProcessamento');
    expect(written.valorCobrado).toBe(120);
    expect(db.docs(INCIDENTE_PATH).get(INCIDENTE_ID)!.resolucao).toMatchObject({ tipo: 7 });
  });

  it('does NOT clear an error it did not set (no open incidente)', async () => {
    // The open incidente is the ownership proof. Without one, the `error` came
    // from an operator or another flow and is not ours to undo.
    const db = new FakeDb();
    seedConta(db);
    seedPedidoConferivel(db, { estado: 'error' });

    await importPedidoMercadoLivre(deps(db, apiConferencia([linhaML()])), 1);

    expect(db.docs('pedidos').get('pedido-1')!.estado).toBe('error');
  });

  it('does NOT clear an error whose incidente was already resolved', async () => {
    // Keeps the restore firing at most once.
    const db = new FakeDb();
    seedConta(db);
    seedPedidoConferivel(db, { estado: 'error' });
    db.seed(INCIDENTE_PATH, INCIDENTE_ID, {
      subtipo: 'ml-envio-itens-divergentes',
      resolucao: { tipo: 7, valor: 0, data: NOW_US - 500, comentarios: null, frete: null },
    });

    await importPedidoMercadoLivre(deps(db, apiConferencia([linhaML()])), 1);

    expect(db.docs('pedidos').get('pedido-1')!.estado).toBe('error');
  });

  it('re-derives the verdict on an OCC retry instead of carrying it over', async () => {
    // The direct regression test for legacy's `bool error` (tasks.dart:511),
    // declared OUTSIDE the transaction closure and written inside it: on an ODM
    // retry a divergence found by the first attempt poisoned every later one.
    // Here the first attempt sees a divergent pedido, then a concurrent writer
    // fixes the items and forces a retry — the retry must conclude "ok".
    const db = new FakeDb();
    seedConta(db);
    seedPedidoConferivel(db, {
      itens: {
        'produto-1': [
          {
            produtoUid: 'produto-1',
            ordem: 1,
            ensureUniqueId: 'uid-1',
            mktplaceId: 'MLB1',
            precoDeVenda: 100,
            quantidade: 2, // surplus → the first attempt would block
            descontoUnitario: 0,
          },
        ],
      },
    });

    let primeira = true;
    db.occ.beforeCommit = async () => {
      // Guard set BEFORE the nested transaction, which fires this hook again.
      if (!primeira) return;
      primeira = false;
      // A concurrent writer repairs the items. Going through a real transaction
      // (rather than `db.seed`) is what bumps the document's version, which is
      // how the engine detects the conflict and re-runs our callback.
      await db.runTransaction(async (tx) => {
        const ref = pedidoCollection.docRef(asDb(db), {}, 'pedido-1') as never;
        await tx.get(ref);
        tx.update(ref, {
          itens: {
            'produto-1': [
              {
                produtoUid: 'produto-1',
                ordem: 1,
                ensureUniqueId: 'uid-1',
                mktplaceId: 'MLB1',
                precoDeVenda: 100,
                quantidade: 1,
                descontoUnitario: 0,
              },
            ],
          },
        });
      });
    };

    await importPedidoMercadoLivre(deps(db, apiConferencia([linhaML()])), 1);

    // The retry really happened — otherwise this test would prove nothing.
    expect(db.occ.txLog.some((e) => e.phase === 'abort')).toBe(true);
    const written = db.docs('pedidos').get('pedido-1')!;
    // The first attempt's verdict (blocking) was DISCARDED, not carried over:
    // no `error`, no throw, and no incidente.
    expect(written.estado).toBe('iniciado');
    expect(written.valorCobrado).toBe(120);
    // Scoped to OUR id: the subcollection also holds `recordItensSemProduto`'s
    // own `ml-prod-*` row for a line that resolved to no produto (#792).
    expect(db.docs(INCIDENTE_PATH).has(INCIDENTE_ID)).toBe(false);
  });

  it('🔒 puts NO buyer data in the thrown error or the incidente', async () => {
    // Legacy's `throw Exception('Erro ao atualizar frete \n $pedido …')`
    // (tasks.dart:616) interpolated the whole pedido and the sweep rethrew it out
    // of the Cloud Run handler — buyer name, CPF/CNPJ, address, phone and prices
    // straight into the logs.
    const db = new FakeDb();
    seedConta(db);
    seedPedidoConferivel(db, {
      itens: {
        'produto-1': [
          {
            produtoUid: 'produto-1',
            ordem: 1,
            ensureUniqueId: 'uid-1',
            mktplaceId: 'MLB1',
            nomeDeVenda: 'Camiseta Preta M',
            sku: 'SKU-SEGREDO',
            precoDeVenda: 1234.56,
            quantidade: 2,
            descontoUnitario: 0,
          },
        ],
      },
    });

    const erro = await importPedidoMercadoLivre(deps(db, apiConferencia([linhaML()])), 1).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(erro).not.toBeNull();
    const mensagem = erro!.message;
    const motivo = String(db.docs(INCIDENTE_PATH).get(INCIDENTE_ID)!.motivoDoIncidente);
    for (const texto of [mensagem, motivo]) {
      expect(texto).not.toContain('Camiseta');
      expect(texto).not.toContain('SKU-SEGREDO');
      expect(texto).not.toContain('1234.56');
      expect(texto).not.toContain('cli-1');
    }
    // …but it DOES say which pedido, which shipment and by how much.
    expect(mensagem).toContain('pedido-1');
    expect(mensagem).toContain(String(SHIPMENT_ID));
    expect(motivo).toContain('MLB1');
  });
});

/* ------------------- concurrency: the frete conference race ---------------- */
// Issue #791 test 4. Exercises the shared `OccEngine`'s retry path against
// `applyFreteStep`'s FULL-CONFERENCE branch — the one branch with no in-tx
// staleness re-guard. `mappedFrete` is built OUTSIDE the transaction, so an
// OCC retry re-applies it verbatim: the loser overwrites the winner with an
// OLDER shipment payload and drags `freteInicial.ultimaModificacao` backwards.

/*
 * The money map of a PACK — the shape #1087's live run left unverified.
 *
 * Vector from the 2026-08-27 run (pack `2000014733850447`): two sibling orders
 * of R$ 50,00 and R$ 99,94 collapsing onto ONE pedido, and a single shipment
 * whose `GET /shipments/{id}/payments` carries one approved R$ 85,99.
 *
 * ⚠️ **The freight is billed ONCE, on the shipment — not per order.** So each
 * order's payment carries `shipping_cost: 0` and ML's per-order `paid_amount`
 * (Σ 149,94) structurally cannot see the 85,99. That is why the create-time
 * Formula A total and the stored one differ on a pack, and why comparing the
 * stored value against Σ `paid_amount` reads as an R$ 85,99 defect when nothing
 * is wrong. `applyFreteStep` is the owner: Σ `itemSubtotal` + frete, i.e. the
 * legacy `Pedido.total` — "valor final cobrado no pedido", freight included.
 *
 * ⚠️ Getting this wrong in the OTHER direction is the dangerous one. At 149,94
 * the `pago` advance (`totalAprovado >= valorCobrado`) fires while the buyer's
 * freight payment is still uncounted — and `pago` authorises dispatch and NF-e
 * emission. The last case below is that assertion.
 */
describe('importPedidoMercadoLivre — money map de um PACK (#1087)', () => {
  const PACK_ID = 9000;
  const ORDER_A = 9001;
  const ORDER_B = 9002;
  const SHIPMENT_ID = 9777;
  const FRETE = 85.99;
  const TOTAL_DO_PACK = 235.93; // roundReais(roundReais(50 + 99.94) + 85.99)

  /** One pack sibling: its own line price and its own single approved payment. */
  function ordemDoPack(id: number, unitPrice: number): DocData {
    const base = makeOrder({ id, packId: PACK_ID, shippingId: SHIPMENT_ID });
    return {
      ...base,
      total_amount: unitPrice,
      order_items: [
        {
          item: { id: `MLB${id}`, title: 'Produto', seller_sku: null },
          quantity: 1,
          unit_price: unitPrice,
        },
      ],
      // `shipping_cost: 0` is the POINT, not a shortcut: on a pack ML charges
      // the freight on the shipment, so Formula A can only ever see the items.
      payments: [
        {
          id: 5000 + id,
          status: 'approved',
          transaction_amount: unitPrice,
          shipping_cost: 0,
          coupon_amount: 0,
        },
      ],
    };
  }

  const ORDENS: ReadonlyMap<number, DocData> = new Map([
    [ORDER_A, ordemDoPack(ORDER_A, 50)],
    [ORDER_B, ordemDoPack(ORDER_B, 99.94)],
  ]);

  function apiDoPack(over: Partial<Record<keyof MercadoLivreApi, unknown>> = {}): MercadoLivreApi {
    return makeApi({
      getOrder: vi.fn(async (id: number | string) => ORDENS.get(Number(id)) ?? ORDENS.get(ORDER_A)),
      getPack: vi.fn(async () => ({
        id: PACK_ID,
        status: 'ready',
        orders: [{ id: ORDER_A }, { id: ORDER_B }],
      })),
      getShipment: vi.fn(async () => ({
        id: SHIPMENT_ID,
        order_id: ORDER_A,
        status: 'ready_to_ship',
        substatus: null,
        last_updated: '2026-01-02T00:00:00.000-03:00',
        shipping_option: {},
      })),
      getShipmentPayments: vi.fn(async () => [
        { payment_id: 7001, status: 'approved', amount: FRETE },
      ]),
      // ONE shipment covering BOTH orders' lines — a matching conference. The
      // default `[]` stub would report `indeterminado` and this block would
      // silently assert the skip path instead of the pricing it is named for.
      getShipmentOrders: vi.fn(async () => [
        {
          order_id: String(ORDER_A),
          item_id: `MLB${ORDER_A}`,
          variation_id: null,
          seller_id: SELLER_USER_ID,
          requested_quantity: 1,
        },
        {
          order_id: String(ORDER_B),
          item_id: `MLB${ORDER_B}`,
          variation_id: null,
          seller_id: SELLER_USER_ID,
          requested_quantity: 1,
        },
      ]),
      ...over,
    });
  }

  /** The `getPayment` the shipping payment actually needs — see the ⚠️ below. */
  const getPaymentDoFrete = () =>
    vi.fn(async (id: number | string) => ({
      id: Number(id),
      status: 'approved',
      transaction_amount: FRETE,
      shipping_cost: 0,
      refunds: [],
    }));

  /**
   * Persist the pedido the way `orderPedidoTx` would, but from the items the
   * REAL `mlOrderItemToItemDoPedido` built during this run's pack fan-out
   * (`./orderMapping` is not mocked in this file) — so the fixture is a genuine
   * pack, not a transcription of one. `valorCobrado` is seeded with the REAL
   * create-time Formula A value for `orders[0]`, which is what makes the repair
   * assertion below mean something.
   */
  function seedPedidoDoPack(db: FakeDb): void {
    seedConta(db);
    vi.mocked(discoverPedidoMercadoLivre).mockImplementation(async (args) => {
      const fake = args.db as unknown as FakeDb;
      if (!fake.docs('pedidos').has('pedido-1')) {
        const itens: Record<string, ItemDoPedido[]> = {};
        for (const lista of args.itensByOrderId.values()) {
          for (const item of lista) (itens[item.produtoUid ?? 'NONE'] ??= []).push(item);
        }
        const core = mlOrderToPedidoCoreFields({ order: args.orders[0]!, packId: PACK_ID });
        fake.seed('pedidos', 'pedido-1', {
          estado: 'emProcessamento',
          clientePedidoOuterRef: 'documents/clientes/cli-1',
          enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
          freteInicial: null,
          numero: String(PACK_ID),
          itens,
          itensIds: Object.keys(itens),
          descontoTotal: core.descontoTotal,
          valorCobrado: core.valorCobrado,
          ultimaModificacao: NOW_US,
        });
      }
      return { pedidoId: 'pedido-1', created: true };
    });
    // One produto per line, so the two lines key under two produtos and no
    // `ml-prod-*` incidente noise lands in the subcollection.
    vi.mocked(resolveOrderLineProduto).mockImplementation(async (_db, query) =>
      query.itemId === `MLB${ORDER_B}`
        ? { produtoId: 'produto-B', via: 'parent-link' }
        : { produtoId: 'produto-A', via: 'parent-link' },
    );
  }

  it('prices the WHOLE pack: Σ itens das duas ordens + o frete do único envio', async () => {
    const db = new FakeDb();
    seedPedidoDoPack(db);

    await importPedidoMercadoLivre(deps(db, apiDoPack()), ORDER_A);

    const written = db.docs('pedidos').get('pedido-1')!;
    expect(written.valorCobrado).toBe(TOTAL_DO_PACK);
    expect(written.freteInicial).toMatchObject({
      externalId: String(SHIPMENT_ID),
      valorCobrado: FRETE, // one shipment's payments serve every sibling
    });
    // Both lines are present and both were priced — the total is not one order's.
    expect((written.itensIds as string[]).sort()).toEqual(['produto-A', 'produto-B']);
    // The conference AGREED; this is not the `indeterminado` fall-through.
    expect(db.docs('pedidos/pedido-1/incidentes').has(`ml-envio-div-${SHIPMENT_ID}`)).toBe(false);
  });

  it('REPAIRS the create-time orders[0]-only under-count (50,00 → 235,93)', async () => {
    const db = new FakeDb();
    seedPedidoDoPack(db);

    await importPedidoMercadoLivre(deps(db, apiDoPack()), ORDER_A);

    // Anti-vacuity, both halves: the fan-out really did carry two orders, and
    // the seed really was the under-counted Formula A value — so 235,93 cannot
    // be the number that was already sitting on the document.
    const args = vi.mocked(discoverPedidoMercadoLivre).mock.calls[0]![0];
    expect(args.orders.map((o) => o.id)).toEqual([ORDER_A, ORDER_B]);
    expect(
      mlOrderToPedidoCoreFields({ order: args.orders[0]!, packId: PACK_ID }).valorCobrado,
    ).toBe(50);
    expect(db.lastPatch('pedidos', 'pedido-1')).toMatchObject({ valorCobrado: TOTAL_DO_PACK });
    // An untouched seeded field proves this was a targeted patch, not a rewrite.
    expect(db.docs('pedidos').get('pedido-1')!.numero).toBe(String(PACK_ID));
  });

  it('advances to pago once the freight payment joins the two ordens pagamentos', async () => {
    const db = new FakeDb();
    seedPedidoDoPack(db);
    db.seed('pedidos/pedido-1/pagamentos', 'pag-A', {
      id: '5001',
      valor: 50,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });
    db.seed('pedidos/pedido-1/pagamentos', 'pag-B', {
      id: '5002',
      valor: 99.94,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });

    // ⚠️ `makeApi`'s default `getPayment` answers `{ id, status: 'approved' }`
    // with NO `transaction_amount`, which maps to `valor: 0` + `estornado`
    // (`refunds >= valorNet` is `0 >= 0`). The shipping payment would then
    // contribute nothing and this test would pass for the wrong reason.
    await importPedidoMercadoLivre(
      deps(db, apiDoPack({ getPayment: getPaymentDoFrete() })),
      ORDER_A,
    );

    // The load-bearing half: the SHIPMENT's payment was registered as a
    // pagamento, which is what lets Σ aprovados reach the pack total at all.
    expect(db.docs('pedidos/pedido-1/pagamentos').size).toBe(3);
    expect(db.docs('pedidos').get('pedido-1')!.estado).toBe('pago');
  });

  it('does NOT advance a pack whose sibling pagamento was recusado', async () => {
    // Σ aprovados is 135,99 here. Against the create-time 50,00 this pedido
    // would be `pago` on a partial payment — #791's failure mode, and the whole
    // reason the conference owns the total. This case reds the moment anyone
    // makes `valorCobrado` per-order again.
    const db = new FakeDb();
    seedPedidoDoPack(db);
    db.seed('pedidos/pedido-1/pagamentos', 'pag-A', {
      id: '5001',
      valor: 50,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });
    db.seed('pedidos/pedido-1/pagamentos', 'pag-B', {
      id: '5002',
      valor: 99.94,
      status_pagamento: STATUS_PAGAMENTO.recusado,
    });

    await importPedidoMercadoLivre(
      deps(db, apiDoPack({ getPayment: getPaymentDoFrete() })),
      ORDER_A,
    );

    const written = db.docs('pedidos').get('pedido-1')!;
    expect(written.valorCobrado).toBe(TOTAL_DO_PACK);
    expect(written.estado).toBe('emProcessamento');
  });
});

describe('applyFreteStep — concurrent conferences (OCC)', () => {
  const STORED_US = Date.parse('2026-01-01T00:00:00.000Z') * 1000;
  const FRESH_ISO = '2026-01-15T00:00:00.000-03:00';
  const STALE_ISO = '2026-01-05T00:00:00.000-03:00';
  const FRESH_US = Date.parse(FRESH_ISO) * 1000;
  const STALE_US = Date.parse(STALE_ISO) * 1000;

  function seedFreteRace(db: FakeDb): void {
    seedConta(db);
    db.seed('pedidos', 'pedido-1', {
      // `pago` is NOT in ESTADOS_CONFERIR_PAGAMENTO, but a null `prazoDespacho`
      // still selects the FULL-CONFERENCE branch — the unguarded one.
      estado: 'pago',
      clientePedidoOuterRef: 'documents/clientes/cli-1',
      enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
      freteInicial: {
        estado: 'postado',
        externalId: '777',
        prazoDespacho: null,
        ultimaModificacao: STORED_US,
      },
      valorCobrado: 100,
      itens: {},
    });
  }

  function apiFor(shipmentLastUpdated: string): MercadoLivreApi {
    return makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, shippingId: 777, status: 'paid' })),
      getShipment: vi.fn(async () => ({
        id: 777,
        order_id: 1,
        status: 'shipped',
        substatus: null,
        last_updated: shipmentLastUpdated,
        base_cost: 15,
        shipping_option: { list_cost: 25 },
      })),
      getShipmentPayments: vi.fn(async () => []),
    });
  }

  /** The `freteInicial.ultimaModificacao` an attempt is about to commit — a run's identity. */
  function pendingFreteStamp(writes: readonly { path: string; data: DocData }[]): number | null {
    const patch = writes.find((w) => w.path === 'pedidos/pedido-1')?.data;
    const frete = patch?.freteInicial as { ultimaModificacao?: number | null } | undefined;
    return frete?.ultimaModificacao ?? null;
  }

  /** Runs both conferences concurrently, forcing `holdLast` to commit LAST. */
  async function runRace(holdLast: 'fresh' | 'stale'): Promise<FakeDb> {
    const db = new FakeDb();
    seedFreteRace(db);
    const heldStamp = holdLast === 'fresh' ? FRESH_US : STALE_US;
    const gate = deferred();
    db.occ.beforeCommit = ({ writes }) =>
      pendingFreteStamp(writes) === heldStamp ? gate.promise : undefined;

    const fresh = importPedidoMercadoLivre(deps(db, apiFor(FRESH_ISO)), 1);
    const stale = importPedidoMercadoLivre(deps(db, apiFor(STALE_ISO)), 1);
    await Promise.race([fresh, stale]); // the un-held run settles on its own
    gate.resolve();
    await Promise.all([fresh, stale]);
    return db;
  }

  it.each(['fresh', 'stale'] as const)(
    'the NEWER shipment payload wins even when the %s conference commits last',
    async (holdLast) => {
      const db = await runRace(holdLast);

      const frete = db.docs('pedidos').get('pedido-1')!.freteInicial as DocData;
      expect(frete.ultimaModificacao).toBe(FRESH_US);
    },
  );
});

/* ------------------ the pago advance uses the APPROVED-only sum ------------ */
// Issue #791 test 1-3 (O13). Legacy's primary advance summed EVERY pagamento
// regardless of status (tasks.dart:665-666), so a rejected payment could push a
// pedido to `pago` — and `pago` authorizes dispatch and NF-e emission.

describe('importPedidoMercadoLivre — pago advance sums only APPROVED pagamentos', () => {
  function seedAdvanceCase(db: FakeDb, pagamentos: DocData[]): void {
    seedConta(db);
    db.seed('pedidos', 'pedido-1', {
      estado: 'emProcessamento',
      clientePedidoOuterRef: 'documents/clientes/cli-1',
      enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
      freteInicial: { estado: 'iniciado' },
      valorCobrado: 100,
      numero: 'X',
      itens: {},
    });
    pagamentos.forEach((p, i) => db.seed('pedidos/pedido-1/pagamentos', `pag-${i}`, p));
  }

  const apiForAdvance = (): MercadoLivreApi =>
    makeApi({ getOrder: vi.fn(async () => makeOrder({ id: 1 })) });

  it('does NOT advance when the only pagamento is recusado for the FULL amount', async () => {
    const db = new FakeDb();
    seedAdvanceCase(db, [{ id: '900', valor: 100, status_pagamento: STATUS_PAGAMENTO.recusado }]);

    await importPedidoMercadoLivre(deps(db, apiForAdvance()), 1);

    expect(db.docs('pedidos').get('pedido-1')!.estado).toBe('emProcessamento');
    // Not merely "did not advance" — did not WRITE. A no-op decision writes nothing.
    expect(db.lastPatch('pedidos', 'pedido-1')).toBeUndefined();
  });

  it('DOES advance on one aprovado pagamento covering the total, with a targeted patch', async () => {
    const db = new FakeDb();
    seedAdvanceCase(db, [{ id: '900', valor: 100, status_pagamento: STATUS_PAGAMENTO.aprovado }]);

    await importPedidoMercadoLivre(deps(db, apiForAdvance()), 1);

    expect(db.docs('pedidos').get('pedido-1')!.estado).toBe('pago');
    const patch = db.lastPatch('pedidos', 'pedido-1')!;
    expect(Object.keys(patch).sort()).toEqual(['estado', 'ultimaModificacao']);
    // An untouched seeded field proves this was a TARGETED patch, not a rewrite.
    expect(db.docs('pedidos').get('pedido-1')!.numero).toBe('X');
  });

  it('stays emProcessamento when aprovado + recusado only TOGETHER cover the total', async () => {
    const db = new FakeDb();
    seedAdvanceCase(db, [
      { id: '900', valor: 40, status_pagamento: STATUS_PAGAMENTO.aprovado },
      // 40 + 60 = 100 under the old sum-everything rule — must not count.
      { id: '901', valor: 60, status_pagamento: STATUS_PAGAMENTO.recusado },
    ]);

    await importPedidoMercadoLivre(deps(db, apiForAdvance()), 1);

    expect(db.docs('pedidos').get('pedido-1')!.estado).toBe('emProcessamento');
    expect(db.lastPatch('pedidos', 'pedido-1')).toBeUndefined();
  });

  it('does not count an estornado_parcialmente residue as paying', async () => {
    const db = new FakeDb();
    seedAdvanceCase(db, [
      { id: '900', valor: 100, status_pagamento: STATUS_PAGAMENTO.estornado_parcialmente },
    ]);

    await importPedidoMercadoLivre(deps(db, apiForAdvance()), 1);

    expect(db.docs('pedidos').get('pedido-1')!.estado).toBe('emProcessamento');
  });

  it('does not count a NULL status_pagamento as paying (sumApprovedOnly, not sumPagamentosPagos)', async () => {
    const db = new FakeDb();
    seedAdvanceCase(db, [{ id: '900', valor: 100, status_pagamento: null }]);

    await importPedidoMercadoLivre(deps(db, apiForAdvance()), 1);

    expect(db.docs('pedidos').get('pedido-1')!.estado).toBe('emProcessamento');
  });

  it('never advances a pedido whose valorCobrado was never conferred (null total)', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('pedidos', 'pedido-1', {
      estado: 'emProcessamento',
      clientePedidoOuterRef: 'documents/clientes/cli-1',
      enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
      freteInicial: { estado: 'iniciado' },
      valorCobrado: null,
      itens: {},
    });
    db.seed('pedidos/pedido-1/pagamentos', 'pag-0', {
      id: '900',
      valor: 5,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });

    await importPedidoMercadoLivre(deps(db, apiForAdvance()), 1);

    // A null total used to read as a threshold of 0, so ANY pagamento advanced it.
    expect(db.docs('pedidos').get('pedido-1')!.estado).toBe('emProcessamento');
  });

  it('never advances a pedido with no pagamentos at all (0 >= 0 is not payment)', async () => {
    const db = new FakeDb();
    seedConta(db);
    db.seed('pedidos', 'pedido-1', {
      estado: 'emProcessamento',
      clientePedidoOuterRef: 'documents/clientes/cli-1',
      enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
      freteInicial: { estado: 'iniciado' },
      valorCobrado: 0,
      itens: {},
    });

    await importPedidoMercadoLivre(deps(db, apiForAdvance()), 1);

    expect(db.docs('pedidos').get('pedido-1')!.estado).toBe('emProcessamento');
  });

  it('re-derives the four-field guard from the tx-fresh doc, not the pre-read one', async () => {
    const db = new FakeDb();
    seedAdvanceCase(db, [{ id: '900', valor: 100, status_pagamento: STATUS_PAGAMENTO.aprovado }]);
    // A competing writer advances the pedido between our pre-read and our
    // commit, via a REAL second transaction (so the engine's version counter
    // moves exactly as it would in production). The advance transaction must
    // abort, re-run, and decline on the tx-fresh `estado` — leaving exactly one
    // estado write in the store.
    let interfered = false;
    db.occ.beforeCommit = async ({ writes }) => {
      if (interfered || !writes.some((w) => w.path === 'pedidos/pedido-1')) return;
      interfered = true;
      await db.runTransaction(async (tx) => {
        tx.update(pedidoCollection.docRef(asDb(db), {}, 'pedido-1'), { estado: 'pago' });
      });
    };

    await importPedidoMercadoLivre(deps(db, apiForAdvance()), 1);

    expect(db.docs('pedidos').get('pedido-1')!.estado).toBe('pago');
    expect(db.occ.txLog.some((e) => e.phase === 'abort')).toBe(true);
    // The competitor's write, and nothing from the aborted attempt's retry.
    const estadoWrites = db.opLog.filter((o) => o.op === 'update' && o.path === 'pedidos/pedido-1');
    expect(estadoWrites.length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * #1087 — an order sold with **no Mercado Envios shipment** ("frete a combinar
 * com o comprador"). Before this, `applyFreteStep` was gated on a non-null
 * `MlShipment` with no `else`, so `freteInicial` was never written,
 * `podeAvancarParaPago` could never fire, and the pedido was stranded at
 * `emProcessamento` FOREVER with the payment correctly imported beside it.
 */
describe('importPedidoMercadoLivre — order with no Mercado Envios shipment', () => {
  function seedPedidoPronto(db: FakeDb, over: DocData = {}): void {
    db.seed('pedidos', 'pedido-1', {
      estado: 'emProcessamento',
      clientePedidoOuterRef: 'documents/clientes/cli-1',
      enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
      freteInicial: null,
      valorCobrado: 100,
      itens: {
        'produto-1': [
          {
            produtoUid: 'produto-1',
            ordem: 1,
            mktplaceId: 'MLB1',
            precoDeVenda: 100,
            quantidade: 1,
            descontoUnitario: 0,
          },
        ],
      },
      ...over,
    });
  }

  it('synthesizes a freteInicial and never asks ML for a shipment', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPronto(db);
    const getShipment = vi.fn();
    const api = makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, tags: ['no_shipping', 'paid'] })),
      getShipment,
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    // There is no shipment to fetch, and asking would be a wasted round trip
    // (and a 404 on a real order).
    expect(getShipment).not.toHaveBeenCalled();

    const frete = db.docs('pedidos').get('pedido-1')!.freteInicial as DocData;
    expect(frete).not.toBeNull();
    expect(frete).toMatchObject({
      estado: 'iniciado',
      // ⚠️ FOB, not CIF. CIF ('0') is the only modalidade that charges freight
      // INTO the nota, and three NF-e generator reads key on it (#1090).
      modalidade: '1',
      // No external freight option exists on this order. This is also what makes
      // the etiqueta route and all three nfeUpload gates decline, correctly —
      // they test `=== INTEGRACAO_FRETE.mercadoLivre`.
      externalOptionIntegracao: null,
      externalId: null,
      codRastreio: null,
      enderecoFreteOuterReference: 'documents/clientes/cli-1/enderecos/end-1',
    });
  });

  it('⚠️ stamps ultimaModificacao, or a later real shipment could never overwrite it', () => {
    // `seedFreteInicial` leaves the stamp null, and the SHIPMENTS-topic policy
    // reads an unstamped STORED block as "already newer" — the deliberate inverse
    // of the order-import policy. An unstamped seed would therefore freeze the
    // block forever, silently, if this order ever did gain a real shipment.
    expect(POLITICA_FRESCOR_TOPICO_SHIPMENTS.semWatermarkArmazenado).toBe('ignorar');
    expect(
      freteRecebidoEhMaisNovo({
        semFreteArmazenado: false,
        armazenadoUs: null, // an UNSTAMPED seed
        recebidoUs: 1_700_000_000_000_000,
        ...POLITICA_FRESCOR_TOPICO_SHIPMENTS,
      }),
      'an unstamped seed would refuse the real shipment',
    ).toBe(false);
    expect(
      freteRecebidoEhMaisNovo({
        semFreteArmazenado: false,
        armazenadoUs: NOW_US, // what we actually write
        recebidoUs: NOW_US + 1,
        ...POLITICA_FRESCOR_TOPICO_SHIPMENTS,
      }),
    ).toBe(true);
  });

  it('⚠️ waits for the endereço — seeding early would freeze the address null forever', async () => {
    // `applyEnderecoStep` has a `sem-cep` path that leaves `enderecoFiscalOuterRef`
    // null and RETRIES on later runs. This step is create-only, so a block seeded
    // now would keep `enderecoFreteOuterReference: null` forever. The shipment
    // path self-heals (`mergeFreteInicial` re-applies the ref every run); this one
    // cannot, so it declines instead — mirroring `applyFreteStep`'s own
    // "no fiscal address AND no prior frete → nothing is written" fallthrough.
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPronto(db, { enderecoFiscalOuterRef: null });
    const api = makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, tags: ['no_shipping'] })),
    });

    await importPedidoMercadoLivre(deps(db, api), 1);
    expect(
      db.docs('pedidos').get('pedido-1')!.freteInicial,
      'must not seed a block whose address it would never revisit',
    ).toBeNull();

    // The endereço lands on a later run — now the seed carries it.
    db.seed('pedidos', 'pedido-1', {
      ...(db.docs('pedidos').get('pedido-1') as DocData),
      enderecoFiscalOuterRef: 'documents/clientes/cli-1/enderecos/end-1',
    });
    await importPedidoMercadoLivre(deps(db, api), 1);

    const frete = db.docs('pedidos').get('pedido-1')!.freteInicial as DocData;
    expect(frete.enderecoFreteOuterReference).toBe('documents/clientes/cli-1/enderecos/end-1');
  });

  it('the written block carries the stamp', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPronto(db);
    const api = makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, tags: ['no_shipping'] })),
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    const frete = db.docs('pedidos').get('pedido-1')!.freteInicial as DocData;
    expect(frete.ultimaModificacao).toBe(NOW_US);
  });

  it('⛔ writes NOTHING when the shipment is merely un-propagated (no no_shipping tag)', async () => {
    // THE test that carries the design. ML attaches the shipment asynchronously
    // — its Orders reference says so — so an absent `shipping.id` on its own also
    // means "not here YET". Seeding a no-freight block on that order would be
    // wrong, and since the step is create-only the wrong block would stick.
    // If someone "simplifies" the gate to `shipping?.id == null`, this goes red.
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPronto(db);
    const api = makeApi({ getOrder: vi.fn(async () => makeOrder({ id: 1 })) });

    await importPedidoMercadoLivre(deps(db, api), 1);

    const written = db.docs('pedidos').get('pedido-1')!;
    expect(written.freteInicial).toBeNull();
    expect(written.estado).toBe('emProcessamento');
  });

  it('says so out loud, printing the real tags — the silent third case is the trap', async () => {
    // If `no_shipping` is not the literal ML sends, this PR fails EXACTLY like
    // #1087 did: stranded pedido, `detail: "updated"`, nothing explaining why.
    // The tag set in this warn is what settles the question from a live replay.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPronto(db);
    const api = makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, tags: ['paid', 'not_delivered'] })),
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('sem tag no_shipping'),
      expect.objectContaining({ tags: ['paid', 'not_delivered'], esperado: 'no_shipping' }),
    );
    warn.mockRestore();
  });

  it('advances the pedido to pago once the payment is there', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPronto(db);
    db.seed('pedidos/pedido-1/pagamentos', 'pag-1', {
      id: '900',
      valor: 100,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });
    const api = makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, tags: ['no_shipping'] })),
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    // The whole point: cliente + endereço were already there, the frete block is
    // what was missing, and the money is covered.
    expect(db.docs('pedidos').get('pedido-1')!.estado).toBe('pago');
  });

  it('reports semEnvio so the notification log can say the freight needs a human', async () => {
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPronto(db);
    const api = makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, tags: ['no_shipping'] })),
    });

    const result = await importPedidoMercadoLivre(deps(db, api), 1);
    expect(result.semEnvio).toBe(true);
  });

  it('is create-only — a replay never clobbers an existing freteInicial', async () => {
    // An operator edit, or a real shipment that landed later, must survive a
    // re-delivered notification.
    const db = new FakeDb();
    seedConta(db);
    seedPedidoPronto(db, {
      freteInicial: { estado: 'postado', modalidade: '0', codRastreio: 'BR123456789BR' },
    });
    const api = makeApi({
      getOrder: vi.fn(async () => makeOrder({ id: 1, tags: ['no_shipping'] })),
    });

    await importPedidoMercadoLivre(deps(db, api), 1);

    expect(db.docs('pedidos').get('pedido-1')!.freteInicial).toMatchObject({
      estado: 'postado',
      modalidade: '0',
      codRastreio: 'BR123456789BR',
    });
  });

  // ⚠️⚠️ EVERY assertion below guards a PHYSICAL STOCK MOVEMENT, not a label.
  // `entregue` ∈ `ESTADOS_FRETE_REMOVE_ESTOQUE`, so committing it wakes
  // `onPedidoEstoqueSync` and deducts the goods from the depósito — and crossing
  // that boundary is irreversible from the frete side (`efeitoEstoquePedido`
  // holds on the PEDIDO estado once applied, so moving the frete back restocks
  // nothing). A guard that stops firing here does not produce a wrong label; it
  // produces missing inventory.
  describe('delivery via order.fulfilled', () => {
    /** A pedido that already carries the sem-envio seed, ready to be advanced. */
    function seedPedidoComFreteSemEnvio(db: FakeDb, freteOver: DocData = {}): void {
      seedPedidoPronto(db, {
        lastMarketplaceUpdate: Date.parse('2026-01-01T00:00:00.000-03:00') * 1000,
        freteInicial: {
          estado: 'iniciado',
          modalidade: '1',
          externalOptionIntegracao: null,
          enderecoFreteOuterReference: 'documents/clientes/cli-1/enderecos/end-1',
          ultimaModificacao: Date.parse('2026-01-01T00:00:00.000-03:00') * 1000,
          ...freteOver,
        },
      });
    }

    function freteDe(db: FakeDb): DocData {
      return db.docs('pedidos').get('pedido-1')!.freteInicial as DocData;
    }

    it('advances an existing sem-envio frete to entregue when fulfilled is true', async () => {
      // The live case: the seller confirms delivery in the ML panel, `fulfilled`
      // flips null → true, and `tags`/`status` never move (ML stopped adding the
      // `delivered` tag automatically — "o integrador deverá realizar um PUT com
      // a tag correspondente"). Before this, the signal arrived and was dropped.
      const db = new FakeDb();
      seedConta(db);
      seedPedidoComFreteSemEnvio(db);
      const api = makeApi({
        getOrder: vi.fn(async () =>
          makeOrder({
            id: 1,
            tags: ['no_shipping', 'not_delivered', 'paid'],
            fulfilled: true,
            lastUpdated: '2026-02-01T00:00:00.000-03:00',
          }),
        ),
      });

      await importPedidoMercadoLivre(deps(db, api), 1);

      expect(freteDe(db)).toMatchObject({ estado: 'entregue' });
      // The rest of the block rides through untouched — the advance re-derives
      // it from the tx-fresh read and overrides exactly one field.
      expect(freteDe(db)).toMatchObject({ modalidade: '1', externalOptionIntegracao: null });
    });

    it('⛔ does NOT read fulfilled on an order that HAS a shipment', async () => {
      // The precedence guard, and it is structural: `fulfilled` is read only
      // inside the `semEnvio` arm, and `pedidoSemEnvioMercadoEnvios` demands an
      // absent `shipping.id`. For an me2/FULL order the shipment is the
      // authority and must never be overridden by a feedback flag.
      const db = new FakeDb();
      seedConta(db);
      seedPedidoComFreteSemEnvio(db);
      const getShipment = vi.fn(async () => ({
        id: 77,
        status: 'ready_to_ship',
        substatus: null,
        last_updated: '2026-02-01T00:00:00.000-03:00',
      }));
      const api = makeApi({
        getOrder: vi.fn(async () =>
          makeOrder({
            id: 1,
            shippingId: 77,
            tags: ['no_shipping'],
            fulfilled: true,
            lastUpdated: '2026-02-01T00:00:00.000-03:00',
          }),
        ),
        getShipment,
      });

      await importPedidoMercadoLivre(deps(db, api), 1);

      // The shipment branch ran...
      expect(getShipment).toHaveBeenCalled();
      // ...and nothing anywhere wrote `entregue` off the back of `fulfilled`.
      expect(freteDe(db).estado).not.toBe('entregue');
    });

    it('⛔ refuses to flip on a payload OLDER than the ML order clock', async () => {
      // `fulfilled` is FEEDBACK, and feedback is editable (`PUT /feedback/{id}`),
      // so a replayed `true` can contradict a newer `false`. That is why the
      // advance is gated even though it is a "promotion" — unlike an approved
      // payment, it is not true-whenever-it-arrives.
      const db = new FakeDb();
      seedConta(db);
      seedPedidoComFreteSemEnvio(db);
      db.docs('pedidos').get('pedido-1')!.lastMarketplaceUpdate =
        Date.parse('2026-03-01T00:00:00.000-03:00') * 1000;
      const api = makeApi({
        getOrder: vi.fn(async () =>
          makeOrder({
            id: 1,
            tags: ['no_shipping'],
            fulfilled: true,
            lastUpdated: '2026-01-01T00:00:00.000-03:00',
          }),
        ),
      });

      await importPedidoMercadoLivre(deps(db, api), 1);

      expect(freteDe(db).estado).toBe('iniciado');
    });

    // ⚠️ BOTH stored states are load-bearing, and the `iniciado` rows are the
    // ones that actually pin the guard. Seeded at `entregue` the idempotence
    // check short-circuits first, so an `entregue`-only table still passes with
    // the `!entregue` guard DELETED — measured, not assumed. The `iniciado` rows
    // are the ones that red, and they are the dangerous direction anyway: a
    // wrong forward flip moves stock, while an un-flip could not restock even if
    // it happened.
    it.each([
      ['iniciado', 'null (the seller has not confirmed)', null],
      ['iniciado', 'false (the sale was NOT concretized)', false],
      ['entregue', 'null (the seller has not confirmed)', null],
      ['entregue', 'false (the sale was NOT concretized)', false],
    ])(
      '⛔ leaves a %s frete exactly as it was — fulfilled: %s',
      async (estadoArmazenado, _label, fulfilled) => {
        // `false` is not "not delivered yet": ML requires a `reason`
        // (OUT_OF_STOCK / BUYER_REGRETS / …), refunds the payment and drives
        // `status` back to `confirmed`. That is the cancel path
        // `applyPagoAdvanceOrDowngrade` already owns via `order.status`; a second
        // writer of it here would be the lost update rule 7 warns about.
        const db = new FakeDb();
        seedConta(db);
        seedPedidoComFreteSemEnvio(db, { estado: estadoArmazenado });
        const api = makeApi({
          getOrder: vi.fn(async () =>
            makeOrder({
              id: 1,
              tags: ['no_shipping'],
              fulfilled: fulfilled as boolean | null,
              lastUpdated: '2026-02-01T00:00:00.000-03:00',
            }),
          ),
        });

        await importPedidoMercadoLivre(deps(db, api), 1);

        expect(freteDe(db).estado).toBe(estadoArmazenado);
      },
    );

    // ⚠️ The block is editable precisely BECAUSE it is not marketplace-owned, so
    // an operator can arrange real freight on it — pick an int_frete, select a
    // quoted option, buy a Melhor Envio label. From then on the carrier owns
    // `estado`. Writing `entregue` over it does not merely mislabel a parcel in
    // transit: the ME webhook latches on `entregue` via its own TERMINAL_ESTADOS,
    // so every later ME event for that label is silently dropped FOREVER — and
    // from a pre-removal estado it fires the irreversible stock movement early.
    it.each([
      [
        'integracaoFreteOuterRef (an int_frete was chosen)',
        { integracaoFreteOuterRef: 'documents/int_frete/me-1' },
      ],
      [
        'externalOptionIntegracao (a quote was selected)',
        { externalOptionIntegracao: 'melhorEnvios' },
      ],
      ['printLabelId (a label was bought)', { printLabelId: 'label-123' }],
      ['externalId (an external shipment exists)', { externalId: 'ext-9' }],
    ])('⛔ never takes a frete arranged outside ML — %s', async (_label, freteOver) => {
      const db = new FakeDb();
      seedConta(db);
      // `postado` is deliberately in ESTADOS_FRETE_REMOVE_ESTOQUE already, so
      // this case isolates the OWNERSHIP violation from the stock one.
      seedPedidoComFreteSemEnvio(db, { estado: 'postado', ...freteOver });
      const api = makeApi({
        getOrder: vi.fn(async () =>
          makeOrder({
            id: 1,
            tags: ['no_shipping'],
            fulfilled: true,
            lastUpdated: '2026-02-01T00:00:00.000-03:00',
          }),
        ),
      });

      await importPedidoMercadoLivre(deps(db, api), 1);

      expect(freteDe(db).estado).toBe('postado');
    });

    it('⛔ an arranged frete in a PRE-REMOVAL estado is not advanced — the stock case', async () => {
      // `despachoAutorizado` is NOT in ESTADOS_FRETE_REMOVE_ESTOQUE, so advancing
      // it to `entregue` would cross the boundary and deduct the goods — for a
      // parcel the carrier has not even collected. This is the worst of the three
      // consequences and the one that cannot be undone from the frete side.
      const db = new FakeDb();
      seedConta(db);
      seedPedidoComFreteSemEnvio(db, {
        estado: 'despachoAutorizado',
        printLabelId: 'label-123',
        externalOptionIntegracao: 'melhorEnvios',
      });
      const api = makeApi({
        getOrder: vi.fn(async () =>
          makeOrder({
            id: 1,
            tags: ['no_shipping'],
            fulfilled: true,
            lastUpdated: '2026-02-01T00:00:00.000-03:00',
          }),
        ),
      });

      await importPedidoMercadoLivre(deps(db, api), 1);

      expect(freteDe(db).estado).toBe('despachoAutorizado');
    });

    it('still advances a frete carrying only a hand-typed codRastreio', async () => {
      // The deliberate NON-member of the arranged-freight predicate. An operator
      // who delivered by motoboy can record a tracking code on a genuinely
      // un-arranged frete; that must not veto ML's confirmation, because no
      // SYSTEM is going to write `estado` for it.
      const db = new FakeDb();
      seedConta(db);
      seedPedidoComFreteSemEnvio(db, { codRastreio: 'BR123456789BR' });
      const api = makeApi({
        getOrder: vi.fn(async () =>
          makeOrder({
            id: 1,
            tags: ['no_shipping'],
            fulfilled: true,
            lastUpdated: '2026-02-01T00:00:00.000-03:00',
          }),
        ),
      });

      await importPedidoMercadoLivre(deps(db, api), 1);

      expect(freteDe(db).estado).toBe('entregue');
    });

    it('⛔ does not overwrite a terminal estado a human set (cancelado)', async () => {
      // A sem-envio block is NOT marketplace-locked (`externalOptionIntegracao`
      // is null), so the pedido form's Frete tab edits it freely. An operator who
      // cancelled has said something ML's flag does not know, and from
      // `cancelado` the flip would MOVE STOCK.
      const db = new FakeDb();
      seedConta(db);
      seedPedidoComFreteSemEnvio(db, { estado: 'cancelado' });
      const api = makeApi({
        getOrder: vi.fn(async () =>
          makeOrder({
            id: 1,
            tags: ['no_shipping'],
            fulfilled: true,
            lastUpdated: '2026-02-01T00:00:00.000-03:00',
          }),
        ),
      });

      await importPedidoMercadoLivre(deps(db, api), 1);

      expect(freteDe(db).estado).toBe('cancelado');
    });

    it('is idempotent — three identical deliveries produce ONE transition, SILENTLY', async () => {
      // ML sent three `orders_v2` deliveries for the live order, the hot sweep
      // re-drives hour-old payloads and `missed_feeds` replays them again. Three
      // stock movements instead of one would be silent, permanent overselling.
      //
      // ⚠️ The "silently" half is the whole reason the `=== entregue` early
      // return exists SEPARATELY from the terminal latch, which would otherwise
      // subsume it (`entregue` ∈ `ESTADOS_FRETE_TERMINAIS_SEM_ENVIO`). Delete the
      // early return and the state assertions below still pass — measured — but
      // every replay starts warning that it hit a terminal estado. Those two
      // cases mean opposite things: "already done, expected, happens constantly"
      // versus "an operator closed this some other way, look at it". A log that
      // cries wolf on the common path is how the rare one gets ignored.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const db = new FakeDb();
        seedConta(db);
        seedPedidoComFreteSemEnvio(db);
        const api = makeApi({
          getOrder: vi.fn(async () =>
            makeOrder({
              id: 1,
              tags: ['no_shipping'],
              fulfilled: true,
              lastUpdated: '2026-02-01T00:00:00.000-03:00',
            }),
          ),
        });

        await importPedidoMercadoLivre(deps(db, api), 1);
        expect(freteDe(db).estado).toBe('entregue');
        const apósPrimeira = freteDe(db).ultimaModificacao;

        db.clearPatches();
        warn.mockClear();
        await importPedidoMercadoLivre(deps(db, api), 1);
        await importPedidoMercadoLivre(deps(db, api), 1);

        expect(freteDe(db).estado).toBe('entregue');
        // Not merely "still entregue": the block was not rewritten at all, so
        // `onPedidoEstoqueSync` is never even woken by deliveries 2 and 3.
        expect(freteDe(db).ultimaModificacao).toBe(apósPrimeira);
        expect(db.lastPatch('pedidos', 'pedido-1')?.freteInicial).toBeUndefined();
        expect(
          warn.mock.calls.filter((c) => String(c[0]).includes('estado terminal')),
        ).toHaveLength(0);
      } finally {
        warn.mockRestore();
      }
    });

    it('seeds a first-seen already-delivered order straight at entregue', async () => {
      // The backlog shape: an order delivered before this shipped, recovered by a
      // re-import. The seed is create-only, so seeding `iniciado` here would
      // strand it forever — the advance arm can never run on a block this same
      // call just created.
      const db = new FakeDb();
      seedConta(db);
      seedPedidoPronto(db);
      const api = makeApi({
        getOrder: vi.fn(async () => makeOrder({ id: 1, tags: ['no_shipping'], fulfilled: true })),
      });

      await importPedidoMercadoLivre(deps(db, api), 1);

      expect(freteDe(db)).toMatchObject({ estado: 'entregue', modalidade: '1' });
    });
  });
});
