'use client';

import { ColorInput } from '@mantine/core';
import type { FieldRenderProps } from '@delfrance/ui';

/**
 * Plain hex-string color input for the "Cores" tab. Unlike `CorInput`
 * (`@/components/inputs/CorInput`), which decodes a legacy 32-bit ARGB
 * integer, webchat's color fields are stored directly as hex strings
 * (`webchatSchema` — a brand-new collection, no legacy int encoding to
 * reproduce), so no int↔hex conversion is needed here.
 */
export function HexColorField({
  value,
  onChange,
  onBlur,
  label,
  hint,
  disabled,
  error,
}: FieldRenderProps) {
  return (
    <ColorInput
      label={label}
      description={hint}
      value={typeof value === 'string' ? value : ''}
      onChange={onChange}
      onBlur={onBlur}
      disabled={disabled}
      error={error}
      format="hex"
    />
  );
}
