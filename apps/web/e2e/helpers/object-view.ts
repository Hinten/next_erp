import { type Page, expect } from '@playwright/test';

/**
 * Fill a `<TextInput>` rendered by `ObjectView` for the given accessible
 * label. The renderer wires `label` to the input's `<label for>` so
 * Playwright's `getByLabel` matches without us guessing CSS classes.
 */
export async function fillField(
  page: Page,
  label: string,
  value: string,
): Promise<void> {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(value);
  // Blur to trigger RHF's onBlur validation step.
  await input.blur();
}

/**
 * Click the primary "Salvar" / `saveLabel` button. Pass a custom label when
 * the page uses one (e.g. "Criar", "Salvar alterações").
 */
export async function clickSave(page: Page, label = 'Salvar'): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click();
}

export async function clickSaveAndContinue(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Salvar e continuar' }).click();
}

/**
 * Clear a nullable string field via the ✕ rightSection button. Asserts the
 * button exists (would throw otherwise).
 */
export async function clearNullableField(
  page: Page,
  label: string,
): Promise<void> {
  // The clear button sits inside the same TextInput root that hosts `label`.
  // Scope by walking from the label to the surrounding wrapper.
  const input = page.getByLabel(label, { exact: true });
  const wrapper = input.locator('xpath=ancestor::div[contains(@class, "mantine-TextInput-root")][1]');
  await wrapper.getByRole('button', { name: 'Limpar' }).click();
}

/**
 * Assert that a Mantine notification matching `matcher` (string substring
 * or RegExp) was shown.
 *
 * Mantine 9 renders notifications as `role="alert"` with the message in
 * children — there is no public `data-color` attribute, so we assert by
 * accessible role + text rather than by color class. Callers pass a string
 * fragment that uniquely identifies the toast they expect.
 */
export async function expectToast(
  page: Page,
  matcher: string | RegExp,
): Promise<void> {
  const toast = page
    .getByRole('alert')
    .filter({ hasText: matcher })
    .first();
  await expect(toast).toBeVisible({ timeout: 5_000 });
}

/**
 * Assert the unsaved-changes confirm modal is open (visible) for the pager
 * or for any in-app navigation we wire later.
 */
export async function expectDiscardChangesModal(page: Page): Promise<void> {
  await expect(
    page.getByRole('dialog').filter({ hasText: 'Descartar alterações' }),
  ).toBeVisible({ timeout: 3_000 });
}
