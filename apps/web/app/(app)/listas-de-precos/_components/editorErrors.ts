/**
 * Helpers for reading per-row validation messages out of the raw RHF error
 * node (`FieldRenderProps.errorTree`), for the staged-deletion array editors
 * on the `listaDePrecos` form.
 *
 * Validation runs on the `prepareForSave`-transformed value (ObjectView's
 * validate-what-you-save resolver), so the error indices refer to the array
 * WITH marked rows removed. `validatedIndices` maps a visible row back to its
 * validated index by counting unmarked rows before it. Mirrors the logistica
 * `editorErrors` helpers (kept local to avoid coupling the two features).
 */

function messageOf(node: unknown): string | undefined {
  if (node == null || typeof node !== 'object') return undefined;
  const msg = (node as { message?: unknown }).message;
  return typeof msg === 'string' ? msg : undefined;
}

/** Message for `errorTree[index][key]` (array-of-objects editors). */
export function rowFieldError(errorTree: unknown, index: number, key: string): string | undefined {
  if (index < 0 || errorTree == null || typeof errorTree !== 'object') return undefined;
  const row = (errorTree as Record<number, unknown>)[index];
  if (row == null || typeof row !== 'object') return undefined;
  return messageOf((row as Record<string, unknown>)[key]);
}

/**
 * Map each visible row to its index in the VALIDATED array (marked rows are
 * stripped before validation, so they get -1 and unmarked rows get the count
 * of unmarked rows before them). Pure — computed once per render, outside JSX
 * callbacks.
 */
export function validatedIndices(rows: ReadonlyArray<unknown>, deleteMark: string): number[] {
  const out: number[] = [];
  let next = 0;
  for (const row of rows) {
    const marked =
      row != null &&
      typeof row === 'object' &&
      (row as Record<string, unknown>)[deleteMark] === true;
    out.push(marked ? -1 : next++);
  }
  return out;
}
