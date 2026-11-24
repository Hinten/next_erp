import {
  and,
  equal,
  equalAny,
  field,
  greaterThanOrEqual,
  lessThan,
  or,
} from 'firebase/firestore/pipelines';
import { MICROS_LOWER_BOUND, MILLIS_UPPER_BOUND } from '@delfrance/core/datetime';
import { estadoPedidoSchema, naoDocId, type EstadoPedido } from '@delfrance/schemas';
import { checkoutDateRange } from './checkouts';

export interface OrderReportFilters {
  startUs: number;
  endExclusiveUs: number;
  estados: readonly EstadoPedido[];
  /** Integration document IDs. An empty selection includes every account. */
  accountIds: readonly string[];
  ehSaida: boolean;
}

export function defaultOrderReportDates(): [string, string] {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return [`${month}-01`, `${month}-${String(now.getDate()).padStart(2, '0')}`];
}

/** Keep both calendar days inclusive and use the pedido timestamp's µs unit. */
export function orderReportDateRange(start: string | null, end: string | null) {
  const range = checkoutDateRange(start, end);
  if (!range) return null;
  const startUs = range.startMs * 1000;
  const endExclusiveUs = range.endExclusiveMs * 1000;
  return Number.isSafeInteger(startUs) && Number.isSafeInteger(endExclusiveUs)
    ? { startUs, endExclusiveUs }
    : null;
}

export function normalizeOrderReportFilters(filters: OrderReportFilters): OrderReportFilters {
  if (
    !Number.isSafeInteger(filters.startUs) ||
    !Number.isSafeInteger(filters.endExclusiveUs) ||
    filters.startUs >= filters.endExclusiveUs ||
    typeof filters.ehSaida !== 'boolean'
  ) {
    throw new RangeError('Selecione um período válido para o relatório.');
  }
  if (filters.estados.length === 0) {
    throw new RangeError('Selecione pelo menos um estado de pedido.');
  }
  for (const state of filters.estados) {
    if (!estadoPedidoSchema.safeParse(state).success) {
      throw new RangeError('Estado de pedido inválido.');
    }
  }
  if (filters.accountIds.some(naoDocId)) {
    throw new RangeError('Conta de marketplace inválida.');
  }
  return {
    ...filters,
    estados: [...new Set(filters.estados)].sort(),
    accountIds: [...new Set(filters.accountIds)].sort(),
  };
}

export function orderReportPredicate(input: OrderReportFilters) {
  const filters = normalizeOrderReportFilters(input);
  // The two timestamp branches match the tolerant schema's numeric-unit heuristic.
  const conditions = [
    equalAny(field('estado'), [...filters.estados]),
    ...(filters.accountIds.length === 0
      ? []
      : [
          equalAny(
            field('integracaoPedidoOuterRef'),
            filters.accountIds.flatMap((id) => [`documents/integracao/${id}`, `integracao/${id}`]),
          ),
        ]),
  ];
  return and(
    equal(field('ehSaida'), filters.ehSaida),
    or(
      and(
        greaterThanOrEqual(field('timestamp'), Math.max(filters.startUs, MICROS_LOWER_BOUND)),
        lessThan(field('timestamp'), filters.endExclusiveUs),
      ),
      and(
        greaterThanOrEqual(field('timestamp'), Math.ceil(filters.startUs / 1000)),
        lessThan(
          field('timestamp'),
          Math.min(Math.ceil(filters.endExclusiveUs / 1000), MILLIS_UPPER_BOUND + 1),
        ),
      ),
    ),
    ...conditions,
  );
}
