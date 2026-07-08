import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import {
  cleanupPedidoImpressaoFixtures,
  e2ePrefix,
  seedPedidoImpressaoFixtures,
} from './_helpers/seed-data';
import { applyTextFilter, expectRowVisible, selectRowByText } from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the pedido print flow shipped in #319 (issue #342).
 * The feature is already well covered by unit + RTL component tests
 * (`lib/pedido-print/*`, `_components/print/*`); this is the belt-and-suspenders
 * pass that proves the two entry points work against the real UI + Firestore:
 *
 *  - Orçamento (footer share menu): open a saved pedido, use the share icon to
 *    download the orçamento as a JPEG image and as a PDF — assert a file
 *    download fires for each.
 *  - Comum (warehouse batch print): select a pedido on `/pedidos`, open the
 *    "Imprimir" dialog and, with `window.print` stubbed, prove the printed
 *    pedido is marked `foiImpresso` + `dtImpressao`.
 *  - Already-printed guard: selecting an already-printed pedido shows the
 *    "reprint?" confirm step before building.
 *
 * Runs serially — the tests share one seeded fixture set (a not-yet-printed and
 * an already-printed pedido); each test targets a disjoint pedido so ordering
 * never couples them.
 */
test.describe.serial('Pedidos e2e — impressão (orçamento + comum)', () => {
  const prefix = e2ePrefix('imp');
  let fixtures: Awaited<ReturnType<typeof seedPedidoImpressaoFixtures>>;

  test.beforeAll(async ({ browser }) => {
    // First-load route compilation can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    fixtures = await seedPedidoImpressaoFixtures(prefix);
    await warmRoutes(browser, ['/pedidos', `/pedidos/${fixtures.naoImpressoId}/editar`]);
  });

  test.afterAll(async () => {
    await cleanupPedidoImpressaoFixtures(prefix);
  });

  test('orçamento: the footer share menu downloads a JPEG and a PDF', async ({ page }) => {
    await page.goto(`/pedidos/${fixtures.naoImpressoId}/editar`);
    // The sticky footer (with the share control) is rendered once outside the
    // tabs; wait for the form to mount via its Principal tab.
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });

    const share = page.getByRole('button', { name: 'Compartilhar orçamento' });
    await expect(share).toBeEnabled();

    // JPEG — the capture assembles the model from Firestore, mounts the hidden
    // OrcamentoSheet and saves it as a silent download (no print dialog).
    await share.click();
    const jpegDownload = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('menuitem', { name: 'Imagem (JPEG)' }).click();
    expect((await jpegDownload).suggestedFilename()).toMatch(/^orcamento-.*\.jpg$/);

    // PDF — same raster, paginated onto A4. The menu closed after the first
    // pick, so re-open it.
    await share.click();
    const pdfDownload = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('menuitem', { name: 'PDF' }).click();
    expect((await pdfDownload).suggestedFilename()).toMatch(/^orcamento-.*\.pdf$/);
  });

  test('comum: selecting an already-printed pedido shows the reprint confirm step', async ({
    page,
  }) => {
    await page.goto('/pedidos');
    await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

    // Narrow to the ALREADY-printed pedido (`dtImpressao` set) and select it.
    await applyTextFilter(page, 'Número', fixtures.impressoNumero);
    await expectRowVisible(page, fixtures.impressoNumero);
    await selectRowByText(page, fixtures.impressoNumero);

    // The action has no confirm modal — it opens the print dialog directly.
    await page.getByRole('button', { name: 'Imprimir', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Guard: it asks to confirm reprinting instead of building straight away.
    await expect(dialog.getByText(/já foi impresso/)).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole('button', { name: 'Imprimir mesmo assim' })).toBeVisible();

    // Back out — no print, no write.
    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toBeHidden();
  });

  test('comum: printing a pedido marks it foiImpresso + dtImpressao', async ({ page }) => {
    // Stub print in every frame: react-to-print calls the off-screen iframe's
    // `contentWindow.print()`, which would open the OS print dialog in headed
    // runs (and is a no-op in headless). Stubbing keeps the flow deterministic;
    // `onAfterPrint` still fires, so the mark-printed write runs.
    await page.addInitScript(() => {
      window.print = () => undefined;
    });

    await page.goto('/pedidos');
    await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

    // The NOT-yet-printed pedido — filter narrows to it, then select it.
    await applyTextFilter(page, 'Número', fixtures.naoImpressoNumero);
    await expectRowVisible(page, fixtures.naoImpressoNumero);
    await selectRowByText(page, fixtures.naoImpressoNumero);

    await page.getByRole('button', { name: 'Imprimir', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Not printed before ⇒ no confirm step; it builds, prepares, then offers the
    // in-dialog "Imprimir" button once ready.
    const printBtn = dialog.getByRole('button', { name: 'Imprimir', exact: true });
    await expect(printBtn).toBeEnabled({ timeout: 30_000 });
    await printBtn.click();

    // The print completed (stub) and `onAfterPrint` marked the pedido.
    await expect(dialog.getByText(/Impressão enviada/)).toBeVisible({ timeout: 15_000 });

    // Wire assertion (Admin SDK, strongly consistent): the mark-printed write
    // landed both flags on the pedido doc.
    await expect
      .poll(
        async () => {
          const snap = await db().collection('pedidos').doc(fixtures.naoImpressoId).get();
          const data = snap.data() ?? {};
          return data.foiImpresso === true && data.dtImpressao != null;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  });
});
