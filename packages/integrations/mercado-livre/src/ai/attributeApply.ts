/**
 * Turning a model's raw JSON answer into Mercado Livre attribute values.
 *
 * Everything a model returns is untrusted input: keys we never asked for,
 * values outside a closed list, numbers where strings were specified, the `-1`
 * sentinel it was told not to use. This module is the boundary that makes the
 * answer safe to *show* — and only to show. Suggestions are staged in a review
 * modal, never written straight to a listing (#799's own criterion, and what
 * the newer legacy flow already did with its Cancelar/Aplicar dialog).
 */
import type { AiAttributeSpec } from './attributeSchema';

/** One suggested value, in the shape the listing editor's rows use. */
export interface AiAttributeSuggestion {
  id: string;
  value_id: string | null;
  value_name: string;
  unit_id: string | null;
}

/** ML's "does not apply" marker — a human-only choice. */
const NA_VALUE_ID = '-1';

const NA_TEXTS = new Set(['n/a', 'na', 'não se aplica', 'nao se aplica', '-1', 'null', 'none']);

/**
 * Map a model answer onto suggestions the editor can stage.
 *
 * Dropped, in order: keys the category does not define (a stale answer for a
 * category the operator has since changed), blank values, and anything that
 * reads as "does not apply". An enumerated attribute whose value matches no
 * option is kept as free text — ML rejects it and says which one, which is more
 * useful than a silent omission.
 */
export function applyAiAttributes(
  attrs: AiAttributeSpec[],
  answer: unknown,
): AiAttributeSuggestion[] {
  if (answer == null || typeof answer !== 'object' || Array.isArray(answer)) return [];
  const byId = new Map(attrs.map((a) => [a.id, a]));
  const out: AiAttributeSuggestion[] = [];

  for (const [id, raw] of Object.entries(answer as Record<string, unknown>)) {
    const attr = byId.get(id);
    if (!attr) continue;

    const text = coerceText(raw);
    if (text == null) continue;
    if (NA_TEXTS.has(normalize(text))) continue;

    const match = attr.values.find(
      (v) => typeof v.name === 'string' && normalize(v.name) === normalize(text),
    );
    if (match) {
      // ⚠️ The text guard above cannot be the only one. `NA_TEXTS` is a fixed
      // list, and ML localises the sentinel's NAME freely ("Não aplicável",
      // "Sem especificar", …), so an unlisted spelling matches a real option
      // and pushes `match.id` — the sentinel — straight through. The id is the
      // identity; drop it whatever ML calls it.
      if (match.id === NA_VALUE_ID) continue;
      out.push({
        id,
        value_id: match.id ?? null,
        value_name: match.name!,
        unit_id: null,
      });
      continue;
    }

    out.push({
      id,
      value_id: null,
      value_name: text,
      // ML wants the unit alongside a bare number; the wire transform appends
      // it. The legacy left this null and shipped "55" for a length in cm.
      unit_id: attr.valueType === 'number_unit' ? attr.defaultUnit : null,
    });
  }

  return out;
}

/**
 * Models emit `55`, `"55"` and `true` interchangeably however the schema is
 * written, so the boundary normalises rather than rejects. Objects and arrays
 * are dropped: an attribute value is a scalar, and anything else is the model
 * ignoring the schema.
 */
function coerceText(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null;
  if (typeof raw === 'boolean') return raw ? 'Sim' : 'Não';
  return null;
}

/** Accent- and case-insensitive, matching the editor's own value resolution. */
function normalize(s: string): string {
  return s
    .trim()
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/**
 * Which suggestions the review modal should pre-check.
 *
 * Only those landing on an attribute that is currently EMPTY. A suggestion that
 * would overwrite a value an operator typed starts unchecked — visible, so it
 * can be accepted deliberately, but never applied by default.
 */
export function preCheckedSuggestionIds(
  suggestions: AiAttributeSuggestion[],
  current: Array<{ id: string; value_id?: string | null; value_name?: string | null }>,
): string[] {
  const filled = new Set(
    current
      .filter(
        (row) =>
          (row.value_id != null && row.value_id !== '') ||
          (typeof row.value_name === 'string' && row.value_name.trim() !== ''),
      )
      .map((row) => row.id),
  );
  return suggestions.filter((s) => !filled.has(s.id)).map((s) => s.id);
}

export { NA_VALUE_ID };
