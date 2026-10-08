import { expect, test, type Page } from '@playwright/test';
import { db } from '@delfrance/test-fixtures';
import { cleanupByNamePrefix, e2ePrefix, seedDepositos } from './_helpers/seed-data';
import {
  applySelectFilter,
  applyTextFilter,
  clearColumnFilter,
  clickColumnSort,
  expectListMode,
  expectRowHidden,
  expectRowVisible,
  firstRowText,
  transitionListMode,
} from './helpers/table-view';

/**
 * Exercise both TableView transports against real emulator RPCs: the declared
 * query streams, while filters and sorting execute projecting Pipelines.
 * Matching rows alone could pass through a classic-query fallback, so each
 * static gesture also requires a successful local ExecutePipeline response.
 */
test.describe.serial('TableView list mode e2e — depósitos', () => {
  const prefix = e2ePrefix('pipeline-list');
  const accented = { id: `${prefix}-001`, nome: `${prefix}-Açaí-001` };
  const uppercase = { id: `${prefix}-002`, nome: `${prefix}-ACAI-002` };
  const nearMiss = { id: `${prefix}-003`, nome: `${prefix}-Açúcar-003` };
  let fixturesCreated = false;

  test.beforeAll(async () => {
    expect(process.env.FIREBASE_PROJECT_ID).toBe('demo-erp');
    expect(['127.0.0.1:8080', 'localhost:8080']).toContain(process.env.FIRESTORE_EMULATOR_HOST);
    await seedDepositos(prefix, 3);
    fixturesCreated = true;
    const batch = db().batch();
    for (const [index, fixture] of [accented, uppercase, nearMiss].entries()) {
      batch.update(db().collection('depositos').doc(fixture.id), {
        nome: fixture.nome,
        ativo: index !== 1,
      });
    }
    await batch.commit();
  });

  test.afterAll(async () => {
    // A failed emulator precondition must not let teardown reach staging.
    if (fixturesCreated) await cleanupByNamePrefix('depositos', prefix);
  });

  async function executeLocalPipeline(page: Page, gesture: () => Promise<unknown>): Promise<void> {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/documents:executePipeline'),
      { timeout: 15_000 },
    );
    await gesture();
    const response = await responsePromise;
    const url = new URL(response.url());
    expect(['127.0.0.1', 'localhost']).toContain(url.hostname);
    expect(url.port).toBe('8080');
    expect(url.pathname).toBe('/v1/projects/demo-erp/databases/default/documents:executePipeline');
    expect(response.status()).toBe(200);
    // TableView must keep its normal projection, including the id expression
    // that recovers row identity after select removes the document reference.
    const body = response.request().postData();
    expect(body).toContain('depositos');
    expect(body).toContain('select');
    expect(body).toContain('document_id');
    expect(body).toContain('rowId');
  }

  test('keeps the declared default query live', async ({ page }) => {
    await page.goto('/depositos');
    await expect(page.getByRole('heading', { name: 'Depósitos de estoque' })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
    await expectListMode(page, 'live', null, 'live');
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
  });

  test('folds case and accents without matching a different word and restores the live query', async ({
    page,
  }) => {
    await page.goto('/depositos');
    await executeLocalPipeline(page, () =>
      transitionListMode(
        page,
        { mode: 'live', policy: 'live', reason: null },
        { mode: 'static', policy: 'static', reason: 'filter' },
        () => applyTextFilter(page, 'Nome', `${prefix}-acai`),
      ),
    );
    await expectRowVisible(page, accented.nome);
    await expectRowVisible(page, uppercase.nome);
    await expectRowHidden(page, nearMiss.nome);

    // The boolean equality must narrow the regex result, rather than replacing
    // it: the other active row is the near-miss and must remain excluded.
    await executeLocalPipeline(page, () => applySelectFilter(page, 'Ativo', 'Sim'));
    await expectRowVisible(page, accented.nome);
    await expectRowHidden(page, uppercase.nome);
    await expectRowHidden(page, nearMiss.nome);

    await executeLocalPipeline(page, () => clearColumnFilter(page, 'Ativo'));
    await expectRowVisible(page, uppercase.nome);
    await transitionListMode(
      page,
      { mode: 'static', policy: 'static', reason: 'filter' },
      { mode: 'live', policy: 'live', reason: null },
      () => clearColumnFilter(page, 'Nome'),
    );
    await expectRowVisible(page, nearMiss.nome);
    await expect(page.getByText('Erro ao carregar')).toHaveCount(0);
  });

  test('sorts projected pipeline rows in both directions and opens the original document', async ({
    page,
  }) => {
    await page.goto('/depositos');
    await executeLocalPipeline(page, () => applyTextFilter(page, 'Nome', prefix));
    await expect.poll(() => firstRowText(page)).toContain(uppercase.nome);

    await executeLocalPipeline(page, () => clickColumnSort(page, 'Nome'));
    await expect(page).toHaveURL(/sort=nome%3Adesc/);
    await expect.poll(() => firstRowText(page)).toContain(nearMiss.nome);

    await executeLocalPipeline(page, () => clickColumnSort(page, 'Nome'));
    await expect.poll(() => firstRowText(page)).toContain(uppercase.nome);
    await page.getByRole('link', { name: accented.nome, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/depositos/${accented.id}$`));
    await expect(page.getByLabel('Nome', { exact: true })).toHaveValue(accented.nome);
  });
});
