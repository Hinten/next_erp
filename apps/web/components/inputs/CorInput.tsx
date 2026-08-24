'use client';

import { ColorInput } from '@mantine/core';
import type { FieldRenderProps } from '@delfrance/ui';
import { corToHex, hexToCor } from '@delfrance/core';

/**
 * The `integracao.cor` editor — a Mantine `ColorInput` over the stored integer.
 *
 * Shared by every channel form that exposes the field (Balcão, WhatsApp,
 * Mercado Livre). It used to be copy-pasted into two of them, with a comment
 * saying a shared module "isn't worth it for one more consumer *because Mercado
 * Livre opts out of `cor` entirely*" — a premise that expired when the produtos
 * list started painting badges with this colour.
 *
 * ⚠️ The decode goes through `corToHex`, which MASKS a legacy 32-bit ARGB value
 * down to its RGB bytes. The copies it replaces *clamped* to `0xffffff`, so a
 * conta coloured by the legacy Flutter app opened showing `#ffffff` — and
 * saving that form then overwrote the real colour with white.
 */
export function CorInput({
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
      description={hint ?? 'Cor de destaque para identificar o canal.'}
      value={corToHex(typeof value === 'number' ? value : null) ?? ''}
      onChange={(next) => onChange(next ? hexToCor(next) : null)}
      onBlur={onBlur}
      disabled={disabled}
      error={error}
      format="hex"
    />
  );
}
