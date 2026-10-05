import type { PrecosMap } from '@delfrance/schemas';

/**
 * A working price entry: the wire `{ valor }` plus the parent editor's
 * transient staged-removal marker. `valor` may be absent while the user is
 * editing; validation reports that state rather than silently deleting it.
 */
export interface PrecoDraft {
  valor?: number;
  _delete?: boolean;
}

/**
 * Drop staged-deleted entries and `_delete` before validation/persistence.
 * Kept entries preserve an absent `valor` so Zod can reject an incomplete row.
 */
export function stripPrecosForSave(value: unknown): Record<string, { valor: number }> | null {
  const map = (value ?? {}) as Record<string, PrecoDraft>;
  const out: Record<string, { valor: number }> = {};
  for (const [listaId, entry] of Object.entries(map)) {
    if (entry?._delete) continue;
    const { _delete, ...rest } = entry ?? {};
    void _delete;
    out[listaId] = rest as { valor: number };
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Canonical price map for live comparisons while the form may still contain
 * `_delete` markers or a temporarily empty input. Explicit removals disappear;
 * an incomplete input keeps its persisted value until validation succeeds, so
 * every variation does not flash as divergent while the operator is typing.
 */
export function normalizePrecosForComparison(value: unknown, persisted: PrecosMap): PrecosMap {
  if (value === undefined) return persisted ?? null;
  if (value === null) return null;

  const stripped = stripPrecosForSave(value) ?? {};
  const out: Record<string, { valor: number }> = {};
  for (const [listaId, entry] of Object.entries(stripped)) {
    if (typeof entry.valor === 'number' && Number.isFinite(entry.valor)) {
      out[listaId] = entry;
    } else if (persisted?.[listaId] !== undefined) {
      out[listaId] = persisted[listaId];
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}
