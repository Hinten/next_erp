import { expect, test } from '@playwright/test';
import { cleanupPedidoWithNFe, e2ePrefix, seedPedidoWithNFe } from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * A cancelada / numeração-inutilizada NF-e closes the pedido's fiscal lifecycle
 * at SEFAZ, so the editor must lock the Fiscal tab AND the Pagamento tab (legacy
 * `travar_fiscal` + `canSavePagamentos`). Seed a pedido with a `cancelada` NF-e
 * and assert both tabs render their lock notice and disable editing.
 */
test.describe.serial('Pedido editor — NF-e cancelada locks fiscal + pagamento', () => {
  const prefix = e2ePrefix('nfelock');
  let pedidoId = '';

  test.beforeAll(async ({ browser }) => {
    // First-load route compilation can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    const seeded = await seedPedidoWithNFe(prefix, 1, 'c'); // 'c' = cancelada
    pedidoId = seeded.pedidoId;
    await warmRoutes(browser, ['/pedidos']);
  });

  test.afterAll(async () => {
    if (pedidoId) await cleanupPedidoWithNFe(pedidoId);
  });

  test('locks the Fiscal and Pagamento tabs when the latest NF-e is cancelada', async ({
    page,
  }) => {
    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Fiscal' })).toBeVisible({ timeout: 15_000 });

    // Fiscal: lock notice + a fiscal field disabled.
    await page.getByRole('tab', { name: 'Fiscal' }).click();
    await expect(page.getByText(/Dados fiscais bloqueados/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByLabel(/Informações complementares/)).toBeDisabled();

    // Pagamento: lock notice + "add payment" disabled.
    await page.getByRole('tab', { name: 'Pagamento' }).click();
    await expect(page.getByText(/Pagamentos bloqueados/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: /Adicionar pagamento/ })).toBeDisabled();
  });
});
