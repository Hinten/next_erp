import { expect, test, type Locator, type Page } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import type {
  CategoriaNoDto,
  CategoriaResumoDto,
  MarcaDto,
  RespostaCategoriasShopee,
  RespostaMarcasShopee,
} from '@delfrance/schemas';
import type { ShopeeContaStatus } from '../lib/shopee/wire';
import { cleanupShopeeFixtures, e2ePrefix, seedShopeeFixtures } from './_helpers/seed-data';
import { clickSave } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the **Marcas** section of `/canais/shopee/[id]`
 * (#1911, D10): a conta's brand SHORTLIST, `integracao/{id}/brandshopee`, which
 * the operator curates once so a listing's brand picker never waits on
 * Shopee's slow brand API. The section stages adds and removals in the conta's
 * own form, and "Salvar alterações" writes them as guarded sibling writes of
 * the conta's save. What only a real browser against a real Firestore shows is
 * what lands in the subcollection:
 *
 *   - a picked brand is written at the document `String(brand_id)` (D10), with
 *     the three fields of the stored row and nothing else;
 *   - a removed brand loses EVERY document that names it — the legacy app wrote
 *     auto-id duplicates, and deleting one would let the other bring the brand
 *     back — while every row the operator did not touch (an unreadable one and
 *     a stored «Sem marca» included) comes back byte-identical;
 *   - rule 7: a brand another operator registered while the screen was open is
 *     the save's conflict, never an overwrite of their document; and a row that
 *     first appeared AFTER the page loaded can still be removed (each document
 *     gets its own baseline from the server snapshot that first shows it).
 *
 * The apps/shopee backend does NOT run in this suite: the three routes the page
 * calls (`conta`, `taxonomia/categorias`, `taxonomia/marcas`) are stubbed on the
 * PATHNAME, answering the bodies the real routes build, typed by the shared
 * envelopes in `@delfrance/schemas`. A route this spec does not know is answered
 * 404 and recorded in `semStub`, which every test asserts empty — nothing is
 * forwarded to a live backend, and the section only ever READS it (the
 * shortlist goes to Firestore, never to Shopee).
 *
 * Every conta and every brand row is seeded through the Admin SDK and read back
 * the same way (strongly consistent). Each test that saves owns its own conta,
 * so no test reads another's writes.
 */

const PREFIXO_ROTAS = '/api/marketplace/shopee/';

/* ---------------------------- the category tree ---------------------------- */

const ROUPAS = {
  categoryId: 100010,
  name: 'Roupas',
  originalName: 'Clothes',
  isLeaf: false,
} satisfies CategoriaResumoDto;
const CAMISETAS = {
  categoryId: 100087,
  name: 'Camisetas',
  originalName: 'T-Shirts',
  isLeaf: true,
} satisfies CategoriaResumoDto;

/** One root (not a leaf) with one leaf — brands are listed for a LEAF only. */
const NOS = new Map<number, CategoriaNoDto>([
  [ROUPAS.categoryId, { ...ROUPAS, parentId: 0, pathFromRoot: [ROUPAS], children: [CAMISETAS] }],
  [
    CAMISETAS.categoryId,
    { ...CAMISETAS, parentId: ROUPAS.categoryId, pathFromRoot: [ROUPAS, CAMISETAS], children: [] },
  ],
]);

/* --------------------------------- the brands -------------------------------- */

/** Fixture brand ids — synthetic, never a real Shopee brand. */
const ID = {
  nike: 9_100_001,
  semNome: 9_100_002,
  adidas: 9_100_003,
  reebok: 9_100_004,
  asics: 9_100_005,
} as const;

/** A stored row the way the legacy app wrote it: three keys, `display_brand_name` an explicit null. */
function linhaLegada(brandId: unknown, nome: string): Record<string, unknown> {
  return { brand_id: brandId, original_brand_name: nome, display_brand_name: null };
}

/** Shopee's "No Brand" — `0` is a choice on the listing, never a shortlist row. */
const SEM_MARCA_DTO: MarcaDto = {
  brandId: 0,
  originalBrandName: 'No Brand',
  displayBrandName: null,
};
const ADIDAS_DTO: MarcaDto = {
  brandId: ID.adidas,
  originalBrandName: 'Adidas',
  displayBrandName: null,
};
const REEBOK_DTO: MarcaDto = {
  brandId: ID.reebok,
  originalBrandName: 'Reebok',
  displayBrandName: 'Reebok Brasil',
};
const ASICS_DTO: MarcaDto = {
  brandId: ID.asics,
  originalBrandName: 'Asics',
  displayBrandName: null,
};

/* --------------------------------- the stubs -------------------------------- */

/** One page of `taxonomia/marcas` as the stub serves it, by the `offset` it answers. */
interface PaginaDeMarcas {
  readonly marcas: readonly MarcaDto[];
  readonly hasNextPage: boolean;
  readonly nextOffset: number | null;
}

/** The leaf's brand list, page by page, keyed on the `offset` each page answers. */
type CatalogoDeMarcas = ReadonlyMap<number, PaginaDeMarcas>;

/** One page: "No Brand", a brand the shortlist already holds, and one to register. */
const CATALOGO_UMA_PAGINA: CatalogoDeMarcas = new Map([
  [0, { marcas: [SEM_MARCA_DTO, ADIDAS_DTO, REEBOK_DTO], hasNextPage: false, nextOffset: null }],
]);

/**
 * Shopee's cursor is NOT `offset + pageSize`: the second page sits at 37, which
 * no page size reaches from 0. The LAST page still carries a non-null
 * `nextOffset` — `hasNextPage: false` is what ends the list.
 */
const CURSOR_DA_SHOPEE = 37;
const CATALOGO_DUAS_PAGINAS: CatalogoDeMarcas = new Map([
  [0, { marcas: [ADIDAS_DTO], hasNextPage: true, nextOffset: CURSOR_DA_SHOPEE }],
  [CURSOR_DA_SHOPEE, { marcas: [ASICS_DTO], hasNextPage: false, nextOffset: 112 }],
]);

/** The conta route's 200 for a conta nobody connected — every key, as the real route builds it. */
const CONTA_DESCONECTADA: ShopeeContaStatus = {
  connected: false,
  shopId: null,
  mainAccountId: null,
  authTime: null,
  expireTime: null,
  diasParaExpirar: null,
  loja: null,
  credencial: null,
};

interface ChamadaShopee {
  readonly metodo: string;
  readonly rota: string;
  readonly integracaoId: string | null;
  readonly categoryId: string | null;
  readonly offset: string | null;
}

interface StubsShopee {
  /** Every Shopee backend call the page made, in order. */
  readonly chamadas: ChamadaShopee[];
  /** Calls this spec does not stub (answered 404, never forwarded). */
  readonly semStub: string[];
}

type Resposta = { readonly status: number; readonly corpo: unknown };

const ok = (corpo: unknown): Resposta => ({ status: 200, corpo });

function categoriaDesconhecida(id: string | null): Resposta {
  return {
    status: 404,
    corpo: {
      error: `Categoria ${String(id)} não existe na árvore desta conta.`,
      code: 'SHOPEE_CATEGORIA_DESCONHECIDA',
    },
  };
}

/** The `taxonomia/marcas` 200 for `params`, or `null` for an offset the catalogue has no page at. */
function paginaDaCategoria(params: URLSearchParams, catalogo: CatalogoDeMarcas): Resposta | null {
  const id = params.get('categoryId');
  const no = NOS.get(Number(id));
  if (no === undefined) return categoriaDesconhecida(id);
  const envelope = {
    categoryId: no.categoryId,
    status: Number(params.get('status') ?? '1'),
    offset: Number(params.get('offset') ?? '0'),
    pageSize: Number(params.get('pageSize') ?? '100'),
  };
  if (!no.isLeaf) {
    return ok({
      ...envelope,
      leaf: false,
      marcas: [],
      hasNextPage: false,
      nextOffset: null,
      isMandatory: null,
      inputType: null,
    } satisfies RespostaMarcasShopee);
  }
  const pagina = catalogo.get(envelope.offset);
  if (pagina === undefined) return null;
  return ok({
    ...envelope,
    leaf: true,
    marcas: [...pagina.marcas],
    hasNextPage: pagina.hasNextPage,
    nextOffset: pagina.nextOffset,
    isMandatory: false,
    inputType: 'DROP_DOWN',
  } satisfies RespostaMarcasShopee);
}

/** The body the real route would answer for `url`, or `null` for a request this spec does not stub. */
function responder(url: URL, catalogo: CatalogoDeMarcas): Resposta | null {
  const params = url.searchParams;
  switch (url.pathname.slice(PREFIXO_ROTAS.length)) {
    case 'conta':
      return ok(CONTA_DESCONECTADA);
    case 'taxonomia/categorias': {
      const id = params.get('categoryId');
      if (id === null) return ok({ raizes: [ROUPAS], no: null } satisfies RespostaCategoriasShopee);
      const no = NOS.get(Number(id));
      return no === undefined
        ? categoriaDesconhecida(id)
        : ok({ raizes: null, no } satisfies RespostaCategoriasShopee);
    }
    case 'taxonomia/marcas':
      return paginaDaCategoria(params, catalogo);
    default:
      return null;
  }
}

/**
 * Stub every apps/shopee route the page calls. MUST run BEFORE `page.goto`.
 * Playwright answers the CORS preflight itself (the backend is cross-origin),
 * so only the real requests land here.
 */
async function instalarStubsShopee(
  page: Page,
  catalogo: CatalogoDeMarcas = CATALOGO_UMA_PAGINA,
): Promise<StubsShopee> {
  const stubs: StubsShopee = { chamadas: [], semStub: [] };
  await page.route(
    (url) => url.pathname.startsWith(PREFIXO_ROTAS),
    async (route) => {
      const pedido = route.request();
      const url = new URL(pedido.url());
      stubs.chamadas.push({
        metodo: pedido.method(),
        rota: url.pathname.slice(PREFIXO_ROTAS.length),
        integracaoId: url.searchParams.get('integracaoId'),
        categoryId: url.searchParams.get('categoryId'),
        offset: url.searchParams.get('offset'),
      });
      let resposta = responder(url, catalogo);
      if (resposta === null) {
        stubs.semStub.push(`${pedido.method()} ${url.pathname}${url.search}`);
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

/** The section only READS the Shopee backend, and only for the conta on screen. */
function expectSoLeiturasDaConta(stubs: StubsShopee, conta: string): void {
  expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  expect(stubs.chamadas.length).toBeGreaterThan(0);
  expect(stubs.chamadas.filter((c) => c.metodo !== 'GET' || c.integracaoId !== conta)).toEqual([]);
}

/** The `taxonomia/marcas` calls the page made, in order. */
function chamadasDeMarcas(stubs: StubsShopee): ChamadaShopee[] {
  return stubs.chamadas.filter((c) => c.rota === 'taxonomia/marcas');
}

/* ------------------------------ Firestore (Admin) ----------------------------- */

function marcasDaConta(conta: string) {
  return db().collection('integracao').doc(conta).collection('brandshopee');
}

/** Write `linhas` under `conta`, each at a fresh AUTO id (the legacy app's ids); answers the ids. */
async function semearMarcas(
  conta: string,
  linhas: readonly Record<string, unknown>[],
): Promise<string[]> {
  const batch = db().batch();
  const ids = linhas.map((data) => {
    const ref = marcasDaConta(conta).doc();
    batch.set(ref, data);
    return ref.id;
  });
  await batch.commit();
  return ids;
}

/** Every `brandshopee` document of `conta`, as stored now, keyed by doc id. */
async function lerMarcas(conta: string): Promise<Record<string, Record<string, unknown>>> {
  const snap = await marcasDaConta(conta).get();
  return Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
}

/**
 * D10 fixes where a registered brand lands: `String(brand_id)`. Spelled here on
 * purpose instead of calling the code under test (`docIdDaMarcaShopee`) — an
 * oracle that called it would follow it anywhere it moved.
 */
function idDeterministico(brandId: number): string {
  return String(brandId);
}

/* ---------------------------------- the page --------------------------------- */

function linhaDaMarca(page: Page, brandId: number): Locator {
  return page.getByTestId(`shopee-marca-${String(brandId)}`);
}

function botaoRemover(page: Page, brandId: number): Locator {
  return linhaDaMarca(page, brandId).getByRole('button', { name: 'Remover', exact: true });
}

/**
 * Open the conta on its Marcas tab once the section has read the shortlist from
 * the SERVER: "Adicionar marcas" stays disabled until then, because a change
 * staged over a cached list would be guarded by nothing.
 */
async function abrirMarcas(page: Page, conta: string): Promise<void> {
  await page.goto(`/canais/shopee/${conta}`);
  await page.getByRole('tab', { name: 'Marcas', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Adicionar marcas', exact: true })).toBeEnabled({
    timeout: 30_000,
  });
}

/** "Adicionar marcas" → the root → the leaf → that leaf's first brand page, through the real modal. */
async function abrirMarcasDaFolha(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Adicionar marcas', exact: true }).click();
  const modal = page.getByTestId('shopee-adicionar-marcas-modal');
  await expect(modal).toBeVisible();
  // A non-leaf drills in; only a leaf offers "Escolher".
  await modal
    .getByTestId(`shopee-categoria-linha-${String(ROUPAS.categoryId)}`)
    .getByRole('button')
    .click();
  await modal
    .getByTestId(`shopee-categoria-linha-${String(CAMISETAS.categoryId)}`)
    .getByRole('button', { name: 'Escolher' })
    .click();
  return modal;
}

function opcaoDaMarca(modal: Locator, brandId: number): Locator {
  return modal.getByTestId(`shopee-marca-opcao-${String(brandId)}`);
}

/** Tick `brandId` on the open page and stage it: the modal closes and the row shows "Nova". */
async function adicionarMarca(page: Page, modal: Locator, brandId: number): Promise<void> {
  await opcaoDaMarca(modal, brandId).getByRole('checkbox').check();
  const confirmar = modal.getByTestId('shopee-adicionar-marcas-confirmar');
  await expect(confirmar).toHaveText('Adicionar selecionadas (1)');
  await confirmar.click();
  await expect(modal).toBeHidden();
  await expect(page.getByTestId(`shopee-marca-nova-${String(brandId)}`)).toContainText('Nova');
}

async function salvarEVoltar(page: Page): Promise<void> {
  await clickSave(page, 'Salvar alterações');
  await page.waitForURL(/\/canais\/shopee$/, { timeout: 15_000 });
}

test.describe.serial('Canais Shopee e2e — the Marcas section of a conta', () => {
  const prefix = e2ePrefix('mrcshp');
  const conta = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;
  /** Conta 1: the legacy corpus shape — rendered by test 1, saved by test 2. */
  const legado = {
    /** Every seeded row, by its auto id. */
    linhas: {} as Record<string, Record<string, unknown>>,
    /** The two documents of the duplicated brand. */
    nike: [] as string[],
  };

  test.beforeAll(async ({ browser }) => {
    // Compiling cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      seedShopeeFixtures(prefix, 4),
      warmRoutes(browser, ['/canais/shopee/__aquecimento__']),
    ]);

    // Two auto-id documents for ONE brand, their names differing only by case.
    const linhas = [
      linhaLegada(ID.nike, 'Nike'),
      linhaLegada(ID.nike, 'NIKE'),
      linhaLegada(ID.semNome, ''),
      linhaLegada(ID.adidas, 'Adidas'),
      // A STRING id is a foreign writer's row, not brand 9 100 006: unreadable.
      linhaLegada('9100006', 'Puma'),
      // A stored "No Brand": never a shortlist row.
      linhaLegada(0, 'No Brand'),
    ];
    const ids = await semearMarcas(conta(1), linhas);
    legado.linhas = Object.fromEntries(ids.map((id, i) => [id, linhas[i]!]));
    legado.nike = ids.slice(0, 2);

    // Contas 2–4 hold one brand each, so their list has a row to wait on.
    await Promise.all(
      [2, 3, 4].map((n) => semearMarcas(conta(n), [linhaLegada(ID.adidas, 'Adidas')])),
    );
  });

  test.afterAll(async () => {
    await cleanupShopeeFixtures(prefix);
  });

  test('lists the shortlist by brand id — legacy duplicates as one row, a nameless row by its id, unreadable rows only counted', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page);
    await abrirMarcas(page, conta(1));

    // ONE row for the two documents of the brand, whichever of their two
    // spellings the reader took as canonical.
    await expect(linhaDaMarca(page, ID.nike)).toContainText(
      new RegExp(`id ${String(ID.nike)} \\(2 registros\\)`),
    );
    await expect(linhaDaMarca(page, ID.semNome)).toContainText(
      `Marca sem nome (id ${String(ID.semNome)})`,
    );
    await expect(linhaDaMarca(page, ID.adidas)).toContainText(`Adidas · id ${String(ID.adidas)}`);
    // Near-misses: the STRING id is not brand 9 100 006, and 0 is not a brand.
    await expect(linhaDaMarca(page, 9_100_006)).toHaveCount(0);
    await expect(linhaDaMarca(page, 0)).toHaveCount(0);
    await expect(page.getByTestId('shopee-marcas-outros-registros')).toContainText('2 registro(s)');

    // The conta panel's read is the ONE Shopee call: rendering the shortlist
    // reads Firestore alone.
    await expect.poll(() => stubs.chamadas.some((c) => c.rota === 'conta')).toBe(true);
    expectSoLeiturasDaConta(stubs, conta(1));
    expect(stubs.chamadas.filter((c) => c.rota !== 'conta')).toEqual([]);
  });

  test('registers a picked brand at its brand-id document and deletes every document of a removed brand, leaving the other rows as stored', async ({
    page,
  }) => {
    const antes = await lerMarcas(conta(1));
    // Non-vacuous: the save below has two duplicates to delete and four rows to leave alone.
    expect(antes).toEqual(legado.linhas);

    const stubs = await instalarStubsShopee(page);
    await abrirMarcas(page, conta(1));

    await botaoRemover(page, ID.nike).click();
    await expect(linhaDaMarca(page, ID.nike)).toContainText('Será removida');
    await expect(
      linhaDaMarca(page, ID.nike).getByRole('button', { name: 'Desfazer' }),
    ).toBeVisible();

    const modal = await abrirMarcasDaFolha(page);
    // "No Brand" is hidden, and a brand the shortlist already holds is checked
    // and disabled — never offered twice.
    await expect(opcaoDaMarca(modal, ID.reebok)).toBeVisible({ timeout: 30_000 });
    await expect(opcaoDaMarca(modal, 0)).toHaveCount(0);
    // Non-vacuous: the page DID carry brand 0, and the modal says why it is not offered.
    await expect(modal.getByTestId('shopee-marcas-sem-marca-oculta')).toBeVisible();
    await expect(opcaoDaMarca(modal, ID.adidas).getByRole('checkbox')).toBeDisabled();
    await expect(opcaoDaMarca(modal, ID.adidas)).toContainText('já cadastrada');
    await adicionarMarca(page, modal, ID.reebok);

    await salvarEVoltar(page);

    const intocadas = { ...legado.linhas };
    for (const id of legado.nike) delete intocadas[id];
    await expect
      .poll(() => lerMarcas(conta(1)), { timeout: 15_000 })
      .toEqual({
        ...intocadas,
        [idDeterministico(ID.reebok)]: {
          brand_id: ID.reebok,
          original_brand_name: 'Reebok',
          display_brand_name: 'Reebok Brasil',
        },
      });

    expectSoLeiturasDaConta(stubs, conta(1));
    expect(chamadasDeMarcas(stubs).map((c) => c.categoryId)).toEqual([
      String(CAMISETAS.categoryId),
    ]);
  });

  test("pages the registration picker on Shopee's own cursor, and stops when Shopee says the list ended", async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page, CATALOGO_DUAS_PAGINAS);
    await abrirMarcas(page, conta(2));

    const modal = await abrirMarcasDaFolha(page);
    await expect(opcaoDaMarca(modal, ID.adidas)).toBeVisible({ timeout: 30_000 });
    await expect(opcaoDaMarca(modal, ID.asics)).toHaveCount(0);

    await modal.getByRole('button', { name: 'Carregar mais' }).click();
    await expect(opcaoDaMarca(modal, ID.asics)).toBeVisible({ timeout: 30_000 });
    // The last page still names a `nextOffset`; `hasNextPage: false` ends the list.
    await expect(modal.getByRole('button', { name: 'Carregar mais' })).toHaveCount(0);

    const offsets = chamadasDeMarcas(stubs).map((c) => c.offset);
    expect(offsets).toHaveLength(2);
    expect([null, '0']).toContain(offsets[0]);
    expect(offsets[1]).toBe(String(CURSOR_DA_SHOPEE));
    expectSoLeiturasDaConta(stubs, conta(2));
  });

  test('raises the conflict when another operator registers the same brand meanwhile, and keeps their document', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page);
    await abrirMarcas(page, conta(3));
    const modal = await abrirMarcasDaFolha(page);
    await expect(opcaoDaMarca(modal, ID.reebok)).toBeVisible({ timeout: 30_000 });
    await adicionarMarca(page, modal, ID.reebok);

    // Another operator registers the SAME brand while this screen is open — at
    // the same deterministic document, with content this save would replace.
    const doOutroOperador = {
      brand_id: ID.reebok,
      original_brand_name: 'Reebok',
      display_brand_name: 'Reebok (outro operador)',
    };
    await marcasDaConta(conta(3)).doc(idDeterministico(ID.reebok)).set(doOutroOperador);
    await expect(linhaDaMarca(page, ID.reebok)).toBeVisible({ timeout: 30_000 });

    await clickSave(page, 'Salvar alterações');
    await expect(page.getByText('Registro alterado')).toBeVisible({ timeout: 15_000 });
    expect((await lerMarcas(conta(3)))[idDeterministico(ID.reebok)]).toEqual(doOutroOperador);
    expectSoLeiturasDaConta(stubs, conta(3));
  });

  test('removes a brand another operator registered after the page loaded', async ({ page }) => {
    const antes = await lerMarcas(conta(4));
    const stubs = await instalarStubsShopee(page);
    await abrirMarcas(page, conta(4));
    await expect(botaoRemover(page, ID.adidas)).toBeEnabled({ timeout: 30_000 });

    // First shown by a LATER server snapshot than the one the section loaded
    // from: it gets its own baseline then, so its removal is guarded too.
    await marcasDaConta(conta(4))
      .doc(idDeterministico(ID.asics))
      .set(linhaLegada(ID.asics, 'Asics'));
    await expect(botaoRemover(page, ID.asics)).toBeEnabled({ timeout: 30_000 });
    await botaoRemover(page, ID.asics).click();
    await expect(linhaDaMarca(page, ID.asics)).toContainText('Será removida');

    await salvarEVoltar(page);

    await expect.poll(() => lerMarcas(conta(4)), { timeout: 15_000 }).toEqual(antes);
    expectSoLeiturasDaConta(stubs, conta(4));
  });
});
