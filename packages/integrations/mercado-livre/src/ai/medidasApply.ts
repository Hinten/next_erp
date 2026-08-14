/**
 * Turning a model's raw JSON answer into size-chart cell suggestions.
 *
 * Everything a model returns is untrusted input: row keys for sizes that are not
 * in the grid, values outside a closed list, numbers where strings were
 * specified, nested objects where a scalar was. This module is the boundary that
 * makes the answer safe to *show* — and only to show. Suggestions are staged in
 * a review modal and applied cell by cell by the operator; nothing here writes.
 */
import { aiCellKey, coerceText, normalizeLoose, preCheckedCells } from '@delfrance/ai';

import { NA_VALUE_ID } from './attributeApply';
import type { MedidaColumnSpec, MedidaRowSpec } from './medidasSchema';

/** One suggested cell, in the shape the editor's grid state uses. */
export interface AiMedidaSuggestion {
  /** The editor's stable row key — resolved back from the size label. */
  rowKey: string;
  attributeId: string;
  /** Set only when the value matched a closed-list option. */
  value_id: string | null;
  value_name: string;
}

/** Reads as "does not apply" in any of the spellings a model reaches for. */
const NA_TEXTS = new Set([
  'n/a',
  'na',
  'não se aplica',
  'nao se aplica',
  '-1',
  'null',
  'none',
  '-',
]);

/**
 * Map a model answer onto suggestions the grid can stage.
 *
 * Dropped, in order: size labels the grid does not have (the model inventing a
 * row, or answering for a chart the operator has since changed), attribute ids
 * outside the requested columns, non-object row values, blanks, and anything
 * reading as "does not apply".
 *
 * An enumerated column whose value matches no option is kept as free text —
 * Mercado Livre rejects it and says which cell, which is more useful to the
 * operator than a silent omission.
 */
export function applyAiMedidas(
  rows: MedidaRowSpec[],
  columns: MedidaColumnSpec[],
  answer: unknown,
): AiMedidaSuggestion[] {
  if (!isRecord(answer)) return [];

  // Size label → row key. Normalised so "p" and "P" land on the same row: the
  // model reads the label off a photo, and casing there is not meaningful.
  const rowBySize = new Map<string, string>();
  for (const row of rows) {
    const size = normalizeLoose(row.size);
    if (size !== '' && !rowBySize.has(size)) rowBySize.set(size, row.key);
  }
  const columnById = new Map(columns.map((c) => [c.attributeId, c]));

  const out: AiMedidaSuggestion[] = [];
  for (const [size, cells] of Object.entries(answer)) {
    const rowKey = rowBySize.get(normalizeLoose(size));
    if (rowKey == null || !isRecord(cells)) continue;

    for (const [attributeId, raw] of Object.entries(cells)) {
      const column = columnById.get(attributeId);
      if (!column) continue;

      const text = coerceText(raw);
      if (text == null) continue;
      if (NA_TEXTS.has(normalizeLoose(text))) continue;

      const match = column.values.find(
        (v) => typeof v.name === 'string' && normalizeLoose(v.name) === normalizeLoose(text),
      );
      if (match) {
        // ⚠️ The `NA_TEXTS` check above cannot be the only guard. It is a fixed
        // list of spellings, and ML localises the sentinel's NAME freely, so an
        // unlisted spelling matches a real option whose id is `-1` and pushes
        // the sentinel straight through as a staged measurement. The id is the
        // identity — drop it whatever ML calls it.
        if (match.id === NA_VALUE_ID) continue;
        out.push({ rowKey, attributeId, value_id: match.id, value_name: match.name });
        continue;
      }

      out.push({
        rowKey,
        attributeId,
        value_id: null,
        value_name: column.kind === 'number' ? normalizeDecimal(text) : text,
      });
    }
  }

  return out;
}

/**
 * `"10,5"` → `"10.5"`.
 *
 * ⚠️ Not cosmetic. `measureStruct` in the sync path parses this with `Number()`
 * after a single comma→dot replace to build ML's `struct: {number, unit}`, and a
 * value ML cannot parse is rejected at send time with a per-cell error the
 * operator then has to fix by hand. Brazilian size tables print commas, so the
 * model reading one back verbatim is the *expected* case, not the odd one.
 *
 * A thousands separator (`1.234,5`) is left alone deliberately: no garment
 * measurement reaches four digits, so a string shaped like that is not a
 * measurement and guessing at it would invent data.
 */
function normalizeDecimal(text: string): string {
  const commas = (text.match(/,/g) ?? []).length;
  if (commas !== 1 || text.includes('.')) return text;
  return text.replace(',', '.');
}

/**
 * ⚠️ Both moved to `@delfrance/ai`, and are re-exported here under their old
 * names so no call site in this package changed.
 *
 * They are agent-neutral (a `(rowKey, attributeId)` pair and an "is it filled?"
 * predicate), and their only production consumer is the review modal in
 * `apps/web` — which cannot import THIS package, whose root is server-only (the
 * OAuth core handles the app `clientSecret`). Leaving them here meant either a
 * second copy in the browser or no caller at all for the tested ones.
 */
export { aiCellKey as medidaCellKey, preCheckedCells as preCheckedMedidaCells };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
