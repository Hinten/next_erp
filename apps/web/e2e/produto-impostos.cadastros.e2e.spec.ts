import { expect, test, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  e2ePrefix,
  getProdutoData,
  getProdutoIdByNome,
  getProdutoImposto,
  seedOperacaoAtiva,
} from './_helpers/seed-data';
import { fillField, selectField } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the Impostos tab — the per-operação fiscal override.
 * It proves the `impostos` aggregate field is persisted to its subdocument
 * (`produtos/<id>/imposto/<operacaoId>`) ATOMICALLY with the produto doc (the
 * page's `transactionWrites`), with the Flutter wire shape (the `impostoOpercao…`
 * typo key, doc id = operação id), and kept OFF the produto document.
 *
 * Driven through the CREATE flow: the imposto doc commits inside the produto-create
 * transaction, so a single "create produto + sibling imposto" commit is robust.
 */
test.describe
  .serial('Produtos impostos e2e — Impostos por operação (imposto subcollection)', () => {
  const prefix = e2ePrefix('prod-imposto');
  const nome = `${prefix}-camiseta`;
  let produtoId = '';
  let operacaoId = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    const op = await seedOperacaoAtiva(prefix);
    operacaoId = op.id;
    await warmRoutes(browser, ['/produtos/novo']);
  });

  test.afterAll(async () => {
    if (produtoId) await cleanupProdutoSubcollection(produtoId, 'imposto');
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupByNamePrefix('operacao', prefix);
  });

  async function fillImpostosTab(page: Page) {
    await page.getByRole('tab', { name: 'Impostos' }).click();
    await expect(page.getByLabel('Operação')).toBeVisible({ timeout: 30_000 });
    // Pick the seeded operação explicitly (staging may hold other padrão ones).
    await selectField(page, 'Operação', `${prefix}-op`);
    await fillField(page, 'CFOP', '5102'); // exact — "CFOP interestadual" is separate
    await page.getByRole('textbox', { name: 'NCM' }).fill('61091000');
  }

  test('creates a produto and persists its per-operação imposto off the produto doc', async ({
    page,
  }) => {
    await page.goto('/produtos/novo');
    await fillField(page, 'Nome', nome);
    await fillImpostosTab(page);
    await page.getByRole('button', { name: 'Criar', exact: true }).click();

    await expect
      .poll(async () => await getProdutoIdByNome(nome), { timeout: 30_000 })
      .not.toBeNull();
    produtoId = (await getProdutoIdByNome(nome))!;

    // The imposto doc id IS the operação id, with the Flutter typo scope key.
    await expect
      .poll(async () => (await getProdutoImposto(produtoId, operacaoId))?.cfop, { timeout: 15_000 })
      .toBe('5102');
    const imposto = await getProdutoImposto(produtoId, operacaoId);
    expect(imposto).toMatchObject({
      id: operacaoId,
      impostoOpercaoOuterRef: `operacao/${operacaoId}`,
      cfop: '5102',
      NCM: '61091000',
    });
    expect(typeof imposto!.timestamp).toBe('number');

    // The transient field never leaked onto the produto document.
    const produto = await getProdutoData(produtoId);
    expect(produto).not.toHaveProperty('impostos');
    expect(produto).not.toHaveProperty('cfop');
  });
});
