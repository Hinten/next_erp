import { expect, test, type Page } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import {
  cleanupPedidoFreteFixtures,
  e2ePrefix,
  seedPedidoFreteFixtures,
} from './_helpers/seed-data';
import { selectField, selectFieldWithSearch } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/** Pick an option in a Mantine Select when the option label needs a regex. */
async function selectFieldMatching(page: Page, label: string, option: RegExp): Promise<void> {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option }).click();
}

/**
 * End-to-end coverage for the pedido **Frete tab** (F3 of the freight
 * port). Wire-shape parity with the legacy Flutter app is the point of
 * these tests, so the assertions read the saved pedido back through the
 * Admin SDK and check exact values:
 *   - `integracaoFreteOuterRef` / `enderecoFreteOuterReference` are plain
 *     `documents/...` STRINGS (Flutter `OuterRefField.toJson`);
 *   - motoboy `externalOptionId` is the Dart optionString with the
 *     mandatory `.0` on integral doubles;
 *   - the money caches (`valorFreteInicial` / `custoFreteInicial` /
 *     `valorCobrado`) follow the legacy `Pedido.total` / factory formulas.
 */
test.describe.serial('Pedidos — aba Frete', () => {
  const prefix = e2ePrefix('pfr');

  let fixtures: Awaited<ReturnType<typeof seedPedidoFreteFixtures>>;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    fixtures = await seedPedidoFreteFixtures(prefix);
    await warmRoutes(browser, ['/pedidos/novo']);
  });

  test.afterAll(async () => {
    await cleanupPedidoFreteFixtures(prefix);
  });

  /** Fill the Principal tab: cliente + operação + integração + one item. */
  async function fillPrincipal(page: Page, precoItem: string) {
    await selectFieldWithSearch(
      page,
      'Cliente',
      fixtures.base.clienteNome,
      new RegExp(fixtures.base.clienteNome),
    );
    await page.getByRole('combobox', { name: 'Operação fiscal', exact: true }).click();
    await page.getByRole('option', { name: fixtures.base.operacaoNome }).click();
    await page.getByRole('combobox', { name: 'Integração', exact: true }).click();
    await page.getByRole('option', { name: fixtures.base.integracaoNome }).click();
    await page.getByPlaceholder('Adicionar item por busca…').fill(fixtures.base.produtoNome);
    await page
      .getByRole('option', { name: new RegExp(fixtures.base.produtoNome) })
      .first()
      .click();
    const priceInput = page.getByLabel('Preço item 1', { exact: true });
    await priceInput.fill(precoItem);
    await priceInput.blur();
  }

  async function createAndReadBack(page: Page): Promise<Record<string, unknown>> {
    await page.getByRole('button', { name: 'Criar' }).click();
    await page.waitForURL((url) => /\/pedidos\/[^/]+\/editar$/.test(url.pathname), {
      timeout: 30_000,
    });
    const pedidoId = page.url().match(/\/pedidos\/([^/]+)\/editar/)?.[1];
    if (!pedidoId) throw new Error(`Unexpected URL after create: ${page.url()}`);
    let data: Record<string, unknown> | undefined;
    await expect
      .poll(
        async () => {
          const snap = await db().collection('pedidos').doc(pedidoId).get();
          data = snap.data() as Record<string, unknown> | undefined;
          return snap.exists;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    return data!;
  }

  test('sem frete (default): saves freteInicial null with zeroed caches', async ({ page }) => {
    await page.goto('/pedidos/novo');
    await fillPrincipal(page, '10');

    // The Frete tab opens collapsed on 'Sem ocorrência de transporte'.
    await page.getByRole('tab', { name: 'Frete' }).click();
    await expect(page.getByText('Sem ocorrência de transporte. Selecione outra')).toBeVisible();

    const pedido = await createAndReadBack(page);
    expect(pedido.freteInicial).toBeNull();
    expect(pedido.valorFreteInicial).toBe(0);
    expect(pedido.custoFreteInicial).toBe(0);
    // valorCobrado = subtotal (10 × 1) − desconto 0 + frete 0.
    expect(pedido.valorCobrado).toBe(10);
  });

  test('retirada na loja: prazoDespacho autofill + string outer ref', async ({ page }) => {
    await page.goto('/pedidos/novo');
    await fillPrincipal(page, '100');

    await page.getByRole('tab', { name: 'Frete' }).click();
    await selectField(page, 'Modalidade de frete', 'Contratação por conta do Emitente (CIF)');

    // "Quem recebe" — the optimized ClientePicker emits the Flutter-ODM
    // doc-path string for this field (emitDocPath).
    await selectFieldWithSearch(
      page,
      'Quem recebe',
      fixtures.base.clienteNome,
      new RegExp(fixtures.base.clienteNome),
    );

    await selectFieldMatching(page, 'Integração de frete', new RegExp(fixtures.retiradaNome));

    // The retirada subform mounts and autofills the dispatch deadline from
    // the integração's 7-day cut-off schedule.
    const valorCobrado = page.getByLabel('Valor cobrado', { exact: true });
    await expect(valorCobrado).toBeVisible();
    await valorCobrado.fill('12.5');
    await valorCobrado.blur();

    const pedido = await createAndReadBack(page);
    const frete = pedido.freteInicial as Record<string, unknown>;
    // Wire shape: STRING doc paths, not native DocumentReferences.
    expect(frete.integracaoFreteOuterRef).toBe(`documents/int_frete/${fixtures.retiradaId}`);
    expect(frete.clienteRecebedorOuterReference).toBe(`documents/clientes/${fixtures.clienteId}`);
    expect(frete.modalidade).toBe('0');
    expect(frete.estado).toBe('iniciado');
    expect(frete.prazoExtra).toBe(0);
    expect(frete.ehReverso).toBe(false);
    expect(typeof frete.prazoDespacho).toBe('number');
    expect(frete.valorCobrado).toBe(12.5);
    // Legacy caches: valorFreteInicial = frete.valorCobrado; valorCobrado =
    // subtotal 100 − desconto 0 + frete 12.5.
    expect(pedido.valorFreteInicial).toBe(12.5);
    expect(pedido.custoFreteInicial).toBe(0);
    expect(pedido.valorCobrado).toBe(112.5);
  });

  test('motoboy: faixa de CEP option stamps the Dart optionString + costs', async ({ page }) => {
    await page.goto('/pedidos/novo');
    await fillPrincipal(page, '50');

    await page.getByRole('tab', { name: 'Frete' }).click();
    await selectField(page, 'Modalidade de frete', 'Contratação por conta do Emitente (CIF)');

    // Destination address drives which faixas are selectable.
    await selectFieldMatching(page, 'Endereço de entrega', /01310-100/);
    await selectFieldMatching(page, 'Integração de frete', new RegExp(fixtures.motoboyNome));
    await selectFieldMatching(page, 'Opção de entrega', /1 dias úteis/);

    const pedido = await createAndReadBack(page);
    const frete = pedido.freteInicial as Record<string, unknown>;
    // The exact legacy optionString — integral doubles carry the Dart `.0`.
    expect(frete.externalOptionId).toBe('01000000 - 01999999 - 15.0 - 20.0 - 1');
    expect(frete.valorCobrado).toBe(20);
    expect(frete.custoCalculado).toBe(15);
    expect(frete.custoFinal).toBe(15);
    expect(typeof frete.prazoDespacho).toBe('number');
    expect(frete.enderecoFreteOuterReference).toBe(`documents/${fixtures.enderecoPath}`);
    expect(frete.integracaoFreteOuterRef).toBe(`documents/int_frete/${fixtures.motoboyId}`);
    // Caches: subtotal 50 + frete 20; custo from custoCalculado.
    expect(pedido.valorFreteInicial).toBe(20);
    expect(pedido.custoFreteInicial).toBe(15);
    expect(pedido.valorCobrado).toBe(70);
  });

  test('marketplace pedido renders the frete read-only', async ({ page }) => {
    await page.goto(`/pedidos/${fixtures.mktPedidoId}/editar`);
    await expect(page.getByRole('tab', { name: 'Frete' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('tab', { name: 'Frete' }).click();

    await expect(page.getByText('Frete gerenciado pelo marketplace')).toBeVisible();
    // Scope to the tab panel: the (closed) "Status do frete" Select keeps a
    // hidden 'Postado' option span in its portal, which getByText also sees.
    await expect(page.getByRole('tabpanel').getByText('Postado', { exact: true })).toBeVisible();

    const codRastreio = page.getByLabel('Código de rastreio', { exact: true });
    await expect(codRastreio).toHaveValue('BR123456789ML');
    await expect(codRastreio).toBeDisabled();
    // No editable money fields — the marketplace owns this block.
    await expect(page.getByLabel('Custo calculado', { exact: true })).toHaveCount(0);
    // The common header locks too (importer owns the whole frete block).
    await expect(
      page.getByRole('combobox', { name: 'Modalidade de frete', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('combobox', { name: 'Integração de frete', exact: true }),
    ).toBeDisabled();
  });
});
