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

/** Whether a bulk action button/menu item should be disabled. */
export function isActionDisabled<T>(
  action: ActionConfig<T>,
  selectedRows: ReadonlyArray<SnapshotRow<T>>,
  visibleRows: ReadonlyArray<SnapshotRow<T>> = [],
): boolean {
  if (!action.requiresSelection) return false;
  return resolveActionRows(action, selectedRows, visibleRows).length === 0;
}
