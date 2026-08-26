import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import { cleanupPedidoWithNFe, e2ePrefix, seedPedidoWithNFe } from './_helpers/seed-data';
import { applyTextFilter, expectRowVisible } from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `NFCell` live-badge guarantee: seed a pedido
 * with one NFe at `estado='0'` (gerado), open `/pedidos`, mutate the NFe
 * estado via the Admin SDK, and assert the cell's badge updates without a
 * page reload — proving `onSnapshot` propagates SEFAZ state changes straight
 * into the rendered cell. This is the only e2e shape that can prove the
 * live-listener guarantee end-to-end (a unit test can only prove the React
 * render path; only Firestore can prove the listener wiring round-trips).
 *
 * The listener is gated on the row being on screen (#1216, `useLatestNfe`).
 * The filter below is what keeps this spec honest about that: it narrows the
 * list to this one pedido, so the row sits at the top of the table and well
 * inside the observer's margin. Do NOT drop the filter to "simplify" — an
 * assertion against a row buried under a full page of pedidos would be
 * asserting the gate, not the listener.
 */
test.describe.serial('Pedidos NF cell — live snapshot updates', () => {
  const prefix = e2ePrefix('nfe');
  let pedidoId = '';
  let nfeId = '';

  test.beforeAll(async ({ browser }) => {
    // First-load route compilation can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    const seeded = await seedPedidoWithNFe(prefix, 1, '0');
    pedidoId = seeded.pedidoId;
    nfeId = seeded.nfeId;
    await warmRoutes(browser, ['/pedidos']);
  });

  test.afterAll(async () => {
    if (pedidoId) await cleanupPedidoWithNFe(pedidoId);
  });

  test('badge starts at "Gerado", flips to "Aprovada" and then "Rejeitada" without reload', async ({
    page,
  }) => {
    await page.goto('/pedidos');
    await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible();
    // Wait for the table to render before asserting on rows — the cold
    // Pipelines call can take a few seconds in CI.
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

    // The pedido's `numero` matches the row's accessible name.
    await applyTextFilter(page, 'Número', pedidoId);
    await expectRowVisible(page, pedidoId);

    const row = page.getByRole('row', { name: new RegExp(pedidoId) });

    // Initial snapshot: estado='0' → label "Gerado".
    await expect(row.getByText('Gerado', { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // Mutate the NFe estado from the test — the page is already open, so
    // the cell must update via the live `onSnapshot` subscription, not on
    // navigation. No `page.reload()` here on purpose.
    await db()
      .collection('pedidos')
      .doc(pedidoId)
      .collection('nfev4')
      .doc(nfeId)
      .update({ estado: 'a', chave: '3'.repeat(44) });
    await expect(row.getByText('Aprovada', { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(row.getByText('Gerado', { exact: true })).toHaveCount(0);

    // And again — flip to rejeitada with an xMotivo so the tooltip helper
    // would have content in the cell. Asserts the cell keeps reacting to
    // subsequent mutations, not just the first one.
    await db()
      .collection('pedidos')
      .doc(pedidoId)
      .collection('nfev4')
      .doc(nfeId)
      .update({ estado: 'n', xMotivo: 'cliente sem inscrição estadual' });
    await expect(row.getByText('Rejeitada', { exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });
});
