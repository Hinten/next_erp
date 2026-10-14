import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PERM } from '@delfrance/auth';
import type { FieldRenderProps } from '@delfrance/ui';
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
  { frete = ENCONTRADO, disabled = false }: { frete?: FreteDaContaLi; disabled?: boolean } = {},
) {
  const onChange = vi.fn();
  const props: FieldRenderProps = {
    name: 'freteHorarioDeCorte',
    label: 'Horários de corte',
    value,
    onChange,
    onBlur: () => undefined,
    disabled,
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
