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

/**
 * The produtos-table bulk **Enviar preços** action (#804) — the port of the
 * legacy `EnviarPrecoAction` + `EnviarPrecoDialog`.
 *
 * The apps/mercado-livre backend does NOT run in this suite, so the push itself
 * is aborted at the browser level (the technique the produto ML-tab and the
 * stock-push specs already use). What is under test here is the selection →
 * dialog → per-row reporting flow, all of which is app-side.
 */
test.describe.serial('Produtos — bulk price push to the marketplaces', () => {
  const prefix = e2ePrefix('envpreco');
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
    await page.getByPlaceholder('Buscar por nome…').fill(prefix);
    await expect(page.getByRole('link', { name: produtoNome, exact: true })).toBeVisible({
      timeout: 30_000,
    });

    const acao = page.getByRole('button', { name: 'Enviar preços' });
    await expect(acao).toBeDisabled();

    await page.getByLabel(`Selecionar ${produtoId}`).check();
    await expect(acao).toBeEnabled();
  });

  test('asks before sending, with decreases allowed by default', async ({ page }) => {
    await page.goto('/produtos');
    await page.getByPlaceholder('Buscar por nome…').fill(prefix);
    await expect(page.getByRole('link', { name: produtoNome, exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByLabel(`Selecionar ${produtoId}`).check();
    await page.getByRole('button', { name: 'Enviar preços' }).click();

    await expect(page.getByText('Enviando preços para os marketplaces')).toBeVisible();
    // The opposite default from the account-wide job, and from the stock push's
    // own opt-in: hand-picking produtos IS the explicit intent to move THOSE
    // prices, including downwards (legacy `produtoTableView.dart:607`).
    await expect(page.getByLabel('Permitir baixar preços')).toBeChecked();
  });

  test('reports a push it could not deliver, per row', async ({ page }) => {
    await page.route('**/api/marketplace/mercado-livre/enviar-precos', (route) => route.abort());
    await page.goto('/produtos');
    await page.getByPlaceholder('Buscar por nome…').fill(prefix);
    await expect(page.getByRole('link', { name: produtoNome, exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByLabel(`Selecionar ${produtoId}`).check();
    await page.getByRole('button', { name: 'Enviar preços' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Enviar preços' }).click();

    // Rows are LISTING-scoped and keyed `<produtoId>:<contaId>:<anuncioId>`, so
    // match the prefix and assert on the one row this scenario produces rather
    // than assuming a produto yields exactly one.
    const rows = page.locator(`[data-testid^="envio-preco-row-${produtoId}:"]`);
    await expect(rows).toHaveCount(1, { timeout: 20_000 });
    await expect(rows.first()).toContainText(
      'Não foi possível contatar o serviço do Mercado Livre.',
    );
    // Fechar only appears once the run is terminal — the operator can always
    // see what happened before the dialog goes away.
    await expect(page.getByRole('button', { name: 'Fechar' })).toBeEnabled({ timeout: 20_000 });
  });
});
