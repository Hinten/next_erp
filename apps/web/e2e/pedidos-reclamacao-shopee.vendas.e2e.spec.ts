import { expect, test, type Page } from '@playwright/test';
import { millisToMicros } from '@delfrance/core/datetime';
import { ESTADO_PEDIDO, ORIGEM_INCIDENTE, STATUS_CLAIM, TIPO_INCIDENTE } from '@delfrance/schemas';
import { db } from '@delfrance/test-fixtures';
import type { ShopeeReclamacaoEstado } from '../lib/shopee/wire';
import {
  cleanupPedidoFixtures,
  cleanupPedidoSubcollection,
  e2ePrefix,
  seedPedidoFixtures,
} from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the Shopee return panel inside the Incidentes tab
 * (#1525, step 17). The panel, the offer modal and the mount are unit-tested
 * (`ReclamacaoShopeePanel.test.tsx`, `OfertaDevolucaoShopeeModal.test.tsx`,
 * `IncidentesTab.test.tsx`, `incidenteCanal.test.ts`); this proves what only
 * the real editor in a real browser shows:
 *
 *   - REACHABILITY — the panel mounts on the incidente the returns importer
 *     writes (origem `pedidoShopee`, an ALPHANUMERIC `return_sn`), and NOT on a
 *     hand-typed one whose id has the very same shape: the mount needs both
 *     halves (`returnSnDoIncidente`);
 *   - it renders the backend's estado — status, deadlines, the Seller Centre
 *     line, and only the buttons `acoesDisponiveis` lists;
 *   - Cancelar on the irreversible confirm sends NOTHING;
 *   - confirming sends exactly ONE body — the pedido ON SCREEN and the amount
 *     the operator was shown, in integer centavos (R-14/R-15) — and the estado
 *     is fetched again and rendered, since the panel writes nothing itself.
 *
 * Network is stubbed (below): both returns routes of the Shopee backend, so no
 * Shopee conta, token or return is needed, and no Firestore write follows the
 * action (the route enqueues a re-import; the stub does not).
 *
 * ⚠️ Never asserts the pedido's blocking overlay. Whether the `storage`
 * codebase the lane runs against already blocks on origem `pedidoShopee` is
 * environment state, not behaviour of this screen (`apps/web/CLAUDE.md` rule
 * 8); the overlay is pinned by `incidenteBloqueio.test.ts` and
 * `sincronizarBloqueioIncidente.test.ts`.
 */

/**
 * The importer's return (the frozen ALPHANUMERIC fixture id). ⚠️ Not a
 * digits-only id: a digits guard — ML's `claimIdDoIncidente` shape — would
 * never mount the panel on a real Shopee return, and only this shape says so.
 */
const RETURN_SN = '260910ABCDE0001';

/**
 * The hand-typed near-miss: a `return_sn`-SHAPED id on an incidente whose
 * origem is not Shopee's. A mount keyed on the id alone would render a second
 * panel here.
 */
const RETURN_SN_MANUAL = '2609100000000002';

/** The fixture order the stubbed return belongs to. */
const ORDER_SN = '260910KJBHUJDM';

const ESTADO_PATH = '/api/marketplace/shopee/reclamacao/estado';
const ACAO_PATH = '/api/marketplace/shopee/reclamacao/acao';

/** What Shopee would refund — shown as R$ 89,90, echoed as 8990 centavos. */
const VALOR_REEMBOLSO = 89.9;
const VALOR_REEMBOLSO_MINOR = 8990;

/** The `motivoSemAcao` sentence the refetched estado carries. */
const MOTIVO_SEM_ACAO = 'A devolução já foi aceita; nenhuma ação resta ao vendedor.';

/** A seller deadline comfortably in the future (ms, Shopee seconds × 1000). */
const PRAZO_RESPOSTA_MS = Date.UTC(2030, 0, 15, 15, 0, 0);

/**
 * Call 1's answer: the return waits for the seller, and the backend lists ONE
 * action. Typed as the browser's own contract (`lib/shopee/wire.ts`, a
 * type-only import — nothing of the app runs in this Node process), so a
 * renamed field fails typecheck here instead of rendering an empty panel.
 *
 * ⚠️ `pedidoId` is NOT the pedido on screen: the backend derives it from the
 * order (`makePedidoIdShopee`), and the panel must echo the pedido the operator
 * is LOOKING AT instead — the cross-check the route refuses on (R-15). A stub
 * agreeing with the screen could not tell the two apart.
 */
function estadoAguardandoVendedor(integracaoId: string): ShopeeReclamacaoEstado {
  return {
    returnSn: RETURN_SN,
    orderSn: ORDER_SN,
    pedidoId: `derivado-pelo-backend-${integracaoId}`,
    status: 'REQUESTED',
    terminal: false,
    solucao: null,
    motivo: 'ITEM_DAMAGED',
    motivoReavaliado: null,
    valorReembolso: VALOR_REEMBOLSO,
    valorAntesDesconto: 99.9,
    moeda: 'BRL',
    tipoRequisicao: 0,
    tipoValidacao: null,
    negociacao: null,
    prova: null,
    compensacao: null,
    prazos: [{ tipo: 'resposta-vendedor', prazoMs: PRAZO_RESPOSTA_MS, reembolsoAutomatico: true }],
    solucoes: [],
    acoesDisponiveis: ['confirmar'],
    motivoSemAcao: null,
    pendenciasForaDoErp: ['contestar'],
  };
}

/** Every later answer: Shopee moved the return on, and nothing is left to do. */
function estadoAceita(integracaoId: string): ShopeeReclamacaoEstado {
  return {
    ...estadoAguardandoVendedor(integracaoId),
    status: 'ACCEPTED',
    prazos: [],
    acoesDisponiveis: [],
    motivoSemAcao: MOTIVO_SEM_ACAO,
    pendenciasForaDoErp: [],
  };
}

interface ChamadaEstado {
  method: string;
  integracaoId: string | null;
  returnSn: string | null;
}

interface RouteStubs {
  /** every estado request, in call order. */
  estado: ChamadaEstado[];
  /** every action request BODY, parsed, in call order. */
  acaoBodies: Array<Record<string, unknown>>;
  /** every action request's method + content type, in call order. */
  acaoHeaders: Array<{ method: string; contentType: string | undefined }>;
}

/** An action request body, parsed — or a marker the body assertion will print. */
function corpoDaChamada(corpo: string | null): Record<string, unknown> {
  try {
    return JSON.parse(corpo ?? '{}') as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) return { corpoNaoJson: corpo };
    throw err;
  }
}

/**
 * Register the stubs for both returns routes. MUST run BEFORE `page.goto`: an
 * unstubbed call would need a live Shopee conta.
 *
 * Matched on the PATHNAME (a predicate, not a glob): the estado URL carries a
 * query string, and the base URL is whatever `NEXT_PUBLIC_SHOPEE_URL` the lane
 * builds with. Playwright answers the CORS preflight itself before any handler
 * runs (the `pedidos-etiqueta-shopee` precedent), so only the real requests
 * land here.
 *
 * The estado answers BY CALL INDEX — call 1 open, every later one accepted —
 * so the refetch after the action is visible on screen, not only in a count.
 */
async function installRouteStubs(page: Page, integracaoId: string): Promise<RouteStubs> {
  const stubs: RouteStubs = { estado: [], acaoBodies: [], acaoHeaders: [] };

  await page.route(
    (url) => url.pathname.endsWith(ESTADO_PATH),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      stubs.estado.push({
        method: req.method(),
        integracaoId: url.searchParams.get('integracaoId'),
        returnSn: url.searchParams.get('returnSn'),
      });
      const corpo =
        stubs.estado.length === 1
          ? estadoAguardandoVendedor(integracaoId)
          : estadoAceita(integracaoId);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify(corpo),
      });
    },
  );

  await page.route(
    (url) => url.pathname.endsWith(ACAO_PATH),
    async (route) => {
      const req = route.request();
      stubs.acaoBodies.push(corpoDaChamada(req.postData()));
      stubs.acaoHeaders.push({ method: req.method(), contentType: req.headers()['content-type'] });
      // A second action is a double submit: refuse it, so the body assertion
      // names the extra call rather than a stub that quietly accepted it.
      if (stubs.acaoBodies.length > 1) {
        const error = 'Chamada inesperada à rota de ação (stub do e2e).';
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error,
            code: 'SHOPEE_RECLAMACAO_ACAO_RECUSADA',
            motivo: 'stub',
            acoesDisponiveis: [],
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          acao: 'confirmar',
          returnSn: RETURN_SN,
          atualizacao: 'enfileirada',
        }),
      });
    },
  );

  return stubs;
}

test.describe.serial('Pedidos — reclamação Shopee (Incidentes tab)', () => {
  const prefix = e2ePrefix('rshp');
  // `numero` = id, so `cleanupPedidoFixtures` (by `numero` prefix) reaches it.
  const pedidoId = `${prefix}-001`;
  let integracaoId: string;

  test.beforeAll(async ({ browser }) => {
    // First-load route compilation can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    const fixtures = await seedPedidoFixtures(prefix);
    integracaoId = fixtures.integracaoPath.split('/')[1]!;
    const produtoId = fixtures.produtoPath.split('/')[1]!;
    const agoraUs = millisToMicros(Date.now());

    // A full saída pedido (the `pedidos-incidentes` shape): the editor's Zod
    // converter must parse it, and `integracaoPedidoOuterRef` is what hands the
    // Incidentes tab its `integracaoId` — without it no channel panel mounts.
    await db()
      .collection('pedidos')
      .doc(pedidoId)
      .set({
        ehSaida: true,
        estado: ESTADO_PEDIDO.iniciado,
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
        timestamp: agoraUs,
      });

    const incidentes = db().collection('pedidos').doc(pedidoId).collection('incidentes');
    const batch = db().batch();
    // What the returns importer writes, at its deterministic id. The panel
    // reads nothing off the stored `devolucaoShopee` block (it asks the
    // backend live), so the block is left out.
    batch.set(incidentes.doc(`shopee-devolucao-${RETURN_SN}`), {
      origem: ORIGEM_INCIDENTE.pedidoShopee,
      tipo: TIPO_INCIDENTE.devolucao,
      externalId: RETURN_SN,
      claimStatus: STATUS_CLAIM.aberta,
      claimStage: null,
      entregue: null,
      motivoDoIncidente: 'Devolução Shopee',
      comentarios: null,
      resolucao: null,
      timestamp: agoraUs,
      ultimaModificacao: agoraUs,
      relogioProvedorUs: agoraUs,
    });
    // The near-miss: typed by a person, origem `outros`, an id of the same shape.
    batch.set(incidentes.doc(`${prefix}-manual`), {
      origem: ORIGEM_INCIDENTE.outros,
      tipo: TIPO_INCIDENTE.devolucao,
      externalId: RETURN_SN_MANUAL,
      claimStatus: null,
      claimStage: null,
      entregue: null,
      motivoDoIncidente: `${prefix}-manual`,
      comentarios: null,
      resolucao: null,
      timestamp: agoraUs - 1,
      ultimaModificacao: agoraUs - 1,
    });
    await batch.commit();

    await warmRoutes(browser, ['/pedidos']);
  });

  test.afterAll(async () => {
    // Firestore never cascades: the incidentes and the trails the triggers
    // append (`onIncidenteChanged` → `historicoDeModificacoes`,
    // `onPedidoChanged` → `historicoEstadoPedido`) go BEFORE the pedido. A row
    // a trigger lands after this is reclaimed by the stale sweep's subtree
    // delete.
    await cleanupPedidoSubcollection(pedidoId, 'incidentes');
    await Promise.all([
      cleanupPedidoSubcollection(pedidoId, 'historicoDeModificacoes'),
      cleanupPedidoSubcollection(pedidoId, 'historicoEstadoPedido'),
    ]);
    await cleanupPedidoFixtures(prefix);
  });

  /** Open the pedido's Incidentes tab and wait for both seeded cards. */
  async function abrirIncidentes(page: Page): Promise<void> {
    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('tab', { name: /Incidentes/ }).click();
    const painel = page.getByRole('tabpanel');
    await expect(painel.getByText(`Shopee #${RETURN_SN}`, { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(painel.getByText(`Ref. externa: ${RETURN_SN_MANUAL}`)).toBeVisible();
  }

  test('mounts the panel only on the imported return and renders its live estado', async ({
    page,
  }) => {
    const stubs = await installRouteStubs(page, integracaoId);
    await abrirIncidentes(page);
    const painel = page.getByRole('tabpanel');
    const verSituacao = painel.getByRole('button', { name: 'Ver situação e ações' });

    // ONE panel, on the importer's row. The manual card is rendered (anchored
    // above) and carries none — its id has the same shape, its origem does not.
    await expect(verSituacao).toHaveCount(1);
    await expect(painel.getByText(`Devolução Shopee #${RETURN_SN}`)).toBeVisible();
    await expect(painel.getByText(`Devolução Shopee #${RETURN_SN_MANUAL}`)).toHaveCount(0);
    // Collapsed: nothing asked of the backend yet. (The unit suite owns the
    // strict "zero calls" proof; this checks it held up to the click.)
    expect(stubs.estado).toHaveLength(0);

    await verSituacao.click();

    // The live estado, rendered: the status label, the deadline with its
    // automatic-refund flag, the amount, the Seller Centre line.
    await expect(painel.getByText('solicitada', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(painel.getByText(/Responder à solicitação até/)).toBeVisible();
    await expect(painel.getByText('reembolso automático', { exact: true })).toHaveCount(1);
    await expect(painel.getByText(/Reembolso solicitado: R\$\s?89,90/)).toBeVisible();
    await expect(painel.getByText('Produto danificado', { exact: true })).toBeVisible();
    await expect(
      painel.getByText('Para contestar a devolução, abra a disputa pelo Seller Centre da Shopee.', {
        exact: true,
      }),
    ).toBeVisible();

    // Only what `acoesDisponiveis` lists — an unlisted action is ABSENT, never
    // a disabled button.
    await expect(painel.getByRole('button', { name: 'Reembolsar sem devolução' })).toBeEnabled();
    await expect(painel.getByRole('button', { name: 'Aceitar proposta do comprador' })).toHaveCount(
      0,
    );
    await expect(painel.getByRole('button', { name: /^Fazer proposta/ })).toHaveCount(0);

    // Exactly one read, for this conta and this return, as a GET.
    expect(stubs.estado).toEqual([{ method: 'GET', integracaoId, returnSn: RETURN_SN }]);
    expect(stubs.acaoBodies).toEqual([]);
  });

  test('Cancelar sends nothing; confirming sends one body and refetches the estado', async ({
    page,
  }) => {
    const stubs = await installRouteStubs(page, integracaoId);
    await abrirIncidentes(page);
    const painel = page.getByRole('tabpanel');

    await painel.getByRole('button', { name: 'Ver situação e ações' }).click();
    const reembolsar = painel.getByRole('button', { name: 'Reembolsar sem devolução' });
    await expect(reembolsar).toBeEnabled({ timeout: 15_000 });
    expect(stubs.estado).toHaveLength(1);

    // The confirm states the CONSEQUENCE with the amount, and its commit label
    // differs from the button just pressed.
    const dialogo = page.getByRole('dialog', {
      name: /^Reembolsar R\$\s?89,90 sem pedir o produto de volta\?$/,
    });
    const confirmar = dialogo.getByRole('button', {
      name: /^Confirmar reembolso de R\$\s?89,90$/,
    });

    // 1) Cancelar — the dialog closes and NOTHING is sent.
    await reembolsar.click();
    await expect(dialogo).toBeVisible();
    await expect(confirmar).toBeVisible();
    await dialogo.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(dialogo).toBeHidden();
    await expect(reembolsar).toBeEnabled();
    expect(stubs.acaoBodies).toEqual([]);
    expect(stubs.estado).toHaveLength(1);

    // 2) Confirm — exactly ONE body: the pedido ON SCREEN (never the estado's
    // own `pedidoId`), and the amount shown, as integer centavos.
    await reembolsar.click();
    await expect(confirmar).toBeVisible();
    await confirmar.click();
    await expect(dialogo).toBeHidden();

    await expect.poll(() => stubs.acaoBodies.length, { timeout: 15_000 }).toBe(1);
    expect(stubs.acaoBodies).toEqual([
      {
        integracaoId,
        pedidoId,
        returnSn: RETURN_SN,
        acao: 'confirmar',
        valorExibidoMinor: VALOR_REEMBOLSO_MINOR,
      },
    ]);
    expect(stubs.acaoHeaders).toEqual([{ method: 'POST', contentType: 'application/json' }]);
    await expect(page.getByText('Enviado à Shopee.', { exact: true })).toBeVisible();

    // The panel writes nothing itself: it asks again, and renders the answer.
    await expect.poll(() => stubs.estado.length, { timeout: 15_000 }).toBe(2);
    expect(stubs.estado[1]).toEqual({ method: 'GET', integracaoId, returnSn: RETURN_SN });
    await expect(painel.getByText('aceita', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(painel.getByText(MOTIVO_SEM_ACAO, { exact: true })).toBeVisible();
    await expect(reembolsar).toHaveCount(0);
    expect(stubs.acaoBodies).toHaveLength(1);
  });
});
