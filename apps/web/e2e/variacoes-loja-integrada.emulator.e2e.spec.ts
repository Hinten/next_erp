import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { CODIGO_ERRO_LI, type RespostaGradeLi, type RespostaGradesLi } from '@delfrance/schemas';
import {
  cleanupVinculadorLojaIntegradaFixtures,
  e2ePrefix,
  escreverLinksVariacoesLiConcorrente,
  getGrupoDeVariacoesDoc,
  seedVinculadorLojaIntegradaFixtures,
  type VinculadorLojaIntegradaFixtures,
} from './_helpers/seed-data';
import { fillField } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * The "Loja Integrada" tab of a variation group (master plan step 10), end to
 * end on the emulators: the grupo, the contas and every save are real
 * Firestore documents, read back with the Admin SDK after each save.
 *
 * The `apps/loja-integrada` backend does NOT run in this suite: its catalogue
 * routes are STUBBED with `page.route` (matched on the pathname, whatever host
 * the build points at), and any other call to them is recorded and answered
 * 409, so an unexpected request names itself. The routes, the store reads and
 * the cache are covered by the backend's own offline suites.
 */

/** Every conta route hangs off this path, whatever host the build points at. */
const CONTA_PATH = '/api/marketplace/loja-integrada/conta/';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type, Accept',
  'access-control-allow-methods': 'GET, OPTIONS',
};

const GRADES: RespostaGradesLi = {
  grades: [
    { id: 8946, nome: 'Tamanho', nomeVisivel: 'Tamanho' },
    { id: 8950, nome: 'Numeração', nomeVisivel: null },
  ],
  lidaEmMs: Date.now(),
};
const DETALHES: Record<number, RespostaGradeLi> = {
  8946: {
    grade: GRADES.grades[0]!,
    opcoes: [
      { id: 37097, nome: 'P' },
      { id: 37098, nome: 'M' },
      { id: 37099, nome: 'G' },
    ],
    lidaEmMs: GRADES.lidaEmMs,
  },
  8950: {
    grade: GRADES.grades[1]!,
    opcoes: [
      { id: 41, nome: '40' },
      { id: 42, nome: '42' },
    ],
    lidaEmMs: GRADES.lidaEmMs,
  },
};

interface StubCatalogo {
  /** Every catalogue read, in order (method + pathname). */
  readonly leituras: string[];
  /** Anything else that reached a conta route — each answered 409. */
  readonly inesperadas: string[];
}

/**
 * Stub the conta's two catalogue routes. MUST run BEFORE `page.goto`.
 * `desligado` answers both the way every backend does until the cutover: 503
 * `LI_CHAMADAS_DESLIGADAS`.
 */
async function stubCatalogo(
  page: Page,
  contaId: string,
  modo: 'desligado' | 'legivel',
): Promise<StubCatalogo> {
  const stub: StubCatalogo = { leituras: [], inesperadas: [] };
  const base = `${CONTA_PATH}${encodeURIComponent(contaId)}/grades`;
  await page.route(
    (url) => url.pathname.startsWith(CONTA_PATH),
    async (route: Route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: CORS });
        return;
      }
      const pathname = new URL(req.url()).pathname;
      const json = (status: number, corpo: unknown) =>
        route.fulfill({
          status,
          headers: { ...CORS, 'Cache-Control': 'no-store' },
          contentType: 'application/json',
          body: JSON.stringify(corpo),
        });
      const ehLeitura =
        req.method() === 'GET' && (pathname === base || pathname.startsWith(`${base}/`));
      if (!ehLeitura) {
        stub.inesperadas.push(`${req.method()} ${pathname}`);
        await json(409, { error: 'chamada inesperada no e2e', code: 'E2E_INESPERADA' });
        return;
      }
      stub.leituras.push(pathname);
      if (modo === 'desligado') {
        await json(503, {
          error: 'Chamadas à Loja Integrada desligadas.',
          code: CODIGO_ERRO_LI.chamadasDesligadas,
        });
        return;
      }
      if (pathname === base) {
        await json(200, GRADES);
        return;
      }
      const detalhe = DETALHES[Number(pathname.slice(base.length + 1))];
      await (detalhe === undefined
        ? json(409, { error: 'Grade ausente.', code: CODIGO_ERRO_LI.gradeAusenteNaLoja })
        : json(200, detalhe));
    },
  );
  return stub;
}

/** Toggle variante `rotulo` in the MultiSelect of option `opcao` inside `cartao`. */
async function alternarVariante(page: Page, cartao: Locator, opcao: string, rotulo: string) {
  await cartao.getByLabel(`Variantes da opção ${opcao}`, { exact: true }).first().click();
  await page.getByRole('option', { name: rotulo, exact: true }).click();
  await page.keyboard.press('Escape');
}

async function salvarEContinuar(page: Page) {
  await page.getByRole('button', { name: 'Salvar e continuar' }).click();
}

test.describe.serial('Variações — o vínculo com a Loja Integrada', () => {
  const prefix = e2ePrefix('grp-li');
  let fx: VinculadorLojaIntegradaFixtures;

  test.beforeAll(async ({ browser }) => {
    // Cold-compiling the editor route can outlast the budget.
    test.setTimeout(240_000);
    await warmRoutes(browser, ['/variacoes/__aquecimento__']);
  });

  // Every case starts from the same stored grupo.
  test.beforeEach(async () => {
    fx = await seedVinculadorLojaIntegradaFixtures(prefix);
  });

  test.afterAll(async () => {
    await cleanupVinculadorLojaIntegradaFixtures(prefix);
  });

  const abrir = async (page: Page) => {
    await page.goto(`/variacoes/${fx.grupoId}`);
    await expect(page.locator('form[data-snapshot-source="server"]')).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole('tab', { name: 'Loja Integrada' }).click();
  };
  const cartao = (page: Page, grade: number) =>
    page.getByTestId(`vinculo-li-${fx.contaAtivaId}-${String(grade)}`);
  const linksGuardados = async () =>
    (await getGrupoDeVariacoesDoc(fx.grupoId))?.linksVariacoesli as
      | Record<string, unknown>[]
      | undefined;

  test('shows the stored links with their stored names while the store cannot be read', async ({
    page,
  }) => {
    const stub = await stubCatalogo(page, fx.contaAtivaId, 'desligado');
    await abrir(page);

    await expect(cartao(page, 8946).getByText('Tamanho (8946)')).toBeVisible();
    await expect(page.getByText(/as chamadas estão desligadas/)).toBeVisible();
    // Adding needs the store's grade list: the grade picker itself is off.
    const bloco = page.getByTestId(`vinculador-li-conta-${fx.contaAtivaId}`);
    await expect(bloco.getByLabel('Grade da loja', { exact: true }).first()).toBeDisabled();
    await expect(bloco.getByRole('button', { name: 'Adicionar vínculo' })).toBeDisabled();
    const outras = page.getByTestId('vinculador-li-outras');
    await expect(outras.getByText(/vínculo ilegível/)).toBeVisible();
    await expect(outras.getByText(/\(inativa\)/)).toBeVisible();
    expect(stub.inesperadas).toEqual([]);
  });

  test('adds a link through the store’s grade list; every other stored entry is written back byte-identical', async ({
    page,
  }) => {
    const stub = await stubCatalogo(page, fx.contaAtivaId, 'legivel');
    await abrir(page);
    const bloco = page.getByTestId(`vinculador-li-conta-${fx.contaAtivaId}`);

    // NEAR-MISS of the switch-off case: with the list read, the picker is on.
    await expect(bloco.getByLabel('Grade da loja', { exact: true }).first()).toBeEnabled();
    await bloco.getByLabel('Grade da loja', { exact: true }).first().click();
    await page.getByRole('option', { name: 'Numeração (8950)', exact: true }).click();
    await bloco.getByRole('button', { name: 'Adicionar vínculo' }).click();
    // G: no option of this store holds it yet (P and M do, on grade 8946).
    await alternarVariante(page, cartao(page, 8950), '40', 'G');
    await salvarEContinuar(page);

    await expect.poll(async () => (await linksGuardados())?.length, { timeout: 15_000 }).toBe(4);
    expect(await linksGuardados()).toEqual([
      ...fx.links,
      {
        name: 'Numeração',
        grade_id: 8950,
        integracaoLiId: fx.contaAtivaId,
        variationOptions: [{ li_option_id: 41, li_option_name: '40', arakene_variation_id: ['g'] }],
      },
    ]);
    expect(stub.inesperadas).toEqual([]);
  });

  test('refuses a save that puts one variante in two options of the same store', async ({
    page,
  }) => {
    const stub = await stubCatalogo(page, fx.contaAtivaId, 'desligado');
    await abrir(page);

    // P already holds variante P; option M gets it too.
    await alternarVariante(page, cartao(page, 8946), 'M', 'P');
    await salvarEContinuar(page);

    await expect(
      page.getByText(/Corrija os campos inválidos na aba "Loja Integrada"/),
    ).toBeVisible();
    await expect(
      cartao(page, 8946).getByText(/"P" está em mais de uma opção desta loja/),
    ).toBeVisible();
    expect(await linksGuardados()).toEqual(fx.links);
    expect(stub.inesperadas).toEqual([]);
  });

  test('renaming the grupo with an untouched half-made link saves, and leaves the links as stored', async ({
    page,
  }) => {
    const stub = await stubCatalogo(page, fx.contaAtivaId, 'desligado');
    await abrir(page);
    await page.getByRole('tab', { name: 'Dados gerais' }).click();

    await fillField(page, 'Nome', `${prefix}-Tamanhos renomeado`);
    await salvarEContinuar(page);

    await expect
      .poll(async () => (await getGrupoDeVariacoesDoc(fx.grupoId))?.nome, { timeout: 15_000 })
      .toBe(`${prefix}-Tamanhos renomeado`);
    expect(await linksGuardados()).toEqual(fx.links);
    expect(stub.inesperadas).toEqual([]);
  });

  test('a link another operator saved meanwhile is kept: the conflict merges link by link', async ({
    page,
  }) => {
    const stub = await stubCatalogo(page, fx.contaAtivaId, 'desligado');
    await abrir(page);
    // A valid edit: option G gets variante G.
    await alternarVariante(page, cartao(page, 8946), 'G', 'G');

    // Another operator saves a link of the other conta meanwhile.
    const daOutraPessoa = {
      name: 'Cor',
      grade_id: 9002,
      integracaoLiId: fx.contaInativaId,
      variationOptions: [{ li_option_id: 2, li_option_name: 'Verde', arakene_variation_id: ['m'] }],
    };
    await escreverLinksVariacoesLiConcorrente(fx.grupoId, [...fx.links, daOutraPessoa]);

    await salvarEContinuar(page);
    await expect(page.getByText('Registro alterado')).toBeVisible();
    await expect(page.getByText('mescla por vínculo')).toBeVisible();
    await page.getByRole('button', { name: 'Salvar mesmo assim' }).click();

    const [vinculo, ...resto] = fx.links;
    const editado = {
      ...vinculo,
      variationOptions: [
        { li_option_id: 37097, li_option_name: 'P', arakene_variation_id: ['p'] },
        { li_option_id: 37098, li_option_name: 'M', arakene_variation_id: ['m'] },
        { li_option_id: 37099, li_option_name: 'G', arakene_variation_id: ['g'] },
      ],
    };
    await expect
      .poll(async () => (await linksGuardados())?.[0], { timeout: 15_000 })
      .toEqual(editado);
    expect(await linksGuardados()).toEqual([editado, ...resto, daOutraPessoa]);
    expect(stub.inesperadas).toEqual([]);
  });
});
