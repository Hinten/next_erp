import { DELETE_MARK, stripMarkedForDeletion } from '@delfrance/ui';

/**
 * Save-time transforms for the `listaDePrecos` composite fields
 * (`formulasCalculoPreco` array + `formulasPorCategoria` record).
 *
 * They implement the staged-deletion convention (CLAUDE.md rule 7 /
 * `apps/web/CLAUDE.md` rule 7): the editors mark items with `DELETE_MARK`
 * in-place and these `prepareForSave` helpers drop the marked ones — plus the
 * transient marker on the survivors — only when the record is saved. The
 * strip is recursive because the shapes nest (a formula carries a
 * `faixasTaxaFixaPeso` array; a category bucket carries its own
 * `formulasCalculoPreco` array).
 *
 * An emptied list collapses to `null`, the shape the legacy Flutter app writes
 * when a list is unset — keeping new docs closest to legacy ones (and matching
 * the schema's `.nullable()` default).
 *
 * All functions are PURE.
 */

/** Strip marked `faixasTaxaFixaPeso` rows inside one formula; empty → null. */
function stripFormulaFaixas(formula: unknown): unknown {
  if (formula == null || typeof formula !== 'object') return formula;
  const rec = formula as Record<string, unknown>;
  const faixas = rec.faixasTaxaFixaPeso;
  if (!Array.isArray(faixas)) return formula;
  const stripped = stripMarkedForDeletion(faixas) as unknown[];
  return { ...rec, faixasTaxaFixaPeso: stripped.length === 0 ? null : stripped };
}

/**
 * `prepareForSave` for a `formulasCalculoPreco` array: drop rows marked for
 * deletion, strip the marker from survivors, then strip each survivor's marked
 * faixas. Empty → null; a non-array (e.g. `null`) passes through untouched.
 */
export function stripFormulasCalculoPreco(value: unknown): unknown {
  const stripped = stripMarkedForDeletion(value);
  if (!Array.isArray(stripped)) return stripped;
  const out = stripped.map(stripFormulaFaixas);
  return out.length === 0 ? null : out;
}

/**
 * `prepareForSave` for a `formulasPorCategoria` record: drop category entries
 * marked for deletion, strip the marker from survivors, and recursively strip
 * each bucket's nested `formulasCalculoPreco`. Empty → null; a non-record
 * (e.g. `null`) passes through untouched. An unexpected (null / non-object)
 * bucket value is preserved untouched — a corrupt entry must fail Zod
 * validation loudly, not be silently erased on save (mirrors
 * `stripMarkedForDeletion`'s pass-through for non-object array items).
 */
export function stripFormulasPorCategoria(value: unknown): unknown {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry == null || typeof entry !== 'object') {
      // Preserve as-is so validation catches it instead of erasing it.
      out[key] = entry;
      continue;
    }
    const rec = entry as Record<string, unknown>;
    if (rec[DELETE_MARK]) continue;
    const { [DELETE_MARK]: _omit, ...clean } = rec;
    out[key] = {
      ...clean,
      formulasCalculoPreco: stripFormulasCalculoPreco(clean.formulasCalculoPreco),
    };
  }
  return Object.keys(out).length === 0 ? null : out;
}
