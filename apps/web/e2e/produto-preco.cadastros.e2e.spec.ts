import { expect, test, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  e2ePrefix,
  getProdutoData,
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
 * The automatic modification-history records and the parent→children precos
 * propagation are owned by the produto-write Cloud Function trigger, which
 * writes the unified `historicoDeModificacoes` subcollection the cost-history
 * modal reads. This suite does NOT assert them: the trigger IS deployed on
 * staging, so what the modal shows depends on whichever concurrent specs also
 * touched the produto, which is not a stable assertion. `produto-preco.emulator.e2e.spec.ts`
 * covers the trigger's real output deterministically instead.
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
      // Legacy subcollections nothing writes anymore — harmless no-ops today,
      // kept in case a stray write ever lands there again.
      cleanupProdutoSubcollection(parentId, 'historicoDePrecos'),
      cleanupProdutoSubcollection(parentId, 'historicoDeCusto'),
      cleanupProdutoSubcollection(childId, 'historicoDePrecos'),
      // The unified history subcollection the modal reads — empty today (no
      // deployed trigger on staging), but not once it is.
      cleanupProdutoSubcollection(parentId, 'historicoDeModificacoes'),
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
