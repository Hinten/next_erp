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
 * card, the stored "Enviada" guia read from the tabMedi's
 * `tabelasDeMedidasMercadoLivre` map, and graceful degradation (creating /
 * sending needs the backend). Rows are scoped by the run-scoped
 * `data-testid="ml-medida-conta-<id>"` since the tab lists every tipo-1
 * integração on shared staging.
 */
test.describe.serial('Medidas Mercado Livre tab e2e — chart manager', () => {
  const prefix = e2ePrefix('medml');
  const conta = `${prefix}-001`;
  let tabMediId = '';
  let chartNome = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const [, seeded] = await Promise.all([
      seedMercadoLivreFixtures(prefix, 1),
      seedMedidaMlChart(prefix, conta),
      warmRoutes(browser, ['/medidas/__aquecimento__']),
    ]);
    tabMediId = seeded.id;
    chartNome = seeded.chartNome;
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
    await expect(card.getByText(chartNome)).toBeVisible();
    // The seeded guia has an ML id → "Enviada", and two size rows.
    await expect(card.getByText('Enviada')).toBeVisible();
    await expect(card.getByText('MLB-T_SHIRTS · 2 tamanhos')).toBeVisible();
  });

  test('offers the create + edit actions on the card', async ({ page }) => {
    await page.goto(`/medidas/${tabMediId}`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    const card = page.getByTestId(`ml-medida-conta-${conta}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    // Each stored guia opens the editor; sending happens inside it, against the
    // whole conta's list. "Nova guia" needs a size group to exist, so it may be
    // disabled — assert it is present, without requiring a group fixture here.
    await expect(card.getByRole('button', { name: 'Editar' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Nova guia' })).toBeVisible();
  });

  test('locks the definition of a sent guia and offers to duplicate it', async ({ page }) => {
    await page.goto(`/medidas/${tabMediId}`);
    await page.getByRole('tab', { name: 'Mercado Livre' }).click();

    const card = page.getByTestId(`ml-medida-conta-${conta}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Editar' }).click();

    const editor = page.getByTestId('ml-size-chart-editor');
    await expect(editor).toBeVisible({ timeout: 30_000 });
    // Mercado Livre freezes everything but the name and the measurement cells
    // once a guia exists, so the editor says so and offers the only way out.
    await expect(editor.getByText('O que ainda dá para mudar')).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Duplicar em nova guia' })).toBeVisible();
    await expect(editor.getByLabel('Domínio')).toBeDisabled();
    // The name stays editable — it is the one field ML lets you PUT.
    await expect(editor.getByLabel('Nome da guia')).toBeEnabled();
    await expect(editor.getByLabel('Nome da guia')).toHaveValue(chartNome);
  });
});
