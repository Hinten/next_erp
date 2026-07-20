'use client';

import { useCallback, useRef } from 'react';
import type { Firestore } from 'firebase/firestore';
import type { CheckoutAction, ScanMeta } from './checkoutReducer';
import { resolveFromIndex, resolveScanText, type ScanIndex } from './resolveScan';
import { createScanQueue, type ScanQueue } from './scanQueue';

export interface ScanPipeline {
  /**
   * Handle one barcode-wedge submission. A prefetched-map HIT dispatches
   * synchronously (the O(1) hot path — no async, no re-render of the input's
   * siblings beyond the one changed row); a MISS is queued for a serialized
   * Firestore fallback that dispatches when it resolves. Both carry the epoch
   * captured here, so a pedido swap mid-resolution drops the result.
   */
  enqueueScan: (text: string) => void;
  /** Adopt `epoch` and drop the pending fallback chain — call on every load/clear/reset. */
  resetQueue: (epoch: number) => void;
}

/**
 * The scan pipeline: normalize/resolve a scanned code to a produto, then hand it
 * to the pure engine via `dispatch`. Owns the {@link ScanQueue} in a ref (reset
 * on epoch change, per the plan §5.3) so serialization + cancellation survive
 * re-renders without re-creating the queue.
 */
export function useScanPipeline(args: {
  db: Firestore;
  currentEpoch: () => number;
  /** the live prefetched scan index (read fresh each scan; updated on load). */
  getIndex: () => ScanIndex;
  dispatch: React.Dispatch<CheckoutAction>;
}): ScanPipeline {
  const { db, currentEpoch, getIndex, dispatch } = args;
  const queueRef = useRef<ScanQueue | null>(null);
  if (queueRef.current === null) queueRef.current = createScanQueue(currentEpoch());

  const enqueueScan = useCallback(
    (text: string) => {
      const epoch = currentEpoch();
      const meta: ScanMeta = { uid: crypto.randomUUID(), timestampMs: Date.now() };

      const hit = resolveFromIndex(text, getIndex());
      if (hit) {
        dispatch({ type: 'scan/apply', epoch, produto: hit, meta });
        return;
      }
      queueRef.current!.enqueue(
        epoch,
        () => resolveScanText(db, text, getIndex()),
        (resolved, ep) => {
          if (resolved.kind === 'produto') {
            dispatch({ type: 'scan/apply', epoch: ep, produto: resolved.produto, meta });
          } else {
            dispatch({ type: 'scan/not-found', epoch: ep, code: resolved.code, meta });
          }
        },
      );
    },
    [db, currentEpoch, getIndex, dispatch],
  );

  const resetQueue = useCallback((epoch: number) => queueRef.current!.reset(epoch), []);

  return { enqueueScan, resetQueue };
}
