import { expect, test, type Page } from '@playwright/test';
import {
  CODIGO_SITUACAO_LI,
  FONTE_CONFERENCIA_PAGAMENTO_LI,
  VEREDITO_PAGAMENTO_LI,
  type RespostaConferenciaPagamentoLi,
} from '@delfrance/schemas';
import { installRouteStubs, stubConferenciaPagamentoLi } from './_helpers/route-stubs';
import {
  cleanupPedidoEtiquetaConferenciaLiFixtures,
  e2ePrefix,
  seedPedidoEtiquetaConferenciaLiFixtures,
} from './_helpers/seed-data';
import { applyTextFilter, expectRowVisible } from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * The Loja Integrada paid re-check before a GENERIC label (master plan step 15,
 * the soft gate): an order imported from Loja Integrada whose payment the store
 * does not confirm asks the operator to acknowledge the risk before the label
 * prints, and a confirmed one prints with no question at all.
 *
 * The pedido is seeded already routed at import to a Motoboy target, at the
 * deterministic id an imported order carries — so the row offers the generic
 * label and the web recognises it as an imported order. The paid re-check
 * route lives on the `apps/loja-integrada` backend, which the e2e build does
 * not have: every case STUBS it (`stubConferenciaPagamentoLi`), the route being
 * covered by its own offline suites, and stubs the local print agent too.
 */

const PAGAMENTO_EM_DISPUTA: RespostaConferenciaPagamentoLi = {
  aplicavel: true,
  fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.loja,
  veredito: VEREDITO_PAGAMENTO_LI.naoPago,
  codigo: CODIGO_SITUACAO_LI.pagamentoEmDisputa,
  motivoContestacao: 'disputa',
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

const PDF = 'Imprimir etiqueta (PDF)';
const TITULO_DO_AVISO = 'Pagamento não confirmado na Loja Integrada';

test.describe
  .serial('Pedidos — etiqueta de um pedido da Loja Integrada (conferência de pagamento)', () => {
  const prefix = e2ePrefix('eli');
  let fixtures: Awaited<ReturnType<typeof seedPedidoEtiquetaConferenciaLiFixtures>> | null = null;

  test.beforeAll(async ({ browser }) => {
    // First-load route compilation can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    fixtures = await seedPedidoEtiquetaConferenciaLiFixtures(prefix);
    await warmRoutes(browser, ['/pedidos']);
  });

  test.afterAll(async () => {
    await cleanupPedidoEtiquetaConferenciaLiFixtures(prefix, fixtures?.pedidoId ?? null);
  });

  /**
   * Open the seeded pedido's etiqueta HoverCard and click the PDF button. The
   * hover is RE-ISSUED on every attempt: the HoverCard has an open delay and
   * `/pedidos` is a live list, so a snapshot inside that window drops a single
   * hover for good (`pedidos-etiqueta-generica.vendas.e2e.spec.ts`).
   */
  async function clicarEtiquetaPdf(page: Page): Promise<void> {
    const numero = fixtures!.numero;
    await page.goto('/pedidos');
    await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

    await applyTextFilter(page, 'Número', numero);
    await expectRowVisible(page, numero);

    const row = page.getByRole('row', { name: new RegExp(numero) });
    const button = page.getByRole('button', { name: PDF, exact: true });
    await expect(async () => {
      await row.getByText('Iniciado', { exact: true }).hover();
      await expect(button).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });

    await button.click();
  }

  test('an unconfirmed payment prints only after "Estou ciente do risco" is ticked', async ({
    page,
  }) => {
    const stubs = await installRouteStubs(page);
    const conferencia = await stubConferenciaPagamentoLi(page, PAGAMENTO_EM_DISPUTA);
    await clicarEtiquetaPdf(page);

    // The warning names THIS pedido: on /pedidos it can queue behind another's.
    const aviso = page.getByRole('dialog', {
      name: `Pedido ${fixtures!.numero} — ${TITULO_DO_AVISO}`,
      exact: true,
    });
    await expect(aviso).toBeVisible({ timeout: 30_000 });
    await expect(aviso.getByText(/Pagamento em disputa/)).toBeVisible();
    const continuar = aviso.getByRole('button', { name: 'Continuar', exact: true });
    await expect(continuar).toBeDisabled();
    // Nothing printed while the question is open.
    expect(stubs.printJobs).toHaveLength(0);

    await aviso.getByRole('checkbox', { name: 'Estou ciente do risco' }).check();
    await expect(continuar).toBeEnabled();
    await continuar.click();

    await expect.poll(() => stubs.printJobs.length, { timeout: 30_000 }).toBe(1);
    expect(stubs.printJobs[0]!.contentType).toBe('application/pdf');
    // Exactly one check, for THIS pedido.
    expect(conferencia.chamadas).toEqual([fixtures!.pedidoId]);
  });

  test('a confirmed payment prints with no question', async ({ page }) => {
    const stubs = await installRouteStubs(page);
    const conferencia = await stubConferenciaPagamentoLi(page, PAGO);
    await clicarEtiquetaPdf(page);

    await expect.poll(() => stubs.printJobs.length, { timeout: 30_000 }).toBe(1);
    await expect(page.getByRole('dialog', { name: TITULO_DO_AVISO })).toHaveCount(0);
    expect(conferencia.chamadas).toEqual([fixtures!.pedidoId]);
  });
});
