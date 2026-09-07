import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  e2ePrefix,
  getProdutoData,
  seedComponenteKit,
  seedListasDePreco,
  seedProdutoComFilho,
  setProdutoFields,
} from './_helpers/seed-data';
import { selectField, selectFieldWithSearch } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for `/produtos/alterar-precos` (#545 manual bulk price
 * editor). Unlike the sibling #544 recalculation screen, this one only ever
 * writes the produtos the user explicitly selects — no whole-catalog scan —
 * so it lives in the plain `crud-cadastros` project (no `dependencies` dance)
 * as long as every selection is made through the "Buscar" filter scoped to
 * this suite's own run-prefixed produtos. `historicoDePrecos`/parent→children
 * propagation (the `onProdutoPrecoCustoChanged` trigger) are NOT asserted
 * here — the trigger IS deployed on staging, but its effects land
 * asynchronously and this suite proves only the parent `precos` write + the
 * screen's own UI/CSV behavior. The trigger itself is covered deterministically
 * by `produto-preco.emulator.e2e.spec.ts`.
 *
 * Four behaviors worth flagging for reviewers, since they shape the tests
 * below:
 *
 *  - Every COMPLETED apply run (any outcome mix, even all-`pulado`) resets the
 *    page's produto selection (`AplicarDialog`'s `onApplied` callback). Any
 *    test that applies twice must re-open the picker and re-select between
 *    runs — the regra/target-lista/direction-toggle state is unaffected and
 *    persists.
 *  - `Valor Fixo` computes the SAME target price for every selected produto,
 *    so a violated bound (`novoPreco` outside `[valorMinimo, valorMaximo]`)
 *    puts EVERY selected row out of bounds at once — `candidateRows` is empty
 *    and the confirm dialog's own "Aplicar" button is correctly disabled
 *    (never reaches "Alteração de preços concluída"). The bounds test below
 *    asserts the pre-apply preview badge + the confirm dialog's inline
 *    ignored-count note instead of a post-apply summary.
 *  - ⚠️ Every test seeds its OWN `precos`/`custo` preconditions — `beforeEach`
 *    restores the four fixtures to {@link seedPrecosBaseline}'s state and a
 *    test needing something else (only the "Baixar preços" one, which must
 *    start from a price ABOVE its target) overwrites it in its own body. No
 *    test inherits a price another test wrote, so each one passes on a cold
 *    run and under a `-g` single-test invocation. `describe.serial` stays
 *    regardless: the four produtos are SHARED, and `fullyParallel: true` would
 *    otherwise let two tests' `beforeEach` resets stomp each other's run.
 *  - ⚠️ Never assert a whole `precos` map with a strict `toEqual` — assert
 *    {@link precosDaSuite}'s projection of it instead. The `precos` map is
 *    keyed by lista id and the #544 recalcular-precos screen writes EVERY
 *    parent produto in the shared catalog with no per-spec scoping. The
 *    `crud-cadastros-recalculo` project's `dependencies` serializes that
 *    within ONE Playwright run, but three PRs' e2e lanes hit the same staging
 *    project concurrently — so a foreign run's `e2e-<otherRun>-w8-recalc-*`
 *    key can land on this suite's produtos mid-test, which is precisely how
 *    run 34131436615 lost two attempts of the "Baixar preços" test on a
 *    correct `valor: 50`. Projecting to this run's own lista ids keeps the
 *    assertion strict over everything this spec owns (a clobbered `atacado`
 *    entry still fails) while ignoring what it provably does not.
 */
test.describe.serial('Alterar preço em massa e2e (#545)', () => {
  const prefix = e2ePrefix('altpreco');

  let varejoId = '';
  let varejoNome = '';
  let atacadoId = '';
  let aId = '';
  let aNome = '';
  let bId = '';
  let bNome = '';
  let cId = '';
  let cNome = '';
  let dId = '';
  let dNome = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);

    const listas = await seedListasDePreco(prefix);
    varejoId = listas.varejoId;
    varejoNome = listas.varejoNome;
    atacadoId = listas.atacadoId;

    const [produtoComFilho, b, c, d] = await Promise.all([
      // A: parent + variation child (child never selectable — the picker only
      // ever lists `paiId == null` parents; propagation onto it is
      // server-owned and not asserted here).
      seedProdutoComFilho(prefix),
      // These `custo` arguments are placeholders: `seedPrecosBaseline` below
      // re-stamps `custo` AND `precos` on all four before every test, and IT
      // is the authority on what each fixture is for.
      seedComponenteKit(prefix, 0, 'b'),
      seedComponenteKit(prefix, 5, 'c'),
      seedComponenteKit(prefix, 7, 'd'),
    ]);
    aId = produtoComFilho.parentId;
    aNome = produtoComFilho.parentNome;
    bId = b.id;
    bNome = b.nome;
    cId = c.id;
    cNome = c.nome;
    dId = d.id;
    dNome = d.nome;

    await warmRoutes(browser, ['/produtos/alterar-precos']);
  });

  /**
   * The `precos`/`custo` state every test below starts from:
   *
   *  - A — custo 10, a varejo price of 20 (the only fixture that starts with
   *    one, so the preview can show a real atual→novo pair).
   *  - B — custo NULL, no prices at all: the `detalhado` "Custo do produto não
   *    encontrado" fixture, and the "a produto with no price under the target
   *    lista always passes the direction gate" fixture.
   *  - C — custo 5, an ATACADO price only: proves the apply merges into
   *    `precos` rather than replacing it.
   *  - D — custo 7, an atacado price only, and never selected except by the
   *    `precoAtual` "sem preço cadastrado" assertion, which needs a produto
   *    that still lacks a varejo price AFTER that test's own apply has given
   *    A and C one.
   *
   * Written with `update({ precos })` (a whole-field replace, not a merge), so
   * a foreign `…-recalc-…` key left on a fixture by a concurrent run is
   * cleared at the start of every test rather than accumulating.
   */
  async function seedPrecosBaseline(): Promise<void> {
    await Promise.all([
      setProdutoFields(aId, { custo: 10, precos: { [varejoId]: { valor: 20 } } }),
      setProdutoFields(bId, { custo: null, precos: null }),
      setProdutoFields(cId, { custo: 5, precos: { [atacadoId]: { valor: 15 } } }),
      setProdutoFields(dId, { custo: 7, precos: { [atacadoId]: { valor: 99 } } }),
    ]);
  }

  /**
   * A produto's `precos` map narrowed to THIS run's two listas — the only
   * shape a strict `toEqual` may be run against here. See the file doc's last
   * bullet: the map is a shared namespace the #544 screen writes into from
   * other CI runs, so a whole-map equality asserts something this suite does
   * not control. Absent/`null` `precos` projects to `{}`.
   */
  async function precosDaSuite(produtoId: string): Promise<Record<string, unknown>> {
    const precos = (await getProdutoData(produtoId))?.precos as
      | Record<string, unknown>
      | null
      | undefined;
    const projecao: Record<string, unknown> = {};
    for (const listaId of [varejoId, atacadoId]) {
      if (precos && listaId in precos) projecao[listaId] = precos[listaId];
    }
    return projecao;
  }

  test.beforeEach(async () => {
    await seedPrecosBaseline();
  });

  test.afterAll(async () => {
    await Promise.all([
      cleanupByNamePrefix('produtos', prefix),
      cleanupByNamePrefix('listaDePrecos', prefix),
    ]);
  });

  test('picks produtos via the search filter and dedups on re-include', async ({ page }) => {
    await page.goto('/produtos/alterar-precos');
    await expect(page.getByRole('heading', { name: 'Alterar Preço em Massa' })).toBeVisible();

    await includeProdutos(page, prefix, [aNome, bNome, cNome]);
    await expect(page.getByText('Total de Produtos: 3', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // Re-including an already-selected produto is a no-op (insertion-ordered
    // Map dedup on produtoId) — the count stays at 3.
    await includeProdutos(page, prefix, [aNome]);
    await expect(page.getByText('Total de Produtos: 3', { exact: true })).toBeVisible();
  });

  test('applies "Valor Fixo" to the target lista, writing produtos with no prior price too', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/produtos/alterar-precos');
    await selectFieldWithSearch(page, 'Lista de preços', varejoNome);
    await includeProdutos(page, prefix, [aNome, bNome, cNome]);
    await expect(page.getByText('Total de Produtos: 3', { exact: true })).toBeVisible();

    await selectField(page, 'Regra', 'Valor Fixo');
    await page.getByLabel('Novo Preço', { exact: true }).fill('50');

    // A already carries a varejo price (20) — the preview shows the pair.
    const aRow = previewRowLocator(page, aNome);
    await expect(aRow).toContainText(/R\$\s*20,00/, { timeout: 10_000 });
    await expect(aRow).toContainText(/R\$\s*50,00/, { timeout: 10_000 });

    await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Aplicar alteração de preços' });
    await dialog.getByRole('button', { name: 'Aplicar', exact: true }).click();
    await expect(dialog.getByText('Alteração de preços concluída', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();

    await expect
      .poll(() => precosDaSuite(aId), { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 50 } });
    // B had no price anywhere — the direction gate always passes when there's
    // nothing to compare against.
    await expect
      .poll(() => precosDaSuite(bId), { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 50 } });
    // C's existing atacado price must survive the merge — only varejo is added.
    await expect
      .poll(() => precosDaSuite(cId), { timeout: 15_000 })
      .toEqual({ [atacadoId]: { valor: 15 }, [varejoId]: { valor: 50 } });
  });

  test('gates a lower price on "Baixar preços"', async ({ page }) => {
    test.setTimeout(90_000);

    // This test's own precondition (NOT inherited from the test above): all
    // three must already carry a varejo price STRICTLY ABOVE the 10 applied
    // below. `applyPrecoAlteracoes` classifies `novo === precoAtual` as
    // 'semAlteracao' before the gate ever runs, so a produto sitting at 10
    // would silently never exercise the direction gate this test is about —
    // and the `3 pulado(s)` assertion would read 0. 50 is the same value the
    // "Valor Fixo" test happens to write, chosen here for the same reason it
    // was chosen there: far enough from 10 that the preview's atual→novo pair
    // is unambiguous.
    await Promise.all([
      setProdutoFields(aId, { precos: { [varejoId]: { valor: 50 } } }),
      setProdutoFields(bId, { precos: { [varejoId]: { valor: 50 } } }),
      setProdutoFields(cId, {
        precos: { [atacadoId]: { valor: 15 }, [varejoId]: { valor: 50 } },
      }),
    ]);

    await page.goto('/produtos/alterar-precos');
    await selectFieldWithSearch(page, 'Lista de preços', varejoNome);
    await includeProdutos(page, prefix, [aNome, bNome, cNome]);

    await selectField(page, 'Regra', 'Valor Fixo');
    await page.getByLabel('Novo Preço', { exact: true }).fill('10');

    // All three sit at 50 (seeded above) — lowering to 10 needs "Baixar
    // preços" (off by default: aumentar=true, baixar=false).
    const aRow = previewRowLocator(page, aNome);
    await expect(aRow).toContainText(/R\$\s*50,00/, { timeout: 10_000 });
    await expect(aRow).toContainText(/R\$\s*10,00/, { timeout: 10_000 });

    await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Aplicar alteração de preços' });
    await dialog.getByRole('button', { name: 'Aplicar', exact: true }).click();
    await expect(dialog.getByText('Alteração de preços concluída', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(dialog.getByText('3 pulado(s)', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();

    await expect
      .poll(() => precosDaSuite(aId), { timeout: 10_000 })
      .toEqual({ [varejoId]: { valor: 50 } });

    // The completed run above reset the page's selection — re-pick, enable
    // "Baixar preços" (regra/target lista persist untouched), and retry.
    await page.getByRole('checkbox', { name: 'Baixar preços', exact: true }).check();
    await includeProdutos(page, prefix, [aNome, bNome, cNome]);

    await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Aplicar alteração de preços' });
    await dialog.getByRole('button', { name: 'Aplicar', exact: true }).click();
    await expect(dialog.getByText('Alteração de preços concluída', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();

    await expect
      .poll(() => precosDaSuite(aId), { timeout: 10_000 })
      .toEqual({ [varejoId]: { valor: 10 } });
  });

  test('surfaces per-strategy calc errors, excluded from the write', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/produtos/alterar-precos');
    await selectFieldWithSearch(page, 'Lista de preços', varejoNome);
    await includeProdutos(page, prefix, [aNome, bNome, cNome]);
    // Regra defaults to 'Cálculo Detalhado' on a fresh mount — no need to pick it.

    const bRow = previewRowLocator(page, bNome);
    await expect(bRow).toContainText('Custo do produto não encontrado', { timeout: 10_000 });

    const bPrecosBefore = await precosDaSuite(bId);

    await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Aplicar alteração de preços' });
    await dialog.getByRole('button', { name: 'Aplicar', exact: true }).click();
    await expect(dialog.getByText('Alteração de preços concluída', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    // B (custo nulo) never reaches the write step — only a calc-time erro.
    await expect(dialog.getByText('1 erro(s)', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();

    expect(await precosDaSuite(bId)).toEqual(bPrecosBefore);

    // 'Com base no preço atual' errors on a produto with NO price yet under
    // the target lista. A and C both just gained one from the apply above
    // (custo 10 → 132, custo 5 → 84 under the detalhado defaults), so the
    // untouched 4th fixture (D — baseline atacado price only, never selected
    // until now) is what carries this assertion.
    await includeProdutos(page, prefix, [dNome]);
    await selectField(page, 'Regra', 'Com base no preço atual');

    const dRow = previewRowLocator(page, dNome);
    await expect(dRow).toContainText('Este produto não possui preço cadastrado na tabela', {
      timeout: 10_000,
    });
  });

  test('bounds a computed price out of range and blocks the write', async ({ page }) => {
    await page.goto('/produtos/alterar-precos');
    await selectFieldWithSearch(page, 'Lista de preços', varejoNome);
    await includeProdutos(page, prefix, [aNome, bNome, cNome]);

    await selectField(page, 'Regra', 'Valor Fixo');
    await page.getByLabel('Novo Preço', { exact: true }).fill('50');
    await page.getByLabel('Valor Máximo', { exact: true }).fill('40');

    // 'Valor Fixo' computes the SAME 50 for every row, so all three land out
    // of bounds together — the preview's own summary badge is the "apply
    // summary" here, since the confirm dialog can never reach a write with
    // zero candidates (see the file doc).
    await expect(page.getByText('3 fora dos limites', { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    const aRow = previewRowLocator(page, aNome);
    await expect(aRow).toContainText('Fora dos limites', { timeout: 10_000 });

    const before = await Promise.all([aId, bId, cId].map((id) => precosDaSuite(id)));

    await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Aplicar alteração de preços' });
    await expect(dialog.getByText('Aplicar alteração de preços em 0 produtos?')).toBeVisible();
    await expect(dialog.getByText(/3 produto\(s\) serão ignorados/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Aplicar', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();

    const after = await Promise.all([aId, bId, cId].map((id) => precosDaSuite(id)));
    expect(after).toEqual(before);
  });

  test('downloads the pre-apply CSV report with the legacy filename pattern', async ({ page }) => {
    await page.goto('/produtos/alterar-precos');
    await selectFieldWithSearch(page, 'Lista de preços', varejoNome);
    await includeProdutos(page, prefix, [aNome]);
    await selectField(page, 'Regra', 'Valor Fixo');
    await page.getByLabel('Novo Preço', { exact: true }).fill('1');

    const baixarRelatorio = page.getByRole('button', { name: 'Baixar Relatório', exact: true });
    await expect(baixarRelatorio).toBeEnabled({ timeout: 10_000 });
    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
    await baixarRelatorio.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(
      new RegExp(`^${varejoNome}_\\d{1,4}_\\d{1,2}_\\d{1,2}_\\d{1,2}_\\d{1,2}_\\d{1,2}\\.csv$`),
    );
  });
});

/**
 * Open "Adicionar produtos", search by the run-scoped `prefix`, check each
 * `nomes` row and include them, then close the modal. `ProdutoPickerModal`
 * stays open after "Incluir selecionados" by design — this helper always
 * closes it afterwards (via Escape) for a uniform call shape; re-opening on
 * the next call re-runs the search fresh, which is harmless since selection
 * dedup lives on the PARENT's Map, not the modal's own local state.
 */
async function includeProdutos(page: Page, prefix: string, nomes: string[]): Promise<void> {
  await page.getByRole('button', { name: 'Adicionar produtos', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Adicionar produtos' });
  await dialog.getByLabel('Buscar', { exact: true }).fill(prefix);
  for (const nome of nomes) {
    await dialog.getByRole('checkbox', { name: `Selecionar ${nome}`, exact: true }).check();
  }
  await dialog.getByRole('button', { name: 'Incluir selecionados', exact: true }).click();
  await page.keyboard.press('Escape');
}

/**
 * The preview row's container for a given produto `nome` — resolved via the
 * row's own "Remover {nome}" trash button (a stable, per-row unique
 * accessible name) rather than parsing rendered price text, then walking up
 * to its immediate parent (the row's positioned `<div>`, which also holds the
 * atual→novo price pair and the "(sku) nome" line). Returned as a `Locator`
 * (not a resolved string) so callers can use Playwright's auto-retrying
 * `toContainText` — the preview recomputes on a `useDeferredValue` a tick or
 * two after a regra field changes.
 */
function previewRowLocator(page: Page, nome: string): Locator {
  return page.getByRole('button', { name: `Remover ${nome}`, exact: true }).locator('xpath=..');
}
