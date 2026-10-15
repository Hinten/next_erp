import { expect, test, type Page } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import {
  cleanupPedidoFreteFixtures,
  e2ePrefix,
  seedPedidoFreteFixtures,
} from './_helpers/seed-data';
import { applyTextFilter, expectRowVisible } from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

const TRACKING_URL = 'https://tracking.example/track?pedido=01&nfiscal=1';

async function openFreightPopover(page: Page, pedidoId: string) {
  await page.goto('/pedidos');
  await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
  await applyTextFilter(page, 'Número', pedidoId);
  await expectRowVisible(page, pedidoId);
  const row = page.getByRole('row', { name: new RegExp(pedidoId) });
  const rastrear = page.getByRole('button', { name: 'Rastrear', exact: true });
  await expect(async () => {
    await row.getByText('Postado', { exact: true }).hover();
    await expect(rastrear).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  return rastrear;
}

test.describe.serial('Pedidos — rastreio Mercado Livre', () => {
  const prefix = e2ePrefix('rml');
  let fixtures: Awaited<ReturnType<typeof seedPedidoFreteFixtures>>;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    fixtures = await seedPedidoFreteFixtures(prefix);
    await warmRoutes(browser, ['/pedidos', `/pedidos/${fixtures.mktPedidoId}/editar`]);
  });
  test.afterAll(async () => {
    await cleanupPedidoFreteFixtures(prefix);
  });

  test('opens carrier tracking from the order row and Frete tab without printing or changing freight', async ({
    page,
  }) => {
    const requests: string[] = [];
    const printing: string[] = [];
    await page.context().route('https://tracking.example/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<p>Carrier tracking</p>',
      });
    });
    await page.route('**/api/marketplace/mercado-livre/rastreio**', async (route) => {
      requests.push(route.request().url());
      await route.fulfill({ status: 200, json: { name: 'Carrier', url: TRACKING_URL } });
    });
    await page.route('**/api/marketplace/mercado-livre/etiqueta**', async (route) => {
      printing.push(route.request().url());
      await route.fulfill({ status: 500, json: { error: 'Unexpected label request' } });
    });
    await page.route('http://localhost:8888/**', async (route) => {
      printing.push(route.request().url());
      await route.fulfill({ status: 500, body: 'Unexpected print job' });
    });

    const rastrear = await openFreightPopover(page, fixtures.mktPedidoId);
    const ref = db().collection('pedidos').doc(fixtures.mktPedidoId);
    const before = (await ref.get()).data();
    const rowPopup = page.waitForEvent('popup');
    await rastrear.click();
    const rowTab = await rowPopup;
    await expect(rowTab).toHaveURL(TRACKING_URL);
    expect(await rowTab.evaluate(() => window.opener === null)).toBe(true);
    await rowTab.close();

    await page.goto(`/pedidos/${fixtures.mktPedidoId}/editar`);
    await page.getByRole('tab', { name: 'Frete', exact: true }).click();
    await expect(page.getByLabel('Código de rastreio')).toBeDisabled();
    const detailPopup = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Rastrear', exact: true }).click();
    const detailTab = await detailPopup;
    await expect(detailTab).toHaveURL(TRACKING_URL);
    await detailTab.close();

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(new URL(request).searchParams.get('pedidoId')).toBe(fixtures.mktPedidoId);
    }
    expect(printing).toEqual([]);
    const after = (await ref.get()).data();
    expect(after?.freteInicial).toEqual(before?.freteInicial);
    expect(after?.estado).toEqual(before?.estado);
  });

  test('shows unavailable tracking without navigating to a carrier', async ({ page }) => {
    await page.route('**/api/marketplace/mercado-livre/rastreio**', async (route) => {
      await route.fulfill({
        status: 409,
        json: {
          error: 'Rastreamento ainda indisponível.',
          code: 'ML_RASTREIO_INDISPONIVEL',
        },
      });
    });
    const rastrear = await openFreightPopover(page, fixtures.mktPedidoId);
    await rastrear.click();
    await expect(page.getByText('Rastreamento ainda indisponível.', { exact: true })).toBeVisible();
    await expect.poll(() => page.context().pages().length).toBe(1);
  });
});
