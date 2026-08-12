import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePrintInFlight } from './usePrintInFlight';

/** A manually-resolvable promise, to hold a "print" in flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('usePrintInFlight', () => {
  it('reports inFlight while an action runs and clears it after', async () => {
    const { result } = renderHook(() => usePrintInFlight());
    const d = deferred<string>();
    expect(result.current.inFlight).toBe(false);

    let p!: Promise<string | undefined>;
    act(() => {
      p = result.current.run(() => d.promise);
    });
    expect(result.current.inFlight).toBe(true);

    await act(async () => {
      d.resolve('ok');
      expect(await p).toBe('ok');
    });
    expect(result.current.inFlight).toBe(false);
  });

  it('DROPS a re-entrant call while one is in flight (never overlaps the printer)', async () => {
    const { result } = renderHook(() => usePrintInFlight());
    const d = deferred<string>();
    const fn1 = vi.fn(() => d.promise);
    const fn2 = vi.fn(() => Promise.resolve('second'));

    let p1!: Promise<string | undefined>;
    let p2!: Promise<string | undefined>;
    act(() => {
      p1 = result.current.run(fn1);
    });
    act(() => {
      p2 = result.current.run(fn2); // in flight → dropped, fn2 never invoked
    });

    expect(fn2).not.toHaveBeenCalled();
    await act(async () => {
      expect(await p2).toBeUndefined();
    });
    await act(async () => {
      d.resolve('first');
      expect(await p1).toBe('first');
    });

    // Mutex released → a fresh call runs normally.
    await act(async () => {
      expect(await result.current.run(fn2)).toBe('second');
    });
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('releases the mutex even when the action rejects', async () => {
    const { result } = renderHook(() => usePrintInFlight());

    await act(async () => {
      await expect(result.current.run(() => Promise.reject(new Error('boom')))).rejects.toThrow(
        'boom',
      );
    });
    expect(result.current.inFlight).toBe(false);

    // Still usable after a failure — not wedged shut.
    await act(async () => {
      expect(await result.current.run(() => Promise.resolve('ok'))).toBe('ok');
    });
  });
});
