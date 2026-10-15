import { FreightTimeoutError } from '@delfrance/integrations-freight-br/http-client';

/**
 * Extra attempts a freight READ query makes — the app default
 * (`QUERY_DEFAULT_OPTIONS.retry: 1`), restated so the predicate below can keep it.
 */
export const FREIGHT_QUERY_MAX_RETRIES = 1;

/**
 * TanStack `retry` predicate for a freight READ query (#1094): the app's default
 * single retry, EXCEPT after a `FreightTimeoutError`.
 *
 * A timeout has already spent the client's whole budget, and the route may still
 * be running; retrying doubles the wait for no new information. In
 * `EtiquetaComprarModal` that wait is not cosmetic — `agenciasSettling` holds the
 * Comprar button disabled until the agency lookup settles, so an automatic retry
 * of a timed-out lookup kept the purchase blocked for two full budgets.
 */
export function freightQueryRetry(failureCount: number, err: unknown): boolean {
  return failureCount < FREIGHT_QUERY_MAX_RETRIES && !(err instanceof FreightTimeoutError);
}
