import { expect, test } from '@playwright/test';
import { requiresAuthEnv } from './helpers/env';
import {
  clearNullableField,
  clickSave,
  clickSaveAndContinue,
  expectToast,
  fillField,
} from './helpers/object-view';
import {
  clickAction,
  expectNoRowWithText,
  expectRowWithText,
  searchTable,
  selectRowByText,
} from './helpers/table-view';

function uniqueName(label: string, workerIndex: number): string {
  return `e2e-${label}-${workerIndex}-${Date.now()}`;
}

test.describe('Clientes CRUD', () => {
  // Skip the whole suite when the auth env isn't configured. Playwright's
  // `test.skip(cond, msg)` is valid inside a describe but not at module
  // level — moving it here avoids the test-discovery error.
  test.skip(
    !requiresAuthEnv(),
    'E2E auth env not configured (E2E_USER_EMAIL/PASSWORD + Firebase Admin secrets)',
  );

  test('list loads and renders the TableView shell', async ({ page }) => {
    await page.goto('/clientes');
    await expect(
      page.getByRole('heading', { name: 'Clientes' }),
    ).toBeVisible();
    await expect(
      page.getByRole('columnheader', { name: 'Nome' }),
    ).toBeVisible();
    await expect(
      page.getByRole('columnheader', { name: 'E-mail' }),
    ).toBeVisible();
  });

  test('create → search → edit → save-and-continue → pristine save', async ({
    page,
  }, testInfo) => {
    const nome = uniqueName('cliente', testInfo.workerIndex);
    const email = `${nome}@example.com`;
    const nomeEditado = `${nome}-editado`;

    // --- Create
    await page.goto('/clientes/novo');
    await fillField(page, 'Nome', nome);
    await fillField(page, 'E-mail', email);
    await fillField(page, 'CPF / CNPJ', '12345678901'); // 11 digits → live CPF preview kicks in
    await clickSave(page, 'Criar');
    await page.waitForURL(/\/clientes\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: nome })).toBeVisible();

    // --- Search filters the list
    await page.goto('/clientes');
    await searchTable(page, nome);
    await expectRowWithText(page, nome);

    // --- Edit via row click → detail → Editar
    await page.getByRole('link', { name: nome }).click();
    await page.waitForURL(/\/clientes\/[^/]+$/);
    await page.getByRole('link', { name: 'Editar' }).click();
    await page.waitForURL(/\/clientes\/[^/]+\/editar$/);
    await fillField(page, 'Nome', nomeEditado);

    // --- Save and continue: stays on the form, dirty cleared, green toast
    await clickSaveAndContinue(page);
    await expectToast(page, /Salvo/);
    await expect(page).toHaveURL(/\/clientes\/[^/]+\/editar$/);

    // --- Pristine save → yellow "Nenhuma alteração" toast
    await clickSave(page, 'Salvar alterações');
    await expectToast(page, /Nenhuma altera/);

    // --- Final save back to detail
    await fillField(page, 'Telefone', '5511999998888');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/clientes\/[^/]+$/, { timeout: 10_000 });
    await expect(
      page.getByRole('heading', { name: nomeEditado }),
    ).toBeVisible();
  });

  test('null-clear: ✕ on `E-mail` writes literal null', async ({
    page,
  }, testInfo) => {
    const nome = uniqueName('cliente-null', testInfo.workerIndex);
    const email = `${nome}@example.com`;

    await page.goto('/clientes/novo');
    await fillField(page, 'Nome', nome);
    await fillField(page, 'E-mail', email);
    await clickSave(page, 'Criar');
    await page.waitForURL(/\/clientes\/[^/]+$/, { timeout: 10_000 });

    await page.getByRole('link', { name: 'Editar' }).click();
    await page.waitForURL(/\/clientes\/[^/]+\/editar$/);

    await clearNullableField(page, 'E-mail');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/clientes\/[^/]+$/, { timeout: 10_000 });

    // Detail view's `<Field>` helper hides null values entirely. Re-enter
    // edit mode and confirm the input is empty.
    await page.getByRole('link', { name: 'Editar' }).click();
    await page.waitForURL(/\/clientes\/[^/]+\/editar$/);
    await expect(page.getByLabel('E-mail', { exact: true })).toHaveValue('');
  });

  test('CPF/CNPJ live formatter shows in the description below the input', async ({
    page,
  }, testInfo) => {
    const nome = uniqueName('cliente-cpf', testInfo.workerIndex);
    await page.goto('/clientes/novo');
    await fillField(page, 'Nome', nome);
    await fillField(page, 'CPF / CNPJ', '12345678901');
    // The renderInput override sets `description={formatCPF(...)}` once the
    // value is exactly 11 chars long. Mantine renders the description right
    // under the input.
    await expect(page.getByText('123.456.789-01')).toBeVisible({ timeout: 2_000 });
  });

  test('bulk delete via ActionBar removes the row', async ({ page }, testInfo) => {
    const nome = uniqueName('cliente-del', testInfo.workerIndex);

    await page.goto('/clientes/novo');
    await fillField(page, 'Nome', nome);
    await clickSave(page, 'Criar');
    await page.waitForURL(/\/clientes\/[^/]+$/, { timeout: 10_000 });

    await page.goto('/clientes');
    await searchTable(page, nome);
    await selectRowByText(page, nome);
    await clickAction(page, 'Excluir');
    await expectNoRowWithText(page, nome);
  });

  test('pagination buttons are present', async ({ page }) => {
    await page.goto('/clientes');
    await expect(
      page.getByRole('button', { name: /Anterior/ }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Próximo/ })).toBeVisible();
  });
});
