import { type Page, expect, test } from '@playwright/test';
import { cleanupEnviNfeFixtures, e2ePrefix, seedEnviNfeFixtures } from './_helpers/seed-data';
import {
  clickAction,
  expectEmptyState,
  expectRowHidden,
  expectRowVisible,
  firstRowText,
  selectRowByText,
} from './helpers/table-view';
import { expectToast, fillField, selectFieldWithSearch } from './helpers/object-view';
import { warmRoutes } from './helpers/warmup';

/**
 * End-to-end coverage for `/nfe/comunicacoes` — the `filiais/{filialId}/enviNfe`
 * audit-log TableView (filial-scoped via FilialPicker), its four filter modes
 * (chave / nNF / nº pedido / ID pedido — all funnel into one server-side
 * `targetsChnfe` predicate), the read-only detail ObjectView and the
 * "Verificar novamente" action's selection guard.
 *
 * Deliberately NOT e2e'd: the verify happy path — apps/nfe is not served in
 * the e2e CI, so `client.verificar` has no backend here. It's covered by unit
 * tests (`useVerificarEnviNfeAction.test.tsx` + the apps/nfe orchestrator and
 * route suites).
 *
 * The seeded fixture set (see `seedEnviNfeFixtures`): three enviNfe docs under
 * one run-scoped filial — a lote send ('3' Concluído, cStat 100) and its
 * consulta ('2' Respondido) targeting `chave` (emitted by the seeded pedido's
 * nfev4 doc, numeracao 777001), plus a transport-error doc ('e' Erro)
 * targeting `chaveErro`. Timestamps are staggered: the erro doc is newest.
 */
test.describe.serial('Comunicações NF-e e2e — enviNfe TableView / ObjectView', () => {
  const prefix = e2ePrefix('com');
  let fixtures: Awaited<ReturnType<typeof seedEnviNfeFixtures>>;

  test.beforeAll(async ({ browser }) => {
    // First-load route compilation can outlast the default 60s hook budget.
    test.setTimeout(240_000);
    [fixtures] = await Promise.all([
      seedEnviNfeFixtures(prefix),
      warmRoutes(browser, [
        '/nfe/comunicacoes',
        // Any param values compile the dynamic detail route module.
        '/nfe/comunicacoes/__aquecimento__/__aquecimento__',
      ]),
    ]);
  });

  test.afterAll(async () => {
    await cleanupEnviNfeFixtures(prefix);
  });

  /** Open the page and pick the seeded filial — the table only renders then. */
  async function openWithFilial(page: Page): Promise<void> {
    await page.goto('/nfe/comunicacoes');
    await expect(page.getByRole('heading', { name: 'Comunicações NF-e' })).toBeVisible();
    await selectFieldWithSearch(page, 'Filial', fixtures.filialId);
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
  }

  /**
   * Drive the page-owned EnviNfeFilterBar: optionally switch the
   * SegmentedControl mode (click its visible label text — the radio input
   * itself is visually hidden), fill the mode's term input and apply. The
   * "Aplicar" button is unique on the page while no column-filter popover is
   * open (Mantine unmounts closed popovers).
   */
  async function applyFilter(
    page: Page,
    modeLabel: string | null,
    inputLabel: string,
    value: string,
  ): Promise<void> {
    if (modeLabel) await page.getByText(modeLabel, { exact: true }).click();
    await fillField(page, inputLabel, value);
    await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
  }

  test('picking the filial lists the 3 seeded comunicações newest-first', async ({ page }) => {
    await openWithFilial(page);

    // Estado badges (schema `.meta({ labels })`) identify each row uniquely —
    // two rows share `chave`, and the header row contains the column label
    // "Erro", so neither is usable as a single-row locator.
    await expectRowVisible(page, 'Concluído');
    await expectRowVisible(page, 'Respondido');
    await expectRowVisible(page, fixtures.chaveErro);
    await expect(page.getByRole('row', { name: /Concluído/ })).toContainText(fixtures.chave);

    // orderBy timestamp desc — the erro doc has the highest timestamp.
    expect(await firstRowText(page)).toContain(fixtures.chaveErro);
  });

  test('chave filter narrows server-side; an unmatched chave yields the empty table', async ({
    page,
  }) => {
    await openWithFilial(page);

    // Positive: both docs targeting `chave` stay, the erro doc disappears.
    await applyFilter(page, null, 'Chave NF-e', fixtures.chave);
    await expectRowVisible(page, 'Concluído');
    await expectRowVisible(page, 'Respondido');
    await expectRowHidden(page, fixtures.chaveErro);

    // Empty: a valid-format chave no doc targets → "Nenhum resultado.", not
    // an unfiltered list.
    await applyFilter(page, null, 'Chave NF-e', '9'.repeat(44));
    await expectEmptyState(page);
    await expectRowHidden(page, fixtures.chave);
    await expectRowHidden(page, fixtures.chaveErro);
  });

  test('nNF filter resolves the chave via the nfev4 collection group', async ({ page }) => {
    await openWithFilial(page);

    await applyFilter(page, 'nNF', 'Número da NF-e (nNF)', String(fixtures.numeracao));
    await expectRowVisible(page, 'Concluído');
    await expectRowVisible(page, 'Respondido');
    await expectRowHidden(page, fixtures.chaveErro);
  });

  test('pedido numero filter resolves pedidos → nfev4 → chaves', async ({ page }) => {
    await openWithFilial(page);

    await applyFilter(page, 'Nº pedido', 'Número do pedido', fixtures.pedidoNumero);
    await expectRowVisible(page, 'Concluído');
    await expectRowVisible(page, 'Respondido');
    await expectRowHidden(page, fixtures.chaveErro);
  });

  test('pedido id filter resolves; a nonexistent id yields the EMPTY table', async ({ page }) => {
    await openWithFilial(page);

    // Positive: the seeded pedido's nfev4 subcollection carries `chave`.
    await applyFilter(page, 'ID pedido', 'ID do pedido', fixtures.pedidoId);
    await expectRowVisible(page, 'Concluído');
    await expectRowVisible(page, 'Respondido');
    await expectRowHidden(page, fixtures.chaveErro);

    // Empty resolution (no such pedido → zero chaves) must short-circuit to
    // the empty table — never fall back to an unfiltered list.
    await applyFilter(page, null, 'ID do pedido', `${prefix}-ped-999`);
    await expectEmptyState(page);
    await expectRowHidden(page, fixtures.chave);
    await expectRowHidden(page, fixtures.chaveErro);
  });

  test('row click opens the read-only detail (no save, disabled fields, copyable XML)', async ({
    page,
  }) => {
    await openWithFilial(page);

    // The erro doc's chave is unique, so its row is unambiguous.
    await expectRowVisible(page, fixtures.chaveErro);
    await page.getByRole('row', { name: new RegExp(fixtures.chaveErro) }).click();
    await page.waitForURL(`**/nfe/comunicacoes/${fixtures.filialId}/${fixtures.msgErroId}`, {
      timeout: 15_000,
    });

    await expect(page.getByRole('heading', { name: 'Comunicação NF-e' })).toBeVisible();

    // Read-only: fields disabled, no save buttons anywhere.
    const estado = page.getByRole('combobox', { name: 'Estado', exact: true });
    await expect(estado).toBeVisible({ timeout: 15_000 });
    await expect(estado).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Salvar', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Salvar e continuar' })).toHaveCount(0);

    // XmlBlock renders the payload with its pinned copy affordance; each
    // chave in targetsChnfe gets its own copy button.
    await expect(page.getByText('XML enviado', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copiar XML enviado' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: `Copiar chave ${fixtures.chaveErro}` }),
    ).toBeVisible();
  });

  test('action guard: disabled with 0 selected; 2 selected toasts "exatamente 1"', async ({
    page,
  }) => {
    await openWithFilial(page);
    await expectRowVisible(page, 'Concluído');

    const verificar = page.getByRole('button', { name: 'Verificar novamente', exact: true });
    await expect(verificar).toBeDisabled();

    await selectRowByText(page, 'Concluído');
    await selectRowByText(page, 'Respondido');
    await expect(verificar).toBeEnabled();

    // No confirm modal on this action — run() itself rejects != 1 row with a
    // notification, before any backend call (apps/nfe isn't served here).
    await clickAction(page, 'Verificar novamente', { confirm: false });
    await expectToast(page, /exatamente 1 comunicação/);
  });
});
