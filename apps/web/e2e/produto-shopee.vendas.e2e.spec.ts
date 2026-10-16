import { expect, test, type Locator, type Page } from '@playwright/test';
import { ACAO_STATUS_ANUNCIO, ESTADO_ANUNCIO_SHOPEE } from '@delfrance/schemas';
import type { AnuncioStatusShopee } from '../lib/shopee/wire';
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
 * `produtos/<id>/prodshopee` link document, and the actions on it.
 *
 * The apps/shopee backend does NOT run in this suite. Every route under
 * `/api/marketplace/shopee/` is intercepted on the PATHNAME (any host the
 * build's `NEXT_PUBLIC_SHOPEE_URL` names) and RECORDED with its body: a route
 * in {@link ROTAS_COM_STUB} answers the body the real route builds; any other
 * is answered 404, recorded in `semStub` and never forwarded — and each test
 * asserts that list is empty. What a real pause does on Shopee is the route's
 * own suite's to prove; this proves what the browser SENDS and what it SHOWS.
 *
 * The tab lists every Shopee conta on staging (shared project), so every
 * assertion is scoped by the run-scoped `data-testid="shopee-conta-<id>"` /
 * `shopee-anuncio-<linkDocId>`. Navigation is TWO levels — the Shopee tab, then
 * the conta's tab inside it — and a conta's panel is lazy, so a `toHaveCount(0)`
 * is always paired with something positive proving the panel rendered.
 */

const PREFIXO_ROTAS = '/api/marketplace/shopee/';

/** The pause run's per-listing sentence this spec answers with — rendered verbatim. */
const MENSAGEM_PAUSA_STUB = 'Anúncio pausado na Shopee (resposta do e2e).';

type Resposta = { readonly status: number; readonly corpo: unknown };

/** One recorded request to the apps/shopee backend. */
interface Chamada {
  readonly metodo: string;
  readonly rota: string;
  readonly corpo: Record<string, unknown> | null;
}

/** A request body, parsed — or a marker the body assertion will print. */
function corpoDaChamada(corpo: string | null): Record<string, unknown> | null {
  if (corpo === null) return null;
  try {
    return JSON.parse(corpo) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) return { corpoNaoJson: corpo };
    throw err;
  }
}

/**
 * The pause/reactivate run's 200 for the ONE listing the request named — the
 * key set `anuncio-status/route.ts` builds by name, typed by the browser's own
 * wire schema so the stub cannot drift from what the tab parses.
 */
function respostaDoStatus(corpo: Record<string, unknown> | null): AnuncioStatusShopee {
  const produtoIds = Array.isArray(corpo?.produtoIds) ? corpo.produtoIds : [];
  const reativar = corpo?.acao === ACAO_STATUS_ANUNCIO.reativar;
  return {
    canal: 'shopee',
    integracaoId: typeof corpo?.integracaoId === 'string' ? corpo.integracaoId : '',
    acao: reativar ? ACAO_STATUS_ANUNCIO.reativar : ACAO_STATUS_ANUNCIO.pausar,
    listings: [
      {
        produtoId: typeof produtoIds[0] === 'string' ? produtoIds[0] : '',
        produtoNome: null,
        anuncioId: String(SHOPEE_E2E_ITEM_ATIVO),
        linkDocId: typeof corpo?.linkDocId === 'string' ? corpo.linkDocId : null,
        outcome: 'enviado',
        motivo: null,
        mensagem: MENSAGEM_PAUSA_STUB,
        statusFinal: reativar ? 'NORMAL' : 'UNLIST',
        estadoAnuncio: reativar ? ESTADO_ANUNCIO_SHOPEE.ativo : ESTADO_ANUNCIO_SHOPEE.pausado,
      },
    ],
    produtosSemAnuncio: [],
    pausadoAte: null,
  };
}

/** The apps/shopee routes this spec answers, by path under {@link PREFIXO_ROTAS}. */
const ROTAS_COM_STUB: ReadonlyMap<string, (corpo: Record<string, unknown> | null) => Resposta> =
  new Map([['anuncio-status', (corpo) => ({ status: 200, corpo: respostaDoStatus(corpo) })]]);

interface StubsShopee {
  /** Every Shopee backend call the page made, in order. */
  readonly chamadas: Chamada[];
  /** Calls to a Shopee route this spec does not stub (answered 404, never forwarded). */
  readonly semStub: string[];
}

/**
 * Intercept every apps/shopee route. MUST run BEFORE `page.goto`. Playwright
 * answers the CORS preflight itself (the backend is cross-origin), so only the
 * real requests land here. A route registered AFTER this one takes precedence
 * (Playwright tries the newest handler first) — how test 6 cuts one route off.
 */
async function instalarStubsShopee(page: Page): Promise<StubsShopee> {
  const stubs: StubsShopee = { chamadas: [], semStub: [] };
  await page.route(
    (url) => url.pathname.startsWith(PREFIXO_ROTAS),
    async (route) => {
      const pedido = route.request();
      const url = new URL(pedido.url());
      const rota = url.pathname.slice(PREFIXO_ROTAS.length);
      const corpo = corpoDaChamada(pedido.postData());
      stubs.chamadas.push({ metodo: pedido.method(), rota, corpo });
      let resposta = ROTAS_COM_STUB.get(rota)?.(corpo) ?? null;
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

test.describe.serial('Produto Shopee tab e2e — listing state and actions', () => {
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

  test('pauses one listing by its link, after a confirmation', async ({ page }) => {
    const stubs = await instalarStubsShopee(page);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    const ativo = painel.getByTestId(`shopee-anuncio-${links.ativo}`);
    await ativo.getByRole('button', { name: 'Pausar anúncio' }).click({ timeout: 30_000 });
    const dialogo = page.getByRole('dialog', { name: 'Pausar anúncio' });
    await expect(dialogo).toBeVisible();
    // Nothing leaves the browser before the operator confirms.
    expect(stubs.chamadas).toEqual([]);
    await dialogo.getByRole('button', { name: 'Pausar', exact: true }).click();

    // The run's own per-listing sentence, in THIS listing's block.
    await expect(ativo.getByText(MENSAGEM_PAUSA_STUB)).toBeVisible({ timeout: 30_000 });
    expect(stubs.chamadas).toEqual([
      {
        metodo: 'POST',
        rota: 'anuncio-status',
        corpo: {
          integracaoId: conta,
          produtoIds: [produtoId],
          acao: ACAO_STATUS_ANUNCIO.pausar,
          linkDocId: links.ativo,
        },
      },
    ]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('shows no Publicar on a draft link, only where a first publish will come from', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    // Positive first: the live listing offers its republish, so the action
    // rows rendered for this operator.
    await expect(
      painel
        .getByTestId(`shopee-anuncio-${links.ativo}`)
        .getByRole('button', { name: 'Republicar', exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    const rascunho = painel.getByTestId(`shopee-anuncio-${links.rascunho}`);
    await expect(
      rascunho.getByText('Primeira publicação: chega na etapa de autoria do anúncio.'),
    ).toBeVisible();
    await expect(rascunho.getByRole('button', { name: /Publicar/ })).toHaveCount(0);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('keeps the listing state and says so when the shopee service is unreachable', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page);
    // Registered AFTER the stubs, so it wins for this one route: the re-verify
    // fails at the network.
    await page.route(
      (url) => url.pathname === `${PREFIXO_ROTAS}reverificar-anuncio`,
      (route) => route.abort('connectionrefused'),
    );
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    const ativo = painel.getByTestId(`shopee-anuncio-${links.ativo}`);
    await expect(ativo.getByText('Ativo', { exact: true })).toBeVisible({ timeout: 30_000 });
    await ativo.getByRole('button', { name: 'Reverificar' }).click();

    await expect(
      ativo.getByText('Não foi possível contatar a integração com a Shopee.'),
    ).toBeVisible({ timeout: 30_000 });
    // The state the tab reads from Firestore is still there.
    await expect(ativo.getByText('Ativo', { exact: true })).toBeVisible();
    await expect(painel.getByText(/Erro ao carregar os anúncios da Shopee/)).toHaveCount(0);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });
});
