import { expect, test, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  e2ePrefix,
  getProdutoData,
  seedHistoricoCusto,
  seedListasDePreco,
  seedProdutoComFilho,
} from './_helpers/seed-data';
import { clickSave, typeMoney } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the produto "Preço e custo" tab: price-per-lista
 * editing (Flutter `precos` map wire shape), the formula recalc engine, the
 * read-only custo-history modal and the min-price/staged-removal validation.
 * Runs serially — later tests build on the prices written by earlier ones.
 *
 * The automatic price/custo-history records and the parent→children precos
 * propagation are now owned by the produto-write Cloud Function trigger —
 * staging has no deployed functions, so those effects are covered by
 * `produto-preco.emulator.e2e.spec.ts` instead.
 */
test.describe.serial('Produtos preço/custo e2e — Preço e custo tab', () => {
  const prefix = e2ePrefix('prod-preco');
  let parentId = '';
  let childId = '';
  let varejoId = '';
  let varejoNome = '';
  let atacadoNome = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const [produto, listas] = await Promise.all([
      seedProdutoComFilho(prefix),
      seedListasDePreco(prefix),
      warmRoutes(browser, ['/produtos/__aquecimento__/editar']),
    ]);
    parentId = produto.parentId;
    childId = produto.childId;
    varejoId = listas.varejoId;
    varejoNome = listas.varejoNome;
    atacadoNome = listas.atacadoNome;
  });

  test.afterAll(async () => {
    await Promise.all([
      cleanupProdutoSubcollection(parentId, 'historicoDePrecos'),
      cleanupProdutoSubcollection(parentId, 'historicoDeCusto'),
      cleanupProdutoSubcollection(childId, 'historicoDePrecos'),
    ]);
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupByNamePrefix('listaDePrecos', prefix);
  });

  async function openPrecoTab(page: Page) {
    await page.goto(`/produtos/${parentId}/editar`);
    await page.getByRole('tab', { name: 'Preço e custo' }).click();
    await expect(page.getByRole('textbox', { name: varejoNome })).toBeVisible({
      timeout: 15_000,
    });
  }

  test('writes and updates the precos map wire shape', async ({ page }) => {
    await openPrecoTab(page);
    await typeMoney(page, varejoNome, '30');
    await clickSave(page, 'Salvar alterações');

    await expect
      .poll(async () => (await getProdutoData(parentId))?.precos, { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 30 } });

    // A later change persists too — not just the initial add. (History
    // recording is the produto-write trigger's job now — see
    // produto-preco.emulator.e2e.spec.ts.)
    await openPrecoTab(page);
    await typeMoney(page, varejoNome, '35');
    await clickSave(page, 'Salvar alterações');
    await expect
      .poll(async () => (await getProdutoData(parentId))?.precos, { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 35 } });
  });

  test('recalculates the price from custo via the lista formulas', async ({ page }) => {
    await openPrecoTab(page);
    // Custo typed but UNSAVED must feed the recalc (live form read).
    await typeMoney(page, 'Custo', '10');

    // The formula-less lista cannot recalc; the varejo one can.
    await expect(page.getByRole('button', { name: `Recalcular ${atacadoNome}` })).toBeDisabled();
    await page.getByRole('button', { name: `Recalcular ${varejoNome}` }).click();

    // C*L+T = 10*2+5 → the input takes the computed value.
    await expect(page.getByRole('textbox', { name: varejoNome })).toHaveValue(/25/);
    await clickSave(page, 'Salvar alterações');
    await expect
      .poll(async () => (await getProdutoData(parentId))?.precos, { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 25 } });
  });

  test('shows a seeded cost-history record in the modal', async ({ page }) => {
    // Cost-history recording is the produto-write trigger's job now (see
    // produto-preco.emulator.e2e.spec.ts) — this test only proves the modal
    // renders a record that's already there, seeded directly the way the
    // still-live legacy Flutter app also writes these.
    await seedHistoricoCusto(parentId, 8.5);
    await openPrecoTab(page);
    await page.getByRole('button', { name: 'Histórico de custo' }).click();
    await expect(page.getByText(/8,50/)).toBeVisible({ timeout: 15_000 });
  });

  test('rejects a price of 0 (min R$ 0,01) without silently dropping it', async ({ page }) => {
    await openPrecoTab(page);
    await typeMoney(page, varejoNome, '0');
    await clickSave(page, 'Salvar alterações');
    // Validation blocks the save and shows the row error — the value is NOT
    // silently dropped, and the persisted price stays at 25 (the recalc test above).
    await expect(page.getByText(/preço mínimo é R\$ 0,01/)).toBeVisible({ timeout: 10_000 });
    expect((await getProdutoData(parentId))?.precos).toEqual({ [varejoId]: { valor: 25 } });
  });

  test('removes a price only via the trash button (staged), applied on save', async ({ page }) => {
    await openPrecoTab(page);
    await page.getByRole('button', { name: `Remover preço ${varejoNome}` }).click();
    await clickSave(page, 'Salvar alterações');
    await expect
      .poll(async () => (await getProdutoData(parentId))?.precos, { timeout: 15_000 })
      .toBeNull();
  });
});
