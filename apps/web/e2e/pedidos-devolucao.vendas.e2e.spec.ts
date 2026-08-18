import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import {
  cleanupByFieldPrefix,
  cleanupDevolucoesLinkedTo,
  cleanupPedidoFixtures,
  cleanupPedidoSubcollection,
  e2ePrefix,
  linkIntegracaoOperacaoDevolucao,
  runDigits,
  seedNfeForPedido,
  seedOperacaoEntrada,
  seedPedidoFixtures,
} from './_helpers/seed-data';
import { fillField } from './helpers/object-view';
import {
  applyTextFilter,
  expectEmptyState,
  expectRowHidden,
  expectRowVisible,
  selectRowByText,
} from './helpers/table-view';
import { warmRoutes } from './helpers/warmup';

/**
 * E2E for the devolução/entradas surface.
 *
 * First describe — the Devolução tab + the save-time devolução flows:
 *  - Mode A: pick a paid ORIGIN order → its items are cloned as return rows.
 *  - Mode B: add an AVULSO item → pick a produto + price/qty.
 *  - #488: a NEW saída with committed return rows walks the dialog chain on
 *    Criar and creates the entrada devolução + the troca incidente atomically.
 *  - #551: the saída list's "Devolução integral" action pre-seeds the entrada
 *    create form from the origin (no save — read-only smoke).
 * Seeds the current pedido + a paid origin pedido via the Admin SDK.
 *
 * Second describe — the `/pedidos/entradas` slice: list separation by
 * `ehSaida`, the entrada create/edit round-trip, tab visibility, the NF filter
 * composing with the direction slice, and the saída-only action gating.
 */
test.describe.serial('Pedidos e2e — Devolução', () => {
  const prefix = e2ePrefix('peddev');
  const pedidoId = `${prefix}-001`;
  const originId = `${prefix}-orig`;
  const originNumero = `${prefix}-ORIG`;
  // Deterministic 44-digit chave of the origin's APROVADA NF-e — the #488
  // devolução must copy it into `chNFeReferenciadas`.
  const originChave = '4'.repeat(44);
  let fixtures: Awaited<ReturnType<typeof seedPedidoFixtures>>;
  let produtoId: string;
  let entradaOp: { id: string; nome: string };

  function pedidoBody(extra: Record<string, unknown>) {
    return {
      ehSaida: true,
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
            quantidade: 2,
            custo: null,
          },
        ],
      },
      itensIds: [produtoId],
      descontoTotal: 0,
      valorCobrado: 20,
      timestamp: Date.now() * 1000,
      ...extra,
    };
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    fixtures = await seedPedidoFixtures(prefix);
    produtoId = fixtures.produtoPath.split('/')[1]!;

    // The pedido being edited, and a PAID origin order to return from.
    await db()
      .collection('pedidos')
      .doc(pedidoId)
      .set(pedidoBody({ estado: 'iniciado' }));
    await db()
      .collection('pedidos')
      .doc(originId)
      .set(pedidoBody({ estado: 'pago', numero: originNumero }));

    // #488/#551 fixtures: an entrada devolução operação (fiscal, finNFe 4),
    // an APROVADA NF-e on the paid origin (its chave rides the devolução's
    // `chNFeReferenciadas`), and the integração wired to that operação via
    // `operacaoDevolucaoOuterRef` so the resolution is deterministic on the
    // shared staging project (no fallback to whatever default entrada
    // operação other suites seeded).
    entradaOp = await seedOperacaoEntrada(prefix, 'opdev');
    await seedNfeForPedido(originId, `${originId}-nfe`, { estado: 'a', chave: originChave });
    await linkIntegracaoOperacaoDevolucao(fixtures.integracaoPath.split('/')[1]!, entradaOp.id);

    await warmRoutes(browser, ['/pedidos', '/pedidos/novo', '/pedidos/entradas/novo']);
  });

  // Each test starts from a clean returns map on the edited pedido.
  test.beforeEach(async () => {
    await db().collection('pedidos').doc(pedidoId).update({ itensDevolvidos: null });
  });

  test.afterAll(async () => {
    // #488 leftovers first (covers every retry attempt): each devolução linked
    // to the origin, and each troca saída linked to that devolução. Neither
    // carries the run prefix in `numero` (both get minted 'E2E-…' numeros from
    // the counter), so they are found via the link fields, not a prefix sweep.
    await cleanupDevolucoesLinkedTo(originId);
    // The origin accumulated subcollection docs (the seeded aprovada NF-e and
    // the troca incidentes — one from mode A's re-save, one per #488 create).
    // Firestore never cascades, so sweep them before deleting the doc.
    await cleanupPedidoSubcollection(originId, 'nfev4');
    await cleanupPedidoSubcollection(originId, 'incidentes');
    await db().collection('pedidos').doc(originId).delete();
    await db().collection('pedidos').doc(pedidoId).delete();
    await cleanupPedidoFixtures(prefix);
  });

  test('Mode A — clones a paid origin order and persists itensDevolvidos on save', async ({
    page,
  }) => {
    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('tab', { name: 'Devolução' }).click();

    // Open the origin picker, search the paid order by número and add it.
    await page.getByRole('button', { name: '+ Adicionar pedido' }).click();
    await page.getByLabel('Buscar por número').fill(originNumero);
    await page.getByRole('button', { name: `Adicionar ${originNumero}` }).click();
    await page.getByRole('button', { name: 'Fechar' }).click();

    // The cloned row appears (qty = origin sold qty 2); reduce it to 1.
    const qty = page.getByLabel(`Quantidade devolvida de ${fixtures.produtoNome}`);
    await expect(qty).toBeVisible({ timeout: 15_000 });
    await qty.fill('1');

    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    await page.waitForURL((url) => /\/pedidos$/.test(url.pathname), { timeout: 30_000 });

    await expect
      .poll(
        async () => {
          const data = (await db().collection('pedidos').doc(pedidoId).get()).data();
          const dev = data?.itensDevolvidos as
            | Record<string, Record<string, Array<{ quantidade?: number; precoDeVenda?: number }>>>
            | null
            | undefined;
          const item = dev?.[originId]?.[produtoId]?.[0];
          // The money is asserted at its SOURCE, not through a cache: the
          // pedido-level `valorDevolucao` was removed (#796) because it was a
          // pure function of these items. `derivePedidoTotals` still computes it
          // for the footer, and `totals.test.ts` pins that arithmetic.
          return { qty: item?.quantidade ?? null, preco: item?.precoDeVenda ?? null };
        },
        { timeout: 15_000 },
      )
      .toEqual({ qty: 1, preco: 10 });
  });

  test('Mode B — adds an avulso produto and persists it under NONE', async ({ page }) => {
    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('tab', { name: 'Devolução' }).click();

    // Add an avulso row, pick the produto fixture, set price = 10.
    await page.getByRole('button', { name: '+ Produto avulso' }).click();
    await page.getByPlaceholder('Buscar produto avulso…').fill(fixtures.produtoNome);
    await page.getByRole('option', { name: new RegExp(fixtures.produtoNome) }).click();
    await page.getByLabel(`Preço de ${fixtures.produtoNome}`).fill('10');

    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    await page.waitForURL((url) => /\/pedidos$/.test(url.pathname), { timeout: 30_000 });

    await expect
      .poll(
        async () => {
          const data = (await db().collection('pedidos').doc(pedidoId).get()).data();
          const dev = data?.itensDevolvidos as
            | Record<string, Record<string, Array<{ quantidade?: number; precoDeVenda?: number }>>>
            | null
            | undefined;
          const item = dev?.NONE?.[produtoId]?.[0];
          return item ? { quantidade: item.quantidade, precoDeVenda: item.precoDeVenda } : null;
        },
        { timeout: 15_000 },
      )
      .toEqual({ quantidade: 1, precoDeVenda: 10 });
  });

  test('#488 — new saída with devolução rows creates the entrada pedido + troca incident', async ({
    page,
  }) => {
    // Many real staging round-trips (form fill + dialog chain + transaction).
    test.setTimeout(120_000);

    await page.goto('/pedidos/novo');
    await expect(page.getByRole('heading', { name: 'Novo pedido' })).toBeVisible({
      timeout: 15_000,
    });

    // Minimum valid saída (mirrors pedidos.vendas): operação (numero prefix),
    // integração (required), lista (enables the item picker) and one item.
    await page.getByRole('combobox', { name: 'Operação fiscal', exact: true }).click();
    await page.getByRole('option', { name: fixtures.operacaoNome }).click();
    await page.getByRole('combobox', { name: 'Integração', exact: true }).click();
    await page.getByRole('option', { name: fixtures.integracaoNome }).click();
    await page.getByRole('combobox', { name: 'Lista de preços', exact: true }).click();
    await page.getByRole('option', { name: fixtures.listaNome }).click();
    await page.getByRole('button', { name: 'Adicionar produto' }).click();
    await page.getByPlaceholder('Buscar produto…').fill(fixtures.produtoNome);
    await page
      .getByRole('option', { name: new RegExp(fixtures.produtoNome) })
      .first()
      .click();
    // The pick landed (price autofilled from the seeded lista).
    await expect(page.getByLabel('Preço item 1', { exact: true })).toHaveValue(/33[.,]5/, {
      timeout: 15_000,
    });

    // Devolução tab: add the paid origin (mode A) and keep the cloned row at
    // the full sold quantity (2).
    await page.getByRole('tab', { name: 'Devolução' }).click();
    await page.getByRole('button', { name: '+ Adicionar pedido' }).click();
    await page.getByLabel('Buscar por número').fill(originNumero);
    await page.getByRole('button', { name: `Adicionar ${originNumero}` }).click();
    await page.getByRole('button', { name: 'Fechar' }).click();
    await expect(page.getByLabel(`Quantidade devolvida de ${fixtures.produtoNome}`)).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: 'Criar' }).click();

    // #488 dialog chain. A Playwright retry can find the origin already linked
    // to a previous attempt's devolução — answer the optional duplicate guard
    // first, then confirm the devolução and decline the NF-e emission (no NF-e
    // server on staging).
    const dupDialog = page.getByRole('dialog').filter({ hasText: 'Já existe uma devolução' });
    const criarDialog = page
      .getByRole('dialog')
      .filter({ hasText: 'Deseja criar uma devolução para os itens devolvidos?' });
    await expect(criarDialog.or(dupDialog)).toBeVisible({ timeout: 20_000 });
    if (await dupDialog.isVisible()) {
      await dupDialog.getByRole('button', { name: 'Sim' }).click();
    }
    await expect(criarDialog).toBeVisible({ timeout: 20_000 });
    await criarDialog.getByRole('button', { name: 'Sim' }).click();

    const nfeDialog = page
      .getByRole('dialog')
      .filter({ hasText: 'Deseja emitir uma NF-e para a devolução?' });
    await expect(nfeDialog).toBeVisible({ timeout: 20_000 });
    await nfeDialog.getByRole('button', { name: 'Não' }).click();

    // The saída commits and the page lands on its edit route.
    await page.waitForURL((url) => /\/pedidos\/[^/]+\/editar$/.test(url.pathname), {
      timeout: 30_000,
    });
    const match = page.url().match(/\/pedidos\/([^/]+)\/editar/);
    if (!match) throw new Error(`Unexpected URL after create: ${page.url()}`);
    const saidaId = match[1]!;

    // The saída links exactly the created devolução.
    let devolucaoId = '';
    await expect
      .poll(
        async () => {
          const saida = (await db().collection('pedidos').doc(saidaId).get()).data();
          const rel = saida?.entradasRelacionadas;
          devolucaoId = Array.isArray(rel) && typeof rel[0] === 'string' ? rel[0] : '';
          return Array.isArray(rel) ? rel.length : null;
        },
        { timeout: 15_000 },
      )
      .toBe(1);

    // The devolução entrada is findable via the Admin query on the origin link
    // and carries the ported #488 shape.
    const devolucoes = await db()
      .collection('pedidos')
      .where('saidasRelacionadas', 'array-contains', originId)
      .get();
    expect(devolucoes.docs.map((d) => d.id)).toContain(devolucaoId);
    const dev = devolucoes.docs.find((d) => d.id === devolucaoId)!.data();
    expect(dev.ehSaida).toBe(false);
    expect(dev.estado).toBe('pago');
    expect(dev.chNFeReferenciadas).toEqual([originChave]);
    expect(dev.saidasRelacionadas).toEqual([originId]);
    // Numero minted from the devolução operação's nome prefix.
    const entradaPrefix = entradaOp.nome.slice(0, 3).toUpperCase();
    expect(String(dev.numero)).toMatch(new RegExp(`^${entradaPrefix}-\\d{6}$`));
    // Items cloned from the committed return rows (full sold qty of the produto).
    const devItens = dev.itens as Record<string, Array<{ quantidade?: number }>>;
    expect(devItens[produtoId]?.[0]?.quantidade).toBe(2);

    // The origin gained the devolução link…
    await expect
      .poll(
        async () => {
          const origin = (await db().collection('pedidos').doc(originId).get()).data();
          const rel = origin?.entradasRelacionadas;
          return Array.isArray(rel) && rel.includes(devolucaoId);
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // …and exactly one troca incidente pointing back at THIS saída (scoped by
    // externalId — mode A's re-save already left one for the edited pedido).
    await expect
      .poll(
        async () => {
          const snap = await db()
            .collection('pedidos')
            .doc(originId)
            .collection('incidentes')
            .where('externalId', '==', saidaId)
            .get();
          return snap.docs.map((d) => {
            const i = d.data();
            return { tipo: i.tipo, origem: i.origem, motivo: i.motivoDoIncidente };
          });
        },
        { timeout: 15_000 },
      )
      .toEqual([
        {
          tipo: 't',
          origem: 3,
          motivo: expect.stringMatching(/^Troca criada com o pedido #/),
        },
      ]);
  });

  test('#551 — "Devolução integral" pre-seeds the entrada create from the origin (no save)', async ({
    page,
  }) => {
    await page.goto('/pedidos');
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });

    // Narrow to the paid origin, select it, run the saída-only action.
    await applyTextFilter(page, 'Número', originNumero);
    await expectRowVisible(page, originNumero);
    await selectRowByText(page, originNumero);
    await page.getByRole('button', { name: 'Devolução integral', exact: true }).click();

    await page.waitForURL(
      (url) =>
        url.pathname.endsWith('/pedidos/entradas/novo') &&
        url.searchParams.get('devolucaoDe') === originId,
      { timeout: 30_000 },
    );

    // The entrada surface + the pre-seeded form.
    await expect(page.locator('[data-direcao="entrada"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Nova entrada' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(`Devolução integral do pedido ${originNumero}`)).toBeVisible({
      timeout: 15_000,
    });
    // The origin's item was cloned into the itens list…
    await expect(page.getByText(fixtures.produtoNome).first()).toBeVisible({ timeout: 15_000 });
    // …and the devolução operação (via the integração's ref) is preselected.
    await expect(page.getByRole('combobox', { name: 'Operação fiscal', exact: true })).toHaveValue(
      entradaOp.nome,
      { timeout: 15_000 },
    );
    // NO save — keeps runtime + staging writes low (#488 covers the commit).
  });
});

/**
 * The `/pedidos/entradas` slice (#551 surface): list separation by `ehSaida`,
 * entrada create/edit round-trip, tab visibility, NF-filter composition with
 * the direction slice and saída-only action gating. Own fixture prefix so the
 * two describes stay hermetic even when Playwright schedules them in parallel
 * workers.
 */
test.describe.serial('Entradas — lista + criação + distinção visual', () => {
  const prefix = e2ePrefix('pedent');
  const saiId = `${prefix}-SAI-001`;
  const entId = `${prefix}-ENT-001`;
  // Run-unique NF numeração: the NF filter resolves through a nfev4
  // collection-group lookup (staging-wide), so the fixed `numeracao: 1` the
  // other suites seed would collide across concurrent runs/specs.
  const nfNumeracao = Number(runDigits(9));
  const state: { entradaId?: string } = {};
  let fixtures: Awaited<ReturnType<typeof seedPedidoFixtures>>;
  let entradaOp: { id: string; nome: string };
  let produtoId: string;

  function pedidoBody(numero: string, ehSaida: boolean, estado: string) {
    return {
      ehSaida,
      estado,
      numero,
      integracaoPedidoOuterRef: `documents/${fixtures.integracaoPath}`,
      clientePedidoOuterRef: `documents/${fixtures.clientePath}`,
      operacaoPedidoOuterRef: null,
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
    };
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    fixtures = await seedPedidoFixtures(prefix);
    produtoId = fixtures.produtoPath.split('/')[1]!;
    entradaOp = await seedOperacaoEntrada(prefix, 'opent');

    // One saída + one entrada sharing the prefix, and an NF-e on the SAÍDA so
    // the NF filter has a direction-crossing match to prove composition.
    await db()
      .collection('pedidos')
      .doc(saiId)
      .set(pedidoBody(saiId, true, 'pago'));
    await db()
      .collection('pedidos')
      .doc(entId)
      .set(pedidoBody(entId, false, 'iniciado'));
    await seedNfeForPedido(saiId, `${saiId}-nfe`, { estado: '0', numeracao: nfNumeracao });

    await warmRoutes(browser, ['/pedidos', '/pedidos/entradas', '/pedidos/entradas/novo']);
  });

  test.afterAll(async () => {
    // The UI-created entrada mints an 'E2E-…' numero (outside the numero
    // prefix sweep); both the create and the edit fill its observações with
    // the run prefix, so this field sweep catches it on any retry attempt.
    await cleanupByFieldPrefix('pedidos', 'observacoesInternas', prefix);
    await cleanupPedidoSubcollection(saiId, 'nfev4');
    await cleanupPedidoFixtures(prefix);
  });

  test('lists split by direction: /pedidos/entradas shows entradas, /pedidos shows saídas', async ({
    page,
  }) => {
    await page.goto('/pedidos/entradas');
    await expect(page.getByRole('heading', { name: 'Entradas' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-direcao="entrada"]')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Nova entrada' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await applyTextFilter(page, 'Número', prefix);
    await expectRowVisible(page, entId);
    await expectRowHidden(page, saiId);

    await page.goto('/pedidos');
    await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-direcao="entrada"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Novo pedido' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await applyTextFilter(page, 'Número', prefix);
    await expectRowVisible(page, saiId);
    await expectRowHidden(page, entId);
  });

  test('creates an entrada via /pedidos/entradas/novo (saída-only tabs hidden, tipo-0 operações)', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/pedidos/entradas/novo');
    await expect(page.getByRole('heading', { name: 'Nova entrada' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[data-direcao="entrada"]')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible();
    // Saída-only tabs are not rendered on an entrada.
    await expect(page.getByRole('tab', { name: 'Devolução' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Incidentes' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Link Pgto' })).toHaveCount(0);

    // The operação picker lists only tipo==0 (entrada) operações: the seeded
    // entrada op is offered; the fixture SAÍDA op is not.
    await page.getByRole('combobox', { name: 'Operação fiscal', exact: true }).click();
    await expect(page.getByRole('option', { name: entradaOp.nome })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('option', { name: fixtures.operacaoNome })).toHaveCount(0);
    await page.getByRole('option', { name: entradaOp.nome }).click();

    // Minimum valid entrada: integração + lista + one item. Observações carry
    // the run prefix so the teardown sweep finds this UI-created doc.
    await page.getByRole('combobox', { name: 'Integração', exact: true }).click();
    await page.getByRole('option', { name: fixtures.integracaoNome }).click();
    await page.getByRole('combobox', { name: 'Lista de preços', exact: true }).click();
    await page.getByRole('option', { name: fixtures.listaNome }).click();
    await page.getByRole('button', { name: 'Adicionar produto' }).click();
    await page.getByPlaceholder('Buscar produto…').fill(fixtures.produtoNome);
    await page
      .getByRole('option', { name: new RegExp(fixtures.produtoNome) })
      .first()
      .click();
    await expect(page.getByLabel('Preço item 1', { exact: true })).toHaveValue(/33[.,]5/, {
      timeout: 15_000,
    });
    await fillField(page, 'Observações internas', `${prefix}-nova-entrada`);

    await page.getByRole('button', { name: 'Criar' }).click();
    await page.waitForURL((url) => /\/pedidos\/entradas\/[^/]+\/editar$/.test(url.pathname), {
      timeout: 30_000,
    });
    const match = page.url().match(/\/pedidos\/entradas\/([^/]+)\/editar/);
    if (!match) throw new Error(`Unexpected URL after create: ${page.url()}`);
    state.entradaId = match[1];

    // Wire assertion: the doc committed as an entrada, numero minted from the
    // entrada operação's nome prefix.
    const entradaPrefix = entradaOp.nome.slice(0, 3).toUpperCase();
    await expect
      .poll(
        async () => {
          const data = (await db().collection('pedidos').doc(state.entradaId!).get()).data();
          if (!data) return null;
          return {
            ehSaida: data.ehSaida,
            numeroOk: new RegExp(`^${entradaPrefix}-\\d{6}$`).test(String(data.numero)),
          };
        },
        { timeout: 15_000 },
      )
      .toEqual({ ehSaida: false, numeroOk: true });
  });

  test('entrada edit round-trip: "Entrada …" title, saves observações, returns to /pedidos/entradas', async ({
    page,
  }) => {
    test.skip(!state.entradaId, 'Create step did not produce an entrada id.');
    const entradaId = state.entradaId!;

    await page.goto(`/pedidos/entradas/${entradaId}/editar`);
    await expect(page.getByRole('heading', { name: /^Entrada / })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[data-direcao="entrada"]')).toBeVisible();

    const obs = `${prefix}-obs-editada`;
    await fillField(page, 'Observações internas', obs);
    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    await page.waitForURL((url) => /\/pedidos\/entradas$/.test(url.pathname), { timeout: 30_000 });

    await expect
      .poll(
        async () =>
          (await db().collection('pedidos').doc(entradaId).get()).data()?.observacoesInternas ??
          null,
        { timeout: 15_000 },
      )
      .toBe(obs);
  });

  test('NF filter composes with the direction slice', async ({ page }) => {
    // The NF-e belongs to the SAÍDA: on /pedidos/entradas the same número must
    // yield the empty state (lookup ids ∩ ehSaida==false = ∅)…
    await page.goto('/pedidos/entradas');
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Filtrar NF', exact: true }).click();
    await page.getByLabel('Número da NF', { exact: true }).fill(String(nfNumeracao));
    await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
    await expectEmptyState(page);

    // …and on /pedidos it resolves to exactly the seeded saída.
    await page.goto('/pedidos');
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Filtrar NF', exact: true }).click();
    await page.getByLabel('Número da NF', { exact: true }).fill(String(nfNumeracao));
    await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
    await expectRowVisible(page, saiId);
  });

  test('"Devolução integral" is saída-only: hidden on the entradas list', async ({ page }) => {
    await page.goto('/pedidos/entradas');
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await applyTextFilter(page, 'Número', prefix);
    await expectRowVisible(page, entId);
    await selectRowByText(page, entId);

    // The shared bulk actions stay; the saída-only action is not wired in.
    await expect(page.getByRole('button', { name: 'Emitir NF-e', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Devolução integral', exact: true })).toHaveCount(
      0,
    );
  });
});
