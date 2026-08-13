import { expect, test } from '@playwright/test';
import {
  cleanupByNamePrefix,
  cleanupMercadoLivreFixtures,
  e2ePrefix,
  seedMedidaMlChart,
  seedMercadoLivreFixtures,
} from './_helpers/seed-data';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for the medidas editor's **Mercado Livre** tab (the
 * size-chart manager). The apps/mercado-livre backend does NOT run in this
 * suite, so the assertions cover the parts that don't need it: the per-conta
 * card, the guias read from the tabMedi's `tabelasDeMedidasMercadoLivre` map,
 * and how the editor renders Mercado Livre's immutability rules. Creating and
 * sending need the backend.
 *
 * Rows are scoped by the run-scoped `data-testid="ml-medida-conta-<id>"` and
 * `data-testid="ml-guia-<conta>-<index>"`, since the tab lists every tipo-1
 * integração on shared staging and the fixture seeds two guias.
 */
test.describe.serial('Medidas Mercado Livre tab e2e — chart manager', () => {
  const prefix = e2ePrefix('medml');
  const conta = `${prefix}-001`;
  let tabMediId = '';
  let chartNome = '';
  let excluindoNome = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const [, seeded] = await Promise.all([
      seedMercadoLivreFixtures(prefix, 1),
      seedMedidaMlChart(prefix, conta),
      warmRoutes(browser, ['/medidas/__aquecimento__']),
    ]);
    tabMediId = seeded.id;
    chartNome = seeded.chartNome;
    excluindoNome = seeded.excluindoNome;
  });

  test.afterAll(async () => {
    await cleanupByNamePrefix('tabMedi', prefix);
    await cleanupMercadoLivreFixtures(prefix);
  });

  test('surfaces the stored guia under its conta card', async ({ page }) => {
    await page.goto(`/medidas/${tabMediId}`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    const card = page.getByTestId(`ml-medida-conta-${conta}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText(conta)).toBeVisible();

    const guia = page.getByTestId(`ml-guia-${conta}-0`);
    await expect(guia.getByText(chartNome)).toBeVisible();
    // The seeded guia has an ML id → "Enviada", and two size rows.
    await expect(guia.getByText('Enviada')).toBeVisible();
    await expect(guia.getByText('MLB-T_SHIRTS · 2 tamanhos')).toBeVisible();
  });

  test('offers the create, edit and delete actions on the card', async ({ page }) => {
    await page.goto(`/medidas/${tabMediId}`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    const card = page.getByTestId(`ml-medida-conta-${conta}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    const guia = page.getByTestId(`ml-guia-${conta}-0`);
    // Each stored guia opens the editor; sending happens inside it, against the
    // whole conta's list. "Nova guia" needs a size group to exist, so it may be
    // disabled — assert it is present, without requiring a group fixture here.
    await expect(guia.getByRole('button', { name: 'Editar' })).toBeVisible();
    await expect(guia.getByRole('button', { name: 'Excluir' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Nova guia' })).toBeVisible();
  });

  test('flags a guia whose deletion Mercado Livre has not confirmed yet', async ({ page }) => {
    await page.goto(`/medidas/${tabMediId}`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    const guia = page.getByTestId(`ml-guia-${conta}-1`);
    await expect(guia).toBeVisible({ timeout: 30_000 });
    await expect(guia.getByText(excluindoNome)).toBeVisible();
    // A deletion is a REQUEST: the guia stays until a re-read confirms, so it
    // keeps its own badge and gains the action that settles it.
    await expect(guia.getByText('Exclusão solicitada')).toBeVisible();
    await expect(guia.getByRole('button', { name: 'Verificar' })).toBeVisible();
  });

  test('warns before asking Mercado Livre to delete a guia', async ({ page }) => {
    await page.goto(`/medidas/${tabMediId}`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    const guia = page.getByTestId(`ml-guia-${conta}-0`);
    await expect(guia).toBeVisible({ timeout: 30_000 });
    await guia.getByRole('button', { name: 'Excluir' }).click();

    // The copy has to say the guia will NOT disappear, or an operator reads the
    // unchanged list as a failure.
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Excluir guia no Mercado Livre')).toBeVisible();
    await expect(dialog.getByText(/até 24 horas/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Não' }).click();
    await expect(guia.getByText('Enviada')).toBeVisible();
  });

  test('locks the definition of a sent guia and offers to duplicate it', async ({ page }) => {
    await page.goto(`/medidas/${tabMediId}`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    const guia = page.getByTestId(`ml-guia-${conta}-0`);
    await expect(guia).toBeVisible({ timeout: 30_000 });
    await guia.getByRole('button', { name: 'Editar' }).click();

    const editor = page.getByTestId('ml-size-chart-editor');
    await expect(editor).toBeVisible({ timeout: 30_000 });
    // Mercado Livre freezes everything but the name and the measurement cells
    // once a guia exists, so the editor says so and offers the only way out.
    await expect(editor.getByText('O que ainda dá para mudar')).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Duplicar em nova guia' })).toBeVisible();
    // The name stays editable — it is the one field ML lets you PUT.
    await expect(editor.getByLabel('Nome da guia')).toBeEnabled();
    await expect(editor.getByLabel('Nome da guia')).toHaveValue(chartNome);

    // A sent guia opens with Definição collapsed (the frozen half); Mantine
    // unmounts collapsed content, so expand it before asserting on the fields.
    await editor.getByRole('button', { name: 'Mostrar' }).click();
    await expect(editor.getByLabel('Domínio')).toBeDisabled();
  });

  test('offers to fill the grid from the size-table photo', async ({ page }) => {
    await page.goto(`/medidas/${tabMediId}`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    const guia = page.getByTestId(`ml-guia-${conta}-0`);
    await expect(guia).toBeVisible({ timeout: 30_000 });
    await guia.getByRole('button', { name: 'Editar' }).click();

    const editor = page.getByTestId('ml-size-chart-editor');
    await expect(editor).toBeVisible({ timeout: 30_000 });

    // The control is enabled once the grid exists — filling a chart that has no
    // rows or columns would be a guaranteed 422, so it stays disabled until
    // there is something to fill.
    const fill = editor.getByTestId('ml-size-chart-ai-fill');
    await expect(fill).toBeVisible();
    await expect(fill).toBeEnabled();

    // Deliberately NOT clicked: the suggestion backend does not run in this
    // lane, so the assertion stops at the affordance. The suggestion itself is
    // covered by the route's own unit tests and by the manual staging pass.
  });
});
