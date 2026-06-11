import { expect, test, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  docExistsByName,
  e2ePrefix,
  seedGruposDeVariacao,
} from './_helpers/seed-data';
import { clickSave, fillField } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the product Variações tab: seed two variation
 * groups, create a parent produto, select groups + variants, generate the
 * Cartesian children, save (children flush in one batch after the parent
 * save) and staged-delete one child. Guards the `VariationManager` +
 * `deriveOnSave`/`onAfterSave` wiring and the Flutter wire shapes.
 */
test.describe.serial('Produtos variações e2e — Variações tab', () => {
  const prefix = e2ePrefix('prod-var');
  const nome = `${prefix}-001`;
  const sku = prefix.toUpperCase().replace(/-/g, '_');

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    await Promise.all([
      seedGruposDeVariacao(prefix),
      warmRoutes(browser, ['/produtos/novo', '/produtos/__aquecimento__/editar']),
    ]);
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupByNamePrefix('grupoDeVariacoes', prefix);
  });

  /** Select an option inside a Mantine MultiSelect identified by its label. */
  async function pickOption(page: Page, selectLabel: string | RegExp, option: string | RegExp) {
    await page.getByLabel(selectLabel).click();
    await page.getByRole('option', { name: option }).click();
    await page.keyboard.press('Escape'); // close the dropdown overlay
  }

  /** True once some <input> on the page holds exactly `value` (controlled inputs). */
  function hasInputValue(page: Page, value: string): Promise<boolean> {
    return page
      .locator('input')
      .evaluateAll(
        (els, v) => els.some((e) => (e as HTMLInputElement).value === v),
        value,
      );
  }

  test('shows the "save first" message on the Variações tab of the create screen', async ({
    page,
  }) => {
    await page.goto('/produtos/novo');
    await expect(page.getByRole('heading', { name: 'Novo produto' })).toBeVisible();
    await page.getByRole('tab', { name: 'Variações' }).click();
    await expect(page.getByText('Salve o produto para poder gerar variações.')).toBeVisible({
      timeout: 15_000,
    });
  });

  test('generates Cartesian children and persists them on save', async ({ page }) => {
    // Create the parent (nome + SKU — both are read by Gerar).
    await page.goto('/produtos/novo');
    await fillField(page, 'Nome', nome);
    await fillField(page, 'SKU', sku);
    await clickSave(page, 'Criar');
    // Lands on the produto route (detail today, editor once the direct-editor
    // PR merges) — extract the id and open the editor explicitly.
    await page.waitForURL(
      (url) =>
        /^\/produtos\/[^/]+(\/editar)?$/.test(url.pathname) && url.pathname !== '/produtos/novo',
      { timeout: 15_000 },
    );
    await expect.poll(() => docExistsByName('produtos', nome), { timeout: 15_000 }).toBe(true);
    const id = new URL(page.url()).pathname.split('/')[2]!;

    await page.goto(`/produtos/${id}/editar`);
    await page.getByRole('tab', { name: 'Variações' }).click();

    // Select the Tamanhos group, then two of its variants.
    await pickOption(page, 'Grupos de variação', `${prefix}-Tamanhos`);
    await expect(page.getByLabel(`${prefix}-Tamanhos`)).toBeVisible({ timeout: 15_000 });
    await pickOption(page, `${prefix}-Tamanhos`, 'P (P)');
    await pickOption(page, `${prefix}-Tamanhos`, 'M (M)');

    await page.getByRole('button', { name: 'Gerar variações' }).click();
    // Two staged children appear with the generated nome/sku.
    await expect.poll(() => hasInputValue(page, `${nome} P`)).toBe(true);
    await expect.poll(() => hasInputValue(page, `${nome} M`)).toBe(true);
    await expect.poll(() => hasInputValue(page, `${sku}P`)).toBe(true);

    await clickSave(page, 'Salvar alterações');
    await expect
      .poll(() => docExistsByName('produtos', `${nome} P`), { timeout: 15_000 })
      .toBe(true);
    await expect
      .poll(() => docExistsByName('produtos', `${nome} M`), { timeout: 15_000 })
      .toBe(true);

    // Re-generating must dedupe (same combos already exist).
    await page.goto(`/produtos/${id}/editar`);
    await page.getByRole('tab', { name: 'Variações' }).click();
    await expect.poll(() => hasInputValue(page, `${nome} P`), { timeout: 15_000 }).toBe(true);
    await page.getByRole('button', { name: 'Gerar variações' }).click();
    await expect(page.getByText('Todas as combinações já existem.')).toBeVisible();
  });

  test('staged-deletes a child and applies it on save', async ({ page }) => {
    await expect
      .poll(() => docExistsByName('produtos', `${nome} P`), { timeout: 15_000 })
      .toBe(true);
    // Open the parent through the list URL captured in the previous test is
    // not available across tests — find it via the editor of any child? The
    // parent doc id is stable: navigate via the produtos list search instead.
    await page.goto('/produtos');
    await page.getByPlaceholder('Buscar por nome…').fill(nome);
    await page.getByRole('link', { name: nome, exact: true }).click();
    await page.waitForURL(/\/produtos\/[^/]+(\/editar)?$/, { timeout: 15_000 });
    const id = new URL(page.url()).pathname.split('/')[2]!;
    await page.goto(`/produtos/${id}/editar`);

    await page.getByRole('tab', { name: 'Variações' }).click();
    await expect.poll(() => hasInputValue(page, `${nome} P`), { timeout: 15_000 }).toBe(true);

    // Mark the first child for deletion — it stays visible with an undo.
    await page.getByRole('button', { name: 'Remover variação' }).first().click();
    await expect(page.getByText('Será excluída')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Desfazer exclusão' })).toBeVisible();

    await clickSave(page, 'Salvar alterações');
    await expect
      .poll(() => docExistsByName('produtos', `${nome} P`), { timeout: 15_000 })
      .toBe(false);
    await expect.poll(() => docExistsByName('produtos', `${nome} M`)).toBe(true);
  });
});
