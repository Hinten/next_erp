import { expect, test, type Page } from '@playwright/test';
import {
  cleanupBalanco,
  cleanupByNamePrefix,
  cleanupProdutoEstoque,
  e2ePrefix,
  getBalanco,
  getProdutoEstoque,
  getRelatorioBalanco,
  listHistoricoEstoque,
  listMovimentosBalanco,
  seedBalancoAberto,
  seedDepositoAtivo,
  seedEstoqueDoc,
  seedProdutoComFilho,
} from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * The balanço workflow end to end: count on the floor, review the difference,
 * apply it to stock.
 *
 * Runs on the emulator lane because the finalize is a Cloud Function callable
 * plus a Cloud Tasks worker — this suite owns its own backend, so the whole
 * chain (callable → queue → worker → estoque + ledger) executes for real
 * instead of being asserted against a mock.
 *
 * Assertions read through the Admin SDK rather than the DOM wherever the point
 * is what LANDED: the screen showing "5" proves the screen, not the write.
 */
test.describe.serial('Balanço e2e — contagem, revisão e aplicação no estoque', () => {
  const prefix = e2ePrefix('balanco');
  let depositoId = '';
  let balancoId = '';
  // Manual entry counts onto its OWN balanço: the shared one above is finalized
  // mid-suite and every later assertion depends on its exact movimento counts.
  let balancoManualId = '';
  let produtoId = '';
  let produtoSku = '';
  let produtoNome = '';
  let paiNome = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const dep = await seedDepositoAtivo(prefix);
    depositoId = dep.id;
    const seeded = await seedProdutoComFilho(prefix);
    // The variation child carries the SKU the scan box resolves.
    produtoId = seeded.childId;
    produtoSku = seeded.childSku;
    produtoNome = seeded.childNome;
    // The parent shares the child's nome as a prefix, so one search returns
    // both — which is what makes the manual test exercise a real choice.
    paiNome = seeded.parentNome;
    await seedEstoqueDoc(produtoId, depositoId, 8);
    const balanco = await seedBalancoAberto(prefix, depositoId);
    balancoId = balanco.id;
    const manual = await seedBalancoAberto(`${prefix}-manual`, depositoId);
    balancoManualId = manual.id;
    await warmRoutes(browser, [`/balanco/${balancoId}`, `/balanco/${balancoManualId}`]);
  });

  test.afterAll(async () => {
    if (balancoId) await cleanupBalanco(balancoId);
    if (balancoManualId) await cleanupBalanco(balancoManualId);
    if (produtoId) await cleanupProdutoEstoque(produtoId);
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupByNamePrefix('depositos', prefix);
  });

  async function abrirContagem(page: Page) {
    await page.goto(`/balanco/${balancoId}`);
    await expect(page.getByLabel('SKU do produto')).toBeVisible({ timeout: 30_000 });
  }

  async function bipar(page: Page, codigo: string) {
    const campo = page.getByLabel('SKU do produto');
    await campo.fill(codigo);
    await campo.press('Enter');
  }

  test('a scanned SKU is counted, and an unknown one is kept as an error', async ({ page }) => {
    await abrirContagem(page);

    await bipar(page, produtoSku);
    await bipar(page, produtoSku);
    await bipar(page, produtoSku);
    await bipar(page, 'SKU-QUE-NAO-EXISTE');

    await expect
      .poll(async () => (await listMovimentosBalanco(balancoId)).length, {
        timeout: 30_000,
      })
      .toBe(4);

    const movimentos = await listMovimentosBalanco(balancoId);
    const contados = movimentos.filter((m) => m.error === false);
    expect(contados).toHaveLength(3);
    expect(contados.every((m) => m.produtoId === produtoId && m.quantidade === 1)).toBe(true);

    // The failed read is PERSISTED, not swallowed: it happened on the floor, so
    // the operator has to be able to find it afterwards. Legacy left
    // `errorInput` null on some of these, rendering rows titled "Error".
    const erro = movimentos.find((m) => m.error === true);
    expect(erro).toMatchObject({
      produtoId: null,
      quantidade: 0,
      errorInput: 'SKU-QUE-NAO-EXISTE',
      errorMessage: 'SKU não encontrado',
    });
  });

  test('a produto chosen from the manual autocomplete is counted', async ({ page }) => {
    await page.goto(`/balanco/${balancoManualId}`);
    // Mantine's SegmentedControl keeps its radio input visually hidden, so the
    // label is the only clickable target — `.check()` on the input times out.
    await page.getByText('Manual', { exact: true }).click();

    // By role, not by label: the Autocomplete's dropdown is `aria-labelledby`
    // the same label, so `getByLabel('Produto')` matches the listbox too.
    const campo = page.getByRole('combobox', { name: 'Produto' });
    await expect(campo).toBeVisible({ timeout: 30_000 });
    // A prefix both produtos share, so the dropdown offers a real choice.
    await campo.fill(paiNome);

    const opcao = page.getByRole('option', { name: `${produtoNome} — ${produtoSku}` });
    await expect(opcao).toBeVisible({ timeout: 30_000 });
    await opcao.click();

    await page.getByLabel('Quantidade').fill('4');
    await page.getByRole('button', { name: 'Lançar' }).click();

    // The regression this guards: picking a suggestion makes Mantine report the
    // option's LABEL as the field value. Searching that label as a `nome`
    // prefix matches nothing, so the option list emptied — and the list was
    // what resolved the produto. Lançar accepted the click and wrote nothing.
    await expect
      .poll(async () => (await listMovimentosBalanco(balancoManualId)).length, {
        timeout: 30_000,
      })
      .toBe(1);

    expect((await listMovimentosBalanco(balancoManualId))[0]).toMatchObject({
      produtoId,
      quantidade: 4,
      error: false,
      removido: false,
    });
  });

  test('cancelling a lançamento removes it from the total without deleting it', async ({
    page,
  }) => {
    await abrirContagem(page);
    const lista = page.getByText('Meus produtos lançados');
    await expect(lista).toBeVisible();

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
    // Soft cancel: the row survives so the withdrawal itself stays auditable.
    expect(await listMovimentosBalanco(balancoId)).toHaveLength(4);
  });

  test('the review screen shows the difference against current stock', async ({ page }) => {
    await page.goto(`/balanco/${balancoId}/revisao`);
    const linha = page.getByRole('row').filter({ hasText: produtoSku });
    await expect(linha).toBeVisible({ timeout: 30_000 });
    // 3 scanned, 1 cancelled ⇒ 2 counted against 8 in stock.
    await expect(linha).toContainText('8');
    await expect(linha).toContainText('2');
    await expect(linha).toContainText('-6');
  });

  test('finalizing applies the count to stock and writes a signed ledger row', async ({ page }) => {
    await page.goto(`/balanco/${balancoId}/revisao`);
    await page.getByRole('button', { name: 'Aplicar contagem no estoque' }).click();

    const modal = page.getByRole('dialog');
    await expect(modal.getByText('Esta ação é irreversível')).toBeVisible();
    await modal.getByRole('button', { name: 'Confirmar e aplicar' }).click();

    await expect
      .poll(async () => (await getBalanco(balancoId))?.estado, { timeout: 60_000 })
      .toBe('finalizado');

    // Absolute set: the stock becomes exactly what was counted.
    expect((await getProdutoEstoque(produtoId, depositoId))?.quantidade).toBe(2);

    const historico = await listHistoricoEstoque(produtoId, depositoId);
    const doBalanco = historico.filter((h) => h.tipo === 'balanco');
    expect(doBalanco).toHaveLength(1);
    // ADR 0014: a signed delta on every row, a balanço included — 2 − 8. v1
    // stored the counted absolute here, which poisons the sweep's
    // `atual − Σmovimento` reconstruction.
    expect(doBalanco[0]?.movimento).toBe(-6);
    expect(doBalanco[0]?.saldo).toBe(2);
    // Stamped from the balanço doc, never from the request payload.
    expect(doBalanco[0]?.motivo).toBe(`Balanço ${prefix}-contagem`);

    // The stored report keeps the value the transaction actually replaced.
    const relatorio = await getRelatorioBalanco(balancoId);
    expect(relatorio[produtoId]).toMatchObject({ estoque: 8, contado: 2, sku: produtoSku });
  });

  test('a finalized balanço refuses further counting and offers no apply button', async ({
    page,
  }) => {
    await abrirContagem(page);
    await expect(page.getByLabel('SKU do produto')).toBeDisabled();
    await expect(page.getByText('Balanço encerrado para contagem')).toBeVisible();

    await page.goto(`/balanco/${balancoId}/revisao`);
    await expect(page.getByText('Balanço aplicado')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Aplicar contagem no estoque' })).toHaveCount(0);
    // ...and the table now comes from the stored shards, so it still reads the
    // pre-balanço stock rather than the value that was just written.
    const linha = page.getByRole('row').filter({ hasText: produtoSku });
    await expect(linha).toContainText('8');
  });
});
