import { expect, test, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  e2ePrefix,
  getProdutoData,
  getProdutoEstoque,
  getProdutoIdByNome,
  seedDepositoAtivo,
} from './_helpers/seed-data';
import { fillField } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the Estoque por depósito tab — the second consumer of
 * the ObjectView `transientFields` enabler. It proves the `estoques` aggregate
 * field is persisted to its per-depósito subdocument
 * (`produtos/<id>/estoques/est-<produtoId>-<depositoId>`) ATOMICALLY with the
 * produto doc (the page's `transactionWrites`), with the Flutter wire shape, and
 * kept OFF the produto document (the transient strip).
 *
 * Driven through the CREATE flow, like the Descrição suite: the estoque doc
 * commits inside the produto-create transaction, so a single
 * "create produto + sibling estoque" commit is far less flaky on staging than
 * the editar save's later writes.
 */
test.describe.serial('Produtos estoque e2e — Estoque por depósito (estoques subcollection)', () => {
  const prefix = e2ePrefix('prod-estoque');
  const nome = `${prefix}-camiseta`;
  let produtoId = '';
  let depositoId = '';
  let depositoNome = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    const dep = await seedDepositoAtivo(prefix);
    depositoId = dep.id;
    depositoNome = dep.nome;
    await warmRoutes(browser, ['/produtos/novo']);
  });

  test.afterAll(async () => {
    if (produtoId) await cleanupProdutoSubcollection(produtoId, 'estoques');
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupByNamePrefix('depositos', prefix);
  });

  async function fillEstoqueTab(page: Page) {
    await page.getByRole('tab', { name: 'Estoque' }).click();
    // Each active depósito is a Mantine Fieldset (role "group", named by its
    // legend); scope to the seeded one so its "Localização" input is unambiguous.
    const depGroup = page.getByRole('group', { name: depositoNome });
    await expect(depGroup).toBeVisible();
    await depGroup.getByLabel('Localização').fill('Corredor 3, Prateleira B');
  }

  test('creates a produto and persists its estoque doc off the produto doc', async ({ page }) => {
    await page.goto('/produtos/novo');
    await fillField(page, 'Nome', nome);
    await fillEstoqueTab(page);
    await page.getByRole('button', { name: 'Criar', exact: true }).click();

    // Navigation-independent: poll Firestore for the created produto by its
    // unique name, then for its per-depósito estoque doc (committed atomically
    // in the same transaction).
    await expect
      .poll(async () => await getProdutoIdByNome(nome), { timeout: 30_000 })
      .not.toBeNull();
    produtoId = (await getProdutoIdByNome(nome))!;

    await expect
      .poll(async () => (await getProdutoEstoque(produtoId, depositoId))?.localizacao, {
        timeout: 15_000,
      })
      .toBe('Corredor 3, Prateleira B');

    const estoque = await getProdutoEstoque(produtoId, depositoId);
    // Flutter wire shape: parentId = produto, doc-path depositoOuterRef, the
    // movement-owned quantities default to 0 (no movement system yet).
    expect(estoque).toMatchObject({
      parentId: produtoId,
      depositoOuterRef: `documents/depositos/${depositoId}`,
      localizacao: 'Corredor 3, Prateleira B',
      quantidade: 0,
      quantidadeReservada: 0,
    });
    expect(typeof estoque!.dataCriacao).toBe('number');
    expect(typeof estoque!.ultimaModificacao).toBe('number');

    // The transient field never leaked onto the produto document.
    const produto = await getProdutoData(produtoId);
    expect(produto).not.toHaveProperty('estoques');
    expect(produto).not.toHaveProperty('localizacao');
  });
});
