'use client';

import type { RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/** One rendered slice of a virtualized list. */
export interface VirtualRow {
  index: number;
  start: number;
  size: number;
}

export interface VirtualRowsResult {
  rows: VirtualRow[];
  totalSize: number;
}

/**
 * Thin `@tanstack/react-virtual` wrapper — only the ~2 fields the panes need, so
 * a jsdom component test can `vi.mock` this module to return every row (jsdom
 * has no layout, so the real virtualizer measures 0 rows). Keeps the panes free
 * of virtualization plumbing and testable without a real scroll container.
 */
export function useVirtualRows(
  count: number,
  scrollRef: RefObject<HTMLElement | null>,
  estimateSize = 72,
): VirtualRowsResult {
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    overscan: 8,
  });
  // getVirtualItems() already returns a fresh array each measure, so mapping it
  // per render is cheap and needs no memo.
  return {
    rows: virtualizer
      .getVirtualItems()
      .map((i) => ({ index: i.index, start: i.start, size: i.size })),
    totalSize: virtualizer.getTotalSize(),
  };
}
