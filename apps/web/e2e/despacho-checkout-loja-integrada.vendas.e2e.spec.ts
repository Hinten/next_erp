import { expect, test, type Page } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import {
  CODIGO_ERRO_LI,
  CODIGO_SITUACAO_LI,
  FONTE_CONFERENCIA_PAGAMENTO_LI,
  MOTIVO_PEDIDO_CONTESTADO_LI,
  VEREDITO_PAGAMENTO_LI,
  type RespostaConferenciaPagamentoLi,
} from '@delfrance/schemas';
import { installRouteStubs, stubConferenciaPagamentoLi } from './_helpers/route-stubs';
import {
  cleanupCheckoutConferenciaLiFixtures,
  e2ePrefix,
  seedCheckoutConferenciaLiFixtures,
} from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * The Loja Integrada paid re-check at the checkout save (master plan step 15,
 * a hard gate): before the checkout of an order imported from Loja Integrada
 * commits — and takes the stock — the order's CURRENT payment is asked of the
 * `apps/loja-integrada` backend. An unpaid or contested order is refused with
 * nothing saved; a check that cannot run asks the operator first; a paid order
 * saves, and its post-save label reuses that same answer instead of asking
 * again.
 *
 * The pedido is seeded already routed at import to a Motoboy target, at the
 * deterministic id an imported order carries — so the web recognises it as an
 * imported order, its label is the generic one, and nothing depends on the
 * routing step. The e2e build has no Loja Integrada backend: every case STUBS
 * the paid re-check route (`stubConferenciaPagamentoLi`), which is covered by
 * its own offline suites, and `installRouteStubs` stubs the print agent and
 * NF-e so nothing reaches a printer or SEFAZ.
 *
 * Serial, with the saving case LAST: the three refused or cancelled cases save
 * nothing, so they share the one pedido, and the paid case checks it out.
 */

const SCAN_PLACEHOLDER = /^Bipe o código/;

const CHAMADAS_DESLIGADAS = {
  status: 503,
  envelope: {
    error: 'As chamadas à Loja Integrada estão desligadas.',
    code: CODIGO_ERRO_LI.chamadasDesligadas,
  },
} as const;

const CONTESTADO_NO_ERP: RespostaConferenciaPagamentoLi = {
  aplicavel: true,
  fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.erp,
  veredito: VEREDITO_PAGAMENTO_LI.contestado,
  codigo: null,
  motivoContestacao: MOTIVO_PEDIDO_CONTESTADO_LI.disputa,
  conferidoEmMs: null,
  correlationId: null,
};

const AGUARDANDO_PAGAMENTO: RespostaConferenciaPagamentoLi = {
  aplicavel: true,
  fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.loja,
  veredito: VEREDITO_PAGAMENTO_LI.naoPago,
  codigo: CODIGO_SITUACAO_LI.aguardandoPagamento,
  motivoContestacao: null,
  conferidoEmMs: Date.now(),
  correlationId: null,
};

const PAGO: RespostaConferenciaPagamentoLi = {
  aplicavel: true,
  fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.loja,
  veredito: VEREDITO_PAGAMENTO_LI.pago,
  codigo: CODIGO_SITUACAO_LI.pedidoPago,
  motivoContestacao: null,
  conferidoEmMs: Date.now(),
  correlationId: null,
};

/** The pedido's `checkout` subdocs — each save writes one. */
async function contarCheckouts(pedidoId: string): Promise<number> {
  const snap = await db().collection('pedidos').doc(pedidoId).collection('checkout').get();
  return snap.size;
}

test.describe
  .serial('Despacho — checkout de um pedido da Loja Integrada (conferência de pagamento)', () => {
  const prefix = e2ePrefix('chkli');
  let fx: Awaited<ReturnType<typeof seedCheckoutConferenciaLiFixtures>> | null = null;

  test.beforeAll(async ({ browser }) => {
    // First-load route compilation can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    fx = await seedCheckoutConferenciaLiFixtures(prefix);
    await warmRoutes(browser, ['/despacho/checkout']);
  });

  test.afterAll(async () => {
    await cleanupCheckoutConferenciaLiFixtures(prefix, fx?.pedidoId ?? null);
  });

  /** Deep-link to the pedido, scan its one line and click Salvar. */
  async function conferirESalvar(page: Page): Promise<void> {
    const { numero, sku } = fx!;
    await page.goto(`/despacho/checkout?pedido=${encodeURIComponent(numero)}`);
    await expect(
      page.getByRole('link', { name: new RegExp(`Pedido Nº ${numero}\\b`) }),
    ).toBeVisible({ timeout: 60_000 });
    const input = page.getByPlaceholder(SCAN_PLACEHOLDER);
    await expect(input).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Produtos esperados (1)')).toBeVisible({ timeout: 30_000 });

    await input.fill(sku);
    await input.press('Enter');
    await expect(page.getByText('Produtos lançados (1)')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Salvar' }).click();
  }

  test('a payment check that cannot run asks before saving, and Cancelar saves nothing', async ({
    page,
  }) => {
    await installRouteStubs(page);
    const conferencia = await stubConferenciaPagamentoLi(page, CHAMADAS_DESLIGADAS);
    await conferirESalvar(page);

    const pergunta = page.getByRole('dialog', { name: 'Atenção' });
    await expect(pergunta).toBeVisible({ timeout: 60_000 });
    await expect(pergunta.getByText(/a chave de chamadas está desligada/)).toBeVisible();
    await pergunta.getByRole('button', { name: 'Cancelar' }).click();
    await expect(pergunta).toBeHidden();

    // One check, for THIS pedido — and nothing saved.
    expect(conferencia.chamadas).toEqual([fx!.pedidoId]);
    expect(await contarCheckouts(fx!.pedidoId)).toBe(0);
  });

  test('a contested payment refuses the checkout with nothing saved', async ({ page }) => {
    await installRouteStubs(page);
    const conferencia = await stubConferenciaPagamentoLi(page, CONTESTADO_NO_ERP);
    await conferirESalvar(page);

    await expect(page.getByText(/está contestado .*O checkout não foi salvo\./)).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText('Checkout salvo')).toHaveCount(0);
    expect(conferencia.chamadas).toEqual([fx!.pedidoId]);
    expect(await contarCheckouts(fx!.pedidoId)).toBe(0);
  });

  test('an unpaid order refuses the checkout with nothing saved', async ({ page }) => {
    await installRouteStubs(page);
    const conferencia = await stubConferenciaPagamentoLi(page, AGUARDANDO_PAGAMENTO);
    await conferirESalvar(page);

    await expect(page.getByText(/não como pago\. O checkout não foi salvo\./)).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText('Checkout salvo')).toHaveCount(0);
    expect(conferencia.chamadas).toEqual([fx!.pedidoId]);
    expect(await contarCheckouts(fx!.pedidoId)).toBe(0);
  });

  test('a paid order saves, and its label prints on that same check — one call in the whole chain', async ({
    page,
  }) => {
    const stubs = await installRouteStubs(page);
    const conferencia = await stubConferenciaPagamentoLi(page, PAGO);
    await conferirESalvar(page);

    await expect(page.getByText('Checkout salvo')).toBeVisible({ timeout: 60_000 });
    // The post-save generic label printed without a question of its own…
    await expect.poll(() => stubs.printJobs.length, { timeout: 30_000 }).toBe(1);
    expect(stubs.printJobs[0]!.contentType).toBe('application/pdf');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // …because it reused the save's `pago`: exactly ONE paid re-check call.
    expect(conferencia.chamadas).toEqual([fx!.pedidoId]);
    await expect.poll(() => contarCheckouts(fx!.pedidoId), { timeout: 20_000 }).toBe(1);
  });
});
