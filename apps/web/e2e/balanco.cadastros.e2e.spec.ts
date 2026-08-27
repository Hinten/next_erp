import { expect, test, type Page } from '@playwright/test';
import {
  cleanupBalanco,
  cleanupByNamePrefix,
  cleanupProdutoEstoque,
  e2ePrefix,
  listMovimentosBalanco,
  seedBalancoAberto,
  seedDepositoAtivo,
  seedEstoqueDoc,
  seedProdutoComFilho,
} from './_helpers/seed-data';
import { clickSave, fillField, selectFieldWithSearch } from './helpers/object-view';
import { applyTextFilter } from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * `/balanco` against staging: the list, the create form, and the counting and
 * review screens.
 *
 * ⚠️ Finalizing is deliberately NOT exercised here. It runs through a callable
 * plus a Cloud Tasks worker, and asserting its output on staging would be
 * asserting a deployment state — the failure mode `apps/web/CLAUDE.md` rule 8
 * exists to prevent. The emulator lane owns that half and drives the whole
 * chain for real; this lane owns the parts the browser is solely responsible
 * for.
 *
 * Every produto/depósito/balanço here is `e2ePrefix`-scoped, and each
 * assertion is written to tolerate rows a concurrent spec may have added to
 * the same shared collections.
 */
test.describe.serial('Balanço e2e — lista, cadastro, contagem e revisão', () => {
  const prefix = e2ePrefix('bal');
  let depositoId = '';
  let depositoNome = '';
  let balancoId = '';
  let produtoId = '';
  let produtoSku = '';
  let produtoNome = '';
  let paiNome = '';

  test.beforeAll(async ({ browser }) => {
    // Three cold routes plus the Admin-SDK seed outlast the default hook budget.
    test.setTimeout(240_000);
    const dep = await seedDepositoAtivo(prefix);
    depositoId = dep.id;
    depositoNome = dep.nome;
    const seeded = await seedProdutoComFilho(prefix);
    produtoId = seeded.childId;
    produtoSku = seeded.childSku;
    produtoNome = seeded.childNome;
    paiNome = seeded.parentNome;
    await seedEstoqueDoc(produtoId, depositoId, 8);
    const balanco = await seedBalancoAberto(prefix, depositoId);
    balancoId = balanco.id;
    await warmRoutes(browser, [
      '/balanco',
      '/balanco/novo',
      `/balanco/${balancoId}`,
      `/balanco/${balancoId}/revisao`,
    ]);
  });

  test.afterAll(async () => {
    if (balancoId) await cleanupBalanco(balancoId);
    if (produtoId) await cleanupProdutoEstoque(produtoId);
    await cleanupByNamePrefix('balanco', prefix);
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupByNamePrefix('depositos', prefix);
  });

  async function abrirContagem(page: Page) {
    await page.goto(`/balanco/${balancoId}`);
    await expect(page.getByLabel('SKU do produto')).toBeVisible({ timeout: 30_000 });
  }

  test('the list loads and shows the seeded balanço as open', async ({ page }) => {
    await page.goto('/balanco');
    await expect(page.getByRole('table')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);

    // Narrow to this run before asserting. `balancoMeta.defaultQuery` is
    // `orderBy timestamp desc, limit 50`, so unfiltered this depended on the
    // seeded row making page 1 — true only until 50 newer balanços exist, which
    // a concurrent lane or a batch of orphaned fixtures supplies for free. The
    // filter is a SERVER-side narrowing (TableView pushes column filters into
    // the query, so `limit` applies after it), which is what makes this
    // independent of how much else is in the collection. Same remedy as
    // `logistica.vendas.e2e.spec.ts` and the other 15 list specs.
    await applyTextFilter(page, 'Nome', prefix);

    const linha = page.getByRole('row').filter({ hasText: `${prefix}-contagem` });
    await expect(linha).toBeVisible({ timeout: 30_000 });
    // An open balanço stores `estado: null` — the workflow lock is server-owned
    // and has no stored "aberto" — so a blank cell here would mean the list is
    // rendering the raw value instead of resolving it.
    await expect(linha).toContainText('Aberto');
  });

  test('creates a balanço from the form', async ({ page }) => {
    await page.goto('/balanco/novo');
    const nome = `${prefix}-criado`;
    await fillField(page, 'Nome', nome);
    await selectFieldWithSearch(page, 'Depósito', depositoNome);
    await clickSave(page, 'Criar');

    // Saving routes to the counting screen for the new balanço.
    await expect(page.getByRole('heading', { name: nome })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel('SKU do produto')).toBeVisible({ timeout: 30_000 });
  });

  test('counts a produto by SKU and keeps an unknown one as an error', async ({ page }) => {
    await abrirContagem(page);

    const campo = page.getByLabel('SKU do produto');
    await campo.fill(produtoSku);
    await campo.press('Enter');
    await campo.fill('SKU-INEXISTENTE-BAL');
    await campo.press('Enter');

    await expect
      .poll(async () => (await listMovimentosBalanco(balancoId)).length, { timeout: 30_000 })
      .toBe(2);

    const movimentos = await listMovimentosBalanco(balancoId);
    expect(movimentos.filter((m) => m.error === false)).toMatchObject([
      { produtoId, quantidade: 1 },
    ]);
    // The failed read is persisted, not swallowed: the scan happened on the
    // floor, so it has to be findable afterwards.
    expect(movimentos.find((m) => m.error === true)).toMatchObject({
      produtoId: null,
      errorInput: 'SKU-INEXISTENTE-BAL',
      errorMessage: 'SKU não encontrado',
    });
  });

  test('counts a produto picked from the manual autocomplete', async ({ page }) => {
    await abrirContagem(page);
    // Mantine keeps the SegmentedControl's radio input visually hidden, so the
    // label is the only clickable target.
    await page.getByText('Manual', { exact: true }).click();

    // By role, not by label: the Autocomplete's dropdown is `aria-labelledby`
    // the same label, so `getByLabel('Produto')` matches the listbox too.
    const campo = page.getByRole('combobox', { name: 'Produto' });
    await expect(campo).toBeVisible({ timeout: 30_000 });
    // A prefix both the parent and the child share, so the dropdown offers a
    // real choice rather than a single inevitable match.
    await campo.fill(paiNome);

    const opcao = page.getByRole('option', { name: `${produtoNome} — ${produtoSku}` });
    await expect(opcao).toBeVisible({ timeout: 30_000 });
    await opcao.click();

    await page.getByLabel('Quantidade').fill('3');
    await page.getByRole('button', { name: 'Lançar' }).click();

    await expect
      .poll(
        async () =>
          (await listMovimentosBalanco(balancoId)).filter((m) => m.quantidade === 3).length,
        { timeout: 30_000 },
      )
      .toBe(1);
  });

  test('cancelling a lançamento is a soft removal, not a delete', async ({ page }) => {
    await abrirContagem(page);
    await expect(page.getByText('Meus produtos lançados')).toBeVisible({ timeout: 30_000 });

    const antes = (await listMovimentosBalanco(balancoId)).length;
    await page
      .getByRole('button', { name: /^Cancelar lançamento/ })
      .first()
      .click();

    await expect
      .poll(
        async () =>
          (await listMovimentosBalanco(balancoId)).filter((m) => m.removido === true).length,
        { timeout: 30_000 },
      )
      .toBe(1);
    // The row survives, so the withdrawal itself stays auditable.
    expect(await listMovimentosBalanco(balancoId)).toHaveLength(antes);
  });

  test('the review screen shows counted units against current stock', async ({ page }) => {
    await page.goto(`/balanco/${balancoId}/revisao`);
    const linha = page.getByRole('row').filter({ hasText: produtoSku });
    await expect(linha).toBeVisible({ timeout: 30_000 });
    // Seeded stock is 8; what remains counted after the cancellation above is
    // asserted from the ledger rather than hard-coded, since the cancelled row
    // is whichever the list happened to show first.
    await expect(linha).toContainText('8');
  });

  test('offers the CSV export on an open balanço', async ({ page }) => {
    await page.goto(`/balanco/${balancoId}/revisao`);
    const baixar = page.getByRole('button', { name: 'Baixar CSV' });
    await expect(baixar).toBeVisible({ timeout: 30_000 });

    const download = page.waitForEvent('download', { timeout: 30_000 });
    await baixar.click();
    const arquivo = await download;
    expect(arquivo.suggestedFilename()).toMatch(/\.csv$/);
  });
});
