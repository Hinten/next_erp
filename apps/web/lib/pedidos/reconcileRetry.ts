/**
 * Retry policy for the `reconciliarPagamentoPedido` callable (#703). Pure (no
 * Firebase init), so it unit-tests without an auth/Functions context — the
 * `lib/nfe/withNFeRetry.ts` shape.
 *
 * The reconcile runs AFTER the pagamento write has committed, so a failed call
 * leaves `estado` stale until the next pagamento mutation. A retry closes the
 * transient half of that gap (a dropped connection, a scaling gen2 instance). It
 * cannot close a tab that is shut before the call ends — nothing client-side can.
 *
 * ⚠️ Safe ONLY because this callable is idempotent: `reconcilePedidoEstado`
 * re-derives `estado` from the CURRENT payment set in one Admin-SDK transaction,
 * so a re-run after a lost response computes the same answer, `nextPedidoEstado`
 * returns `null`, and nothing is written. That is why this stays local instead of
 * becoming a "retry any callable" helper: `aplicarEstoque` applies increments, and
 * the same retry there would move stock twice.
 *
 * The codes are the Functions SDK's, which are `functions/`-PREFIXED — never
 * reuse `isRetryableFirestoreError`, whose bare codes can never match one.
 * Verified against `@firebase/functions` 0.13.4:
 *   - `internal`: a network drop (`fetch` throws → status 0) OR a server 500 — the
 *     SDK cannot tell them apart, and both are worth another try;
 *   - `unavailable` (503), `resource-exhausted` (429), `aborted` (409), and
 *     `unknown` (an unmapped status, e.g. a 502 from the front end).
 * Deliberately NOT retried:
 *   - `deadline-exceeded`: the client gave up after 70s but the server keeps
 *     running, so the write usually lands anyway — and each retry would hold the
 *     Pagamentos tab's spinner (and its disabled "+ Adicionar") another 70s;
 *   - everything deterministic — `not-found` (callable not deployed, or the
 *     pedido is gone), `permission-denied`, `unauthenticated`,
 *     `invalid-argument`, … — which a retry would only delay.
 */
import { FunctionsError } from 'firebase/functions';
import { retryAsync } from '@delfrance/data/hooks';

const RETRYABLE_RECONCILE_CODES: ReadonlySet<string> = new Set([
  'functions/internal',
  'functions/unavailable',
  'functions/resource-exhausted',
  'functions/aborted',
  'functions/unknown',
]);

/** Deny-by-default: only a `FunctionsError` carrying a transient code qualifies. */
export function isRetryableReconcileError(err: unknown): boolean {
  return err instanceof FunctionsError && RETRYABLE_RECONCILE_CODES.has(err.code);
}

/**
 * Run `fn` with `retryAsync`'s defaults (3 attempts, jittered 400ms → 800ms).
 * The final attempt's ORIGINAL error propagates, so callers keep narrowing on
 * `FirebaseError` exactly as before.
 */
export function retryReconcile<T>(fn: () => Promise<T>): Promise<T> {
  return retryAsync(fn, { isRetryable: isRetryableReconcileError });
}
