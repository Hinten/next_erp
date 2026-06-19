import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import { cleanupPedidoFixtures, e2ePrefix, seedPedidoFixtures } from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * E2E for the Incidentes tab: adding an incidente writes a doc to the
 * `pedidos/{id}/incidentes` subcollection (immediate write, no main-form save).
 * Seeds a minimal pedido via the Admin SDK, then drives the UI.
 */
test.describe.serial('Pedidos e2e — Incidentes', () => {
  const prefix = e2ePrefix('pedinc');
  const pedidoId = `${prefix}-001`;
  let fixtures: Awaited<ReturnType<typeof seedPedidoFixtures>>;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    fixtures = await seedPedidoFixtures(prefix);
    const produtoId = fixtures.produtoPath.split('/')[1]!;

    await db()
      .collection('pedidos')
      .doc(pedidoId)
      .set({
        ehSaida: true,
        estado: 'iniciado',
        numero: pedidoId,
        integracaoPedidoOuterRef: `documents/${fixtures.integracaoPath}`,
        clientePedidoOuterRef: `documents/${fixtures.clientePath}`,
        operacaoPedidoOuterRef: `documents/${fixtures.operacaoPath}`,
        itens: {
          [produtoId]: [
            {
              produtoUid: produtoId,
              ordem: 1,
              sku: fixtures.produtoSku,
              nomeDeVenda: fixtures.produtoNome,
              precoDeVenda: 10,
              descontoUnitario: 0,
              quantidade: 1,
              custo: null,
            },
          ],
        },
        itensIds: [produtoId],
        descontoTotal: 0,
        valorCobrado: 10,
        timestamp: Date.now() * 1000,
      });

    await warmRoutes(browser, ['/pedidos']);
  });

  // Clear the subcollection before each attempt so a retry can't see a card left
  // by a prior attempt whose write persisted (which would duplicate the motivo).
  test.beforeEach(async () => {
    const inc = await db().collection('pedidos').doc(pedidoId).collection('incidentes').get();
    await Promise.all(inc.docs.map((d) => d.ref.delete()));
  });

  test.afterAll(async () => {
    const inc = await db().collection('pedidos').doc(pedidoId).collection('incidentes').get();
    await Promise.all(inc.docs.map((d) => d.ref.delete()));
    await cleanupPedidoFixtures(prefix);
  });

  test('adds an incidente and persists it to the subcollection', async ({ page }) => {
    const motivo = `${prefix}-motivo`;
    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('tab', { name: 'Incidentes' }).click();
    await page.getByRole('button', { name: /Adicionar incidente/ }).click();
    // tipo defaults to "Devolução"; fill the Motivo and save.
    await page.getByRole('textbox', { name: 'Motivo', exact: true }).fill(motivo);
    await page.getByRole('button', { name: 'Salvar', exact: true }).click();

    // The new incidente card shows the motivo. Scope to the card's paragraph:
    // the form stays open (immediate write, button spins until the server ack),
    // and its Motivo <textarea> echoes the same text — a bare getByText would
    // match both and strict-fail.
    await expect(page.getByRole('paragraph').filter({ hasText: motivo })).toBeVisible({
      timeout: 15_000,
    });

    // And the subcollection has the doc with tipo 'returns' (Devolução).
    await expect
      .poll(
        async () => {
          const snap = await db()
            .collection('pedidos')
            .doc(pedidoId)
            .collection('incidentes')
            .get();
          return snap.docs.map((d) => d.data().motivoDoIncidente as string);
        },
        { timeout: 15_000 },
      )
      .toContain(motivo);
  });
});
