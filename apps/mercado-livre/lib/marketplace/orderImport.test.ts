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

import { resolveExistingProduto } from './import';
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
import {
  OccEngine,
  deferred,
  type OccOpKind,
  type OccTransaction,
  type OccWriteKind,
} from './testing/occTransaction';
import type { MappedFreteInicialFields } from './orderShipmentMapping';
import {
  TIPO_CLIENTE,
  INTEGRACAO_FRETE,
  ESTADO_FRETE,
  STATUS_PAGAMENTO,
  UF_SIGLA,
} from '@delfrance/schemas';
import type { EnderecoBuildOutcome, EnderecoForcado, FreteDoPedido } from '@delfrance/schemas';
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
// (`./testing/occTransaction`), which replaces the non-isolated stand-in this
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
  vi.mocked(resolveExistingProduto).mockResolvedValue(null);
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
    // `discoverPedidoMercadoLivre` is mocked to report `created: true`, so the
    // doc it claims to have created must exist for the steps that follow to
    // `update` it — the Admin SDK rejects an update of an absent document.
    db.seed('pedidos', 'pedido-1', { estado: 'iniciado', itens: {} });
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
    // See the sibling test above — the mocked discover reports `created: true`,
    // so the pedido doc has to exist for the later steps to update it.
    db.seed('pedidos', 'pedido-1', { estado: 'iniciado', itens: {} });
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

/* ------------------- concurrency: the frete conference race ---------------- */
// Issue #791 test 4. Exercises the shared `OccEngine`'s retry path against
// `applyFreteStep`'s FULL-CONFERENCE branch — the one branch with no in-tx
// staleness re-guard. `mappedFrete` is built OUTSIDE the transaction, so an
// OCC retry re-applies it verbatim: the loser overwrites the winner with an
// OLDER shipment payload and drags `freteInicial.ultimaModificacao` backwards.

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
