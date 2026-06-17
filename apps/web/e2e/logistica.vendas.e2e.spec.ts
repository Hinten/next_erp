import { expect, test } from '@playwright/test';
import {
  cleanupIntFreteFixtures,
  docExistsByName,
  e2ePrefix,
  getIntFreteByName,
  intFreteFaixaCount,
  seedIntFreteFixtures,
} from './_helpers/seed-data';
import { expectRowHidden, expectRowVisible } from './helpers/table-view';
import { clickSave, confirmDelete, fillField, selectFieldWithSearch } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/logistica/*` slices of the `int_frete`
 * collection (tipo-discriminated, same pattern as `/canais/balcao`). The
 * motoboy slice gets the full CRUD pass — it exercises the FaixaCepEditor's
 * staged deletion — and the retirada slice gets a slice-isolation check.
 *
 * Wire-compat assertions ride along: a UI-created doc must carry the Flutter
 * shapes F1 pinned (`documents/filiais/<id>` STRING ref, ms-epoch
 * `dataCadastro`).
 */
test.describe.serial('Logística e2e — int_frete TableView / ObjectView', () => {
  const prefix = e2ePrefix('log');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    await Promise.all([
      seedIntFreteFixtures(prefix, 4),
      warmRoutes(browser, [
        '/logistica/motoboy',
        '/logistica/motoboy/novo',
        '/logistica/motoboy/__aquecimento__',
        '/logistica/retirada',
      ]),
    ]);
  });

  test.afterAll(async () => {
    await cleanupIntFreteFixtures(prefix);
  });

  test('motoboy list shows only motoboy rows', async ({ page }) => {
    await page.goto('/logistica/motoboy');
    await expect(page.getByRole('heading', { name: 'Motoboy' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
    await expectRowVisible(page, row(1));
    await expectRowVisible(page, row(4));
    // The retirada fixture lives in the same collection but another slice.
    await expectRowHidden(page, `${prefix}-ret-001`);
  });

  test('retirada list shows only retirada rows', async ({ page }) => {
    await page.goto('/logistica/retirada');
    await expect(page.getByRole('heading', { name: 'Retirada na loja' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expectRowVisible(page, `${prefix}-ret-001`);
    await expectRowHidden(page, row(1));
  });

  test('creates a motoboy writing Flutter wire shapes', async ({ page }) => {
    const nome = `${prefix}-novo`;
    await page.goto('/logistica/motoboy/novo');
    await fillField(page, 'Nome', nome);
    await selectFieldWithSearch(page, 'Filial', `${prefix}-ref-filial`);
    await clickSave(page, 'Criar');

    await page.waitForURL(
      (url) =>
        /^\/logistica\/motoboy\/[^/]+$/.test(url.pathname) &&
        url.pathname !== '/logistica/motoboy/novo',
      { timeout: 15_000 },
    );
    await expect.poll(() => docExistsByName('int_frete', nome), { timeout: 15_000 }).toBe(true);

    // Byte-compat checks: tipo pinned, ms-epoch dataCadastro, STRING doc-path
    // filial ref in the Flutter-ODM format.
    const data = await getIntFreteByName(nome);
    expect(data?.tipo).toBe('motoboy');
    expect(typeof data?.dataCadastro).toBe('number');
    expect(data?.filialIntegracaoFreteOuterRef).toBe(`documents/filiais/${prefix}-ref-filial`);
    expect(data?.prazoExtra).toBe(0);

    await page.goto('/logistica/motoboy');
    await expectRowVisible(page, nome);
  });

  test('opens an existing motoboy from the list', async ({ page }) => {
    await page.goto('/logistica/motoboy');
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/logistica\/motoboy\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
    // The faixaCep editor lives on its own tab; the seeded rows render there.
    await page.getByRole('tab', { name: 'Faixas de CEP' }).click();
    await expect(page.getByLabel('CEP Inicial 1')).toHaveValue('01000000');
    await expect(page.getByLabel('CEP Inicial 2')).toHaveValue('02000000');
  });

  test('adds a faixa de CEP and saves', async ({ page }) => {
    await page.goto(`/logistica/motoboy/${row(3)}`);
    await page.getByRole('tab', { name: 'Faixas de CEP' }).click();
    await expect(page.getByLabel('CEP Inicial 1')).toHaveValue('01000000');
    await page.getByRole('button', { name: 'Adicionar faixa' }).click();
    await page.getByLabel('CEP Inicial 3').fill('03000000');
    await page.getByLabel('CEP Final 3').fill('03999999');
    await page.getByLabel('Preço 3').fill('30');
    await page.getByLabel('Prazo 3').fill('3');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/logistica\/motoboy$/, { timeout: 15_000 });

    await expect.poll(() => intFreteFaixaCount(row(3)), { timeout: 15_000 }).toBe(3);
  });

  test('staged deletion: a marked (even invalid) faixa does not block the save, then is dropped', async ({
    page,
  }) => {
    await page.goto(`/logistica/motoboy/${row(4)}`);
    await page.getByRole('tab', { name: 'Faixas de CEP' }).click();
    await expect(page.getByLabel('CEP Inicial 1')).toHaveValue('01000000');

    // Corrupt the row FIRST (schema-invalid CEP), then mark it for deletion —
    // validation must ignore rows that will be stripped on save.
    await page.getByLabel('CEP Inicial 1').fill('1');
    // Blur explicitly and wait for the per-row message (the inline-error fix)
    // BEFORE clicking the trash icon: the message render shifts the layout,
    // and a click during that shift misses the icon.
    await page.getByLabel('CEP Inicial 1').blur();
    await expect(page.getByText('CEP deve ter 8 dígitos')).toBeVisible();
    await page.getByRole('button', { name: 'Excluir faixa 1' }).click();
    await expect(page.getByText('Será excluída')).toBeVisible();
    // Nothing committed yet — the doc still has both rows.
    expect(await intFreteFaixaCount(row(4))).toBe(2);

    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/logistica\/motoboy$/, { timeout: 15_000 });
    await expect.poll(() => intFreteFaixaCount(row(4)), { timeout: 15_000 }).toBe(1);
  });

  test('invalid create from a non-first tab toasts and jumps back to Dados gerais', async ({
    page,
  }) => {
    await page.goto('/logistica/motoboy/novo');
    // Move away from the tab that holds the empty required fields.
    await page.getByRole('tab', { name: 'Horários de corte' }).click();
    await expect(page.getByRole('tab', { name: 'Horários de corte' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await clickSave(page, 'Criar');

    // Red toast names the erroring tab, the form jumps to it, and the
    // inline required-field error is visible there.
    await expect(page.getByText(/Corrija os campos inválidos na aba "Dados gerais"/)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('tab', { name: /Dados gerais/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page).toHaveURL(/\/logistica\/motoboy\/novo$/);
  });

  test('duplicate weekday in horários de corte blocks the save with a visible message', async ({
    page,
  }) => {
    await page.goto(`/logistica/motoboy/${row(2)}`);
    await page.getByRole('tab', { name: 'Horários de corte' }).click();
    // The seeded schedule already has a segunda-feira row; the new row
    // defaults to segunda-feira → duplicate.
    await page.getByRole('button', { name: 'Adicionar horário' }).click();
    await clickSave(page, 'Salvar alterações');

    await expect(page.getByText('Dia da semana duplicado')).toBeVisible({ timeout: 10_000 });
    // Save blocked — still on the edit page.
    await expect(page).toHaveURL(new RegExp(`/logistica/motoboy/${row(2)}$`));
  });

  test('origin address: toggle on, CEP leads the form, fill and persist', async ({ page }) => {
    await page.goto(`/logistica/motoboy/${row(3)}`);
    await page.getByRole('tab', { name: 'Endereço de origem' }).click();

    // Off by default (origin = filial sede): the Switch is unchecked and the
    // address sub-fields are hidden. Mantine's Switch is a `role="switch"`
    // control whose <span> label isn't wired as an ARIA accessible name, so
    // scope to the active tab panel and grab its single switch by role.
    const toggle = page.getByRole('tabpanel').getByRole('switch');
    await expect(toggle).not.toBeChecked();
    await expect(page.getByLabel('CEP', { exact: true })).toHaveCount(0);

    await toggle.click();

    // CEP is the first address field (schema order), ahead of Logradouro, and
    // Estado was seeded to SP by the field's defaultValue.
    const cep = page.getByLabel('CEP', { exact: true });
    const logradouro = page.getByLabel('Logradouro', { exact: true });
    await expect(cep).toBeVisible();
    await expect(logradouro).toBeVisible();
    const cepTop = await cep.boundingBox();
    const logrTop = await logradouro.boundingBox();
    expect(cepTop!.y).toBeLessThan(logrTop!.y);
    await expect(page.getByRole('combobox', { name: 'Estado (UF)', exact: true })).toHaveValue(
      'SP',
    );

    // Fill the required location fields (no ViaCEP lookup — keep it offline).
    await fillField(page, 'CEP', '01310100');
    await fillField(page, 'Logradouro', 'Av. Paulista');
    await fillField(page, 'Número', '1000');
    await fillField(page, 'Bairro', 'Bela Vista');
    await fillField(page, 'Cidade', 'São Paulo');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/logistica\/motoboy$/, { timeout: 15_000 });

    const origem = async () =>
      (await getIntFreteByName(row(3)))?.enderecoDeOrigem as Record<string, unknown> | null;
    await expect.poll(async () => (await origem())?.cep, { timeout: 15_000 }).toBe('01310100');
    const data = await origem();
    expect(data?.logradouro).toBe('Av. Paulista');
    // Brazil seeded on toggle-on (hidden NFe country fields).
    expect(data?.cPais).toBe('1058');
    expect(data?.pais).toBe('Brasil');
  });

  test('deletes a motoboy through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/logistica/motoboy/${row(1)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/logistica\/motoboy$/, { timeout: 15_000 });
    await expectRowHidden(page, row(1));
  });
});
