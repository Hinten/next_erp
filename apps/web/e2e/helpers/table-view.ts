import { type Page, expect } from '@playwright/test';

/**
 * Type a search term into the TableView's debounced search input. Waits
 * the debounce window (300ms) before returning so callers can immediately
 * assert against the filtered result.
 */
export async function searchTable(page: Page, term: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Buscar' }).fill(term);
  // SearchBar debounces at 300ms; pad a bit for the snapshot turnaround.
  await page.waitForTimeout(450);
}

export async function selectRowByText(
  page: Page,
  rowText: string,
): Promise<void> {
  const row = page.getByRole('row', { name: new RegExp(rowText) });
  await row.getByRole('checkbox').check();
}

/**
 * Trigger an ActionBar button and (when present) confirm the resulting
 * Mantine modal. The modal's confirm button label is "Confirmar" per
 * `packages/ui/src/table/ActionBar.tsx`.
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

export async function expectRowWithText(
  page: Page,
  text: string,
): Promise<void> {
  await expect(page.getByRole('row', { name: new RegExp(text) })).toBeVisible({
    timeout: 5_000,
  });
}

export async function expectNoRowWithText(
  page: Page,
  text: string,
): Promise<void> {
  await expect(
    page.getByRole('row', { name: new RegExp(text) }),
  ).toHaveCount(0, { timeout: 5_000 });
}
