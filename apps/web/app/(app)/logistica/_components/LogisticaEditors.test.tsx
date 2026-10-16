import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
      <output data-testid="horario-value">{JSON.stringify(value)}</output>
    </MantineTestProvider>
  );
}

function horarioValue(): unknown[] {
  return JSON.parse(screen.getByTestId('horario-value').textContent ?? '[]') as unknown[];
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

  /** The row "Adicionar faixa" starts from. */
  const FAIXA_EM_BRANCO = { cepInicial: '', cepFinal: '', custo: null, valor: null, prazo: null };
  const FAIXA_VALIDA = {
    cepInicial: '01000000',
    cepFinal: '01999999',
    custo: 10,
    valor: 20,
    prazo: 1,
  };

  it('a stored row that is not an object shows as the blank row, and an edit saves the row it shows', () => {
    render(<FaixaHarness initial={[null, 'texto', FAIXA_VALIDA]} />);

    expect(screen.getAllByLabelText(/^CEP Inicial \d$/)).toHaveLength(3);
    expect((screen.getByLabelText('CEP Inicial 1') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Prazo 2') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('CEP Inicial 1'), { target: { value: '02000000' } });
    // The other unmodelled row stays as stored until it is edited.
    expect(faixaValue()).toEqual([
      { ...FAIXA_EM_BRANCO, cepInicial: '02000000' },
      'texto',
      FAIXA_VALIDA,
    ]);
  });

  it('deleting, then restoring, a stored row that is not an object leaves the row it showed', () => {
    render(<FaixaHarness initial={[null]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Excluir faixa 1' }));
    expect(faixaValue()).toEqual([{ ...FAIXA_EM_BRANCO, [DELETE_MARK]: true }]);
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer exclusão da faixa 1' }));
    expect(faixaValue()).toEqual([{ ...FAIXA_EM_BRANCO, [DELETE_MARK]: false }]);
  });

  it('NEAR-MISS: an object row is edited in place — its stored keys survive, no blank defaults pad it', () => {
    const legada = { cepInicial: '01000000', cepFinal: '01999999', valor: 20, obs: 'legado' };
    render(<FaixaHarness initial={[legada]} />);
    fireEvent.change(screen.getByLabelText('Prazo 1'), { target: { value: '3' } });
    expect(faixaValue()).toEqual([{ ...legada, prazo: 3 }]);
  });

  it('shows a row-level issue under its own row, past a marked predecessor', () => {
    render(
      <FaixaHarness
        initial={[{ ...FAIXA_VALIDA, [DELETE_MARK]: true }, FAIXA_VALIDA, 'texto']}
        errorTree={[undefined, { message: 'Tipo inválido: esperado object, recebido string' }]}
      />,
    );
    const linhas = screen
      .getAllByLabelText(/^CEP Inicial \d$/)
      .map((cep) => cep.closest('.mantine-Stack-root'));
    expect(linhas[2]?.textContent).toContain('Tipo inválido: esperado object, recebido string');
    expect(linhas[1]?.textContent).not.toContain('Tipo inválido');
  });

  it('NEAR-MISS: a key-level issue stays on its cell and is not repeated as a row message', () => {
    render(
      <FaixaHarness
        initial={[{ ...FAIXA_VALIDA, cepInicial: '1' }]}
        errorTree={[{ cepInicial: { message: 'CEP deve ter 8 dígitos' } }]}
      />,
    );
    expect(screen.getAllByText('CEP deve ter 8 dígitos')).toHaveLength(1);
    expect(screen.getByLabelText('CEP Inicial 1').getAttribute('aria-invalid')).toBe('true');
  });
});

/**
 * The weekday Select shows what is SAVED. It used to fall back to Monday for a
 * row with no weekday, while an edit saved the row without one — and Select
 * fires no change for the value it already shows, so picking the Monday on
 * screen could never fix the row.
 */
describe('HorarioCorteEditor — a stored row with no readable weekday', () => {
  const diaDaSemana1 = () => screen.getByLabelText('Dia da semana 1') as HTMLInputElement;

  it.each([
    ['absent', {}],
    ['null', { diaDaSemana: null }],
    ['text', { diaDaSemana: '1' }],
    ['out of range', { diaDaSemana: 9 }],
  ])('shows no weekday when it is %s, and picking Monday saves Monday', (_caso, dia) => {
    render(<HorarioHarness initial={[{ ...dia, horaDeCorte: 14 }]} />);
    expect(diaDaSemana1().value).toBe('');

    fireEvent.click(screen.getByRole('combobox', { name: 'Dia da semana 1' }));
    fireEvent.click(screen.getByRole('option', { name: 'Segunda-feira' }));
    expect(horarioValue()).toEqual([{ ...dia, horaDeCorte: 14, diaDaSemana: 1 }]);
    expect(diaDaSemana1().value).toBe('Segunda-feira');
  });

  it('an edit of another cell saves the row as shown — still with no weekday', () => {
    render(<HorarioHarness initial={[{ horaDeCorte: 14 }]} />);
    fireEvent.change(screen.getByLabelText('Corte (min) 1'), { target: { value: '30' } });
    expect(horarioValue()).toEqual([{ horaDeCorte: 14, minutosDeCorte: 30 }]);
    expect(diaDaSemana1().value).toBe('');
  });

  it('NEAR-MISS: a stored weekday shows as itself, and an added row starts on Monday', () => {
    render(<HorarioHarness initial={[{ diaDaSemana: 3, horaDeCorte: 14 }]} />);
    expect(diaDaSemana1().value).toBe('Quarta-feira');
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar horário' }));
    expect((screen.getByLabelText('Dia da semana 2') as HTMLInputElement).value).toBe(
      'Segunda-feira',
    );
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

  /** The row "Adicionar horário" starts from: Monday, every number blank. */
  const LINHA_EM_BRANCO = {
    diaDaSemana: 1,
    horaDeCorte: null,
    minutosDeCorte: null,
    prazoDePostagem: null,
    horaPostagem: null,
    minutosPostagem: null,
  };

  it('a stored row that is not an object shows as the blank row, and an edit saves the row it shows', () => {
    const onChange = vi.fn();
    render(
      <MantineTestProvider>
        <HorarioCorteEditor
          name="horarioDeCorte"
          label="Horários de corte"
          value={[null, 'texto', { diaDaSemana: 2 }]}
          onChange={onChange}
          onBlur={() => undefined}
          descriptor={{} as FieldRenderProps['descriptor']}
        />
      </MantineTestProvider>,
    );
    expect(screen.getAllByLabelText(/^Dia da semana \d$/)).toHaveLength(3);
    expect((screen.getByLabelText('Dia da semana 1') as HTMLInputElement).value).toBe(
      'Segunda-feira',
    );
    expect((screen.getAllByLabelText('Corte (h) 1')[0] as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getAllByLabelText('Corte (h) 1')[0]!, { target: { value: '15' } });
    // The weekday on screen is the weekday saved — Select never fires onChange
    // for the value it already shows, so a row saved WITHOUT it could not be
    // fixed by confirming it. The other unmodelled row is left as stored.
    expect(onChange).toHaveBeenLastCalledWith([
      { ...LINHA_EM_BRANCO, horaDeCorte: 15 },
      'texto',
      { diaDaSemana: 2 },
    ]);
  });

  it('deleting, then restoring, a stored row that is not an object leaves the row it showed', () => {
    render(<HorarioHarness initial={[null]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Excluir horário 1' }));
    expect(horarioValue()).toEqual([{ ...LINHA_EM_BRANCO, [DELETE_MARK]: true }]);
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer exclusão do horário 1' }));
    expect(horarioValue()).toEqual([{ ...LINHA_EM_BRANCO, [DELETE_MARK]: false }]);
  });
});
