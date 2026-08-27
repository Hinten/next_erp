import { expect, test } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupMercadoLivreFixtures,
  cleanupProdutoSubcollection,
  e2ePrefix,
  seedMercadoLivreFixtures,
  seedProdutoMlPublicado,
} from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';
import { searchTableView } from './helpers/table-view';

/**
 * The produtos-table bulk **Enviar estoque** action (#819) — the port of the
 * legacy `EnviarEstoqueAction` + `EnviarEstoqueDialog`.
 *
 * The apps/mercado-livre backend does NOT run in this suite, so the push itself
 * is aborted at the browser level (the technique the produto ML-tab specs
 * already use). What is under test here is the selection → dialog → per-row
 * reporting flow, all of which is app-side.
 */
test.describe.serial('Produtos — bulk stock push to the marketplaces', () => {
  const prefix = e2ePrefix('envest');
  const conta = `${prefix}-001`;
  // Deterministic (mirrors seedProdutoMlPublicado) so afterAll can always sweep
  // the link subcollection even if beforeAll dies mid-way — Firestore never
  // cascades, and the nome-prefix sweep only reaches the parent doc.
  const produtoId = `${prefix}-prod`;
  let produtoNome = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    await Promise.all([
      seedMercadoLivreFixtures(prefix, 1)
        .then(() => seedProdutoMlPublicado(prefix, conta))
        .then((r) => {
          produtoNome = r.nome;
        }),
      warmRoutes(browser, ['/produtos']),
    ]);
  });

  test.afterAll(async () => {
    await cleanupProdutoSubcollection(produtoId, 'produtoMercadoLivre');
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupMercadoLivreFixtures(prefix);
  });

  test('enables the action only once a produto is selected', async ({ page }) => {
    await page.goto('/produtos');
    await searchTableView(page, prefix);
    await expect(page.getByRole('link', { name: produtoNome, exact: true })).toBeVisible({
      timeout: 30_000,
    });

    const acao = page.getByRole('button', { name: 'Enviar estoque' });
    await expect(acao).toBeDisabled();

    await page.getByLabel(`Selecionar ${produtoId}`).check();
    await expect(acao).toBeEnabled();
  });

  test('asks before sending, with the error opt-in off by default', async ({ page }) => {
    await page.goto('/produtos');
    await searchTableView(page, prefix);
    await expect(page.getByRole('link', { name: produtoNome, exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByLabel(`Selecionar ${produtoId}`).check();
    await page.getByRole('button', { name: 'Enviar estoque' }).click();

    await expect(page.getByText('Enviando estoque para os marketplaces')).toBeVisible();
    // Re-arming a latched anúncio costs an extra call and can re-earn the same
    // rejection, so it is never implicit.
    await expect(page.getByLabel('Reenviar anúncios com erro')).not.toBeChecked();
  });

  test('reports a push it could not deliver, per row', async ({ page }) => {
    await page.route('**/api/marketplace/mercado-livre/enviar-estoque', (route) => route.abort());
    await page.goto('/produtos');
    await searchTableView(page, prefix);
    await expect(page.getByRole('link', { name: produtoNome, exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByLabel(`Selecionar ${produtoId}`).check();
    await page.getByRole('button', { name: 'Enviar estoque' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Enviar estoque' }).click();

    // Rows are LISTING-scoped and keyed `<produtoId>:<contaId>:<anuncioId>`, so
    // match the prefix and assert on the one row this scenario produces rather
    // than assuming a produto yields exactly one.
    const rows = page.locator(`[data-testid^="envio-estoque-row-${produtoId}:"]`);
    await expect(rows).toHaveCount(1, { timeout: 20_000 });
    await expect(rows.first()).toContainText(
      'Não foi possível contatar o serviço do Mercado Livre.',
    );
    // Fechar only appears once the run is terminal — the operator can always
    // see what happened before the dialog goes away.
    await expect(page.getByRole('button', { name: 'Fechar' })).toBeEnabled({ timeout: 20_000 });
  });
});
