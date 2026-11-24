import {
  and,
  equalAny,
  field,
  greaterThanOrEqual,
  lessThan,
  or,
} from 'firebase/firestore/pipelines';
import { MICROS_LOWER_BOUND, MILLIS_UPPER_BOUND } from '@delfrance/core/datetime';

export interface PedidoReportDateRange {
  startUs: number;
  endExclusiveUs: number;
}

/** Seek both numeric timestamp units without overlapping the stored ranges. */
export function pedidoReportTimestamp({ startUs, endExclusiveUs }: PedidoReportDateRange) {
  return or(
    and(
      greaterThanOrEqual(field('timestamp'), Math.max(startUs, MICROS_LOWER_BOUND)),
      lessThan(field('timestamp'), endExclusiveUs),
    ),
    and(
      greaterThanOrEqual(field('timestamp'), Math.ceil(startUs / 1000)),
      lessThan(
        field('timestamp'),
        Math.min(Math.ceil(endExclusiveUs / 1000), MILLIS_UPPER_BOUND + 1),
      ),
    ),
  );
}

/** Called only for a nonempty selection. Match current and legacy reference formats. */
export function pedidoReportAccounts(accountIds: readonly string[]) {
  return equalAny(
    field('integracaoPedidoOuterRef'),
    accountIds.flatMap((id) => ['documents/integracao/' + id, 'integracao/' + id]),
  );
}
