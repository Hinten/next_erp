import { expect, test } from '@playwright/test';
import {
  cleanupWhatsappFixtures,
  docExistsByName,
  e2ePrefix,
  seedWhatsappFixtures,
} from './_helpers/seed-data';
import { applyTextFilter, expectRowHidden, expectRowVisible } from './helpers/table-view';
import { clickSave, confirmDelete, fillField, selectFieldWithSearch } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/canais/whatsapp` TableView + ObjectView flow,
 * driven by `integracaoSchema` filtered to `tipo == 6` (whatsapp). Mirrors
 * the Balcão suite (CRUD via seeded fixtures) plus the Mercado Livre suite's
 * panel-degradation assertion — `ContaWhatsappPanel` talks to the
 * apps/whatsapp backend (#527/#529), which does NOT run in this suite; the
 * assertions only require it to degrade gracefully ("Não conectada" + error
 * alert), never to actually connect.
 */
test.describe.serial('Canais WhatsApp e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('wa');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;
  const refLabel = `${prefix}-ref`;

  test.beforeAll(async ({ browser }) => {
    // Compiling 3 cold routes can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    await Promise.all([
      seedWhatsappFixtures(prefix, 5),
      warmRoutes(browser, [
        '/canais/whatsapp',
        '/canais/whatsapp/novo',
        '/canais/whatsapp/__aquecimento__',
      ]),
    ]);
  });

  test.afterAll(async () => {
    await cleanupWhatsappFixtures(prefix);
  });

  test('TableView lists WhatsApp accounts only', async ({ page }) => {
    await page.goto('/canais/whatsapp');
    await expect(page.getByRole('heading', { name: 'WhatsApp' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
    // Narrow to this run first. Run-scoped names make each row uniquely
    // identifiable, but the list is `orderBy nome asc` with `limit: 50`, so
    // identity is not enough — the row still has to be on page 1, which
    // orphaned fixtures from older runs quietly prevent (#712).
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, row(1));
    await expectRowVisible(page, row(5));
  });

  test('navigates to the new-conta page', async ({ page }) => {
    await page.goto('/canais/whatsapp');
    await page.getByRole('link', { name: 'Nova conta WhatsApp' }).click();
    await expect(page).toHaveURL(/\/canais\/whatsapp\/novo$/);
    await expect(page.getByRole('heading', { name: 'Nova conta WhatsApp' })).toBeVisible();
  });

  test('creates a new conta and lands on the connect panel', async ({ page }) => {
    const nome = `${prefix}-nova`;
    await page.goto('/canais/whatsapp/novo');
    await fillField(page, 'Nome', nome);
    // The dropdowns cap at 15 docs — type to trigger the server-side search
    // so the run-scoped fixture refs are found regardless of their position.
    await selectFieldWithSearch(page, 'Filial', `${refLabel}-filial`);
    await selectFieldWithSearch(page, 'Tabela de preços', `${refLabel}-lista`);
    await selectFieldWithSearch(page, 'Depósito', `${refLabel}-deposito`);
    await fillField(page, 'Número', '5511988887777');
    await clickSave(page, 'Criar');

    // onSaved does router.replace('/canais/whatsapp/<id>') — the edit page,
    // where the account panel lives.
    await page.waitForURL(
      (url) =>
        /^\/canais\/whatsapp\/[^/]+$/.test(url.pathname) &&
        url.pathname !== '/canais/whatsapp/novo',
      { timeout: 15_000 },
    );
    await expect.poll(() => docExistsByName('integracao', nome), { timeout: 15_000 }).toBe(true);

    // The account panel renders even with the whatsapp backend offline — a
    // disconnected state + a usable token form (it must degrade, not break).
    // Role-scoped locators: the page <h2> and the panel label share the text
    // "Conta WhatsApp", so a bare getByText is a strict-mode violation.
    await expect(page.getByRole('heading', { name: 'Conta WhatsApp' })).toBeVisible();
    await expect(page.getByText('Não conectada')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Salvar token' })).toBeVisible();

    await page.goto('/canais/whatsapp');
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, nome);
  });

  test('opens an existing conta from the list', async ({ page }) => {
    await page.goto('/canais/whatsapp');
    await applyTextFilter(page, 'Nome', prefix);
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/canais\/whatsapp\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
  });

  test('edits a conta and saves', async ({ page }) => {
    await page.goto(`/canais/whatsapp/${row(4)}`);
    await fillField(page, 'Nome', `${prefix}-004-editada`);
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/canais\/whatsapp$/, { timeout: 15_000 });

    await page.goto(`/canais/whatsapp/${row(4)}`);
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(`${prefix}-004-editada`);
  });

  test('sets a weekday of horario_funcionamento and saves', async ({ page }) => {
    // Business-hours field smoke test: toggle Monday on, fill its
    // abertura/fechamento TimeInputs, save, then reload and confirm the
    // toggle round-trips (the wire shape is a `PeriodoWhatsapp[]`, asserted
    // indirectly here via the UI staying consistent after a reload).
    // `horario_funcionamento` lives on the "Atendimento" tab, so open it
    // first — the form defaults to the "Geral" tab where these inputs are
    // not rendered.
    await page.goto(`/canais/whatsapp/${row(3)}`);
    await page.getByRole('tab', { name: 'Atendimento' }).click();
    await page.getByLabel('Segunda-feira', { exact: true }).check();
    await page.getByLabel('Segunda-feira — Abertura', { exact: true }).fill('09:00');
    await page.getByLabel('Segunda-feira — Fechamento', { exact: true }).fill('18:30');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/canais\/whatsapp$/, { timeout: 15_000 });

    await page.goto(`/canais/whatsapp/${row(3)}`);
    await page.getByRole('tab', { name: 'Atendimento' }).click();
    await expect(page.getByLabel('Segunda-feira', { exact: true })).toBeChecked();
    await expect(page.getByLabel('Segunda-feira — Abertura', { exact: true })).toHaveValue('09:00');
    await expect(page.getByLabel('Segunda-feira — Fechamento', { exact: true })).toHaveValue(
      '18:30',
    );
  });

  test('deletes a conta through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/canais/whatsapp/${row(5)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/canais\/whatsapp$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowHidden(page, row(5));
  });
});
