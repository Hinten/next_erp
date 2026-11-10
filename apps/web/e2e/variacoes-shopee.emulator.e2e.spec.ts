import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import type {
  CategoriaResumoDto,
  RespostaCategoriasShopee,
  RespostaLimitesDoItemShopee,
  RespostaVariacoesShopee,
  VariacaoDto,
} from '@delfrance/schemas';
import {
  VINCULADOR_SHOPEE_E2E,
  cleanupVinculadorShopeeFixtures,
  e2ePrefix,
  escreverLinksVariacoesShopeeConcorrente,
  getGrupoDeVariacoesDoc,
  seedVinculadorShopeeFixtures,
  type VinculadorShopeeFixtures,
} from './_helpers/seed-data';
import { expectToast } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * The "Shopee" tab of a variation group (#1911 P14), end to end on the
 * emulators: the grupo, the contas and every save are real Firestore
 * documents, read back with the Admin SDK after each save. The Loja Integrada
 * and Amazon arrays of the same grupo must come back exactly as stored.
 *
 * The `apps/shopee` backend does NOT run in this suite. Its three taxonomy
 * reads are STUBBED with `page.route`, matched on the exact pathname under
 * `/api/marketplace/shopee/` (whatever host the build points at), for the
 * ACTIVE conta only, with the CORS preflight answered. Any other call to that
 * prefix is recorded and answered 409, so an unexpected request names itself,
 * and each test asserts that list is empty. The routes, the Shopee calls and
 * the cache are covered by the backend's own offline suites.
 *
 * The stubbed tree is ONE invented root holding four invented leaves: a Fashion
 * leaf (the stored entry's), a second Fashion leaf (the import's), a mug leaf
 * whose variations carry no option, and a leaf whose tree read fails the way a
 * backend calling a path Shopee does not serve fails (502, Shopee's
 * `error_not_found`). The variation, group and option ids and names inside the
 * Fashion tree are Shopee's PUBLIC standard taxonomy ("Tamanho" 101056 with its
 * INT and BR groups, "Cor" 101054 with two «Preto»), except one INVENTED BR
 * option for G. Every category id and every name the ERP owns is invented.
 *
 * Every assertion is scoped by the run-scoped `data-testid`s of the tab
 * (`vinculador-shopee-conta-<conta>`, `vinculo-shopee-<conta>-<category>`,
 * `vinculo-shopee-leitura-<index>`), since the emulator holds every suite's
 * contas. Serial: each case re-seeds the same two grupos.
 */

/** Every apps/shopee route hangs off this path, whatever host the build points at. */
const PREFIXO_ROTAS = '/api/marketplace/shopee/';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type, Accept',
  'access-control-allow-methods': 'GET, OPTIONS',
};

/* ---------------------------- the category tree ---------------------------- */

const NOME_RAIZ = 'Raiz inventada';
const RAIZ: CategoriaResumoDto = {
  categoryId: 990_100,
  name: NOME_RAIZ,
  originalName: 'Invented root',
  isLeaf: false,
};
/** The stored entry's leaf: the seed's, so its tree answers the stored card. */
const FOLHA_MODA: CategoriaResumoDto = {
  categoryId: VINCULADOR_SHOPEE_E2E.categoriaModa.categoryId,
  name: VINCULADOR_SHOPEE_E2E.categoriaModa.nome,
  originalName: 'Invented trousers',
  isLeaf: true,
};
/** The leaf of the entry the import writes while the page is open (case 5). */
const FOLHA_MODA_IMPORTADA: CategoriaResumoDto = {
  categoryId: 990_102,
  name: 'Saias inventadas',
  originalName: 'Invented skirts',
  isLeaf: true,
};
/** A leaf with standard variations and not one option: nothing to bind. */
const FOLHA_CANECA: CategoriaResumoDto = {
  categoryId: 990_103,
  name: 'Canecas inventadas',
  originalName: 'Invented mugs',
  isLeaf: true,
};
/** A leaf whose tree read fails 502 `error_not_found`. */
const FOLHA_SEM_ARVORE: CategoriaResumoDto = {
  categoryId: 990_104,
  name: 'Categoria inventada sem árvore',
  originalName: 'Invented treeless category',
  isLeaf: true,
};
const FOLHAS = [FOLHA_MODA, FOLHA_MODA_IMPORTADA, FOLHA_CANECA, FOLHA_SEM_ARVORE];

/** `taxonomia/categorias?categoryId=` for one node of the stubbed tree, or `null`. */
function noDaArvore(categoryId: number): RespostaCategoriasShopee | null {
  if (categoryId === RAIZ.categoryId) {
    return {
      raizes: null,
      no: { ...RAIZ, parentId: 0, pathFromRoot: [RAIZ], children: FOLHAS },
    };
  }
  const folha = FOLHAS.find((f) => f.categoryId === categoryId);
  if (folha === undefined) return null;
  return {
    raizes: null,
    no: { ...folha, parentId: RAIZ.categoryId, pathFromRoot: [RAIZ, folha], children: [] },
  };
}

/* --------------------------- the variation trees --------------------------- */

const VARIACAO_TAMANHO = VINCULADOR_SHOPEE_E2E.variacaoTamanho;
const VARIACAO_COR = 101_054;
/** Shopee's public groups of "Tamanho": international and Brazilian sizes. */
const GRUPO_INT = 841_350_766_059_029;
const GRUPO_BR = 844_758_844_060_204;
const ROTULO_GRUPO_BR = `Tamanho (BR) (${String(GRUPO_BR)})`;

/**
 * «Tamanho (BR)»'s option for G: an INVENTED id, and a name with a trailing
 * space. Shopee's names do carry such spaces (« Estampa»): the tab shows the
 * name trimmed and a link stores it verbatim.
 */
const OPCAO_BR_G = { variationOptionId: 990_013, variationOptionName: 'G ' };

function opcao(variationOptionId: number, variationOptionName: string) {
  return { variationOptionId, variationOptionName };
}

/**
 * A Fashion leaf's tree: "Tamanho" with two option-bearing groups (so a link must
 * record one), "Cor" single-level (group `0`, name `''`) with two options both
 * named «Preto», and an option-less "Estilo". ⚠️ 6933, which the stored entry's
 * M row names, is in NEITHER group: the stored id is outside the current list.
 */
const VARIACOES_MODA: VariacaoDto[] = [
  {
    variationId: VARIACAO_TAMANHO,
    variationName: 'Tamanho',
    variationGroupList: [
      {
        variationGroupId: GRUPO_INT,
        variationGroupName: 'Tamanho (INT)',
        variationOptionList: [opcao(6270, 'M')],
      },
      {
        variationGroupId: GRUPO_BR,
        variationGroupName: 'Tamanho (BR)',
        variationOptionList: [opcao(6857, 'P'), OPCAO_BR_G],
      },
    ],
  },
  {
    variationId: VARIACAO_COR,
    variationName: 'Cor',
    variationGroupList: [
      {
        variationGroupId: 0,
        variationGroupName: '',
        variationOptionList: [
          opcao(6258, 'Preto'),
          opcao(9585, 'Preto'),
          opcao(9632, 'Azul Turquesa'),
        ],
      },
    ],
  },
  { variationId: 103_236, variationName: 'Estilo', variationGroupList: [] },
];

/** A mug leaf's tree: several standard variations, not one option among them. */
const VARIACOES_CANECA: VariacaoDto[] = [
  { variationId: VARIACAO_COR, variationName: 'Cor', variationGroupList: [] },
  { variationId: 103_236, variationName: 'Estilo', variationGroupList: [] },
  { variationId: 101_264, variationName: ' Estampa', variationGroupList: [] },
  { variationId: 102_870, variationName: 'Capacidade', variationGroupList: [] },
];

function arvore(categoryId: number, lista: VariacaoDto[]): RespostaVariacoesShopee {
  return {
    leaf: true,
    categoryId,
    standardiseVariationList: lista,
    pathUsed: '/api/v2/product/get_variation_tree',
  };
}

/** The 502 `lib/shopee/core/respond.ts` builds when Shopee answers `error_not_found`. */
const FALHA_ERROR_NOT_FOUND = {
  error: 'A Shopee recusou a consulta (error_not_found).',
  code: 'SHOPEE_HTTP_ERROR',
  upstreamStatus: 404,
  shopeeCode: 'error_not_found',
  kind: 'other',
};

/**
 * `taxonomia/limites?categoryId=` for a Fashion leaf, the WHOLE envelope: only
 * the custom-option band is set (what the tab measures a custom name against);
 * every other band is "Shopee did not say".
 */
function limitesDaFolha(categoryId: number): RespostaLimitesDoItemShopee {
  return {
    scope: 'category',
    categoryId,
    limites: {
      priceLimit: null,
      wholesalePriceThresholdPercentage: null,
      stockLimit: null,
      itemNameLengthLimit: null,
      itemImageCountLimit: null,
      itemDescriptionLengthLimit: null,
      tierVariationNameLengthLimit: null,
      tierVariationOptionLengthLimit: { min: 1, max: 30 },
      itemCountLimit: null,
      extendedDescriptionLimit: null,
      dtsLimit: null,
      weightLimit: null,
      dimensionLimit: null,
      sizeChartLimit: null,
    },
    gtinLimit: null,
    supportsPreOrder: false,
  };
}

/* --------------------------------- the stubs -------------------------------- */

type Resposta = { readonly status: number; readonly corpo: unknown };

const ok = (corpo: unknown): Resposta => ({ status: 200, corpo });

const ehModa = (id: number | null) =>
  id === FOLHA_MODA.categoryId || id === FOLHA_MODA_IMPORTADA.categoryId;

/** The body the real route answers for this route and category, or `null` (unexpected). */
function responder(rota: string, categoria: string | null): Resposta | null {
  const id = categoria === null ? null : Number(categoria);
  switch (rota) {
    case 'taxonomia/categorias': {
      if (id === null) return ok({ raizes: [RAIZ], no: null } satisfies RespostaCategoriasShopee);
      const no = noDaArvore(id);
      return no === null ? null : ok(no);
    }
    case 'taxonomia/variacoes':
      if (id !== null && ehModa(id)) return ok(arvore(id, VARIACOES_MODA));
      if (id === FOLHA_CANECA.categoryId) return ok(arvore(id, VARIACOES_CANECA));
      if (id === FOLHA_SEM_ARVORE.categoryId) return { status: 502, corpo: FALHA_ERROR_NOT_FOUND };
      return null;
    case 'taxonomia/limites':
      return id !== null && ehModa(id) ? ok(limitesDaFolha(id)) : null;
    default:
      return null;
  }
}

interface StubShopee {
  /** Every stubbed read, in order: `<route> <categoryId|->`. */
  readonly leituras: string[];
  /** Anything else that reached `/api/marketplace/shopee/`, each answered 409. */
  readonly inesperadas: string[];
}

/**
 * Stub the three taxonomy reads for `contaId`. MUST run BEFORE `page.goto`. A
 * read for any other conta, category or route is unexpected.
 */
async function instalarStubsShopee(page: Page, contaId: string): Promise<StubShopee> {
  const stub: StubShopee = { leituras: [], inesperadas: [] };
  await page.route(
    (url) => url.pathname.startsWith(PREFIXO_ROTAS),
    async (route: Route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: CORS });
        return;
      }
      const url = new URL(req.url());
      const rota = url.pathname.slice(PREFIXO_ROTAS.length);
      const categoria = url.searchParams.get('categoryId');
      const json = (status: number, corpo: unknown) =>
        route.fulfill({
          status,
          headers: { ...CORS, 'Cache-Control': 'no-store' },
          contentType: 'application/json',
          body: JSON.stringify(corpo),
        });
      const resposta =
        req.method() === 'GET' && url.searchParams.get('integracaoId') === contaId
          ? responder(rota, categoria)
          : null;
      if (resposta === null) {
        stub.inesperadas.push(`${req.method()} ${url.pathname}${url.search}`);
        await json(409, { error: 'chamada inesperada no e2e', code: 'E2E_INESPERADA' });
        return;
      }
      stub.leituras.push(`${rota} ${categoria ?? '-'}`);
      await json(resposta.status, resposta.corpo);
    },
  );
  return stub;
}

/* ------------------------------- the copy -------------------------------- */

/*
 * The tab's copy (design-C-VAR §10), spelled here: its sources import the
 * browser's Shopee client (and through it the auth hook), which a Node spec
 * must not load. Each names where it is written.
 */

/** §10 #12, `VinculadorDaShopee.tsx` — a leaf with nothing to bind. */
const FRASE_NAO_PRECISA_VINCULAR =
  'Esta categoria não tem variações padrão da Shopee: não é preciso vincular. A publicação usa variações personalizadas, com o nome do grupo e das variantes.';
/** §10 #26, `MENSAGEM_VARIACOES_SHOPEE_BACKEND_DESATUALIZADO` (`lib/shopee/variacoes.ts`). */
const FRASE_BACKEND_DESATUALIZADO =
  'A Shopee não reconheceu a consulta de variações (HTTP 404): o backend da Shopee está desatualizado. Os vínculos guardados continuam aqui e podem ser removidos; para escolher opções novas, o backend precisa ser atualizado.';
/** §10 #21, `mensagemDoAchadoShopee` (`grupo-ausente`). */
const FRASE_GRUPO_AUSENTE =
  'A Shopee exige o grupo de opções desta variação, e este vínculo não o registra. Escolha o grupo — ou reimporte o anúncio, que o registra.';
/** §10 #22, `mensagemDoAchadoShopee` (`opcao-fora-da-arvore`), for the stored M row. */
const FRASE_M_FORA_DA_LISTA =
  'A opção M (6933) não está entre as opções atuais da Shopee para a variação e o grupo deste vínculo. O vínculo é mantido: um anúncio publicado pode estar usando essa opção.';
/** §10 #18, `VinculadorDaShopee.tsx` — a custom entry. */
const FRASE_VINCULO_PERSONALIZADO =
  'Vínculo personalizado (gravado pela importação): as opções levam o nome guardado em cada uma (sem opção guardada, o da variante) e não há o que vincular aqui.';
/** §10 #7. */
const FRASE_SEM_VINCULO = 'Nenhum vínculo com esta conta.';
/** `NothingChangedError` (`packages/ui`): the save of a pristine form. */
const TOAST_NADA_A_SALVAR = 'Nenhuma alteração para salvar';

/** The variante case 2 types in the Variantes tab: an invented name. */
const VARIANTE_NOVA = 'Tamanho inventado';

/* -------------------------------- the helpers ------------------------------- */

/** Pick `opcao` in the Mantine `Select` `campo`, and wait for its list to close. */
async function escolherOpcao(page: Page, campo: Locator, opcao: string): Promise<void> {
  await campo.click();
  await page.getByRole('option', { name: opcao, exact: true }).click();
  // Every variante's list holds «Sem opção»: never let two lists be open at once.
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

/** Drill from the roots into the one root and pick `folha` in the add modal. */
async function escolherCategoria(modal: Locator, folha: CategoriaResumoDto): Promise<void> {
  const navegador = modal.getByTestId('shopee-categoria-browser');
  await navegador
    .getByTestId(`shopee-categoria-linha-${String(RAIZ.categoryId)}`)
    .getByRole('button', { name: NOME_RAIZ, exact: true })
    .click();
  await navegador
    .getByTestId(`shopee-categoria-linha-${String(folha.categoryId)}`)
    .getByRole('button', { name: 'Escolher', exact: true })
    .click();
  await expect(
    modal.getByText(`Categoria: ${String(folha.name)} (${String(folha.categoryId)})`, {
      exact: true,
    }),
  ).toBeVisible();
}

async function salvarEContinuar(page: Page) {
  await page.getByRole('button', { name: 'Salvar e continuar' }).click();
}

test.describe.serial('Variações — o vínculo com a Shopee', () => {
  const prefix = e2ePrefix('vincshp');
  let fx: VinculadorShopeeFixtures;

  test.beforeAll(async ({ browser }) => {
    // Cold-compiling the editor route can outlast the budget.
    test.setTimeout(240_000);
    await warmRoutes(browser, ['/variacoes/__aquecimento__']);
  });

  // Every case starts from the same two stored grupos.
  test.beforeEach(async () => {
    fx = await seedVinculadorShopeeFixtures(prefix);
  });

  test.afterAll(async () => {
    await cleanupVinculadorShopeeFixtures(prefix);
  });

  const abrir = async (page: Page, grupoId: string, aba = 'Shopee') => {
    await page.goto(`/variacoes/${grupoId}`);
    await expect(page.locator('form[data-snapshot-source="server"]')).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('tab', { name: aba }).click();
  };
  const blocoDaConta = (page: Page) =>
    page.getByTestId(`vinculador-shopee-conta-${fx.contaAtivaId}`);
  const cartao = (page: Page, categoryId: number) =>
    blocoDaConta(page).getByTestId(`vinculo-shopee-${fx.contaAtivaId}-${String(categoryId)}`);
  const outrasContas = (page: Page) => page.getByTestId('vinculador-shopee-outras');
  const modalNovoVinculo = (page: Page) => page.getByTestId('shopee-novo-vinculo-modal');
  const opcaoDaVariante = (vinculo: Locator, variante: string) =>
    vinculo.getByRole('combobox', { name: `Opção da Shopee para «${variante}»`, exact: true });
  const linksGuardados = async (grupoId = fx.grupoId) =>
    (await getGrupoDeVariacoesDoc(grupoId))?.linksVariacoesShopee as
      | Record<string, unknown>[]
      | undefined;

  test('lista o vínculo guardado sob a sua conta, com o aviso do grupo e a opção fora da lista atual, e o personalizado da conta inativa à parte', async ({
    page,
  }) => {
    const stub = await instalarStubsShopee(page, fx.contaAtivaId);
    await abrir(page, fx.grupoId);

    const vinculo = cartao(page, FOLHA_MODA.categoryId);
    await expect(
      vinculo.getByText(`${String(FOLHA_MODA.name)} (${String(FOLHA_MODA.categoryId)})`, {
        exact: true,
      }),
    ).toBeVisible();
    // The tree was read: the variation is named by it, no longer by its id.
    await expect(vinculo.getByText('Tamanho (101056)', { exact: true })).toBeVisible();
    // Stored group 0 on a two-group variation: the group is asked for, and no
    // option can be chosen until it is.
    await expect(vinculo.getByText(FRASE_GRUPO_AUSENTE)).toBeVisible();
    await expect(
      vinculo.getByRole('combobox', { name: 'Grupo de opções', exact: true }),
    ).toBeEnabled();
    await expect(opcaoDaVariante(vinculo, 'M')).toBeDisabled();
    // 6933 is in no group of the current tree: kept, labelled and warned about.
    await expect(opcaoDaVariante(vinculo, 'M')).toHaveValue('M (6933) — fora da lista atual');
    await expect(vinculo.getByText(FRASE_M_FORA_DA_LISTA)).toBeVisible();
    // NEAR-MISS: 6857 IS in the tree (group BR), so it is not called outside it.
    await expect(opcaoDaVariante(vinculo, 'P')).toHaveValue('P (6857)');
    await expect(opcaoDaVariante(vinculo, 'G')).toHaveValue('Sem opção');

    // The inactive conta's custom entry is listed apart, read-only, never read from Shopee.
    const outras = outrasContas(page);
    await expect(outras.getByText('Vínculos de outras contas', { exact: true })).toBeVisible();
    const personalizado = outras.getByTestId('vinculo-shopee-leitura-1');
    await expect(personalizado.getByText('Personalizada', { exact: true })).toBeVisible();
    await expect(personalizado.getByText(FRASE_VINCULO_PERSONALIZADO)).toBeVisible();
    await expect(
      personalizado.getByText(`${fx.contaInativaId} (inativa)`, { exact: true }),
    ).toBeVisible();
    await expect(personalizado.getByRole('combobox')).toHaveCount(0);

    expect(stub.leituras).toContain(`taxonomia/variacoes ${String(FOLHA_MODA.categoryId)}`);
    expect(await linksGuardados()).toStrictEqual(fx.links);
    expect(stub.inesperadas).toEqual([]);
  });

  test('escolhe o grupo BR, vincula G a uma opção BR e uma variante nova a uma opção personalizada; os outros vínculos voltam intactos', async ({
    page,
  }) => {
    const stub = await instalarStubsShopee(page, fx.contaAtivaId);
    await abrir(page, fx.grupoId, 'Variantes');
    await page.getByRole('button', { name: 'Adicionar variante' }).click();
    await page
      .getByRole('tabpanel', { name: 'Variantes' })
      .getByRole('textbox', { name: 'Nome', exact: true })
      .last()
      .fill(VARIANTE_NOVA);
    await page.getByRole('tab', { name: 'Shopee' }).click();

    const vinculo = cartao(page, FOLHA_MODA.categoryId);
    await expect(vinculo.getByText('Tamanho (101056)', { exact: true })).toBeVisible();
    await escolherOpcao(
      page,
      vinculo.getByRole('combobox', { name: 'Grupo de opções', exact: true }),
      ROTULO_GRUPO_BR,
    );
    // Recorded: the group is named, no longer asked for.
    await expect(
      vinculo.getByText(`Tamanho (101056) · ${ROTULO_GRUPO_BR}`, { exact: true }),
    ).toBeVisible();
    await expect(
      vinculo.getByRole('combobox', { name: 'Grupo de opções', exact: true }),
    ).toHaveCount(0);

    // Group scope: BR's options are offered, INT's M (6270) never is.
    await opcaoDaVariante(vinculo, 'G').click();
    await expect(page.getByRole('option', { name: 'P (6857)', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'M (6270)', exact: true })).toHaveCount(0);
    // Shown trimmed, stored verbatim (below).
    await page
      .getByRole('option', { name: `G (${String(OPCAO_BR_G.variationOptionId)})`, exact: true })
      .click();
    await expect(page.getByRole('listbox')).toHaveCount(0);

    await escolherOpcao(
      page,
      opcaoDaVariante(vinculo, VARIANTE_NOVA),
      `Personalizada: «${VARIANTE_NOVA}»`,
    );
    // A custom name is measured against the leaf's band.
    await expect
      .poll(() => stub.leituras)
      .toContain(`taxonomia/limites ${String(FOLHA_MODA.categoryId)}`);
    await salvarEContinuar(page);

    await expect
      .poll(async () => (await linksGuardados())?.[0]?.variation_group_list, { timeout: 15_000 })
      .toBe(GRUPO_BR);
    const grupo = await getGrupoDeVariacoesDoc(fx.grupoId);
    const variantes = (grupo?.variacoes ?? []) as { id: string; nome: string }[];
    const novaId = variantes.find((v) => v.nome === VARIANTE_NOVA)?.id;
    expect(novaId).toMatch(/^[a-z0-9]{8}$/);
    const [vinculoModa, personalizado] = fx.links;
    const linhasGuardadas = (vinculoModa?.variationOptions ?? []) as unknown[];
    expect(grupo?.linksVariacoesShopee).toStrictEqual([
      {
        ...vinculoModa,
        variation_group_list: GRUPO_BR,
        variationOptions: [
          ...linhasGuardadas,
          {
            shopee_option_id: OPCAO_BR_G.variationOptionId,
            shopee_option_name: OPCAO_BR_G.variationOptionName,
            arakene_variation_id: ['g'],
          },
          {
            shopee_option_id: 0,
            shopee_option_name: VARIANTE_NOVA,
            arakene_variation_id: [novaId],
          },
        ],
      },
      personalizado,
    ]);
    expect(grupo?.linksVariacoesli).toStrictEqual(fx.linksLi);
    expect(grupo?.linksVariacoesAmazon).toStrictEqual(fx.linksAmazon);
    expect(stub.inesperadas).toEqual([]);
  });

  test('numa folha sem opções padrão diz que não é preciso vincular e não acrescenta nada', async ({
    page,
  }) => {
    const stub = await instalarStubsShopee(page, fx.contaAtivaId);
    await abrir(page, fx.grupoId);

    await blocoDaConta(page).getByRole('button', { name: 'Adicionar vínculo' }).click();
    const modal = modalNovoVinculo(page);
    await escolherCategoria(modal, FOLHA_CANECA);
    await expect(modal.getByText(FRASE_NAO_PRECISA_VINCULAR)).toBeVisible();
    await expect(
      modal.getByRole('combobox', { name: 'Variação da Shopee', exact: true }),
    ).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Adicionar', exact: true })).toBeDisabled();
    await modal.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(modal).toHaveCount(0);

    // Nothing entered the form: the save has nothing to write.
    await salvarEContinuar(page);
    await expectToast(page, TOAST_NADA_A_SALVAR);
    expect(await linksGuardados()).toStrictEqual(fx.links);
    expect(stub.leituras).toContain(`taxonomia/variacoes ${String(FOLHA_CANECA.categoryId)}`);
    expect(stub.inesperadas).toEqual([]);
  });

  test('numa folha cuja leitura falha com error_not_found mostra a frase do backend desatualizado, não deixa adicionar e mantém os vínculos guardados', async ({
    page,
  }) => {
    const stub = await instalarStubsShopee(page, fx.contaAtivaId);
    await abrir(page, fx.grupoId);

    await blocoDaConta(page).getByRole('button', { name: 'Adicionar vínculo' }).click();
    const modal = modalNovoVinculo(page);
    await escolherCategoria(modal, FOLHA_SEM_ARVORE);
    await expect(modal.getByText(FRASE_BACKEND_DESATUALIZADO)).toBeVisible();
    // The same read fails until the backend changes: no retry is offered.
    await expect(modal.getByRole('button', { name: 'Tentar de novo' })).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Adicionar', exact: true })).toBeDisabled();
    await modal.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(modal).toHaveCount(0);

    // The stored entries are still listed, each where it was.
    await expect(
      cartao(page, FOLHA_MODA.categoryId).getByText('Tamanho (101056)', { exact: true }),
    ).toBeVisible();
    await expect(outrasContas(page).getByTestId('vinculo-shopee-leitura-1')).toBeVisible();
    expect(stub.leituras).toContain(`taxonomia/variacoes ${String(FOLHA_SEM_ARVORE.categoryId)}`);
    expect(await linksGuardados()).toStrictEqual(fx.links);
    expect(stub.inesperadas).toEqual([]);
  });

  test('um vínculo que a importação grava com a página aberta é mantido: o conflito mescla por conta e categoria', async ({
    page,
  }) => {
    const stub = await instalarStubsShopee(page, fx.contaAtivaId);
    await abrir(page, fx.grupoId);

    // A valid edit: the stored entry gets its group.
    const vinculo = cartao(page, FOLHA_MODA.categoryId);
    await expect(vinculo.getByText('Tamanho (101056)', { exact: true })).toBeVisible();
    await escolherOpcao(
      page,
      vinculo.getByRole('combobox', { name: 'Grupo de opções', exact: true }),
      ROTULO_GRUPO_BR,
    );
    await expect(
      vinculo.getByText(`Tamanho (101056) · ${ROTULO_GRUPO_BR}`, { exact: true }),
    ).toBeVisible();

    // The import writes its entry for another Fashion leaf meanwhile (its shape:
    // the bare conta id, the listing's own group).
    const importado: Record<string, unknown> = {
      name: FOLHA_MODA_IMPORTADA.name,
      category_id: FOLHA_MODA_IMPORTADA.categoryId,
      variation_id: VARIACAO_TAMANHO,
      variation_group_list: GRUPO_BR,
      integracaoShopeeId: fx.contaAtivaId,
      variationOptions: [
        { shopee_option_id: 6857, shopee_option_name: 'P', arakene_variation_id: ['p'] },
      ],
    };
    await escreverLinksVariacoesShopeeConcorrente(fx.grupoId, [...fx.links, importado]);

    await salvarEContinuar(page);
    await expect(page.getByText('Registro alterado')).toBeVisible();
    await expect(page.getByText('mescla por conta e categoria')).toBeVisible();
    await page.getByRole('button', { name: 'Salvar mesmo assim' }).click();

    const [vinculoModa, personalizado] = fx.links;
    const editado = { ...vinculoModa, variation_group_list: GRUPO_BR };
    await expect
      .poll(async () => (await linksGuardados())?.[0], { timeout: 15_000 })
      .toEqual(editado);
    expect(await linksGuardados()).toStrictEqual([editado, personalizado, importado]);
    // The merged entry is a card of the conta's block too.
    await expect(cartao(page, FOLHA_MODA_IMPORTADA.categoryId)).toBeVisible();
    expect(stub.inesperadas).toEqual([]);
  });

  test('remover um vínculo é uma marca que se desfaz; marcado de novo e salvo, só ele sai', async ({
    page,
  }) => {
    const stub = await instalarStubsShopee(page, fx.contaAtivaId);
    await abrir(page, fx.grupoId);

    const personalizado = outrasContas(page).getByTestId('vinculo-shopee-leitura-1');
    const marca = personalizado.getByText('Será removido', { exact: true });
    await personalizado.getByRole('button', { name: 'Remover vínculo' }).click();
    await expect(marca).toBeVisible();
    await personalizado.getByRole('button', { name: 'Desfazer remoção' }).click();
    await expect(marca).toHaveCount(0);
    await personalizado.getByRole('button', { name: 'Remover vínculo' }).click();
    await expect(marca).toBeVisible();
    // Staged, not removed: still listed, and still stored until the save.
    await expect(personalizado.getByText(FRASE_VINCULO_PERSONALIZADO)).toBeVisible();
    expect(await linksGuardados()).toStrictEqual(fx.links);

    await salvarEContinuar(page);
    await expect.poll(async () => (await linksGuardados())?.length, { timeout: 15_000 }).toBe(1);
    const grupo = await getGrupoDeVariacoesDoc(fx.grupoId);
    expect(grupo?.linksVariacoesShopee).toStrictEqual([fx.links[0]]);
    expect(grupo?.linksVariacoesli).toStrictEqual(fx.linksLi);
    expect(grupo?.linksVariacoesAmazon).toStrictEqual(fx.linksAmazon);
    // Saved, it is gone from the tab as well.
    await expect(outrasContas(page)).toHaveCount(0);
    expect(stub.inesperadas).toEqual([]);
  });

  test('num grupo sem a chave, acrescentar um vínculo e removê-lo deixa o formulário sem alterações', async ({
    page,
  }) => {
    const stub = await instalarStubsShopee(page, fx.contaAtivaId);
    await abrir(page, fx.grupoSemChaveId);

    const bloco = blocoDaConta(page);
    await expect(bloco.getByText(FRASE_SEM_VINCULO, { exact: true })).toBeVisible();
    await bloco.getByRole('button', { name: 'Adicionar vínculo' }).click();
    const modal = modalNovoVinculo(page);
    await escolherCategoria(modal, FOLHA_MODA);
    // Two variations have options here (Estilo has none), so none is picked for
    // the operator; Cor is single-level, so its group `0` needs no choice.
    await escolherOpcao(
      page,
      modal.getByRole('combobox', { name: 'Variação da Shopee', exact: true }),
      `Cor (${String(VARIACAO_COR)})`,
    );
    await expect(modal.getByRole('combobox', { name: 'Grupo de opções', exact: true })).toHaveCount(
      0,
    );
    await modal.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await expect(modal).toHaveCount(0);

    const vinculo = cartao(page, FOLHA_MODA.categoryId);
    await expect(vinculo.getByText(`Cor (${String(VARIACAO_COR)})`, { exact: true })).toBeVisible();
    // A NEW entry leaves at once (nothing stored is at stake), and the emptied
    // field goes back to its seed: the key was absent, and stays absent.
    await vinculo.getByRole('button', { name: 'Remover vínculo' }).click();
    await expect(vinculo).toHaveCount(0);
    await expect(bloco.getByText(FRASE_SEM_VINCULO, { exact: true })).toBeVisible();

    await salvarEContinuar(page);
    await expectToast(page, TOAST_NADA_A_SALVAR);
    const grupo = await getGrupoDeVariacoesDoc(fx.grupoSemChaveId);
    expect(grupo?.ultimaModificacao).toBe(fx.ultimaModificacaoSemChave);
    expect(Object.keys(grupo ?? {})).not.toContain('linksVariacoesShopee');
    expect(stub.inesperadas).toEqual([]);
  });
});
