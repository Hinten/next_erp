import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import type { FieldRenderProps } from '@delfrance/ui';
import { dimensaoRenderInput, pesoRenderInput } from './PesoField';

/** Minimal `FieldRenderProps` — PesoField only reads a subset (no descriptor). */
const makeProps = (over: Partial<FieldRenderProps> = {}): FieldRenderProps =>
  ({
    name: 'pesoBrutoKg',
    label: 'Peso bruto (kg)',
    hint: 'manual hint',
    value: 1,
    onChange: () => {},
    onBlur: () => {},
    ...over,
  }) as unknown as FieldRenderProps;

/** Render the field inside a form whose `ehKit` drives the read-only behavior. */
function Harness({ ehKit }: { ehKit: boolean }) {
  const form = useForm({ defaultValues: { ehKit } });
  return (
    <MantineTestProvider>
      <FormProvider {...form}>{pesoRenderInput?.(makeProps())}</FormProvider>
    </MantineTestProvider>
  );
}

describe('PesoField', () => {
  it('is editable and shows the manual hint when the produto is not a kit', () => {
    render(<Harness ehKit={false} />);
    const input = screen.getByLabelText('Peso bruto (kg)') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(screen.getByText('manual hint')).toBeTruthy();
  });

  it('is read-only with the "calculado" hint when the produto is a kit', () => {
    render(<Harness ehKit />);
    const input = screen.getByLabelText('Peso bruto (kg)') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(
      screen.getByText('Calculado automaticamente a partir dos componentes do kit.'),
    ).toBeTruthy();
  });
});

/**
 * A CONTROLLED harness — it stores what `onChange` emits and feeds it straight
 * back as `value`, exactly as `ObjectView`'s RHF `Controller` does.
 *
 * ⚠️ The plain `Harness` above cannot see the bug this guards: its `onChange` is
 * a no-op, so the field never re-renders with the parent's answer and the wipe
 * never happens.
 */
function TypingHarness({
  renderInput,
  label,
}: {
  renderInput: typeof pesoRenderInput;
  label: string;
}) {
  const form = useForm({ defaultValues: { ehKit: false } });
  const [value, setValue] = useState<number | null>(null);
  return (
    <MantineTestProvider>
      <FormProvider {...form}>
        {renderInput?.(makeProps({ label, value, onChange: (v) => setValue(v as number | null) }))}
      </FormProvider>
      <output data-testid="held">{value === null ? 'null' : String(value)}</output>
    </MantineTestProvider>
  );
}

/**
 * The reported defect: on the "Dimensões e peso" tab the form kept clearing
 * itself the moment a decimal separator was pressed.
 */
describe('PesoField — typing a decimal', () => {
  it('keeps the value when the decimal separator is pressed (peso, kg)', () => {
    render(<TypingHarness renderInput={pesoRenderInput} label="Peso bruto (kg)" />);
    const input = screen.getByLabelText('Peso bruto (kg)') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '1' } });
    expect(screen.getByTestId('held').textContent).toBe('1');

    // ⭐ The keystroke that used to wipe the field. Asserting only the final
    // "1,25" below would pass against the broken code.
    fireEvent.change(input, { target: { value: '1,' } });
    expect(input.value).toBe('1,');
    expect(screen.getByTestId('held').textContent).toBe('1');

    fireEvent.change(input, { target: { value: '1,25' } });
    expect(input.value).toBe('1,25');
    expect(screen.getByTestId('held').textContent).toBe('1.25');
  });

  it('keeps the value when the decimal separator is pressed (dimensão, cm)', () => {
    render(<TypingHarness renderInput={dimensaoRenderInput} label="Altura (cm)" />);
    const input = screen.getByLabelText('Altura (cm)') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.change(input, { target: { value: '5,' } });
    expect(input.value).toBe('5,');
    expect(screen.getByTestId('held').textContent).toBe('5');

    fireEvent.change(input, { target: { value: '5,5' } });
    expect(screen.getByTestId('held').textContent).toBe('5.5');
  });

  it('clears to null rather than to 0', () => {
    render(<TypingHarness renderInput={dimensaoRenderInput} label="Altura (cm)" />);
    const input = screen.getByLabelText('Altura (cm)') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByTestId('held').textContent).toBe('null');
  });
});
