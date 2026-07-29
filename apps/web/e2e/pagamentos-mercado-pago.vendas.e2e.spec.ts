import { expect, test } from '@playwright/test';
import {
  cleanupMetodoPagamento,
  docExistsByName,
  e2ePrefix,
  seedMetodoPagamento,
} from './_helpers/seed-data';
import { applyTextFilter, expectRowHidden, expectRowVisible } from './helpers/table-view';
import { clickSave, confirmDelete, fillField } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/pagamentos/mercado-pago` TableView +
 * ObjectView flow, driven by `metodoPagamentoSchema` (the `metodo_pgto`
 * collection). Mirrors the Mercado Livre suite; row lookup leans on the
 * run-scoped `nome` prefix. The Conta panel talks to the mercado-pago
 * payments backend, which does NOT run in this suite — the assertions only
 * require it to degrade gracefully ("Não conectada" + Conectar button),
 * never to actually connect.
 */
test.describe.serial('Pagamentos Mercado Pago e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('mp');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

  test.beforeAll(async ({ browser }) => {
    // Compiling 3 cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      seedMetodoPagamento(prefix, 5),
      warmRoutes(browser, [
        '/pagamentos/mercado-pago',
        '/pagamentos/mercado-pago/novo',
        '/pagamentos/mercado-pago/__aquecimento__',
      ]),
    ]);
  });

  test.afterAll(async () => {
    await cleanupMetodoPagamento(prefix);
  });

  test('TableView lists Mercado Pago accounts', async ({ page }) => {
    await page.goto('/pagamentos/mercado-pago');
    await expect(page.getByRole('heading', { name: 'Mercado Pago' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
    // Narrow to this run first: the list is `orderBy nome asc` with `limit: 50`,
    // so a run-scoped name is only findable while it stays on page 1 — which
    // orphaned fixtures from older runs quietly prevent (#712).
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, row(1));
    await expectRowVisible(page, row(5));
  });

  test('navigates to the new-conta page', async ({ page }) => {
    await page.goto('/pagamentos/mercado-pago');
    await page.getByRole('link', { name: 'Nova conta' }).click();
    await expect(page).toHaveURL(/\/pagamentos\/mercado-pago\/novo$/);
    await expect(page.getByRole('heading', { name: 'Nova conta Mercado Pago' })).toBeVisible();
  });

  test('creates a new conta and lands on the connect panel', async ({ page }) => {
    const nome = `${prefix}-nova`;
    await page.goto('/pagamentos/mercado-pago/novo');
    await fillField(page, 'Nome', nome);
    await clickSave(page, 'Criar');

    // onSaved does router.replace('/pagamentos/mercado-pago/<id>') — the edit
    // page, where the Conectar panel lives.
    await page.waitForURL(
      (url) =>
        /^\/pagamentos\/mercado-pago\/[^/]+$/.test(url.pathname) &&
        url.pathname !== '/pagamentos/mercado-pago/novo',
      { timeout: 15_000 },
    );
    await expect.poll(() => docExistsByName('metodo_pgto', nome), { timeout: 15_000 }).toBe(true);

    // The account panel renders even with the mercado-pago backend offline —
    // a disconnected state + the Conectar button (it must degrade, not
    // break). Role-scoped locators: the page <h2> and the panel label share
    // the text "Conta Mercado Pago", so a bare getByText is a strict-mode
    // violation.
    await expect(page.getByRole('heading', { name: 'Conta Mercado Pago' })).toBeVisible();
    await expect(page.getByText('Não conectada')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Conectar conta' })).toBeVisible({
      timeout: 15_000,
    });

    await page.goto('/pagamentos/mercado-pago');
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, nome);
  });

  test('opens an existing conta from the list', async ({ page }) => {
    await page.goto('/pagamentos/mercado-pago');
    await applyTextFilter(page, 'Nome', prefix);
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/pagamentos\/mercado-pago\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
  });

  test('edits a conta and saves', async ({ page }) => {
    await page.goto(`/pagamentos/mercado-pago/${row(4)}`);
    await fillField(page, 'Nome', `${prefix}-004-editada`);
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/pagamentos\/mercado-pago$/, { timeout: 15_000 });

    await page.goto(`/pagamentos/mercado-pago/${row(4)}`);
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(`${prefix}-004-editada`);
  });

  test('deletes a conta through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/pagamentos/mercado-pago/${row(5)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/pagamentos\/mercado-pago$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowHidden(page, row(5));
  });
});
