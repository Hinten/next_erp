/**
 * Retry policy for one-shot Firestore reads.
 *
 * Live listeners (`onSnapshot`) reconnect on their own — the SDK's
 * `PersistentListenStream` retries transient failures with an internal
 * exponential backoff. One-shot RPCs do NOT: `getDocs` and the Pipelines
 * `execute()` both go through `invokeRPC`/`invokeStreamingRPC`, which reject
 * on the first error with no retry and no public knob to configure one. This
 * module supplies that missing retry for the read path, so a transient blip
 * doesn't surface as an error before we've given it a couple of chances.
 *
 * Style mirrors the NF-e numeração adapter
 * (`packages/integrations/nfe/src/numeracao/firestore-adapter.ts`): a bounded
 * attempt loop, a duck-typed "is this worth retrying?" classifier, jittered
 * backoff between tries, and an immediate rethrow for anything we don't own.
 */

/** Total attempts (initial try + retries). 3 = 2 backoff waits before failing. */
export const READ_RETRY_MAX_ATTEMPTS = 3;

/** Base backoff (ms) — the wait after the first failed attempt. */
export const READ_RETRY_BACKOFF_BASE_MS = 400;

/**
 * Cap (ms) on a single backoff wait. Dormant at the default 3 attempts (the
 * 2nd wait is only ~800 ms) — it exists so bumping `READ_RETRY_MAX_ATTEMPTS`
 * later can't grow the delay unbounded.
 */
export const READ_RETRY_BACKOFF_MAX_MS = 4000;

/**
 * Firestore JS-SDK error codes that are transient and worth retrying. These are
 * the client SDK's **string** codes (`FirestoreError.code`) — not the Admin
 * SDK's numeric gRPC codes. Everything outside this set (permission-denied,
 * unauthenticated, not-found, invalid-argument, failed-precondition, …) is
 * deterministic: retrying would just stall before showing the same error.
 */
const RETRYABLE_FIRESTORE_CODES: ReadonlySet<string> = new Set([
  'unavailable',
  'deadline-exceeded',
  'internal',
  'resource-exhausted',
  'aborted',
  'cancelled',
]);

/**
 * Deny-by-default classifier. Only an `Error` carrying a **string** `code` in
 * the retryable set qualifies. A missing/non-string code (including non-Error
 * throws and the synthetic Error the pipeline hook wraps non-Error rejections
 * in) returns `false`, so a weird shape can never trigger an unbounded loop.
 */
export function isRetryableFirestoreError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && RETRYABLE_FIRESTORE_CODES.has(code);
}

/**
 * Backoff for the wait *after* a failed attempt. `attempt` is 1-based: the
 * wait after attempt 1 uses `base`, after attempt 2 uses `base*2`, capped at
 * `max`. Uses *equal jitter* — the result lands in `[ceiling/2, ceiling]` (half
 * fixed, half random) — so concurrent tables don't retry in lockstep while the
 * wait stays predictable enough to feel responsive.
 */
export function computeBackoffDelay(
  attempt: number,
  options: { baseMs?: number; maxMs?: number } = {},
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(
      `computeBackoffDelay: attempt must be an integer >= 1, got ${attempt}`,
    );
  }
  const baseMs = options.baseMs ?? READ_RETRY_BACKOFF_BASE_MS;
  const maxMs = options.maxMs ?? READ_RETRY_BACKOFF_MAX_MS;
  const ceiling = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  /** Total attempts (initial try + retries). Defaults to `READ_RETRY_MAX_ATTEMPTS`. */
  maxAttempts?: number;
  /** Decides whether a thrown error is transient and worth another attempt. */
  isRetryable: (err: unknown) => boolean;
  /**
   * Optional cancellation probe, checked before and after each backoff. Lets a
   * torn-down caller (e.g. a React effect cleanup) abandon retries promptly
   * instead of waiting out the wait and firing a stale `setState`.
   */
  isCancelled?: () => boolean;
}

/**
 * Run `fn`, retrying transient failures with jittered exponential backoff.
 *
 * Non-retryable errors (per `isRetryable`) rethrow immediately; the original
 * error from the final attempt is what propagates once the budget is spent, so
 * the caller's existing error handling sees the real failure unchanged.
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? READ_RETRY_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(
      `retryAsync: maxAttempts must be an integer >= 1, got ${maxAttempts}`,
    );
  }
  const isCancelled = options.isCancelled ?? (() => false);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Bail out for a torn-down caller or a deterministic error — neither
      // benefits from waiting and trying again. Rethrow keeps the original.
      if (isCancelled() || !options.isRetryable(err)) throw err;
      if (attempt === maxAttempts) break;
      await sleep(computeBackoffDelay(attempt));
      if (isCancelled()) throw err;
    }
  }
  throw lastErr;
}
