import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  READ_RETRY_BACKOFF_MAX_MS,
  computeBackoffDelay,
  isRetryableFirestoreError,
  retryAsync,
} from './retry';

/** A Firestore-shaped error: an `Error` with a string `code`. */
function makeErr(code: string): Error {
  const err = new Error(`firestore: ${code}`);
  (err as { code?: string }).code = code;
  return err;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('isRetryableFirestoreError', () => {
  it('is true for transient Firestore codes', () => {
    for (const code of [
      'unavailable',
      'deadline-exceeded',
      'internal',
      'resource-exhausted',
      'aborted',
      'cancelled',
    ]) {
      expect(isRetryableFirestoreError(makeErr(code))).toBe(true);
    }
  });

  it('is false for deterministic Firestore codes', () => {
    for (const code of [
      'permission-denied',
      'unauthenticated',
      'not-found',
      'invalid-argument',
      'failed-precondition',
    ]) {
      expect(isRetryableFirestoreError(makeErr(code))).toBe(false);
    }
  });

  it('is false when the code is missing, non-string, or the throw is not an Error', () => {
    expect(isRetryableFirestoreError(new Error('no code'))).toBe(false);
    const numeric = new Error('numeric code');
    (numeric as { code?: number }).code = 10; // Admin-SDK style — not ours
    expect(isRetryableFirestoreError(numeric)).toBe(false);
    expect(isRetryableFirestoreError('unavailable')).toBe(false);
    expect(isRetryableFirestoreError({ code: 'unavailable' })).toBe(false);
    expect(isRetryableFirestoreError(undefined)).toBe(false);
  });
});

describe('computeBackoffDelay', () => {
  it('stays within [ceiling/2, ceiling] and grows exponentially per attempt', () => {
    const random = vi.spyOn(Math, 'random');

    // attempt 1: ceiling = base (400) → [200, 400]
    random.mockReturnValue(0);
    expect(computeBackoffDelay(1)).toBe(200);
    random.mockReturnValue(1);
    expect(computeBackoffDelay(1)).toBe(400);

    // attempt 2: ceiling = base*2 (800) → [400, 800]
    random.mockReturnValue(0);
    expect(computeBackoffDelay(2)).toBe(400);
    random.mockReturnValue(1);
    expect(computeBackoffDelay(2)).toBe(800);
  });

  it('saturates at the max cap on high attempt numbers', () => {
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValue(0);
    expect(computeBackoffDelay(10)).toBe(READ_RETRY_BACKOFF_MAX_MS / 2);
    random.mockReturnValue(1);
    expect(computeBackoffDelay(10)).toBe(READ_RETRY_BACKOFF_MAX_MS);
  });

  it('never returns zero on the first attempt', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(computeBackoffDelay(1)).toBeGreaterThan(0);
  });

  it('throws RangeError on a non-positive or non-integer attempt', () => {
    expect(() => computeBackoffDelay(0)).toThrow(RangeError);
    expect(() => computeBackoffDelay(-1)).toThrow(RangeError);
    expect(() => computeBackoffDelay(1.5)).toThrow(RangeError);
  });
});

describe('retryAsync', () => {
  it('returns on the first successful attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(
      retryAsync(fn, { isRetryable: isRetryableFirestoreError }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure then resolves', async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeErr('unavailable'))
      .mockResolvedValue('ok');
    const promise = retryAsync(fn, { isRetryable: isRetryableFirestoreError });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt budget and rethrows the last error', async () => {
    vi.useFakeTimers();
    const err = makeErr('unavailable');
    const fn = vi.fn().mockRejectedValue(err);
    const promise = retryAsync(fn, {
      isRetryable: isRetryableFirestoreError,
      maxAttempts: 3,
    });
    // Attach the handler synchronously so driving the timers doesn't surface
    // an unhandled rejection.
    const settled = promise.catch((e) => e);
    await vi.runAllTimersAsync();
    await expect(settled).resolves.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows a non-retryable error immediately without retrying', async () => {
    const err = makeErr('permission-denied');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      retryAsync(fn, { isRetryable: isRetryableFirestoreError }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects with RangeError when maxAttempts is invalid', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(
      retryAsync(fn, { isRetryable: isRetryableFirestoreError, maxAttempts: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops retrying when cancelled', async () => {
    const err = makeErr('unavailable');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      retryAsync(fn, {
        isRetryable: isRetryableFirestoreError,
        isCancelled: () => true,
      }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
