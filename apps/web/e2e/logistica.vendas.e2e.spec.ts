import { expect, test } from '@playwright/test';
import {
  cleanupIntFreteFixtures,
  docExistsByName,
  e2ePrefix,
  getIntFreteByName,
  intFreteFaixaCount,
  seedIntFreteFixtures,
} from './_helpers/seed-data';
import { expectRowHidden, expectRowVisible } from './helpers/table-view';
import { clickSave, confirmDelete, fillField, selectFieldWithSearch } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/logistica/*` slices of the `int_frete`
 * collection (tipo-discriminated, same pattern as `/canais/balcao`). The
 * motoboy slice gets the full CRUD pass — it exercises the FaixaCepEditor's
 * staged deletion — and the retirada slice gets a slice-isolation check.
 *
 * Wire-compat assertions ride along: a UI-created doc must carry the Flutter
 * shapes F1 pinned (`documents/filiais/<id>` STRING ref, ms-epoch
 * `dataCadastro`).
 */
test.describe.serial('Logística e2e — int_frete TableView / ObjectView', () => {
  const prefix = e2ePrefix('log');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    await Promise.all([
      seedIntFreteFixtures(prefix, 4),
      warmRoutes(browser, [
        '/logistica/motoboy',
        '/logistica/motoboy/novo',
        '/logistica/motoboy/__aquecimento__',
        '/logistica/retirada',
      ]),
    ]);
  });

  test.afterAll(async () => {
    await cleanupIntFreteFixtures(prefix);
  });

  test('motoboy list shows only motoboy rows', async ({ page }) => {
    await page.goto('/logistica/motoboy');
    await expect(page.getByRole('heading', { name: 'Motoboy' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
    await expectRowVisible(page, row(1));
    await expectRowVisible(page, row(4));
    // The retirada fixture lives in the same collection but another slice.
    await expectRowHidden(page, `${prefix}-ret-001`);
  });

  test('retirada list shows only retirada rows', async ({ page }) => {
    await page.goto('/logistica/retirada');
    await expect(page.getByRole('heading', { name: 'Retirada na loja' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expectRowVisible(page, `${prefix}-ret-001`);
    await expectRowHidden(page, row(1));
  });

  test('creates a motoboy writing Flutter wire shapes', async ({ page }) => {
    const nome = `${prefix}-novo`;
    await page.goto('/logistica/motoboy/novo');
    await fillField(page, 'Nome', nome);
    await selectFieldWithSearch(page, 'Filial', `${prefix}-ref-filial`);
    await clickSave(page, 'Criar');

    await page.waitForURL(
      (url) =>
        /^\/logistica\/motoboy\/[^/]+$/.test(url.pathname) &&
        url.pathname !== '/logistica/motoboy/novo',
      { timeout: 15_000 },
    );
    await expect.poll(() => docExistsByName('int_frete', nome), { timeout: 15_000 }).toBe(true);

    // Byte-compat checks: tipo pinned, ms-epoch dataCadastro, STRING doc-path
    // filial ref in the Flutter-ODM format.
    const data = await getIntFreteByName(nome);
    expect(data?.tipo).toBe('motoboy');
    expect(typeof data?.dataCadastro).toBe('number');
    expect(data?.filialIntegracaoFreteOuterRef).toBe(`documents/filiais/${prefix}-ref-filial`);
    expect(data?.prazoExtra).toBe(0);

    await page.goto('/logistica/motoboy');
    await expectRowVisible(page, nome);
  });

  test('opens an existing motoboy from the list', async ({ page }) => {
    await page.goto('/logistica/motoboy');
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/logistica\/motoboy\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
    // The faixaCep editor lives on its own tab; the seeded rows render there.
    await page.getByRole('tab', { name: 'Faixas de CEP' }).click();
    await expect(page.getByLabel('CEP Inicial 1')).toHaveValue('01000000');
    await expect(page.getByLabel('CEP Inicial 2')).toHaveValue('02000000');
  });

  test('adds a faixa de CEP and saves', async ({ page }) => {
    await page.goto(`/logistica/motoboy/${row(3)}`);
    await page.getByRole('tab', { name: 'Faixas de CEP' }).click();
    await expect(page.getByLabel('CEP Inicial 1')).toHaveValue('01000000');
    await page.getByRole('button', { name: 'Adicionar faixa' }).click();
    await page.getByLabel('CEP Inicial 3').fill('03000000');
    await page.getByLabel('CEP Final 3').fill('03999999');
    await page.getByLabel('Preço 3').fill('30');
    await page.getByLabel('Prazo 3').fill('3');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/logistica\/motoboy$/, { timeout: 15_000 });

    await expect.poll(() => intFreteFaixaCount(row(3)), { timeout: 15_000 }).toBe(3);
  });

  test('staged deletion: marked faixa survives until save, then is dropped', async ({ page }) => {
    await page.goto(`/logistica/motoboy/${row(4)}`);
    await page.getByRole('tab', { name: 'Faixas de CEP' }).click();
    await expect(page.getByLabel('CEP Inicial 1')).toHaveValue('01000000');

    await page.getByRole('button', { name: 'Excluir faixa 1' }).click();
    await expect(page.getByText('Será excluída')).toBeVisible();
    // Nothing committed yet — the doc still has both rows.
    expect(await intFreteFaixaCount(row(4))).toBe(2);

    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/logistica\/motoboy$/, { timeout: 15_000 });
    await expect.poll(() => intFreteFaixaCount(row(4)), { timeout: 15_000 }).toBe(1);
  });

  test('deletes a motoboy through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/logistica/motoboy/${row(1)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/logistica\/motoboy$/, { timeout: 15_000 });
    await expectRowHidden(page, row(1));
  });
});
