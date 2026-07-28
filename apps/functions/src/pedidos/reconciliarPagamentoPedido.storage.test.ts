import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { PedidoReconcileNotFoundError, reconcilePedidoEstado } from '@delfrance/data/admin';
import { STATUS_PAGAMENTO } from '@delfrance/schemas';

// Integration test — requires the firestore emulator. Drives the exported
// `reconcilePedidoEstado` core directly (the `reconciliarPagamentoPedido`
// onCall wrapper only adds auth + Zod validation, both covered elsewhere).
// This is the ONE place the load-bearing claim of #308 is actually proven:
// the REAL Admin SDK reads the pagamentos QUERY inside `runTransaction`, in
// the same snapshot as the pedido. Every other test of this core runs against
// a hand-rolled fake whose `tx.get(collectionRef)` is an `Object.entries()`
// filter, which proves nothing about the SDK. Skipped bare.
const EMULATED = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const projectId = process.env.GCLOUD_PROJECT ?? 'demo-erp';

function getDb() {
  const app = getApps()[0] ?? initializeApp({ projectId });
  return getFirestore(app, process.env.FIREBASE_DATABASE_ID ?? 'default');
}

function pedidoRef(db: Firestore, pedidoId: string) {
  return db.collection('pedidos').doc(pedidoId);
}

async function historicos(db: Firestore, pedidoId: string) {
  const snap = await pedidoRef(db, pedidoId).collection('historicoEstadoPedido').get();
  return snap.docs.map((d) => d.data() as Record<string, unknown>);
}

/**
 * The `historicoEstadoPedido` trail is no longer written by the reconcile: the
 * `onPedidoEstadoChanged` trigger observes the pedido write and appends it
 * asynchronously, so the rows land AFTER `reconcilePedidoEstado` resolves. Poll
 * until the expected estado shows up.
 *
 * Note the trail also carries an OPENING row for the estado `seedPedido` created
 * the pedido with — the trigger records creates too — so assertions here count
 * rows of a given estado rather than the whole trail.
 */
async function waitForEstadoRow(
  db: Firestore,
  pedidoId: string,
  estado: string,
  timeoutMs = 20_000,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const trail = await historicos(db, pedidoId);
    if (trail.some((r) => r.estado === estado)) return trail;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for a '${estado}' historicoEstadoPedido row`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Seed one pedido + its pagamentos with plain Admin-SDK writes (deliberately
 * NOT through the collection handles the code under test uses). The pedido id
 * is unique per call so tests never interfere.
 */
async function seedPedido(
  db: Firestore,
  pedido: Record<string, unknown>,
  pagamentos: ReadonlyArray<Record<string, unknown>> = [],
): Promise<string> {
  const pedidoId = `ped${randomUUID().replace(/-/g, '')}`;
  const ref = pedidoRef(db, pedidoId);
  await ref.set(pedido);
  for (const [i, pagamento] of pagamentos.entries()) {
    const pagamentoId = `pay${i + 1}`;
    await ref.collection('pagamentos').doc(pagamentoId).set(pagamento);
  }
  return pedidoId;
}

describe.skipIf(!EMULATED)('reconcilePedidoEstado core (emulator)', () => {
  it('sums a real multi-doc pagamentos query in-transaction and transitions to pago', async () => {
    const db = getDb();
    const pedidoId = await seedPedido(
      db,
      {
        estado: 'aguardandoConfirmacaoDePagamento',
        valorCobrado: 100,
        freteInicial: { estado: 'iniciado', codRastreio: null },
      },
      [
        { valor: 60, status_pagamento: STATUS_PAGAMENTO.aprovado },
        { valor: 40, status_pagamento: STATUS_PAGAMENTO.aprovado },
        // `isPagamentoPagante` is null-or-aprovado, so this 1000 must NOT
        // cover the total — the filter runs over what the real query returned.
        { valor: 1000, status_pagamento: STATUS_PAGAMENTO.recusado },
      ],
    );

    const result = await reconcilePedidoEstado(db, { pedidoId });

    expect(result).toEqual({ transition: 'pago' });

    const pedido = (await pedidoRef(db, pedidoId).get()).data()!;
    expect(pedido.estado).toBe('pago');
    expect(pedido.freteInicial).toEqual({ estado: 'despachoAutorizado', codRastreio: null });

    // The trigger records the transition. Exactly one `pago` row, and its usuário
    // is null: this reconcile runs on the Admin SDK, so there is no end user
    // behind the write for the trigger's auth context to resolve.
    const trail = await waitForEstadoRow(db, pedidoId, 'pago');
    expect(trail.filter((r) => r.estado === 'pago')).toHaveLength(1);
    expect(trail.find((r) => r.estado === 'pago')).toMatchObject({
      usuarioHistoricoEstadosPedidoOuterRef: null,
    });
  }, 60_000);

  it('two concurrent reconciles settle on one consistent estado and write one history row (#308)', async () => {
    const db = getDb();
    const pedidoId = await seedPedido(
      db,
      {
        estado: 'iniciado',
        valorCobrado: 100,
        freteInicial: { estado: 'iniciado', codRastreio: null },
      },
      [{ valor: 100, status_pagamento: STATUS_PAGAMENTO.aprovado }],
    );

    // THE #308 regression. The client path sums the pagamentos with a `getDocs`
    // BEFORE `runTransaction` (the JS SDK can't query inside one), so two
    // callers can both read the pre-transition estado and both write. Here both
    // transactions read the pedido doc inside the tx, so they serialize on it:
    // the winner writes `pago`, the loser re-reads the already-settled `pago`,
    // `nextPedidoEstado` returns null for an already-`pago` fully-paid pedido,
    // and it commits nothing — hence exactly one history row.
    const resultados = await Promise.all([
      reconcilePedidoEstado(db, { pedidoId }),
      reconcilePedidoEstado(db, { pedidoId }),
    ]);

    // Exactly one transitioned; the other was a clean no-op.
    expect(resultados.map((r) => r.transition).filter((t) => t !== null)).toEqual(['pago']);
    expect((await pedidoRef(db, pedidoId).get()).data()!.estado).toBe('pago');

    // …and the trail agrees: ONE `pago` row, not two. The loser committed no
    // pedido write, so the trigger had nothing to record for it.
    const trail = await waitForEstadoRow(db, pedidoId, 'pago');
    expect(trail.filter((r) => r.estado === 'pago')).toHaveLength(1);
  }, 60_000);

  it('throws PedidoReconcileNotFoundError against a real missing pedido', async () => {
    const db = getDb();
    const pedidoId = `ped${randomUUID().replace(/-/g, '')}`; // never seeded

    await expect(reconcilePedidoEstado(db, { pedidoId })).rejects.toBeInstanceOf(
      PedidoReconcileNotFoundError,
    );

    // The transaction aborted before any write: no phantom pedido, no história.
    expect((await pedidoRef(db, pedidoId).get()).exists).toBe(false);
    expect(await historicos(db, pedidoId)).toHaveLength(0);
  });
});
