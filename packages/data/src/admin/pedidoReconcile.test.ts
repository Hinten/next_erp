import { describe, expect, it } from 'vitest';
import type { Firestore as FirebaseAdminFirestore } from 'firebase-admin/firestore';
import { STATUS_PAGAMENTO, pagamentoSchema, type Pagamento } from '@delfrance/schemas';

import {
  PedidoReconcileNotFoundError,
  reconcilePedidoEstado,
  reconcilePedidoFromPagamento,
} from './pedidoReconcile';

/* -------------------------------------------------------------------------- */
/*  Fake Admin-SDK Firestore                                                  */
/*                                                                            */
/*  A minimal in-memory `db` with the surface `reconcilePedidoFromPagamento`  */
/*  touches: `collection(path).doc(id?)` (odd-segment collection paths, auto  */
/*  id when omitted) and `runTransaction(fn)` whose `tx` supports `get` on a  */
/*  doc ref (→ DocumentSnapshot) and on a collection ref (→ QuerySnapshot of   */
/*  direct children), plus `set` / `update`. Docs are keyed by full path.     */
/* -------------------------------------------------------------------------- */

interface DocRef {
  __kind: 'doc';
  path: string;
  id: string;
  collection(name: string): CollectionRef;
}
interface CollectionRef {
  __kind: 'collection';
  path: string;
  doc(id?: string): DocRef;
}

interface FakeWrites {
  sets: Array<{ path: string; data: Record<string, unknown> }>;
  updates: Array<{ path: string; data: Record<string, unknown> }>;
}

function makeDb(seed: Record<string, Record<string, unknown>>): {
  db: FirebaseAdminFirestore;
  store: Record<string, Record<string, unknown>>;
  writes: FakeWrites;
} {
  const store: Record<string, Record<string, unknown>> = { ...seed };
  const writes: FakeWrites = { sets: [], updates: [] };
  let autoCounter = 0;

  const docRef = (path: string, id: string): DocRef => ({
    __kind: 'doc',
    path,
    id,
    collection: (name) => collectionRef(`${path}/${name}`),
  });
  const collectionRef = (path: string): CollectionRef => ({
    __kind: 'collection',
    path,
    doc: (id) => {
      const docId = id ?? `auto-${++autoCounter}`;
      return docRef(`${path}/${docId}`, docId);
    },
  });

  const snapshotOf = (id: string, data: Record<string, unknown> | undefined) => ({
    exists: data !== undefined,
    id,
    get: (field: string) => data?.[field],
    data: () => data,
  });

  const tx = {
    get(ref: DocRef | CollectionRef) {
      if (ref.__kind === 'doc') {
        return Promise.resolve(snapshotOf(ref.id, store[ref.path]));
      }
      const prefix = `${ref.path}/`;
      const docs = Object.entries(store)
        .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(([p, data]) => snapshotOf(p.slice(prefix.length), data));
      return Promise.resolve({ docs });
    },
    set(ref: DocRef, data: Record<string, unknown>) {
      store[ref.path] = data;
      writes.sets.push({ path: ref.path, data });
    },
    update(ref: DocRef, data: Record<string, unknown>) {
      store[ref.path] = { ...(store[ref.path] ?? {}), ...data };
      writes.updates.push({ path: ref.path, data });
    },
  };

  const db = {
    collection: (path: string) => collectionRef(path),
    runTransaction: <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  };

  return { db: db as unknown as FirebaseAdminFirestore, store, writes };
}

/** Build a valid `Pagamento` (defaults applied) with the given overrides. */
function mkPagamento(overrides: Partial<Pagamento> & { valor: number }): Pagamento {
  return pagamentoSchema.parse(overrides);
}

const PEDIDO_ID = 'p1';
const PAY_ID = 'pay1';

// Realistic epoch-MICROSECONDS (≥ MICROS_LOWER_BOUND 1e14) so `pagamentoSchema`'s
// `microsSinceEpoch` coercion leaves them unscaled — the seeded (unparsed) store
// values and the parsed incoming values then compare on the same scale.
const T_OLD = 1_700_000_001_000_000;
const T_NEW = 1_700_000_002_000_000;

describe('reconcilePedidoFromPagamento', () => {
  it('full payment → pago, authorizes frete dispatch, and appends a history row', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        freteInicial: { estado: 'iniciado', codRastreio: null },
      },
    });

    const result = await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_NEW,
      }),
    });

    expect(result).toEqual({ transition: 'pago', skippedStale: false });

    // Pedido advanced + frete flipped (from a pre-shipment estado).
    expect(store['pedidos/p1']!.estado).toBe('pago');
    expect(store['pedidos/p1']!.freteInicial).toEqual({
      estado: 'despachoAutorizado',
      codRastreio: null,
    });
    expect(typeof store['pedidos/p1']!.ultimaModificacao).toBe('number');

    // Pagamento persisted at the fixed id.
    expect(store['pedidos/p1/pagamentos/pay1']).toMatchObject({
      valor: 100,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      ultimaModificacao: T_NEW,
    });
    // First-seen dataCadastro stamped on create.
    expect(typeof store['pedidos/p1/pagamentos/pay1']!.dataCadastro).toBe('number');

    // No history row from here — the onPedidoEstadoChanged trigger observes the
    // pedido write above and records the transition.
    const historyWrites = writes.sets.filter((w) => w.path.includes('/historicoEstadoPedido/'));
    expect(historyWrites).toEqual([]);
  });

  it('partial payment → aguardandoConfirmacaoDePagamento, does NOT authorize frete', async () => {
    const { db, store } = makeDb({
      'pedidos/p1': {
        estado: 'iniciado',
        valorCobrado: 100,
        freteInicial: { estado: 'iniciado' },
      },
    });

    const result = await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 40,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_NEW,
      }),
    });

    expect(result).toEqual({
      transition: 'aguardandoConfirmacaoDePagamento',
      skippedStale: false,
    });
    expect(store['pedidos/p1']!.estado).toBe('aguardandoConfirmacaoDePagamento');
    // Frete untouched (not fully paid).
    expect(store['pedidos/p1']!.freteInicial).toEqual({ estado: 'iniciado' });
  });

  it('refund on the only payment downgrades a pago pedido back to aguardando', async () => {
    const { db, store } = makeDb({
      'pedidos/p1': { estado: 'pago', valorCobrado: 100, freteInicial: { estado: 'iniciado' } },
      'pedidos/p1/pagamentos/pay1': {
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_OLD,
      },
    });

    const result = await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.estornado,
        ultimaModificacao: T_NEW,
      }),
    });

    expect(result.transition).toBe('aguardandoConfirmacaoDePagamento');
    expect(result.skippedStale).toBe(false);
    expect(store['pedidos/p1']!.estado).toBe('aguardandoConfirmacaoDePagamento');
    expect(store['pedidos/p1/pagamentos/pay1']!.status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
  });

  it('preserves operator-edited fields on a gateway redelivery, updating only gateway-owned fields', async () => {
    const { db, store } = makeDb({
      'pedidos/p1': {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        freteInicial: { estado: 'iniciado', codRastreio: null },
      },
      // The stored pagamento carries operator edits + first-write / out-of-band
      // fields the webhook mapper never sends.
      'pedidos/p1/pagamentos/pay1': {
        valor: 40,
        status_pagamento: STATUS_PAGAMENTO.pendente,
        ultimaModificacao: T_OLD,
        nFat: 'NF-123',
        vencimento: T_OLD,
        descricaoPagamento: 'combinado com o cliente',
        juros: 5,
        duplicata: true,
        dataCadastro: T_OLD,
        metodoPagamentoOuterRef: 'documents/metodo_pgto/mp1',
      },
    });

    const result = await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      // A newer redelivery: the gateway advances status/valor and would blank
      // the operator fields if the merge weren't inverted.
      pagamento: mkPagamento({
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_NEW,
        descricaoPagamento: null,
        nFat: null,
      }),
    });

    expect(result.transition).toBe('pago');
    const stored = store['pedidos/p1/pagamentos/pay1']!;
    // Gateway-owned fields advanced to the incoming values.
    expect(stored.valor).toBe(100);
    expect(stored.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(stored.ultimaModificacao).toBe(T_NEW);
    // Operator-edited / out-of-band fields survive the redelivery untouched.
    expect(stored.nFat).toBe('NF-123');
    expect(stored.vencimento).toBe(T_OLD);
    expect(stored.descricaoPagamento).toBe('combinado com o cliente');
    expect(stored.juros).toBe(5);
    expect(stored.duplicata).toBe(true);
    expect(stored.dataCadastro).toBe(T_OLD);
    expect(stored.metodoPagamentoOuterRef).toBe('documents/metodo_pgto/mp1');
  });

  it('skips a stale delivery (existing ultimaModificacao newer) without writing', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 100 },
      'pedidos/p1/pagamentos/pay1': {
        valor: 60,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_NEW,
      },
    });

    const result = await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_OLD, // older than the stored 5000
      }),
    });

    expect(result).toEqual({ transition: null, skippedStale: true });
    expect(writes.sets).toHaveLength(0);
    expect(writes.updates).toHaveLength(0);
    // Stored payment untouched.
    expect(store['pedidos/p1/pagamentos/pay1']!.valor).toBe(60);
    expect(store['pedidos/p1']!.estado).toBe('aguardandoConfirmacaoDePagamento');
  });

  it('treats an idempotent redelivery (same id + same ultimaModificacao) as stale', async () => {
    const { db, writes } = makeDb({
      'pedidos/p1': { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 100 },
      'pedidos/p1/pagamentos/pay1': {
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_NEW,
      },
    });

    const result = await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_NEW, // equal → not newer → skip
      }),
    });

    expect(result).toEqual({ transition: null, skippedStale: true });
    expect(writes.sets).toHaveLength(0);
    expect(writes.updates).toHaveLength(0);
  });

  it('writes the pagamento but does NOT transition an estado outside AUTO_ESTADO_SOURCES', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': {
        estado: 'finalizado',
        valorCobrado: 100,
        freteInicial: { estado: 'entregue' },
      },
    });

    const result = await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_NEW,
      }),
    });

    expect(result).toEqual({ transition: null, skippedStale: false });
    // Estado untouched.
    expect(store['pedidos/p1']!.estado).toBe('finalizado');
    // But the pagamento was still upserted.
    expect(store['pedidos/p1/pagamentos/pay1']).toMatchObject({ valor: 100 });
    // No pedido update, no history row.
    expect(writes.updates).toHaveLength(0);
    expect(writes.sets.filter((w) => w.path.includes('/historicoEstadoPedido/'))).toHaveLength(0);
  });

  it('does NOT regress a frete already past despachoAutorizado when it becomes pago', async () => {
    const { db, store } = makeDb({
      'pedidos/p1': {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        freteInicial: { estado: 'postado', codRastreio: 'BR123' },
      },
    });

    const result = await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_NEW,
      }),
    });

    expect(result.transition).toBe('pago');
    expect(store['pedidos/p1']!.estado).toBe('pago');
    // Frete NOT regressed to despachoAutorizado.
    expect(store['pedidos/p1']!.freteInicial).toEqual({ estado: 'postado', codRastreio: 'BR123' });
  });

  it('throws PedidoReconcileNotFoundError when the pedido is missing', async () => {
    const { db, writes } = makeDb({});

    await expect(
      reconcilePedidoFromPagamento(db, {
        pedidoId: PEDIDO_ID,
        pagamentoId: PAY_ID,
        pagamento: mkPagamento({ valor: 100, ultimaModificacao: T_NEW }),
      }),
    ).rejects.toBeInstanceOf(PedidoReconcileNotFoundError);
    expect(writes.sets).toHaveLength(0);
  });
});

describe('reconcilePedidoEstado', () => {
  it('sums approved pagamentos ACROSS multiple existing docs, atomically with the pedido read (#308)', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        freteInicial: { estado: 'iniciado', codRastreio: null },
      },
      'pedidos/p1/pagamentos/pay1': {
        valor: 60,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_OLD,
      },
      'pedidos/p1/pagamentos/pay2': {
        valor: 40,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_NEW,
      },
      // Not paying (pendente) — must NOT count toward valorPago.
      'pedidos/p1/pagamentos/pay3': {
        valor: 1000,
        status_pagamento: STATUS_PAGAMENTO.pendente,
        ultimaModificacao: T_NEW,
      },
    });

    const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

    expect(result).toEqual({ transition: 'pago' });
    expect(store['pedidos/p1']!.estado).toBe('pago');
    expect(store['pedidos/p1']!.freteInicial).toEqual({
      estado: 'despachoAutorizado',
      codRastreio: null,
    });
    // No pagamento doc was touched — this reconcile only reads them.
    expect(writes.sets.filter((w) => w.path.includes('/pagamentos/'))).toHaveLength(0);
    // No history row from here either — the onPedidoEstadoChanged trigger
    // observes the pedido write above and records the transition.
    const historyWrites = writes.sets.filter((w) => w.path.includes('/historicoEstadoPedido/'));
    expect(historyWrites).toEqual([]);
  });

  it('advances to aguardando on a partial payment without touching frete', async () => {
    const { db, store } = makeDb({
      'pedidos/p1': {
        estado: 'iniciado',
        valorCobrado: 100,
        freteInicial: { estado: 'iniciado' },
      },
      'pedidos/p1/pagamentos/pay1': {
        valor: 40,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_OLD,
      },
    });

    const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

    expect(result).toEqual({ transition: 'aguardandoConfirmacaoDePagamento' });
    expect(store['pedidos/p1']!.estado).toBe('aguardandoConfirmacaoDePagamento');
    expect(store['pedidos/p1']!.freteInicial).toEqual({ estado: 'iniciado' });
  });

  it('is a no-op (no write, no história) when no pagamento exists yet', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': { estado: 'iniciado', valorCobrado: 100 },
    });

    const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

    expect(result).toEqual({ transition: null });
    expect(store['pedidos/p1']!.estado).toBe('iniciado');
    expect(writes.updates).toHaveLength(0);
    expect(writes.sets).toHaveLength(0);
  });

  it('never auto-reverts a terminal estado (e.g. finalizado) even if fully paid', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': {
        estado: 'finalizado',
        valorCobrado: 100,
        freteInicial: { estado: 'entregue' },
      },
      'pedidos/p1/pagamentos/pay1': {
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_OLD,
      },
    });

    const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

    expect(result).toEqual({ transition: null });
    expect(store['pedidos/p1']!.estado).toBe('finalizado');
    expect(writes.updates).toHaveLength(0);
    expect(writes.sets).toHaveLength(0);
  });

  it('does NOT regress a frete already past despachoAutorizado when it becomes pago', async () => {
    const { db, store } = makeDb({
      'pedidos/p1': {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        freteInicial: { estado: 'postado', codRastreio: 'BR123' },
      },
      'pedidos/p1/pagamentos/pay1': {
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_OLD,
      },
    });

    const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

    expect(result).toEqual({ transition: 'pago' });
    expect(store['pedidos/p1']!.estado).toBe('pago');
    expect(store['pedidos/p1']!.freteInicial).toEqual({ estado: 'postado', codRastreio: 'BR123' });
  });

  it('throws PedidoReconcileNotFoundError when the pedido is missing', async () => {
    const { db, writes } = makeDb({});

    await expect(reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID })).rejects.toBeInstanceOf(
      PedidoReconcileNotFoundError,
    );
    expect(writes.sets).toHaveLength(0);
    expect(writes.updates).toHaveLength(0);
  });
});
