/**
 * Turning a model's raw JSON answer into Mercado Livre attribute values.
 *
 * Everything a model returns is untrusted input: keys we never asked for,
 * values outside a closed list, numbers where strings were specified, a
 * "does not apply" spelled a dozen ways. This module is the boundary that makes
 * the answer safe to *show* — and only to show. Suggestions are staged in a
 * review modal, never written straight to a listing (#799's own criterion, and
 * what the newer legacy flow already did with its Cancelar/Aplicar dialog).
 */
import { coerceText, normalizeLoose } from '@delfrance/ai';

import { NA_ENUM_LABEL, type AiAttributeSpec } from './attributeSchema';

/** One suggested value, in the shape the listing editor's rows use. */
export interface AiAttributeSuggestion {
  id: string;
  value_id: string | null;
  value_name: string;
  unit_id: string | null;
}

/** ML's platform-wide "does not apply" marker. */
const NA_VALUE_ID = '-1';

/**
 * Spellings that mean "this attribute does not apply to this product".
 *
 * ⚠️ These are now MAPPED to ML's sentinel rather than dropped. The model is
 * explicitly allowed to declare an attribute inapplicable — many genuinely are
 * (voltage on a t-shirt, sole material on a notebook) — and refusing to carry
 * that answer forced it to choose between inventing a value and omitting an
 * attribute it had correctly judged.
 *
 * `null` and `none` are deliberately NOT here any more. A model that emits
 * `null` is expressing absence, not inapplicability, and turning that into a
 * positive "does not apply" claim on a live listing is exactly the kind of
 * confident wrong answer the prompt separates omission from.
 */
const NA_TEXTS = new Set([
  'n/a',
  'na',
  'n.a.',
  'não se aplica',
  'nao se aplica',
  'não aplicável',
  'nao aplicavel',
  'no aplica',
  'not applicable',
  '-1',
]);

/**
 * The suggestion that declares an attribute inapplicable, in ML's own shape.
 *
 * `NA_ENUM_LABEL` rather than a second `'N/A'` literal: it is the spelling the
 * schema offers the model, and two constants that must agree are one rename away
 * from disagreeing silently.
 */
function naSuggestion(id: string): AiAttributeSuggestion {
  return { id, value_id: NA_VALUE_ID, value_name: NA_ENUM_LABEL, unit_id: null };
}

/**
 * Whether this text means "does not apply" FOR THIS ATTRIBUTE.
 *
 * ⚠️ `-1` is attribute-dependent, and that is the whole reason this is a
 * function. It is ML's sentinel, but it is also a perfectly ordinary value for a
 * numeric attribute — lens power, minimum operating temperature. The model was
 * told to answer `"N/A"` in words, so a bare `-1` arriving on a `number` /
 * `number_unit` attribute is far more likely to be the measurement than the
 * marker, and reading it as "does not apply" would publish a false disclaimer
 * instead of a real value.
 */
function meansNotApplicable(attr: AiAttributeSpec, text: string): boolean {
  const normalized = normalizeLoose(text);
  if (normalized === NA_VALUE_ID) {
    return attr.valueType !== 'number' && attr.valueType !== 'number_unit';
  }
  return NA_TEXTS.has(normalized);
}

/**
 * Map a model answer onto suggestions the editor can stage.
 *
 * Dropped: keys the category does not define (a stale answer for a category the
 * operator has since changed) and blank values. An enumerated attribute whose
 * value matches no option is kept as free text — ML rejects it and says which
 * one, which is more useful than a silent omission.
 *
 * ⚠️ "Does not apply" is a RESULT, not a drop. It maps to ML's `-1` sentinel and
 * is staged like any other suggestion, so the operator still confirms it before
 * it reaches a listing. An OMITTED key remains the model's way of saying "I do
 * not know" — the prompt draws that line explicitly, and this function is what
 * makes both halves reachable.
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

    // ⚠️ A REAL option beats the spelling heuristic, so this match runs FIRST.
    // `NA_TEXTS` is a fixed list of ways to write "does not apply", and some of
    // them are also legitimate closed-list values — an `ORIGIN` attribute really
    // can offer an option named "NA". While a false hit merely DROPPED the
    // answer that was invisible and harmless; now it emits `value_id: '-1'`, a
    // positive claim staged for one click, so the cost of being wrong went from
    // "nothing shown" to "a false disclaimer on a live listing".
    const match = attr.values.find(
      (v) => typeof v.name === 'string' && normalizeLoose(v.name) === normalizeLoose(text),
    );
    if (match) {
      // The id is the identity: ML localises the sentinel's NAME freely, so a
      // spelling `NA_TEXTS` does not know can still match a real option whose
      // id is `-1`. Normalise it to the same shape rather than shipping ML's
      // localised label as if it were a chosen value.
      if (match.id === NA_VALUE_ID) {
        out.push(naSuggestion(id));
        continue;
      }
      out.push({
        id,
        value_id: match.id ?? null,
        value_name: match.name!,
        unit_id: null,
      });
      continue;
    }

    if (meansNotApplicable(attr, text)) {
      out.push(naSuggestion(id));
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
 * Which suggestions the review modal should pre-check.
 *
 * Only those landing on an attribute that is currently EMPTY. A suggestion that
 * would overwrite a value an operator typed starts unchecked — visible, so it
 * can be accepted deliberately, but never applied by default.
 *
 * ⚠️ An N/A suggestion is NEVER pre-checked, even though the attribute it lands
 * on is by definition empty. `-1` **satisfies ML's required check**
 * (`apps/web/lib/mercado-livre/attributeForm.ts`), so pre-checking it would make
 * the default path for a required attribute the model judged inapplicable:
 * checked → applied on one bulk "Aplicar" → published as a positive disclaimer
 * that also silences the very validation meant to catch the missing value.
 * Allowing the model to SAY "does not apply" and requiring a human to ACCEPT it
 * are separate decisions; this is where the second one is kept real.
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
  return suggestions
    .filter((s) => !filled.has(s.id) && s.value_id !== NA_VALUE_ID)
    .map((s) => s.id);
}

export { NA_VALUE_ID };
