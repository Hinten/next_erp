import { type Page, expect } from '@playwright/test';

/**
 * Helpers for driving the generic `ObjectView` (`@delfrance/ui`): field
 * inputs, save buttons, the typed-confirm delete modal and validation
 * assertions.
 */

/**
 * Fill a `<TextInput>` rendered by `ObjectView` for the given accessible
 * label. The renderer wires `label` to the input's `<label for>` so
 * `getByLabel` matches without guessing CSS classes. Use `selectField` for
 * enum (`Select`) fields.
 */
export async function fillField(page: Page, label: string, value: string): Promise<void> {
  const input = page.getByLabel(label, { exact: true });
  await input.fill(value);
  // Blur to trigger RHF's onBlur validation step.
  await input.blur();
}

/**
 * Fill a BRL-masked money input (`CurrencyInput`) found by accessible name.
 * Playwright's `.fill()` mis-scales a fixed-decimal masked input — it sets the
 * value wholesale and `react-number-format` reads "30" as 3000 — so clear and
 * type the digits like a real user, which the mask handles correctly.
 */
export async function typeMoney(page: Page, name: string, value: string): Promise<void> {
  const input = page.getByRole('textbox', { name });
  await input.click();
  await input.press('ControlOrMeta+a');
  await input.press('Delete');
  await input.pressSequentially(value);
  await input.blur();
}

/** Pick an option in a Mantine `Select` field (enum kind) by its label. */
export async function selectField(page: Page, label: string, optionText: string): Promise<void> {
  // `getByLabel` also matches the Select's `role="listbox"` popup (same
  // `aria-labelledby`); target the combobox input explicitly.
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: optionText, exact: true }).click();
}

/**
 * Pick an option in a searchable Mantine `Select` whose option list is
 * server-filtered (e.g. `CollectionSelect`). Opens the combobox, types
 * `searchText` to trigger the server query, then clicks the matching option.
 * `optionText` defaults to `searchText` for the common type-the-exact-name
 * case; pass a RegExp when the option's accessible name carries extra text
 * (e.g. the `optionHintField` second line on `ClientePicker` options).
 */
export async function selectFieldWithSearch(
  page: Page,
  label: string,
  searchText: string,
  optionText: string | RegExp = searchText,
): Promise<void> {
  const combobox = page.getByRole('combobox', { name: label, exact: true });
  await combobox.click();
  await combobox.fill(searchText);
  const option =
    typeof optionText === 'string'
      ? page.getByRole('option', { name: optionText, exact: true })
      : page.getByRole('option', { name: optionText }).first();
  await option.click();
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
 * Clear a nullable string field via the ✕ rightSection button.
 */
export async function clearNullableField(page: Page, label: string): Promise<void> {
  const input = page.getByLabel(label, { exact: true });
  const wrapper = input.locator(
    'xpath=ancestor::div[contains(@class, "mantine-TextInput-root")][1]',
  );
  await wrapper.getByRole('button', { name: 'Limpar' }).click();
}

/**
 * Run the ObjectView delete flow: click "Excluir" to open the modal, type
 * the literal word "excluir" into the confirm field, then confirm.
 */
export async function confirmDelete(page: Page): Promise<void> {
  // Before the modal opens there is only one "Excluir" button (the row
  // action). Clicking it opens the confirmation modal.
  await page.getByRole('button', { name: 'Excluir', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Digite "excluir" para confirmar', { exact: true }).fill('excluir');
  await dialog.getByRole('button', { name: 'Excluir', exact: true }).click();
}

/**
 * Assert a field (by label) is in the Mantine error state. Mantine wires
 * `aria-invalid="true"` onto an input whose `error` prop is set.
 */
export async function expectFieldError(page: Page, label: string): Promise<void> {
  await expect(page.getByLabel(label, { exact: true })).toHaveAttribute('aria-invalid', 'true', {
    timeout: 5_000,
  });
}

/** Assert a specific validation message is visible (stable custom messages). */
export async function expectErrorText(page: Page, matcher: string | RegExp): Promise<void> {
  await expect(page.getByText(matcher).first()).toBeVisible({ timeout: 5_000 });
}

/**
 * Assert that a Mantine notification matching `matcher` was shown. Mantine 9
 * renders notifications as `role="alert"` — assert by role + text.
 */
export async function expectToast(page: Page, matcher: string | RegExp): Promise<void> {
  const toast = page.getByRole('alert').filter({ hasText: matcher }).first();
  await expect(toast).toBeVisible({ timeout: 5_000 });
}

/**
 * Budget for a value that has to survive a save followed by a full page load.
 *
 * ## Why the default 5s is not a valid budget here
 *
 * `ObjectView` deliberately paints the Firestore snapshot it can get
 * *immediately* and corrects it afterwards. With `persistentLocalCache`,
 * `onSnapshot` emits `fromCache: true` FIRST, and `saveRecord` commits in a
 * transaction — which has no latency compensation — while the screen navigates
 * away in `onSaved`, tearing the listener down before the server echo lands. So
 * the local cache still holds the pre-save value when the record is re-opened.
 * `useServerTruthSeed` re-seeds the form once the authoritative
 * `fromCache: false` snapshot arrives; on a cold page load that includes
 * re-establishing the Firestore connection, which 5s does not reliably cover.
 *
 * ⚠️ This widens the window, it does NOT weaken the assertion: the same
 * converged value is still required, so a regression that never converges still
 * fails. Use it ONLY after a save + `goto`/reload. A same-page assertion must
 * keep the default, or it stops catching a genuine hang.
 */
export const SERVER_TRUTH_TIMEOUT = 15_000;

/** Assert a field's value on a record re-opened after a save. */
export async function expectFieldAfterReload(
  page: Page,
  label: string,
  value: string | RegExp,
): Promise<void> {
  await expect(page.getByLabel(label, { exact: true })).toHaveValue(value, {
    timeout: SERVER_TRUTH_TIMEOUT,
  });
}

/** `expectFieldAfterReload` for a Mantine `Switch` / checkbox. */
export async function expectSwitchAfterReload(
  page: Page,
  label: string,
  checked = true,
): Promise<void> {
  const control = page.getByLabel(label, { exact: true });
  await expect(control).toBeChecked({ checked, timeout: SERVER_TRUTH_TIMEOUT });
}
