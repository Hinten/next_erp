import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { centavosDeReais, formatReais } from '@delfrance/core/money';
import {
  CODIGO_ERRO_LINK,
  MODO_LINK_PAGAMENTO,
  MOTIVO_RECUSA_LINK,
  MOTIVO_RECUSA_LINK_LABELS,
  ROTA_LINK_PAGAMENTO,
  SITUACAO_LINK_PAGAMENTO_LABELS,
  STATUS_LINK_PAGAMENTO,
  TIPO_PAGAMENTO_MP,
  TIPO_PAGAMENTO_MP_LABELS,
  cancelarLinkPagamentoBodySchema,
  cancelarLinkPagamentoRespostaSchema,
  criarLinksPagamentoBodySchema,
  criarLinksPagamentoRespostaSchema,
  sincronizarLinksPagamentoBodySchema,
  sincronizarLinksPagamentoRespostaSchema,
} from '@delfrance/schemas';
import { db } from '@delfrance/test-fixtures';
import {
  cleanupLinkPagamentoFixtures,
  e2ePrefix,
  resetLinksPagamento,
  seedLinkPagamentoFixtures,
  type LinkPagamentoFixtures,
} from './_helpers/seed-data';
import { expectMoneyValue, fillField, typeMoney } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * A aba "Link Pgto" do editor de pedido (#367): o operador escolhe uma conta do
 * Mercado Pago e gera um link (ou uma vaquinha, um link por pessoa), copia as
 * mensagens para o WhatsApp e acompanha quem já pagou.
 *
 * Emulator lane, not the staging `vendas` one, for two reasons:
 *
 *  1. The tab reads `pedidos/{id}/linkPgtoMercadoPago`, a server-owned collection
 *     whose rules only exist in the repo's generated `firestore.e2e.rules`. The
 *     emulator loads that file (`firebase.e2e.json`), so the spec is deterministic;
 *     against staging it would be red until a human deployed the rules — a fact
 *     about the environment, which is exactly what `apps/web/CLAUDE.md` rule 8
 *     forbids a spec from asserting.
 *  2. Creating a link means a real Mercado Pago preference, which needs
 *     `apps/mercado-pago` running with a connected account and moves real money.
 *
 * So the backend is a FAKE, installed with `page.route` (the CORS handling mirrors
 * `whatsapp-vinculos.emulator.e2e.spec.ts`). It is not a rubber stamp: it parses every
 * request with the SAME strict schemas the real routes use and every response with
 * the SAME schemas the client validates with (`@delfrance/schemas`), and it persists
 * the links it "created" through the Admin SDK, as the real route does — so the list
 * reacts to a creation through the real Firestore listener. What this file cannot
 * cover is the route's own behaviour (transaction, Mercado Pago call, estado flip):
 * that belongs to the `apps/mercado-pago` suites.
 *
 * The clipboard is asserted through a recorder around `navigator.clipboard.writeText`
 * rather than by reading the real clipboard back: `readText()` needs a focused
 * document and a permission grant that headless runs do not guarantee, and a test
 * that quietly reads an empty string would be vacuous. The recorder captures exactly
 * what the page handed to the clipboard, which is the behaviour under test.
 *
 * Seed (see `seedLinkPagamentoFixtures`): a saída pedido of R$ 100,00 with Maria's
 * link (R$ 30,00, paid), João's link (R$ 30,00, open) and a legacy link (R$ 20,00, no
 * tracking). restante = 70, R$ 30,00 of it is in João's open link, so a new batch may
 * charge R$ 40,00.
 */

/** The CORS headers the fake backend answers with (the page is cross-origin to it). */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Authorization, Content-Type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

/** The Mercado Pago account grant is dead (`respond.ts` of `apps/mercado-pago`). */
const CODIGO_REAUTENTICAR = 'MP_REAUTH_REQUIRED';

/** What the fake `criar` route does with the next request. */
type PassoCriar = 'ok' | 'rede' | 'excedeRestante' | 'reautenticar';

interface BackendMp {
  /** Every body POSTed to each route, exactly as the browser sent it. */
  criar: unknown[];
  cancelar: unknown[];
  sincronizar: unknown[];
}

const FUSO = 'America/Sao_Paulo';

/** Today's civil date (`YYYY-MM-DD`) in São Paulo — the zone the deadline is counted in. */
function diaCivilSaoPaulo(ms: number): string {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ms);
  const campo = (tipo: string): string => partes.find((p) => p.type === tipo)?.value ?? '';
  return `${campo('year')}-${campo('month')}-${campo('day')}`;
}

function somarDias(civil: string, dias: number): string {
  const [ano = 0, mes = 1, dia = 1] = civil.split('-').map(Number);
  return new Date(Date.UTC(ano, mes - 1, dia + dias)).toISOString().slice(0, 10);
}

/** `DD/MM` of an instant on the São Paulo calendar — the day the payer sees. */
function diaMes(ms: number): string {
  const [, mes = '', dia = ''] = diaCivilSaoPaulo(ms).split('-');
  return `${dia}/${mes}`;
}

/** 23:59:59-03:00 of a civil date, as epoch ms — what the real route stores as the deadline. */
function fimDoDiaSaoPaulo(civil: string): number {
  const [ano = 0, mes = 1, dia = 1] = civil.split('-').map(Number);
  return Date.UTC(ano, mes - 1, dia, 23 + 3, 59, 59);
}

function literal(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A money amount as the UI prints it — `formatReais` puts a NO-BREAK SPACE after `R$`. */
function reais(valor: number): RegExp {
  return new RegExp(literal(formatReais(valor)).replace(/\s/g, '\\s'));
}

/** The same amount, anchored: the whole text of a summary figure. */
function reaisExato(valor: number): RegExp {
  return new RegExp(`^${reais(valor).source}$`);
}

const linhas = (page: Page): Locator => page.getByTestId('link-pagamento-linha');

/** The situação badge of a row. */
const badge = (linha: Locator, situacao: string): Locator =>
  linha.getByText(situacao, { exact: true });

/**
 * Stand in for `apps/mercado-pago`'s link routes. `roteiro` scripts the next `criar`
 * answers in order (default `ok`), so a test can lose the connection or get a refusal
 * and then succeed.
 */
async function instalarBackend(
  page: Page,
  fixtures: LinkPagamentoFixtures,
  roteiro: PassoCriar[] = [],
): Promise<BackendMp> {
  const backend: BackendMp = { criar: [], cancelar: [], sincronizar: [] };
  const passos = [...roteiro];
  const pedidoRef = db().collection('pedidos').doc(fixtures.pedidoId);
  const colecao = pedidoRef.collection('linkPgtoMercadoPago');

  async function responder(route: Route, corpo: unknown, status = 200): Promise<void> {
    await route.fulfill({
      status,
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify(corpo),
    });
  }

  async function criar(route: Route, corpo: unknown): Promise<void> {
    backend.criar.push(corpo);
    const passo = passos.shift() ?? 'ok';
    if (passo === 'rede') {
      await route.abort('failed');
      return;
    }
    if (passo === 'excedeRestante') {
      await responder(
        route,
        {
          error: MOTIVO_RECUSA_LINK_LABELS[MOTIVO_RECUSA_LINK.excedeRestante],
          code: CODIGO_ERRO_LINK.naoElegivel,
          reason: MOTIVO_RECUSA_LINK.excedeRestante,
        },
        409,
      );
      return;
    }
    if (passo === 'reautenticar') {
      await responder(
        route,
        { error: 'Reconecte a conta do Mercado Pago.', code: CODIGO_REAUTENTICAR },
        409,
      );
      return;
    }

    const lido = criarLinksPagamentoBodySchema.safeParse(corpo);
    if (!lido.success) {
      await responder(
        route,
        { error: lido.error.message, code: CODIGO_ERRO_LINK.corpoInvalido },
        400,
      );
      return;
    }
    const pedido = lido.data;
    const agora = Date.now();
    const expiraMs = fimDoDiaSaoPaulo(pedido.expiraEm);
    const quantidade = pedido.quantidadeMaxima ?? 1;

    // What the real route persists for each link, in the shape the tab reads.
    const docs = pedido.links.map((l, ordem) => ({
      id: l.linkId,
      data: {
        contaMercadoPagoOuterRef: `documents/metodo_pgto/${pedido.metodoId}`,
        valorCobrado: l.valor,
        link: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-${l.linkId}`,
        id: `pref-${l.linkId}`,
        dataCriacao: agora,
        dataExpiracao: expiraMs,
        modo: pedido.modo,
        nomePagador: l.nomePagador,
        quantidadeMaxima: quantidade,
        grupoId: `lote-${String(agora)}`,
        ordem,
        status: STATUS_LINK_PAGAMENTO.aberto,
        encerradoEm: null,
        encerradoPorOuterRef: null,
        erroEncerramento: null,
        criadoPorOuterRef: null,
        tiposExcluidos: pedido.tiposExcluidos.length > 0 ? pedido.tiposExcluidos : null,
        parcelasMaximas: pedido.parcelasMaximas,
      },
    }));
    await Promise.all(docs.map(({ id, data }) => colecao.doc(id).set(data)));

    const resposta = criarLinksPagamentoRespostaSchema.parse({
      links: pedido.links.map((l) => ({
        linkId: l.linkId,
        preferenceId: `pref-${l.linkId}`,
        link: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-${l.linkId}`,
        valorCobrado: l.valor,
        nomePagador: l.nomePagador,
        dataExpiracao: expiraMs,
        modo: pedido.modo,
        quantidadeMaxima: quantidade,
      })),
      estado: null,
      reaproveitado: false,
    });
    await responder(route, resposta, 201);
  }

  async function cancelar(route: Route, corpo: unknown): Promise<void> {
    backend.cancelar.push(corpo);
    const lido = cancelarLinkPagamentoBodySchema.safeParse(corpo);
    if (!lido.success) {
      await responder(
        route,
        { error: lido.error.message, code: CODIGO_ERRO_LINK.corpoInvalido },
        400,
      );
      return;
    }
    const link = colecao.doc(lido.data.linkId);
    await link.update({ status: STATUS_LINK_PAGAMENTO.cancelado, encerradoEm: Date.now() });
    await responder(
      route,
      cancelarLinkPagamentoRespostaSchema.parse({
        linkId: lido.data.linkId,
        status: STATUS_LINK_PAGAMENTO.cancelado,
      }),
    );
  }

  async function sincronizar(route: Route, corpo: unknown): Promise<void> {
    backend.sincronizar.push(corpo);
    const lido = sincronizarLinksPagamentoBodySchema.safeParse(corpo);
    if (!lido.success) {
      await responder(
        route,
        { error: lido.error.message, code: CODIGO_ERRO_LINK.corpoInvalido },
        400,
      );
      return;
    }
    await responder(
      route,
      sincronizarLinksPagamentoRespostaSchema.parse({
        encontrados: 2,
        reconciliados: 1,
        ignorados: 1,
        falhas: [],
        transicoes: [],
        truncado: false,
      }),
    );
  }

  await page.route('**/api/payments/mercado-pago/links/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const caminho = new URL(req.url()).pathname;
    const corpo: unknown = req.postDataJSON();
    if (caminho.endsWith(ROTA_LINK_PAGAMENTO.criar)) {
      await criar(route, corpo);
    } else if (caminho.endsWith(ROTA_LINK_PAGAMENTO.cancelar)) {
      await cancelar(route, corpo);
    } else if (caminho.endsWith(ROTA_LINK_PAGAMENTO.sincronizar)) {
      await sincronizar(route, corpo);
    } else {
      await responder(route, { error: 'Rota desconhecida.' }, 404);
    }
  });

  return backend;
}

/**
 * Record every string the page hands to `navigator.clipboard.writeText`. Must run
 * BEFORE `page.goto`. The real write still happens (permissions are granted), so
 * the page behaves as in production.
 */
async function gravarClipboard(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const copiados: string[] = [];
    (window as unknown as { __copiados: string[] }).__copiados = copiados;
    const area = navigator.clipboard;
    const original = area.writeText.bind(area);
    area.writeText = (texto: string) => {
      copiados.push(texto);
      return original(texto);
    };
  });
  return () =>
    page.evaluate(() => (window as unknown as { __copiados?: string[] }).__copiados ?? []);
}

test.describe.serial('Pedidos e2e — aba Link Pgto (links de pagamento Mercado Pago)', () => {
  const prefix = e2ePrefix('linkpgto');
  let fixtures: LinkPagamentoFixtures;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    fixtures = await seedLinkPagamentoFixtures(prefix);
    await warmRoutes(browser, [`/pedidos/${fixtures.pedidoId}/editar`]);
  });

  test.beforeEach(async ({ context }) => {
    test.setTimeout(120_000);
    // Every test starts from the same three links, whatever the previous one created
    // or cancelled through the fake backend.
    await resetLinksPagamento(fixtures);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test.afterAll(async () => {
    await cleanupLinkPagamentoFixtures(prefix);
  });

  /** Open the editor, switch to the tab and wait for the three seeded links. */
  async function abrirAbaLinks(page: Page): Promise<void> {
    await page.goto(`/pedidos/${fixtures.pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('tab', { name: 'Link Pgto' }).click();
    await expect(linhas(page)).toHaveCount(3, { timeout: 30_000 });
  }

  /**
   * Make sure the seeded account is the one selected. The tab picks the only eligible
   * account by itself; going through the picker when it has not (yet) is what an
   * operator with two accounts would do, and keeps the other tests from depending on
   * the auto-pick that the picker test asserts on its own.
   */
  async function garantirConta(page: Page): Promise<void> {
    const conta = page.getByRole('combobox', { name: 'Conta Mercado Pago', exact: true });
    await expect(async () => {
      if (!(await conta.inputValue()).includes(fixtures.metodoNome)) {
        await conta.click();
        await page.getByRole('option', { name: fixtures.metodoNome }).click();
      }
      await expect(conta).toHaveValue(new RegExp(literal(fixtures.metodoNome)));
    }).toPass({ timeout: 30_000 });
  }

  /** The vaquinha starts with however many rows the form offers; end with exactly `total`. */
  async function garantirPessoas(page: Page, total: number): Promise<void> {
    const adicionar = page.getByRole('button', { name: 'Adicionar pessoa', exact: true });
    // The rows render in the same commit as this button, so once it shows they are there.
    await expect(adicionar).toBeVisible();
    for (let n = 1; n <= total; n += 1) {
      const nome = page.getByLabel(`Nome da pessoa ${String(n)}`, { exact: true });
      if ((await nome.count()) === 0) await adicionar.click();
      await expect(nome).toBeVisible();
    }
    await expect(
      page.getByLabel(`Nome da pessoa ${String(total + 1)}`, { exact: true }),
    ).toHaveCount(0);
  }

  async function escolherModo(page: Page, modo: string): Promise<void> {
    await page.locator('label', { hasText: modo }).first().click();
  }

  /** One figure of the summary card, by the tab's own test id. */
  async function expectResumo(page: Page, testId: string, valor: number): Promise<void> {
    await expect(page.getByTestId(testId)).toHaveText(reaisExato(valor));
  }

  test('lista cada link com a situação derivada dos pagamentos e o valor ainda disponível', async ({
    page,
  }) => {
    await abrirAbaLinks(page);
    const { links } = fixtures;

    // Maria: her link was paid by the approved pagamento attributed to it.
    const maria = linhas(page).filter({ hasText: 'Maria' });
    await expect(maria).toHaveCount(1);
    await expect(badge(maria, SITUACAO_LINK_PAGAMENTO_LABELS.pago)).toBeVisible();
    await expect(maria).toContainText(reais(links.maria.valor));
    await expect(maria).toContainText(fixtures.metodoNome);
    await expect(maria.getByRole('button', { name: /^Cancelar/ })).toHaveCount(0);

    // João: nobody paid it yet, so it is open and can still be withdrawn.
    const joao = linhas(page).filter({ hasText: 'João' });
    await expect(joao).toHaveCount(1);
    await expect(badge(joao, SITUACAO_LINK_PAGAMENTO_LABELS.aberto)).toBeVisible();
    await expect(joao).toContainText(reais(links.joao.valor));
    await expect(joao.getByRole('button', { name: /^Cancelar/ })).toHaveCount(1);
    await expect(joao.getByRole('link', { name: 'Abrir', exact: true })).toHaveAttribute(
      'href',
      links.joao.url,
    );

    // The legacy link carries no tracking: it is listed, but flagged and never cancellable.
    const legado = linhas(page).filter({ hasText: SITUACAO_LINK_PAGAMENTO_LABELS.legado });
    await expect(legado).toHaveCount(1);
    await expect(legado).toContainText(reais(links.legado.valor));
    await expect(legado.getByRole('button', { name: /^Cancelar/ })).toHaveCount(0);

    // restante = 100 − 30 paid; only João's link is counted as open (the legacy link is
    // not — it would otherwise read as R$ 50,00 and shrink what can still be charged).
    await expectResumo(page, 'link-resumo-total', fixtures.valorCobrado);
    await expectResumo(page, 'link-resumo-pago', fixtures.valorPago);
    await expectResumo(page, 'link-resumo-em-aberto', fixtures.emLinksAbertos);
    await expectResumo(page, 'link-resumo-restante', fixtures.restante);
    await expectResumo(page, 'link-resumo-disponivel', fixtures.disponivel);
  });

  test('só oferece contas Mercado Pago conectadas e habilitadas para links', async ({ page }) => {
    await abrirAbaLinks(page);

    const conta = page.getByRole('combobox', { name: 'Conta Mercado Pago', exact: true });
    // The only eligible account is picked for the operator…
    await expect(conta).toHaveValue(new RegExp(literal(fixtures.metodoNome)), { timeout: 30_000 });

    // …and it is the only one the list offers: the other two exist in the collection,
    // one not enabled for links and one never connected.
    await conta.click();
    await expect(page.getByRole('option', { name: fixtures.metodoNome })).toBeVisible();
    await expect(page.getByRole('option', { name: fixtures.metodoSemLinkNome })).toHaveCount(0);
    await expect(page.getByRole('option', { name: fixtures.metodoSemUsuarioNome })).toHaveCount(0);
  });

  test('o link compartilhado não pode ser escolhido', async ({ page }) => {
    await abrirAbaLinks(page);

    await expect(page.getByRole('radio', { name: 'Link compartilhado' })).toBeDisabled();
    // The two modes that work stay selectable.
    await expect(page.getByRole('radio', { name: 'Um link', exact: true })).toBeEnabled();
    await expect(page.getByRole('radio', { name: 'Vaquinha por pessoa' })).toBeEnabled();
  });

  test('copia os links em aberto e, separadamente, só os primeiros nomes de quem já pagou', async ({
    page,
  }) => {
    const copiados = await gravarClipboard(page);
    await abrirAbaLinks(page);
    const { links } = fixtures;

    // One link on its own.
    await linhas(page)
      .filter({ hasText: 'João' })
      .getByRole('button', { name: 'Copiar link', exact: true })
      .click();
    await expect.poll(async () => (await copiados()).length, { timeout: 15_000 }).toBe(1);
    expect((await copiados())[0]).toBe(links.joao.url);

    // Every payable link, ready to paste into WhatsApp.
    await page.getByRole('button', { name: 'Copiar todos os links', exact: true }).click();
    await expect.poll(async () => (await copiados()).length, { timeout: 15_000 }).toBe(2);
    const todos = (await copiados())[1] ?? '';
    expect(todos).toContain(`Pedido ${fixtures.numero}`);
    expect(todos).toContain(links.joao.url);
    expect(todos).toMatch(new RegExp(`João: ${reais(links.joao.valor).source}`));
    expect(todos).toContain(`(até ${diaMes(links.joao.expiraMs)})`);
    // Maria already paid; the legacy link cannot be tracked. Neither is offered as payable.
    expect(todos).not.toContain(links.maria.url);
    expect(todos).not.toContain(links.legado.url);

    // Who has already paid: first names only — no links, no amounts.
    await page.getByRole('button', { name: 'Copiar quem já pagou', exact: true }).click();
    await expect.poll(async () => (await copiados()).length, { timeout: 15_000 }).toBe(3);
    const quem = (await copiados())[2] ?? '';
    // João has a name and an open link, so he shows up — but under "Aguardando", not among
    // the ones who paid.
    const [pagaram = '', aguardando = ''] = quem.split('Aguardando:');
    expect(pagaram).toContain('Maria');
    expect(pagaram).not.toContain('João');
    expect(aguardando).toContain('João');
    expect(quem).not.toMatch(/https?:\/\//);
    expect(quem).not.toContain('R$');
  });

  test('vaquinha por pessoa: divide o valor disponível ao centavo e envia um link individual por pessoa', async ({
    page,
  }) => {
    const backend = await instalarBackend(page, fixtures);
    await abrirAbaLinks(page);
    await garantirConta(page);
    await escolherModo(page, 'Vaquinha por pessoa');

    const nomes = ['Ana', 'Bruno', 'Carla'];
    await garantirPessoas(page, nomes.length);
    for (let i = 0; i < nomes.length; i += 1) {
      await page.getByLabel(`Nome da pessoa ${String(i + 1)}`, { exact: true }).fill(nomes[i]!);
    }

    // R$ 40,00 among three is not a whole number of centavos: the odd one goes to the first.
    await page.getByRole('button', { name: 'Dividir igualmente', exact: true }).click();
    await expectMoneyValue(page, 'Valor da pessoa 1', 13.34, { exact: true });
    await expectMoneyValue(page, 'Valor da pessoa 2', 13.33, { exact: true });
    await expectMoneyValue(page, 'Valor da pessoa 3', 13.33, { exact: true });

    const hojeAntes = diaCivilSaoPaulo(Date.now());
    await page.getByRole('button', { name: 'Gerar links', exact: true }).click();
    await expect.poll(() => backend.criar.length, { timeout: 30_000 }).toBe(1);
    const hojeDepois = diaCivilSaoPaulo(Date.now());

    // The request satisfies the real route's strict contract (parse throws otherwise)…
    const corpo = criarLinksPagamentoBodySchema.parse(backend.criar[0]);
    expect(corpo).toMatchObject({
      pedidoId: fixtures.pedidoId,
      metodoId: fixtures.metodoId,
      modo: MODO_LINK_PAGAMENTO.individual,
      // the total the operator SAW, so the route can refuse a stale one
      valorCobradoEsperado: fixtures.valorCobrado,
      quantidadeMaxima: null,
      preencherPagador: false,
      tiposExcluidos: [],
      parcelasMaximas: null,
    });
    // …with the default deadline: three days from today, in São Paulo.
    expect([somarDias(hojeAntes, 3), somarDias(hojeDepois, 3)]).toContain(corpo.expiraEm);

    // One link per person, in order, splitting exactly what was still available.
    expect(corpo.links.map((l) => l.nomePagador)).toEqual(nomes);
    expect(corpo.links.map((l) => l.valor)).toEqual([13.34, 13.33, 13.33]);
    const somaCentavos = corpo.links.reduce((soma, l) => soma + centavosDeReais(l.valor), 0);
    expect(somaCentavos).toBe(centavosDeReais(fixtures.disponivel));
    // Ids are minted per link: three distinct ones, or a replay would collapse the batch.
    expect(new Set(corpo.links.map((l) => l.linkId)).size).toBe(3);

    // The list picks up the new links from Firestore, each open.
    await expect(page.getByText('3 link(s) gerado(s).')).toBeVisible();
    await expect(linhas(page)).toHaveCount(6, { timeout: 30_000 });
    for (const [i, nome] of nomes.entries()) {
      const linha = linhas(page).filter({ hasText: nome });
      await expect(linha).toHaveCount(1);
      await expect(badge(linha, SITUACAO_LINK_PAGAMENTO_LABELS.aberto)).toBeVisible();
      await expect(linha).toContainText(reais(corpo.links[i]!.valor));
    }
  });

  test('um link: envia o nome, o valor, os tipos de pagamento aceitos e o preenchimento do cliente', async ({
    page,
  }) => {
    const backend = await instalarBackend(page, fixtures);
    await abrirAbaLinks(page);
    await garantirConta(page);

    await typeMoney(page, 'Valor do link', '25', { exact: true });
    await page.getByLabel('Nome do pagador', { exact: true }).fill('Paulo');
    // Turn Pix off: the other three stay accepted. Mantine's thumb sits over the
    // hidden input and the sticky pedido footer covers the bottom of the viewport,
    // so `.uncheck()` on the input never gets a clickable point: center the switch
    // and click its visible label instead (the balanco emulator spec's precedent).
    const pix = page.getByRole('switch', {
      name: TIPO_PAGAMENTO_MP_LABELS[TIPO_PAGAMENTO_MP.pix],
    });
    await pix.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const pixId = await pix.getAttribute('id');
    await page.locator(`label[for="${pixId}"]`).last().click();
    await expect(pix).not.toBeChecked();

    await page.getByRole('button', { name: 'Gerar link', exact: true }).click();
    await expect.poll(() => backend.criar.length, { timeout: 30_000 }).toBe(1);

    const corpo = criarLinksPagamentoBodySchema.parse(backend.criar[0]);
    expect(corpo).toMatchObject({
      pedidoId: fixtures.pedidoId,
      metodoId: fixtures.metodoId,
      modo: MODO_LINK_PAGAMENTO.individual,
      valorCobradoEsperado: fixtures.valorCobrado,
      quantidadeMaxima: null,
      // the pedido has a cliente, so the checkout is prefilled with it
      preencherPagador: true,
      tiposExcluidos: [TIPO_PAGAMENTO_MP.pix],
      parcelasMaximas: null,
    });
    expect(corpo.links).toHaveLength(1);
    expect(corpo.links[0]).toMatchObject({ nomePagador: 'Paulo', valor: 25 });

    await expect(page.getByText('1 link(s) gerado(s).')).toBeVisible();
    const linha = linhas(page).filter({ hasText: 'Paulo' });
    await expect(linha).toHaveCount(1, { timeout: 30_000 });
    await expect(badge(linha, SITUACAO_LINK_PAGAMENTO_LABELS.aberto)).toBeVisible();
  });

  test('repetir após perder a conexão reenvia o mesmo lote; após uma recusa do servidor, gera novos ids', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    // Lose the connection, then get refused, then succeed.
    const backend = await instalarBackend(page, fixtures, ['rede', 'excedeRestante', 'ok']);
    await abrirAbaLinks(page);
    await garantirConta(page);
    await typeMoney(page, 'Valor do link', '10', { exact: true });
    const gerar = page.getByRole('button', { name: 'Gerar link', exact: true });

    await gerar.click();
    await expect(
      page.getByText('Sem conexão com o backend do Mercado Pago. Tente de novo.'),
    ).toBeVisible({ timeout: 30_000 });
    // The failure must not leave the button spinning.
    await expect(gerar).toBeEnabled({ timeout: 30_000 });

    await gerar.click();
    await expect(
      page.getByText(MOTIVO_RECUSA_LINK_LABELS[MOTIVO_RECUSA_LINK.excedeRestante]),
    ).toBeVisible({ timeout: 30_000 });
    await expect(gerar).toBeEnabled({ timeout: 30_000 });

    await gerar.click();
    await expect.poll(() => backend.criar.length, { timeout: 30_000 }).toBe(3);

    const [primeiro, segundo, terceiro] = backend.criar.map((corpo) =>
      criarLinksPagamentoBodySchema.parse(corpo),
    );
    // No response arrived the first time, so the server may already hold the batch: the
    // retry sends it again, byte for byte, and the server recognises the ids as a replay.
    expect(segundo).toEqual(primeiro);
    // The second attempt was ANSWERED (refused), so nothing was created under those ids: a
    // fresh batch gets fresh ids instead of colliding with a link that never existed.
    expect(terceiro!.links.map((l) => l.linkId)).not.toEqual(segundo!.links.map((l) => l.linkId));

    await expect(linhas(page)).toHaveCount(4, { timeout: 30_000 });
  });

  test('conta desconectada: avisa e leva o operador a reconectar', async ({ page }) => {
    const backend = await instalarBackend(page, fixtures, ['reautenticar']);
    await abrirAbaLinks(page);
    await garantirConta(page);
    await typeMoney(page, 'Valor do link', '10', { exact: true });

    await page.getByRole('button', { name: 'Gerar link', exact: true }).click();
    await expect.poll(() => backend.criar.length, { timeout: 30_000 }).toBe(1);

    const reconectar = page.getByRole('link', { name: 'Reconectar conta' });
    await expect(reconectar).toBeVisible({ timeout: 30_000 });
    await expect(reconectar).toHaveAttribute(
      'href',
      `/pagamentos/mercado-pago/${encodeURIComponent(fixtures.metodoId)}`,
    );
    // Nothing was created.
    await expect(linhas(page)).toHaveCount(3);
  });

  test('cancelar um link aberto pede confirmação antes de avisar o Mercado Pago', async ({
    page,
  }) => {
    const backend = await instalarBackend(page, fixtures);
    await abrirAbaLinks(page);
    const joao = linhas(page).filter({ hasText: 'João' });

    await joao.getByRole('button', { name: /^Cancelar/ }).click();
    const dialogo = page.getByRole('dialog');
    // The copy must not promise that nobody can pay any more: an issued Pix may still come in.
    await expect(dialogo).toContainText(/ainda podem ser concluídos/);
    // Asking is not cancelling.
    expect(backend.cancelar).toHaveLength(0);

    await dialogo.getByRole('button', { name: 'Confirmar cancelamento', exact: true }).click();
    await expect.poll(() => backend.cancelar.length, { timeout: 30_000 }).toBe(1);
    expect(cancelarLinkPagamentoBodySchema.parse(backend.cancelar[0])).toEqual({
      pedidoId: fixtures.pedidoId,
      linkId: fixtures.links.joao.id,
    });

    await expect(page.getByText('Link cancelado.')).toBeVisible({ timeout: 30_000 });
    await expect(badge(joao, SITUACAO_LINK_PAGAMENTO_LABELS.cancelado)).toBeVisible({
      timeout: 30_000,
    });
    await expect(joao.getByRole('button', { name: /^Cancelar/ })).toHaveCount(0);
    // Only João's link moved.
    const maria = linhas(page).filter({ hasText: 'Maria' });
    await expect(badge(maria, SITUACAO_LINK_PAGAMENTO_LABELS.pago)).toBeVisible();
  });

  test('sincronizar pede ao Mercado Pago os pagamentos do pedido e libera o botão ao terminar', async ({
    page,
  }) => {
    const backend = await instalarBackend(page, fixtures);
    await abrirAbaLinks(page);

    const sincronizar = page.getByRole('button', {
      name: 'Sincronizar com Mercado Pago',
      exact: true,
    });
    await sincronizar.click();
    await expect.poll(() => backend.sincronizar.length, { timeout: 30_000 }).toBe(1);
    expect(sincronizarLinksPagamentoBodySchema.parse(backend.sincronizar[0])).toEqual({
      pedidoId: fixtures.pedidoId,
    });
    await expect(sincronizar).toBeEnabled({ timeout: 30_000 });
  });

  test('bloqueia a geração enquanto o pedido tem alterações não salvas e preserva o rascunho', async ({
    page,
  }) => {
    await abrirAbaLinks(page);
    await garantirConta(page);
    await typeMoney(page, 'Valor do link', '10', { exact: true });
    const gerar = page.getByRole('button', { name: 'Gerar link', exact: true });
    // The control: a saved pedido and a valid draft leave the button enabled, so what
    // disables it below is the unsaved edit and nothing else.
    await expect(gerar).toBeEnabled({ timeout: 30_000 });

    await page.getByRole('tab', { name: 'Principal' }).click();
    await fillField(page, 'Observações internas', 'edicao-nao-salva');
    await page.getByRole('tab', { name: 'Link Pgto' }).click();

    await expect(
      page.getByText('Há alterações não salvas no pedido. Salve antes de gerar links.'),
    ).toBeVisible();
    await expect(gerar).toBeDisabled();
    // Switching tabs did not throw the half-typed link away.
    await expectMoneyValue(page, 'Valor do link', 10, { exact: true });
  });
});
