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
  // Deterministic (mirrors seedProdutoMlPublicado) so afterAll can always
  // sweep the link SUBCOLLECTION even when beforeAll dies mid-way — the
  // nome-prefix sweep only reaches the parent doc, and Firestore never
  // cascades, so a guard on a beforeAll-assigned id would leak an orphan.
  const produtoId = `${prefix}-prod`;
  const mlItemId = 'MLB3609679155';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    await Promise.all([
      seedMercadoLivreFixtures(prefix, 2).then(() => seedProdutoMlPublicado(prefix, contaLinked)),
      warmRoutes(browser, ['/produtos/__aquecimento__/editar']),
    ]);
  });

  test.afterAll(async () => {
    await cleanupProdutoSubcollection(produtoId, 'produtoMercadoLivre');
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

  test('degrades gracefully when the mercado-livre backend is unreachable', async ({ page }) => {
    // Abort the publish request at the browser level: deterministic in every
    // environment. (Relying on "nothing listens on :3006" breaks locally,
    // where `pnpm dev` runs the real backend and the click would surface a
    // 409/500 toast instead of the network-error mapping under test.)
    await page.route('**/api/marketplace/mercado-livre/publicar', (route) => route.abort());
    await page.goto(`/produtos/${produtoId}/editar`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    const card = page.getByTestId(`ml-conta-${contaUnlinked}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Publicar no Mercado Livre' }).click();

    await expect(
      page.getByText('Não foi possível contatar o serviço do Mercado Livre.'),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('offers an on-demand stock push only where the account holds a listing', async ({
    page,
  }) => {
    // #819: before this button the only way to fix a wrong quantity was to wait
    // for the sweep. It is per CONTA (the sender loops every anúncio the conta
    // holds), so it appears exactly where there is something to send to.
    await page.goto(`/produtos/${produtoId}/editar`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    const linked = page.getByTestId(`ml-conta-${contaLinked}`);
    await expect(linked).toBeVisible({ timeout: 30_000 });
    await expect(linked.getByRole('button', { name: 'Enviar estoque' })).toBeEnabled();

    const unlinked = page.getByTestId(`ml-conta-${contaUnlinked}`);
    await expect(unlinked.getByRole('button', { name: 'Enviar estoque' })).toHaveCount(0);
  });

  test('reports a stock push it could not deliver', async ({ page }) => {
    // Same route-abort technique as the publish degradation test above: the
    // mercado-livre backend does not run in this suite.
    await page.route('**/api/marketplace/mercado-livre/enviar-estoque', (route) => route.abort());
    await page.goto(`/produtos/${produtoId}/editar`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    const card = page.getByTestId(`ml-conta-${contaLinked}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Enviar estoque' }).click();

    // A per-listing failure lands INLINE on the anúncio, not as a toast — a
    // conta can hold several listings and one toast could only describe one.
    await expect(
      card.getByText('Não foi possível contatar o serviço do Mercado Livre.'),
    ).toBeVisible({ timeout: 15_000 });
  });
});
