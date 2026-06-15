'use client';

import type { CSSProperties } from 'react';
import { NumberInput } from '@mantine/core';

/**
 * Coerce Mantine `NumberInput`'s `onChange` payload to a number (or `null` when
 * empty). With pt-BR separators the control hands back a FORMATTED STRING
 * ("R$ 1.234,56") — and Playwright `.fill()` always yields a string — so a
 * naive `typeof v === 'number'` check silently drops every value. Strip the
 * prefix and thousands dots, turn the decimal comma into a dot, then parse.
 */
function parseBrl(v: number | string): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const cleaned = v
    .replace(/[^\d.,-]/g, '') // drop "R$", spaces, NBSP
    .replace(/\./g, '') // thousands separator
    .replace(',', '.'); // decimal separator → dot
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
}

/**
 * BRL money input (pt-BR): `R$ ` prefix, comma decimal separator, dot thousands
 * grouping, and a FIXED two-decimal scale so values loaded from Firestore show
 * as e.g. `R$ 30,00` (not `R$ 30`). Negatives are blocked. Clamping is left to
 * Zod validation (`clampBehavior="none"`) so an invalid 0 surfaces as a form
 * error instead of being silently corrected. Emits `null` when cleared.
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
}: CurrencyInputProps) {
  return (
    <NumberInput
      label={label}
      description={description}
      disabled={disabled}
      error={error}
      aria-label={ariaLabel}
      style={style}
      value={value ?? ''}
      onChange={(v) => onChange(parseBrl(v))}
      prefix="R$ "
      decimalScale={2}
      fixedDecimalScale
      decimalSeparator=","
      thousandSeparator="."
      allowNegative={false}
      clampBehavior="none"
      hideControls
    />
  );
}
