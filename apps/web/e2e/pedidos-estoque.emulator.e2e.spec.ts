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

/** Change the pedido estado through the real editor (same path as the vendas
 *  estado spec): Estado/Histórico tab → Select → Salvar → back on /pedidos. */
async function mudarEstadoViaUI(page: Page, estadoLabel: string) {
  await page.goto(`/pedidos/${pedidoId}/editar`);
  await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Estado/Histórico' }).click();
  await page.getByRole('combobox', { name: 'Estado', exact: true }).click();
  await page.getByRole('option', { name: estadoLabel, exact: true }).click();
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  await page.waitForURL((url) => /\/pedidos$/.test(url.pathname), { timeout: 30_000 });
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
  expect(aposReserva.data?.dataIndisponivelEstoque).not.toBeNull();

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
  expect(aposRemocao.data?.dataRemocaoEstoque).not.toBeNull();

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
  expect(aposCancelamento.data?.dataIndisponivelEstoque ?? null).toBeNull();
  expect(aposCancelamento.data?.dataRemocaoEstoque ?? null).toBeNull();

  // 5. No-runaway proof: the poll above confirmed the sync's write-back landed
  // (snapshot cleared IS the write-back), so any further pedido write would be
  // a loop. Audit count and the pedido's updateTime must survive a quiet
  // window untouched — the fast-path swallows the self-retrigger.
  const trail = await listHistoricoEstoque(produtoId, depositoId);
  expect(trail).toHaveLength(3);
  expect(trail.map((h) => h.tipo).sort()).toEqual(['devolucao', 'reserva', 'saida']);
  const antesDaJanela = await getPedidoDoc(pedidoId);
  await page.waitForTimeout(4_000);
  const depoisDaJanela = await getPedidoDoc(pedidoId);
  expect(depoisDaJanela.updateTimeMs).toBe(antesDaJanela.updateTimeMs);
  expect(await listHistoricoEstoque(produtoId, depositoId)).toHaveLength(3);
});
