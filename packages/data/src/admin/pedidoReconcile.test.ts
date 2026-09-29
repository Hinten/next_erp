import { describe, expect, it } from 'vitest';
import type { Firestore as FirebaseAdminFirestore } from 'firebase-admin/firestore';
import {
  ESTADO_FRETE,
  FORMA_PAGAMENTO,
  INTEGRACAO_TIPO,
  STATUS_PAGAMENTO,
  estadoFreteSchema,
  pagamentoSchema,
  type EstadoFrete,
  type Pagamento,
} from '@delfrance/schemas';

import { pedidoCollection } from './collections';
import {
  PedidoReconcileNotFoundError,
  canalDecideOEstado,
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

/** The two trigger-owned audit trails a pedido write can produce. */
type PedidoTrail = 'historicoEstadoPedido' | 'historicoFtIni';

/**
 * Rows a reconcile wrote into one of the pedido audit trails. BOTH trails are
 * written solely by the `onPedidoChanged` trigger
 * (`apps/functions/src/pedidos/registrarHistoricoPedido.ts`), which observes the
 * pedido write the reconcile makes and derives the rows from the before/after
 * snapshots. No trigger runs against this fake db, so every call below must
 * leave both empty — and an append hand-rolled into `pedidoReconcile.ts` would
 * DOUBLE every row in production, where the trigger does fire on that same write.
 */
function trailWrites(writes: FakeWrites, trail: PedidoTrail) {
  return writes.sets.filter((w) => w.path.includes(`/${trail}/`));
}

/** Build a valid `Pagamento` (defaults applied) with the given overrides. */
function mkPagamento(overrides: Partial<Pagamento> & { valor: number }): Pagamento {
  return pagamentoSchema.parse({
    ...overrides,
    lastProviderUpdate: overrides.lastProviderUpdate ?? overrides.ultimaModificacao ?? T_NEW,
  });
}

const PEDIDO_ID = 'p1';
const PAY_ID = 'pay1';

// Realistic epoch-MICROSECONDS (≥ MICROS_LOWER_BOUND 1e14) so `pagamentoSchema`'s
// `microsSinceEpoch` coercion leaves them unscaled — the seeded (unparsed) store
// values and the parsed incoming values then compare on the same scale.
const T_OLD = 1_700_000_001_000_000;
const T_NEW = 1_700_000_002_000_000;

/**
 * The estados a payment-driven `pago` transition may flip to `despachoAutorizado`
 * (#702). Spelled out as literals instead of imported from
 * `ESTADOS_FRETE_PRE_AUTORIZACAO` — importing the set the reconcile is built on
 * would only assert `Set.has === Set.has`. Written this way, WIDENING the
 * authorizing set (a new enum member added to it, or an old one re-admitted) reds
 * the table below instead of silently letting a payment rewrite one more
 * warehouse estado.
 */
const FLIPPABLE: readonly EstadoFrete[] = [
  ESTADO_FRETE.iniciado,
  ESTADO_FRETE.aguardandoAutorizacao,
  ESTADO_FRETE.aguardandoNFe,
  ESTADO_FRETE.aguardandoValidacaoTransporadora,
];

describe('reconcilePedidoFromPagamento', () => {
  it('full payment → pago, authorizes frete dispatch, and appends NO row to EITHER history trail', async () => {
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

    expect(result).toEqual({ transition: 'pago', skippedStale: false, aprovadosDoLink: null });

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
      lastProviderUpdate: T_NEW,
    });
    expect(store['pedidos/p1/pagamentos/pay1']!.ultimaModificacao).toBeGreaterThanOrEqual(T_NEW);
    // First-seen dataCadastro stamped on create.
    expect(typeof store['pedidos/p1/pagamentos/pay1']!.dataCadastro).toBe('number');

    // No history row from here in EITHER trail — the onPedidoChanged
    // trigger observes the pedido write above and records both the estado
    // transition and the freteInicial one. This is precisely the case where a
    // hand-rolled frete append would be tempting: the reconcile DID flip
    // `freteInicial` to `despachoAutorizado` a few lines up, and writing the row
    // here would duplicate the one the trigger already derives from that write.
    expect(trailWrites(writes, 'historicoEstadoPedido')).toEqual([]);
    expect(trailWrites(writes, 'historicoFtIni')).toEqual([]);
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
      aprovadosDoLink: null,
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
    expect(stored.ultimaModificacao).toBeGreaterThanOrEqual(T_NEW);
    expect(stored.lastProviderUpdate).toBe(T_NEW);
    // Operator-edited / out-of-band fields survive the redelivery untouched.
    expect(stored.nFat).toBe('NF-123');
    expect(stored.vencimento).toBe(T_OLD);
    expect(stored.descricaoPagamento).toBe('combinado com o cliente');
    expect(stored.juros).toBe(5);
    expect(stored.duplicata).toBe(true);
    expect(stored.dataCadastro).toBe(T_OLD);
    expect(stored.metodoPagamentoOuterRef).toBe('documents/metodo_pgto/mp1');
  });

  it('merges a gateway redelivery onto a legacy stored pagamento carrying an unmodeled key (#463)', async () => {
    // `pagamentoSchema` dropped `.passthrough()` in #463: the merge below used
    // to spread the raw stored doc straight into the strict write parse, so an
    // unmodeled legacy key would throw `ZodError: unrecognized_keys` instead of
    // being silently stripped as the read-tolerance contract requires (root
    // `CLAUDE.md` rule 8).
    const { db, store } = makeDb({
      'pedidos/p1': {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        freteInicial: { estado: 'iniciado', codRastreio: null },
      },
      'pedidos/p1/pagamentos/pay1': {
        valor: 40,
        status_pagamento: STATUS_PAGAMENTO.pendente,
        ultimaModificacao: T_OLD,
        someRetiredLegacyField: 'whatever',
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
    const stored = store['pedidos/p1/pagamentos/pay1']!;
    expect(stored.valor).toBe(100);
    expect(stored.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    // The unmodeled key is stripped on the way through, not re-written.
    expect(stored).not.toHaveProperty('someRetiredLegacyField');
  });

  it('skips a stale delivery (existing lastProviderUpdate newer) without writing', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 100 },
      'pedidos/p1/pagamentos/pay1': {
        valor: 60,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_NEW,
        lastProviderUpdate: T_NEW,
      },
    });

    const result = await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_NEW + 1_000_000, // local recency is deliberately irrelevant
        lastProviderUpdate: T_OLD,
      }),
    });

    expect(result).toEqual({ transition: null, skippedStale: true, aprovadosDoLink: null });
    expect(writes.sets).toHaveLength(0);
    expect(writes.updates).toHaveLength(0);
    // Stored payment untouched.
    expect(store['pedidos/p1/pagamentos/pay1']!.valor).toBe(60);
    expect(store['pedidos/p1']!.estado).toBe('aguardandoConfirmacaoDePagamento');
  });

  it('treats an idempotent redelivery (same provider watermark) as stale', async () => {
    const { db, writes } = makeDb({
      'pedidos/p1': { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 100 },
      'pedidos/p1/pagamentos/pay1': {
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_NEW,
        lastProviderUpdate: T_NEW,
      },
    });

    const result = await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_NEW + 1_000_000,
        lastProviderUpdate: T_NEW, // equal → not newer → skip
      }),
    });

    expect(result).toEqual({ transition: null, skippedStale: true, aprovadosDoLink: null });
    expect(writes.sets).toHaveLength(0);
    expect(writes.updates).toHaveLength(0);
  });

  it('a future human ultimaModificacao neither blocks the provider nor regresses', async () => {
    const humanFuture = 2_000_000_000_000_000;
    const { db, store } = makeDb({
      'pedidos/p1': { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 100 },
      'pedidos/p1/pagamentos/pay1': {
        valor: 40,
        status_pagamento: STATUS_PAGAMENTO.pendente,
        ultimaModificacao: humanFuture,
        lastProviderUpdate: T_OLD,
      },
    });

    const result = await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_NEW,
        lastProviderUpdate: T_NEW,
      }),
    });

    expect(result.skippedStale).toBe(false);
    expect(store['pedidos/p1/pagamentos/pay1']).toMatchObject({
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      lastProviderUpdate: T_NEW,
      ultimaModificacao: humanFuture,
    });
  });

  it('initializes a missing provider watermark without inferring one from local recency', async () => {
    const humanFuture = 2_000_000_000_000_000;
    const { db, store } = makeDb({
      'pedidos/p1': { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 100 },
      'pedidos/p1/pagamentos/pay1': {
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: humanFuture,
      },
    });

    const result = await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 40,
        status_pagamento: STATUS_PAGAMENTO.pendente,
        ultimaModificacao: T_OLD,
        lastProviderUpdate: T_OLD,
      }),
    });

    expect(result.skippedStale).toBe(false);
    expect(store['pedidos/p1/pagamentos/pay1']).toMatchObject({
      valor: 40,
      status_pagamento: STATUS_PAGAMENTO.pendente,
      lastProviderUpdate: T_OLD,
      ultimaModificacao: humanFuture,
    });
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

    expect(result).toEqual({ transition: null, skippedStale: false, aprovadosDoLink: null });
    // Estado untouched.
    expect(store['pedidos/p1']!.estado).toBe('finalizado');
    // But the pagamento was still upserted.
    expect(store['pedidos/p1/pagamentos/pay1']).toMatchObject({ valor: 100 });
    // No pedido update at all, so neither trigger-owned trail has anything to
    // record — and the reconcile itself appends to neither.
    expect(writes.updates).toHaveLength(0);
    expect(trailWrites(writes, 'historicoEstadoPedido')).toEqual([]);
    expect(trailWrites(writes, 'historicoFtIni')).toEqual([]);
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

  // The #702 guard lives in the shared `applyEstadoTransition`, but the two entry
  // points reach it by different routes — this one writes the pagamento FIRST —
  // so both are covered.
  it('does not un-pack an empacotado frete when a webhook payment pays the pedido in full (#702)', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        freteInicial: { estado: 'empacotado', codRastreio: null },
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

    expect(result).toEqual({ transition: 'pago', skippedStale: false, aprovadosDoLink: null });
    expect(store['pedidos/p1']!.estado).toBe('pago');
    const pedidoUpdates = writes.updates.filter((w) => w.path === 'pedidos/p1');
    expect(pedidoUpdates).toHaveLength(1);
    expect(pedidoUpdates[0]!.data).not.toHaveProperty('freteInicial');
  });

  it('does not authorize dispatch on a marketplace-owned frete block (#702)', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        freteInicial: {
          estado: 'iniciado',
          externalOptionIntegracao: 'mercadoLivre',
          codRastreio: null,
        },
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

    expect(result).toEqual({ transition: 'pago', skippedStale: false, aprovadosDoLink: null });
    expect(store['pedidos/p1']!.estado).toBe('pago');
    const pedidoUpdates = writes.updates.filter((w) => w.path === 'pedidos/p1');
    expect(pedidoUpdates).toHaveLength(1);
    expect(pedidoUpdates[0]!.data).not.toHaveProperty('freteInicial');
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

/* -------------------------------------------------------------------------- */
/*  Payment-link attribution (#367)                                           */
/*                                                                            */
/*  `linkPagamentoId` / `primeiroNomePagador` are server-stamped by the       */
/*  Mercado Pago mapper. Unlike the GATEWAY_OWNED keys (overlaid from every   */
/*  delivery) they are FILL-ONCE: the first delivery that carries a value     */
/*  fixes it, and no later delivery — poorer, different or empty — may        */
/*  overwrite or clear it.                                                    */
/* -------------------------------------------------------------------------- */

/** Two DISTINCT link ids in the `newDocId()` shape (20 chars, `[A-Za-z0-9]`) the schema requires. */
const LINK_A = 'AbCdEfGhIjKlMnOpQrSt';
const LINK_B = 'ZyXwVuTsRqPoNmLkJiHg';
const PAG_PATH = 'pedidos/p1/pagamentos/pay1';

type ChaveAtribuicao = 'linkPagamentoId' | 'primeiroNomePagador';

/** One attribution key of a `Pagamento`, built without a computed key so the literal stays type-checked. */
function atribuicao(key: ChaveAtribuicao, value: string | null): Partial<Pagamento> {
  return key === 'linkPagamentoId' ? { linkPagamentoId: value } : { primeiroNomePagador: value };
}

/** [key, a value ALREADY stored, a DIFFERENT value a later delivery carries]. */
const ATRIBUICOES: Array<[ChaveAtribuicao, string, string]> = [
  ['linkPagamentoId', LINK_A, LINK_B],
  ['primeiroNomePagador', 'Maria', 'Joana'],
];

/** A pedido awaiting payment plus a stored pagamento at the OLD provider watermark. */
const pedidoComPagamentoGravado = (guardado: Record<string, unknown>) => ({
  'pedidos/p1': { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 100 },
  [PAG_PATH]: {
    valor: 40,
    status_pagamento: STATUS_PAGAMENTO.pendente,
    ultimaModificacao: T_OLD,
    lastProviderUpdate: T_OLD,
    ...guardado,
  },
});

/** A NEWER delivery (it wins the update-if-newer guard) that pays the pedido in full. */
const entregaMaisNova = (extra: Partial<Pagamento> = {}): Pagamento =>
  mkPagamento({
    valor: 100,
    status_pagamento: STATUS_PAGAMENTO.aprovado,
    ultimaModificacao: T_NEW,
    lastProviderUpdate: T_NEW,
    ...extra,
  });

describe('reconcilePedidoFromPagamento — payment-link attribution is fill-once (#367)', () => {
  describe('UPDATE of a stored pagamento', () => {
    it.each(ATRIBUICOES)(
      '%s: a stored value survives a NEWER delivery that carries a different one',
      async (key, guardado, outro) => {
        const { db, store } = makeDb(pedidoComPagamentoGravado({ [key]: guardado }));

        const result = await reconcilePedidoFromPagamento(db, {
          pedidoId: PEDIDO_ID,
          pagamentoId: PAY_ID,
          pagamento: entregaMaisNova({ ...atribuicao(key, outro), dataAprovacao: T_NEW }),
        });

        // The delivery WAS applied — so what follows is the overlay's decision, not a stale skip…
        // (`aprovadosDoLink` counts the link the doc is attributed to AFTER the
        // write: this delivery is APPROVED and names LINK_B, yet the stored LINK_A
        // is not re-attributed, so LINK_B still has no approved payment.)
        expect(result).toEqual({
          transition: 'pago',
          skippedStale: false,
          aprovadosDoLink: key === 'linkPagamentoId' ? 0 : null,
        });
        expect(store[PAG_PATH]).toMatchObject({
          valor: 100,
          status_pagamento: STATUS_PAGAMENTO.aprovado,
          lastProviderUpdate: T_NEW,
        });
        // …and the first observation still stands (a plain GATEWAY_OWNED overlay would hold `outro`).
        expect(store[PAG_PATH]![key]).toBe(guardado);
      },
    );

    it.each(ATRIBUICOES)(
      '%s: a doc that never had the key is filled by the first delivery that carries it',
      async (key, _guardado, valor) => {
        const { db, store } = makeDb(pedidoComPagamentoGravado({}));

        await reconcilePedidoFromPagamento(db, {
          pedidoId: PEDIDO_ID,
          pagamentoId: PAY_ID,
          pagamento: entregaMaisNova(atribuicao(key, valor)),
        });

        expect(store[PAG_PATH]![key]).toBe(valor);
      },
    );

    it.each(ATRIBUICOES)(
      '%s: an explicit stored null counts as empty (NEAR-MISS for an `=== undefined` check)',
      async (key, _guardado, valor) => {
        const { db, store } = makeDb(pedidoComPagamentoGravado({ [key]: null }));

        await reconcilePedidoFromPagamento(db, {
          pedidoId: PEDIDO_ID,
          pagamentoId: PAY_ID,
          pagamento: entregaMaisNova(atribuicao(key, valor)),
        });

        expect(store[PAG_PATH]![key]).toBe(valor);
      },
    );

    it.each(ATRIBUICOES)(
      '%s: a newer delivery WITHOUT the key does not clear the stored one',
      async (key, guardado) => {
        const { db, store } = makeDb(pedidoComPagamentoGravado({ [key]: guardado }));

        const result = await reconcilePedidoFromPagamento(db, {
          pedidoId: PEDIDO_ID,
          pagamentoId: PAY_ID,
          pagamento: entregaMaisNova(),
        });

        expect(result.skippedStale).toBe(false);
        expect(store[PAG_PATH]![key]).toBe(guardado);
      },
    );

    it.each(ATRIBUICOES)(
      '%s: an explicit null on a newer delivery does not clear the stored one either',
      async (key, guardado) => {
        const { db, store } = makeDb(pedidoComPagamentoGravado({ [key]: guardado }));

        await reconcilePedidoFromPagamento(db, {
          pedidoId: PEDIDO_ID,
          pagamentoId: PAY_ID,
          pagamento: entregaMaisNova(atribuicao(key, null)),
        });

        expect(store[PAG_PATH]![key]).toBe(guardado);
      },
    );

    it('decides the two keys independently — a stored link id does not freeze an empty first name', async () => {
      const { db, store } = makeDb(pedidoComPagamentoGravado({ linkPagamentoId: LINK_A }));

      await reconcilePedidoFromPagamento(db, {
        pedidoId: PEDIDO_ID,
        pagamentoId: PAY_ID,
        pagamento: entregaMaisNova({ linkPagamentoId: LINK_B, primeiroNomePagador: 'Joana' }),
      });

      expect(store[PAG_PATH]).toMatchObject({
        linkPagamentoId: LINK_A,
        primeiroNomePagador: 'Joana',
      });
    });

    it('…and a stored first name does not freeze an empty link id', async () => {
      const { db, store } = makeDb(pedidoComPagamentoGravado({ primeiroNomePagador: 'Maria' }));

      await reconcilePedidoFromPagamento(db, {
        pedidoId: PEDIDO_ID,
        pagamentoId: PAY_ID,
        pagamento: entregaMaisNova({ linkPagamentoId: LINK_B, primeiroNomePagador: 'Joana' }),
      });

      expect(store[PAG_PATH]).toMatchObject({
        linkPagamentoId: LINK_B,
        primeiroNomePagador: 'Maria',
      });
    });

    it('NEAR-MISS: a STALE delivery carrying an attribution fills nothing and writes nothing', async () => {
      // Same watermark as the stored doc → the update-if-newer guard drops the
      // delivery whole, attribution included; the next fresh event fills it.
      const { db, store, writes } = makeDb(pedidoComPagamentoGravado({}));

      const result = await reconcilePedidoFromPagamento(db, {
        pedidoId: PEDIDO_ID,
        pagamentoId: PAY_ID,
        pagamento: entregaMaisNova({
          lastProviderUpdate: T_OLD,
          linkPagamentoId: LINK_A,
          primeiroNomePagador: 'Maria',
        }),
      });

      // (the stored row was never approved, so LINK_A's count is 0, not null)
      expect(result).toEqual({ transition: null, skippedStale: true, aprovadosDoLink: 0 });
      expect(writes.sets).toHaveLength(0);
      expect(writes.updates).toHaveLength(0);
      expect(store[PAG_PATH]).not.toHaveProperty('linkPagamentoId');
      expect(store[PAG_PATH]).not.toHaveProperty('primeiroNomePagador');
    });

    it('still overlays the GATEWAY_OWNED fields while it keeps the attribution', async () => {
      // The fill-once loop is a SIBLING of the gateway overlay, not a replacement.
      const { db, store } = makeDb(
        pedidoComPagamentoGravado({ linkPagamentoId: LINK_A, primeiroNomePagador: 'Maria' }),
      );

      const result = await reconcilePedidoFromPagamento(db, {
        pedidoId: PEDIDO_ID,
        pagamentoId: PAY_ID,
        pagamento: entregaMaisNova({ linkPagamentoId: LINK_B, primeiroNomePagador: 'Joana' }),
      });

      expect(result.transition).toBe('pago');
      expect(store[PAG_PATH]).toMatchObject({
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        lastProviderUpdate: T_NEW,
        linkPagamentoId: LINK_A,
        primeiroNomePagador: 'Maria',
      });
    });
  });

  describe('CREATE of a new pagamento', () => {
    /** A fresh seed per test: the fake store is seeded by reference. */
    const pedidoAguardando = () => ({
      'pedidos/p1': { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 100 },
    });

    it('persists the attribution the mapper derived', async () => {
      const { db, store } = makeDb(pedidoAguardando());

      await reconcilePedidoFromPagamento(db, {
        pedidoId: PEDIDO_ID,
        pagamentoId: PAY_ID,
        pagamento: entregaMaisNova({ linkPagamentoId: LINK_A, primeiroNomePagador: 'Maria' }),
      });

      expect(store[PAG_PATH]).toMatchObject({
        linkPagamentoId: LINK_A,
        primeiroNomePagador: 'Maria',
      });
    });

    it.each(ATRIBUICOES)(
      '%s: a delivery without it writes a doc with NO such key (not null, not undefined)',
      async (key) => {
        const { db, store } = makeDb(pedidoAguardando());

        await reconcilePedidoFromPagamento(db, {
          pedidoId: PEDIDO_ID,
          pagamentoId: PAY_ID,
          pagamento: entregaMaisNova(),
        });

        // `in`, not `=== undefined`: an `undefined` value would be rejected by the Admin
        // SDK and a `null` would show up as a spurious change in the modification history.
        expect(key in store[PAG_PATH]!).toBe(false);
      },
    );

    it.each(ATRIBUICOES)(
      '%s: a delivery carrying only this key does not invent the other',
      async (key, _guardado, valor) => {
        const { db, store } = makeDb(pedidoAguardando());
        const outra: ChaveAtribuicao =
          key === 'linkPagamentoId' ? 'primeiroNomePagador' : 'linkPagamentoId';

        await reconcilePedidoFromPagamento(db, {
          pedidoId: PEDIDO_ID,
          pagamentoId: PAY_ID,
          pagamento: entregaMaisNova(atribuicao(key, valor)),
        });

        expect(store[PAG_PATH]![key]).toBe(valor);
        expect(outra in store[PAG_PATH]!).toBe(false);
      },
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  `aprovadosDoLink` — how many payments a link has been paid by (#367)       */
/*                                                                            */
/*  The webhook closes a payment link once its quota is spent, and the count   */
/*  it closes on comes out of THIS transaction's pagamento read: the docs      */
/*  attributed to the incoming payment's link with `dataAprovacao != null`.    */
/*  It is returned from BOTH exits — the write, where the target doc counts    */
/*  as written, and the stale skip, where a crashed close is finished from.    */
/* -------------------------------------------------------------------------- */

describe('reconcilePedidoFromPagamento — aprovadosDoLink, the link quota count (#367)', () => {
  const OUTRO = 'pedidos/p1/pagamentos/outro1';
  const OUTRO_2 = 'pedidos/p1/pagamentos/outro2';
  const LEGADO = 'pedidos/p1/pagamentos/legAuto1';
  const CONTA = 'documents/metodo_pgto/m1';
  /** Big enough that no payment below settles it — the estado never moves under the count. */
  const PEDIDO_ABERTO = { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 1000 };

  /** A stored pagamento, at the OLD provider watermark, approved at T_OLD unless overridden. */
  const gravado = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    valor: 100,
    status_pagamento: STATUS_PAGAMENTO.aprovado,
    dataAprovacao: T_OLD,
    ultimaModificacao: T_OLD,
    lastProviderUpdate: T_OLD,
    ...over,
  });
  /** A stored row that was never approved (pending, no approval stamp). */
  const naoAprovado = (over: Record<string, unknown> = {}) =>
    gravado({ status_pagamento: STATUS_PAGAMENTO.pendente, dataAprovacao: null, ...over });

  /** A NEWER delivery that is approved (it stamps `dataAprovacao`, like the mapper). */
  const aprovada = (extra: Partial<Pagamento> = {}): Pagamento =>
    entregaMaisNova({ dataAprovacao: T_NEW, ...extra });
  /** A delivery at the SAME watermark as the stored docs → the stale skip. */
  const obsoleta = (extra: Partial<Pagamento> = {}): Pagamento =>
    entregaMaisNova({ lastProviderUpdate: T_OLD, dataAprovacao: T_NEW, ...extra });

  const reconciliar = async (
    seed: Record<string, Record<string, unknown>>,
    pagamento: Pagamento,
  ) => {
    const fake = makeDb(seed);
    const result = await reconcilePedidoFromPagamento(fake.db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento,
    });
    return { result, ...fake };
  };

  describe('WRITE exit — the target doc counts as it was written', () => {
    it('counts the payment this very delivery approves (CREATE, nothing else stored)', async () => {
      const { result } = await reconciliar(
        { 'pedidos/p1': PEDIDO_ABERTO },
        aprovada({ linkPagamentoId: LINK_A }),
      );

      expect(result).toEqual({ transition: null, skippedStale: false, aprovadosDoLink: 1 });
    });

    it('adds the payments the link was already approved for (a shared link paid N times)', async () => {
      const { result } = await reconciliar(
        {
          'pedidos/p1': PEDIDO_ABERTO,
          [OUTRO]: gravado({ linkPagamentoId: LINK_A }),
          [OUTRO_2]: gravado({ linkPagamentoId: LINK_A }),
        },
        aprovada({ linkPagamentoId: LINK_A }),
      );

      expect(result.aprovadosDoLink).toBe(3);
    });

    it('NEAR-MISS: a row of the link that was never approved is not a payment', async () => {
      const { result } = await reconciliar(
        {
          'pedidos/p1': PEDIDO_ABERTO,
          [OUTRO]: naoAprovado({ linkPagamentoId: LINK_A }),
        },
        aprovada({ linkPagamentoId: LINK_A }),
      );

      expect(result.aprovadosDoLink).toBe(1);
    });

    it('NEAR-MISS: rows attributed to ANOTHER link, or to none, are not counted', async () => {
      const { result } = await reconciliar(
        {
          'pedidos/p1': PEDIDO_ABERTO,
          [OUTRO]: gravado({ linkPagamentoId: LINK_B }),
          [OUTRO_2]: gravado(),
        },
        aprovada({ linkPagamentoId: LINK_A }),
      );

      expect(result.aprovadosDoLink).toBe(1);
    });

    it('NEAR-MISS: the incoming payment counts only once it is approved', async () => {
      const semAprovacao = entregaMaisNova({
        linkPagamentoId: LINK_A,
        status_pagamento: STATUS_PAGAMENTO.pendente,
      });

      const sozinha = await reconciliar({ 'pedidos/p1': PEDIDO_ABERTO }, semAprovacao);
      expect(sozinha.result.aprovadosDoLink).toBe(0);

      const aoLadoDeUmaAprovada = await reconciliar(
        { 'pedidos/p1': PEDIDO_ABERTO, [OUTRO]: gravado({ linkPagamentoId: LINK_A }) },
        semAprovacao,
      );
      expect(aoLadoDeUmaAprovada.result.aprovadosDoLink).toBe(1);
    });

    it('the target is REPLACED, not added: a redelivery of a counted payment counts once', async () => {
      const { result } = await reconciliar(
        { 'pedidos/p1': PEDIDO_ABERTO, [PAG_PATH]: gravado({ linkPagamentoId: LINK_A }) },
        aprovada({ linkPagamentoId: LINK_A }),
      );

      expect(result).toMatchObject({ skippedStale: false, aprovadosDoLink: 1 });
    });

    it('counts the values WRITTEN: an overlay that clears the approval stamp drops the payment', async () => {
      // `dataAprovacao` is GATEWAY_OWNED, so a newer delivery carrying null overlays
      // the stored stamp — and the count must follow what landed, not what was there.
      const { result, store } = await reconciliar(
        { 'pedidos/p1': PEDIDO_ABERTO, [PAG_PATH]: gravado({ linkPagamentoId: LINK_A }) },
        entregaMaisNova({ linkPagamentoId: LINK_A }),
      );

      expect(store[PAG_PATH]!.dataAprovacao).toBeNull();
      expect(result.aprovadosDoLink).toBe(0);
    });

    it('a refund delivery that keeps the approval stamp still counts (ever approved, not paying now)', async () => {
      const { result, store } = await reconciliar(
        { 'pedidos/p1': PEDIDO_ABERTO, [PAG_PATH]: gravado({ linkPagamentoId: LINK_A }) },
        aprovada({ linkPagamentoId: LINK_A, status_pagamento: STATUS_PAGAMENTO.estornado }),
      );

      expect(store[PAG_PATH]!.status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
      expect(result.aprovadosDoLink).toBe(1);
    });

    it('fill-once decides the attribution: a target stored under ANOTHER link is not moved', async () => {
      const { result, store } = await reconciliar(
        {
          'pedidos/p1': PEDIDO_ABERTO,
          [PAG_PATH]: gravado({ linkPagamentoId: LINK_B }),
          [OUTRO]: gravado({ linkPagamentoId: LINK_A }),
        },
        aprovada({ linkPagamentoId: LINK_A }),
      );

      // The delivery names LINK_A, but the doc it updated stays LINK_B's.
      expect(store[PAG_PATH]!.linkPagamentoId).toBe(LINK_B);
      expect(result.aprovadosDoLink).toBe(1);
    });

    it('fill-once decides the attribution: an UNattributed target is filled by this delivery and counts', async () => {
      const { result, store } = await reconciliar(
        { 'pedidos/p1': PEDIDO_ABERTO, [PAG_PATH]: gravado() },
        aprovada({ linkPagamentoId: LINK_A }),
      );

      expect(store[PAG_PATH]!.linkPagamentoId).toBe(LINK_A);
      expect(result.aprovadosDoLink).toBe(1);
    });

    it('a legacy auto-id doc is the target: replaced by the write, never counted beside a new doc', async () => {
      // The doc already carries the link (an earlier in-place update filled it), so
      // counting it in its stored form AND as written would make 2.
      const { result, store } = await reconciliar(
        {
          'pedidos/p1': PEDIDO_ABERTO,
          [LEGADO]: gravado({
            id: PAY_ID,
            metodoPagamentoOuterRef: CONTA,
            valor: 60,
            linkPagamentoId: LINK_A,
          }),
        },
        aprovada({ linkPagamentoId: LINK_A, metodoPagamentoOuterRef: CONTA }),
      );

      expect(store['pedidos/p1/pagamentos/pay1']).toBeUndefined();
      expect(store[LEGADO]!.linkPagamentoId).toBe(LINK_A);
      expect(result.aprovadosDoLink).toBe(1);
    });

    it('is null when the incoming payment carries no link — whatever the stored rows say', async () => {
      const { result } = await reconciliar(
        { 'pedidos/p1': PEDIDO_ABERTO, [OUTRO]: gravado({ linkPagamentoId: LINK_A }) },
        aprovada(),
      );

      expect(result).toEqual({ transition: null, skippedStale: false, aprovadosDoLink: null });
    });

    it('writes nothing but the pagamento (the count is a return value, not a write)', async () => {
      const { writes } = await reconciliar(
        { 'pedidos/p1': PEDIDO_ABERTO, [OUTRO]: gravado({ linkPagamentoId: LINK_A }) },
        aprovada({ linkPagamentoId: LINK_A }),
      );

      expect(writes.sets.map((w) => w.path)).toEqual([PAG_PATH]);
    });
  });

  describe('STALE exit — counted from the stored docs, nothing written', () => {
    it('a redelivery of an approved payment still reports the count (a crashed close can be finished)', async () => {
      const { result, writes } = await reconciliar(
        { 'pedidos/p1': PEDIDO_ABERTO, [PAG_PATH]: gravado({ linkPagamentoId: LINK_A }) },
        obsoleta({ linkPagamentoId: LINK_A }),
      );

      expect(result).toEqual({ transition: null, skippedStale: true, aprovadosDoLink: 1 });
      expect(writes.sets).toHaveLength(0);
      expect(writes.updates).toHaveLength(0);
    });

    it('counts the link’s other approved rows beside the target', async () => {
      const { result } = await reconciliar(
        {
          'pedidos/p1': PEDIDO_ABERTO,
          [PAG_PATH]: gravado({ linkPagamentoId: LINK_A }),
          [OUTRO]: gravado({ linkPagamentoId: LINK_A }),
          [OUTRO_2]: naoAprovado({ linkPagamentoId: LINK_A }),
        },
        obsoleta({ linkPagamentoId: LINK_A }),
      );

      expect(result.aprovadosDoLink).toBe(2);
    });

    it('a target with NO stored attribution is read as the incoming link’s — and nothing is filled', async () => {
      const { result, store } = await reconciliar(
        { 'pedidos/p1': PEDIDO_ABERTO, [PAG_PATH]: gravado() },
        obsoleta({ linkPagamentoId: LINK_A }),
      );

      expect(result.aprovadosDoLink).toBe(1);
      expect(store[PAG_PATH]).not.toHaveProperty('linkPagamentoId');
    });

    it('NEAR-MISS: only the TARGET gets that reading — another unattributed row is not counted', async () => {
      const { result } = await reconciliar(
        { 'pedidos/p1': PEDIDO_ABERTO, [PAG_PATH]: gravado(), [OUTRO]: gravado() },
        obsoleta({ linkPagamentoId: LINK_A }),
      );

      expect(result.aprovadosDoLink).toBe(1);
    });

    it('NEAR-MISS: a target stored under ANOTHER link is not moved to the incoming one', async () => {
      const { result } = await reconciliar(
        { 'pedidos/p1': PEDIDO_ABERTO, [PAG_PATH]: gravado({ linkPagamentoId: LINK_B }) },
        obsoleta({ linkPagamentoId: LINK_A }),
      );

      expect(result.aprovadosDoLink).toBe(0);
    });

    it('NEAR-MISS: a target that was never approved does not count, attributed or not', async () => {
      const semLink = await reconciliar(
        { 'pedidos/p1': PEDIDO_ABERTO, [PAG_PATH]: naoAprovado() },
        obsoleta({ linkPagamentoId: LINK_A }),
      );
      const comLink = await reconciliar(
        { 'pedidos/p1': PEDIDO_ABERTO, [PAG_PATH]: naoAprovado({ linkPagamentoId: LINK_A }) },
        obsoleta({ linkPagamentoId: LINK_A }),
      );

      expect(semLink.result.aprovadosDoLink).toBe(0);
      expect(comLink.result.aprovadosDoLink).toBe(0);
    });

    it('a legacy auto-id target counts once, as the incoming link’s', async () => {
      const { result } = await reconciliar(
        {
          'pedidos/p1': PEDIDO_ABERTO,
          [LEGADO]: gravado({ id: PAY_ID, metodoPagamentoOuterRef: CONTA, valor: 60 }),
        },
        obsoleta({ linkPagamentoId: LINK_A, metodoPagamentoOuterRef: CONTA }),
      );

      expect(result).toMatchObject({ skippedStale: true, aprovadosDoLink: 1 });
    });

    it('is null when the stale delivery carries no link', async () => {
      const { result } = await reconciliar(
        { 'pedidos/p1': PEDIDO_ABERTO, [PAG_PATH]: gravado({ linkPagamentoId: LINK_A }) },
        obsoleta(),
      );

      expect(result).toEqual({ transition: null, skippedStale: true, aprovadosDoLink: null });
    });
  });
});

describe('canalDecideOEstado — exported for the payment-link route (#367)', () => {
  const REF_INT1 = 'documents/integracao/int1';

  /**
   * Runs the gate exactly as a caller does: inside ITS OWN transaction, on ITS OWN
   * pedido read. `ref` is the pedido's `integracaoPedidoOuterRef` (key omitted when
   * `undefined`); `integracao` is the doc that ref points at (not seeded when `null`).
   */
  const decide = (
    ref: unknown,
    integracao: Record<string, unknown> | null = null,
  ): Promise<boolean> => {
    const { db } = makeDb({
      'pedidos/p1': {
        estado: 'carrinho',
        valorCobrado: 10,
        ...(ref === undefined ? {} : { integracaoPedidoOuterRef: ref }),
      },
      ...(integracao === null ? {} : { 'integracao/int1': integracao }),
    });
    return db.runTransaction(async (tx) =>
      canalDecideOEstado(tx, db, await tx.get(pedidoCollection.docRef(db, {}, PEDIDO_ID))),
    );
  };

  it.each([
    ['mercadoLivre', INTEGRACAO_TIPO.mercadoLivre],
    ['shopee', INTEGRACAO_TIPO.shopee],
    ['magalu', INTEGRACAO_TIPO.magalu],
    ['amazon', INTEGRACAO_TIPO.amazon],
  ])('the %s channel decides the estado', async (_canal, tipo) => {
    await expect(decide(REF_INT1, { tipo })).resolves.toBe(true);
  });

  it.each([
    ['nenhuma', INTEGRACAO_TIPO.nenhuma],
    ['whatsapp', INTEGRACAO_TIPO.whatsapp],
    ['balcao', INTEGRACAO_TIPO.balcao],
  ])('NEAR-MISS: the %s channel does not', async (_canal, tipo) => {
    await expect(decide(REF_INT1, { tipo })).resolves.toBe(false);
  });

  it('a pedido with no integração at all was never written by a marketplace importer', async () => {
    await expect(decide(undefined)).resolves.toBe(false);
  });

  it('a ref that is not a string reads as no integração (not as a marketplace)', async () => {
    await expect(decide(123)).resolves.toBe(false);
  });

  it.each([
    ['the integração no longer exists', null],
    ['its tipo is outside the enum', { tipo: 99 }],
    ['its tipo is missing', {}],
  ])('fails CLOSED when %s', async (_caso, integracao) => {
    // A ref that is SET but cannot be resolved is not the same as "no integração":
    // the sibling test above answers false for that, this one answers true.
    await expect(decide(REF_INT1, integracao)).resolves.toBe(true);
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
    // No row in either trail from here either — the onPedidoChanged
    // trigger observes the pedido write above and records both the estado
    // transition and the freteInicial flip that rides along with it.
    expect(trailWrites(writes, 'historicoEstadoPedido')).toEqual([]);
    expect(trailWrites(writes, 'historicoFtIni')).toEqual([]);
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

  describe('aposAlterarTotal — the reconcile after a total change (#703)', () => {
    const pagoPela = (valor: number) => ({
      'pedidos/p1/pagamentos/pay1': {
        valor,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_OLD,
      },
    });

    it('settles a carrinho pedido whose new total the payments now cover', async () => {
      const { db, store } = makeDb({
        'pedidos/p1': { estado: 'carrinho', valorCobrado: 10 },
        ...pagoPela(10),
      });

      const result = await reconcilePedidoEstado(db, {
        pedidoId: PEDIDO_ID,
        aposAlterarTotal: true,
      });

      expect(result).toEqual({ transition: 'pago' });
      expect(store['pedidos/p1']!.estado).toBe('pago');
    });

    it('⚠️ leaves a pedido the ML import promoted to emProcessamento untouched', async () => {
      // #703 blocker 1: a partial payment would move it to aguardando, after
      // which ML's advance guards (keyed on the `emProcessamento` literal) can
      // never move it to `pago`. The gate reads the estado from THIS transaction.
      const { db, store, writes } = makeDb({
        'pedidos/p1': { estado: 'emProcessamento', valorCobrado: 100 },
        ...pagoPela(40),
      });

      const result = await reconcilePedidoEstado(db, {
        pedidoId: PEDIDO_ID,
        aposAlterarTotal: true,
      });

      expect(result).toEqual({ transition: null });
      expect(store['pedidos/p1']!.estado).toBe('emProcessamento');
      expect(writes.updates).toHaveLength(0);
    });

    it('still throws for a pedido that is gone', async () => {
      const { db } = makeDb({});
      await expect(
        reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID, aposAlterarTotal: true }),
      ).rejects.toBeInstanceOf(PedidoReconcileNotFoundError);
    });

    describe('the channel gate — a marketplace pedido is never reconciled from a total change', () => {
      const carrinhoPagoVia = (integracao: Record<string, unknown> | null) => ({
        'pedidos/p1': {
          estado: 'carrinho',
          valorCobrado: 10,
          integracaoPedidoOuterRef: 'documents/integracao/int1',
        },
        ...(integracao ? { 'integracao/int1': integracao } : {}),
        ...pagoPela(10),
      });

      it('⚠️ leaves an ML pedido in carrinho alone even though its payment covers the total', async () => {
        // The #791 window: ML's payments topic stored an aprovado pagamento but
        // `podeAvancarParaPago` (emProcessamento + cliente + endereço + frete) did
        // not hold yet. `carrinho` passes the items-editable gate and is in
        // AUTO_ESTADO_SOURCES — without this gate an item edit jumps it to `pago`.
        const { db, store, writes } = makeDb(carrinhoPagoVia({ tipo: 1 })); // mercadoLivre

        const result = await reconcilePedidoEstado(db, {
          pedidoId: PEDIDO_ID,
          aposAlterarTotal: true,
        });

        expect(result).toEqual({ transition: null });
        expect(store['pedidos/p1']!.estado).toBe('carrinho');
        expect(writes.updates).toHaveLength(0);
      });

      it('NEAR-MISS: settles the same pedido when its channel is the balcão', async () => {
        const { db, store } = makeDb(carrinhoPagoVia({ tipo: 7 })); // balcao

        const result = await reconcilePedidoEstado(db, {
          pedidoId: PEDIDO_ID,
          aposAlterarTotal: true,
        });

        expect(result).toEqual({ transition: 'pago' });
        expect(store['pedidos/p1']!.estado).toBe('pago');
      });

      it.each([
        ['the integração no longer exists', null],
        ['its tipo is outside the enum', { tipo: 99 }],
        ['its tipo is missing', {}],
      ])('fails closed (no write) when %s', async (_caso, integracao) => {
        const { db, writes } = makeDb(carrinhoPagoVia(integracao));

        const result = await reconcilePedidoEstado(db, {
          pedidoId: PEDIDO_ID,
          aposAlterarTotal: true,
        });

        expect(result).toEqual({ transition: null });
        expect(writes.updates).toHaveLength(0);
      });

      it('NEAR-MISS: the pagamento path (no flag) still reconciles the ML pedido', async () => {
        // The channel gate is opt-in like the estado gate: the Pagamentos tab's
        // behaviour is unchanged by this PR, exposure included.
        const { db, store } = makeDb(carrinhoPagoVia({ tipo: 1 }));

        const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

        expect(result).toEqual({ transition: 'pago' });
        expect(store['pedidos/p1']!.estado).toBe('pago');
      });
    });

    it('NEAR-MISS: without the flag (the pagamento path) the same pedido still transitions', async () => {
      // Pins that the gate is opt-in: the Pagamentos tab's behaviour is unchanged.
      const { db, store } = makeDb({
        'pedidos/p1': { estado: 'emProcessamento', valorCobrado: 100 },
        ...pagoPela(40),
      });

      const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

      expect(result).toEqual({ transition: 'aguardandoConfirmacaoDePagamento' });
      expect(store['pedidos/p1']!.estado).toBe('aguardandoConfirmacaoDePagamento');
    });
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

  // The idempotency property the whole design leans on: calling this twice — two
  // tabs, a retried callable, two concurrent reconciles — cannot double-write or
  // append a second história row, because the second call re-reads the settled
  // estado and `nextPedidoEstado` returns null.
  it('is a no-op when the estado already matches the payment set (pago, still fully paid)', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': { estado: 'pago', valorCobrado: 100 },
      'pedidos/p1/pagamentos/pay1': {
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_OLD,
      },
    });

    const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

    expect(result).toEqual({ transition: null });
    expect(store['pedidos/p1']!.estado).toBe('pago');
    expect(writes.updates).toHaveLength(0);
    expect(writes.sets).toHaveLength(0);
  });

  it('downgrades a pago pedido once its payments no longer cover the total', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': {
        estado: 'pago',
        valorCobrado: 100,
        freteInicial: { estado: 'despachoAutorizado' },
      },
      // Refunded — a real reversal, so `valorPago` drops to 0 and the pedido
      // is no longer covered. Contrast the `em_disputa` case below: that one
      // is a HOLD and must NOT downgrade.
      'pedidos/p1/pagamentos/pay1': {
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.estornado,
        ultimaModificacao: T_OLD,
      },
    });

    const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

    expect(result).toEqual({ transition: 'aguardandoConfirmacaoDePagamento' });
    expect(store['pedidos/p1']!.estado).toBe('aguardandoConfirmacaoDePagamento');
    // A downgrade never re-authorizes dispatch, so `freteInicial` is left alone.
    expect(store['pedidos/p1']!.freteInicial).toEqual({ estado: 'despachoAutorizado' });
    // No row in either trail from here — the onPedidoChanged trigger
    // records the downgrade off the pedido write, and no trigger runs against
    // this fake db. The frete trail stays empty for a second reason too: a
    // downgrade leaves `freteInicial` alone, so there is no frete transition to
    // record even once the trigger is in play.
    expect(trailWrites(writes, 'historicoEstadoPedido')).toEqual([]);
    expect(trailWrites(writes, 'historicoFtIni')).toEqual([]);
  });

  it('does NOT downgrade a pago pedido whose payment went em_disputa (#1322)', async () => {
    // ⚠️ The regression this reconcile used to produce. ML keeps the order
    // `paid` for the whole mediation and holds the money as `retained`; the
    // payments topic mirrors that as `em_disputa`. Counting it as unpaid
    // dropped `valorPago` to 0 and downgraded the pedido to
    // `aguardandoConfirmacaoDePagamento` — a paid order labelled as awaiting
    // payment, on the Mercado Pago webhook path and on the operator's own
    // "reconciliar" button.
    //
    // It protected nothing: `pago` and `aguardandoConfirmacaoDePagamento` are
    // both in ESTADOS_PEDIDO_RESERVA and ESTADOS_PEDIDO_MOVIMENTACAO (stock
    // never moved) and neither is in EMISSAO_NFE_BLOQUEADA (NF-e stayed
    // emittable). The money-at-risk signal belongs to the dispute overlay.
    const { db, store, writes } = makeDb({
      'pedidos/p1': {
        estado: 'pago',
        valorCobrado: 100,
        freteInicial: { estado: 'despachoAutorizado' },
      },
      'pedidos/p1/pagamentos/pay1': {
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.em_disputa,
        ultimaModificacao: T_OLD,
      },
    });

    const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

    expect(result).toEqual({ transition: null });
    expect(store['pedidos/p1']!.estado).toBe('pago');
    // No transition means no write at all — not a write that happens to land
    // on the same value.
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

  // The load-bearing #702 table: EVERY member of the enum goes through the real
  // reconcile, so a future estado added to the authorizing set cannot become
  // flippable without a deliberate edit to {@link FLIPPABLE} above.
  it.each([...estadoFreteSchema.options])(
    'authorizes dispatch from frete estado %s only when it precedes authorization (#702)',
    async (estadoFrete) => {
      const { db, writes } = makeDb({
        'pedidos/p1': {
          estado: 'iniciado',
          valorCobrado: 100,
          freteInicial: { estado: estadoFrete, codRastreio: null },
        },
        'pedidos/p1/pagamentos/pay1': {
          valor: 100,
          status_pagamento: STATUS_PAGAMENTO.aprovado,
          ultimaModificacao: T_OLD,
        },
      });

      const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

      // The estado transition itself never depends on the frete.
      expect(result).toEqual({ transition: 'pago' });
      const pedidoUpdates = writes.updates.filter((w) => w.path === 'pedidos/p1');
      expect(pedidoUpdates).toHaveLength(1);
      const patch = pedidoUpdates[0]!.data;
      expect(patch.estado).toBe('pago');

      if (FLIPPABLE.includes(estadoFrete)) {
        expect(patch.freteInicial).toEqual({
          estado: 'despachoAutorizado',
          codRastreio: null,
        });
      } else {
        // Not merely "same value" — the patch must not carry the key at all, so
        // the frete block is never rewritten (nor its sibling fields re-stamped).
        expect(patch).not.toHaveProperty('freteInicial');
      }

      // `reconcilePedidoEstado` only ever tx.updates the pedido — it never
      // tx.sets a subcollection document — so riding this table gets the
      // no-hand-rolled-history property for free on all 27 frete estados,
      // including the four that DO flip to `despachoAutorizado` and would
      // otherwise be the place to append a frete row. Asserted on the whole
      // `sets` list rather than a per-trail filter so it also catches an append
      // landing under a third, not-yet-named trail.
      expect(writes.sets).toEqual([]);
    },
  );

  it('does not un-pack an empacotado frete when the pedido becomes pago (#702)', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        // The warehouse already packed this order; `empacotado` also removes stock
        // (ESTADOS_FRETE_REMOVE_ESTOQUE), so regressing it un-removes it.
        freteInicial: { estado: 'empacotado', codRastreio: null },
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
    const pedidoUpdates = writes.updates.filter((w) => w.path === 'pedidos/p1');
    expect(pedidoUpdates).toHaveLength(1);
    expect(pedidoUpdates[0]!.data).not.toHaveProperty('freteInicial');
  });

  it('does not pull an emSeparacao frete back off the picking floor when it becomes pago (#702)', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        freteInicial: { estado: 'emSeparacao', codRastreio: null },
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
    const pedidoUpdates = writes.updates.filter((w) => w.path === 'pedidos/p1');
    expect(pedidoUpdates).toHaveLength(1);
    expect(pedidoUpdates[0]!.data).not.toHaveProperty('freteInicial');
  });

  it('does not drop an aguardandoAgendamento frete out of its pickup slot when it becomes pago (#702)', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        freteInicial: { estado: 'aguardandoAgendamento', codRastreio: null },
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
    const pedidoUpdates = writes.updates.filter((w) => w.path === 'pedidos/p1');
    expect(pedidoUpdates).toHaveLength(1);
    expect(pedidoUpdates[0]!.data).not.toHaveProperty('freteInicial');
  });

  it('does not erase a finished despacho conference (checkFinalizado) when it becomes pago (#702)', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        // Written by the despacho checkout screen on every completed conference
        // (`apps/web/lib/checkout/saveCheckout.ts`) — the operator's work.
        freteInicial: { estado: 'checkFinalizado', codRastreio: null },
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
    const pedidoUpdates = writes.updates.filter((w) => w.path === 'pedidos/p1');
    expect(pedidoUpdates).toHaveLength(1);
    expect(pedidoUpdates[0]!.data).not.toHaveProperty('freteInicial');
  });

  it('does not rewrite a frete that is already despachoAutorizado', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        freteInicial: { estado: 'despachoAutorizado', codRastreio: null },
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
    // Already authorized — no redundant write of the whole frete map.
    const pedidoUpdates = writes.updates.filter((w) => w.path === 'pedidos/p1');
    expect(pedidoUpdates).toHaveLength(1);
    expect(pedidoUpdates[0]!.data).not.toHaveProperty('freteInicial');
  });

  it('does not authorize dispatch on a marketplace-owned frete block (#702)', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        // The Mercado Livre importer owns this block (the same read-only lock the
        // Frete tab applies) — the ERP must not drive its lifecycle.
        freteInicial: {
          estado: 'iniciado',
          externalOptionIntegracao: 'mercadoLivre',
          codRastreio: null,
        },
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
    const pedidoUpdates = writes.updates.filter((w) => w.path === 'pedidos/p1');
    expect(pedidoUpdates).toHaveLength(1);
    expect(pedidoUpdates[0]!.data).not.toHaveProperty('freteInicial');
  });

  it('still authorizes dispatch on an app-managed melhorEnvios frete', async () => {
    const { db, store } = makeDb({
      'pedidos/p1': {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        freteInicial: {
          estado: 'iniciado',
          externalOptionIntegracao: 'melhorEnvios',
          codRastreio: null,
        },
      },
      'pedidos/p1/pagamentos/pay1': {
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_OLD,
      },
    });

    const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

    expect(result).toEqual({ transition: 'pago' });
    // Flipped, and the rest of the frete map rides along untouched.
    expect(store['pedidos/p1']!.freteInicial).toEqual({
      estado: 'despachoAutorizado',
      externalOptionIntegracao: 'melhorEnvios',
      codRastreio: null,
    });
  });

  // The one branch the 27-row table above cannot reach: `podeAutorizarDespacho`
  // is only consulted when an estado is present, so a malformed block — legacy
  // Flutter or a partial merge, since `freteDoPedidoSchema` makes `estado`
  // required — takes the `!freteEstado` short-circuit. Pinned deliberately:
  // repairing it to `despachoAutorizado` is the pre-#702 behaviour and nothing
  // is regressed by it (there is no progress to lose), but a future refactor
  // that flips this in either direction should have to update a test.
  it('authorizes dispatch on a frete block that carries no estado at all', async () => {
    const { db, store } = makeDb({
      'pedidos/p1': {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        freteInicial: { codRastreio: null },
      },
      'pedidos/p1/pagamentos/pay1': {
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_OLD,
      },
    });

    const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

    expect(result).toEqual({ transition: 'pago' });
    expect(store['pedidos/p1']!.freteInicial).toEqual({
      estado: 'despachoAutorizado',
      codRastreio: null,
    });
  });

  it('writes only estado (no freteInicial key) when the pedido has no frete', async () => {
    const { db, store, writes } = makeDb({
      // No `freteInicial` at all — the dispatch authorization must not invent one.
      'pedidos/p1': { estado: 'iniciado', valorCobrado: 100 },
      'pedidos/p1/pagamentos/pay1': {
        valor: 100,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        ultimaModificacao: T_OLD,
      },
    });

    const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

    expect(result).toEqual({ transition: 'pago' });
    expect(store['pedidos/p1']!.estado).toBe('pago');
    const pedidoUpdates = writes.updates.filter((w) => w.path === 'pedidos/p1');
    expect(pedidoUpdates).toHaveLength(1);
    expect(pedidoUpdates[0]!.data).not.toHaveProperty('freteInicial');
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

/* -------------------------------------------------------------------------- */
/*  Troca — the devolução credit counts as PAID (#367 PR 0)                   */
/*                                                                            */
/*  Legacy counted the returned items as paid and compared against the GROSS  */
/*  total (`tasks.dart:64-68`). `valorCobrado` stays gross here; the credit   */
/*  is read off the pedido snapshot the reconcile already holds and added to  */
/*  the PAID side (`coberturaDoPedido`) — minus paying 'crédito loja'         */
/*  pagamentos, so registering the returned value as a payment (to emit the   */
/*  troca's NF-e) is not counted twice.                                       */
/* -------------------------------------------------------------------------- */

describe('troca — the devolução credit counts as paid', () => {
  /** The returned items of a troca: one line worth `valor` (qty 1, no discount). */
  const devolvidos = (valor: number) => ({
    o1: { p1: [{ precoDeVenda: valor, descontoUnitario: 0, quantidade: 1 }] },
  });
  /** A saída `iniciado`, total 150 (GROSS), returning 100 — "pay the difference". */
  const trocaSeed = (over: Record<string, unknown> = {}) => ({
    estado: 'iniciado',
    ehSaida: true,
    valorCobrado: 150,
    itensDevolvidos: devolvidos(100),
    freteInicial: { estado: 'iniciado', codRastreio: null },
    ...over,
  });
  const pagamentoDoc = (valor: number, over: Record<string, unknown> = {}) => ({
    valor,
    status_pagamento: STATUS_PAGAMENTO.aprovado,
    forma_de_pagamento: FORMA_PAGAMENTO.pix,
    ultimaModificacao: T_OLD,
    ...over,
  });
  const creditoLoja = (valor: number, over: Record<string, unknown> = {}) =>
    pagamentoDoc(valor, { forma_de_pagamento: FORMA_PAGAMENTO.credito_loja, ...over });

  describe('reconcilePedidoEstado', () => {
    it('a troca paid the difference (credit 100 + aprovado 50 on 150) → pago, dispatch authorized', async () => {
      const { db, store } = makeDb({
        'pedidos/p1': trocaSeed(),
        'pedidos/p1/pagamentos/pay1': pagamentoDoc(50),
      });

      const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

      expect(result).toEqual({ transition: 'pago' });
      expect(store['pedidos/p1']!.estado).toBe('pago');
      expect(store['pedidos/p1']!.freteInicial).toEqual({
        estado: 'despachoAutorizado',
        codRastreio: null,
      });
      // The credit is a figure derived from the pedido — never written back.
      expect(store['pedidos/p1']!.valorCobrado).toBe(150);
    });

    it('⚠️ NEAR-MISS: one cent short of the difference (49.99) → aguardando, frete untouched', async () => {
      const { db, store } = makeDb({
        'pedidos/p1': trocaSeed(),
        'pedidos/p1/pagamentos/pay1': pagamentoDoc(49.99),
      });

      const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

      expect(result).toEqual({ transition: 'aguardandoConfirmacaoDePagamento' });
      expect(store['pedidos/p1']!.freteInicial).toEqual({ estado: 'iniciado', codRastreio: null });
    });

    it('an even swap (credit 150, NO pagamentos) → pago — the credit is added to the paid side, not netted off the total', async () => {
      // Netting would leave a total of 0, and `nextPedidoEstado` returns null on
      // `total <= 0`: the swap would sit in `iniciado` forever.
      const { db, store } = makeDb({
        'pedidos/p1': trocaSeed({ itensDevolvidos: devolvidos(150) }),
      });

      const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

      expect(result).toEqual({ transition: 'pago' });
      expect(store['pedidos/p1']!.estado).toBe('pago');
      expect(store['pedidos/p1']!.freteInicial).toMatchObject({ estado: 'despachoAutorizado' });
    });

    it('a credit-only partial (100 on 150, no pagamentos) → aguardando (legacy: valorPago > 0 includes the credit)', async () => {
      const { db, store } = makeDb({ 'pedidos/p1': trocaSeed() });

      const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

      expect(result).toEqual({ transition: 'aguardandoConfirmacaoDePagamento' });
      expect(store['pedidos/p1']!.freteInicial).toEqual({ estado: 'iniciado', codRastreio: null });
    });

    it('a pago troca whose payment + credit still cover the total is a no-op (it used to DOWNGRADE)', async () => {
      // The regression: without the credit this pedido reads as 50 paid of 150 and
      // a reconcile (the operator's button, any pagamento save) sent it back to
      // aguardando.
      const { db, store, writes } = makeDb({
        'pedidos/p1': trocaSeed({ estado: 'pago' }),
        'pedidos/p1/pagamentos/pay1': pagamentoDoc(50),
      });

      const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

      expect(result).toEqual({ transition: null });
      expect(store['pedidos/p1']!.estado).toBe('pago');
      expect(writes.updates).toHaveLength(0);
    });

    it('⚠️ NEAR-MISS: the same pago troca one cent short (49.99) downgrades', async () => {
      const { db, store } = makeDb({
        'pedidos/p1': trocaSeed({ estado: 'pago' }),
        'pedidos/p1/pagamentos/pay1': pagamentoDoc(49.99),
      });

      const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

      expect(result).toEqual({ transition: 'aguardandoConfirmacaoDePagamento' });
      expect(store['pedidos/p1']!.estado).toBe('aguardandoConfirmacaoDePagamento');
    });

    it('a refund of the difference downgrades a pago troca (the credit alone does not cover the total)', async () => {
      const { db, store } = makeDb({
        'pedidos/p1': trocaSeed({ estado: 'pago' }),
        'pedidos/p1/pagamentos/pay1': pagamentoDoc(50, {
          status_pagamento: STATUS_PAGAMENTO.estornado,
        }),
      });

      const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

      expect(result).toEqual({ transition: 'aguardandoConfirmacaoDePagamento' });
      expect(store['pedidos/p1']!.estado).toBe('aguardandoConfirmacaoDePagamento');
    });

    describe('OD1 — a paying crédito loja pagamento is the returned value already registered, not extra money', () => {
      it.each<[number, string]>([
        // credit 100 − crédito loja 100 = 0, so only the pix counts.
        [49.99, 'aguardandoConfirmacaoDePagamento'],
        [50, 'pago'],
      ])('crédito loja 100 + pix %s on 150 → %s', async (pix, esperado) => {
        // Counted twice (credit 100 + crédito loja 100) the pedido would be `pago`
        // — and its freight authorized — before the difference was paid.
        const { db, store } = makeDb({
          'pedidos/p1': trocaSeed(),
          'pedidos/p1/pagamentos/pay1': creditoLoja(100),
          'pedidos/p1/pagamentos/pay2': pagamentoDoc(pix),
        });

        const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

        expect(result).toEqual({ transition: esperado });
        expect(store['pedidos/p1']!.estado).toBe(esperado);
      });

      it('NEAR-MISS: a REFUSED crédito loja does not reduce the credit', async () => {
        // A recusado row is not paying, so it neither adds to the sum nor eats the
        // credit: credit 100 + pix 50 covers the 150.
        const { db, store } = makeDb({
          'pedidos/p1': trocaSeed(),
          'pedidos/p1/pagamentos/pay1': creditoLoja(100, {
            status_pagamento: STATUS_PAGAMENTO.recusado,
          }),
          'pedidos/p1/pagamentos/pay2': pagamentoDoc(50),
        });

        const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

        expect(result).toEqual({ transition: 'pago' });
        expect(store['pedidos/p1']!.estado).toBe('pago');
      });

      it('a PARTIAL crédito loja only eats that much of the credit (40 of 100 → credit 60)', async () => {
        // 60 + 40 + 50 = 150 covers; 60 + 40 + 49.99 does not.
        const seed = (pix: number) => ({
          'pedidos/p1': trocaSeed(),
          'pedidos/p1/pagamentos/pay1': creditoLoja(40),
          'pedidos/p1/pagamentos/pay2': pagamentoDoc(pix),
        });
        const cobre = makeDb(seed(50));
        expect(await reconcilePedidoEstado(cobre.db, { pedidoId: PEDIDO_ID })).toEqual({
          transition: 'pago',
        });
        const falta = makeDb(seed(49.99));
        expect(await reconcilePedidoEstado(falta.db, { pedidoId: PEDIDO_ID })).toEqual({
          transition: 'aguardandoConfirmacaoDePagamento',
        });
      });
    });

    it('an ENTRADA carrying itensDevolvidos gets no credit (50 on 150 → aguardando)', async () => {
      const { db, store } = makeDb({
        'pedidos/p1': trocaSeed({ ehSaida: false }),
        'pedidos/p1/pagamentos/pay1': pagamentoDoc(50),
      });

      const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

      expect(result).toEqual({ transition: 'aguardandoConfirmacaoDePagamento' });
      expect(store['pedidos/p1']!.freteInicial).toEqual({ estado: 'iniciado', codRastreio: null });
    });

    it('reads a raw legacy devolução tolerantly — junk counts as no credit and never throws', async () => {
      const { db, store } = makeDb({
        'pedidos/p1': trocaSeed({
          itensDevolvidos: {
            // A string price is not a number: this line is worth 0.
            o1: { p1: [{ precoDeVenda: '100', descontoUnitario: 0, quantidade: 1 }] },
            o2: 'lixo',
            o3: { p3: 'nao-e-lista' },
          },
        }),
        'pedidos/p1/pagamentos/pay1': pagamentoDoc(50),
      });

      const result = await reconcilePedidoEstado(db, { pedidoId: PEDIDO_ID });

      // 50 paid of 150, no credit → still partial.
      expect(result).toEqual({ transition: 'aguardandoConfirmacaoDePagamento' });
      expect(store['pedidos/p1']!.estado).toBe('aguardandoConfirmacaoDePagamento');
    });

    describe('aposAlterarTotal — a devolução-only edit reconciles', () => {
      it('settles an even swap the operator just edited into existence (no pagamentos)', async () => {
        const { db, store } = makeDb({
          'pedidos/p1': trocaSeed({ itensDevolvidos: devolvidos(150) }),
        });

        const result = await reconcilePedidoEstado(db, {
          pedidoId: PEDIDO_ID,
          aposAlterarTotal: true,
        });

        expect(result).toEqual({ transition: 'pago' });
        expect(store['pedidos/p1']!.estado).toBe('pago');
      });

      it('⚠️ a marketplace pedido is still left alone — the gate is unchanged by the credit', async () => {
        const { db, store, writes } = makeDb({
          'pedidos/p1': trocaSeed({
            estado: 'carrinho',
            itensDevolvidos: devolvidos(150),
            integracaoPedidoOuterRef: 'documents/integracao/int1',
          }),
          'integracao/int1': { tipo: 1 }, // mercadoLivre
        });

        const result = await reconcilePedidoEstado(db, {
          pedidoId: PEDIDO_ID,
          aposAlterarTotal: true,
        });

        expect(result).toEqual({ transition: null });
        expect(store['pedidos/p1']!.estado).toBe('carrinho');
        expect(writes.updates).toHaveLength(0);
      });

      it('NEAR-MISS: the same pedido on the balcão is settled', async () => {
        const { db, store } = makeDb({
          'pedidos/p1': trocaSeed({
            estado: 'carrinho',
            itensDevolvidos: devolvidos(150),
            integracaoPedidoOuterRef: 'documents/integracao/int1',
          }),
          'integracao/int1': { tipo: 7 }, // balcao
        });

        const result = await reconcilePedidoEstado(db, {
          pedidoId: PEDIDO_ID,
          aposAlterarTotal: true,
        });

        expect(result).toEqual({ transition: 'pago' });
        expect(store['pedidos/p1']!.estado).toBe('pago');
      });
    });
  });

  describe('reconcilePedidoFromPagamento', () => {
    it('a Mercado Pago payment of the difference (50 on a 150 troca, credit 100) → pago', async () => {
      // The credit comes ONLY from the stored pedido doc: the incoming pagamento
      // carries nothing about the devolução.
      const { db, store } = makeDb({ 'pedidos/p1': trocaSeed() });

      const result = await reconcilePedidoFromPagamento(db, {
        pedidoId: PEDIDO_ID,
        pagamentoId: PAY_ID,
        pagamento: mkPagamento({
          valor: 50,
          status_pagamento: STATUS_PAGAMENTO.aprovado,
          ultimaModificacao: T_NEW,
        }),
      });

      expect(result).toEqual({ transition: 'pago', skippedStale: false, aprovadosDoLink: null });
      expect(store['pedidos/p1']!.estado).toBe('pago');
      expect(store['pedidos/p1']!.freteInicial).toEqual({
        estado: 'despachoAutorizado',
        codRastreio: null,
      });
    });

    it('⚠️ NEAR-MISS: 49.99 of the 50 difference → aguardando, frete untouched', async () => {
      const { db, store } = makeDb({ 'pedidos/p1': trocaSeed() });

      const result = await reconcilePedidoFromPagamento(db, {
        pedidoId: PEDIDO_ID,
        pagamentoId: PAY_ID,
        pagamento: mkPagamento({
          valor: 49.99,
          status_pagamento: STATUS_PAGAMENTO.aprovado,
          ultimaModificacao: T_NEW,
        }),
      });

      expect(result).toEqual({
        transition: 'aguardandoConfirmacaoDePagamento',
        skippedStale: false,
        aprovadosDoLink: null,
      });
      expect(store['pedidos/p1']!.freteInicial).toEqual({ estado: 'iniciado', codRastreio: null });
    });

    it('the INCOMING pagamento carries its forma: a crédito loja of 100 eats the whole credit', async () => {
      // credit 100 − crédito loja 100 = 0, paid 100 of 150 → aguardando. If the
      // incoming row lost its `forma_de_pagamento` it would count as extra money
      // (100 + 100 ≥ 150) and the pedido would read `pago`.
      const { db, store } = makeDb({ 'pedidos/p1': trocaSeed() });

      const result = await reconcilePedidoFromPagamento(db, {
        pedidoId: PEDIDO_ID,
        pagamentoId: PAY_ID,
        pagamento: mkPagamento({
          valor: 100,
          forma_de_pagamento: FORMA_PAGAMENTO.credito_loja,
          status_pagamento: STATUS_PAGAMENTO.aprovado,
          ultimaModificacao: T_NEW,
        }),
      });

      expect(result).toEqual({
        transition: 'aguardandoConfirmacaoDePagamento',
        skippedStale: false,
        aprovadosDoLink: null,
      });
      expect(store['pedidos/p1']!.estado).toBe('aguardandoConfirmacaoDePagamento');
    });

    it.each<[number, string]>([
      [49.99, 'aguardandoConfirmacaoDePagamento'],
      [50, 'pago'],
    ])(
      'a STORED crédito loja of 100 + an incoming payment of %s on 150 → %s',
      async (valor, esperado) => {
        const { db, store } = makeDb({
          'pedidos/p1': trocaSeed(),
          'pedidos/p1/pagamentos/payCL': creditoLoja(100),
        });

        const result = await reconcilePedidoFromPagamento(db, {
          pedidoId: PEDIDO_ID,
          pagamentoId: PAY_ID,
          pagamento: mkPagamento({
            valor,
            status_pagamento: STATUS_PAGAMENTO.aprovado,
            ultimaModificacao: T_NEW,
          }),
        });

        expect(result).toEqual({
          transition: esperado,
          skippedStale: false,
          aprovadosDoLink: null,
        });
        expect(store['pedidos/p1']!.estado).toBe(esperado);
      },
    );

    it('a payment refund on a pago troca downgrades it (the credit alone does not cover)', async () => {
      const { db, store } = makeDb({
        'pedidos/p1': trocaSeed({ estado: 'pago' }),
        'pedidos/p1/pagamentos/pay1': pagamentoDoc(50),
      });

      const result = await reconcilePedidoFromPagamento(db, {
        pedidoId: PEDIDO_ID,
        pagamentoId: PAY_ID,
        pagamento: mkPagamento({
          valor: 50,
          status_pagamento: STATUS_PAGAMENTO.estornado,
          ultimaModificacao: T_NEW,
        }),
      });

      expect(result.transition).toBe('aguardandoConfirmacaoDePagamento');
      expect(store['pedidos/p1']!.estado).toBe('aguardandoConfirmacaoDePagamento');
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  #367 PR 1b — a payment the LEGACY app stored under an AUTO doc id          */
/* -------------------------------------------------------------------------- */

describe('reconcilePedidoFromPagamento — legacy auto-id pagamento (#367 PR 1b)', () => {
  const CONTA = 'documents/metodo_pgto/m1';
  const LEGADO = 'pedidos/p1/pagamentos/legAuto1';

  /** A pagamento as the legacy app persisted it: auto doc id, MP id in the `id` FIELD. */
  function legado(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: PAY_ID,
      metodoPagamentoOuterRef: CONTA,
      forma_de_pagamento: FORMA_PAGAMENTO.cartao_credito,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      valor: 60,
      nFat: 'NF-legado',
      ...over,
    };
  }

  it('updates the legacy doc IN PLACE instead of creating a second one', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': { estado: 'pago', valorCobrado: 60 },
      [LEGADO]: legado(),
    });

    const result = await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 60,
        status_pagamento: STATUS_PAGAMENTO.estornado,
        metodoPagamentoOuterRef: CONTA,
      }),
    });

    // The refund landed on the legacy doc, and no doc was minted at the MP id.
    expect(store['pedidos/p1/pagamentos/pay1']).toBeUndefined();
    expect(writes.sets.map((w) => w.path)).toEqual([LEGADO]);
    expect(store[LEGADO]).toMatchObject({
      status_pagamento: STATUS_PAGAMENTO.estornado,
      // Operator/legacy fields survive the inverted merge, like any update.
      nFat: 'NF-legado',
    });
    // Nothing paid any more → the pago pedido is downgraded.
    expect(result.transition).toBe('aguardandoConfirmacaoDePagamento');
  });

  it('counts the payment ONCE: a redelivery of the same approved payment does not reach pago', async () => {
    // The double count this fixes: without the match, a new doc at `pay1` (60)
    // plus the legacy doc (60) would sum 120 >= 100 and settle the pedido.
    const { db, store } = makeDb({
      'pedidos/p1': { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 100 },
      [LEGADO]: legado(),
    });

    const result = await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 60,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        metodoPagamentoOuterRef: CONTA,
      }),
    });

    expect(result.transition).toBeNull();
    expect(store['pedidos/p1']!.estado).toBe('aguardandoConfirmacaoDePagamento');
    expect(store['pedidos/p1/pagamentos/pay1']).toBeUndefined();
  });

  it('near-miss: the same MP id on ANOTHER account is a different payment', async () => {
    const { db, store } = makeDb({
      'pedidos/p1': { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 100 },
      [LEGADO]: legado({ metodoPagamentoOuterRef: 'documents/metodo_pgto/outra' }),
    });

    await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 40,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        metodoPagamentoOuterRef: CONTA,
      }),
    });

    expect(store['pedidos/p1/pagamentos/pay1']).toMatchObject({ valor: 40 });
    expect(store[LEGADO]).toMatchObject({ valor: 60, nFat: 'NF-legado' });
    // 60 (other account, still counted) + 40 = 100 → pago.
    expect(store['pedidos/p1']!.estado).toBe('pago');
  });

  it('near-miss: a doc whose `id` field is a DIFFERENT payment is never matched', async () => {
    const { db, store } = makeDb({
      'pedidos/p1': { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 100 },
      [LEGADO]: legado({ id: 'outroPagamento' }),
    });

    await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 40,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        metodoPagamentoOuterRef: CONTA,
      }),
    });

    expect(store['pedidos/p1/pagamentos/pay1']).toMatchObject({ valor: 40 });
    expect(store[LEGADO]).toMatchObject({ id: 'outroPagamento', valor: 60 });
  });

  it('a doc AT the MP id wins over a legacy doc for the same payment', async () => {
    const { db, store } = makeDb({
      'pedidos/p1': { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 100 },
      'pedidos/p1/pagamentos/pay1': legado({ valor: 10 }),
      [LEGADO]: legado(),
    });

    await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 20,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        metodoPagamentoOuterRef: CONTA,
      }),
    });

    expect(store['pedidos/p1/pagamentos/pay1']).toMatchObject({ valor: 20 });
    expect(store[LEGADO]).toMatchObject({ valor: 60 });
  });

  it('two legacy docs for one payment resolve deterministically to the lowest doc id', async () => {
    // ⚠️ Pins a KNOWN divergence from legacy: only the chosen doc is replaced in
    // the sum, so the other duplicate keeps counting and the pedido stays pago
    // (legacy dropped both). Duplicates are a corpus question for the window.
    const { db, store } = makeDb({
      'pedidos/p1': { estado: 'pago', valorCobrado: 60 },
      'pedidos/p1/pagamentos/zzLegado': legado(),
      'pedidos/p1/pagamentos/aaLegado': legado(),
    });

    await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 60,
        status_pagamento: STATUS_PAGAMENTO.estornado,
        metodoPagamentoOuterRef: CONTA,
      }),
    });

    expect(store['pedidos/p1/pagamentos/aaLegado']).toMatchObject({
      status_pagamento: STATUS_PAGAMENTO.estornado,
    });
    expect(store['pedidos/p1/pagamentos/zzLegado']).toMatchObject({
      status_pagamento: STATUS_PAGAMENTO.aprovado,
    });
    expect(store['pedidos/p1/pagamentos/pay1']).toBeUndefined();
    expect(store['pedidos/p1']!.estado).toBe('pago');
  });

  it('an incoming payment with no account ref never matches a legacy doc', async () => {
    const { db, store } = makeDb({
      'pedidos/p1': { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 100 },
      [LEGADO]: legado(),
    });

    await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({ valor: 40, status_pagamento: STATUS_PAGAMENTO.aprovado }),
    });

    expect(store['pedidos/p1/pagamentos/pay1']).toMatchObject({ valor: 40 });
    expect(store[LEGADO]).toMatchObject({ valor: 60 });
  });
  it('the update-if-newer guard protects a legacy doc too (same watermark → skipped)', async () => {
    const { db, store, writes } = makeDb({
      'pedidos/p1': { estado: 'pago', valorCobrado: 60 },
      [LEGADO]: legado({ lastProviderUpdate: T_NEW }),
    });

    const result = await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 60,
        status_pagamento: STATUS_PAGAMENTO.estornado,
        metodoPagamentoOuterRef: CONTA,
        lastProviderUpdate: T_NEW,
      }),
    });

    expect(result).toMatchObject({ transition: null, skippedStale: true });
    expect(writes.sets).toEqual([]);
    expect(store[LEGADO]).toMatchObject({ status_pagamento: STATUS_PAGAMENTO.aprovado });
  });

  it('writes a realistic legacy doc (ms dates, cartao block) without throwing, dates in µs', async () => {
    const MS = 1_700_000_000_000; // legacy stored epoch MILLISECONDS
    const { db, store } = makeDb({
      'pedidos/p1': { estado: 'pago', valorCobrado: 60 },
      [LEGADO]: legado({
        dataCadastro: MS,
        dataAprovacao: MS,
        ultimaModificacao: MS,
        parcelas: 2,
        aVista: false,
        cartao: { tpIntegra: '2', numeroCartao: '1234', cAut: 'ABC' },
      }),
    });

    await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 60,
        status_pagamento: STATUS_PAGAMENTO.estornado,
        metodoPagamentoOuterRef: CONTA,
      }),
    });

    const doc = store[LEGADO]!;
    expect(doc.status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    // The legacy first-seen stamp survives, coerced to the µs standard.
    expect(doc.dataCadastro).toBe(MS * 1000);
    expect(doc.cartao).toMatchObject({ numeroCartao: '1234', cAut: 'ABC' });
    expect(doc.ultimaModificacao as number).toBeGreaterThan(MS * 1000);
    expect(store['pedidos/p1/pagamentos/pay1']).toBeUndefined();
  });

  it('near-miss: an equal id under ANOTHER collection is not the same account', async () => {
    const { db, store } = makeDb({
      'pedidos/p1': { estado: 'aguardandoConfirmacaoDePagamento', valorCobrado: 100 },
      [LEGADO]: legado({ metodoPagamentoOuterRef: 'documents/integracoes/m1' }),
    });

    await reconcilePedidoFromPagamento(db, {
      pedidoId: PEDIDO_ID,
      pagamentoId: PAY_ID,
      pagamento: mkPagamento({
        valor: 40,
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        metodoPagamentoOuterRef: CONTA,
      }),
    });

    expect(store['pedidos/p1/pagamentos/pay1']).toMatchObject({ valor: 40 });
    expect(store[LEGADO]).toMatchObject({ valor: 60 });
  });
});
