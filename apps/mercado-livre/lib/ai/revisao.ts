import type { AiAttributeSuggestion } from '@delfrance/integrations-mercado-livre';

/**
 * The prior answer a revise turn echoes back, cleaned.
 *
 * ⚠️ This is **client input**, not model output. The route used to cast the raw
 * array straight to `AiAttributeSuggestion[]`, which made two things possible: a
 * single `null` entry crashed `buildAttributePrompt` (it maps `a.id`) into a 500,
 * and an unbounded array walked into the prompt uncapped while `feedback` next to
 * it was capped at 1000 characters — a token bill with no ceiling on a per-click
 * path.
 */

/**
 * Cap on the prior answer.
 *
 * A legitimate one comes straight back from this same route, which caps the
 * response schema at `maxProperties` (40 by default) — so anything longer never
 * came from us, and rejecting is honest rather than truncating something the
 * operator can see on screen.
 */
export const MAX_ANTERIOR = 60;

/**
 * Keep the entries that are actually usable and drop the rest.
 *
 * ⚠️ Length is a 400 but a malformed ENTRY is dropped, and the asymmetry is
 * deliberate: an oversized payload is a bounded-resource question the caller must
 * fix, while a junk entry is the same "untrusted shape" problem
 * `applyAiAttributes` already answers by skipping — being stricter here would
 * fail a whole revision over one bad row the model never needed.
 *
 * Only `id` and `value_name` reach the prompt; `value_id`/`unit_id` are carried
 * so the shape stays honest to its type.
 */
export function normalizarAnterior(raw: unknown): AiAttributeSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const out: AiAttributeSuggestion[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) continue;
    const s = item as Record<string, unknown>;
    if (typeof s.id !== 'string' || s.id.trim() === '') continue;
    if (typeof s.value_name !== 'string') continue;
    out.push({
      id: s.id,
      value_id: typeof s.value_id === 'string' ? s.value_id : null,
      value_name: s.value_name,
      unit_id: typeof s.unit_id === 'string' ? s.unit_id : null,
    });
  }
  return out;
}
