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
  if (selectedRows.length > 0) return [...selectedRows];
  if (action.fallbackToSingleVisibleRow && visibleRows.length === 1) {
    return [visibleRows[0]!];
  }
  return [];
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
  if (!action.requiresSelection) return null;
  return resolveActionRows(action, selectedRows, visibleRows).length === 0
    ? 'Selecione ao menos 1 registro'
    : null;
}

/** Whether a bulk action button/menu item should be disabled. */
export function isActionDisabled<T>(
  action: ActionConfig<T>,
  selectedRows: ReadonlyArray<SnapshotRow<T>>,
  visibleRows: ReadonlyArray<SnapshotRow<T>> = [],
): boolean {
  return actionDisabledReason(action, selectedRows, visibleRows) !== null;
}
