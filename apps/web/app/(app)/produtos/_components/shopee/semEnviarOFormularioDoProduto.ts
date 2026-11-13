import type { KeyboardEvent } from 'react';

/**
 * ⚠️ The Shopee draft sits INSIDE the produto's `<form>` (ObjectView, with a submit button):
 * Enter in a single-line input would submit THAT form (an implicit submission) — saving the
 * produto, not the draft. A SEARCHABLE `Select` / `MultiSelect` is a real text `<input>` too,
 * and Mantine prevents Enter there only while an option is highlighted in an open dropdown (its
 * own handler, which runs after this one, still picks that option). Only Enter (by `key`, so
 * NumpadEnter too): every other key passes.
 *
 * One guard for every draft input that needs it — the title, the attribute controls and the
 * brand `Select` — so the rule cannot drift between private copies.
 */
export function semEnviarOFormularioDoProduto(e: KeyboardEvent<HTMLInputElement>): void {
  if (e.key === 'Enter') e.preventDefault();
}
