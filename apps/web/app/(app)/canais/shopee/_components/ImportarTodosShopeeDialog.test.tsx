import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { OPCOES_IMPORTACAO_SHOPEE_PADRAO, SHOPEE_IMPORT_STATUS } from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';
import {
  ROTULO_OPCAO_IMPORTACAO_SHOPEE,
  ROTULO_STATUS_IMPORTACAO_SHOPEE,
} from '@/lib/shopee/rotulosImportacaoShopee';
import type { ImportarTodosShopeeActionState } from './useImportarTodosShopeeAction';
import type { AtualizarPrecosShopeeActionState } from './useAtualizarPrecosShopeeAction';

// The calendar has its own library tests; two plain inputs drive the range so
// the dialog's own rules — both ends or neither, SECONDS on the wire — are what
// is exercised here (the `relatorios/checkouts/page.test.tsx` precedent). Its
// label is rendered too, so the shared label module's `janela` is on screen.
vi.mock('@mantine/dates', () => ({
  DatePickerInput: ({
    label,
    value,
    onChange,
    error,
  }: {
    label?: string;
    value: [string | null, string | null];
    onChange: (value: [string | null, string | null]) => void;
    error?: string | null;
  }) => (
    <>
      <span>{label}</span>
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

  it('#2015: every label the shared module names is on screen, with the default the refusal copy claims', () => {
    // `anuncioProduto.ts`'s `logistica-nao-confirmada` copy quotes these labels
    // and says which come ticked: the screen must agree with both.
    const R = ROTULO_OPCAO_IMPORTACAO_SHOPEE;
    const S = ROTULO_STATUS_IMPORTACAO_SHOPEE;
    renderImportacao();
    const caixa = (rotulo: string) => screen.getByLabelText(rotulo) as HTMLInputElement;
    for (const chave of [
      'importarEstoque',
      'sobrescreverEstoque',
      'importarPreco',
      'sobrescreverPreco',
      'importarFotos',
      'importarCategorias',
      'atualizarProdutoPai',
      'sobrescreverDadosProduto',
      'atualizarCadastrados',
    ] as const) {
      expect(caixa(R[chave]).type, chave).toBe('checkbox');
    }
    // «desmarque … (vem marcado)»: ticked, and untickable as the dialog opens.
    expect(caixa(R.sobrescreverPreco).checked).toBe(true);
    expect(caixa(R.sobrescreverPreco).disabled).toBe(false);
    // «deixe desmarcados …» / «… marcado» (the operator ticks it).
    expect(caixa(R.sobrescreverEstoque).checked).toBe(false);
    expect(caixa(R.sobrescreverDadosProduto).checked).toBe(false);
    expect(caixa(R.atualizarCadastrados).checked).toBe(false);
    // «(«Banidos» e «Em revisão» vêm desmarcados)» — the other two come ticked.
    expect(caixa(S[SHOPEE_IMPORT_STATUS.banned]).checked).toBe(false);
    expect(caixa(S[SHOPEE_IMPORT_STATUS.reviewing]).checked).toBe(false);
    expect(caixa(S[SHOPEE_IMPORT_STATUS.normal]).checked).toBe(true);
    expect(caixa(S[SHOPEE_IMPORT_STATUS.unlist]).checked).toBe(true);
    expect(screen.getByText(R.statuses)).not.toBeNull();
    // «… a «Janela de atualização (opcional)» vazia»: it opens empty.
    expect(screen.getByText(R.janela)).not.toBeNull();
    expect(caixa('Janela — de').value).toBe('');
    expect(caixa('Janela — até').value).toBe('');
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
