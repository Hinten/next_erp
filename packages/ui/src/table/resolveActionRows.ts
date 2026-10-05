import type { SnapshotRow } from '@delfrance/data/hooks';
import type { ActionConfig } from '../schema/types';

/**
 * Rows an action should receive when triggered.
 *
 * 1. Any explicit selection wins.
 * 2. Else, when `fallbackToSingleVisibleRow` is set and the table shows exactly
 *    one row, that row is used (Flutter `intent.data.length == 1` perk).
 * 3. Else empty.
 */
export function resolveActionRows<T>(
  action: ActionConfig<T>,
  selectedRows: ReadonlyArray<SnapshotRow<T>>,
  visibleRows: ReadonlyArray<SnapshotRow<T>> = [],
): SnapshotRow<T>[] {
  return partitionActionRows(action, selectedRows, visibleRows).eligible;
}

/** One refused row and the operator-facing reason it was refused. */
export interface RefusedRow<T> {
  row: SnapshotRow<T>;
  reason: string;
}

/**
 * The rows an action would receive, split into what it will act on and what it
 * refused.
 *
 * ⚠️ The eligibility filter runs AFTER the selection is resolved, never before,
 * and `actionDisabledReason` checks `maxSelection` against the RAW selection.
 * Filtering first would let three selected rows — two of them refused — satisfy
 * a `maxSelection: 1` action that should have declined the SELECTION, not
 * silently acted on its one survivor.
 *
 * ⚠️ `fallbackToSingleVisibleRow` can now resolve to an EMPTY list where it
 * previously always returned one row. Every `run` opens with a length guard, so
 * that degrades correctly, but it is a real change in what the perk promises.
 */
export function partitionActionRows<T>(
  action: ActionConfig<T>,
  selectedRows: ReadonlyArray<SnapshotRow<T>>,
  visibleRows: ReadonlyArray<SnapshotRow<T>> = [],
): { eligible: SnapshotRow<T>[]; refused: RefusedRow<T>[] } {
  const resolved =
    selectedRows.length > 0
      ? [...selectedRows]
      : action.fallbackToSingleVisibleRow && visibleRows.length === 1
        ? [visibleRows[0]!]
        : [];

  const predicate = action.rowIneligibleReason;
  if (!predicate) return { eligible: resolved, refused: [] };

  const eligible: SnapshotRow<T>[] = [];
  const refused: RefusedRow<T>[] = [];
  for (const row of resolved) {
    const reason = predicate(row);
    if (reason === null) eligible.push(row);
    else refused.push({ row, reason });
  }
  return { eligible, refused };
}

/**
 * Why a bulk action is unavailable, or `null` when it is available. The string
 * is operator-facing: it goes on the disabled button's `title`, so "nothing
 * happens when I click it" always has an answer on hover.
 *
 * The `maxSelection` cap is checked FIRST and independently of
 * `requiresSelection` — an action that declines a wide selection declines it
 * whether or not it also needs one.
 */
export function actionDisabledReason<T>(
  action: ActionConfig<T>,
  selectedRows: ReadonlyArray<SnapshotRow<T>>,
  visibleRows: ReadonlyArray<SnapshotRow<T>> = [],
): string | null {
  const max = action.maxSelection;
  if (max != null && selectedRows.length > max) {
    return max === 1 ? 'Selecione apenas 1 registro' : `Selecione no máximo ${max} registros`;
  }
  const { eligible, refused } = partitionActionRows(action, selectedRows, visibleRows);
  // Every selected row was refused. Saying "Selecione ao menos 1 registro" here
  // would be false — they DID select — and would hide the one thing that
  // explains the disabled button. With a single row, name its reason outright.
  if (eligible.length === 0 && refused.length > 0) {
    return refused.length === 1
      ? refused[0]!.reason
      : `Nenhum dos ${refused.length} registros selecionados aceita esta ação`;
  }
  if (!action.requiresSelection) return null;
  return eligible.length === 0 ? 'Selecione ao menos 1 registro' : null;
}

/** Whether a bulk action button/menu item should be disabled. */
export function isActionDisabled<T>(
  action: ActionConfig<T>,
  selectedRows: ReadonlyArray<SnapshotRow<T>>,
  visibleRows: ReadonlyArray<SnapshotRow<T>> = [],
): boolean {
  return actionDisabledReason(action, selectedRows, visibleRows) !== null;
}
