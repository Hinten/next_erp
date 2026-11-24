import { expect } from '@playwright/test';
import { millisToMicros } from '@delfrance/core/datetime';
import { deleteDocumentSubtree } from '@delfrance/data/admin';
import {
  bucketOf,
  checkoutFretePedidoSchema,
  ESTADO_BUCKET_LABELS,
  ESTADO_PEDIDO,
  ESTADO_PEDIDO_LABELS,
  INTEGRACAO_TIPO,
  INTEGRACAO_TIPO_LABELS,
  MODALIDADE_FRETE,
  pedidoSchema,
  seedFreteInicial,
  usuarioSchema,
  type EstadoPedido,
} from '@delfrance/schemas';
import { db } from '@delfrance/test-fixtures';
import { salesReportDateRange } from '../../lib/reports/salesReport';
import { readEmulatorAccessConfig } from '../_helpers/verify-emulator-access';

const REPORT_DAY = '2025-06-12';
const REPORT_VARIANTS = ['before', 'after', 'other-channel', 'incoming'] as const;
const REPORT_STATES = [
  { estado: ESTADO_PEDIDO.iniciado, count: 1, price: 15 },
  { estado: ESTADO_PEDIDO.emAnalise, count: 2, price: 25 },
  { estado: ESTADO_PEDIDO.pago, count: 4, price: 40 },
  { estado: ESTADO_PEDIDO.cancelado, count: 1, price: 10 },
] as const;

function reportOrders(prefix: string) {
  const outgoing = REPORT_STATES.flatMap(({ estado, count, price }) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-report-${estado}-${index}`,
      estado,
      price,
      variant: estado === ESTADO_PEDIDO.iniciado ? ('legacy' as const) : ('outgoing' as const),
    })),
  );
  const other = REPORT_VARIANTS.map((variant) => ({
    id: `${prefix}-report-${variant}`,
    estado: ESTADO_PEDIDO.pago,
    price: 97,
    variant,
  }));
  return { outgoing, other };
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

/** Historical orders in a private channel isolate the report from concurrent suites. */
export async function seedThemeReportFixtures(prefix: string) {
  readEmulatorAccessConfig();
  const range = salesReportDateRange(REPORT_DAY, REPORT_DAY);
  if (!range) throw new RangeError('Invalid date for sales report fixtures.');
  const accountId = prefix + '-report-channel';
  const accountName = prefix + ' Loja';
  const { outgoing, other } = reportOrders(prefix);
  const orders = [...outgoing, ...other];
  const batch = db().batch();
  batch.set(db().collection('integracao').doc(accountId), {
    nome: accountName,
    tipo: INTEGRACAO_TIPO.balcao,
    ativo: false,
  });
  for (const { id, estado, price, variant } of orders) {
    const timestamps = {
      legacy: range.startUs / 1000,
      outgoing: range.endExclusiveUs - 1,
      before: range.startUs - 1,
      after: range.endExclusiveUs / 1000,
      'other-channel': range.startUs,
      incoming: range.startUs,
    };
    const { ehSaida, ...order } = pedidoSchema.parse({
      estado,
      ehSaida: variant !== 'incoming',
      ultimaModificacao: millisToMicros(Date.now()),
      valorCobrado: price + 10,
      itens: { NONE: [{ quantidade: 2, precoDeVenda: price / 2 + 2, descontoUnitario: 2 }] },
    });
    batch.set(db().collection('pedidos').doc(id), {
      ...order,
      timestamp: timestamps[variant],
      integracaoPedidoOuterRef:
        variant === 'legacy'
          ? 'integracao/' + accountId
          : 'documents/integracao/' +
            (variant === 'other-channel' ? accountId + '-other' : accountId),
      ...(variant === 'legacy' ? {} : { ehSaida }),
    });
  }
  await batch.commit();
  await Promise.all(orders.map(({ id, estado }) => expectReportOrderCreationSettled(id, estado)));
  return {
    day: REPORT_DAY,
    accountLabel: `${accountName} (${INTEGRACAO_TIPO_LABELS[INTEGRACAO_TIPO.balcao]}) — inativo`,
    total: outgoing.length,
    incomingRevenue: other.find(({ variant }) => variant === 'incoming')!.price,
    states: REPORT_STATES.map(({ estado, count, price }) => ({
      estado,
      label: ESTADO_PEDIDO_LABELS[estado],
      bucketLabel: ESTADO_BUCKET_LABELS[bucketOf(estado)],
      count,
      revenue: count * price,
    })),
  };
}

/** Delete only this worker's orders and wait for deletion history before sweeping descendants. */
export async function cleanupThemeReportFixtures(prefix: string): Promise<void> {
  readEmulatorAccessConfig();
  const { outgoing, other } = reportOrders(prefix);
  await Promise.all([
    db()
      .collection('integracao')
      .doc(prefix + '-report-channel')
      .delete(),
    ...[...outgoing, ...other].map(async ({ id, estado }) => {
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
  ]);
}

const CHECKOUT_FIXTURE_COUNT = 3;

function checkoutFixture(prefix: string) {
  return {
    userId: `${prefix}-checkout-colaborador`,
    pedidoId: `${prefix}-checkout-pedido`,
    // One unbreakable token far wider than the chart's 180px user axis: the
    // shape of the e2e collaborator id that clipped the staging report.
    nome: `${prefix}-colaborador-com-um-nome-sem-espacos`,
  };
}

/**
 * A collaborator with three checkouts today, so the default (current month)
 * checkouts report always ranks and names them, whatever else the run wrote.
 * No parent pedido: the report reads the `checkout` collection group, and a
 * bare subcollection fires no pedido trigger whose history cleanup must await.
 */
export async function seedThemeCheckoutFixtures(prefix: string) {
  readEmulatorAccessConfig();
  const { userId, pedidoId, nome } = checkoutFixture(prefix);
  const batch = db().batch();
  batch.set(
    db().collection('usuarios').doc(userId),
    usuarioSchema.parse({ nome, colaborador: true }),
  );
  for (let index = 0; index < CHECKOUT_FIXTURE_COUNT; index += 1) {
    batch.set(
      db()
        .collection('pedidos')
        .doc(pedidoId)
        .collection('checkout')
        .doc(`${prefix}-checkout-${index}`),
      checkoutFretePedidoSchema.parse({
        usuarioCheckoutFretePedidoOuterRef: `documents/usuarios/${userId}`,
        timestamp: Date.now() - 1000 * (index + 1),
        freteNoMomentoDoCheckout: seedFreteInicial(MODALIDADE_FRETE.semTransporte, true),
      }),
    );
  }
  await batch.commit();
  return { nome, count: CHECKOUT_FIXTURE_COUNT };
}

export async function cleanupThemeCheckoutFixtures(prefix: string): Promise<void> {
  readEmulatorAccessConfig();
  const { userId, pedidoId } = checkoutFixture(prefix);
  const result = await deleteDocumentSubtree(db(), db().collection('pedidos').doc(pedidoId));
  expect(result.failedDeletes, `Delete checkout fixtures under ${pedidoId}`).toBe(0);
  expect(result.truncated).toBe(false);
  await db().collection('usuarios').doc(userId).delete();
}
