import { stripMarkedForDeletion } from '@delfrance/ui';

/**
 * The save-time transform of an `int_frete` list edited with staged deletions
 * (`faixaCep`, `horarioDeCorte`): drop the rows marked for deletion and the mark
 * itself, then collapse an emptied list to `null` — the stored shape of an unset
 * list (readers accept both, but `null` keeps new docs closest to the corpus).
 *
 * A value that is not a list passes through untouched. Idempotent: applying it
 * to its own output changes nothing, so a caller may normalise a value that is
 * already prepared.
 *
 * One definition for every screen that writes these lists: the `/logistica`
 * editors' `prepareForSave`, and the channel conta screen's horário, whose
 * "changed" decision compares under it (`freteDaConta.ts`).
 */
export function stripThenNullIfEmpty(value: unknown): unknown {
  const stripped = stripMarkedForDeletion(value);
  return Array.isArray(stripped) && stripped.length === 0 ? null : stripped;
}
