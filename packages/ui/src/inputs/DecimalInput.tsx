'use client';

import type { CSSProperties, FocusEvent, KeyboardEvent, ReactNode, Ref } from 'react';
import type { MantineSize } from '@mantine/core';
import { NumberInput } from '@mantine/core';

import { parseDecimalInput } from './decimalValue';

export interface DecimalInputProps {
  /** Numeric value; `null` renders an empty field. */
  value: number | null;
  /** Emits the number, or `null` when the field is cleared. */
  onChange: (next: number | null) => void;
  /** Digits after the separator. Omit for "as many as typed". */
  decimalScale?: number;
  /**
   * Reject the decimal separator outright. Pair with `decimalScale={0}` for a
   * field that is conceptually an integer but shares a generic wrapper with
   * decimal siblings (the frete `prazo` fields).
   */
  allowDecimal?: boolean;
  /**
   * Defaults to `'blur'` — **Mantine's own default**, deliberately.
   *
   * ⚠️ This wrapper must not silently change a default of the component it
   * wraps. An earlier revision defaulted to `'none'` on the theory that an
   * out-of-range value should surface as a Zod error; that theory was never
   * checked against the call sites, and eleven of them relied on the Mantine
   * default for the ONLY enforcement their bound had — `precoDeVenda`'s
   * `min={0.01}`, `Temperatura`'s `max={2}`, seven `max={1}` coefficients in
   * `RegraForm`. Nothing downstream re-checks any of them, so the field simply
   * stopped correcting itself.
   *
   * Pass `'none'` to genuinely defer to schema validation (`CurrencyInput`
   * does), or `'strict'` to reject the keystroke outright (`DevolucaoTab`'s
   * quantity, where `max` guards against returning more than was sold).
   */
  clampBehavior?: 'none' | 'blur' | 'strict';
  /**
   * Pad an idle value out to `decimalScale` (`30` renders `30,00`).
   *
   * ⚠️ Off by default, and a caller that turns it on must turn it back OFF
   * while the field is focused — see the note on `CurrencyInput`, the only
   * place in this repo that needs it.
   */
  fixedDecimalScale?: boolean;
  /** Rendered inside the field, before the digits (e.g. `'R$ '`). */
  prefix?: string;
  /** Rendered inside the field, after the digits. */
  suffix?: string;
  /** Defaults to `false` — these fields are weights, sizes and money. */
  allowNegative?: boolean;
  min?: number;
  max?: number;
  step?: number;
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  /** Accessible name override (grid rows target one cell by name). */
  ariaLabel?: string;
  /** Hide the increment/decrement chevrons. */
  hideControls?: boolean;
  style?: CSSProperties;
  w?: string | number;
  size?: MantineSize;
  /** Forwarded to the underlying `<input>` (grid rows move focus by ref). */
  ref?: Ref<HTMLInputElement>;
  /** Optional content (e.g. an action icon) rendered inside the input's end. */
  rightSection?: ReactNode;
  onFocus?: (event: FocusEvent<HTMLInputElement>) => void;
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
}

/**
 * THE decimal number input for this app (pt-BR): comma decimal separator,
 * either `,` or `.` accepted as the decimal key, `null` when cleared.
 *
 * ## Why this exists rather than a bare `<NumberInput>`
 *
 * Mantine emits a formatted STRING for every in-progress decimal, so the
 * obvious `typeof v === 'number' ? v : null` coercion answers the keystroke
 * that OPENS the decimal with `null` — and a controlled input then re-renders
 * empty, which makes a decimal unreachable however slowly you type.
 * `parseDecimalInput` is the one place that rule is written; its docblock lists
 * the four patterns involved.
 *
 * ## Two deliberate omissions, each with a scar behind it
 *
 * - **`fixedDecimalScale` is off unless a caller asks for it.** Padding a
 *   controlled value to `,00` while it is being typed makes react-number-format
 *   re-read the forced decimals as integer digits, which mis-scaled every
 *   keystroke (x100) and blocked decimal entry outright (`07bf3fa7`). Padding is
 *   a *money* affordance anyway — a weight reading `1,250 kg` or an NF-e
 *   alíquota reading `17,000000` is noise, not information. Keeping it out by
 *   default means this component's correctness never depends on a focus event.
 * - **`thousandSeparator` is never set at all.** It makes the parse ambiguous
 *   and zeroed the localized pedido inputs (`3fb2b299`).
 *
 * `clampBehavior` follows Mantine (`'blur'`) — see the prop's note.
 */
export function DecimalInput({
  value,
  onChange,
  decimalScale,
  allowDecimal,
  fixedDecimalScale,
  clampBehavior = 'blur',
  prefix,
  suffix,
  allowNegative = false,
  min,
  max,
  step,
  label,
  description,
  error,
  disabled,
  ariaLabel,
  hideControls,
  style,
  w,
  size,
  ref,
  rightSection,
  onFocus,
  onBlur,
  onKeyDown,
  autoFocus,
}: DecimalInputProps) {
  return (
    <NumberInput
      label={label}
      description={description}
      error={error}
      disabled={disabled}
      aria-label={ariaLabel}
      style={style}
      w={w}
      size={size}
      ref={ref}
      rightSection={rightSection}
      rightSectionPointerEvents={rightSection ? 'all' : undefined}
      value={value ?? ''}
      onChange={(v) => onChange(parseDecimalInput(v))}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      autoFocus={autoFocus}
      prefix={prefix}
      suffix={suffix}
      decimalScale={decimalScale}
      allowDecimal={allowDecimal}
      fixedDecimalScale={fixedDecimalScale}
      decimalSeparator=","
      allowedDecimalSeparators={[',', '.']}
      allowNegative={allowNegative}
      min={min}
      max={max}
      step={step}
      clampBehavior={clampBehavior}
      hideControls={hideControls}
    />
  );
}
