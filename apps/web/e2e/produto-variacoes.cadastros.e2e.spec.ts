import { expect, test, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  docExistsByName,
  e2ePrefix,
  getProdutoData,
  getProdutoEstoque,
  getProdutoIdBySku,
  seedDepositoAtivo,
  seedEstoqueDoc,
  seedGruposDeVariacao,
} from './_helpers/seed-data';
import { clickSave, fillField } from './helpers/object-view';
import { searchTableView } from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the product Variações tab: seed two variation
 * groups, create a parent produto, select groups + variants, generate the
 * Cartesian children, save the first conversion atomically and staged-delete
 * one child. Guards the VariationManager and the Firestore wire shapes.
 */
test.describe.serial('Produtos variações e2e — Variações tab', () => {
  const prefix = e2ePrefix('prod-var');
  const nome = `${prefix}-001`;
  const sku = prefix.toUpperCase().replace(/-/g, '_');
  let originalMemberId: string | undefined;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    await Promise.all([
      seedGruposDeVariacao(prefix),
      warmRoutes(browser, ['/produtos/novo', '/produtos/__aquecimento__/editar']),
    ]);
  });

  test.afterAll(async () => {
    if (originalMemberId) await cleanupProdutoSubcollection(originalMemberId, 'estoques');
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupByNamePrefix('grupoDeVariacoes', prefix);
    await cleanupByNamePrefix('depositos', prefix);
  });

  /**
   * Select an option inside a Mantine MultiSelect identified by its label.
   * Scoped to the combobox role — the input renders `role="combobox"`
   * (confirmed in a production trace), and a bare getByLabel can also match
   * the open dropdown listbox (same accessible name → strict-mode violation).
   */
  async function pickOption(page: Page, selectLabel: string | RegExp, option: string | RegExp) {
    await page.getByRole('combobox', { name: selectLabel }).click();
    await page.getByRole('option', { name: option }).click();
    await page.keyboard.press('Escape'); // close the dropdown overlay
  }

  /** True once some <input> on the page holds exactly `value` (controlled inputs). */
  function hasInputValue(page: Page, value: string): Promise<boolean> {
    return page
      .locator('input')
      .evaluateAll((els, v) => els.some((e) => (e as HTMLInputElement).value === v), value);
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

  test('reuses the simple product’s sellable record when generating and rebuilding variants', async ({
    page,
  }) => {
    const originalSku = `SHOPEE-${sku}`;
    await page.goto('/produtos/novo');
    await fillField(page, 'Nome', nome);
    await fillField(page, 'SKU', originalSku);
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

    // Create-default parity: a fresh produto persists as a DRAFT
    // (`publicado=false`), matching the Flutter constructor (`models.dart:1333`).
    expect((await getProdutoData(id))?.publicado).toBe(false);
    const member = (await getProdutoData(id))?.filhoUnicoId;
    expect(typeof member).toBe('string');
    if (typeof member !== 'string')
      throw new Error('Expected the simple product’s sellable record');
    originalMemberId = member;
    expect((await getProdutoData(member))?.sku).toBe(`${originalSku}-UN`);
    const deposito = await seedDepositoAtivo(prefix);
    await seedEstoqueDoc(member, deposito.id, 12, 2);

    await page.goto(`/produtos/${member}/editar`);
    await page.waitForURL(`**/produtos/${id}/editar`);
    // Type the SKU in the editor but do NOT save yet — Gerar must pick it up
    // from the live form values.
    await fillField(page, 'SKU', sku);
    await page.getByRole('tab', { name: 'Dimensões e peso' }).click();
    await fillField(page, 'Altura (cm)', '14');
    await page.getByRole('tab', { name: 'Variações' }).click();
    await expect(page.getByRole('button', { name: 'Reconstituir variações' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Nova variante' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remover variação' })).toHaveCount(0);

    // Select the Tamanhos group, then two of its variants.
    await pickOption(page, 'Grupos de variação', `${prefix}-Tamanhos`);
    await expect(page.getByRole('combobox', { name: `${prefix}-Tamanhos` })).toBeVisible({
      timeout: 15_000,
    });
    await pickOption(page, `${prefix}-Tamanhos`, 'P (P)');
    await pickOption(page, `${prefix}-Tamanhos`, 'M (M)');

    await page.getByRole('button', { name: 'Gerar variações' }).click();
    // Two staged children appear with the generated nome/sku.
    await expect.poll(() => hasInputValue(page, `${nome} P`)).toBe(true);
    await expect.poll(() => hasInputValue(page, `${nome} M`)).toBe(true);
    await expect.poll(() => hasInputValue(page, `${sku}P`)).toBe(true);
    await page.getByRole('button', { name: 'Reconstituir variações' }).click();
    await expect(page.getByText('Variações reconstituídas — salve para gravar.')).toBeVisible();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Variação que receberá o estoque' }),
    ).toContainText(`${nome} P`);
    await expect(page.getByRole('textbox', { name: 'SKU' })).toHaveCount(2);

    await clickSave(page, 'Salvar alterações');
    await expect
      .poll(() => docExistsByName('produtos', `${nome} P`), { timeout: 15_000 })
      .toBe(true);
    await expect
      .poll(() => docExistsByName('produtos', `${nome} M`), { timeout: 15_000 })
      .toBe(true);
    expect(await getProdutoIdBySku(`${sku}P`)).toBe(member);
    expect((await getProdutoData(id))?.filhoUnicoId).toBeNull();
    expect((await getProdutoData(member))?.alturaCm).toBe(14);
    expect(await getProdutoEstoque(member, deposito.id)).toMatchObject({
      quantidade: 12,
      quantidadeReservada: 2,
    });

    await page.goto(`/produtos/${member}/editar`);
    await expect(page.getByRole('link', { name: 'Abrir produto pai' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Excluir', exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'SKU', exact: true })).toHaveValue(`${sku}P`);

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
    // The parent's id isn't carried across tests — find it again through the
    // produtos list search (exact-name link, so children don't match).
    await page.goto('/produtos');
    await searchTableView(page, nome);
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
