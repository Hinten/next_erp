'use client';

import { TagsInput } from '@mantine/core';
import type { FieldRenderProps } from '@delfrance/ui';

/**
 * `mensagens_padrao` — up to 3 quick-reply chips, hard client-side cap (the
 * schema itself also caps it via `.max(3)`, so a value written any other way
 * still fails validation). Mantine's `TagsInput` already gives the
 * add-by-typing / remove-by-click chip UX the legacy screen described.
 */
export function MensagensPadraoField({
  value,
  onChange,
  onBlur,
  label,
  hint,
  disabled,
  error,
}: FieldRenderProps) {
  const tags = Array.isArray(value) ? (value as string[]) : [];
  return (
    <TagsInput
      label={label}
      description={hint}
      value={tags}
      onChange={(next) => onChange(next.length > 0 ? next : null)}
      onBlur={onBlur}
      disabled={disabled}
      error={error}
      maxTags={3}
      placeholder={tags.length < 3 ? 'Digite e pressione Enter' : undefined}
    />
  );
}
