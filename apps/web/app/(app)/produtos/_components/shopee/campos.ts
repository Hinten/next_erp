/**
 * The two narrows every block of the Shopee tab reads a stored link through.
 *
 * A soft-read hands the tab the RAW document when the schema does not parse it
 * (a migrated Flutter row, a half-written one), so a field the type calls a
 * `number` can arrive as anything. These answer `null` for whatever is not the
 * shape asked for — the tab then prints "—" instead of `NaN` or `[object
 * Object]`. Display only: no decision is taken from them.
 */

/** A finite number, or `null`. */
export function numeroFinito(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A string with at least one non-blank character, or `null`. */
export function textoPreenchido(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
