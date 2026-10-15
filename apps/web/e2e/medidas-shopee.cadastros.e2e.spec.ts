import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  entradaTabelaShopeeSchema,
  projetarTabelaShopee,
  type DetalheTabelaShopeeEntrada,
  type EntradaTabelaShopee,
  type TabelaShopeeProjetada,
} from '@delfrance/schemas';
import type {
  CategoriaNoDto,
  CategoriaResumoDto,
  DetalheTabelaMedidasDto,
  ListaTabelasMedidasDto,
  RespostaCategoriasShopee,
  RespostaLimitesShopee,
} from '../lib/shopee/wire';
import type { PapelDaLinha } from '../lib/shopee/tabelasMedidasForm';
import {
  CONTA_SHOPEE_IRMA,
  cleanupByNamePrefix,
  cleanupShopeeFixtures,
  e2ePrefix,
  getTabMediById,
  mapasMedidaShopee,
  seedMedidaShopee,
  seedShopeeFixtures,
} from './_helpers/seed-data';
import { clickSave } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the medidas editor's **Shopee** tab (#1526, step 18):
 * per conta, which Shopee size-chart template each category's listings get.
 *
 * The pick is STAGED in the tabela's own form and written by "Salvar
 * alterações" (ObjectView's save transaction) — so what only a real browser
 * against a real Firestore can show is what lands in the document:
 *
 *   - THIS conta's list holds the legacy corpus shape `{ categoryId,
 *     size_chart_id, name }` (ids numbers, `name` the CATEGORY's label), parsed
 *     here with the one strict write schema;
 *   - the sibling conta key and `tabelasDeMedidasMercadoLivre` come back
 *     deep-equal to what was stored before the save;
 *   - a removal is a mark until the save, an undone mark leaves the form clean,
 *     and no `_pendingDelete` ever reaches Firestore.
 *
 * The apps/shopee backend does NOT run in this suite: its four read routes are
 * stubbed below (`page.route` on the PATHNAME — every call carries a query
 * string), answering the bodies the real routes build. The chart itself comes
 * from Shopee's own `get_size_chart_detail` doc sample run through
 * `projetarTabelaShopee` — the SAME projector the detail route calls — so the
 * read-only grid renders exactly what that route sends, parsed by the browser
 * with the one shared `tabelaShopeeProjetadaSchema` (round trip RT7).
 *
 * Rows are scoped by the run-scoped `data-testid="shopee-medida-conta-<id>"` /
 * `shopee-medida-entrada-<conta>-<raw index>`, since the tab lists every Shopee
 * conta on shared staging. Runs serially: tests 4 and 5 edit the same tabela,
 * and each asserts against what it read from Firestore just before.
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
const REGATAS = {
  categoryId: 100088,
  name: 'Regatas',
  originalName: 'Tank Tops',
  isLeaf: true,
} satisfies CategoriaResumoDto;

/** One root (not a leaf) with two leaves — `pathFromRoot` is root FIRST, the node LAST. */
const NOS = new Map<number, CategoriaNoDto>([
  [
    ROUPAS.categoryId,
    { ...ROUPAS, parentId: 0, pathFromRoot: [ROUPAS], children: [CAMISETAS, REGATAS] },
  ],
  [
    CAMISETAS.categoryId,
    { ...CAMISETAS, parentId: ROUPAS.categoryId, pathFromRoot: [ROUPAS, CAMISETAS], children: [] },
  ],
  [
    REGATAS.categoryId,
    { ...REGATAS, parentId: ROUPAS.categoryId, pathFromRoot: [ROUPAS, REGATAS], children: [] },
  ],
]);

/* -------------------------------- the charts ------------------------------- */

/** One cell of the doc sample, every key present (Shopee sends the unused ones as `null`). */
function celula(
  campos: Partial<Record<'option' | 'value' | 'min_value' | 'max_value', string | number>>,
) {
  return {
    option: typeof campos.option === 'string' ? campos.option : null,
    value: typeof campos.value === 'number' ? campos.value : null,
    min_value: typeof campos.min_value === 'number' ? campos.min_value : null,
    max_value: typeof campos.max_value === 'number' ? campos.max_value : null,
  };
}

/**
 * Shopee's published `get_size_chart_detail` sample (`response`), in the shape
 * the package's reader produces: one single-number, one range and one dropdown
 * column — note the dropdown's `unit: "cm"`, which must NOT reach its header.
 */
const DETALHE_DOC_SAMPLE: DetalheTabelaShopeeEntrada = {
  size_chart_id: 700024639,
  size_chart_name: 'testtestt',
  size_chart_table: {
    column_list: [
      {
        measurement: {
          display_name: 'test single input number',
          input_type: 'Input Single Number',
          unit: 'cm',
        },
        measurement_value_list: [celula({ value: 1 }), celula({ value: 2 }), celula({ value: 3 })],
      },
      {
        measurement: {
          display_name: 'susu_input_range_number_with_special_unit_kg',
          input_type: 'Input Range Number',
          unit: 'kg',
        },
        measurement_value_list: [
          celula({ min_value: 12, max_value: 13 }),
          celula({ min_value: 13, max_value: 14 }),
          celula({ min_value: 14, max_value: 16 }),
        ],
      },
      {
        measurement: {
          display_name: 'regional 001 dropdowm',
          input_type: 'Single Dropdown',
          unit: 'cm',
        },
        measurement_value_list: [
          celula({ option: '01s' }),
          celula({ option: '01m' }),
          celula({ option: '01l' }),
        ],
      },
    ],
  },
};

/** The template a new pick chooses — its name is deliberately NOT the category's. */
const GUIA_REGATAS = { sizeChartId: 700024613, sizeChartName: 'Guia de regatas' };

/** What the detail route answers per template; any other id is one the shop no longer has. */
const TABELAS = new Map<number, TabelaShopeeProjetada>([
  [700024639, projetarTabelaShopee(700024639, DETALHE_DOC_SAMPLE)],
  [
    GUIA_REGATAS.sizeChartId,
    projetarTabelaShopee(GUIA_REGATAS.sizeChartId, {
      ...DETALHE_DOC_SAMPLE,
      size_chart_id: GUIA_REGATAS.sizeChartId,
      size_chart_name: GUIA_REGATAS.sizeChartName,
    }),
  ],
]);

/** Every leaf lists the same two templates (the list route's `tabelas`, Shopee's order). */
const MODELOS: ListaTabelasMedidasDto['tabelas'] = [
  { sizeChartId: 700024639, sizeChartName: 'testtestt', legivel: true },
  { ...GUIA_REGATAS, legivel: true },
];

/* --------------------------------- the stubs -------------------------------- */

interface ChamadaShopee {
  readonly metodo: string;
  readonly caminho: string;
  readonly integracaoId: string | null;
}

interface StubsShopee {
  /** Every Shopee backend call the page made, in order. */
  readonly chamadas: ChamadaShopee[];
  /** Calls to a Shopee route this spec does not stub (answered 404, never forwarded). */
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

/** The body the real route would answer for `url`, or `null` for a route not stubbed here. */
function responder(url: URL): Resposta | null {
  const params = url.searchParams;
  switch (url.pathname.slice(PREFIXO_ROTAS.length)) {
    case 'taxonomia/categorias': {
      const id = params.get('categoryId');
      if (id === null) return ok({ raizes: [ROUPAS], no: null } satisfies RespostaCategoriasShopee);
      const no = NOS.get(Number(id));
      return no === undefined
        ? categoriaDesconhecida(id)
        : ok({ raizes: null, no } satisfies RespostaCategoriasShopee);
    }
    case 'taxonomia/limites':
      return ok({
        scope: 'category',
        categoryId: Number(params.get('categoryId')),
        limites: {
          sizeChartLimit: {
            sizeChartMandatory: false,
            supportImageSizeChart: true,
            supportTemplateSizeChart: true,
          },
        },
      } satisfies RespostaLimitesShopee);
    case 'tabela-medidas/lista': {
      const id = params.get('categoryId');
      const no = NOS.get(Number(id));
      if (no === undefined) return categoriaDesconhecida(id);
      return ok({
        leaf: no.isLeaf,
        categoryId: no.categoryId,
        tabelas: no.isLeaf ? MODELOS : [],
        totalCount: no.isLeaf ? MODELOS.length : null,
        truncado: false,
        removidas: 0,
        idsIlegiveis: 0,
      } satisfies ListaTabelasMedidasDto);
    }
    case 'tabela-medidas/detalhe': {
      const id = Number(params.get('sizeChartId'));
      const tabela = TABELAS.get(id);
      if (tabela !== undefined) return ok({ tabela } satisfies DetalheTabelaMedidasDto);
      return {
        status: 404,
        corpo: {
          error: `A tabela de medidas ${String(id)} não existe mais nesta loja da Shopee — escolha outra.`,
          code: 'SHOPEE_TABELA_MEDIDAS_INEXISTENTE',
          sizeChartId: id,
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Stub every apps/shopee route the page calls. MUST run BEFORE `page.goto`.
 * Playwright answers the CORS preflight itself (the backend is cross-origin),
 * so only the real requests land here. A route this spec does not know is
 * answered 404 and recorded — never forwarded to a live backend.
 */
async function instalarStubsShopee(page: Page): Promise<StubsShopee> {
  const stubs: StubsShopee = { chamadas: [], semStub: [] };
  await page.route(
    (url) => url.pathname.startsWith(PREFIXO_ROTAS),
    async (route) => {
      const pedido = route.request();
      const url = new URL(pedido.url());
      stubs.chamadas.push({
        metodo: pedido.method(),
        caminho: url.pathname,
        integracaoId: url.searchParams.get('integracaoId'),
      });
      let resposta = responder(url);
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

/**
 * The tab only READS the Shopee backend, and only for the conta whose card
 * asked: no write ever leaves for Shopee (the pick lives in Firestore), and a
 * key with no conta (the sibling) triggers no call at all.
 */
function expectSoLeiturasDaConta(stubs: StubsShopee, conta: string): void {
  expect(stubs.semStub, 'Shopee routes this spec does not stub').toEqual([]);
  expect(stubs.chamadas.length).toBeGreaterThan(0);
  expect(stubs.chamadas.filter((c) => c.metodo !== 'GET' || c.integracaoId !== conta)).toEqual([]);
}

/* ------------------------------ Firestore reads ----------------------------- */

interface MapasLidos {
  readonly shopee: Record<string, unknown>;
  readonly mercadoLivre: unknown;
}

/** The two marketplace maps of one tabMedi, as Firestore holds them now. */
async function lerMapas(tabMediId: string): Promise<MapasLidos> {
  const data = await getTabMediById(tabMediId);
  expect(data, `tabMedi ${tabMediId}`).not.toBeNull();
  const shopee = data?.tabelasMedidasShopee;
  return {
    shopee:
      shopee !== null && typeof shopee === 'object' ? (shopee as Record<string, unknown>) : {},
    mercadoLivre: data?.tabelasDeMedidasMercadoLivre ?? null,
  };
}

/**
 * Every element of one conta's stored list, through the STRICT write schema —
 * exactly `{ categoryId, size_chart_id, name }`, positive integer ids. A stray
 * key (a leaked `_pendingDelete`) or a stringified id fails the parse.
 */
function listaNoFormatoDoCorpus(
  mapa: Record<string, unknown>,
  conta: string,
): EntradaTabelaShopee[] {
  const lista = mapa[conta];
  expect(Array.isArray(lista), `tabelasMedidasShopee[${conta}] is a list`).toBe(true);
  return (lista as unknown[]).map((entrada) => entradaTabelaShopeeSchema.parse(entrada));
}

/* ---------------------------------- helpers --------------------------------- */

/**
 * A row's role as the tab computed it (`data-papel`, the row frame's e2e hook) —
 * THE selection rule's verdict (`indiceDaEntradaShopee`), not a copy of it.
 */
async function expectPapel(linha: Locator, papel: PapelDaLinha): Promise<void> {
  await expect(linha).toHaveAttribute('data-papel', papel);
}

/** Open the tabela's Shopee tab and wait for this conta's card. */
async function abrirAbaShopee(page: Page, tabMediId: string, conta: string): Promise<Locator> {
  await page.goto(`/medidas/${tabMediId}`);
  await page.getByRole('tab', { name: 'Shopee' }).click();
  const card = page.getByTestId(`shopee-medida-conta-${conta}`);
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

/** "Adicionar" on the card → the root → `folha` → the template → confirm, through the real modal. */
async function escolherTabela(
  page: Page,
  card: Locator,
  folha: CategoriaResumoDto,
  sizeChartId: number,
): Promise<void> {
  await card.getByRole('button', { name: 'Adicionar', exact: true }).click();
  const modal = page.getByTestId('shopee-escolher-tabela-modal');
  await expect(modal).toBeVisible();

  // A non-leaf drills in; only a leaf offers "Escolher".
  await modal
    .getByTestId(`shopee-categoria-linha-${String(ROUPAS.categoryId)}`)
    .getByRole('button')
    .click();
  await modal
    .getByTestId(`shopee-categoria-linha-${String(folha.categoryId)}`)
    .getByRole('button', { name: 'Escolher' })
    .click();

  await modal.getByRole('radio', { name: new RegExp(`#${String(sizeChartId)}`) }).check();
  const confirmar = modal.getByTestId('shopee-escolher-tabela-confirmar');
  // No active entry for this category in this conta → an ADD, not a replace.
  await expect(confirmar).toHaveText('Adicionar');
  await confirmar.click();
  await expect(modal).toBeHidden();
}

async function salvarTabela(page: Page): Promise<void> {
  await clickSave(page, 'Salvar alterações');
  await page.waitForURL(/\/medidas$/, { timeout: 15_000 });
}

test.describe.serial('Medidas Shopee tab e2e — size-chart picks', () => {
  const prefix = e2ePrefix('tmshp');
  const conta = `${prefix}-001`;
  const seed = mapasMedidaShopee(conta);
  let comMapa = '';
  let semMapa = '';

  test.beforeAll(async ({ browser }) => {
    // Compiling cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    const [, docs] = await Promise.all([
      seedShopeeFixtures(prefix, 1),
      seedMedidaShopee(prefix, conta),
      warmRoutes(browser, ['/medidas/__aquecimento__']),
    ]);
    comMapa = docs.comMapa;
    semMapa = docs.semMapa;
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('tabMedi', prefix);
    await cleanupShopeeFixtures(prefix);
  });

  test('lists the stored picks under the conta card with the live chart name, the duplicate marked ignored', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page);
    await abrirAbaShopee(page, comMapa, conta);

    // Raw 0 is the pick a listing of the category gets: the chart's name comes
    // from the shop (the detail read), the path from the conta's live tree.
    const usada = page.getByTestId(`shopee-medida-entrada-${conta}-0`);
    await expect(usada.getByText('testtestt')).toBeVisible({ timeout: 30_000 });
    await expect(usada.getByText('#700024639')).toBeVisible();
    await expect(usada.getByText('Roupas › Camisetas')).toBeVisible();
    await expectPapel(usada, 'usada');
    await expect(usada.getByText(/ignorada/)).toHaveCount(0);

    // Raw 1 picks the SAME category: the first match wins, so it is kept and
    // shown, but flagged as never used.
    const duplicada = page.getByTestId(`shopee-medida-entrada-${conta}-1`);
    await expect(duplicada.getByText('#700024641')).toBeVisible();
    await expectPapel(duplicada, 'ignorada-duplicada');
    await expect(duplicada.getByText(/ignorada/)).toBeVisible();

    // The sibling key has no conta: one muted line, kept, no card of its own.
    await expect(page.getByTestId('shopee-medida-contas-ausentes')).toHaveText(
      '1 entrada(s) de contas que não existem mais (mantidas)',
    );
    await expect(page.getByTestId(`shopee-medida-conta-${CONTA_SHOPEE_IRMA}`)).toHaveCount(0);

    expectSoLeiturasDaConta(stubs, conta);
  });

  test('shows a stored pick whose chart no longer exists in the shop as one to re-pick', async ({
    page,
  }) => {
    const stubs = await instalarStubsShopee(page);
    await abrirAbaShopee(page, comMapa, conta);

    const stale = page.getByTestId(`shopee-medida-entrada-${conta}-1`);
    await expect(stale.getByText(/não existe mais na loja/)).toBeVisible({ timeout: 30_000 });
    await expect(stale.getByRole('button', { name: 'Trocar' })).toBeEnabled();
    // Only that row: the neighbour's chart still exists.
    const viva = page.getByTestId(`shopee-medida-entrada-${conta}-0`);
    await expect(viva.getByText('testtestt')).toBeVisible();
    await expect(viva.getByText(/não existe mais na loja/)).toHaveCount(0);

    expectSoLeiturasDaConta(stubs, conta);
  });

  test('opens a stored chart read-only, cell for cell as the shop defines it', async ({ page }) => {
    const stubs = await instalarStubsShopee(page);
    await abrirAbaShopee(page, comMapa, conta);

    const usada = page.getByTestId(`shopee-medida-entrada-${conta}-0`);
    // Offered once the detail read answered.
    const ver = usada.getByRole('button', { name: 'Ver tabela' });
    await expect(ver).toBeVisible({ timeout: 30_000 });
    await ver.click();
    const grade = page.getByTestId('shopee-tabela-grid');
    await expect(grade).toBeVisible({ timeout: 30_000 });

    // The doc sample projects clean: three sizes, three columns, no problem line.
    await expect(grade.getByTestId(/^shopee-tabela-grid-linha-/)).toHaveCount(3);
    await expect(grade.getByTestId('shopee-tabela-grid-problemas')).toHaveCount(0);
    // The unit rides only on the numeric columns — the dropdown's "cm" is not a size.
    await expect(grade.getByRole('columnheader')).toHaveText([
      'test single input number (cm)',
      'susu_input_range_number_with_special_unit_kg (kg)',
      'regional 001 dropdowm',
    ]);
    await expect(grade.getByTestId('shopee-tabela-grid-linha-0').getByRole('cell')).toHaveText([
      '1',
      '12–13',
      '01s',
    ]);
    await expect(grade.getByTestId('shopee-tabela-grid-linha-2').getByRole('cell')).toHaveText([
      '3',
      '14–16',
      '01l',
    ]);
    // Read-only: nothing to type into.
    await expect(grade.getByRole('textbox')).toHaveCount(0);
    await expect(grade.getByRole('spinbutton')).toHaveCount(0);

    expectSoLeiturasDaConta(stubs, conta);
  });

  test('saves a new pick with the tabela and leaves the sibling conta and Mercado Livre maps untouched', async ({
    page,
  }) => {
    const antes = await lerMapas(comMapa);
    // Non-vacuous: the save below has a sibling list and an ML map to clobber.
    expect(antes.shopee[CONTA_SHOPEE_IRMA]).toEqual(seed.shopee[CONTA_SHOPEE_IRMA]);
    expect(antes.mercadoLivre).toEqual(seed.mercadoLivre);
    const antesDaConta = listaNoFormatoDoCorpus(antes.shopee, conta);

    const stubs = await instalarStubsShopee(page);
    const card = await abrirAbaShopee(page, comMapa, conta);
    await escolherTabela(page, card, REGATAS, GUIA_REGATAS.sizeChartId);

    // Staged: a new row in the form, the live chart name, nothing written yet.
    const nova = page.getByTestId(`shopee-medida-entrada-${conta}-${String(antesDaConta.length)}`);
    await expect(nova.getByText(`#${String(GUIA_REGATAS.sizeChartId)}`)).toBeVisible();
    await expect(nova.getByText(GUIA_REGATAS.sizeChartName)).toBeVisible({ timeout: 30_000 });
    expect((await lerMapas(comMapa)).shopee).toEqual(antes.shopee);

    await salvarTabela(page);

    const depois = await lerMapas(comMapa);
    // THIS conta: every stored entry kept in place, the new one appended in the
    // corpus shape — `name` is the CATEGORY's label, never the chart's.
    expect(listaNoFormatoDoCorpus(depois.shopee, conta)).toEqual([
      ...antesDaConta,
      {
        categoryId: REGATAS.categoryId,
        size_chart_id: GUIA_REGATAS.sizeChartId,
        name: REGATAS.name,
      },
    ]);
    // Everything else exactly as it was.
    expect(Object.keys(depois.shopee).sort()).toEqual(Object.keys(antes.shopee).sort());
    expect(depois.shopee[CONTA_SHOPEE_IRMA]).toEqual(antes.shopee[CONTA_SHOPEE_IRMA]);
    expect(depois.mercadoLivre).toEqual(antes.mercadoLivre);

    expectSoLeiturasDaConta(stubs, conta);
  });

  test('applies a staged removal only on save, and an undone one leaves nothing to save', async ({
    page,
  }) => {
    // Two loads of the editor and one of the list: past the 60s default on a cold backend.
    test.setTimeout(120_000);
    const antes = await lerMapas(comMapa);
    const antesDaConta = listaNoFormatoDoCorpus(antes.shopee, conta);
    // Raw 0 and raw 1 share the category: removing 0 must promote 1.
    expect(antesDaConta[0]?.categoryId).toBe(CAMISETAS.categoryId);
    expect(antesDaConta[1]?.categoryId).toBe(CAMISETAS.categoryId);

    const dialogos: string[] = [];
    page.on('dialog', (dialogo) => {
      dialogos.push(dialogo.message());
      void dialogo.dismiss();
    });
    const stubs = await instalarStubsShopee(page);
    await abrirAbaShopee(page, comMapa, conta);

    const primeira = page.getByTestId(`shopee-medida-entrada-${conta}-0`);
    const segunda = page.getByTestId(`shopee-medida-entrada-${conta}-1`);
    await expect(segunda.getByText(/ignorada/)).toBeVisible({ timeout: 30_000 });
    await expectPapel(primeira, 'usada');

    // Mark: still on screen and undoable, its successor now the one in force.
    await primeira.getByRole('button', { name: 'Remover' }).click();
    await expectPapel(primeira, 'sera-removida');
    await expect(primeira.getByRole('button', { name: 'Desfazer' })).toBeVisible();
    await expect(primeira.getByText('#700024639')).toBeVisible();
    await expectPapel(segunda, 'usada');
    await expect(segunda.getByText(/ignorada/)).toHaveCount(0);
    expect((await lerMapas(comMapa)).shopee).toEqual(antes.shopee);

    // Undo: back exactly as loaded — the form is clean, so leaving asks nothing.
    await primeira.getByRole('button', { name: 'Desfazer' }).click();
    await expectPapel(primeira, 'usada');
    await expectPapel(segunda, 'ignorada-duplicada');
    await page.getByRole('link', { name: 'Voltar à lista' }).click();
    await expect
      .poll(() => (dialogos.length > 0 ? dialogos.join(' | ') : new URL(page.url()).pathname), {
        message: 'an undone removal must leave the form clean (no unsaved-changes prompt)',
        timeout: 15_000,
      })
      .toBe('/medidas');
    expect((await lerMapas(comMapa)).shopee).toEqual(antes.shopee);

    // Mark again and save: only now is the entry gone.
    await abrirAbaShopee(page, comMapa, conta);
    await primeira.getByRole('button', { name: 'Remover' }).click();
    await expectPapel(primeira, 'sera-removida');
    await salvarTabela(page);

    const depois = await lerMapas(comMapa);
    expect(listaNoFormatoDoCorpus(depois.shopee, conta)).toEqual(antesDaConta.slice(1));
    expect(JSON.stringify(depois.shopee)).not.toContain('_pendingDelete');
    expect(depois.shopee[CONTA_SHOPEE_IRMA]).toEqual(seed.shopee[CONTA_SHOPEE_IRMA]);
    expect(depois.mercadoLivre).toEqual(seed.mercadoLivre);

    expectSoLeiturasDaConta(stubs, conta);
  });

  test('creates the Shopee map on the first pick of a tabela that had none', async ({ page }) => {
    const antes = await getTabMediById(semMapa);
    expect(antes?.tabelasMedidasShopee).toBeNull();

    const stubs = await instalarStubsShopee(page);
    const card = await abrirAbaShopee(page, semMapa, conta);
    await escolherTabela(page, card, CAMISETAS, 700024639);
    await expect(page.getByTestId(`shopee-medida-entrada-${conta}-0`)).toBeVisible();
    await salvarTabela(page);

    const depois = await getTabMediById(semMapa);
    expect(depois?.tabelasMedidasShopee).toEqual({
      [conta]: [
        { categoryId: CAMISETAS.categoryId, size_chart_id: 700024639, name: CAMISETAS.name },
      ],
    });
    expect(
      listaNoFormatoDoCorpus(depois?.tabelasMedidasShopee as Record<string, unknown>, conta),
    ).toHaveLength(1);
    expect(depois?.tabelasDeMedidasMercadoLivre).toBeNull();

    expectSoLeiturasDaConta(stubs, conta);
  });
});
