import { expect, test } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupEnderecos,
  e2ePrefix,
  enderecoCount,
  seedClientes,
} from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the cliente "Endereços" sub-table and the
 * "find a client by address" search on the /clientes list.
 *
 * Seeds one cliente, then drives the modal-hosted endereco CRUD on its detail
 * page and the collection-group address search. Runs serially — later steps
 * consume earlier state.
 */
test.describe.serial('Endereços e2e — cliente sub-table + address search', () => {
  const prefix = e2ePrefix('end');
  // seedClientes writes deterministic ids `<prefix>-NNN`.
  const clienteId = `${prefix}-001`;
  const logradouro = `${prefix} Rua das Flores`;
  const cidade = `${prefix}ville`;

  test.beforeAll(async ({ browser }) => {
    // Compiling cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      seedClientes(prefix, 1),
      warmRoutes(browser, ['/clientes', `/clientes/${clienteId}`]),
    ]);
  });

  test.afterAll(async () => {
    await cleanupEnderecos(clienteId);
    await cleanupByNamePrefix('clientes', prefix);
  });

  test('shows the Endereços section on the cliente detail page', async ({ page }) => {
    await page.goto(`/clientes/${clienteId}`);
    await expect(page.getByRole('heading', { name: 'Endereços', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('button', { name: 'Novo endereço' })).toBeVisible();
  });

  test('creates an endereço through the modal', async ({ page }) => {
    await page.goto(`/clientes/${clienteId}`);
    await page.getByRole('button', { name: 'Novo endereço' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Logradouro', { exact: true }).fill(logradouro);
    await dialog.getByLabel('Número', { exact: true }).fill('100');
    await dialog.getByLabel('Bairro', { exact: true }).fill('Centro');
    await dialog.getByLabel('CEP', { exact: true }).fill('01310100');
    await dialog.getByLabel('Cidade', { exact: true }).fill(cidade);
    // Estado is a required enum rendered as a Mantine Select.
    await dialog.getByRole('combobox', { name: 'Estado (UF)', exact: true }).click();
    await page.getByRole('option', { name: 'SP', exact: true }).click();
    await dialog.getByRole('button', { name: 'Criar', exact: true }).click();

    // The modal closes and the sub-table remounts with fresh data.
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect.poll(() => enderecoCount(clienteId), { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(page.getByRole('cell', { name: logradouro, exact: true })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('edits the endereço through the row-click modal', async ({ page }) => {
    await page.goto(`/clientes/${clienteId}`);
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('row', { name: new RegExp(logradouro) }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Número', { exact: true }).fill('250');
    await dialog.getByRole('button', { name: 'Salvar alterações', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    await page.reload();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('row', { name: new RegExp(logradouro) }).click();
    await expect(page.getByRole('dialog').getByLabel('Número', { exact: true })).toHaveValue('250');
  });

  test('finds the cliente by address from the /clientes list', async ({ page }) => {
    await page.goto('/clientes');
    await page.getByLabel('Buscar cliente por endereço', { exact: true }).fill(logradouro);
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();

    // The collection-group Pipelines search can lag the default expect budget.
    await expect(page.getByRole('table')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('cell', { name: clienteId, exact: true })).toBeVisible({
      timeout: 15_000,
    });
  });

  test('shows an empty state when no address matches', async ({ page }) => {
    await page.goto('/clientes');
    await page
      .getByLabel('Buscar cliente por endereço', { exact: true })
      .fill(`${prefix}-inexistente`);
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await expect(page.getByText('Nenhum cliente encontrado para este endereço.')).toBeVisible({
      timeout: 30_000,
    });
  });

  test('deletes the endereço through the modal', async ({ page }) => {
    await page.goto(`/clientes/${clienteId}`);
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('row', { name: new RegExp(logradouro) }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Excluir', exact: true }).click();

    // ObjectView's typed-confirm modal stacks on top — it's the last dialog.
    const confirm = page.getByRole('dialog').last();
    await confirm.getByLabel('Digite "excluir" para confirmar', { exact: true }).fill('excluir');
    await confirm.getByRole('button', { name: 'Excluir', exact: true }).click();

    await expect.poll(() => enderecoCount(clienteId), { timeout: 15_000 }).toBe(0);
  });
});
