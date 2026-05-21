import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import {
  cleanupPedidoFixtures,
  e2ePrefix,
  seedPedidoFixtures,
} from './_helpers/seed-data';
import { fillField } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/pedidos/novo` + edit flow. Seeds the
 * minimal cliente + operação + integração + produto a pedido needs,
 * then exercises:
 *   - creating a pedido by picking each ref and adding one item via
 *     the produto picker;
 *   - asserting the totals footer renders the expected subtotal;
 *   - landing on the edit URL after save and confirming the doc is
 *     committed (Admin SDK read-back);
 *   - editing `observacoesInternas`, reloading and verifying it
 *     persisted.
 *
 * Runs serially — later steps consume earlier state.
 */
test.describe.serial('Pedidos e2e — novo + editar', () => {
  const prefix = e2ePrefix('ped');
  // Mutable holder for cross-test state — created pedido id from the
  // create step is reused by the edit step.
  const state: { pedidoId?: string } = {};

  let fixtures: Awaited<ReturnType<typeof seedPedidoFixtures>>;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    fixtures = await seedPedidoFixtures(prefix);
    await warmRoutes(browser, [
      '/pedidos',
      '/pedidos/novo',
    ]);
  });

  test.afterAll(async () => {
    await cleanupPedidoFixtures(prefix);
  });

  test('renders /pedidos/novo with empty defaults', async ({ page }) => {
    await page.goto('/pedidos/novo');
    await expect(
      page.getByRole('heading', { name: 'Novo pedido' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Fiscal' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Frete' })).toBeVisible();
  });

  test('creates a new pedido picking cliente, operação, integração and one item', async ({
    page,
  }) => {
    await page.goto('/pedidos/novo');

    // Cliente picker — open dropdown, type the prefix, choose first row.
    await page
      .getByPlaceholder('Buscar cliente por nome…')
      .fill(fixtures.clienteNome);
    await page
      .getByRole('option', { name: new RegExp(fixtures.clienteNome) })
      .first()
      .click();

    // Operação picker — Mantine searchable Select. Opens via the
    // combobox with label "Operação fiscal".
    await page
      .getByRole('textbox', { name: 'Operação fiscal' })
      .click();
    await page
      .getByRole('option', { name: fixtures.operacaoNome })
      .click();

    // Integração picker — same shape.
    await page
      .getByRole('textbox', { name: 'Integração' })
      .click();
    await page
      .getByRole('option', { name: fixtures.integracaoNome })
      .click();

    // Add one item via the produto picker. Trigger search then pick.
    await page
      .getByPlaceholder('Adicionar item por busca…')
      .fill(fixtures.produtoNome);
    await page
      .getByRole('option', { name: new RegExp(fixtures.produtoNome) })
      .first()
      .click();

    // The row appears in the items table — set quantidade=2,
    // descontoUnitario=1.5, precoDeVenda=10. The row's NumberInputs
    // carry per-row aria-labels so we can target them deterministically.
    const priceInput = page.getByLabel('Preço item 1', { exact: true });
    const qtyInput = page.getByLabel('Quantidade item 1', { exact: true });
    const discountInput = page.getByLabel('Desconto item 1', { exact: true });
    await priceInput.fill('10');
    await priceInput.blur();
    await qtyInput.fill('2');
    await qtyInput.blur();
    await discountInput.fill('1,5');
    await discountInput.blur();

    // Expected subtotal: (10 - 1.5) * 2 = 17.00. Mantine money format
    // renders R$ 17,00; assert the footer Total/Subtotal contains it.
    await expect(page.getByText(/17,00/)).toBeVisible();

    await page.getByRole('button', { name: 'Criar' }).click();

    // After create we redirect to /pedidos/{id}/editar.
    await page.waitForURL(
      (url) => /\/pedidos\/[^/]+\/editar$/.test(url.pathname),
      { timeout: 30_000 },
    );

    const match = page.url().match(/\/pedidos\/([^/]+)\/editar/);
    if (!match) throw new Error(`Unexpected URL after create: ${page.url()}`);
    state.pedidoId = match[1];

    // Confirm the doc actually committed (Admin SDK is strongly
    // consistent) so the next step doesn't race the write.
    await expect
      .poll(
        async () => {
          const snap = await db()
            .collection('pedidos')
            .doc(state.pedidoId!)
            .get();
          return snap.exists;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  });

  test('edit page reloads the just-created pedido and persists observações', async ({
    page,
  }) => {
    test.skip(!state.pedidoId, 'Create step did not produce a pedido id.');
    const pedidoId = state.pedidoId!;

    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(
      page.getByRole('heading', { name: 'Editar pedido' }),
    ).toBeVisible({ timeout: 15_000 });

    // Observations textarea — fill, save, reload, assert.
    const obs = `${prefix}-observacao-${Date.now()}`;
    await fillField(page, 'Observações internas', obs);
    await page
      .getByRole('button', { name: 'Salvar alterações' })
      .click();

    await page.waitForURL(`**/pedidos/${pedidoId}`, { timeout: 30_000 });

    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(
      page.getByLabel('Observações internas', { exact: true }),
    ).toHaveValue(obs);
  });
});
