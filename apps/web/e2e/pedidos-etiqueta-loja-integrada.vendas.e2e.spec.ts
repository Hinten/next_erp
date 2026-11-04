import { expect, test, type Page } from '@playwright/test';
import {
  CODIGO_SITUACAO_LI,
  ESTADO_FRETE,
  FONTE_CONFERENCIA_PAGAMENTO_LI,
  INTEGRACAO_FRETE,
  MOTIVO_ROTA_ETIQUETA_LI,
  TIPO_RESPOSTA_ROTA_ETIQUETA_LI,
  VEREDITO_PAGAMENTO_LI,
  type RespostaConferenciaPagamentoLi,
} from '@delfrance/schemas';
import {
  installRouteStubs,
  stubConferenciaPagamentoLi,
  stubRotaEtiquetaLi,
} from './_helpers/route-stubs';
import {
  cleanupPedidoEtiquetaConferenciaLiFixtures,
  e2ePrefix,
  seedPedidoRoteamentoLiFixtures,
} from './_helpers/seed-data';
import { applyTextFilter, expectRowVisible } from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * The Loja Integrada routing action on the `/pedidos` row (master plan step
 * 15): a pedido imported from Loja Integrada that still names its conta's
 * freight doc has no carrier yet, so the row offers "Definir transportadora"
 * instead of a label. Routing it makes the SAME row offer the carrier's label
 * on the next hover — with a column filter active, so the list itself never
 * repaints the pedido and the row has only the routing answer to go on.
 *
 * The routing route and the paid re-check route both live on the
 * `apps/loja-integrada` backend, which the e2e build does not have: both are
 * STUBBED (the routing write is pinned by the route's own offline and emulator
 * suites), and so is the local print agent. The paid re-check answers `pago`,
 * so the label prints with no question.
 */

const PAGO: RespostaConferenciaPagamentoLi = {
  aplicavel: true,
  fonte: FONTE_CONFERENCIA_PAGAMENTO_LI.loja,
  veredito: VEREDITO_PAGAMENTO_LI.pago,
  codigo: CODIGO_SITUACAO_LI.pedidoPago,
  motivoContestacao: null,
  conferidoEmMs: Date.now(),
  correlationId: null,
};

const DEFINIR = 'Definir transportadora';
const PDF = 'Imprimir etiqueta (PDF)';

test.describe.serial('Pedidos — etiqueta de um pedido da Loja Integrada sem transportadora', () => {
  const prefix = e2ePrefix('rli');
  let fixtures: Awaited<ReturnType<typeof seedPedidoRoteamentoLiFixtures>> | null = null;

  test.beforeAll(async ({ browser }) => {
    // First-load route compilation can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    fixtures = await seedPedidoRoteamentoLiFixtures(prefix);
    await warmRoutes(browser, ['/pedidos']);
  });

  test.afterAll(async () => {
    await cleanupPedidoEtiquetaConferenciaLiFixtures(prefix, fixtures?.pedidoId ?? null);
  });

  /** Open `/pedidos` with the número filter on, and wait for the seeded row. */
  async function abrirLista(page: Page): Promise<void> {
    const numero = fixtures!.numero;
    await page.goto('/pedidos');
    await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await applyTextFilter(page, 'Número', numero);
    await expectRowVisible(page, numero);
  }

  /**
   * Hover the seeded row's freight badge until `botao` shows. The hover is
   * RE-ISSUED on every attempt: the HoverCard has an open delay, and a single
   * hover can be lost to a re-render inside that window.
   */
  async function abrirAcoesDaEtiqueta(page: Page, botao: string): Promise<void> {
    const row = page.getByRole('row', { name: new RegExp(fixtures!.numero) });
    const alvo = page.getByRole('button', { name: botao, exact: true });
    await expect(async () => {
      await row.getByText('Iniciado', { exact: true }).hover();
      await expect(alvo).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  }

  test("routing the pedido to its mapped carrier makes the same row print that carrier's label", async ({
    page,
  }) => {
    const { frete, pedidoId } = fixtures!;
    const stubs = await installRouteStubs(page);
    const conferencia = await stubConferenciaPagamentoLi(page, PAGO);
    const rota = await stubRotaEtiquetaLi(page, {
      tipo: TIPO_RESPOSTA_ROTA_ETIQUETA_LI.roteado,
      alvo: { id: frete.motoboyId, tipo: INTEGRACAO_FRETE.motoboy, nome: frete.motoboyNome },
      rota: {
        integracaoFreteOuterRef: `documents/int_frete/${frete.motoboyId}`,
        externalOptionId: null,
        integracaoTargetOuterRef: null,
        estado: ESTADO_FRETE.iniciado,
      },
    });
    await abrirLista(page);

    // Before routing: the routing action, and no label action.
    await abrirAcoesDaEtiqueta(page, DEFINIR);
    await expect(page.getByRole('button', { name: PDF, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: DEFINIR, exact: true }).click();

    await expect(
      page.getByText(`Transportadora definida: ${frete.motoboyNome} (Motoboy).`),
    ).toBeVisible({ timeout: 30_000 });
    // One call, for THIS pedido, letting the conta's mapa decide.
    expect(rota.chamadas).toEqual([{ pedidoId, corpo: { escolha: null } }]);
    // Routing prints nothing by itself.
    expect(stubs.printJobs).toHaveLength(0);

    // The mouse leaves (the HoverCard unmounts the row), then comes back: the
    // filtered list never repaints the pedido, yet the row offers the
    // carrier's label now.
    await page.mouse.move(0, 0);
    await expect(page.getByRole('button', { name: DEFINIR, exact: true })).toHaveCount(0, {
      timeout: 10_000,
    });
    await abrirAcoesDaEtiqueta(page, PDF);
    await expect(page.getByRole('button', { name: DEFINIR, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: PDF, exact: true }).click();

    await expect.poll(() => stubs.printJobs.length, { timeout: 30_000 }).toBe(1);
    expect(stubs.printJobs[0]!.contentType).toBe('application/pdf');
    // The label's paid re-check ran once, for this pedido; routing ran none.
    expect(conferencia.chamadas).toEqual([pedidoId]);
    expect(rota.chamadas).toHaveLength(1);
  });

  test('a shipping method with no carrier mapped says so, and the row still offers the routing', async ({
    page,
  }) => {
    const stubs = await installRouteStubs(page);
    await stubConferenciaPagamentoLi(page, PAGO);
    const rota = await stubRotaEtiquetaLi(page, {
      tipo: TIPO_RESPOSTA_ROTA_ETIQUETA_LI.recusado,
      motivo: MOTIVO_ROTA_ETIQUETA_LI.semMapeamento,
    });
    await abrirLista(page);

    await abrirAcoesDaEtiqueta(page, DEFINIR);
    await page.getByRole('button', { name: DEFINIR, exact: true }).click();

    await expect(
      page.getByText(/Esta forma de envio não está mapeada para uma transportadora/),
    ).toBeVisible({ timeout: 30_000 });
    expect(rota.chamadas).toHaveLength(1);
    // Nothing was registered: the next hover offers the routing again.
    await page.mouse.move(0, 0);
    await abrirAcoesDaEtiqueta(page, DEFINIR);
    await expect(page.getByRole('button', { name: PDF, exact: true })).toHaveCount(0);
    expect(stubs.printJobs).toHaveLength(0);
  });
});
