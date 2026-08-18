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
  // A third account exists purely so the draft-creation test has one it can
  // write to. Sharing `contaUnlinked` would leave a link doc behind that the
  // "offers to prepare" assertions above no longer hold for on a retry.
  const contaDraft = `${prefix}-003`;
  // Deterministic (mirrors seedProdutoMlPublicado) so afterAll can always
  // sweep the link SUBCOLLECTION even when beforeAll dies mid-way — the
  // nome-prefix sweep only reaches the parent doc, and Firestore never
  // cascades, so a guard on a beforeAll-assigned id would leak an orphan.
  const produtoId = `${prefix}-prod`;
  const mlItemId = 'MLB3609679155';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    await Promise.all([
      seedMercadoLivreFixtures(prefix, 3).then(() => seedProdutoMlPublicado(prefix, contaLinked)),
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
    //
    // ⚠️ `exact` is load-bearing: Playwright matches an accessible name by
    // SUBSTRING, so a plain 'Republicar' also matches the sibling
    // "Republicar e atualizar preços" (#804 S6) and the locator resolves to two
    // elements. Both buttons are asserted here so neither can silently vanish.
    await expect(card.getByRole('button', { name: 'Republicar', exact: true })).toBeVisible();
    await expect(
      card.getByRole('button', { name: 'Republicar e atualizar preços', exact: true }),
    ).toBeVisible();
    await expect(card.getByLabel('Tipo de anúncio')).toHaveCount(0);
  });

  test('offers to prepare a draft listing for an unbound account', async ({ page }) => {
    await page.goto(`/produtos/${produtoId}/editar`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    const card = page.getByTestId(`ml-conta-${contaUnlinked}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText('Não publicado')).toBeVisible();
    await expect(card.getByLabel('Tipo de anúncio')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Preparar anúncio' })).toBeEnabled();
    // Publishing straight from here cannot succeed: with no link doc there is
    // no category, and publish rejects that before it writes anything — so the
    // failure would leave nothing behind and the next attempt would fail
    // identically. Preparing the draft is what breaks that cycle.
    await expect(card.getByRole('button', { name: 'Publicar no Mercado Livre' })).toHaveCount(0);
  });

  test('preparing a draft opens the editor and keeps publish gated on a category', async ({
    page,
  }) => {
    await page.goto(`/produtos/${produtoId}/editar`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    const card = page.getByTestId(`ml-conta-${contaDraft}`);
    await expect(card).toBeVisible({ timeout: 30_000 });

    // Tolerate a draft left by an earlier attempt of this same test: the draft
    // doc id is the integração id, so preparing twice is a no-op, and on a
    // retry the button is simply gone.
    const preparar = card.getByRole('button', { name: 'Preparar anúncio' });
    if ((await preparar.count()) > 0) await preparar.click();

    await expect(card.getByText('Rascunho — ainda não publicado')).toBeVisible({
      timeout: 15_000,
    });
    await expect(card.getByRole('button', { name: 'Escolher categoria' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Publicar no Mercado Livre' })).toBeDisabled();
    await expect(
      card.getByText('Escolha a categoria do Mercado Livre antes de publicar.'),
    ).toBeVisible();
  });

  test('degrades gracefully when the mercado-livre backend is unreachable', async ({ page }) => {
    // Abort the publish request at the browser level: deterministic in every
    // environment. (Relying on "nothing listens on :3006" breaks locally,
    // where `pnpm dev` runs the real backend and the click would surface a
    // 409/500 toast instead of the network-error mapping under test.)
    await page.route('**/api/marketplace/mercado-livre/publicar', (route) => route.abort());
    await page.goto(`/produtos/${produtoId}/editar`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    // The PUBLISHED account, because it is the one whose publish button is
    // reachable: an unbound account now prepares a draft first, which is a
    // Firestore write and never touches the backend under test here.
    const card = page.getByTestId(`ml-conta-${contaLinked}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    // Exact: the sibling "Republicar e atualizar preços" would match a
    // substring locator too (see the note in the status test above).
    await card.getByRole('button', { name: 'Republicar', exact: true }).click();

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

    // ⚠️ A DRAFT is the case the old gate got wrong, and it needs the draft to
    // actually EXIST to mean anything: with no link doc the button is absent for
    // the boring reason, which is the same assertion passing for the wrong cause.
    // So prepare one (tolerating a draft left by another test — the draft doc id
    // is the integração id, so preparing twice is a no-op) and prove the listing
    // is there before asserting the button is not.
    const draft = page.getByTestId(`ml-conta-${contaDraft}`);
    await expect(draft).toBeVisible({ timeout: 30_000 });
    const preparar = draft.getByRole('button', { name: 'Preparar anúncio' });
    if ((await preparar.count()) > 0) await preparar.click();
    await expect(draft.getByText('Rascunho — ainda não publicado')).toBeVisible({
      timeout: 15_000,
    });

    // The listing exists; it simply has no ML id, so the push has nothing to
    // send and the backend answers `sem-id-externo`. The button must be absent,
    // not enabled-and-useless.
    await expect(draft.getByRole('button', { name: 'Enviar estoque' })).toHaveCount(0);
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

    // A CONTA-level failure (the request never reached the backend) names no
    // listing, so it has nowhere inline to land and surfaces as a toast. Only a
    // per-LISTING outcome — which requires a response — renders on the anúncio.
    await expect(
      page.getByText('Não foi possível contatar o serviço do Mercado Livre.'),
    ).toBeVisible({ timeout: 15_000 });
  });
});
