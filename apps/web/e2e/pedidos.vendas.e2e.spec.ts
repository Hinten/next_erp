import { expect, test } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import {
  cleanupPedidoFixtures,
  docExistsByName,
  e2ePrefix,
  getClienteByName,
  runDigits,
  seedPedidoFixtures,
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

    // Override the autofilled price + set quantidade/desconto. Mantine
    // NumberInput's default decimal separator is '.', so type a period.
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

    // Mark the only item for deletion (staged — stays visible+dimmed with a
    // "Será excluída" cue until save). The row is NOT removed from the DOM.
    await page.getByRole('button', { name: 'Remover item' }).first().click();
    await expect(page.getByText('Será excluída').first()).toBeVisible();

    await page.getByRole('button', { name: 'Salvar alterações' }).click();
    await page.waitForURL((url) => /\/pedidos$/.test(url.pathname), { timeout: 30_000 });

    // The saved doc has no items — the staged row was dropped by the resolver.
    await expect
      .poll(
        async () => {
          const snap = await db().collection('pedidos').doc(pedidoId).get();
          const itens = (snap.data() as { itens?: Record<string, unknown[]> }).itens ?? {};
          return Object.keys(itens).length;
        },
        { timeout: 15_000 },
      )
      .toBe(0);
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
});
