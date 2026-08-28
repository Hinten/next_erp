import { expect, test, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupProdutoEstoque,
  e2ePrefix,
  getProdutoEstoque,
  listHistoricoEstoque,
  seedDepositoAtivo,
  seedProdutoComFilho,
} from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the Estoque por depósito tab (the per-variation rework).
 * It proves the two decoupled, conflict-safe write paths:
 *  - inline `localizacao` editing writes ONLY `localizacao` (an existing/new
 *    estoque keeps `quantidade` at 0 — quantities are movement-owned);
 *  - the movement modal applies an atomic `increment` and appends a
 *    `historicoEstoque` audit record.
 *
 * Driven on the EDIT screen (stock needs a saved produto) against a parent +
 * one variation child. The write paths are exercised on the VARIATION row,
 * because a parent that has variations and no stock of its own is hidden behind
 * the "Mostrar estoque do produto pai" toggle — the first test covers that.
 */
test.describe
  .serial('Produtos estoque e2e — Estoque por depósito (variações + movimentação)', () => {
  const prefix = e2ePrefix('prod-estoque');
  let parentId = '';
  let childId = '';
  let depositoId = '';
  let depositoNome = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    const dep = await seedDepositoAtivo(prefix);
    depositoId = dep.id;
    depositoNome = dep.nome;
    const seeded = await seedProdutoComFilho(prefix);
    parentId = seeded.parentId;
    childId = seeded.childId;
    await warmRoutes(browser, [`/produtos/${parentId}/editar`]);
  });

  test.afterAll(async () => {
    if (parentId) await cleanupProdutoEstoque(parentId);
    if (childId) await cleanupProdutoEstoque(childId);
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupByNamePrefix('depositos', prefix);
  });

  async function openEstoqueTab(page: Page) {
    await page.goto(`/produtos/${parentId}/editar`);
    await page.getByRole('tab', { name: 'Estoque' }).click();
    // The VARIATION's depósito row mounts once depósitos + produtos load. It is
    // the anchor rather than the parent's row, which starts hidden — see below.
    await expect(page.getByLabel(`Localização ${childId} ${depositoNome}`)).toBeVisible({
      timeout: 30_000,
    });
  }

  test('a produto with variations hides its own empty estoque behind a toggle', async ({
    page,
  }) => {
    await openEstoqueTab(page);
    // Stock belongs on the variations, so the parent's rows are out of the way
    // rather than inviting a write no marketplace ever reads.
    await expect(page.getByLabel(`Localização ${parentId} ${depositoNome}`)).toHaveCount(0);

    await page.getByRole('button', { name: 'Mostrar estoque do produto pai' }).click();
    await expect(page.getByLabel(`Localização ${parentId} ${depositoNome}`)).toBeVisible();
  });

  test('inline localização writes only localizacao (quantidade stays 0)', async ({ page }) => {
    await openEstoqueTab(page);
    const input = page.getByLabel(`Localização ${childId} ${depositoNome}`);
    await input.fill('Corredor 3, Prateleira B');
    await input.blur();

    await expect
      .poll(async () => (await getProdutoEstoque(childId, depositoId))?.localizacao, {
        timeout: 20_000,
      })
      .toBe('Corredor 3, Prateleira B');
    const estoque = await getProdutoEstoque(childId, depositoId);
    // A fresh estoque created by the localização write keeps quantidade at 0 —
    // which is also why the parent stays hidden: a location string is not stock.
    expect(estoque).toMatchObject({
      // ⚠️ The doc's own `parentId` field is its OWNING produto (the variation),
      // not `parentId` the fixture's parent produto.
      parentId: childId,
      depositoOuterRef: `documents/depositos/${depositoId}`,
      localizacao: 'Corredor 3, Prateleira B',
      quantidade: 0,
      quantidadeReservada: 0,
    });
  });

  test('a movement (entrada) increments the variation stock and logs a record', async ({
    page,
  }) => {
    await openEstoqueTab(page);
    // Open the movement modal on the VARIATION child's depósito row.
    await page.getByRole('button', { name: `Editar estoque ${childId} ${depositoNome}` }).click();

    const modal = page.getByRole('dialog');
    await expect(modal.getByText('Edição de estoque')).toBeVisible();
    // tipo defaults to Entrada; enter a quantity of 5 and save.
    await modal.getByLabel('Quantidade', { exact: true }).fill('5');
    await modal.getByRole('button', { name: 'Salvar' }).click();

    await expect
      .poll(async () => (await getProdutoEstoque(childId, depositoId))?.quantidade, {
        timeout: 20_000,
      })
      .toBe(5);
    const records = await listHistoricoEstoque(childId, depositoId);
    expect(records.length).toBeGreaterThanOrEqual(1);
    // v2: the ledger records a SIGNED movimento, not a bare quantity (ADR 0014).
    expect(records.some((r) => r.movimento === 5)).toBe(true);
  });

  test('the filter field accepts a variation SKU term', async ({ page }) => {
    await openEstoqueTab(page);
    // The filter highlights matches (visual); assert it is present and typeable.
    const filter = page.getByLabel('Filtrar');
    await filter.fill(prefix.toUpperCase().replace(/-/g, '_'));
    await expect(filter).toHaveValue(prefix.toUpperCase().replace(/-/g, '_'));
  });
});
