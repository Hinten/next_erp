import { expect, test, type Page } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupProdutoSubcollection,
  e2ePrefix,
  getProdutoData,
  seedListasDePreco,
  seedProdutoComFilho,
} from './_helpers/seed-data';
import { clickSave, typeMoney } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the produto "Preço e custo" tab: price-per-lista
 * editing (Flutter `precos` map wire shape), the formula recalc engine, the
 * read-only custo-history modal and the min-price/staged-removal validation.
 * Runs serially — later tests build on the prices written by earlier ones.
 *
 * The automatic modification-history records and the parent→children precos
 * propagation are owned by the produto-write Cloud Function trigger, which
 * writes the unified `historicoDeModificacoes` subcollection the cost-history
 * modal reads. This suite does NOT assert them: the trigger IS deployed on
 * staging, so what the modal shows depends on whichever concurrent specs also
 * touched the produto, which is not a stable assertion. `produto-preco.emulator.e2e.spec.ts`
 * covers the trigger's real output deterministically instead.
 *
 * ⚠️ Never assert a whole `precos` map with a strict `toEqual` — assert
 * {@link precosDaSuite}'s projection of it instead. The map is keyed by lista
 * id, and the #544 recalcular-precos screen writes EVERY parent produto in the
 * shared catalog with no per-spec scoping. The `crud-cadastros-recalculo`
 * project's `dependencies` serializes that within ONE Playwright run, but
 * several PRs' e2e lanes hit the same staging project concurrently — so a
 * foreign run's `e2e-<otherRun>-w<N>-recalc-*` key can land on this suite's
 * produtos mid-test. That is how run 34131436615 lost two attempts of the
 * sibling `produto-alterar-preco-massa` suite on a CORRECT value, and
 * `playwright.config.ts`'s own `crud-cadastros-recalculo` comment records THIS
 * file as where the collision was first observed. Projecting to this run's own
 * lista ids keeps the assertion strict over everything this spec owns (a price
 * appearing under its own atacado lista still fails) while ignoring what it
 * provably does not control.
 */
test.describe.serial('Produtos preço/custo e2e — Preço e custo tab', () => {
  const prefix = e2ePrefix('prod-preco');
  let parentId = '';
  let childId = '';
  let varejoId = '';
  let varejoNome = '';
  let atacadoId = '';
  let atacadoNome = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const [produto, listas] = await Promise.all([
      seedProdutoComFilho(prefix),
      seedListasDePreco(prefix),
      warmRoutes(browser, ['/produtos/__aquecimento__/editar']),
    ]);
    parentId = produto.parentId;
    childId = produto.childId;
    varejoId = listas.varejoId;
    varejoNome = listas.varejoNome;
    atacadoId = listas.atacadoId;
    atacadoNome = listas.atacadoNome;
  });

  test.afterAll(async () => {
    await Promise.all([
      // Legacy subcollections nothing writes anymore — harmless no-ops today,
      // kept in case a stray write ever lands there again.
      cleanupProdutoSubcollection(parentId, 'historicoDePrecos'),
      cleanupProdutoSubcollection(parentId, 'historicoDeCusto'),
      cleanupProdutoSubcollection(childId, 'historicoDePrecos'),
      // The unified history subcollection the modal reads — empty today (no
      // deployed trigger on staging), but not once it is.
      cleanupProdutoSubcollection(parentId, 'historicoDeModificacoes'),
    ]);
    await cleanupByNamePrefix('produtos', prefix);
    await cleanupByNamePrefix('listaDePrecos', prefix);
  });

  /**
   * A produto's `precos` map narrowed to THIS run's two listas — the only
   * shape a strict `toEqual` may be run against here (see the file doc). The
   * atacado id is projected too even though no test writes under it: that
   * lista is still this suite's OWN namespace, so a price turning up there is
   * a real failure and must not be filtered away. Absent/`null` `precos`
   * projects to `{}`.
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

  async function openPrecoTab(page: Page) {
    await page.goto(`/produtos/${parentId}/editar`);
    await page.getByRole('tab', { name: 'Preço e custo' }).click();
    await expect(page.getByRole('textbox', { name: varejoNome })).toBeVisible({
      timeout: 15_000,
    });
  }

  test('writes and updates the precos map wire shape', async ({ page }) => {
    await openPrecoTab(page);
    await typeMoney(page, varejoNome, '30');
    await clickSave(page, 'Salvar alterações');

    await expect
      .poll(() => precosDaSuite(parentId), { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 30 } });

    // A later change persists too — not just the initial add. (History
    // recording is the produto-write trigger's job now — see
    // produto-preco.emulator.e2e.spec.ts.)
    await openPrecoTab(page);
    await typeMoney(page, varejoNome, '35');
    await clickSave(page, 'Salvar alterações');
    await expect
      .poll(() => precosDaSuite(parentId), { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 35 } });
  });

  test('recalculates the price from custo via the lista formulas', async ({ page }) => {
    await openPrecoTab(page);
    // Custo typed but UNSAVED must feed the recalc (live form read).
    await typeMoney(page, 'Custo', '10');

    // The formula-less lista cannot recalc; the varejo one can.
    await expect(page.getByRole('button', { name: `Recalcular ${atacadoNome}` })).toBeDisabled();
    await page.getByRole('button', { name: `Recalcular ${varejoNome}` }).click();

    // C*L+T = 10*2+5 → the input takes the computed value.
    await expect(page.getByRole('textbox', { name: varejoNome })).toHaveValue(/25/);
    await clickSave(page, 'Salvar alterações');
    await expect
      .poll(() => precosDaSuite(parentId), { timeout: 15_000 })
      .toEqual({ [varejoId]: { valor: 25 } });
  });

  test('rejects a price of 0 (min R$ 0,01) without silently dropping it', async ({ page }) => {
    await openPrecoTab(page);
    await typeMoney(page, varejoNome, '0');
    await clickSave(page, 'Salvar alterações');
    // Validation blocks the save and shows the row error — the value is NOT
    // silently dropped, and the persisted price stays at 25 (the recalc test above).
    await expect(page.getByText(/preço mínimo é R\$ 0,01/)).toBeVisible({ timeout: 10_000 });
    expect(await precosDaSuite(parentId)).toEqual({ [varejoId]: { valor: 25 } });
  });

  test('removes a price only via the trash button (staged), applied on save', async ({ page }) => {
    await openPrecoTab(page);
    await page.getByRole('button', { name: `Remover preço ${varejoNome}` }).click();
    await clickSave(page, 'Salvar alterações');
    // "No price under any of THIS run's listas" is what the staged removal
    // means here. The raw `precos: null` wire shape is NOT assertable on
    // shared staging (a foreign `-recalc-` key alone makes the field
    // non-null); `produto-revert.emulator.e2e.spec.ts` pins it on the
    // emulator lane's isolated backend instead.
    await expect.poll(() => precosDaSuite(parentId), { timeout: 15_000 }).toEqual({});
  });
});
