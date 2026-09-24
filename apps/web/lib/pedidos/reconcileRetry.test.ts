/**
 * The `reconciliarPagamentoPedido` retry policy (#703). Two things must hold:
 * a transient Functions failure is retried, and the classifier stops at the
 * Functions namespace — a bare-coded `FirebaseError` (Firestore's `'internal'`)
 * or a deterministic Functions code must reach the caller on the first failure.
 */
import { FirebaseError } from 'firebase/app';
import { FunctionsError } from 'firebase/functions';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isRetryableReconcileError, retryReconcile } from './reconcileRetry';

afterEach(() => {
  vi.useRealTimers();
});

describe('isRetryableReconcileError', () => {
  it.each(['internal', 'unavailable', 'resource-exhausted', 'aborted', 'unknown'] as const)(
    'retries functions/%s',
    (code) => {
      expect(isRetryableReconcileError(new FunctionsError(code, code))).toBe(true);
    },
  );

  it.each([
    'deadline-exceeded',
    'not-found',
    'permission-denied',
    'unauthenticated',
    'invalid-argument',
    'failed-precondition',
    'cancelled',
  ] as const)('does NOT retry functions/%s', (code) => {
    expect(isRetryableReconcileError(new FunctionsError(code, code))).toBe(false);
  });

  it('does NOT retry a FirebaseError whose bare code merely looks transient', () => {
    // Firestore's `internal` — same word, other namespace, not this callable's.
    expect(isRetryableReconcileError(new FirebaseError('internal', 'x'))).toBe(false);
    expect(isRetryableReconcileError(new FirebaseError('functions/internal', 'x'))).toBe(false);
  });

  it('does NOT retry a plain Error or a non-Error throw', () => {
    expect(isRetryableReconcileError(new Error('functions/internal'))).toBe(false);
    expect(isRetryableReconcileError({ code: 'functions/internal' })).toBe(false);
  });
});

describe('retryReconcile', () => {
  it('retries a network drop (functions/internal) and resolves', async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new FunctionsError('internal', 'internal'))
      .mockResolvedValue({ transition: 'pago' });
    const promise = retryReconcile(fn);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ transition: 'pago' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 attempts and rethrows the LAST original error', async () => {
    vi.useFakeTimers();
    const last = new FunctionsError('unavailable', 'third');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new FunctionsError('unavailable', 'first'))
      .mockRejectedValueOnce(new FunctionsError('unavailable', 'second'))
      .mockRejectedValueOnce(last);
    // Attach the handler synchronously so driving the timers doesn't surface an
    // unhandled rejection.
    const settled = retryReconcile(fn).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    await expect(settled).resolves.toBe(last);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it.each(['not-found', 'deadline-exceeded'] as const)(
    'surfaces functions/%s on the first failure, without waiting',
    async (code) => {
      const err = new FunctionsError(code, code);
      const fn = vi.fn().mockRejectedValue(err);
      await expect(retryReconcile(fn)).rejects.toBe(err);
      expect(fn).toHaveBeenCalledTimes(1);
    },
  );
});
