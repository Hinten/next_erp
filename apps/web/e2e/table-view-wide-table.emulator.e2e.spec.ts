import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import { COLOR_SCHEME_STORAGE_KEY } from '../lib/theme/colorScheme';
import { cleanupByNamePrefix, e2ePrefix } from './_helpers/seed-data';
import { readEmulatorAccessConfig } from './_helpers/verify-emulator-access';
import { expectListMode, searchTableView } from './helpers/table-view';
import { expectThemeReadable } from './helpers/theme-a11y';

/**
 * A TableView whose table is wider than its column, beside the docked
 * `actionsPanel` rail — the layout behind the intermittent
 * `all-pages.smoke.spec.ts` failure on /produtos.
 *
 * The table's minimum width is the sum of its columns' longest UNBREAKABLE
 * tokens, so it is set by the data, not the code. The e2e seeds write parent
 * produtos whose SKU is `${prefix.toUpperCase().replace(/-/g, '_')}_…` — `-`
 * becomes `_`, which leaves no line-break opportunity, so one ~45-character
 * token decides the SKU column's width. Whenever a concurrent staging run's row
 * was among the 50 most recently modified, the table outgrew the 932px left
 * beside the 300px rail at the smoke viewport, and its last columns painted
 * UNDER the rail: an operator could not read "Última modificação" at all, and
 * the readability audit reported it as `unreachable-glyph` plus axe
 * `bgOverlap`. Real data does the same with any long SKU or narrower window.
 *
 * Offline on purpose: this lane owns its Firestore, so the wide row is always
 * there — the staging smoke only sees it when another run happens to write one.
 */
test.describe('TableView — a table wider than its column', () => {
  const prefix = e2ePrefix('wide-table');
  const produtoId = `${prefix}-sku-longo`;
  // The seeds' own shape, made long enough to overflow on its own.
  const sku = `${prefix.toUpperCase().replace(/-/g, '_')}_SKU_SEM_PONTO_DE_QUEBRA`;
  let seeded = false;

  test.beforeAll(async () => {
    // A failed emulator precondition must stop before any Admin write.
    expect(process.env.FIREBASE_PROJECT_ID).toBe('demo-erp');
    readEmulatorAccessConfig();
    await db().collection('produtos').doc(produtoId).set({
      ultimaModificacao: Date.now(),
      nome: produtoId,
      sku,
      paiId: null,
      ordem: null,
      publicado: true,
      ehKit: false,
      ehKitVirtual: false,
      ofereceFreteGratis: false,
      permiteVendaSemEstoque: false,
      fotos: null,
      videos: null,
      timestamp: new Date().toISOString(),
    });
    seeded = true;
  });

  test.afterAll(async () => {
    if (seeded) await cleanupByNamePrefix('produtos', prefix);
  });

  test('scrolls inside its column instead of passing under the docked actions rail', async ({
    page,
  }, testInfo) => {
    // The `smoke` project's viewport (Desktop Chrome), stated rather than
    // inherited: the overlap is a function of the room beside the rail.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.addInitScript((key) => localStorage.setItem(key, 'light'), COLOR_SCHEME_STORAGE_KEY);
    await page.goto('/produtos');
    // The term is the seeded document id: the list resolves it to that one row.
    await searchTableView(page, produtoId);
    await expectListMode(page, 'static', 'ids');
    const table = page.getByRole('main').getByRole('table');
    await expect(table.getByRole('row')).toHaveCount(2, { timeout: 15_000 });
    const row = table.getByRole('row').filter({ hasText: sku });
    await expect(row).toHaveCount(1);

    const rail = page.getByRole('complementary', { name: 'Ações', exact: true });
    await expect(rail.getByRole('button', { name: 'Recolher ações', exact: true })).toBeVisible();
    // Without this the test could pass vacuously: if the fixture stops
    // outgrowing the column (a shorter token, a wider viewport), nothing below
    // exercises the overflow at all.
    const [tableBox, railBox] = await Promise.all([table.boundingBox(), rail.boundingBox()]);
    expect(tableBox, 'table box').not.toBeNull();
    expect(railBox, 'rail box').not.toBeNull();
    expect(
      tableBox!.width,
      'the fixture must make the table wider than the room beside the expanded rail',
    ).toBeGreaterThan(railBox!.x - tableBox!.x);

    // The text the smoke failure named: the last header and its cells. Each is
    // brought into view and hit-tested, and axe then checks every other text
    // node on the page — a cell anywhere under the rail is a finding.
    await expectThemeReadable(page, testInfo, {
      scheme: 'light',
      required: [
        table.getByRole('columnheader').last().getByText('Última modificação', { exact: true }),
        row.getByRole('cell', { name: sku, exact: true }),
        row.getByRole('cell').last(),
      ],
    });
  });
});
