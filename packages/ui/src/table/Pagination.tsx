'use client';

import { Button, Group } from '@mantine/core';

export interface PaginationProps {
  /** Disables the "anterior" button (typically on the first page). */
  canGoPrev: boolean;
  /** Disables the "próximo" button (typically when fewer than pageSize rows). */
  canGoNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  /**
   * Optional label rendered between the buttons. Page counters are
   * intentionally omitted since cursor pagination doesn't know totals.
   */
  label?: string;
}

export function Pagination({ canGoPrev, canGoNext, onPrev, onNext, label }: PaginationProps) {
  return (
    <Group justify="flex-end" gap="xs">
      <Button variant="default" size="xs" disabled={!canGoPrev} onClick={onPrev}>
        ‹ Anterior
      </Button>
      {label && <span>{label}</span>}
      <Button variant="default" size="xs" disabled={!canGoNext} onClick={onNext}>
        Próximo ›
      </Button>
    </Group>
  );
}
