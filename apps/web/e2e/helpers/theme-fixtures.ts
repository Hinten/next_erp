import { expect } from '@playwright/test';
import { millisToMicros } from '@delfrance/core/datetime';
import { deleteDocumentSubtree } from '@delfrance/data/admin';
import {
  bucketOf,
  ESTADO_BUCKET_LABELS,
  ESTADO_PEDIDO,
  ESTADO_PEDIDO_LABELS,
  pedidoSchema,
  type EstadoPedido,
} from '@delfrance/schemas';
import { db } from '@delfrance/test-fixtures';
import { readEmulatorAccessConfig } from '../_helpers/verify-emulator-access';

const REPORT_STATES = [
  { estado: ESTADO_PEDIDO.iniciado, count: 1, price: 15 },
  { estado: ESTADO_PEDIDO.emAnalise, count: 2, price: 25 },
  { estado: ESTADO_PEDIDO.pago, count: 4, price: 40 },
  { estado: ESTADO_PEDIDO.cancelado, count: 1, price: 10 },
] as const;

function reportOrders(prefix: string) {
  return REPORT_STATES.flatMap(({ estado, count }) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-report-${estado}-${index}`,
      estado,
    })),
  );
}

/** Both independent writes must land before a later delete can be safely swept. */
async function expectReportOrderCreationSettled(id: string, estado: EstadoPedido): Promise<void> {
  const reference = db().collection('pedidos').doc(id);
  await expect
    .poll(
      async () => {
        const history = await reference
          .collection('historicoDeModificacoes')
          .where('kind', '==', 'create')
          .limit(1)
          .get();
        const creation = history.docs[0];
        if (!creation) return false;
        // Both rows originate in the same onPedidoChanged event. A row for a
        // different event or only one completed sibling write is insufficient.
        const state = await reference.collection('historicoEstadoPedido').doc(creation.id).get();
        return state.data()?.eventId === creation.id && state.data()?.estado === estado;
      },
      { timeout: 60_000, message: `Wait for report fixture ${id} creation and state history` },
    )
    .toBe(true);
}

/** Eight display-only orders cover every report bucket without a large trigger backlog. */
export async function seedThemeReportFixtures(prefix: string) {
  readEmulatorAccessConfig();
  const batch = db().batch();
  const timestamp = millisToMicros(Date.now());
  for (const { estado, count, price } of REPORT_STATES) {
    for (let index = 0; index < count; index += 1) {
      const id = `${prefix}-report-${estado}-${index}`;
      batch.set(
        db().collection('pedidos').doc(id),
        pedidoSchema.parse({
          estado,
          // The real report reads numero DESC, limited to 500. Retain the e2e
          // prefix on the ID for cancelled-run reclamation, and put these few
          // orders inside that window without excluding another suite's rows.
          numero: `zzz-${id}`,
          timestamp,
          ultimaModificacao: timestamp,
          valorCobrado: price,
          itens: { NONE: [{ quantidade: 1, precoDeVenda: price, nomeDeVenda: id }] },
          // No stock, payment or provider binding: these settled display
          // fixtures exercise the report, never an integration workflow.
        }),
      );
    }
  }
  await batch.commit();
  await Promise.all(
    reportOrders(prefix).map(({ id, estado }) => expectReportOrderCreationSettled(id, estado)),
  );
  return {
    orderIds: reportOrders(prefix).map(({ id }) => id),
    states: REPORT_STATES.map(({ estado, count, price }) => ({
      estado,
      label: ESTADO_PEDIDO_LABELS[estado],
      bucketLabel: ESTADO_BUCKET_LABELS[bucketOf(estado)],
      count,
      revenue: count * price,
    })),
  };
}

/** Prove our orders are in the actual unscoped report window before browser assertions. */
export async function expectThemeReportFixturesInRecentWindow(
  fixtures: Awaited<ReturnType<typeof seedThemeReportFixtures>>,
): Promise<void> {
  readEmulatorAccessConfig();
  const snapshot = await db().collection('pedidos').orderBy('numero', 'desc').limit(500).get();
  expect(snapshot.docs.map(({ id }) => id)).toEqual(expect.arrayContaining(fixtures.orderIds));
  for (const state of fixtures.states) {
    const own = snapshot.docs.filter(
      (document) =>
        fixtures.orderIds.includes(document.id) && document.data().estado === state.estado,
    );
    expect(own, `The report window must contain this worker's ${state.label} orders`).toHaveLength(
      state.count,
    );
  }
}

/** Delete only this worker's orders and wait for deletion history before sweeping descendants. */
export async function cleanupThemeReportFixtures(prefix: string): Promise<void> {
  readEmulatorAccessConfig();
  await Promise.all(
    reportOrders(prefix).map(async ({ id, estado }) => {
      const reference = db().collection('pedidos').doc(id);
      const existed = (await reference.get()).exists;
      // Repeat the seed settlement here: beforeAll may have failed after the
      // batch committed but before seedThemeReportFixtures could return.
      // Do not delete an existing parent while its create event can still
      // append either history row after the subtree has been swept.
      if (existed) await expectReportOrderCreationSettled(id, estado);
      await reference.delete();
      try {
        if (existed) {
          // Pedido deletion intentionally records a tombstone. Sweeping first
          // lets that asynchronous trigger recreate an orphan after cleanup.
          await expect
            .poll(
              async () => {
                const history = await reference
                  .collection('historicoDeModificacoes')
                  .where('kind', '==', 'delete')
                  .limit(1)
                  .get();
                return !history.empty;
              },
              { timeout: 60_000, message: `Wait for report fixture ${id} deletion history` },
            )
            .toBe(true);
        }
      } finally {
        const result = await deleteDocumentSubtree(db(), reference);
        expect(result.failedDeletes, `Delete report fixture descendants for ${id}`).toBe(0);
        expect(result.truncated).toBe(false);
      }
    }),
  );
}
