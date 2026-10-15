import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PERM } from '@delfrance/auth';
import { DELETE_MARK, type FieldRenderProps } from '@delfrance/ui';
import { MantineTestProvider } from '@/lib/testing/mantine';
import type { FreteDaContaLi } from './useFreteDaContaLi';

/**
 * The "Horário de Corte" tab of a Loja Integrada conta (step 20, #1826): the
 * unchanged `/logistica` editor, gated by the freight doc's state, the
 * server-truth seed (doubled here; the page suite pins it) and BOTH write
 * permissions. The weekday rule is the page model's, pinned by the page suite.
 */

const h = vi.hoisted(() => ({ permissoes: 0n, pronto: true }));

vi.mock('@/lib/auth', () => ({
  usePermission: (bit: bigint) => ({ allowed: (h.permissoes & bit) === bit, loading: false }),
}));
vi.mock('./useFreteDaContaLi', async (importActual) => ({
  ...(await importActual<typeof import('./useFreteDaContaLi')>()),
  useSemearFreteDaContaLi: () => ({ ready: h.pronto, error: null }),
}));

const { HorarioCorteManager } = await import('./HorarioCorteManager');

const ENCONTRADO: FreteDaContaLi = {
  estado: 'encontrado',
  intFreteId: 'lojaIntegrada-conta-1',
  ativo: true,
  total: 1,
  naConsulta: true,
};
const LINHA = {
  diaDaSemana: 1,
  horaDeCorte: 16,
  minutosDeCorte: 30,
  prazoDePostagem: 0,
  horaPostagem: 18,
  minutosPostagem: 0,
};

function renderManager(
  value: unknown,
  {
    frete = ENCONTRADO,
    disabled = false,
    recusa,
  }: {
    frete?: FreteDaContaLi;
    disabled?: boolean;
    /** The page's refusal of the horário, as ObjectView hands it to the field: ONE flat message. */
    recusa?: string;
  } = {},
) {
  const onChange = vi.fn();
  const props: FieldRenderProps = {
    name: 'freteHorarioDeCorte',
    label: 'Horários de corte',
    value,
    onChange,
    onBlur: () => undefined,
    disabled,
    error: recusa,
    errorTree: recusa === undefined ? undefined : { type: 'custom', message: recusa },
    descriptor: {} as never,
  };
  render(
    <MantineTestProvider>
      <HorarioCorteManager db={{} as never} frete={frete} {...props} />
    </MantineTestProvider>,
  );
  return onChange;
}

const adicionar = () =>
  screen.queryByRole('button', { name: 'Adicionar horário' }) as HTMLButtonElement | null;

/** Whether row `linha`'s (1-based) `rotulo` cell is marked invalid. */
const invalido = (rotulo: string, linha: number) =>
  screen.getAllByLabelText(`${rotulo} ${linha}`)[0]!.getAttribute('aria-invalid') === 'true';

beforeEach(() => {
  h.permissoes = PERM.frete.write;
  h.pronto = true;
});

describe('HorarioCorteManager', () => {
  it('edits the stored rows with the /logistica editor once loaded and allowed', () => {
    const onChange = renderManager([LINHA]);
    expect((screen.getAllByLabelText('Corte (h) 1')[0] as HTMLInputElement).value).toBe('16');
    fireEvent.click(adicionar()!);
    expect(onChange).toHaveBeenCalledWith([LINHA, expect.objectContaining({ diaDaSemana: 1 })]);
  });

  it('(g) read-only without PERM.frete.write, and says why', () => {
    h.permissoes = 0n;
    renderManager([LINHA]);
    expect(adicionar()?.disabled).toBe(true);
    expect(screen.getByText(/exige permissão de escrita nas integrações de frete/)).toBeTruthy();
  });

  it('(g) read-only when the page is (no conta write permission)', () => {
    renderManager([LINHA], { disabled: true });
    expect(adicionar()?.disabled).toBe(true);
  });

  it('read-only once the loaded doc no longer belongs to the conta, and says why', () => {
    renderManager([LINHA], { frete: { ...ENCONTRADO, naConsulta: false } });
    expect(adicionar()?.disabled).toBe(true);
    expect(screen.getByText('O frete desta conta mudou')).toBeTruthy();
  });

  it('(c) offers no editor before the server-truth seed', () => {
    h.pronto = false;
    renderManager([LINHA]);
    expect(adicionar()).toBeNull();
    expect(screen.getByText('Carregando o frete da conta do servidor…')).toBeTruthy();
  });

  it('a conta with no freight doc explains it, and offers no editor', () => {
    renderManager(null, { frete: { estado: 'ausente' } });
    expect(screen.getByText('Esta conta ainda não tem frete')).toBeTruthy();
    expect(adicionar()).toBeNull();
  });
});

describe('HorarioCorteManager — a refusal names its rows', () => {
  // ObjectView hands a page-level refusal to the field as ONE flat message, so
  // the rows it is about are re-derived from the same rule over the same value.
  it('marks the row that repeats a weekday, and keeps the message under the list', () => {
    renderManager([LINHA, LINHA], { recusa: 'Dia da semana duplicado' });
    expect(invalido('Dia da semana', 2)).toBe(true);
    expect(invalido('Dia da semana', 1)).toBe(false);
    expect(screen.getAllByText('Dia da semana duplicado')).toHaveLength(2);
  });

  it('marks the cell out of range', () => {
    renderManager([{ ...LINHA, horaDeCorte: 30 }], { recusa: 'Too big' });
    expect(invalido('Corte (h)', 1)).toBe(true);
    expect(invalido('Corte (min)', 1)).toBe(false);
  });

  it('maps the row past a staged deletion, as the save strips it', () => {
    renderManager([{ ...LINHA, [DELETE_MARK]: true }, LINHA, LINHA], {
      recusa: 'Dia da semana duplicado',
    });
    expect(invalido('Dia da semana', 1)).toBe(false);
    expect(invalido('Dia da semana', 2)).toBe(false);
    expect(invalido('Dia da semana', 3)).toBe(true);
  });

  it('judges the list the save KEEPS: a staged deletion shifts the index of every row after it', () => {
    // Over the raw list the repeat sits at index 3, which names no row the
    // editor shows; over the list the save keeps it sits at 2 — row 4.
    const TERCA = { ...LINHA, diaDaSemana: 2 };
    const QUARTA = { ...LINHA, diaDaSemana: 3 };
    renderManager([{ ...LINHA, [DELETE_MARK]: true }, TERCA, QUARTA, QUARTA], {
      recusa: 'Dia da semana duplicado',
    });
    expect(invalido('Dia da semana', 4)).toBe(true);
    expect(invalido('Dia da semana', 3)).toBe(false);
    expect(invalido('Dia da semana', 2)).toBe(false);
  });

  it('⚠️ NEAR-MISS: the same list with NO refusal marks nothing — an untouched stored list is not judged', () => {
    renderManager([LINHA, LINHA]);
    expect(invalido('Dia da semana', 2)).toBe(false);
    expect(screen.queryByText('Dia da semana duplicado')).toBeNull();
  });
});
