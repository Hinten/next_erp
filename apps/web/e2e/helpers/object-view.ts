import { type Page, errors, expect } from '@playwright/test';

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
 * Read the number a BRL-masked field is actually holding.
 *
 * Mirrors `parseBrl` in `apps/web/app/(app)/produtos/_components/CurrencyInput.tsx`
 * — deliberately duplicated rather than imported, so an e2e helper does not
 * reach into app internals to check the app. Handles both display states: the
 * focused one (`R$ 40`, `fixedDecimalScale` off) and the idle one (`R$ 40,00`).
 */
function parseBrlText(raw: string): number | null {
  const cleaned = raw
    .replace(/[^\d.,-]/g, '') // drop "R$", spaces, NBSP
    .replace(/\.(?=.*,)/g, '') // dots before a comma are thousands → drop
    .replace(',', '.'); // decimal comma → dot
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fill a BRL-masked money input (`CurrencyInput`) found by accessible name.
 * Playwright's `.fill()` mis-scales a fixed-decimal masked input — it sets the
 * value wholesale and `react-number-format` reads "30" as 3000 — so clear and
 * type the digits like a real user, which the mask handles correctly.
 *
 * ⚠️ The clear RACES the form's async hydration, which is why it is retried as
 * one unit with the typing and then verified. `pressSequentially` appends: if
 * the stored value lands between the select-all and the keystrokes, a field
 * holding 35 typed with '40' ends up reading **3540**. That is the worst shape
 * a test failure can take — a plausible wrong number rather than a visible
 * error — and on these specs, which share one produto across tests, it poisons
 * the next test as well. It is exactly how the emulator lane went red on
 * PR #1203: one test got 3540 instead of 40, and the next timed out waiting for
 * a value it could no longer produce.
 *
 * Verification is on the number the field HOLDS, never on the keystrokes sent —
 * the append case sends exactly the right keystrokes.
 */
export async function typeMoney(page: Page, name: string, value: string): Promise<void> {
  const input = page.getByRole('textbox', { name });
  const wanted = parseBrlText(value);
  await expect(input).toBeEnabled();

  await expect(async () => {
    await input.click();
    await input.press('ControlOrMeta+a');
    await input.press('Delete');
    // Prove the field is empty before typing rather than assuming the clear
    // landed; a re-hydration mid-clear simply fails here and the block retries.
    // The prefix may or may not survive an empty value, so accept either.
    expect(parseBrlText(await input.inputValue())).toBeNull();
    await input.pressSequentially(value);
    expect(parseBrlText(await input.inputValue())).toBe(wanted);
  }).toPass({ timeout: 10_000 });

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
 * Per-attempt budget for the authoritative Firestore snapshot to reach a record
 * that was just re-opened after a save.
 *
 * ## Two different things went wrong here; this budget only addresses one
 *
 * `ObjectView` paints the snapshot it can get *immediately* and corrects it
 * afterwards: `onSnapshot` emits `fromCache: true` first, and `saveRecord`
 * commits in a transaction — no latency compensation — while `onSaved` navigates
 * away, tearing the listener down before the server echo. `useServerTruthSeed`
 * re-seeds once the authoritative `fromCache: false` snapshot arrives.
 *
 * **The structural bug was that it usually never arrived at all.** The SDK's
 * `QueryListener.shouldRaiseEvent` delivers a change-free snapshot only when the
 * cache -> server transition coincides with `includeMetadataChanges: true`, and
 * the shared hooks did not pass it — so `fromCache` flipped only when the server
 * copy also differed in DATA. That is fixed at the source now, in
 * `packages/data/src/hooks/useSnapshot.ts`, and guarded by
 * `packages/config-eslint/rules/snapshot-metadata-changes.test.js`. Waiting here
 * would never have fixed it: there was nothing in flight to wait for.
 *
 * **The residual flake is a genuinely stalled stream**, which is what the budget
 * and the reload are for. Widening it alone was tried (5s -> 15s, #799) and went
 * red anyway, because the watch stream backs off exponentially (1s, x1.5, capped
 * at 60s) and `OnlineStateTracker` concludes "offline" after 10s and serves
 * cache. Once the initial handshake misses, retries land FURTHER apart — so a
 * stalled load is no likelier to converge at 30s than at 15s, while a fresh page
 * load resets the backoff and typically converges in under two seconds.
 *
 * Hence a per-attempt budget rather than a total: {@link waitForServerSnapshot}
 * spends it, reloads, and spends it again. 10s is deliberate — past that the SDK
 * has already given up and is serving cache, so more waiting buys nothing.
 */
export const SERVER_TRUTH_TIMEOUT = 10_000;

/**
 * Block until the form on screen is showing SERVER truth, reloading once if the
 * stream stalls.
 *
 * `ObjectView` advertises which snapshot it painted from on its `<form>` as
 * `data-snapshot-source={'pending'|'cache'|'server'}`. Waiting on that instead of
 * on the field's value is what makes a failure here diagnosable: `cache` means
 * the stream never delivered and the field is showing the pre-save value;
 * `pending` means no snapshot arrived at all (dead listener, wrong id); and a
 * value that is still wrong AFTER this returns is a genuinely lost write. Read
 * off the value alone, all three produce the identical `toHaveValue` failure —
 * which is exactly what cost PR #1241 a full investigation.
 *
 * ⚠️ The reload is safe only because these helpers are contracted to run right
 * after a save + `goto`/reload, on a pristine form with nothing on screen worth
 * preserving. Do NOT reach for this mid-interaction.
 */
export async function waitForServerSnapshot(page: Page): Promise<{ reloaded: boolean }> {
  const served = page.locator('form[data-snapshot-source="server"]');
  try {
    await served.waitFor({ state: 'attached', timeout: SERVER_TRUTH_TIMEOUT });
    return { reloaded: false };
  } catch (err) {
    // Only a timeout means "stalled, try a fresh connection". A strict-mode
    // violation (two ObjectViews on one page) or a closed page is a real
    // problem and must not be retried into a confusing second failure.
    if (!(err instanceof errors.TimeoutError)) throw err;
  }
  // Say so even though we are about to recover. A stall that the reload fixes
  // leaves no other trace, and a lane that starts logging this on every spec is
  // telling you staging is degrading — which is worth seeing BEFORE it turns
  // into a red build nobody can reproduce.
  // Deliberately does not read the DOM to report WHICH state it stalled in: that
  // read can itself throw on the failure path, and the distinction is already in
  // the assertion below if the reload does not save us.
  console.warn(
    `[server-snapshot] no server snapshot after ${SERVER_TRUTH_TIMEOUT}ms on ${page.url()} —` +
      ' reloading to reset the watch-stream backoff',
  );
  // Reload rather than wait longer — see SERVER_TRUTH_TIMEOUT. Asserted through
  // `expect` this time so the failure names what the form actually settled on
  // (`cache` / `pending`) instead of just reporting a missing selector.
  await page.reload();
  await expect(page.locator('form[data-snapshot-source]')).toHaveAttribute(
    'data-snapshot-source',
    'server',
    { timeout: SERVER_TRUTH_TIMEOUT },
  );
  return { reloaded: true };
}

/**
 * Turn the reload's collateral damage into a failure that explains itself.
 *
 * The recovery above is a real navigation, so it resets whatever view state a
 * reload cannot restore — an open tab, an expanded section, a modal. That makes
 * the two helpers below conditionally navigating, which their names do not
 * advertise: a call from inside a tab passes every run EXCEPT a stalled one, and
 * then fails as a value mismatch on an element that is simply no longer
 * rendered. Ambiguous failures on this exact assertion are what
 * `data-snapshot-source` exists to end, so the stall path must not reintroduce
 * one.
 *
 * Only ever runs when the reload actually happened, so the healthy path pays
 * nothing.
 */
async function expectSurvivedReload(page: Page, label: string): Promise<void> {
  if (await page.getByLabel(label, { exact: true }).count()) return;
  throw new Error(
    `"${label}" is not on the page after the server-snapshot reload.\n` +
      'The snapshot stalled, so the helper reloaded to reset the watch-stream ' +
      'backoff — which also reset any view state the caller had set up (an open ' +
      'tab, an expanded section, a modal).\n' +
      'Fix: call `waitForServerSnapshot(page)` explicitly BEFORE entering that ' +
      'state, then assert with plain `expect(...)`. See ' +
      'canais-whatsapp.vendas.e2e.spec.ts for that shape.',
  );
}

/**
 * Assert a field's value on a record re-opened after a save.
 *
 * The value assertion runs on the DEFAULT expect timeout, and that is a
 * strengthening rather than a relaxation: the round trip it used to be padding
 * for is now waited out explicitly above, so all this has to absorb is the one
 * paint by which `data-snapshot-source` leads the inputs (the attribute flips
 * during render, `form.reset` runs in the effect after). A wrong value now
 * reports in 5s and means something specific.
 */
export async function expectFieldAfterReload(
  page: Page,
  label: string,
  value: string | RegExp,
): Promise<void> {
  const { reloaded } = await waitForServerSnapshot(page);
  if (reloaded) await expectSurvivedReload(page, label);
  await expect(page.getByLabel(label, { exact: true })).toHaveValue(value);
}

/** `expectFieldAfterReload` for a Mantine `Switch` / checkbox. */
export async function expectSwitchAfterReload(
  page: Page,
  label: string,
  checked = true,
): Promise<void> {
  const { reloaded } = await waitForServerSnapshot(page);
  if (reloaded) await expectSurvivedReload(page, label);
  await expect(page.getByLabel(label, { exact: true })).toBeChecked({ checked });
}
