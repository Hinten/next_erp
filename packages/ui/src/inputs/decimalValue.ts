/**
 * Coerce Mantine `NumberInput`'s `onChange` payload to a number (or `null` when
 * the field is empty).
 *
 * ## Why a plain `typeof v === 'number'` check is a bug
 *
 * Mantine 9's `NumberInput` deliberately hands back `payload.value` — a
 * STRING — instead of `payload.floatValue` whenever the input is mid-decimal.
 * Four patterns in `NumberInput.mjs` force that branch:
 *
 * | pattern                             | emits a string for      |
 * | ----------------------------------- | ----------------------- |
 * | `trailingDecimalSeparatorPattern`   | `"1."`, `"25."`         |
 * | `trailingZerosPattern`              | `"1.0"`, `"1.50"`       |
 * | `leadingDecimalZeroPattern`         | `"0."`, `"0.0"`, `"-0"` |
 * | `!isValidNumber(...)`               | `""`, `"-"`             |
 *
 * A controlled input whose parent answers those with `null` (or `0`, or the
 * previous value) re-renders empty on the very keystroke that opened the
 * decimal, so a decimal can never be typed at all — however slowly. That is the
 * defect this function exists to make impossible; every decimal field in the
 * app must route its `onChange` through it (or through `DecimalInput`, which
 * does it for you).
 *
 * ⚠️ Note what is NOT the problem: Mantine's `allowedDecimalSeparators` already
 * defaults to `['.', ',']`, so typing a comma has always worked. Only the
 * DISPLAY separator is configurable, and `DecimalInput` sets it to `,`.
 *
 * ## What it accepts
 *
 * Mantine's string is react-number-format's unformatted numeric string, so it
 * is always dot-decimal and prefix-free. The comma/thousands handling below is
 * for the other two producers: a Playwright `.fill()` and a human pasting a
 * pt-BR value (`"1.234,56"`, `"R$ 30,00"`).
 */
export function parseDecimalInput(v: number | string): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const cleaned = v
    .replace(/[^\d.,-]/g, '') // drop "R$", spaces, NBSP
    .replace(/\.(?=.*,)/g, '') // dots before a comma are thousands -> drop
    .replace(',', '.'); // decimal comma -> dot
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  // `Number('-0')` is `-0`; `+0` keeps a stored value from round-tripping as
  // `-0`, which compares equal but serialises differently.
  return Number.isFinite(n) ? n + 0 : null;
}
