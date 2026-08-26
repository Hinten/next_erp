import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { MantineTestProvider } from '../testing/mantine';
import { DecimalInput } from './DecimalInput';

/**
 * A CONTROLLED harness — it stores what `onChange` emits and hands it straight
 * back as `value`.
 *
 * ⚠️ This shape is mandatory, not stylistic. A `vi.fn()` spy cannot see this bug
 * class at all: the defect is that the parent's answer to an in-progress
 * keystroke re-renders the field empty, and a spy never re-renders anything, so
 * a spy harness passes against the broken code.
 */
function Harness({
  initial = null,
  decimalScale,
  min,
  max,
  clampBehavior,
}: {
  initial?: number | null;
  decimalScale?: number;
  min?: number;
  max?: number;
  clampBehavior?: 'none' | 'blur' | 'strict';
}) {
  const [value, setValue] = useState<number | null>(initial);
  return (
    <MantineTestProvider>
      <DecimalInput
        label="Altura (cm)"
        value={value}
        onChange={setValue}
        decimalScale={decimalScale}
        min={min}
        max={max}
        clampBehavior={clampBehavior}
      />
      <output data-testid="held">{value === null ? 'null' : String(value)}</output>
    </MantineTestProvider>
  );
}

const held = () => screen.getByTestId('held').textContent;
const box = () => screen.getByLabelText('Altura (cm)') as HTMLInputElement;

/**
 * ⚠️ `fireEvent.change` replaces the WHOLE value, so each call must carry the
 * full text the field would show after that one keystroke. Skipping the
 * intermediate states is exactly what makes such a test vacuous.
 */
describe('DecimalInput', () => {
  it('lets a decimal be typed one keystroke at a time', () => {
    render(<Harness decimalScale={2} />);
    const input = box();

    fireEvent.change(input, { target: { value: '1' } });
    expect(input.value).toBe('1');
    expect(held()).toBe('1');

    // ⭐ THE load-bearing assertion. Mantine emits the STRING "1." here, and the
    // old `typeof v === 'number' ? v : null` answered it with null — blowing the
    // field away on the very keystroke that opens the decimal. Jumping straight
    // to "1,5" below passes against that broken code.
    fireEvent.change(input, { target: { value: '1,' } });
    expect(input.value).toBe('1,');
    expect(held()).toBe('1');

    fireEvent.change(input, { target: { value: '1,5' } });
    expect(input.value).toBe('1,5');
    expect(held()).toBe('1.5');
  });

  it('survives a trailing zero, which Mantine also emits as a string', () => {
    render(<Harness decimalScale={2} />);
    const input = box();

    fireEvent.change(input, { target: { value: '1,5' } });
    expect(held()).toBe('1.5');

    // "1.50" matches Mantine's `trailingZerosPattern` -> string, not number.
    fireEvent.change(input, { target: { value: '1,50' } });
    expect(input.value).toBe('1,50');
    expect(held()).toBe('1.5');
  });

  it('survives a leading decimal zero, which Mantine also emits as a string', () => {
    render(<Harness decimalScale={2} />);
    const input = box();

    // "0." and "0.0" both match `leadingDecimalZeroPattern`. Type the zero
    // first: inserting "0," into an EMPTY field in one go is a multi-character
    // diff, which react-number-format treats as a paste and trims.
    fireEvent.change(input, { target: { value: '0' } });
    expect(held()).toBe('0');

    fireEvent.change(input, { target: { value: '0,' } });
    expect(input.value).toBe('0,');
    expect(held()).toBe('0');

    fireEvent.change(input, { target: { value: '0,9' } });
    expect(input.value).toBe('0,9');
    expect(held()).toBe('0.9');
  });

  it('accepts a dot as the decimal key and displays it as a comma', () => {
    render(<Harness decimalScale={2} />);
    const input = box();

    // One character at a time: `allowedDecimalSeparators` acts on the character
    // being INSERTED, so a whole-value change is a different event entirely.
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.change(input, { target: { value: '2.' } });
    expect(input.value).toBe('2,');
    expect(held()).toBe('2');

    fireEvent.change(input, { target: { value: '2,5' } });
    expect(held()).toBe('2.5');
  });

  it('clears to null, never to 0', () => {
    render(<Harness initial={7} decimalScale={2} />);
    fireEvent.change(box(), { target: { value: '' } });
    expect(held()).toBe('null');
  });

  it('does not pad an idle value — that is a money affordance, not a decimal one', () => {
    render(<Harness initial={30} decimalScale={2} />);
    expect(box().value).toBe('30');
  });

  it('works with no decimalScale at all', () => {
    render(<Harness initial={1} />);
    const input = box();
    expect(input.value).toBe('1');

    fireEvent.change(input, { target: { value: '1,' } });
    expect(held()).toBe('1');
    fireEvent.change(input, { target: { value: '1,234' } });
    expect(held()).toBe('1.234');
  });

  it('caps the typed precision at decimalScale', () => {
    render(<Harness decimalScale={2} />);
    const input = box();
    fireEvent.change(input, { target: { value: '1,239' } });
    expect(input.value).toBe('1,23');
    expect(held()).toBe('1.23');
  });
});

/**
 * ⭐ `clampBehavior` must keep MANTINE's default, not invent one.
 *
 * An earlier revision defaulted it to `'none'`, which silently disarmed the
 * `min`/`max` of eleven converted call sites — `precoDeVenda`'s `min={0.01}`,
 * `Temperatura`'s `max={2}`, seven `max={1}` coefficients — none of which has
 * any downstream re-check. A wrapper that changes a default of the component it
 * wraps breaks its callers without touching them.
 *
 * ⚠️ `fireEvent.focusOut`, not `fireEvent.blur`: React listens on `focusout`.
 */
describe('DecimalInput — bounds', () => {
  it("clamps up to `min` on blur by default, like Mantine's own NumberInput", () => {
    render(<Harness min={0.01} decimalScale={2} />);
    const input = box();

    fireEvent.change(input, { target: { value: '0' } });
    expect(held()).toBe('0');

    fireEvent.focusOut(input);
    expect(held()).toBe('0.01');
  });

  it('clamps down to `max` on blur too', () => {
    render(<Harness max={2} decimalScale={1} />);
    const input = box();

    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.focusOut(input);
    expect(held()).toBe('2');
  });

  it('leaves the value alone when a caller opts out with "none"', () => {
    render(<Harness min={0.01} decimalScale={2} clampBehavior="none" />);
    const input = box();

    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.focusOut(input);
    // CurrencyInput relies on this: an invalid 0 must reach Zod as a form error
    // rather than be silently corrected into a valid-looking price.
    expect(held()).toBe('0');
  });

  it('still lets a decimal be typed under the default clamp', () => {
    // The clamp runs on blur, so it must not interfere with typing "0,5" — the
    // reason `"strict"` would have been the wrong repair.
    render(<Harness min={0.01} decimalScale={2} />);
    const input = box();

    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.change(input, { target: { value: '0,' } });
    expect(held()).toBe('0');
    fireEvent.change(input, { target: { value: '0,5' } });
    expect(input.value).toBe('0,5');

    fireEvent.focusOut(input);
    expect(held()).toBe('0.5');
  });
});
