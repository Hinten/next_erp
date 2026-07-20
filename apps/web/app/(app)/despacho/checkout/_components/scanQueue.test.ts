import { describe, expect, it } from 'vitest';
import { createScanQueue } from './scanQueue';

/** A manually-resolvable promise, for controlling task timing. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createScanQueue', () => {
  it('runs tasks one at a time in FIFO order', async () => {
    const q = createScanQueue(1);
    const order: string[] = [];
    const d1 = deferred<string>();
    const d2 = deferred<string>();

    q.enqueue(
      1,
      () => d1.promise,
      (r) => order.push(`done:${r}`),
    );
    q.enqueue(
      1,
      () => d2.promise,
      (r) => order.push(`done:${r}`),
    );

    await tick();
    // Second task must not have started/finished before the first resolves.
    expect(order).toEqual([]);

    d1.resolve('a');
    await tick();
    expect(order).toEqual(['done:a']);

    d2.resolve('b');
    await tick();
    expect(order).toEqual(['done:a', 'done:b']);
  });

  it('drops a task whose epoch went stale before it ran', async () => {
    const q = createScanQueue(1);
    const seen: string[] = [];
    const d1 = deferred<string>();

    // Task 1 (epoch 1) is in flight; task 2 (epoch 1) is queued behind it.
    q.enqueue(
      1,
      () => d1.promise,
      (r) => seen.push(r),
    );
    q.enqueue(
      1,
      () => Promise.resolve('second'),
      (r) => seen.push(r),
    );

    // A pedido swap bumps the epoch — the queued task must not fire.
    q.reset(2);
    d1.resolve('first');
    await tick();

    expect(seen).toEqual([]);
    expect(q.epoch()).toBe(2);
  });

  it('drops a task that goes stale WHILE resolving', async () => {
    const q = createScanQueue(1);
    const seen: string[] = [];
    const d1 = deferred<string>();

    q.enqueue(
      1,
      () => d1.promise,
      (r) => seen.push(r),
    );
    // Reset AFTER the task started but BEFORE it resolves.
    q.reset(3);
    d1.resolve('x');
    await tick();

    expect(seen).toEqual([]);
  });

  it('runs tasks enqueued under the new epoch after a reset', async () => {
    const q = createScanQueue(1);
    const seen: string[] = [];
    q.reset(5);
    q.enqueue(
      5,
      () => Promise.resolve('ok'),
      (r) => seen.push(r),
    );
    await tick();
    expect(seen).toEqual(['ok']);
  });
});
