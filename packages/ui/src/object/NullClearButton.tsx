'use client';

import { ActionIcon } from '@mantine/core';

export interface NullClearButtonProps {
  onClear: () => void;
  ariaLabel?: string;
}

/**
 * `✕` button rendered on the right edge of a nullable string input. Sets
 * the field value to literal `null` (not undefined) so the patch sent to
 * Firestore preserves the user's intent to clear the field.
 */
export function NullClearButton({ onClear, ariaLabel = 'Limpar' }: NullClearButtonProps) {
  return (
    <ActionIcon variant="subtle" onClick={onClear} aria-label={ariaLabel}>
      ✕
    </ActionIcon>
  );
}
