import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { OPCOES_IMPORTACAO_SHOPEE_PADRAO, SHOPEE_IMPORT_STATUS } from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';
import type { ImportarTodosShopeeActionState } from './useImportarTodosShopeeAction';
import type { AtualizarPrecosShopeeActionState } from './useAtualizarPrecosShopeeAction';

// The calendar has its own library tests; two plain inputs drive the range so
// the dialog's own rules — both ends or neither, SECONDS on the wire — are what
// is exercised here (the `relatorios/checkouts/page.test.tsx` precedent).
vi.mock('@mantine/dates', () => ({
  DatePickerInput: ({
    value,
    onChange,
    error,
  }: {
    value: [string | null, string | null];
    onChange: (value: [string | null, string | null]) => void;
    error?: string | null;
  }) => (
    <>
      <input
        aria-label="Janela — de"
        value={value[0] ?? ''}
        onChange={(e) => onChange([e.target.value || null, value[1]])}
      />
      <input
        aria-label="Janela — até"
        value={value[1] ?? ''}
        onChange={(e) => onChange([value[0], e.target.value || null])}
      />
      {error ? <span>{error}</span> : null}
    </>
  ),
}));

const { ImportarTodosShopeeDialog } = await import('./ImportarTodosShopeeDialog');
const { AtualizarPrecosShopeeDialog } = await import('./AtualizarPrecosShopeeDialog');

function estadoImportacao(): ImportarTodosShopeeActionState {
  return {
    opened: true,
    contas: [{ id: 'int-1', nome: 'Loja A' }],
    busy: false,
    entries: [],
    reatados: new Set(),
    close: vi.fn(),
    start: vi.fn(async () => {}),
    dismiss: vi.fn(),
  };
}

function renderImportacao(state = estadoImportacao()) {
  render(
    <MantineTestProvider>
      <ImportarTodosShopeeDialog state={state} />
    </MantineTestProvider>,
  );
  return state;
}

const iniciar = () => screen.getByRole('button', { name: 'Iniciar importação' });

describe('ImportarTodosShopeeDialog', () => {
  it('names the conta the run will touch', () => {
    renderImportacao();
    expect(screen.getByText('1 conta selecionada')).not.toBeNull();
    expect(screen.getByText('Loja A')).not.toBeNull();
  });

  it('⭐ sends EVERY option, starting from the backend’s own defaults — Ativos and Inativos, no window', () => {
    const state = renderImportacao();
    fireEvent.click(iniciar());

    expect(state.start).toHaveBeenCalledWith({
      ...OPCOES_IMPORTACAO_SHOPEE_PADRAO,
      statuses: [SHOPEE_IMPORT_STATUS.normal, SHOPEE_IMPORT_STATUS.unlist],
    });
  });

  it('keeps the statuses in the canonical order, whatever order they were clicked in', () => {
    const state = renderImportacao();
    fireEvent.click(screen.getByLabelText('Ativos'));
    fireEvent.click(screen.getByLabelText('Inativos'));
    fireEvent.click(screen.getByLabelText('Em revisão'));
    fireEvent.click(screen.getByLabelText('Ativos'));
    fireEvent.click(iniciar());

    expect(state.start).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: [SHOPEE_IMPORT_STATUS.normal, SHOPEE_IMPORT_STATUS.reviewing],
      }),
    );
  });

  it('refuses to start with no status — the wire parameter is required', () => {
    const state = renderImportacao();
    fireEvent.click(screen.getByLabelText('Ativos'));
    fireEvent.click(screen.getByLabelText('Inativos'));

    expect(screen.getByText('Escolha pelo menos um status.')).not.toBeNull();
    expect((iniciar() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(iniciar());
    expect(state.start).not.toHaveBeenCalled();
  });

  it('⭐ turns the date window into SECONDS, whole São Paulo days', () => {
    const state = renderImportacao();
    fireEvent.change(screen.getByLabelText('Janela — de'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('Janela — até'), { target: { value: '2026-10-02' } });
    fireEvent.click(iniciar());

    expect(state.start).toHaveBeenCalledWith(
      expect.objectContaining({ updateTimeFromS: 1790823600, updateTimeToS: 1790996399 }),
    );
  });

  it('refuses half a window instead of guessing the other end', () => {
    const state = renderImportacao();
    fireEvent.change(screen.getByLabelText('Janela — de'), { target: { value: '2026-10-01' } });

    expect(screen.getByText('Escolha as duas datas da janela, ou limpe-a.')).not.toBeNull();
    expect((iniciar() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(iniciar());
    expect(state.start).not.toHaveBeenCalled();
  });

  it('sends the toggles the operator changed', () => {
    const state = renderImportacao();
    fireEvent.click(screen.getByLabelText('Importar fotos'));
    fireEvent.click(screen.getByLabelText('Atualizar anúncios já cadastrados'));
    fireEvent.click(iniciar());

    expect(state.start).toHaveBeenCalledWith(
      expect.objectContaining({ importarFotos: false, atualizarCadastrados: true }),
    );
  });
});

describe('AtualizarPrecosShopeeDialog', () => {
  function estadoPrecos(baixarPreco: boolean): AtualizarPrecosShopeeActionState {
    return {
      opened: true,
      contas: [{ id: 'int-1', nome: 'Loja A' }],
      baixarPreco,
      setBaixarPreco: vi.fn(),
      busy: false,
      entries: [],
      reatados: new Set(),
      close: vi.fn(),
      start: vi.fn(async () => {}),
      dismiss: vi.fn(),
    };
  }

  it('shows the decrease opt-in as the hook holds it and reports a change', () => {
    const state = estadoPrecos(false);
    render(
      <MantineTestProvider>
        <AtualizarPrecosShopeeDialog state={state} />
      </MantineTestProvider>,
    );
    const opcao = screen.getByLabelText('Permitir baixar preços') as HTMLInputElement;
    expect(opcao.checked).toBe(false);

    fireEvent.click(opcao);
    expect(state.setBaixarPreco).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Atualizar preços' }));
    expect(state.start).toHaveBeenCalled();
  });
});
