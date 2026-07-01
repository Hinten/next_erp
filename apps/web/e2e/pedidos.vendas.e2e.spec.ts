import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import {
  cleanupPedidoFixtures,
  docExistsByName,
  e2ePrefix,
  getClienteByName,
  runDigits,
  seedPedidoFixtures,
  validTestCnpj,
  validTestCpf,
} from './_helpers/seed-data';
import { fillField, selectFieldWithSearch } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/pedidos/novo` + edit flow. Seeds the
 * minimal cliente + operação + integração + produto a pedido needs,
 * then exercises:
 *   - creating a pedido by picking each ref and adding one item via
 *     the produto picker;
 *   - asserting the totals footer renders the expected subtotal;
 *   - landing on the edit URL after save and confirming the doc is
 *     committed (Admin SDK read-back);
 *   - editing `observacoesInternas`, reloading and verifying it
 *     persisted.
 *
 * Runs serially — later steps consume earlier state.
 */
test.describe.serial('Pedidos e2e — novo + editar', () => {
  const prefix = e2ePrefix('ped');
  // Mutable holder for cross-test state — created pedido id from the
  // create step is reused by the edit step.
  const state: { pedidoId?: string } = {};

  let fixtures: Awaited<ReturnType<typeof seedPedidoFixtures>>;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    fixtures = await seedPedidoFixtures(prefix);
    await warmRoutes(browser, ['/pedidos', '/pedidos/novo']);
  });

  test.afterAll(async () => {
    await cleanupPedidoFixtures(prefix);
  });

  test('navigates from the pedidos list to /pedidos/novo', async ({ page }) => {
    await page.goto('/pedidos');
    await page.getByRole('link', { name: 'Novo pedido' }).click();
    await expect(page).toHaveURL(/\/pedidos\/novo$/);
    await expect(page.getByRole('heading', { name: 'Novo pedido' })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('renders /pedidos/novo with empty defaults', async ({ page }) => {
    await page.goto('/pedidos/novo');
    await expect(page.getByRole('heading', { name: 'Novo pedido' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Fiscal' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Frete' })).toBeVisible();
  });

  test('creates a new pedido picking cliente, operação, integração and one item', async ({
    page,
  }) => {
    await page.goto('/pedidos/novo');

    // Cliente picker — CollectionSelect preset; the option's accessible name
    // carries the cpf_cnpj hint line, so match by regex.
    await selectFieldWithSearch(
      page,
      'Cliente',
      fixtures.clienteNome,
      new RegExp(fixtures.clienteNome),
    );

    // Operação picker — Mantine searchable Select exposes role="combobox".
    await page.getByRole('combobox', { name: 'Operação fiscal', exact: true }).click();
    await page.getByRole('option', { name: fixtures.operacaoNome }).click();

    // Integração picker — same shape.
    await page.getByRole('combobox', { name: 'Integração', exact: true }).click();
    await page.getByRole('option', { name: fixtures.integracaoNome }).click();

    // Lista de preços — REQUIRED before adding products: the inline item picker
    // refuses a pick (red notification) without a lista, and uses it to look up
    // the seeded list price.
    await page.getByRole('combobox', { name: 'Lista de preços', exact: true }).click();
    await page.getByRole('option', { name: fixtures.listaNome }).click();

    // Add one item: click "Adicionar produto" to append an empty row, then use
    // the inline per-row picker.
    await page.getByRole('button', { name: 'Adicionar produto' }).click();
    await page.getByPlaceholder('Buscar produto…').fill(fixtures.produtoNome);
    await page
      .getByRole('option', { name: new RegExp(fixtures.produtoNome) })
      .first()
      .click();

    // The pick autofills `precoDeVenda` from the seeded lista (NOT the 0.01
    // placeholder) — assert the displayed price reflects the list value before
    // we override it. The row's NumberInputs carry per-row aria-labels.
    const priceInput = page.getByLabel('Preço item 1', { exact: true });
    const qtyInput = page.getByLabel('Quantidade item 1', { exact: true });
    const discountInput = page.getByLabel('Desconto item 1', { exact: true });
    await expect(priceInput).toHaveValue(/33[.,]5/, { timeout: 15_000 });

    // Slice B: the pedido totals live in a sticky footer. With qty 1 and the
    // autofilled 33,50 price (no desconto/frete), the footer Total reads R$ 33,50.
    const footerTotal = page.getByTestId('footer-total');
    await expect(footerTotal).toHaveText(/33[.,]50/);

    // Override the autofilled price + set quantidade/desconto. These inputs are
    // localized (pt-BR), so the decimal separator is a comma. (Kept contiguous —
    // no tab switch in between, which would remount the Principal tab and race
    // the fills.)
    await priceInput.fill('10');
    await priceInput.blur();
    await qtyInput.fill('2');
    await qtyInput.blur();
    await discountInput.fill('1,5');
    await discountInput.blur();

    // The footer re-derives the total live from the watched item values:
    // (10 − 1,50) × 2 = R$ 17,00. This proves the bar reflects edits, not just
    // the initial autofill.
    await expect(footerTotal).toHaveText(/17[.,]00/);

    // …and the sticky footer (with its total) stays visible on other tabs — it
    // is rendered outside <Tabs>. The Criar button lives in that footer.
    await page.getByRole('tab', { name: 'Fiscal' }).click();
    await expect(footerTotal).toHaveText(/17[.,]00/);

    await page.getByRole('button', { name: 'Criar' }).click();

    // After create we redirect to /pedidos/{id}/editar.
    await page.waitForURL((url) => /\/pedidos\/[^/]+\/editar$/.test(url.pathname), {
      timeout: 30_000,
    });

    const match = page.url().match(/\/pedidos\/([^/]+)\/editar/);
    if (!match) throw new Error(`Unexpected URL after create: ${page.url()}`);
    state.pedidoId = match[1];

    // Confirm the doc actually committed (Admin SDK is strongly
    // consistent) so the next step doesn't race the write.
    await expect
      .poll(
        async () => {
          const snap = await db().collection('pedidos').doc(state.pedidoId!).get();
          return snap.exists;
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // Read back the saved item: the overridden price (10, not the 0.01
    // placeholder) + qty + desconto landed under the produto's group key.
    const snap = await db().collection('pedidos').doc(state.pedidoId!).get();
    const itens = (snap.data() as { itens?: Record<string, unknown[]> }).itens ?? {};
    const produtoId = fixtures.produtoPath.split('/').pop()!;
    const saved = itens[produtoId]?.[0] as
      | { precoDeVenda?: number; quantidade?: number; descontoUnitario?: number }
      | undefined;
    expect(saved?.precoDeVenda).toBe(10);
    expect(saved?.quantidade).toBe(2);
    expect(saved?.descontoUnitario).toBe(1.5);
    // No bogus in-progress 'NONE' group leaked through the resolver.
    expect(itens.NONE).toBeUndefined();
  });

  test('edit page reloads the just-created pedido and persists observações', async ({ page }) => {
    test.skip(!state.pedidoId, 'Create step did not produce a pedido id.');
    const pedidoId = state.pedidoId!;

    await page.goto(`/pedidos/${pedidoId}/editar`);
    // The header now shows the pedido number (or a #id fallback for a
    // numberless pedido); assert the form mounted via its Principal tab.
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({
      timeout: 15_000,
    });

    // Observations textarea — fill, save, reload, assert.
    const obs = `${prefix}-observacao-${Date.now()}`;
    await fillField(page, 'Observações internas', obs);
    await page.getByRole('button', { name: 'Salvar alterações' }).click();

    // Saving an existing pedido redirects back to the list.
    await page.waitForURL((url) => /\/pedidos$/.test(url.pathname), {
      timeout: 30_000,
    });

    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByLabel('Observações internas', { exact: true })).toHaveValue(obs);
  });

  test('staged-deletes an item: the row is excluded from the saved pedido', async ({ page }) => {
    test.skip(!state.pedidoId, 'Create step did not produce a pedido id.');
    const pedidoId = state.pedidoId!;

    await page.goto(`/pedidos/${pedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Principal' })).toBeVisible({ timeout: 15_000 });

    // Add a SECOND line of the same produto. A pedido needs at least one item, so
    // we can't stage the only row down to zero (that save is correctly blocked) —
    // instead keep one and prove the staged one is dropped. The lista de preços
    // was saved on create, so the pick autofills the price (proof the row set).
    await page.getByRole('button', { name: 'Adicionar produto' }).click();
    await page.getByPlaceholder('Buscar produto…').last().fill(fixtures.produtoNome);
    await page
      .getByRole('option', { name: new RegExp(fixtures.produtoNome) })
      .first()
      .click();
    await expect(page.getByLabel('Preço item 2', { exact: true })).toHaveValue(/33[.,]5/, {
      timeout: 15_000,
    });

    // Stage-delete the FIRST row (stays visible+dimmed with a "Será excluída" cue
    // until save). The row is NOT removed from the DOM.
    await page.getByRole('button', { name: 'Remover item' }).first().click();
    await expect(page.getByText('Será excluída').first()).toBeVisible();

    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    await page.waitForURL((url) => /\/pedidos$/.test(url.pathname), { timeout: 30_000 });

    // The saved doc keeps exactly one item — the staged row was dropped by the
    // resolver (both rows share the produto, so they collapse under one key).
    await expect
      .poll(
        async () => {
          const snap = await db().collection('pedidos').doc(pedidoId).get();
          const itens = (snap.data() as { itens?: Record<string, unknown[]> }).itens ?? {};
          return Object.values(itens).reduce((n, arr) => n + arr.length, 0);
        },
        { timeout: 15_000 },
      )
      .toBe(1);
  });

  test('creates a cliente through the quick-create modal and emits it into the form', async ({
    page,
  }, testInfo) => {
    // Run+retry-unique identity values. The staging `clientes` collection is
    // shared (runs isolate by nome prefix only) and holds long-lived dev
    // seeds, and a failed attempt may leave its created doc behind until
    // afterAll — a fixed CPF/telefone/nome would trip the modal's own dedup
    // (blocking alert or "Criar mesmo assim" review) and the dialog would
    // never close.
    const nome = `${prefix}-qc-${testInfo.retry}`;
    const cpf = validTestCpf(Number(runDigits(7)) * 10 + testInfo.retry);
    const telefone = `11${cpf.slice(0, 9)}`;
    await page.goto('/pedidos/novo');

    // `.first()` — the Frete tab keeps a second (hidden) ClientePicker
    // mounted, so the role query would otherwise be ambiguous.
    await page.getByRole('button', { name: '+ Novo cliente' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Nome is `required` — Mantine puts the asterisk inside the label
    // ("Nome *"), so an exact getByLabel never matches (same caveat as the
    // login fields in _helpers/auth.ts). The dialog scope keeps the
    // substring match unambiguous.
    await dialog.getByLabel('Nome').fill(nome);
    await dialog.getByLabel('CPF / CNPJ', { exact: true }).fill(cpf);
    await dialog.getByLabel('E-mail', { exact: true }).fill(`${nome}@example.com`);
    await dialog.getByLabel('Telefone', { exact: true }).fill(telefone);
    await dialog.getByRole('button', { name: 'Criar', exact: true }).click();

    // The modal resolves and the picker locks onto the new cliente.
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(nome).first()).toBeVisible({ timeout: 15_000 });

    // Wire assertions (Admin SDK): doc committed, telefone stored in the
    // standardized wa_id shape (55 + DDD + number), cpf_cnpj as typed.
    await expect.poll(() => docExistsByName('clientes', nome), { timeout: 15_000 }).toBe(true);
    const doc = await getClienteByName(nome);
    expect(doc?.telefone).toBe(`55${telefone}`);
    expect(doc?.cpf_cnpj).toBe(cpf);
    expect(doc?.tipo).toBe('0');
  });

  test('blocks a duplicate CPF/CNPJ in the quick-create modal and offers the existing cliente', async ({
    page,
  }) => {
    await page.goto('/pedidos/novo');

    await page.getByRole('button', { name: '+ Novo cliente' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Non-exact: the required asterisk lives inside the Nome label.
    await dialog.getByLabel('Nome').fill(`${prefix}-qc-dup`);
    // The seeded pedido fixture cliente owns this run-unique CNPJ, so it is
    // the only blocking candidate — blur triggers the debounced dedup check
    // and the blocking alert.
    await dialog.getByLabel('CPF / CNPJ', { exact: true }).fill(fixtures.clienteCpfCnpj);
    await dialog.getByLabel('CPF / CNPJ', { exact: true }).blur();

    await expect(dialog.getByText('Cliente já cadastrado')).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole('button', { name: 'Criar', exact: true })).toBeDisabled();

    // Resolve with the existing cliente instead — the picker locks onto it.
    await dialog.getByRole('button', { name: 'Usar cliente existente' }).first().click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(fixtures.clienteNome).first()).toBeVisible({ timeout: 15_000 });
  });

  test('auto-switches PF to PJ, fills nome + IE, and offers the resolved endereço from the CNPJ lookup (#250, #293, #294)', async ({
    page,
  }, testInfo) => {
    const RAZAO = 'EMPRESA QUICK CREATE LTDA';
    const IE = '111222333444';
    // Run+retry-unique CNPJ, DISTINCT from the seeded fixture cliente's
    // `validTestCnpj(runDigits(12))` — reusing that value would make the fixture
    // an exact cpf_cnpj match and block the create (dialog never closes).
    // Mirrors the PF quick-create test's retry-scoped identity derivation.
    const cnpj = validTestCnpj(String(Number(runDigits(11)) * 10 + testInfo.retry));
    const nome = `${prefix}-qc-pj-${testInfo.retry}`;

    // The lookup hits two external services unavailable from staging — stub
    // both at the network layer. BrasilAPI fills razão social; the apps/nfe
    // Consulta Cadastro route returns a habilitada inscrição so the PJ-only IE
    // field fills deterministically.
    await page.route('https://brasilapi.com.br/api/cnpj/v1/**', (route) =>
      route.fulfill({
        json: {
          razao_social: RAZAO,
          descricao_tipo_de_logradouro: 'AVENIDA',
          logradouro: 'PAULISTA',
          numero: '1000',
          bairro: 'BELA VISTA',
          cep: '01310100',
          municipio: 'SAO PAULO',
          uf: 'SP',
          codigo_municipio_ibge: 3550308,
        },
      }),
    );
    await page.route('**/api/nfe/consulta-cadastro*', (route) =>
      route.fulfill({
        json: {
          supported: true,
          uf: 'SP',
          cStat: '111',
          xMotivo: 'Consulta cadastro com uma ocorrência',
          infCad: [
            { ie: IE, cnpj, cpf: null, uf: 'SP', situacao: '1', razaoSocial: RAZAO, ender: null },
          ],
        },
      }),
    );

    await page.goto('/pedidos/novo');
    await page.getByRole('button', { name: '+ Novo cliente' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // #293: the lookup button shows for the DEFAULT Pessoa Física tipo too and
    // is always clickable. The PJ-only IE field stays hidden until the lookup
    // flips the tipo to PJ. (The validate-on-click feedback for an invalid CNPJ
    // is covered by clientes-cnpj.cadastros — the modal surfaces it as a toast.)
    const buscar = dialog.getByRole('button', { name: 'Buscar dados do CNPJ' });
    await expect(buscar).toBeVisible();
    await expect(buscar).toBeEnabled();
    await expect(dialog.getByLabel('Inscrição estadual', { exact: true })).toHaveCount(0);

    await dialog.getByLabel('CPF / CNPJ', { exact: true }).fill(cnpj);

    // The SEFAZ leg of the lookup needs the default filial id, which an async
    // query (useDefaultFilialId) resolves on modal mount. If the first click
    // lands before it settles, the best-effort SEFAZ call is skipped and the IE
    // stays blank — so retry the lookup until the IE fills (nome/tipo writes are
    // idempotent). Mirrors the product's best-effort SEFAZ behavior.
    const ieField = dialog.getByLabel('Inscrição estadual', { exact: true });
    await expect(async () => {
      await buscar.click();
      await expect(ieField).toHaveValue(IE, { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });

    // The lookup switched the tipo to Pessoa Jurídica (a CNPJ ⇒ PJ) and filled
    // nome (BrasilAPI) + the authoritative IE (SEFAZ).
    await expect(dialog.getByRole('combobox', { name: 'Tipo', exact: true })).toHaveValue(
      'Pessoa Jurídica',
    );
    await expect(dialog.getByLabel('Nome')).toHaveValue(RAZAO);

    // #294/#341: the lookup returned an address → the modal shows the "endereço
    // encontrado" hint; after Criar it opens the endereço review IN PLACE.
    await expect(dialog.getByText('Endereço encontrado')).toBeVisible();

    // Rename to a run-scoped prefix so afterAll cleanup catches the doc.
    await dialog.getByLabel('Nome').fill(nome);
    await dialog.getByRole('button', { name: 'Criar', exact: true }).click();

    // #341: the resolved address is reviewed in place — the prefilled "Novo
    // endereço" modal opens (no new-tab relay). Save it, then the cliente is
    // emitted into the pedido.
    const endereco = page.getByRole('dialog', { name: 'Novo endereço' });
    await expect(endereco.getByLabel('Logradouro', { exact: true })).toHaveValue(
      'AVENIDA PAULISTA',
      { timeout: 15_000 },
    );
    await endereco.getByRole('button', { name: 'Criar', exact: true }).click();
    await expect(endereco).toBeHidden({ timeout: 15_000 });

    // The cliente is now selected in the pedido form.
    await expect(page.getByText(nome).first()).toBeVisible({ timeout: 15_000 });

    // Wire assertion (Admin SDK): the created PJ cliente carries the IE...
    await expect.poll(() => docExistsByName('clientes', nome), { timeout: 15_000 }).toBe(true);
    const doc = await getClienteByName(nome);
    expect(doc?.tipo).toBe('1');
    expect(doc?.ie).toBe(IE);

    // ...and the reviewed endereço was written to the cliente's subcollection.
    const cliId = (await db().collection('clientes').where('nome', '==', nome).limit(1).get())
      .docs[0]?.id;
    if (!cliId) throw new Error('created cliente not found for endereço assertion');
    await expect
      .poll(
        async () => {
          const snap = await db().collection('clientes').doc(cliId).collection('enderecos').get();
          return snap.docs.some((d) =>
            String(d.data().logradouro ?? '').includes('AVENIDA PAULISTA'),
          );
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  });
});
