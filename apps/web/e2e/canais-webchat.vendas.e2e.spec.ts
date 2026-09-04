import { expect, test } from '@playwright/test';
import {
  cleanupWebchatFixtures,
  docExistsByName,
  e2ePrefix,
  seedWebchatFixtures,
} from './_helpers/seed-data';
import {
  applyTextFilter,
  clickAction,
  expectRowHidden,
  expectRowVisible,
  selectRowByText,
} from './helpers/table-view';
import {
  clickSave,
  confirmDelete,
  expectFieldAfterReload,
  expectSwitchAfterReload,
  fillField,
  selectField,
} from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the `/canais/webchat` TableView + ObjectView flow
 * (#558): CRUD over the standalone `webchat` collection, the
 * horario_funcionamento business-hours editor, the mensagens_padrao chip
 * list, and the "Gerar Script Webchat" bulk action.
 */
test.describe.serial('Canais Webchat e2e — TableView / ObjectView', () => {
  const prefix = e2ePrefix('wc');
  const row = (n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    await Promise.all([
      seedWebchatFixtures(prefix, 5),
      warmRoutes(browser, [
        '/canais/webchat',
        '/canais/webchat/novo',
        '/canais/webchat/__aquecimento__',
      ]),
    ]);
  });

  test.afterAll(async () => {
    await cleanupWebchatFixtures(prefix);
  });

  test('TableView lists webchat configs', async ({ page }) => {
    await page.goto('/canais/webchat');
    await expect(page.getByRole('heading', { name: 'Webchat' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, row(1));
    await expectRowVisible(page, row(5));
  });

  test('navigates to the new-webchat page', async ({ page }) => {
    await page.goto('/canais/webchat');
    await page.getByRole('link', { name: 'Novo webchat' }).click();
    await expect(page).toHaveURL(/\/canais\/webchat\/novo$/);
    await expect(page.getByRole('heading', { name: 'Novo webchat' })).toBeVisible();
  });

  test('creates a new webchat config and lands on the edit page', async ({ page }) => {
    const nome = `${prefix}-nova`;
    await page.goto('/canais/webchat/novo');
    await fillField(page, 'Nome', nome);
    await selectField(page, 'Posicionamento', 'Esquerda');
    await clickSave(page, 'Criar');

    await page.waitForURL(
      (url) =>
        /^\/canais\/webchat\/[^/]+$/.test(url.pathname) && url.pathname !== '/canais/webchat/novo',
      { timeout: 15_000 },
    );
    await expect.poll(() => docExistsByName('webchat', nome), { timeout: 15_000 }).toBe(true);

    await page.goto('/canais/webchat');
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, nome);
  });

  test('opens an existing config from the list', async ({ page }) => {
    await page.goto('/canais/webchat');
    await applyTextFilter(page, 'Nome', prefix);
    await page.getByRole('row', { name: new RegExp(row(2)) }).click();
    await page.waitForURL(/\/canais\/webchat\/[^/]+$/, { timeout: 10_000 });
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(row(2));
  });

  test('edits a config and saves', async ({ page }) => {
    await page.goto(`/canais/webchat/${row(4)}`);
    await fillField(page, 'Nome', `${prefix}-004-editada`);
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/canais\/webchat$/, { timeout: 15_000 });

    await page.goto(`/canais/webchat/${row(4)}`);
    await expectFieldAfterReload(page, 'Nome', `${prefix}-004-editada`);
  });

  test('sets a weekday of horario_funcionamento and saves', async ({ page }) => {
    // `horario_funcionamento` lives on the "Horário de Funcionamento" tab —
    // open it first, mirroring the WhatsApp business-hours smoke test.
    await page.goto(`/canais/webchat/${row(3)}`);
    await page.getByRole('tab', { name: 'Horário de Funcionamento' }).click();
    await page.getByLabel('Segunda-feira', { exact: true }).check();
    await page.getByLabel('Segunda-feira — Abertura', { exact: true }).fill('09:00');
    await page.getByLabel('Segunda-feira — Fechamento', { exact: true }).fill('18:30');
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/canais\/webchat$/, { timeout: 15_000 });

    await page.goto(`/canais/webchat/${row(3)}`);
    await page.getByRole('tab', { name: 'Horário de Funcionamento' }).click();
    await expectSwitchAfterReload(page, 'Segunda-feira');
    await expectFieldAfterReload(page, 'Segunda-feira — Abertura', '09:00');
    await expectFieldAfterReload(page, 'Segunda-feira — Fechamento', '18:30');
  });

  test('adds a mensagem padrão chip (max 3) and saves', async ({ page }) => {
    await page.goto(`/canais/webchat/${row(1)}`);
    await page.getByRole('tab', { name: 'Horário de Funcionamento' }).click();
    const tagsInput = page.getByLabel('Mensagens padrão', { exact: true });
    await tagsInput.fill('Fale conosco');
    await tagsInput.press('Enter');
    await expect(page.getByText('Fale conosco', { exact: true })).toBeVisible();
    await clickSave(page, 'Salvar alterações');
    await page.waitForURL(/\/canais\/webchat$/, { timeout: 15_000 });

    await page.goto(`/canais/webchat/${row(1)}`);
    await page.getByRole('tab', { name: 'Horário de Funcionamento' }).click();
    await expect(page.getByText('Fale conosco', { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test('"Gerar Script Webchat" generates a working embed snippet for one selected row', async ({
    page,
  }) => {
    await page.goto('/canais/webchat');
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowVisible(page, row(5));

    await selectRowByText(page, row(5));
    await clickAction(page, 'Gerar Script Webchat', { confirm: false });

    await expect(page.getByRole('heading', { name: /Script de instalação/ })).toBeVisible();
    const script = page.getByText(/data-tenant=/);
    await expect(script).toBeVisible();
    const scriptText = (await script.textContent()) ?? '';
    expect(scriptText).toContain('loader.js');
    expect(scriptText).toContain('data-tenant=');

    // The base64 block round-trips to the same script. `Code block` renders
    // as a `<pre>` (`packages/ui` pulls in Mantine's `Code` verbatim) — the
    // plain script is the first block, the base64 one the second.
    const base64Block = page.locator('pre').nth(1);
    const base64Text = (await base64Block.textContent())?.trim() ?? '';
    expect(base64Text.length).toBeGreaterThan(0);
    const decoded = Buffer.from(base64Text, 'base64').toString('utf-8');
    expect(decoded).toContain('loader.js');
  });

  test('deletes a config through the typed-confirm modal', async ({ page }) => {
    await page.goto(`/canais/webchat/${row(5)}`);
    await confirmDelete(page);
    await page.waitForURL(/\/canais\/webchat$/, { timeout: 15_000 });
    await applyTextFilter(page, 'Nome', prefix);
    await expectRowHidden(page, row(5));
  });
});
