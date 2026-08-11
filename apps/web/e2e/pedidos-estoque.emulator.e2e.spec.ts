import { expect, test, type Page } from '@playwright/test';
import {
  cleanupPedidoEstoqueFixtures,
  e2ePrefix,
  getPedidoDoc,
  getProdutoEstoque,
  listHistoricoEstoque,
  seedPedidoEstoqueFixtures,
} from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * Real trigger delivery for the pedido→estoque sync (#409). The ci-storage
 * suite drives the exported core directly; THIS spec exercises the deployed
 * wiring in the functions emulator: a browser flips pedido estados through the
 * real editor, `onPedidoEstoqueSync` fires on the Firestore writes, and the
 * assertions watch the stock move — plus the no-runaway proof that the sync's
 * own write-back does not re-trigger it.
 *
 * Emulator-only (`e2e-emulator.yml`): the trigger is served locally from
 * `firebase.e2e.json`'s functions codebase. NOTE: in the emulator, Admin SDK
 * seed writes ALSO fire the trigger — the fixture pedido is seeded at
 * `iniciado` (a no-effect estado), which doubles as the function warm-up.
 */

const prefix = e2ePrefix('ped-estoque');

let depositoId: string;
let produtoId: string;
let pedidoId: string;
let quantidade: number;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const fixtures = await seedPedidoEstoqueFixtures(prefix);
  depositoId = fixtures.depositoId;
  produtoId = fixtures.produtoId;
  pedidoId = fixtures.pedidoId;
  quantidade = fixtures.quantidade;
  await warmRoutes(browser, [`/pedidos/${pedidoId}/editar`]);
});

test.afterAll(async () => {
  await cleanupPedidoEstoqueFixtures(prefix, produtoId);
});

/**
 * The editor's "Pedido alterado" concurrency modal. A save that trips the guard
 * stays on the page and opens this instead of navigating — silently, as far as a
 * plain `waitForURL` can tell.
 */
function conflitoModal(page: Page) {
  return page.getByRole('dialog', { name: 'Pedido alterado' });
}

/** Change the pedido estado through the real editor (same path as the vendas
 *  estado spec): Estado/Histórico tab → Select → Salvar → back on /pedidos. */
async function mudarEstadoViaUI(page: Page, estadoLabel: string) {
  await page.goto(`/pedidos/${pedidoId}/editar`);
  await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Estado/Histórico' }).click();
  await page.getByRole('combobox', { name: 'Estado', exact: true }).click();
  await page.getByRole('option', { name: estadoLabel, exact: true }).click();
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  await esperarVoltarParaLista(page, `Salvar "${estadoLabel}"`);
}

/**
 * Wait for the post-save redirect, reporting WHY it did not happen.
 *
 * A bare `waitForURL` collapses every failure mode into "Timeout 30000ms
 * exceeded", which is what made #972 read as slowness for four unrelated PRs.
 * Every abort path leaves the browser on the editor, so poll a discriminator
 * instead: Playwright prints the last value, so the report names the conflict
 * (and quotes the modal) rather than the clock.
 */
async function esperarVoltarParaLista(page: Page, oQue: string) {
  await expect
    .poll(
      async () => {
        if (/\/pedidos$/.test(new URL(page.url()).pathname)) return 'lista';
        if (await conflitoModal(page).isVisible()) {
          const texto = (await conflitoModal(page).innerText()).replace(/\s+/g, ' ').trim();
          return `conflito de concorrência: ${texto}`;
        }
        return 'salvando';
      },
      { timeout: 30_000, message: `${oQue} não voltou para /pedidos` },
    )
    .toBe('lista');
}

test('the trigger reserves, removes and returns stock across the pedido lifecycle', async ({
  page,
}) => {
  test.setTimeout(300_000);

  // 1. iniciado → pago: the trigger RESERVES. The estoque doc is created by the
  // sync itself (poll starts from a missing doc — trigger delivery is async).
  await mudarEstadoViaUI(page, 'Pago');
  await expect
    .poll(async () => (await getProdutoEstoque(produtoId, depositoId))?.quantidadeReservada, {
      timeout: 30_000,
    })
    .toBe(quantidade);
  // The estoque write and the pedido snapshot commit in ONE transaction.
  const aposReserva = await getPedidoDoc(pedidoId);
  const snapshotReserva = aposReserva.data?.estoqueAplicado as {
    reservado?: Record<string, number>;
  } | null;
  expect(snapshotReserva?.reservado?.[produtoId]).toBe(quantidade);
  // `typeof … === 'number'` (not `not.toBeNull()`): a never-written field is
  // undefined, which `not.toBeNull()` would vacuously accept.
  expect(typeof aposReserva.data?.dataIndisponivelEstoque).toBe('number');

  // 2. The #408 read-only Estoque tab renders the applied effect end-to-end.
  await page.goto(`/pedidos/${pedidoId}/editar`);
  await page.getByRole('tab', { name: 'Estoque', exact: true }).click();
  await expect(page.getByText('Efeito aplicado')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('cell', { name: produtoId }).first()).toBeVisible({
    timeout: 30_000,
  });
  // The movements table's tipo badge (group query served by the emulator).
  await expect(page.getByText('Reserva', { exact: true })).toBeVisible({ timeout: 30_000 });

  // 3. pago → finalizado: physical removal + reservation release, atomically.
  await mudarEstadoViaUI(page, 'Finalizado');
  await expect
    .poll(async () => (await getProdutoEstoque(produtoId, depositoId))?.quantidade, {
      timeout: 30_000,
    })
    .toBe(-quantidade);
  const estoqueAposRemocao = await getProdutoEstoque(produtoId, depositoId);
  expect(estoqueAposRemocao?.quantidadeReservada).toBe(0);
  const aposRemocao = await getPedidoDoc(pedidoId);
  const snapshotRemocao = aposRemocao.data?.estoqueAplicado as {
    removido?: Record<string, number>;
    reservado?: Record<string, number> | null;
  } | null;
  expect(snapshotRemocao?.removido?.[produtoId]).toBe(quantidade);
  expect(snapshotRemocao?.reservado ?? null).toBeNull();
  expect(typeof aposRemocao.data?.dataRemocaoEstoque).toBe('number');

  // 4. finalizado → cancelado: stock returns, snapshot + markers cleared.
  await mudarEstadoViaUI(page, 'Cancelado');
  await expect
    .poll(async () => (await getProdutoEstoque(produtoId, depositoId))?.quantidade, {
      timeout: 30_000,
    })
    .toBe(0);
  await expect
    .poll(async () => (await getPedidoDoc(pedidoId)).data?.estoqueAplicado ?? null, {
      timeout: 30_000,
    })
    .toBeNull();
  const aposCancelamento = await getPedidoDoc(pedidoId);
  // Doc-existence first: `?.` + `?? null` would collapse a MISSING pedido into
  // "markers cleared".
  expect(aposCancelamento.data).not.toBeNull();
  expect(aposCancelamento.data!.dataIndisponivelEstoque ?? null).toBeNull();
  expect(aposCancelamento.data!.dataRemocaoEstoque ?? null).toBeNull();

  // 5. No-runaway proof: the poll above confirmed the sync's write-back landed
  // (snapshot cleared IS the write-back), so any further pedido write would be
  // a loop. Audit count and the pedido's updateTime must survive a quiet
  // window untouched — the fast-path swallows the self-retrigger.
  const trail = await listHistoricoEstoque(produtoId, depositoId);
  expect(trail).toHaveLength(3);
  expect(trail.map((h) => h.tipo).sort()).toEqual(['devolucao', 'reserva', 'saida']);
  const antesDaJanela = await getPedidoDoc(pedidoId);
  // Non-null before comparing — two null updateTimes (missing doc) would make
  // the stabilization check pass vacuously.
  expect(antesDaJanela.updateTimeMs).not.toBeNull();
  await page.waitForTimeout(4_000);
  const depoisDaJanela = await getPedidoDoc(pedidoId);
  expect(depoisDaJanela.updateTimeMs).toBe(antesDaJanela.updateTimeMs);
  expect(await listHistoricoEstoque(produtoId, depositoId)).toHaveLength(3);
});

test('the sync writing its snapshot back does not read as a concurrent edit', async ({ page }) => {
  test.setTimeout(180_000);

  // The DETERMINISTIC half of #972. The test above trips the same guard, but
  // only as a race — it depends on whether the browser cache still holds the
  // pre-write-back doc — which is exactly why it read as flaky slowness across
  // four unrelated PRs. Nothing here depends on the cache.
  //
  // The lever is "Salvar e continuar editando": it stays on the page and
  // re-baselines the concurrency guard to `{ ...baseline, ...patch }`. The patch
  // can never carry the sync's fields (`estoqueAplicado` is serverOwned, so the
  // rules deny the client writing it; the two markers are read-only in the
  // Estoque tab), so the baseline keeps the PRE-write-back values while the
  // trigger moves the stored ones. Every later save in that session then had a
  // guaranteed mismatch on fields the operator can neither see nor edit — the
  // "Pedido alterado" modal, and no navigation.
  //
  // Sequence: save-and-continue to arm the stale baseline, wait server-side for
  // the write-back to actually land, then edit something the sync never touches
  // and save for real.
  await page.goto(`/pedidos/${pedidoId}/editar`);
  await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Estado/Histórico' }).click();
  await page.getByRole('combobox', { name: 'Estado', exact: true }).click();
  await page.getByRole('option', { name: 'Pago', exact: true }).click();
  await page.getByRole('button', { name: 'Salvar e continuar editando' }).click();

  // The write-back has landed: the baseline in memory is now provably stale.
  await expect
    .poll(async () => (await getPedidoDoc(pedidoId)).data?.estoqueAplicado ?? null, {
      timeout: 30_000,
    })
    .not.toBeNull();

  await page.getByRole('tab', { name: 'Principal' }).click();
  const observacoes = page.getByLabel(/Observações internas/);
  await observacoes.fill('editado depois do write-back do sync');
  await page.getByRole('button', { name: 'Salvar alterações' }).click();

  await expect(conflitoModal(page)).toHaveCount(0);
  await esperarVoltarParaLista(page, 'Salvar após o write-back do sync');
});
