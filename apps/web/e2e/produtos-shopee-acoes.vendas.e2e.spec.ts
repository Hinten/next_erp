import { expect, test, type Page } from '@playwright/test';
import { ACAO_STATUS_ANUNCIO, ESTADO_ANUNCIO_SHOPEE } from '@delfrance/schemas';
import type {
  AnuncioStatusShopee,
  EnvioEstoqueManualShopee,
  EnvioPrecoManualShopee,
} from '../lib/shopee/wire';
import {
  SHOPEE_E2E_ITEM_ATIVO,
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  cleanupShopeeFixtures,
  e2ePrefix,
  seedProdutoShopeeVinculado,
  seedShopeeFixtures,
} from './_helpers/seed-data';
import { searchTableView } from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * The `/produtos` bulk actions — Enviar estoque, Enviar preços, Pausar anúncios —
 * reaching a SHOPEE conta (master-plan step 22, #1530). Each resolves the conta
 * through `MARKETPLACE_TIPO_CAPS` and the three web registries, so this spec is
 * what proves the caps row and the registries let a selection through: with the
 * row unbuilt, a Shopee conta answers one `canal-nao-implementado` row per
 * produto and nothing leaves the browser.
 *
 * The apps/shopee backend does NOT run in this suite. Every route under
 * `/api/marketplace/shopee/` is intercepted on the PATHNAME (any host the build's
 * `NEXT_PUBLIC_SHOPEE_URL` names) and RECORDED with its body; the three push
 * routes answer the body the real route builds (typed by the browser's own wire
 * schema, so a stub cannot drift from what the dialog parses), any other route is
 * answered 404 and recorded in `semStub` — and every test asserts that list is
 * empty. What a real push does on Shopee is the route's own suite's to prove;
 * this proves what the browser SENDS and what the dialog SHOWS.
 *
 * Staging is shared, so nothing here reads beyond the run-scoped produto and
 * conta: the selection is ONE seeded produto whose `integracoesComProduto` names
 * ONE seeded conta, and every row locator is scoped by its run-scoped key.
 */

const PREFIXO_ROTAS = '/api/marketplace/shopee/';

const MENSAGEM_ESTOQUE = 'Estoque enviado à Shopee (resposta do e2e).';
const MENSAGEM_PRECO = 'Preço enviado à Shopee (resposta do e2e).';
const MENSAGEM_PAUSA = 'Anúncio pausado na Shopee (resposta do e2e).';

/** The sentence an unbuilt channel's conta earns (`mensagemNaoSuportado`). */
const NAO_IMPLEMENTADO = /ainda não foi implementado aqui/;

interface Chamada {
  readonly metodo: string;
  readonly rota: string;
  readonly corpo: Record<string, unknown> | null;
}

interface StubsShopee {
  /** Every Shopee backend call the page made, in order. */
  readonly chamadas: Chamada[];
  /** Calls to a Shopee route this spec does not stub (answered 404, never forwarded). */
  readonly semStub: string[];
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

const texto = (v: unknown): string => (typeof v === 'string' ? v : '');
const primeiroProduto = (corpo: Record<string, unknown> | null): string =>
  Array.isArray(corpo?.produtoIds) ? texto(corpo.produtoIds[0]) : '';

type Responder = (corpo: Record<string, unknown> | null) => unknown;

/** The three push routes' 200 for the ONE live listing the seeded produto holds. */
function rotasComStub(linkAtivo: string): ReadonlyMap<string, Responder> {
  const anuncioId = String(SHOPEE_E2E_ITEM_ATIVO);
  const estoque = (corpo: Record<string, unknown> | null): EnvioEstoqueManualShopee => ({
    canal: 'shopee',
    integracaoId: texto(corpo?.integracaoId),
    listings: [
      {
        produtoId: primeiroProduto(corpo),
        produtoNome: null,
        anuncioId,
        linkDocId: linkAtivo,
        outcome: 'enviado',
        motivo: null,
        mensagem: MENSAGEM_ESTOQUE,
        quantidade: 7,
        modelosRecusados: 0,
        clampados: 0,
      },
    ],
    produtosSemEnvio: [],
    pausadoAte: null,
  });
  const precos = (corpo: Record<string, unknown> | null): EnvioPrecoManualShopee => ({
    canal: 'shopee',
    integracaoId: texto(corpo?.integracaoId),
    listings: [
      {
        produtoId: primeiroProduto(corpo),
        produtoNome: null,
        variacaoProdutoId: null,
        anuncioId,
        linkDocId: linkAtivo,
        outcome: 'enviado',
        motivo: null,
        mensagem: MENSAGEM_PRECO,
        preco: 79.9,
        precoAnterior: 89.9,
        codigo: null,
        variacaoNome: null,
        variacaoSku: null,
      },
    ],
    produtosSemEnvio: [],
    pausadoAte: null,
  });
  const status = (corpo: Record<string, unknown> | null): AnuncioStatusShopee => ({
    canal: 'shopee',
    integracaoId: texto(corpo?.integracaoId),
    acao: ACAO_STATUS_ANUNCIO.pausar,
    listings: [
      {
        produtoId: primeiroProduto(corpo),
        produtoNome: null,
        anuncioId,
        linkDocId: linkAtivo,
        outcome: 'enviado',
        motivo: null,
        mensagem: MENSAGEM_PAUSA,
        statusFinal: 'UNLIST',
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.pausado,
      },
    ],
    produtosSemAnuncio: [],
    pausadoAte: null,
  });
  return new Map<string, Responder>([
    ['enviar-estoque', estoque],
    ['enviar-precos', precos],
    ['anuncio-status', status],
  ]);
}

/**
 * Intercept every apps/shopee route. MUST run BEFORE `page.goto`. Playwright
 * answers the CORS preflight itself (the backend is cross-origin), so only the
 * real requests land here.
 */
async function instalarStubsShopee(page: Page, linkAtivo: string): Promise<StubsShopee> {
  const stubs: StubsShopee = { chamadas: [], semStub: [] };
  const rotas = rotasComStub(linkAtivo);
  await page.route(
    (url) => url.pathname.startsWith(PREFIXO_ROTAS),
    async (route) => {
      const pedido = route.request();
      const url = new URL(pedido.url());
      const rota = url.pathname.slice(PREFIXO_ROTAS.length);
      const corpo = corpoDaChamada(pedido.postData());
      stubs.chamadas.push({ metodo: pedido.method(), rota, corpo });
      const responder = rotas.get(rota);
      if (!responder) stubs.semStub.push(`${pedido.method()} ${url.pathname}`);
      await route.fulfill({
        status: responder ? 200 : 404,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify(
          responder
            ? responder(corpo)
            : { error: 'Rota da Shopee sem stub neste e2e.', code: 'E2E_SEM_STUB' },
        ),
      });
    },
  );
  return stubs;
}

test.describe.serial('Produtos — the bulk actions reach a Shopee conta', () => {
  const prefix = e2ePrefix('shpmassa');
  const conta = `${prefix}-001`;
  // Deterministic (mirrors `seedProdutoShopeeVinculado`) so afterAll can always
  // sweep the link SUBCOLLECTION even when beforeAll dies mid-way.
  const produtoId = `${prefix}-prod`;
  const linkAtivo = `${prefix}-ativo`;
  /** `makeRowKeyer`'s first key for the one listing every stub answers. */
  const chaveDaLinha = `${produtoId}:${conta}:${String(SHOPEE_E2E_ITEM_ATIVO)}`;

  test.beforeAll(async ({ browser }) => {
    // Compiling cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      // The link seed stamps the conta's `shop_id`, so the conta comes first.
      seedShopeeFixtures(prefix, 1).then(() => seedProdutoShopeeVinculado(prefix, conta)),
      warmRoutes(browser, ['/produtos']),
    ]);
  });

  test.afterAll(async () => {
    await cleanupProdutoSubcollection(produtoId, 'prodshopee');
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupShopeeFixtures(prefix);
  });

  /** Find the seeded produto, select it, and open one bulk action's dialog. */
  async function abrirAcao(page: Page, acao: string): Promise<void> {
    await page.goto('/produtos');
    await searchTableView(page, prefix);
    await expect(page.getByRole('link', { name: produtoId, exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByLabel(`Selecionar ${produtoId}`).check();
    await page.getByRole('button', { name: acao }).click();
  }

  test("sends the selection's stock to the Shopee conta and shows its row", async ({ page }) => {
    const stubs = await instalarStubsShopee(page, linkAtivo);
    await abrirAcao(page, 'Enviar estoque');
    const dialogo = page.getByRole('dialog', { name: 'Enviando estoque para os marketplaces' });
    await expect(dialogo).toBeVisible();
    // Nothing leaves the browser before the operator confirms.
    expect(stubs.chamadas).toEqual([]);
    await dialogo.getByRole('button', { name: 'Enviar estoque' }).click();

    await expect(dialogo.getByTestId(`envio-estoque-row-${chaveDaLinha}`)).toContainText(
      MENSAGEM_ESTOQUE,
      { timeout: 30_000 },
    );
    await expect(dialogo.getByText('Enviados 1 · Pulados 0 · Falhas 0')).toBeVisible();
    await expect(dialogo.getByText(NAO_IMPLEMENTADO)).toHaveCount(0);
    expect(stubs.chamadas).toEqual([
      {
        metodo: 'POST',
        rota: 'enviar-estoque',
        corpo: { integracaoId: conta, produtoIds: [produtoId], reenviarComErro: false },
      },
    ]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test("sends the selection's prices to the Shopee conta, without the Mercado Livre-only option", async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, linkAtivo);
    await abrirAcao(page, 'Enviar preços');
    const dialogo = page.getByRole('dialog', { name: 'Enviando preços para os marketplaces' });
    await expect(dialogo).toBeVisible();
    expect(stubs.chamadas).toEqual([]);
    await dialogo.getByRole('button', { name: 'Enviar preços' }).click();

    await expect(dialogo.getByTestId(`envio-preco-row-${chaveDaLinha}`)).toContainText(
      MENSAGEM_PRECO,
      { timeout: 30_000 },
    );
    await expect(dialogo.getByText('Enviados 1 · Pulados 0 · Falhas 0')).toBeVisible();
    await expect(dialogo.getByText(NAO_IMPLEMENTADO)).toHaveCount(0);
    // ⚠️ The near-miss: `incluirNaoPublicados` is Mercado Livre's, and the Shopee
    // client rebuilds the body by name — so the key is ABSENT, not false.
    expect(stubs.chamadas).toEqual([
      {
        metodo: 'POST',
        rota: 'enviar-precos',
        corpo: { integracaoId: conta, produtoIds: [produtoId], baixarPreco: false },
      },
    ]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test("pauses the selection's Shopee listings for the whole conta, naming no single link", async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, linkAtivo);
    await abrirAcao(page, 'Pausar anúncios');
    const dialogo = page.getByRole('dialog', { name: 'Pausando anúncios nos marketplaces' });
    await expect(dialogo).toBeVisible();
    expect(stubs.chamadas).toEqual([]);
    await dialogo.getByRole('button', { name: 'Pausar anúncios' }).click();

    await expect(dialogo.getByTestId(`pausar-anuncio-row-${chaveDaLinha}`)).toContainText(
      MENSAGEM_PAUSA,
      { timeout: 30_000 },
    );
    await expect(dialogo.getByText('Pausados 1 · Pulados 0 · Falhas 0')).toBeVisible();
    await expect(dialogo.getByText(NAO_IMPLEMENTADO)).toHaveCount(0);
    // ⚠️ The near-miss: the produto tab's pause names ONE `linkDocId`; the bulk
    // path names none and covers every listing the selection holds on the conta.
    expect(stubs.chamadas).toEqual([
      {
        metodo: 'POST',
        rota: 'anuncio-status',
        corpo: { integracaoId: conta, produtoIds: [produtoId], acao: ACAO_STATUS_ANUNCIO.pausar },
      },
    ]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });
});
