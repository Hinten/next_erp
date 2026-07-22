import { expect, test } from '@playwright/test';
import {
  cleanupPedidoAnexosFixtures,
  e2ePrefix,
  seedPedidoAnexosFixtures,
} from './_helpers/seed-data';
import { applyTextFilter, expectRowVisible, selectRowByText } from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * E2E for #550 — bulk "Download Anexos" on `/pedidos`.
 *
 * Seeds a variation line item whose parent carries one anexo, plus a pedido
 * with no anexos. The arquivo URL is a fake host; we `page.route` it so the
 * download does not depend on Storage/CORS. IndexedDB cache is asserted via
 * `page.evaluate` against the Next-owned `delfrance-arquivo-cache` DB.
 */
test.describe.serial('Pedidos e2e — Download Anexos', () => {
  const prefix = e2ePrefix('anex');
  let fixtures: Awaited<ReturnType<typeof seedPedidoAnexosFixtures>>;
  /** Tiny PDF-ish payload fulfilled by the route mock. */
  const payload = Buffer.from('%PDF-1.4 e2e-anexo-fixture\n');

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    fixtures = await seedPedidoAnexosFixtures(prefix);
    await warmRoutes(browser, ['/pedidos']);
  });

  test.afterAll(async () => {
    if (fixtures) await cleanupPedidoAnexosFixtures(prefix, fixtures.arquivoId);
  });

  test('downloads the parent anexo for a variation line item', async ({ page }) => {
    let networkHits = 0;
    await page.route(fixtures.arquivoUrl, async (route) => {
      networkHits += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: payload,
      });
    });

    await page.goto('/pedidos');
    await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

    await applyTextFilter(page, 'Número', fixtures.withAnexoNumero);
    await expectRowVisible(page, fixtures.withAnexoNumero);
    await selectRowByText(page, fixtures.withAnexoNumero);

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Download Anexos', exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(fixtures.arquivoFileName);
    expect(networkHits).toBe(1);

    // IndexedDB cache entry for this arquivo id.
    const cached = await page.evaluate(async (arquivoId) => {
      return new Promise<boolean>((resolve, reject) => {
        const req = indexedDB.open('delfrance-arquivo-cache', 1);
        req.onerror = () => reject(req.error ?? new Error('idb open failed'));
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('arquivos')) {
            db.close();
            resolve(false);
            return;
          }
          const tx = db.transaction('arquivos', 'readonly');
          const getReq = tx.objectStore('arquivos').get(arquivoId);
          getReq.onsuccess = () => {
            const val = getReq.result as { bytes?: ArrayBuffer } | undefined;
            db.close();
            resolve(!!val && val.bytes instanceof ArrayBuffer);
          };
          getReq.onerror = () => {
            db.close();
            reject(getReq.error ?? new Error('idb get failed'));
          };
        };
      });
    }, fixtures.arquivoId);
    expect(cached).toBe(true);

    // Second run: still downloads for the user, but no extra network fetch.
    networkHits = 0;
    await selectRowByText(page, fixtures.withAnexoNumero);
    const download2Promise = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Download Anexos', exact: true }).click();
    await download2Promise;
    expect(networkHits).toBe(0);
  });

  test('shows an empty notification when the pedido has no anexos', async ({ page }) => {
    await page.goto('/pedidos');
    await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

    await applyTextFilter(page, 'Número', fixtures.noAnexoNumero);
    await expectRowVisible(page, fixtures.noAnexoNumero);
    await selectRowByText(page, fixtures.noAnexoNumero);

    // No download should fire.
    let gotDownload = false;
    page.once('download', () => {
      gotDownload = true;
    });

    await page.getByRole('button', { name: 'Download Anexos', exact: true }).click();
    await expect(page.getByText(/Nenhum anexo encontrado/i)).toBeVisible({ timeout: 15_000 });
    // Brief settle so a late download event would have landed.
    await page.waitForTimeout(500);
    expect(gotDownload).toBe(false);
  });
});
