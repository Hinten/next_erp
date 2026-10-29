import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  ACAO_STATUS_ANUNCIO,
  ESTADO_ANUNCIO_SHOPEE,
  PADRAO_ID_RASCUNHO_SHOPEE,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  campoRascunhoShopeeSchema,
  type CampoRascunhoShopee,
  type RespostaAtualizarRascunhoShopee,
  type RespostaCriarRascunhoShopee,
  type RespostaDescartarRascunhoShopee,
} from '@delfrance/schemas';
import type { AnuncioStatusShopee, ProblemaShopee } from '../lib/shopee/wire';
import {
  SHOPEE_E2E_ITEM_ATIVO,
  SHOPEE_E2E_SHOP_ID,
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  cleanupShopeeFixtures,
  e2ePrefix,
  seedEditorRascunhoShopee,
  seedMarcaShopee,
  seedProdutoShopeeVinculado,
  seedShopeeFixtures,
} from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the produto editor's **Shopee** tab (step 21-3,
 * #1529): the state of each EXISTING listing, read live from its
 * `produtos/<id>/prodshopee` link document, and the actions on it — the
 * native-kit ones included (the confirmed Recriar on a removed kit, and a
 * refused publish worded by its motivo and its `acao`, never by the CLI
 * sentence the server writes beside them) — and, since #1911 P10, the listing
 * DRAFT editor: a draft link edited with its own buttons (Salvar rascunho /
 * Descartar — still no Publicar, which is P11's), a new draft opened per conta
 * by "Novo anúncio" and written only on Salvar rascunho, and the
 * second-listing confirmation.
 *
 * The apps/shopee backend does NOT run in this suite. Every route under
 * `/api/marketplace/shopee/` is intercepted on the PATHNAME (any host the
 * build's `NEXT_PUBLIC_SHOPEE_URL` names) and RECORDED with its body: a route
 * in {@link rotasComStub} answers the body the real route builds; any other
 * is answered 404, recorded in `semStub` and never forwarded — and each test
 * asserts that list is empty. What a real pause does on Shopee is the route's
 * own suite's to prove; this proves what the browser SENDS and what it SHOWS.
 * ⚠️ The draft routes are stubbed too, so no draft document is ever written,
 * created or deleted by this suite: every test opens the seeded draft as
 * seeded. That draft has no category, so the editor reads no category bands
 * and asks apps/shopee for nothing on render — no test needs a taxonomy stub.
 * A test that seeds or picks a category stubs `taxonomia/categorias` and
 * `taxonomia/limites` itself.
 *
 * The tab lists every Shopee conta on staging (shared project), so every
 * assertion is scoped by the run-scoped `data-testid="shopee-conta-<id>"` /
 * `shopee-anuncio-<linkDocId>` / `shopee-rascunho-<linkDocId>`. Navigation is
 * TWO levels — the Shopee tab, then the conta's tab inside it — and a conta's
 * panel is lazy, so a `toHaveCount(0)` is always paired with something
 * positive proving the panel rendered.
 */

const PREFIXO_ROTAS = '/api/marketplace/shopee/';

/** The pause run's per-listing sentence this spec answers with — rendered verbatim. */
const MENSAGEM_PAUSA_STUB = 'Anúncio pausado na Shopee (resposta do e2e).';

/** CLI copy — a flag, a `<verbo>:anuncio` script name or the word "comando" — never reaches the page. */
const TEXTO_DE_TERMINAL = /(^|\s)--[a-z]|:anuncio|comando/i;

/*
 * The draft editor's copy (#1911 P10), spelled here as the rest of this spec
 * spells the tab's copy: its source, `lib/shopee/anuncioProduto.ts`, imports the
 * browser's Shopee client (and through it the auth hook), which a Node spec
 * must not load. Each names the constant it mirrors.
 */

/** `FRASE_MARCA_NAO_ESCOLHIDA_SHOPEE` — the `marca-nao-escolhida` pendência. */
const PENDENCIA_MARCA = 'Escolha a marca deste rascunho (ou «Sem marca») antes de publicar.';
/** `FRASE_PENDENCIA_CATEGORIA_AUSENTE_SHOPEE` — the `categoria-ausente` pendência. */
const PENDENCIA_CATEGORIA = 'Escolha a categoria (uma categoria final da árvore da Shopee).';
/** `FRASE_PENDENCIA_SEM_DESCRICAO_SHOPEE`'s opening — the `sem-descricao` pendência. */
const PENDENCIA_SEM_DESCRICAO = /O anúncio não tem descrição/;
/** `FRASE_RASCUNHO_NOVO_SHOPEE` — a draft opened here and not saved yet. */
const FRASE_RASCUNHO_NOVO = 'Novo rascunho (ainda não salvo).';
/** `TITULO_SEGUNDO_ANUNCIO_SHOPEE` — the second-listing confirmation's title. */
const TITULO_SEGUNDO_ANUNCIO = 'Criar outro anúncio nesta conta?';
/** `ROTULO_CONFIRMAR_SEGUNDO_ANUNCIO_SHOPEE` — its confirming button. */
const ROTULO_CONFIRMAR_SEGUNDO_ANUNCIO = 'Criar rascunho mesmo assim';
/** `FRASE_CONFIRMAR_DESCARTE_SHOPEE` — the discard confirmation of a saved draft. */
const FRASE_CONFIRMAR_DESCARTE = 'O rascunho será excluído. Nada foi publicado na Shopee.';
/** `FRASE_RASCUNHO_CRIADO_SHOPEE` / `…_SALVO_…` / `…_DESCARTADO_…` — the three 2xx toasts. */
const TOAST_RASCUNHO_CRIADO = 'Rascunho criado.';
const TOAST_RASCUNHO_SALVO = 'Rascunho salvo.';
const TOAST_RASCUNHO_DESCARTADO = 'Rascunho descartado.';
/** `ROTULO_SEM_MARCA_SHOPEE` (`MarcaRascunhoShopee.tsx`) — the picker's own «Sem marca» option. */
const ROTULO_SEM_MARCA = 'Sem marca (No Brand)';

/**
 * The ONE brand seeded on conta 1's shortlist (`integracao/{id}/brandshopee`,
 * #1911 P9) by `seedMarcaShopee`, through the Marcas section's own writer rule
 * — a fixture id, never a real Shopee brand. Its two names DIFFER on purpose:
 * the draft's picker labels a row by its display name, while the draft stores
 * (and publish sends) its ORIGINAL name, so a body carrying the label is a
 * drift this spec sees.
 */
const MARCA_DA_CONTA = {
  brandId: 9_200_001,
  originalBrandName: 'E2E Brand',
  displayBrandName: 'Marca do e2e',
} as const;

/**
 * The sentence a draft link showed BEFORE the editor existed (P10 removed it
 * with its constant). Asserted absent: the draft block is the editor now.
 */
const FRASE_PRIMEIRA_PUBLICACAO_REMOVIDA =
  'Primeira publicação: chega na etapa de autoria do anúncio.';

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

/** A string member of a request body, or `''` (which no assertion of this spec expects). */
function textoDoCorpo(corpo: Record<string, unknown> | null, chave: string): string {
  const valor = corpo?.[chave];
  return typeof valor === 'string' ? valor : '';
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

/**
 * The publish route's 422 for a refusal decided BEFORE any Shopee write — the
 * keys `core/respond.ts`'s blocked arm builds by name. Two rows, each worded for
 * the CLI as the server words them: a removed native kit whose next step is a
 * structured `acao` (recriar, on the link it names), and an `instabilidade-shopee`
 * with no `acao`, which the tab words by its MOTIVO.
 */
function recusaDaPublicacao(
  corpo: Record<string, unknown> | null,
  kitRemovido: string,
): Record<string, unknown> {
  const produtoId = typeof corpo?.produtoId === 'string' ? corpo.produtoId : '';
  const problemas: ProblemaShopee[] = [
    {
      campo: 'linkDocId',
      motivo: 'listagem-removida',
      mensagem:
        `o kit do vínculo ${kitRemovido} foi removido na Shopee — publique com --link ` +
        `${kitRemovido} --recriar (publicar:anuncio)`,
      acao: { tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.recriar, linkDocId: kitRemovido },
    },
    {
      campo: null,
      motivo: 'instabilidade-shopee',
      mensagem:
        'a Shopee respondeu com instabilidade; a operação pode ter sido feita — rode ' +
        'exatamente o mesmo comando de novo daqui a 4 minutos',
      acao: null,
    },
  ];
  return {
    error: `Publicação bloqueada no produto ${produtoId}: ${String(problemas.length)} problema(s)`,
    code: 'SHOPEE_PUBLISH_BLOCKED',
    motivo: 'listagem-removida',
    produtoId,
    itemId: SHOPEE_E2E_ITEM_ATIVO,
    problemas,
  };
}

/**
 * The draft create's 201 — `{linkDocId, criado: true}`, the answer of the
 * draft route for a draft it created — typed by the shared answer schema's
 * type, so the stub cannot drift from what the tab parses.
 */
function respostaDoRascunhoCriado(
  corpo: Record<string, unknown> | null,
): RespostaCriarRascunhoShopee {
  return { linkDocId: textoDoCorpo(corpo, 'linkDocId'), criado: true };
}

/**
 * The draft edit's 200 — the fields it WROTE: here, every field the request's
 * `patch` named (the stub stores nothing, and nothing differs from a stub).
 * Read through the shared campo schema, so an unknown key is never echoed.
 */
function respostaDoRascunhoAtualizado(
  corpo: Record<string, unknown> | null,
): RespostaAtualizarRascunhoShopee {
  const patch = corpo?.patch;
  const gravados: CampoRascunhoShopee[] =
    typeof patch === 'object' && patch !== null
      ? Object.keys(patch).flatMap((chave) => {
          const lido = campoRascunhoShopeeSchema.safeParse(chave);
          return lido.success ? [lido.data] : [];
        })
      : [];
  return { linkDocId: textoDoCorpo(corpo, 'linkDocId'), gravados };
}

/** The draft discard's 200 for a draft with no uncertain create behind it. */
function respostaDoRascunhoDescartado(
  corpo: Record<string, unknown> | null,
): RespostaDescartarRascunhoShopee {
  return { linkDocId: textoDoCorpo(corpo, 'linkDocId'), descartado: true, criacaoIncerta: false };
}

/** The apps/shopee routes this spec answers, by path under {@link PREFIXO_ROTAS}. */
function rotasComStub(
  kitRemovido: string,
): ReadonlyMap<string, (corpo: Record<string, unknown> | null) => Resposta> {
  return new Map([
    ['anuncio-status', (corpo) => ({ status: 200, corpo: respostaDoStatus(corpo) })],
    ['publicar', (corpo) => ({ status: 422, corpo: recusaDaPublicacao(corpo, kitRemovido) })],
    // The three draft routes (#1911 P10). Answered 2xx and writing NOTHING, so
    // the seeded draft stays exactly as seeded for every later test.
    ['rascunho', (corpo) => ({ status: 201, corpo: respostaDoRascunhoCriado(corpo) })],
    [
      'rascunho/atualizar',
      (corpo) => ({ status: 200, corpo: respostaDoRascunhoAtualizado(corpo) }),
    ],
    [
      'rascunho/descartar',
      (corpo) => ({ status: 200, corpo: respostaDoRascunhoDescartado(corpo) }),
    ],
  ]);
}

interface StubsShopee {
  /**
   * Every Shopee backend call the page made, in order. A test whose page must
   * send nothing asserts it EMPTY, never `semStub` alone: every stubbed route
   * answers 2xx — the three draft writes, a pause, a publish — so a stray
   * call to one of them never reaches `semStub`.
   */
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
async function instalarStubsShopee(page: Page, kitRemovido: string): Promise<StubsShopee> {
  const stubs: StubsShopee = { chamadas: [], semStub: [] };
  const rotas = rotasComStub(kitRemovido);
  await page.route(
    (url) => url.pathname.startsWith(PREFIXO_ROTAS),
    async (route) => {
      const pedido = route.request();
      const url = new URL(pedido.url());
      const rota = url.pathname.slice(PREFIXO_ROTAS.length);
      const corpo = corpoDaChamada(pedido.postData());
      stubs.chamadas.push({ metodo: pedido.method(), rota, corpo });
      let resposta = rotas.get(rota)?.(corpo) ?? null;
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

/** The prefix of a draft editor's root test id; the rest is the draft's link doc id. */
const RAIZ_DO_RASCUNHO = 'shopee-rascunho-';

/**
 * The link doc id of the ONE draft editor in `painel` holding a "Salvar
 * rascunho" button — read off its root's test id. Its two pickers carry test
 * ids under the same prefix, but neither holds that button, so only the root
 * matches.
 */
async function idDoUnicoRascunho(painel: Locator): Promise<string> {
  const raiz = painel.locator(`[data-testid^="${RAIZ_DO_RASCUNHO}"]`).filter({
    has: painel.page().getByRole('button', { name: 'Salvar rascunho', exact: true }),
  });
  const testId = (await raiz.getAttribute('data-testid')) ?? '';
  return testId.slice(RAIZ_DO_RASCUNHO.length);
}

test.describe.serial('Produto Shopee tab e2e — listing state, actions and the native kit', () => {
  const prefix = e2ePrefix('shpaba');
  const conta = `${prefix}-001`;
  /** The second conta: it holds ONE removed listing of the produto and nothing else. */
  const contaSoRemovido = `${prefix}-002`;
  // Deterministic (mirrors `seedProdutoShopeeVinculado`) so afterAll can always
  // sweep the link SUBCOLLECTION even when beforeAll dies mid-way: the
  // nome-prefix sweep only reaches the parent doc, and Firestore never cascades.
  const produtoId = `${prefix}-prod`;
  const links = {
    ativo: `${prefix}-ativo`,
    kitRemovido: `${prefix}-kit-removido`,
    rascunho: `${prefix}-rascunho`,
    // Mirrors `seedEditorRascunhoShopee` — on `contaSoRemovido`.
    removido: `${prefix}-removido`,
  };
  /** The seeded draft's stored title — every edit's baseline. */
  const tituloGuardado = `${prefix}-rascunho`;

  test.beforeAll(async ({ browser }) => {
    // Compiling cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      // The link seed stamps the conta's `shop_id`, so the contas come first.
      seedShopeeFixtures(prefix, 2)
        .then(() => seedProdutoShopeeVinculado(prefix, conta))
        .then(() => seedEditorRascunhoShopee(prefix, contaSoRemovido)),
      warmRoutes(browser, ['/produtos/__aquecimento__/editar']),
    ]);
    // Once the conta exists: `cleanupShopeeFixtures` reaches a shortlist row
    // only through its conta.
    await seedMarcaShopee(conta, MARCA_DA_CONTA);
  });

  test.afterAll(async () => {
    await cleanupProdutoSubcollection(produtoId, 'prodshopee');
    await cleanupProdutoSubcollection(produtoId, 'extraData');
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
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
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

    // Showing the state sends nothing — no draft write, no pause, no publish.
    expect(stubs.chamadas).toEqual([]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('pauses one listing by its link, after a confirmation', async ({ page }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
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

  test('edits a draft link with its own buttons and pendências, and offers no Publicar on it', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    // Positive first: the live listing offers its republish, so the action
    // rows rendered for this operator.
    await expect(
      painel
        .getByTestId(`shopee-anuncio-${links.ativo}`)
        .getByRole('button', { name: 'Republicar', exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    // The draft block IS the editor now, with its own buttons; nothing differs
    // from what is stored yet, so there is nothing to save.
    const rascunho = painel.getByTestId(`shopee-anuncio-${links.rascunho}`);
    const editor = rascunho.getByTestId(`${RAIZ_DO_RASCUNHO}${links.rascunho}`);
    await expect(editor.getByRole('button', { name: 'Descartar', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const salvar = editor.getByRole('button', { name: 'Salvar rascunho', exact: true });
    await expect(salvar).toBeVisible();
    await expect(salvar).toBeDisabled();
    await expect(rascunho.getByText(FRASE_PRIMEIRA_PUBLICACAO_REMOVIDA)).toHaveCount(0);

    // The seeded draft has neither a category nor a brand: both pendências,
    // in every test that opens this conta.
    await expect(editor.getByText(PENDENCIA_CATEGORIA).first()).toBeVisible();
    await expect(editor.getByText(PENDENCIA_MARCA).first()).toBeVisible();
    // Its description is empty, but the produto's STORED Descrição stands in
    // for it — the document the publish reads — so no `sem-descricao`.
    await expect(editor.getByText(PENDENCIA_SEM_DESCRICAO)).toHaveCount(0);

    // ⚠️ Still no Publicar on a draft block: the first publish of a draft is
    // #1911 P11's, which inverts this line.
    await expect(rascunho.getByRole('button', { name: /Publicar/ })).toHaveCount(0);
    expect(stubs.chamadas).toEqual([]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('offers Recriar instead of Pausar on a removed native kit', async ({ page }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    // Positive first: the removed kit's block rendered, with its kit badge and
    // the one create arm that applies to it.
    const removido = painel.getByTestId(`shopee-anuncio-${links.kitRemovido}`);
    await expect(removido.getByText('Removido', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(removido.getByText('Kit nativo (inativo)', { exact: true })).toBeVisible();
    const recriar = removido.getByRole('button', { name: 'Recriar kit', exact: true });
    await expect(recriar).toBeVisible();
    await expect(removido.getByRole('button', { name: 'Pausar anúncio' })).toHaveCount(0);
    await expect(removido.getByRole('button', { name: 'Reativar anúncio' })).toHaveCount(0);

    // A create makes a NEW kit on Shopee: it is confirmed first, and a cancel sends nothing.
    await recriar.click();
    const dialogo = page.getByRole('dialog', { name: 'Recriar kit nativo' });
    await expect(dialogo).toBeVisible();
    await expect(dialogo.getByText(/já foi excluído na Shopee/)).toBeVisible();
    await dialogo.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialogo).toHaveCount(0);
    expect(stubs.chamadas).toEqual([]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('renders a blocked publish by motivo without terminal commands', async ({ page }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    const ativo = painel.getByTestId(`shopee-anuncio-${links.ativo}`);
    await ativo.getByRole('button', { name: 'Republicar', exact: true }).click({ timeout: 30_000 });

    const desfecho = ativo.getByTestId(`shopee-desfecho-${links.ativo}`);
    await expect(
      desfecho.getByText('Publicação bloqueada — nada foi enviado à Shopee'),
    ).toBeVisible({ timeout: 30_000 });
    // The row with an acao: its button acts on the link the acao NAMES.
    await expect(
      desfecho.getByRole('button', { name: `Recriar o kit do vínculo ${links.kitRemovido}` }),
    ).toBeVisible();
    // The row without one is worded by its motivo, never by its CLI sentence.
    await expect(desfecho.getByText(/A Shopee respondeu com instabilidade/)).toBeVisible();
    // Scoped to the conta's panel: the page's inline scripts are not the tab's copy.
    await expect(painel.getByText(TEXTO_DE_TERMINAL)).toHaveCount(0);

    expect(stubs.chamadas).toEqual([
      {
        metodo: 'POST',
        rota: 'publicar',
        corpo: { integracaoId: conta, produtoId, linkDocId: links.ativo },
      },
    ]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('keeps the listing state and says so when the shopee service is unreachable', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
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
    // The cut-off re-verify never reaches the recorder (the newer handler took
    // it), so anything recorded is a call the failure set off — a draft save,
    // a pause or a publish, each answered 2xx and so invisible to `semStub`.
    expect(stubs.chamadas).toEqual([]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test("saves only a draft's edited title, with the stored title as its baseline", async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    const editor = painel.getByTestId(`${RAIZ_DO_RASCUNHO}${links.rascunho}`);
    const titulo = editor.getByRole('textbox', { name: /^Título/ });
    await expect(titulo).toHaveValue(tituloGuardado, { timeout: 30_000 });
    const tituloEditado = `${tituloGuardado} editado`;

    // The field takes typing once the links listener answered FROM THE SERVER
    // (a cached copy is never an edit's baseline) — `fill` waits for that.
    await titulo.fill(tituloEditado, { timeout: 30_000 });
    // An undo puts the stored title back and sends nothing.
    await editor.getByRole('button', { name: 'Desfazer alterações', exact: true }).click();
    await expect(titulo).toHaveValue(tituloGuardado);

    await titulo.fill(tituloEditado);
    // Nothing leaves the browser before the operator saves.
    expect(stubs.chamadas).toEqual([]);
    await editor.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();

    // ONLY the edited field, and beside it the value the operator SAW stored —
    // never the description, category or brand nobody touched.
    await expect
      .poll(() => stubs.chamadas, { timeout: 30_000 })
      .toEqual([
        {
          metodo: 'POST',
          rota: 'rascunho/atualizar',
          corpo: {
            integracaoId: conta,
            produtoId,
            linkDocId: links.rascunho,
            base: { item_name: tituloGuardado },
            patch: { item_name: tituloEditado },
          },
        },
      ]);
    await expect(page.getByText(TOAST_RASCUNHO_SALVO, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test("saves a draft's brand picked from the conta's shortlist under the brand's original name", async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    // Positive first: the stored draft's form loaded, and it holds no brand.
    const editor = painel.getByTestId(`${RAIZ_DO_RASCUNHO}${links.rascunho}`);
    await expect(editor.getByRole('textbox', { name: /^Título/ })).toHaveValue(tituloGuardado, {
      timeout: 30_000,
    });
    await expect(editor.getByText(PENDENCIA_MARCA).first()).toBeVisible();

    // The picker reads the conta's shortlist from Firestore — the row the
    // Marcas section writes — and asks apps/shopee nothing. Like typing, a
    // pick waits for the links listener's server answer; `click` waits for it.
    const marca = editor
      .getByTestId(`shopee-rascunho-marca-${links.rascunho}`)
      .getByRole('combobox', { name: 'Marca', exact: true });
    await marca.click({ timeout: 30_000 });
    // «Sem marca» is the picker's own option, never a shortlist row; the row
    // is offered under its DISPLAY name.
    await expect(page.getByRole('option', { name: ROTULO_SEM_MARCA, exact: true })).toBeVisible();
    await page.getByRole('option', { name: MARCA_DA_CONTA.displayBrandName, exact: true }).click();
    await expect(marca).toHaveValue(MARCA_DA_CONTA.displayBrandName);
    // The pick answers the brand's pendência, and only that one.
    await expect(editor.getByText(PENDENCIA_MARCA)).toHaveCount(0);
    await expect(editor.getByText(PENDENCIA_CATEGORIA).first()).toBeVisible();
    // Nothing leaves the browser before the operator saves.
    expect(stubs.chamadas).toEqual([]);
    await editor.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();

    // ONLY the brand, as the pair the draft stores: the row's id with its
    // ORIGINAL name — the one publish sends — never the label the picker
    // showed; and beside it the brand the operator saw stored, none.
    await expect
      .poll(() => stubs.chamadas, { timeout: 30_000 })
      .toEqual([
        {
          metodo: 'POST',
          rota: 'rascunho/atualizar',
          corpo: {
            integracaoId: conta,
            produtoId,
            linkDocId: links.rascunho,
            base: { marca: null },
            patch: {
              marca: {
                brand_id: MARCA_DA_CONTA.brandId,
                original_brand_name: MARCA_DA_CONTA.originalBrandName,
              },
            },
          },
        },
      ]);
    await expect(page.getByText(TOAST_RASCUNHO_SALVO, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('discards a draft after a confirmation, sending every stored field as its baseline', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    const editor = painel.getByTestId(`${RAIZ_DO_RASCUNHO}${links.rascunho}`);
    const descartar = editor.getByRole('button', { name: 'Descartar', exact: true });
    await descartar.click({ timeout: 30_000 });
    const dialogo = page.getByRole('dialog').filter({ hasText: FRASE_CONFIRMAR_DESCARTE });
    await expect(dialogo).toBeVisible();
    // A cancel sends nothing.
    await dialogo.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialogo).toHaveCount(0);
    expect(stubs.chamadas).toEqual([]);

    await descartar.click();
    await expect(dialogo).toBeVisible();
    // Nothing leaves the browser before the operator confirms.
    expect(stubs.chamadas).toEqual([]);
    await dialogo.getByRole('button', { name: /^Descartar/ }).click();

    // ALL FIVE stored fields, as stored — `null` included — so a draft edited
    // meanwhile is refused instead of deleted unseen; never `logistic_info`,
    // and no Seller-Centre attestation for a draft with no uncertain create.
    await expect
      .poll(() => stubs.chamadas, { timeout: 30_000 })
      .toEqual([
        {
          metodo: 'POST',
          rota: 'rascunho/descartar',
          corpo: {
            integracaoId: conta,
            produtoId,
            linkDocId: links.rascunho,
            base: {
              item_name: tituloGuardado,
              description: null,
              category_id: null,
              marca: null,
              attributes: null,
            },
          },
        },
      ]);
    await expect(page.getByText(TOAST_RASCUNHO_DESCARTADO, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('opens a new draft on a conta holding only a removed listing and writes it only on Salvar rascunho', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, contaSoRemovido);

    // Positive first: the conta's one listing rendered — removed, so it makes
    // no new listing here a SECOND one.
    await expect(
      painel.getByTestId(`shopee-anuncio-${links.removido}`).getByText('Removido', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await painel.getByRole('button', { name: 'Novo anúncio', exact: true }).click();

    // The new draft opens at once: no second-listing confirmation was asked.
    await expect(
      painel.getByRole('button', { name: 'Salvar rascunho', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('dialog', { name: TITULO_SEGUNDO_ANUNCIO })).toHaveCount(0);
    const novoId = await idDoUnicoRascunho(painel);
    // Minted here — a Firestore-style id, the only shape the create accepts.
    expect(novoId).toMatch(PADRAO_ID_RASCUNHO_SHOPEE);
    const editor = painel.getByTestId(`${RAIZ_DO_RASCUNHO}${novoId}`);
    await expect(editor.getByText(FRASE_RASCUNHO_NOVO)).toBeVisible();
    // Prefilled with the produto's name; no category, no brand chosen.
    await expect(editor.getByRole('textbox', { name: /^Título/ })).toHaveValue(produtoId);
    await expect(editor.getByText(PENDENCIA_CATEGORIA).first()).toBeVisible();
    await expect(editor.getByText(PENDENCIA_MARCA).first()).toBeVisible();
    // Opening it wrote nothing.
    expect(stubs.chamadas).toEqual([]);

    await editor.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
    // The create names EVERY field (`attributes: null` on a new draft) at the
    // id minted when the draft was opened — and no second-listing flag, since
    // nothing was confirmed.
    await expect
      .poll(() => stubs.chamadas, { timeout: 30_000 })
      .toEqual([
        {
          metodo: 'POST',
          rota: 'rascunho',
          corpo: {
            integracaoId: contaSoRemovido,
            produtoId,
            linkDocId: novoId,
            conteudo: {
              item_name: produtoId,
              description: null,
              category_id: null,
              marca: null,
              attributes: null,
            },
          },
        },
      ]);
    await expect(page.getByText(TOAST_RASCUNHO_CRIADO, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });

  test('asks before a second listing on a conta that already holds one, and a cancel opens nothing', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, links.kitRemovido);
    await page.goto(`/produtos/${produtoId}/editar`);
    const painel = await abrirConta(page, conta);

    // Positive first: the conta's stored draft editor rendered.
    const salvarRascunho = painel.getByRole('button', { name: 'Salvar rascunho', exact: true });
    await expect(salvarRascunho).toHaveCount(1, { timeout: 30_000 });
    await painel.getByRole('button', { name: 'Novo anúncio', exact: true }).click();

    const dialogo = page.getByRole('dialog', { name: TITULO_SEGUNDO_ANUNCIO });
    await expect(dialogo).toBeVisible();
    // The live listing and the draft count; the removed kit does not.
    await expect(
      dialogo.getByText(/Esta conta já tem 2 anúncio\(s\) deste produto, incluindo um rascunho\./),
    ).toBeVisible();
    await expect(
      dialogo.getByRole('button', { name: ROTULO_CONFIRMAR_SEGUNDO_ANUNCIO, exact: true }),
    ).toBeVisible();
    await dialogo.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialogo).toHaveCount(0);

    // No new draft opened: the stored draft's editor is still the only one.
    await expect(salvarRascunho).toHaveCount(1);
    await expect(painel.getByText(FRASE_RASCUNHO_NOVO)).toHaveCount(0);
    expect(stubs.chamadas).toEqual([]);
    expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  });
});
