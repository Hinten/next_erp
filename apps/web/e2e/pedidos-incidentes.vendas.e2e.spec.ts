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

    // The new incidente card shows the motivo. The card text is a Mantine <Text>
    // (a <p>); the editing form's Motivo <textarea> echoes the same string, so a
    // bare getByText would match both and strict-fail. A `p` tag locator targets
    // only the card text and excludes the textarea, regardless of whether the
    // save form has closed yet.
    await expect(page.locator('p').filter({ hasText: motivo })).toBeVisible({
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

  test('records a resolução (tipo + despesa) on the incidente', async ({ page }) => {
    const motivo = `${prefix}-res`;
    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('tab', { name: 'Incidentes' }).click();
    await page.getByRole('button', { name: /Adicionar incidente/ }).click();
    await page.getByRole('textbox', { name: 'Motivo', exact: true }).fill(motivo);

    // Enable the resolução section, pick a Tipo and enter a Despesa. The
    // Incidentes tabpanel has a single switch, so select it by role within the
    // panel rather than by accessible name (Mantine's label wiring is unreliable).
    await page.getByRole('tabpanel').getByRole('switch').click();
    await page.getByRole('combobox', { name: 'Tipo de resolução', exact: true }).click();
    await page
      .getByRole('option', { name: 'Pagamento devolvido integralmente', exact: true })
      .click();
    await page.getByLabel('Despesa da resolução').fill('15');

    await page.getByRole('button', { name: 'Salvar', exact: true }).click();

    // The card shows the green resolução badge. Scope to the tabpanel: a closed
    // Mantine Select can leave option spans in a body-level portal, and the Select
    // input still holds the same label — both would strict-fail a bare getByText.
    await expect(
      page.getByRole('tabpanel').getByText('Pagamento devolvido integralmente', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // The persisted doc carries the resolução sub-object (tipo 3, valor 15).
    await expect
      .poll(
        async () => {
          const snap = await db()
            .collection('pedidos')
            .doc(pedidoId)
            .collection('incidentes')
            .get();
          const inc = snap.docs.map((d) => d.data()).find((d) => d.motivoDoIncidente === motivo);
          const res = inc?.resolucao as { tipo?: number; valor?: number } | undefined;
          return res ? { tipo: res.tipo, valor: res.valor } : null;
        },
        { timeout: 15_000 },
      )
      .toEqual({ tipo: 3, valor: 15 });
  });
});
