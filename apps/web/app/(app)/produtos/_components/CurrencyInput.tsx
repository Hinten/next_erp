'use client';

import { type CSSProperties, type ReactNode, useState } from 'react';
import { NumberInput } from '@mantine/core';

/**
 * Coerce Mantine `NumberInput`'s `onChange` payload to a number (or `null` when
 * empty). The control hands back a FORMATTED STRING with a comma decimal (and
 * Playwright `.fill()` always yields a string), so a naive
 * `typeof v === 'number'` check silently drops every value. Drop the prefix,
 * fold any thousands dots that precede a comma, then turn the decimal comma
 * into a dot (a lone dot is also accepted as the decimal separator).
 */
export function parseBrl(v: number | string): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const cleaned = v
    .replace(/[^\d.,-]/g, '') // drop "R$", spaces, NBSP
    .replace(/\.(?=.*,)/g, '') // dots before a comma are thousands → drop
    .replace(',', '.'); // decimal comma → dot
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export interface CurrencyInputProps {
  /** Numeric value; `null` renders empty. */
  value: number | null;
  /** Emits the number, or `null` when the field is cleared. */
  onChange: (next: number | null) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  error?: string;
  /** Accessible name override (price rows target a specific lista by name). */
  ariaLabel?: string;
  style?: CSSProperties;
  /** Optional content (e.g. an action icon) rendered inside the input's end. */
  rightSection?: ReactNode;
}

/**
 * BRL money input (pt-BR): `R$ ` prefix, comma decimal separator, up to two
 * decimal places. Either `,` or `.` is accepted as the decimal key.
 *
 * `fixedDecimalScale` is enabled ONLY while the field is NOT focused, so a
 * loaded/idle value always shows both decimals (e.g. `R$ 30,00`). It is turned
 * OFF during editing: with a controlled value, fixed decimals re-format
 * mid-typing and react-number-format re-reads the padded `,00` as integer
 * digits, which mis-scaled every keystroke (×100) and blocked decimal entry.
 * `thousandSeparator` is intentionally omitted for the same parsing-ambiguity
 * reason. Negatives are blocked; clamping is left to Zod (`clampBehavior="none"`)
 * so an invalid 0 surfaces as a form error instead of being silently corrected.
 * Emits `null` when cleared.
 */
export function CurrencyInput({
  value,
  onChange,
  label,
  description,
  disabled,
  error,
  ariaLabel,
  style,
  rightSection,
}: CurrencyInputProps) {
  const [editing, setEditing] = useState(false);
  return (
    <NumberInput
      label={label}
      description={description}
      disabled={disabled}
      error={error}
      aria-label={ariaLabel}
      style={style}
      rightSection={rightSection}
      rightSectionPointerEvents={rightSection ? 'all' : undefined}
      value={value ?? ''}
      onChange={(v) => onChange(parseBrl(v))}
      onFocus={() => setEditing(true)}
      onBlur={() => setEditing(false)}
      prefix="R$ "
      decimalScale={2}
      fixedDecimalScale={!editing}
      decimalSeparator=","
      allowedDecimalSeparators={[',', '.']}
      allowNegative={false}
      clampBehavior="none"
      hideControls
    />
  );
}
