import { getAuth } from 'firebase-admin/auth';
import { expect, test } from '@playwright/test';
import { db, getApp } from '@delfrance/test-fixtures';
import { e2eUserEmail } from './_helpers/run-id';
import { cleanupPedidoFixtures, e2ePrefix, seedPedidoFixtures } from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * E2E for the Estado/Histórico tab: changing a pedido's `estado` and saving must
 * persist the new state AND append a `historicoEstadoPedido` audit row (the
 * legacy `Pedido.save()` behavior). Seeds a minimal pedido (one item + the
 * required refs) directly via the Admin SDK, then drives the UI.
 *
 * Since #697 the audit row comes from the `onPedidoEstadoChanged` Cloud Function
 * rather than the client, which makes this the ONLY place in the repo that can
 * prove the trail's ACTOR end-to-end: the emulator hardcodes the Firestore
 * event's `authId` to 'fake-auth-id@gmail.com' (firebase-tools#7609, closed as
 * not-planned), so every offline test can only ever assert `null`. Here a real
 * signed-in user saves through the browser, so the row must name them.
 */
test.describe.serial('Pedidos e2e — Estado / Histórico', () => {
  const prefix = e2ePrefix('pedest');
  const pedidoId = `${prefix}-001`;
  let fixtures: Awaited<ReturnType<typeof seedPedidoFixtures>>;
  /** uid of the run's ephemeral signed-in user — the actor the trail must name. */
  let e2eUid: string;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    e2eUid = (await getAuth(getApp()).getUserByEmail(e2eUserEmail())).uid;
    fixtures = await seedPedidoFixtures(prefix);
    const produtoId = fixtures.produtoPath.split('/')[1]!;

    await db()
      .collection('pedidos')
      .doc(pedidoId)
      .set({
        ehSaida: true,
        estado: 'iniciado',
        numero: pedidoId,
        integracaoPedidoOuterRef: `documents/${fixtures.integracaoPath}`,
        clientePedidoOuterRef: `documents/${fixtures.clientePath}`,
        operacaoPedidoOuterRef: `documents/${fixtures.operacaoPath}`,
        itens: {
          [produtoId]: [
            {
              produtoUid: produtoId,
              ordem: 1,
              sku: fixtures.produtoSku,
              nomeDeVenda: fixtures.produtoNome,
              precoDeVenda: 10,
              descontoUnitario: 0,
              quantidade: 1,
              custo: null,
            },
          ],
        },
        itensIds: [produtoId],
        descontoTotal: 0,
        valorCobrado: 10,
        timestamp: Date.now() * 1000,
      });

    await warmRoutes(browser, ['/pedidos']);
  });

  // Reset the estado and clear the trail before each ATTEMPT. `pedidoId` is
  // derived from GITHUB_RUN_ID, so it is identical across the 2 CI retries, and
  // the trail row now lands ASYNCHRONOUSLY — a row from a timed-out attempt can
  // arrive after `afterAll` already read the subcollection and so survive into
  // the retry. Without this sweep the retry's assertion would be satisfied by
  // the failed attempt's leftover instead of by its own transition.
  test.beforeEach(async () => {
    await db().collection('pedidos').doc(pedidoId).update({ estado: 'iniciado' });
    const hist = await db()
      .collection('pedidos')
      .doc(pedidoId)
      .collection('historicoEstadoPedido')
      .get();
    await Promise.all(hist.docs.map((d) => d.ref.delete()));
  });

  test.afterAll(async () => {
    // Remove the history subcollection first, then the fixture sweep by prefix.
    // `cleanupPedidoFixtures` deletes the pedido with a plain batch delete, which
    // does NOT cascade subcollections.
    const hist = await db()
      .collection('pedidos')
      .doc(pedidoId)
      .collection('historicoEstadoPedido')
      .get();
    await Promise.all(hist.docs.map((d) => d.ref.delete()));
    await cleanupPedidoFixtures(prefix);
  });

  test('changing estado persists it and appends a history row', async ({ page }) => {
    // The 240s in `beforeAll` extends THAT HOOK, not this test — Playwright's
    // `test.setTimeout` inside a beforeAll sets the hook's own budget. Without
    // this line the body runs on `playwright.config.ts`'s 60s, which the history
    // poll below cannot fit behind the three earlier waits. The symptom would be
    // `Test timeout of 60000ms exceeded` instead of the assertion failure,
    // making a slow trigger indistinguishable from an undeployed one.
    test.setTimeout(180_000);

    // Watermark: only rows written AFTER this instant count as this attempt's.
    // `data` is microseconds since epoch (`nowMicros()` convention).
    const t0 = Date.now() * 1000;

    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });

    // Open the Estado/Histórico tab and change the estado to "Pago".
    await page.getByRole('tab', { name: 'Estado/Histórico' }).click();
    await page.getByRole('combobox', { name: 'Estado', exact: true }).click();
    await page.getByRole('option', { name: 'Pago', exact: true }).click();

    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    await page.waitForURL((url) => /\/pedidos$/.test(url.pathname), { timeout: 30_000 });

    // The pedido doc now carries the new estado.
    await expect
      .poll(
        async () => {
          const snap = await db().collection('pedidos').doc(pedidoId).get();
          return snap.data()?.estado as string | undefined;
        },
        { timeout: 15_000 },
      )
      .toBe('pago');

    // And a historicoEstadoPedido row records the change. That row is written by
    // the `onPedidoEstadoChanged` Cloud Function (apps/functions) reacting to the
    // pedido write above — no longer by the client — so this assertion requires
    // the function to be DEPLOYED to the staging project. The timeout covers a
    // cold start on top of the trigger's own delivery latency, and matches the
    // budget the emulator suite gives the same trigger; staging is strictly
    // slower than the emulator.
    //
    // Scoped to `data > t0` deliberately: a bare `.toContain('pago')` over the
    // whole trail can be satisfied by a row left behind by a previous attempt,
    // which turns a real failure into a green retry.
    const freshPagoRow = async () => {
      const hist = await db()
        .collection('pedidos')
        .doc(pedidoId)
        .collection('historicoEstadoPedido')
        .get();
      return (
        hist.docs
          .map((d) => d.data())
          .find((r) => r.estado === 'pago' && (r.data as number) > t0) ?? null
      );
    };

    await expect.poll(freshPagoRow, { timeout: 90_000 }).not.toBeNull();
    const pagoRow = (await freshPagoRow())!;

    // THE ACTOR. This is the only automated coverage of
    // `resolveUsuarioOuterRef(event.authType, event.authId)` producing a real
    // ref: the save above came from a signed-in browser session, so the trigger's
    // auth context carries this run's uid. Every offline test can only assert
    // null (the emulator's hardcoded `authId` is not uid-shaped), so without
    // this a transposed-argument regression would keep every other suite green
    // while production silently recorded `null` for every operator.
    expect(pagoRow.usuarioHistoricoEstadosPedidoOuterRef).toBe(`documents/usuarios/${e2eUid}`);
  });
});
