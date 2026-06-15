import { expect, test, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  e2ePrefix,
  getProdutoData,
  listHistoricoCusto,
  listHistoricoPrecos,
  seedHistoricoCusto,
  seedListasDePreco,
  seedProdutoComFilho,
} from './_helpers/seed-data';
import { clickSave, typeMoney } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the produto "Preço e custo" tab: price-per-lista
 * editing (Flutter `precos` map wire shape), the automatic price-history
 * records, the formula recalc engine, the price propagation to variation
 * children and the read-only custo history. Runs serially — later tests
 * build on the prices written by earlier ones.
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

  test('writes the precos map wire shape and the initial history record', async ({ page }) => {
    await openPrecoTab(page);
    await typeMoney(page, varejoNome, '30');
    await clickSave(page, 'Salvar alterações');

    await expect
      .poll(async () => (await getProdutoData(parentId))?.precos, { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 30 } });

    // Flutter parity: a price added from nothing records valorFinal only.
    await expect
      .poll(async () => (await listHistoricoPrecos(parentId)).length, { timeout: 15_000 })
      .toBe(1);
    const [record] = await listHistoricoPrecos(parentId);
    expect(record).toMatchObject({ valorOriginal: null, valorFinal: 30 });
    expect(String(record!.listaDePrecoHistoricoOuterRef).split('/').pop()).toBe(varejoId);
    expect(typeof record!.timestamp).toBe('number');
  });

  test('records valorOriginal → valorFinal on a price change', async ({ page }) => {
    await openPrecoTab(page);
    await typeMoney(page, varejoNome, '35');
    await clickSave(page, 'Salvar alterações');

    await expect
      .poll(
        async () =>
          (await listHistoricoPrecos(parentId)).some(
            (r) => r.valorOriginal === 30 && r.valorFinal === 35,
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
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
    // The recalc save must propagate the new price to the variation child too.
    await expect
      .poll(async () => (await getProdutoData(childId))?.precos, { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 25 } });
  });

  test('propagates the parent prices to variation children on save', async ({ page }) => {
    // The flush runs on every save — by now the child must mirror the parent.
    await expect
      .poll(async () => (await getProdutoData(childId))?.precos, { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 25 } });

    // And a fresh save keeps them in sync after another change.
    await openPrecoTab(page);
    await typeMoney(page, varejoNome, '40');
    await clickSave(page, 'Salvar alterações');
    await expect
      .poll(async () => (await getProdutoData(childId))?.precos, { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 40 } });
  });

  test('records cost history on a custo change and shows it', async ({ page }) => {
    // The recalc test above saved custo=10 → a historicoDeCusto record must
    // have been written (the write fix). Then a seeded record shows in the modal.
    await expect
      .poll(async () => (await listHistoricoCusto(parentId)).some((r) => r.valor === 10), {
        timeout: 15_000,
      })
      .toBe(true);

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
    // silently dropped, and the persisted price stays at 40 (from the test above).
    await expect(page.getByText(/preço mínimo é R\$ 0,01/)).toBeVisible({ timeout: 10_000 });
    expect((await getProdutoData(parentId))?.precos).toEqual({ [varejoId]: { valor: 40 } });
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
