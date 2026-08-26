'use client';

import { type CSSProperties, type ReactNode, useState } from 'react';
import { DecimalInput } from '@delfrance/ui';

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
 * BRL money input (pt-BR): `R$ ` prefix, two decimal places.
 *
 * Everything about reading the operator's keystrokes lives in `DecimalInput`
 * (`@delfrance/ui`) — this adds only what is specific to money.
 *
 * ⚠️ The one thing it adds is genuinely delicate: **`fixedDecimalScale` is on
 * ONLY while the field is not focused**, so an idle price always shows both
 * decimals (`R$ 30,00`) while a price being typed shows exactly what was typed.
 * Padding a controlled value mid-typing makes react-number-format re-read the
 * forced `,00` as integer digits, which mis-scaled every keystroke (×100) and
 * blocked decimal entry outright (`07bf3fa7`). This is the only field kind in
 * the app that wants the padding, which is why `DecimalInput` leaves it off by
 * default rather than sequencing it for everyone.
 *
 * Negatives are blocked; clamping is left to Zod so an invalid 0 surfaces as a
 * form error instead of being silently corrected. Emits `null` when cleared.
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
    <DecimalInput
      label={label}
      description={description}
      disabled={disabled}
      error={error}
      ariaLabel={ariaLabel}
      style={style}
      rightSection={rightSection}
      value={value}
      onChange={onChange}
      onFocus={() => setEditing(true)}
      onBlur={() => setEditing(false)}
      prefix="R$ "
      decimalScale={2}
      fixedDecimalScale={!editing}
      // Deliberate opt-out, carried over verbatim: clamping is left to Zod so
      // an invalid 0 surfaces as a form error instead of being silently
      // corrected into a valid-looking price.
      clampBehavior="none"
      hideControls
    />
  );
}
