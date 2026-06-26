import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { FormProvider, useForm } from 'react-hook-form';
import type { FieldRenderProps } from '@delfrance/ui';
import { pesoRenderInput } from './PesoField';

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
    <MantineProvider>
      <FormProvider {...form}>{pesoRenderInput?.(makeProps())}</FormProvider>
    </MantineProvider>
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
