import { type Page, expect } from '@playwright/test';

/**
 * Helpers for driving the generic `TableView` (`@delfrance/ui`): per-column
 * filters, header sorting, row selection and ActionBar actions.
 */

/** Assert a data row containing `text` is visible. */
export async function expectRowVisible(page: Page, text: string): Promise<void> {
  await expect(page.getByRole('row', { name: new RegExp(text) })).toBeVisible({ timeout: 10_000 });
}

/** Assert no data row contains `text`. */
export async function expectRowHidden(page: Page, text: string): Promise<void> {
  await expect(page.getByRole('row', { name: new RegExp(text) })).toHaveCount(0, {
    timeout: 10_000,
  });
}

/** Assert the TableView's "no results" empty state is shown. */
export async function expectEmptyState(page: Page): Promise<void> {
  await expect(page.getByText('Nenhum resultado.')).toBeVisible({ timeout: 10_000 });
}

/** Text content of the first body row (header row excluded). */
export async function firstRowText(page: Page): Promise<string> {
  // role=row includes the <thead> row at index 0; data rows start at 1.
  return (await page.getByRole('row').nth(1).textContent()) ?? '';
}

/**
 * Open a column's filter popover via its `Filtrar <label>` icon, type a
 * substring and apply (string columns → `contains`).
 */
export async function applyTextFilter(
  page: Page,
  columnLabel: string,
  value: string,
): Promise<void> {
  await page.getByRole('button', { name: `Filtrar ${columnLabel}`, exact: true }).click();
  await page.getByLabel(`${columnLabel} contém`, { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
}

/**
 * Open a column's filter popover and pick a `Select` option (enum / boolean
 * columns → `eq`). The Select applies on change; no Apply click needed.
 */
export async function applySelectFilter(
  page: Page,
  columnLabel: string,
  optionLabel: string,
): Promise<void> {
  await page.getByRole('button', { name: `Filtrar ${columnLabel}`, exact: true }).click();
  // `getByLabel` also matches the Select's `role="listbox"` popup (same
  // `aria-labelledby`); target the combobox input explicitly.
  await page.getByRole('combobox', { name: columnLabel, exact: true }).click();
  await page.getByRole('option', { name: optionLabel, exact: true }).click();
}

/** Open a column's filter popover and click "Limpar". */
export async function clearColumnFilter(page: Page, columnLabel: string): Promise<void> {
  await page.getByRole('button', { name: `Filtrar ${columnLabel}`, exact: true }).click();
  await page.getByRole('button', { name: 'Limpar', exact: true }).click();
}

/**
 * Click a column header to cycle its sort (different col → asc; same → flip).
 * Targets the header's label span by exact text — the sort `onClick` lives on
 * the wrapping group, so the click bubbles up to it.
 */
export async function clickColumnSort(page: Page, columnLabel: string): Promise<void> {
  await page.getByText(columnLabel, { exact: true }).click();
}

/** Check the selection checkbox of the row containing `text`. */
export async function selectRowByText(page: Page, text: string): Promise<void> {
  const row = page.getByRole('row', { name: new RegExp(text) });
  await row.getByRole('checkbox').check();
}

/**
 * Click an ActionBar button and confirm the resulting Mantine modal. The
 * modal confirm label is "Confirmar" (`packages/ui/src/table/ActionBar.tsx`).
 */
export async function clickAction(
  page: Page,
  label: string,
  { confirm = true }: { confirm?: boolean } = {},
): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click();
  if (confirm) {
    await page.getByRole('button', { name: 'Confirmar' }).click();
  }
}
