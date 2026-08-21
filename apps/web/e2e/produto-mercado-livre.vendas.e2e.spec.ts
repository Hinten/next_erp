import { expect, test, type Locator, type Page } from '@playwright/test';
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
 *
 * Navigation is TWO levels: the Mercado Livre tab, then one account's tab inside
 * it. An account's panel is lazy — it does not exist until its own tab has been
 * clicked — so every assertion goes through `abrirConta`, and a `toHaveCount(0)`
 * is always paired with something positive proving the panel actually rendered.
 * Without the pairing, "the button is absent" and "the panel was never built"
 * are the same green.
 */
test.describe.serial('Produto Mercado Livre tab e2e — status + publish action', () => {
  const prefix = e2ePrefix('mlpub');
  const contaLinked = `${prefix}-001`;
  const contaUnlinked = `${prefix}-002`;
  // A third account exists purely so the draft-creation test has one it can
  // write to. Sharing `contaUnlinked` would leave a link doc behind that the
  // "offers to prepare" assertions above no longer hold for on a retry.
  const contaDraft = `${prefix}-003`;
  // A fourth account owned entirely by the multi-listing test. Sharing one of
  // the three above would leave a SECOND link doc behind that the "offers to
  // prepare"/"only where the account holds a listing" assertions no longer hold
  // for on a `describe.serial` retry.
  const contaMulti = `${prefix}-004`;
  // A fifth, for the same reason: the delete test creates and destroys a draft,
  // which no other test's tolerance logic should have to reason about.
  const contaExcluir = `${prefix}-005`;
  // Deterministic (mirrors seedProdutoMlPublicado) so afterAll can always
  // sweep the link SUBCOLLECTION even when beforeAll dies mid-way — the
  // nome-prefix sweep only reaches the parent doc, and Firestore never
  // cascades, so a guard on a beforeAll-assigned id would leak an orphan.
  const produtoId = `${prefix}-prod`;
  const mlItemId = 'MLB3609679155';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    await Promise.all([
      seedMercadoLivreFixtures(prefix, 5).then(() => seedProdutoMlPublicado(prefix, contaLinked)),
      warmRoutes(browser, ['/produtos/novo', '/produtos/__aquecimento__/editar']),
    ]);
  });

  test.afterAll(async () => {
    await cleanupProdutoSubcollection(produtoId, 'produtoMercadoLivre');
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupMercadoLivreFixtures(prefix);
  });

  /**
   * Start a new anúncio on an account, through the "Novo anúncio" dialog.
   *
   * ⚠️ Its controls are located THROUGH `getByRole('dialog')`. The produto editor
   * has its own "Cancelar" in the form footer and its own "Excluir" in
   * ObjectView's delete-confirm, so an unscoped locator resolves to two elements
   * and Playwright's strict mode refuses the click.
   */
  async function criarAnuncio(page: Page, contaId: string): Promise<void> {
    await page.getByTestId(`ml-novo-anuncio-${contaId}`).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Criar anúncio' }).click();
  }

  /**
   * Open the Mercado Livre tab, then ONE account's tab inside it, and return
   * that account's card.
   *
   * The account tab's accessible name is the integração's `nome`, which
   * `seedIntegracaoFixtures` sets equal to its doc id — so the run-scoped id is
   * also the label. Matched by substring on purpose: the tab also carries a
   * badge ("Não publicado", or the listing count), so an exact match would never
   * hit.
   */
  async function abrirConta(page: Page, contaId: string): Promise<Locator> {
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();
    await page.getByRole('tab', { name: contaId }).click({ timeout: 30_000 });
    const card = page.getByTestId(`ml-conta-${contaId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    return card;
  }

  test('surfaces the published link-doc status for the bound account', async ({ page }) => {
    await page.goto(`/produtos/${produtoId}/editar`);
    const card = await abrirConta(page, contaLinked);

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
    const card = await abrirConta(page, contaUnlinked);

    await expect(card.getByText('Não publicado')).toBeVisible();
    await expect(card.getByText('Nenhum anúncio desta conta para este produto.')).toBeVisible();
    // Publishing straight from here cannot succeed: with no link doc there is
    // no category, and publish rejects that before it writes anything — so the
    // failure would leave nothing behind and the next attempt would fail
    // identically. Creating the draft is what breaks that cycle, and there is
    // no publish control until one exists.
    await expect(card.getByRole('button', { name: 'Publicar no Mercado Livre' })).toHaveCount(0);

    // The listing type is chosen in the dialog, not in the panel: once a listing
    // exists its own form owns that value, and a second control for it beside
    // the form would be two inputs for one thing.
    await page.getByTestId(`ml-novo-anuncio-${contaUnlinked}`).click();
    const dialogo = page.getByRole('dialog');
    // ⚠️ `getByRole('combobox')`, not `getByLabel`: a Mantine `Select` renders
    // its listbox `aria-labelledby` the SAME label as its input, so `getByLabel`
    // resolves to two elements once the dropdown exists.
    await expect(dialogo.getByRole('combobox', { name: 'Tipo de anúncio' })).toBeVisible();
    await dialogo.getByRole('button', { name: 'Cancelar' }).click();
  });

  test('preparing a draft opens the editor and keeps publish gated on a category', async ({
    page,
  }) => {
    await page.goto(`/produtos/${produtoId}/editar`);
    const card = await abrirConta(page, contaDraft);

    // Tolerate a draft left by an earlier attempt of this same test: the FIRST
    // draft on an account takes the integração id as its doc id, so creating it
    // twice is a no-op rather than a second listing.
    if ((await card.locator('[data-testid^="ml-anuncio-"]').count()) === 0) {
      await criarAnuncio(page, contaDraft);
    }

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

    // The PUBLISHED account, because it is the one whose publish button is
    // reachable: an unbound account now prepares a draft first, which is a
    // Firestore write and never touches the backend under test here.
    const card = await abrirConta(page, contaLinked);
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

    // One account at a time now — they are tabs, not stacked cards — and each
    // negative assertion follows its own tab click, so "the button is absent"
    // can never be "the panel was never built".
    const linked = await abrirConta(page, contaLinked);
    await expect(linked.getByRole('button', { name: 'Enviar estoque' })).toBeEnabled();

    // Positive first: the account really has nothing published, which is WHY the
    // button is absent.
    const unlinked = await abrirConta(page, contaUnlinked);
    await expect(unlinked.getByText('Não publicado')).toBeVisible();
    await expect(unlinked.getByRole('button', { name: 'Enviar estoque' })).toHaveCount(0);

    // ⚠️ A DRAFT is the case the old gate got wrong, and it needs the draft to
    // actually EXIST to mean anything: with no link doc the button is absent for
    // the boring reason, which is the same assertion passing for the wrong cause.
    // So prepare one (tolerating a draft left by another test — the draft doc id
    // is the integração id, so preparing twice is a no-op) and prove the listing
    // is there before asserting the button is not.
    const draft = await abrirConta(page, contaDraft);
    if ((await draft.getByText('Rascunho — ainda não publicado').count()) === 0) {
      await criarAnuncio(page, contaDraft);
    }
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
    const card = await abrirConta(page, contaLinked);
    await card.getByRole('button', { name: 'Enviar estoque' }).click();

    // A CONTA-level failure (the request never reached the backend) names no
    // listing, so it has nowhere inline to land and surfaces as a toast. Only a
    // per-LISTING outcome — which requires a response — renders on the anúncio.
    await expect(
      page.getByText('Não foi possível contatar o serviço do Mercado Livre.'),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('keeps the tab open with its state when another tab is visited', async ({ page }) => {
    await page.goto(`/produtos/${produtoId}/editar`);
    const card = await abrirConta(page, contaLinked);

    // A piece of state that lives INSIDE the listing form and is persisted
    // nowhere: the descrição disclosure. The seed stores `descricao: null`, so
    // it starts closed. Chosen over typing into a field on purpose — it proves
    // the form survived without leaving the page dirty for the next test.
    const descricao = card.getByTestId('ml-descricao-wrapper');
    await expect(descricao).toHaveAttribute('data-open', 'false');
    await card.getByRole('button', { name: 'Descrição do anúncio' }).click();
    await expect(descricao).toHaveAttribute('data-open', 'true');

    await page.getByRole('tab', { name: 'Fotos' }).click();
    await expect(page.getByRole('tab', { name: 'Fotos' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    // Still open: the panel was never suspended, so neither the Firestore
    // listeners nor the listing form were torn down and rebuilt. The account
    // tab selection survived too — it is state inside that same panel.
    await expect(descricao).toHaveAttribute('data-open', 'true');
    await expect(page.getByRole('tab', { name: contaLinked })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test("keeps an account's listing state when another account is visited", async ({ page }) => {
    // The same guarantee one level down, and the reason the account panels are
    // not `<Activity>`-suspended: an off-screen account keeps its listing forms
    // mounted, so their unsaved edits and their registration in the produto's
    // save still exist when the operator comes back.
    await page.goto(`/produtos/${produtoId}/editar`);
    const card = await abrirConta(page, contaLinked);

    const descricao = card.getByTestId('ml-descricao-wrapper');
    await expect(descricao).toHaveAttribute('data-open', 'false');
    await card.getByRole('button', { name: 'Descrição do anúncio' }).click();
    await expect(descricao).toHaveAttribute('data-open', 'true');

    // Positive assertion on the account we switch to: without it a click that
    // silently did nothing would leave the check below passing for the wrong
    // reason.
    const outra = await abrirConta(page, contaUnlinked);
    await expect(outra.getByText('Não publicado')).toBeVisible();

    await page.getByRole('tab', { name: contaLinked }).click();
    await expect(descricao).toHaveAttribute('data-open', 'true');
  });

  test('adds a second anúncio to an account that already has one', async ({ page }) => {
    // What this whole screen exists for. The old "Preparar anúncio" only
    // appeared while the account had NO listing, and the draft's doc id was the
    // integração id — so a second one was unreachable and, had it been reached,
    // unwritable.
    await page.goto(`/produtos/${produtoId}/editar`);
    const card = await abrirConta(page, contaMulti);

    const anuncios = card.locator('[data-testid^="ml-anuncio-"]');
    // Idempotent across `describe.serial` retries: create only as many as are
    // missing, so a re-run does not stack a third and a fourth.
    while ((await anuncios.count()) < 2) {
      const antes = await anuncios.count();
      await criarAnuncio(page, contaMulti);
      await expect(anuncios).toHaveCount(antes + 1, { timeout: 15_000 });
    }

    await expect(anuncios).toHaveCount(2);
    // Both are drafts, and each carries its own form rather than the two
    // collapsing onto one record.
    await expect(card.getByText('Rascunho — ainda não publicado')).toHaveCount(2);
  });

  test('removes a draft that was never published', async ({ page }) => {
    // The affordance "Novo anúncio" makes necessary: it is the first way to
    // create a link doc that is pure clutter, so there has to be a way back.
    await page.goto(`/produtos/${produtoId}/editar`);
    const card = await abrirConta(page, contaExcluir);

    const anuncios = card.locator('[data-testid^="ml-anuncio-"]');
    if ((await anuncios.count()) === 0) await criarAnuncio(page, contaExcluir);
    await expect(anuncios).toHaveCount(1, { timeout: 15_000 });

    await card.getByRole('button', { name: 'Excluir anúncio' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Excluir', exact: true }).click();

    await expect(anuncios).toHaveCount(0, { timeout: 15_000 });
    await expect(card.getByText('Nenhum anúncio desta conta para este produto.')).toBeVisible();
  });

  test('shows the tab with a "save first" message on the create screen', async ({ page }) => {
    await page.goto('/produtos/novo');
    await expect(page.getByRole('heading', { name: 'Novo produto' })).toBeVisible();
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    // No produtoId yet — publishing, the stock push and the link subcollection
    // all need a produto that exists, so the tab explains itself instead of
    // disappearing.
    await expect(page.getByText('Salve o produto para continuar.')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('button', { name: 'Novo anúncio' })).toHaveCount(0);
  });
});
