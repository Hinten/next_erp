/**
 * Reading scalar values out of an untrusted model answer.
 *
 * Both helpers were private to `attributeApply.ts` until a second agent needed
 * exactly the same behaviour. They are lifted rather than copied because the
 * two must never drift: a suggestion is resolved against a closed list by
 * `normalizeLoose`, and a copy that normalised differently would silently turn
 * a valid choice into free text that the provider then rejects.
 */

/**
 * Accent- and case-insensitive, matching the editors' own value resolution.
 *
 * The legacy compared raw strings, so a model answering `Algodao` fell through
 * to free text and Mercado Livre rejected the listing.
 */
export function normalizeLoose(s: string): string {
  return s
    .trim()
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/**
 * Models emit `55`, `"55"` and `true` interchangeably however the schema is
 * written, so the boundary normalises rather than rejects. Objects and arrays
 * are dropped: a cell value is a scalar, and anything else is the model
 * ignoring the schema.
 */
export function coerceText(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null;
  if (typeof raw === 'boolean') return raw ? 'Sim' : 'Não';
  return null;
}
