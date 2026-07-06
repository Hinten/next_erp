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
 * End-to-end coverage for the produto editor's **Mercado Livre** tab: the
 * publish status read live from the old-wire-shape
 * `produtos/<id>/produtoMercadoLivre` link doc, and the Publicar/Republicar
 * action. The apps/mercado-livre backend does NOT run in this suite — the
 * action must degrade gracefully (network-error toast), never break the page.
 *
 * The tab lists every tipo-1 integração on staging (shared project), so all
 * row assertions are scoped by the run-scoped `data-testid="ml-conta-<id>"`.
 */
test.describe.serial('Produto Mercado Livre tab e2e — status + publish action', () => {
  const prefix = e2ePrefix('mlpub');
  const contaLinked = `${prefix}-001`;
  const contaUnlinked = `${prefix}-002`;
  let produtoId = '';
  let mlItemId = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const [seeded] = await Promise.all([
      seedMercadoLivreFixtures(prefix, 2).then(() => seedProdutoMlPublicado(prefix, contaLinked)),
      warmRoutes(browser, ['/produtos/__aquecimento__/editar']),
    ]);
    produtoId = seeded.produtoId;
    mlItemId = seeded.mlItemId;
  });

  test.afterAll(async () => {
    if (produtoId) await cleanupProdutoSubcollection(produtoId, 'produtoMercadoLivre');
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupMercadoLivreFixtures(prefix);
  });

  test('surfaces the published link-doc status for the bound account', async ({ page }) => {
    await page.goto(`/produtos/${produtoId}/editar`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    const card = page.getByTestId(`ml-conta-${contaLinked}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText(contaLinked)).toBeVisible();
    await expect(card.getByText('Publicado', { exact: true })).toBeVisible();
    await expect(card.getByText(`Anúncio ${mlItemId}`)).toBeVisible();
    // A bound listing re-publishes — no listing-type choice (the link doc's
    // persisted `listing_type_id` wins).
    await expect(card.getByRole('button', { name: 'Republicar' })).toBeVisible();
    await expect(card.getByLabel('Tipo de anúncio')).toHaveCount(0);
  });

  test('offers a first publish (with listing type) for an unbound account', async ({ page }) => {
    await page.goto(`/produtos/${produtoId}/editar`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    const card = page.getByTestId(`ml-conta-${contaUnlinked}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText('Não publicado')).toBeVisible();
    await expect(card.getByLabel('Tipo de anúncio')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Publicar no Mercado Livre' })).toBeEnabled();
  });

  test('degrades gracefully when the mercado-livre backend is offline', async ({ page }) => {
    await page.goto(`/produtos/${produtoId}/editar`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    const card = page.getByTestId(`ml-conta-${contaUnlinked}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Publicar no Mercado Livre' }).click();

    // No backend on :3006 in this suite → the client's network-error mapping.
    await expect(
      page.getByText('Não foi possível contatar o serviço do Mercado Livre.'),
    ).toBeVisible({ timeout: 15_000 });
  });
});
