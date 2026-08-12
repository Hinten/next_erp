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
 * Three behaviors worth flagging for reviewers, since they shape the test
 * order below:
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
 *  - Tests 2–3 write a `varejo` price onto every seeded produto (A/B/C), so by
 *    test 4 none of them still lacks one — the wrong precondition for
 *    exercising `precoAtual`'s "sem preço cadastrado" error. A 4th, untouched
 *    fixture (D) is seeded up front and stays unselected until that one
 *    assertion, exactly as the module notes license ("use fresh produtos if
 *    state juggling gets fragile").
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
      seedComponenteKit(prefix, 0, 'b'), // custo forced to null below
      seedComponenteKit(prefix, 5, 'c'),
      seedComponenteKit(prefix, 7, 'd'), // untouched fixture — see file doc
    ]);
    aId = produtoComFilho.parentId;
    aNome = produtoComFilho.parentNome;
    bId = b.id;
    bNome = b.nome;
    cId = c.id;
    cNome = c.nome;
    dId = d.id;
    dNome = d.nome;

    await Promise.all([
      setProdutoFields(aId, { custo: 10, precos: { [varejoId]: { valor: 20 } } }),
      setProdutoFields(bId, { custo: null }),
      setProdutoFields(cId, { precos: { [atacadoId]: { valor: 15 } } }),
      setProdutoFields(dId, { precos: { [atacadoId]: { valor: 99 } } }),
      warmRoutes(browser, ['/produtos/alterar-precos']),
    ]);
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
      .poll(async () => (await getProdutoData(aId))?.precos, { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 50 } });
    // B had no price anywhere — the direction gate always passes when there's
    // nothing to compare against.
    await expect
      .poll(async () => (await getProdutoData(bId))?.precos, { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 50 } });
    // C's existing atacado price must survive the merge — only varejo is added.
    await expect
      .poll(async () => (await getProdutoData(cId))?.precos, { timeout: 15_000 })
      .toEqual({ [atacadoId]: { valor: 15 }, [varejoId]: { valor: 50 } });
  });

  test('gates a lower price on "Baixar preços"', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/produtos/alterar-precos');
    await selectFieldWithSearch(page, 'Lista de preços', varejoNome);
    await includeProdutos(page, prefix, [aNome, bNome, cNome]);

    await selectField(page, 'Regra', 'Valor Fixo');
    await page.getByLabel('Novo Preço', { exact: true }).fill('10');

    // All three currently sit at 50 (previous test) — lowering to 10 needs
    // "Baixar preços" (off by default: aumentar=true, baixar=false).
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
      .poll(async () => (await getProdutoData(aId))?.precos, { timeout: 10_000 })
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
      .poll(async () => (await getProdutoData(aId))?.precos, { timeout: 10_000 })
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

    const bPrecosBefore = (await getProdutoData(bId))?.precos;

    await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Aplicar alteração de preços' });
    await dialog.getByRole('button', { name: 'Aplicar', exact: true }).click();
    await expect(dialog.getByText('Alteração de preços concluída', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    // B (custo nulo) never reaches the write step — only a calc-time erro.
    await expect(dialog.getByText('1 erro(s)', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();

    expect((await getProdutoData(bId))?.precos).toEqual(bPrecosBefore);

    // 'Com base no preço atual' errors on a produto with NO price yet under
    // the target lista — A/B/C all gained one above, so a fresh, untouched
    // produto (D, seeded with only an atacado price) is used instead.
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

    const before = await Promise.all(
      [aId, bId, cId].map(async (id) => (await getProdutoData(id))?.precos),
    );

    await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Aplicar alteração de preços' });
    await expect(dialog.getByText('Aplicar alteração de preços em 0 produtos?')).toBeVisible();
    await expect(dialog.getByText(/3 produto\(s\) serão ignorados/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Aplicar', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();

    const after = await Promise.all(
      [aId, bId, cId].map(async (id) => (await getProdutoData(id))?.precos),
    );
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
