import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  SHOPEE_E2E_ITEM_ATIVO,
  SHOPEE_E2E_SHOP_ID,
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  cleanupShopeeFixtures,
  e2ePrefix,
  seedProdutoShopeeVinculado,
  seedShopeeFixtures,
} from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the produto editor's **Shopee** tab (step 21-3,
 * #1529): the state of each EXISTING listing, read live from its
 * `produtos/<id>/prodshopee` link document.
 *
 * The apps/shopee backend does NOT run in this suite. Every route under
 * `/api/marketplace/shopee/` is intercepted on the PATHNAME (any host the
 * build's `NEXT_PUBLIC_SHOPEE_URL` names): a route this spec has no stub for is
 * answered 404 and RECORDED in `semStub`, never forwarded — and each test
 * asserts that list is empty. The read-only tab calls none of them; the actions
 * that do (pause, re-verify, republish) add their stubs with their tests.
 *
 * The tab lists every Shopee conta on staging (shared project), so every
 * assertion is scoped by the run-scoped `data-testid="shopee-conta-<id>"` /
 * `shopee-anuncio-<linkDocId>`. Navigation is TWO levels — the Shopee tab, then
 * the conta's tab inside it — and a conta's panel is lazy, so a `toHaveCount(0)`
 * is always paired with something positive proving the panel rendered.
 */

const PREFIXO_ROTAS = '/api/marketplace/shopee/';

type Resposta = { readonly status: number; readonly corpo: unknown };

/**
 * The apps/shopee routes this spec answers, by path under {@link PREFIXO_ROTAS}.
 * Empty: nothing the read-only tab renders comes from the service.
 */
const ROTAS_COM_STUB: ReadonlyMap<string, (url: URL) => Resposta> = new Map();

interface StubsShopee {
  /** Calls to a Shopee route this spec does not stub (answered 404, never forwarded). */
  readonly semStub: string[];
}

/**
 * Intercept every apps/shopee route. MUST run BEFORE `page.goto`. Playwright
 * answers the CORS preflight itself (the backend is cross-origin), so only the
 * real requests land here.
 */
async function instalarStubsShopee(page: Page): Promise<StubsShopee> {
  const stubs: StubsShopee = { semStub: [] };
  await page.route(
    (url) => url.pathname.startsWith(PREFIXO_ROTAS),
    async (route) => {
      const pedido = route.request();
      const url = new URL(pedido.url());
      const responder = ROTAS_COM_STUB.get(url.pathname.slice(PREFIXO_ROTAS.length));
      let resposta = responder?.(url) ?? null;
      if (resposta === null) {
        stubs.semStub.push(`${pedido.method()} ${url.pathname}`);
        resposta = {
          status: 404,
          corpo: { error: 'Rota da Shopee sem stub neste e2e.', code: 'E2E_SEM_STUB' },
        };
      }
      await route.fulfill({
        status: resposta.status,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify(resposta.corpo),
      });
    },
  );
  return stubs;
}

test.describe.serial('Produto Shopee tab e2e — listing state', () => {
  const prefix = e2ePrefix('shpaba');
  const conta = `${prefix}-001`;
  // Deterministic (mirrors `seedProdutoShopeeVinculado`) so afterAll can always
  // sweep the link SUBCOLLECTION even when beforeAll dies mid-way: the
  // nome-prefix sweep only reaches the parent doc, and Firestore never cascades.
  const produtoId = `${prefix}-prod`;
  const links = {
    ativo: `${prefix}-ativo`,
    kitRemovido: `${prefix}-kit-removido`,
    rascunho: `${prefix}-rascunho`,
  };

  test.beforeAll(async ({ browser }) => {
    // Compiling cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      // The link seed stamps the conta's `shop_id`, so the conta comes first.
      seedShopeeFixtures(prefix, 1).then(() => seedProdutoShopeeVinculado(prefix, conta)),
      warmRoutes(browser, ['/produtos/__aquecimento__/editar']),
    ]);
  });

  test.afterAll(async () => {
    await cleanupProdutoSubcollection(produtoId, 'prodshopee');
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupShopeeFixtures(prefix);
  });

  /**
   * Open the Shopee tab, then the conta's tab inside it, and return its panel.
   *
   * The conta tab's accessible name holds the integração's `nome`, which
   * `seedIntegracaoFixtures` sets equal to its doc id, plus a badge — so it is
   * matched by substring. The produto tab is matched EXACTLY: a conta tab's
   * name could contain "Shopee" too.
   */
  async function abrirConta(page: Page, contaId: string): Promise<Locator> {
    await page.getByRole('tab', { name: 'Shopee', exact: true }).click({ timeout: 30_000 });
    await page.getByRole('tab', { name: contaId }).click({ timeout: 30_000 });
    const painel = page.getByTestId(`shopee-conta-${contaId}`);
    await expect(painel).toBeVisible({ timeout: 30_000 });
    return painel;
  }

  test("shows each listing's state from its link document", async ({ page }) => {
    const stubs = await instalarStubsShopee(page);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    const ativo = painel.getByTestId(`shopee-anuncio-${links.ativo}`);
    await expect(ativo.getByText('Ativo', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(ativo.getByText('Rebaixado na busca')).toBeVisible();
    await expect(
      ativo.getByText('A foto principal semeada pelo e2e está desfocada.'),
    ).toBeVisible();
    await expect(ativo.getByText(/Recusa de preço semeada pelo e2e\./)).toBeVisible();
    await expect(ativo.getByRole('link', { name: 'Ver na Shopee' })).toHaveAttribute(
      'href',
      `https://shopee.com.br/product/${String(SHOPEE_E2E_SHOP_ID)}/${String(SHOPEE_E2E_ITEM_ATIVO)}`,
    );

    const removido = painel.getByTestId(`shopee-anuncio-${links.kitRemovido}`);
    await expect(removido.getByText('Removido', { exact: true })).toBeVisible();

    // A draft names no listing: no storefront link — asserted only after the
    // positive "Não publicado" proves the block rendered.
    const rascunho = painel.getByTestId(`shopee-anuncio-${links.rascunho}`);
    await expect(rascunho.getByText('Não publicado', { exact: true })).toBeVisible();
    await expect(rascunho.getByRole('link', { name: 'Ver na Shopee' })).toHaveCount(0);

    // Live first, then the removed kit, then the draft.
    const ordem = await painel
      .locator('[data-testid^="shopee-anuncio-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(ordem).toEqual([
      `shopee-anuncio-${links.ativo}`,
      `shopee-anuncio-${links.kitRemovido}`,
      `shopee-anuncio-${links.rascunho}`,
    ]);

    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('shows the listings from Firestore while the shopee service is unreachable', async ({
    page,
  }) => {
    // Every apps/shopee request fails at the network: the tab must still
    // render the state it reads from the link documents.
    await page.route(
      (url) => url.pathname.startsWith(PREFIXO_ROTAS),
      (route) => route.abort('connectionrefused'),
    );
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    const ativo = painel.getByTestId(`shopee-anuncio-${links.ativo}`);
    await expect(ativo.getByText('Ativo', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(painel.getByText(/Erro ao carregar os anúncios da Shopee/)).toHaveCount(0);
  });
});
