import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DELETE_MARK, type FieldRenderProps } from '@delfrance/ui';
import { faixaDeCepSchema } from '@delfrance/schemas';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { FaixaCepEditor } from './FaixaCepEditor';
import { HorarioCorteEditor } from './HorarioCorteEditor';

function FaixaHarness({ initial, errorTree }: { initial: unknown[]; errorTree?: unknown }) {
  const [value, setValue] = useState<unknown>(initial);
  return (
    <MantineTestProvider>
      <FaixaCepEditor
        name="faixaCep"
        label="Faixas de CEP"
        value={value}
        onChange={setValue}
        onBlur={() => undefined}
        errorTree={errorTree}
        descriptor={{} as FieldRenderProps['descriptor']}
      />
      <output data-testid="faixa-value">{JSON.stringify(value)}</output>
    </MantineTestProvider>
  );
}

function HorarioHarness({ initial, errorTree }: { initial: unknown[]; errorTree?: unknown }) {
  const [value, setValue] = useState<unknown>(initial);
  return (
    <MantineTestProvider>
      <HorarioCorteEditor
        name="horarioDeCorte"
        label="Horários de corte"
        value={value}
        onChange={setValue}
        onBlur={() => undefined}
        errorTree={errorTree}
        descriptor={{} as FieldRenderProps['descriptor']}
      />
    </MantineTestProvider>
  );
}

function faixaValue(): Array<Record<string, unknown>> {
  return JSON.parse(screen.getByTestId('faixa-value').textContent ?? '[]') as Array<
    Record<string, unknown>
  >;
}

describe('FaixaCepEditor', () => {
  it('adds blank numeric cells and accepts an explicitly entered zero', () => {
    render(<FaixaHarness initial={[]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar faixa' }));
    expect((screen.getByLabelText('Custo 1') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Preço 1') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Prazo 1') as HTMLInputElement).value).toBe('');
    expect(faixaValue()[0]).toMatchObject({ custo: null, valor: null, prazo: null });

    fireEvent.change(screen.getByLabelText('Custo 1'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Preço 1'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Prazo 1'), { target: { value: '0' } });
    expect(faixaValue()[0]).toMatchObject({ custo: 0, valor: 0, prazo: 0 });
  });

  it('keeps cleared numeric cells blank and invalid instead of coercing them to zero', () => {
    render(
      <FaixaHarness
        initial={[
          {
            cepInicial: '01000000',
            cepFinal: '01999999',
            custo: 10,
            valor: 20,
            prazo: 1,
          },
        ]}
      />,
    );

    fireEvent.change(screen.getByLabelText('Custo 1'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Preço 1'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Prazo 1'), { target: { value: '' } });

    const row = faixaValue()[0]!;
    expect(row).toMatchObject({ custo: null, valor: null, prazo: null });
    expect((screen.getByLabelText('Custo 1') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Preço 1') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Prazo 1') as HTMLInputElement).value).toBe('');
    expect(faixaDeCepSchema.safeParse(row).success).toBe(false);
  });

  it('maps a validated error to an unmarked row after a marked predecessor', () => {
    render(
      <FaixaHarness
        initial={[
          {
            cepInicial: '01000000',
            cepFinal: '01999999',
            custo: 10,
            valor: 20,
            prazo: 1,
            [DELETE_MARK]: true,
          },
          {
            cepInicial: '1',
            cepFinal: '02999999',
            custo: 10,
            valor: 20,
            prazo: 1,
          },
        ]}
        errorTree={[{ cepInicial: { message: 'CEP deve ter 8 dígitos' } }]}
      />,
    );

    expect(screen.getByLabelText('CEP Inicial 1').getAttribute('aria-invalid')).not.toBe('true');
    expect(screen.getByLabelText('CEP Inicial 2').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('CEP deve ter 8 dígitos')).toBeTruthy();
  });
});

describe('HorarioCorteEditor', () => {
  it('maps a duplicate-weekday error past a marked predecessor', () => {
    const horario = (diaDaSemana: number) => ({
      diaDaSemana,
      horaDeCorte: 12,
      minutosDeCorte: 0,
      prazoDePostagem: 0,
      horaPostagem: 18,
      minutosPostagem: 0,
    });
    render(
      <HorarioHarness
        initial={[{ ...horario(1), [DELETE_MARK]: true }, horario(2), horario(2)]}
        errorTree={[undefined, { diaDaSemana: { message: 'Dia da semana duplicado' } }]}
      />,
    );

    expect(screen.getByLabelText('Dia da semana 1').getAttribute('aria-invalid')).not.toBe('true');
    expect(screen.getByLabelText('Dia da semana 3').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Dia da semana duplicado')).toBeTruthy();
  });
});
