/**
 * Staged-deletion convention for editor list fields.
 *
 * Destructive removal of an item inside an `ObjectView` field is never
 * immediate: clicking "delete" MARKS the item (sets `DELETE_MARK` to `true`)
 * so the UI can show it struck-through / dimmed with an undo affordance. The
 * actual removal happens only when the parent record is saved — wire
 * `stripMarkedForDeletion` as the field's `FieldConfig.prepareForSave`, which
 * drops the marked items and removes the transient marker from the survivors
 * before the value is written to Firestore.
 */
export const DELETE_MARK = '_pendingDelete';

/**
 * Drop array items flagged with `DELETE_MARK` and strip the marker key from the
 * survivors. Non-array values pass through untouched. Pure; use as a field's
 * `FieldConfig.prepareForSave`.
 */
export function stripMarkedForDeletion(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const out: unknown[] = [];
  for (const item of value) {
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      if (rec[DELETE_MARK]) continue; // marked → drop
      if (DELETE_MARK in rec) {
        const copy = { ...rec };
        delete copy[DELETE_MARK];
        out.push(copy);
        continue;
      }
    }
    out.push(item);
  }
  return out;
}
