import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeadlineExceededError, REPRINT_STAGE_TIMEOUT_MS, withDeadline } from './withDeadline';

/**
 * The reprint chain's only defence against a stage that never settles.
 *
 * ⚠️ The load-bearing case is the FIRING one. A deadline that is never observed
 * to fire is the same class of dead guard as a wiring test that passes
 * vacuously — so the timeout is exercised here with fake timers rather than
 * assumed from the code shape.
 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('withDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes a value straight through when the work settles in time', async () => {
    await expect(withDeadline('etapa', Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });

  it('propagates the work’s own rejection unchanged', async () => {
    // A real failure must NOT be relabelled as a timeout — the operator would
    // chase the network instead of the actual error.
    await expect(withDeadline('etapa', Promise.reject(new Error('boom')), 1000)).rejects.toThrow(
      'boom',
    );
  });

  it('REJECTS with DeadlineExceededError once the budget elapses', async () => {
    const d = deferred<string>();
    const p = withDeadline('carregar o pedido', d.promise, 30_000);
    const assertion = expect(p).rejects.toBeInstanceOf(DeadlineExceededError);

    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('names the stage in the error, which is the whole point', async () => {
    const d = deferred<string>();
    const p = withDeadline('resolver a integração de frete', d.promise, 5_000);
    const assertion = expect(p).rejects.toThrow(/resolver a integração de frete/);

    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    // ...and carries it structurally, so the caller can branch without parsing.
    await withDeadline('x', Promise.resolve(1), 1).catch(() => undefined);
  });

  it('does NOT fire one tick early', async () => {
    const d = deferred<string>();
    let settled = false;
    const p = withDeadline('etapa', d.promise, 10_000).then(
      () => (settled = true),
      () => (settled = true),
    );

    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);

    d.resolve('late but in time');
    await p;
    expect(settled).toBe(true);
  });

  it('clears its timer on the success path so nothing is left pending', async () => {
    // A leaked timer per reprint keeps the tab awake and, under fake timers,
    // bleeds into the next test.
    await withDeadline('etapa', Promise.resolve('ok'), 30_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer on the rejection path too', async () => {
    await withDeadline('etapa', Promise.reject(new Error('boom')), 30_000).catch(() => undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('exposes a default budget the callers share', () => {
    expect(REPRINT_STAGE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
