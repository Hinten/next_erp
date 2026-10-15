import { expect, test, type Page } from '@playwright/test';
import {
  cleanupPedidoFiltroFixtures,
  e2ePrefix,
  seedPedidoFiltroFixtures,
} from './_helpers/seed-data';
import {
  activeFilterChip,
  applySegmentedFilter,
  applySelectFilter,
  applyTextFilter,
  closeColumnFilter,
  expectRowHidden,
  expectRowVisible,
} from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * The two `/pedidos` list filters that narrow by WHO and by WHERE FROM:
 * **Canal** (`integracaoPedidoOuterRef`) and **Cliente → Anônimo**
 * (`clientePedidoOuterRef == null`).
 *
 * ⚠️ The reload cases are the reason this file exists, not a nicety. A column
 * filter round-trips through the query string, and the null filter's first
 * encoding — `String(null)` — hydrated back as the four-character STRING
 * `'null'`. That filter applied correctly on click and, after a reload or from
 * a shared link, silently matched nothing while the chip still read as active.
 * `packages/ui/src/table/isNullFilter.test.ts` pins the encoding; these prove
 * it end to end, through the real URL and a real Firestore.
 *
 * Runs serially: the tests share one seeded fixture set and each starts from a
 * clean `/pedidos`.
 *
 * ⚠️ Staging is shared, so every assertion is scoped by the run prefix first —
 * the Número filter narrows the list to this run's three pedidos before any
 * other filter is touched.
 */
test.describe.serial('Pedidos e2e — filtros da lista (Canal + Cliente anônimo)', () => {
  const prefix = e2ePrefix('filtro');
  let fixtures: Awaited<ReturnType<typeof seedPedidoFiltroFixtures>>;

  test.beforeAll(async ({ browser }) => {
    // First-load route compilation can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    fixtures = await seedPedidoFiltroFixtures(prefix);
    await warmRoutes(browser, ['/pedidos']);
  });

  test.afterAll(async () => {
    await cleanupPedidoFiltroFixtures(prefix);
  });

  /** Open `/pedidos` narrowed to this run's pedidos. */
  async function openList(page: Page) {
    await page.goto('/pedidos');
    await expect(page.getByRole('table')).toBeVisible({ timeout: 60_000 });
    await applyTextFilter(page, 'Número', prefix);
    await expectRowVisible(page, fixtures.comClienteCanalA);
  }

  test('the Canal column names the pedido channel', async ({ page }) => {
    await openList(page);
    await expect(
      page
        .getByRole('row', { name: new RegExp(fixtures.comClienteCanalB) })
        .getByText(fixtures.canalBNome, { exact: true }),
    ).toBeVisible();
  });

  test('filtering by Canal keeps only that channel, and says so in a chip', async ({ page }) => {
    await openList(page);
    await applySelectFilter(page, 'Canal', `${fixtures.canalANome} (Balcão)`);
    await closeColumnFilter(page);

    await expectRowVisible(page, fixtures.comClienteCanalA);
    await expectRowVisible(page, fixtures.anonimoCanalA);
    await expectRowHidden(page, fixtures.comClienteCanalB);
    // The chip names the CHANNEL, not the stored `documents/integracao/<id>`.
    await expect(activeFilterChip(page, `Canal: ${fixtures.canalANome}`)).toBeVisible();
  });

  test('the Canal filter survives a reload', async ({ page }) => {
    await openList(page);
    await applySelectFilter(page, 'Canal', `${fixtures.canalANome} (Balcão)`);
    await closeColumnFilter(page);
    await expectRowHidden(page, fixtures.comClienteCanalB);

    await page.reload();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 60_000 });
    await expectRowVisible(page, fixtures.comClienteCanalA);
    await expectRowHidden(page, fixtures.comClienteCanalB);
    await expect(activeFilterChip(page, `Canal: ${fixtures.canalANome}`)).toBeVisible();
  });

  test('Cliente → Anônimo keeps only the pedidos with no cliente ref', async ({ page }) => {
    await openList(page);
    await applySegmentedFilter(page, 'Cliente', 'Anônimo');
    await closeColumnFilter(page);

    await expectRowVisible(page, fixtures.anonimoCanalA);
    await expectRowHidden(page, fixtures.comClienteCanalA);
    await expectRowHidden(page, fixtures.comClienteCanalB);
    // The chip uses the same word the cell does for a null ref.
    await expect(activeFilterChip(page, 'Cliente: Anônimo')).toBeVisible();
  });

  test('the Anônimo filter survives a reload', async ({ page }) => {
    // ⚠️ THE regression test. Before the `isNull` op, the reload dropped the
    // constraint and showed every pedido back, with nothing on screen saying
    // why — the silent-widening class, from a link anyone could share.
    await openList(page);
    await applySegmentedFilter(page, 'Cliente', 'Anônimo');
    await closeColumnFilter(page);
    await expectRowHidden(page, fixtures.comClienteCanalA);

    await page.reload();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 60_000 });
    await expectRowVisible(page, fixtures.anonimoCanalA);
    await expectRowHidden(page, fixtures.comClienteCanalA);
    await expect(activeFilterChip(page, 'Cliente: Anônimo')).toBeVisible();
  });

  test('switching back to Cliente with nothing picked clears the filter', async ({ page }) => {
    await openList(page);
    await applySegmentedFilter(page, 'Cliente', 'Anônimo');
    await closeColumnFilter(page);
    await expectRowHidden(page, fixtures.comClienteCanalA);

    await applySegmentedFilter(page, 'Cliente', 'Cliente');
    await closeColumnFilter(page);
    await expectRowVisible(page, fixtures.comClienteCanalA);
    await expect(activeFilterChip(page, 'Cliente: Anônimo')).toHaveCount(0);
  });

  test('Canal and Anônimo narrow together', async ({ page }) => {
    await openList(page);
    await applySelectFilter(page, 'Canal', `${fixtures.canalANome} (Balcão)`);
    await closeColumnFilter(page);
    await applySegmentedFilter(page, 'Cliente', 'Anônimo');
    await closeColumnFilter(page);

    await expectRowVisible(page, fixtures.anonimoCanalA);
    await expectRowHidden(page, fixtures.comClienteCanalA);
    await expectRowHidden(page, fixtures.comClienteCanalB);
  });
});
