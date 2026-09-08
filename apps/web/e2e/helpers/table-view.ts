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

/**
 * The TableView search box (the opt-in `search` prop's input).
 *
 * ⚠️ Located by its stable `aria-label`, never by its placeholder. The
 * placeholder is presentational and tracks what the search can DO — /produtos'
 * went from "Buscar por nome…" to naming SKU and marketplace ids the day it
 * learned to resolve them — which silently breaks every `getByPlaceholder`
 * call site at once, across specs that have nothing to do with the change.
 * `exact` because other screens carry `Buscar por …` labels of their own.
 */
export function tableViewSearchBox(page: Page) {
  return page.getByLabel('Buscar', { exact: true });
}

/** Type a term into the TableView search box. */
export async function searchTableView(page: Page, term: string): Promise<void> {
  await tableViewSearchBox(page).fill(term);
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
 * The open filter popover for one column.
 *
 * ⚠️ Every control inside a filter popover MUST be located through this, never
 * through `page`. Mantine's `Popover.Dropdown` carries `role="dialog"` plus
 * `aria-labelledby` pointing at the `Filtrar <label>` trigger, so each open
 * popover is a dialog with a UNIQUE accessible name — that is the only thing
 * distinguishing its "Aplicar" / "Limpar" / `<label> contém` controls from
 * identically-named controls anywhere else on the page.
 *
 * Page-scoped locators worked only while the column header was the sole filter
 * surface. `ActiveFilters.tsx` already records the sibling rule for chips
 * ("Nothing here may render a bare column label"); this is the same invariant
 * one layer up, and it is what lets a screen grow a filter panel without
 * reopening every call site.
 *
 * Every input inside renders with `withinPortal: false` (ColumnFilter.tsx), so
 * Select listboxes and date pickers live inside this dialog too, not in a portal.
 */
function filterPopover(page: Page, columnLabel: string) {
  return page.getByRole('dialog', { name: `Filtrar ${columnLabel}`, exact: true });
}

/** Open a column's filter popover via its `Filtrar <label>` icon. */
async function openColumnFilter(page: Page, columnLabel: string) {
  await page.getByRole('button', { name: `Filtrar ${columnLabel}`, exact: true }).click();
  return filterPopover(page, columnLabel);
}

/**
 * Open a column's filter popover, type a substring and apply (string columns →
 * `contains`).
 */
export async function applyTextFilter(
  page: Page,
  columnLabel: string,
  value: string,
): Promise<void> {
  const popover = await openColumnFilter(page, columnLabel);
  await popover.getByLabel(`${columnLabel} contém`, { exact: true }).fill(value);
  await popover.getByRole('button', { name: 'Aplicar', exact: true }).click();
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
  const popover = await openColumnFilter(page, columnLabel);
  // `getByLabel` also matches the Select's `role="listbox"` popup (same
  // `aria-labelledby`); target the combobox input explicitly.
  await popover.getByRole('combobox', { name: columnLabel, exact: true }).click();
  await popover.getByRole('option', { name: optionLabel, exact: true }).click();
}

/** Open a column's filter popover and click "Limpar". */
export async function clearColumnFilter(page: Page, columnLabel: string): Promise<void> {
  const popover = await openColumnFilter(page, columnLabel);
  await popover.getByRole('button', { name: 'Limpar', exact: true }).click();
}

/**
 * Click a column header to cycle its sort (different col → asc; same → flip).
 * Targets the header's label span by exact text — the sort `onClick` lives on
 * the wrapping group, so the click bubbles up to it.
 *
 * ⚠️ Scoped to `thead`. The label text is not unique on the page: a filter
 * surface listing the same column names would make a page-scoped
 * `getByText(label, { exact: true })` resolve to several nodes and fail
 * Playwright strict mode on every sort call site at once.
 */
export async function clickColumnSort(page: Page, columnLabel: string): Promise<void> {
  await page.locator('thead').getByText(columnLabel, { exact: true }).click();
}

/** Check the selection checkbox of the row containing `text`. */
export async function selectRowByText(page: Page, text: string): Promise<void> {
  const row = page.getByRole('row', { name: new RegExp(text) });
  await row.getByRole('checkbox').check();
}

/** Uncheck the selection checkbox of the row containing `text`. */
export async function deselectRowByText(page: Page, text: string): Promise<void> {
  const row = page.getByRole('row', { name: new RegExp(text) });
  await row.getByRole('checkbox').uncheck();
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
    // `exact: true` — without it Playwright's substring match makes
    // 'Confirmar' match both the modal's own button AND an ActionBar action
    // whose label starts with "Confirmar" (e.g. "Confirmar entrega", #549),
    // a strict-mode violation the moment such an action exists.
    await page.getByRole('button', { name: 'Confirmar', exact: true }).click();
  }
}
