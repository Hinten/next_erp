import type { QueryPredicate } from '@delfrance/schemas';
import type { PipelineOrderSpec } from '@delfrance/data';
import type { ColumnFilterValue } from '../schema/types';

export interface TablePresetFilter {
  key: string;
  label: string;
  formatValue: (value: ColumnFilterValue['value']) => string;
  resolve: (
    value: ColumnFilterValue,
  ) => { predicate: QueryPredicate; orderBy?: PipelineOrderSpec } | { error: string };
}

export function resolvePresetFilters(
  presets: readonly TablePresetFilter[],
  filters: Record<string, ColumnFilterValue>,
) {
  const predicates: QueryPredicate[] = [];
  let orderBy: PipelineOrderSpec | undefined;
  for (const preset of presets) {
    const value = filters[preset.key];
    if (!value) continue;
    const result = preset.resolve(value);
    if ('error' in result) return { error: result.error, predicate: undefined, orderBy: undefined };
    predicates.push(result.predicate);
    orderBy ??= result.orderBy;
  }
  return {
    error: undefined,
    predicate:
      predicates.length === 1
        ? predicates[0]
        : predicates.length > 1
          ? ({ and: predicates } as QueryPredicate)
          : undefined,
    orderBy,
  };
}
