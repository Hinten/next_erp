/**
 * Staging a grid-shaped suggestion: the cell key, and the pre-check rule.
 *
 * Both are agent-neutral — they only need a `(rowKey, attributeId)` pair and a
 * way to ask whether that cell already holds something. They live here rather
 * than beside the size-chart agent because the review UI in `apps/web` is their
 * only production consumer, and `apps/web` cannot import the Mercado Livre
 * package: its root is server-only (the OAuth core handles the app
 * `clientSecret`) and must never reach a browser bundle.
 *
 * ⚠️ That constraint is why this is not simply imported from the channel
 * package. A local copy in `apps/web` was the alternative, and it would have
 * been two implementations of one rule with the tested one having no caller —
 * the same trade `normalizeLoose` and `coerceText` already made in this package.
 */

/** The minimum a suggestion needs to be staged in a grid. */
export interface AiGridCellRef {
  rowKey: string;
  attributeId: string;
}

/**
 * Stable identity for one proposed cell — the review modal's checkbox key.
 *
 * `::` rather than a bare separator because `rowKey` is a document path and
 * carries slashes; the pair is never parsed back apart, only compared.
 */
export function aiCellKey(rowKey: string, attributeId: string): string {
  return `${rowKey}::${attributeId}`;
}

/**
 * Which suggestions a review UI should pre-check.
 *
 * Only those landing on a cell that is currently EMPTY. A suggestion that would
 * overwrite something an operator typed starts unchecked — visible, so it can be
 * accepted deliberately, but never applied by default.
 */
export function preCheckedCells<T extends AiGridCellRef>(
  suggestions: readonly T[],
  isFilled: (rowKey: string, attributeId: string) => boolean,
): string[] {
  return suggestions
    .filter((s) => !isFilled(s.rowKey, s.attributeId))
    .map((s) => aiCellKey(s.rowKey, s.attributeId));
}
