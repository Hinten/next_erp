'use client';

/**
 * A tiny, pure FIFO scan queue — the async half of the scan pipeline
 * (`useScanPipeline`). Rapid barcode-wedge scans that MISS the prefetched
 * produto maps fall back to Firestore; this serializes those fallbacks so N
 * quick scans issue N *sequential* reads (one resolution at a time) instead of
 * N concurrent `getDocs`, and drops any resolution whose pedido was swapped out
 * mid-flight (the epoch guard — see the checkout port plan §5.3).
 *
 * Zero React / Firestore deps — the resolver + completion callback are injected,
 * so the queue is exhaustively unit-testable in jsdom. Prefetched-map HITS never
 * enter the queue at all (`useScanPipeline` resolves them synchronously); only
 * the async fallback tasks are enqueued here.
 */

export interface ScanQueue {
  /**
   * Enqueue an async resolution tagged with the `epoch` it was captured at. The
   * task runs only after every earlier task settles, and both BEFORE running and
   * AFTER resolving it re-checks the queue's live epoch — a stale task (its
   * pedido was replaced) is dropped without invoking `onDone`.
   */
  enqueue<T>(
    epoch: number,
    task: () => Promise<T>,
    onDone: (result: T, epoch: number) => void,
  ): void;
  /**
   * Adopt a new epoch and detach the pending chain. In-flight/queued tasks from
   * the old chain self-drop on their epoch check; new work starts fresh. Called
   * on every pedido (re)load and screen clear so a swapped-out pedido's scans
   * can never land on the new engine state.
   */
  reset(epoch: number): void;
  /** The queue's current live epoch (the value a task is checked against). */
  epoch(): number;
}

export function createScanQueue(initialEpoch = 0): ScanQueue {
  let currentEpoch = initialEpoch;
  // The serialization chain: each enqueued task `.then`s off the previous, so at
  // most one fallback resolution is in flight at a time.
  let chain: Promise<unknown> = Promise.resolve();

  return {
    enqueue(epoch, task, onDone) {
      chain = chain.then(async () => {
        // Stale before we even start (a newer pedido loaded while we waited).
        if (epoch !== currentEpoch) return;
        const result = await task();
        // Stale after the read resolved (the pedido swapped during the round-trip).
        if (epoch !== currentEpoch) return;
        onDone(result, epoch);
      });
    },
    reset(epoch) {
      currentEpoch = epoch;
      chain = Promise.resolve();
    },
    epoch() {
      return currentEpoch;
    },
  };
}
