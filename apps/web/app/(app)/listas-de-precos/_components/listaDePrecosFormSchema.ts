import { z } from 'zod';
import {
  evaluateFormula,
  formulaCalculoPrecoSchema,
  formulasPorCategoriaSchema,
  listaDePrecosSchema,
} from '@delfrance/schemas';
import { DELETE_MARK } from '@delfrance/ui';

/**
 * FORM-ONLY validation for `listaDePrecos` — legacy parity
 * (`listaDePrecosCadastroView.dart`): the Flutter form blocked save on a
 * formula `Parser().parse` couldn't handle, and required a non-empty
 * `limiar` no greater than 9999999999. The schema-driven editor lets
 * "C*"/"abc"/a cleared limiar through today, producing silently-dead
 * formulas — this file restores that gate.
 *
 * Kept SEPARATE from the registry `listaDePrecosSchema`: Zod 4 throws at
 * RUNTIME if `.pick()` is ever called on a schema carrying refinements (see
 * the `zod4-pick-refine-runtime-crash` note). This schema is never registered
 * in `ALL_DOMAINS` and never `.pick()`ed — only handed to `ObjectView`'s wider
 * `schema` prop (the collection itself stays typed on the plain
 * `listaDePrecosSchema`, mirroring `clienteFormSchema` / `clienteSchema`).
 */

/** Legacy cap (`listaDePrecosCadastroView.dart`): limiar must be > 0 and ≤ this. */
const LIMIAR_MAX = 9_999_999_999;

/**
 * Two structurally different variable bindings used to probe whether a
 * formula string parses at all. A formula is rejected only when BOTH probes
 * come back `null` — a single point can legitimately blow up (e.g. a
 * coincidental zero denominator for that one combination of variables)
 * without the formula itself being invalid, so one non-null result is enough
 * to accept it.
 */
const PROBE_VARS_A = { C: 2.37, c: 1.13, T: 0.91, L: 1.7, M: 0.23, I: 0.31, F: 0.19, K: 0.11 };
const PROBE_VARS_B = { C: 5.19, c: 0.47, T: 2.03, L: 0.89, M: 1.31, I: 0.67, F: 1.09, K: 0.53 };

function isParsableFormula(formula: string): boolean {
  return (
    evaluateFormula(formula, PROBE_VARS_A) !== null ||
    evaluateFormula(formula, PROBE_VARS_B) !== null
  );
}

/**
 * One `FormulaCalculoPreco` row, form-validated. Extended with the transient
 * `DELETE_MARK` key so a row staged for deletion (`formulaStrip.ts`) can be
 * recognized and skipped here: Zod's default "strip" parsing would otherwise
 * drop that key — silently, before this refinement ever ran — since it isn't
 * part of the registry row shape. This is defense-in-depth: `ObjectView`
 * already applies each field's `prepareForSave` (which drops marked rows)
 * BEFORE the resolver validates, so a marked row shouldn't reach this
 * refinement in practice either way — but the form schema stays correct on
 * its own, independent of that ordering.
 *
 * `limiar`/`formula` are widened to accept the in-progress editor state
 * (`limiar: null` while the input is cleared) so an incomplete row surfaces
 * OUR message instead of a generic Zod type-mismatch.
 */
const formulaRowFormSchema = formulaCalculoPrecoSchema
  .extend({
    limiar: z.number().nullable(),
    formula: z.string(),
    [DELETE_MARK]: z.boolean().optional(),
  })
  .superRefine((row, ctx) => {
    if (row[DELETE_MARK]) return; // staged for deletion — never blocks save.
    // `row.limiar === null` covers the cleared-input case with the same
    // message as a non-positive value — both mean "no usable threshold yet".
    if (row.limiar === null || row.limiar <= 0) {
      ctx.addIssue({ code: 'custom', path: ['limiar'], message: 'Limiar deve ser maior que zero' });
    } else if (row.limiar > LIMIAR_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['limiar'],
        message: `Limiar deve ser no máximo ${LIMIAR_MAX}`,
      });
    }
    if (!isParsableFormula(row.formula)) {
      ctx.addIssue({ code: 'custom', path: ['formula'], message: 'Fórmula inválida' });
    }
  });

/**
 * `formulasPorCategoria` bucket, its `formulasCalculoPreco` array swapped for
 * the row-validated variant above — the same per-row rules apply whether the
 * formula lives at the top level or inside a category bucket.
 */
const formulasPorCategoriaFormSchema = formulasPorCategoriaSchema.extend({
  formulasCalculoPreco: z.array(formulaRowFormSchema).nullable().optional(),
});

/**
 * Form-only `listaDePrecos` schema: identical persisted shape to
 * `listaDePrecosSchema`, with every formula row (top-level
 * `formulasCalculoPreco` AND inside every `formulasPorCategoria` bucket)
 * validated per-row. Pass to `ObjectView`'s `schema` prop; `collection` stays
 * on the plain `listaDePrecosSchema`.
 */
export const listaDePrecosFormSchema = listaDePrecosSchema.extend({
  formulasCalculoPreco: z.array(formulaRowFormSchema).nullable().optional(),
  formulasPorCategoria: z.record(z.string(), formulasPorCategoriaFormSchema).nullable().optional(),
});
