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

    // Add one item via the produto picker. Trigger search then pick.
    await page.getByPlaceholder('Adicionar item por busca…').fill(fixtures.produtoNome);
    await page
      .getByRole('option', { name: new RegExp(fixtures.produtoNome) })
      .first()
      .click();

    // The row appears in the items table — set quantidade=2,
    // descontoUnitario=1.5, precoDeVenda=10. The row's NumberInputs
    // carry per-row aria-labels so we can target them deterministically.
    // Mantine NumberInput's default decimal separator is '.', so use a
    // period in the typed text (the displayed value uses the locale's
    // separator, but the input parser expects '.').
    const priceInput = page.getByLabel('Preço item 1', { exact: true });
    const qtyInput = page.getByLabel('Quantidade item 1', { exact: true });
    const discountInput = page.getByLabel('Desconto item 1', { exact: true });
    await priceInput.fill('10');
    await priceInput.blur();
    await qtyInput.fill('2');
    await qtyInput.blur();
    await discountInput.fill('1.5');
    await discountInput.blur();

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

  test('auto-switches PF to PJ and fills nome + IE from the CNPJ lookup in the quick-create modal (#250, #293)', async ({
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
      route.fulfill({ json: { razao_social: RAZAO, uf: 'SP' } }),
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
    // is always clickable (it validates on click). The PJ-only IE field stays
    // hidden until the lookup flips the tipo to PJ.
    const buscar = dialog.getByRole('button', { name: 'Buscar dados do CNPJ' });
    await expect(buscar).toBeVisible();
    await expect(buscar).toBeEnabled();
    await expect(dialog.getByLabel('Inscrição estadual', { exact: true })).toHaveCount(0);

    // Clicking with an empty/invalid CNPJ validates first — shows the message,
    // no API call, no tipo switch.
    await buscar.click();
    await expect(
      dialog.getByText('Informe um CNPJ válido (14 dígitos) para buscar os dados.'),
    ).toBeVisible();

    await dialog.getByLabel('CPF / CNPJ', { exact: true }).fill(cnpj);
    await buscar.click();

    // The lookup switches the tipo to Pessoa Jurídica (a CNPJ ⇒ PJ) and fills
    // nome (BrasilAPI) + the authoritative IE (SEFAZ); the revealed IE shows it.
    await expect(dialog.getByRole('combobox', { name: 'Tipo', exact: true })).toHaveValue(
      'Pessoa Jurídica',
    );
    await expect(dialog.getByLabel('Nome')).toHaveValue(RAZAO);
    await expect(dialog.getByLabel('Inscrição estadual', { exact: true })).toHaveValue(IE);

    // Rename to a run-scoped prefix so afterAll cleanup catches the doc.
    await dialog.getByLabel('Nome').fill(nome);
    await dialog.getByRole('button', { name: 'Criar', exact: true }).click();

    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(nome).first()).toBeVisible({ timeout: 15_000 });

    // Wire assertion (Admin SDK): the created PJ cliente carries the IE.
    await expect.poll(() => docExistsByName('clientes', nome), { timeout: 15_000 }).toBe(true);
    const doc = await getClienteByName(nome);
    expect(doc?.tipo).toBe('1');
    expect(doc?.ie).toBe(IE);
  });
});
