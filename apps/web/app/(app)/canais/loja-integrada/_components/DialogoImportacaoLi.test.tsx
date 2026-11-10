import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  ACAO_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  CATEGORIAS_IMPORTACAO_LI,
  FOTOS_IMPORTACAO_LI,
  MODO_IMPORTACAO_LI,
  OPCOES_IMPORTACAO_LI_PADRAO,
  opcoesImportacaoLiSchema,
} from '@delfrance/schemas';

import type { EntradaOpcoesImportacaoLi } from '@/lib/loja-integrada/client';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { DialogoImportacaoLi } from './DialogoImportacaoLi';
import type { ImportarProdutosLiActionState } from './useImportarProdutosLiAction';

/**
 * The start dialog of the product import (master plan step 9): its defaults,
 * its five groups, and the one rule the start body enforces — under "Só
 * vincular" the categories and photos are disabled and SENT as their defaults.
 * Every body it sends is also parsed through the strict start schema, so a
 * dialog that could build a body the backend refuses fails here.
 */

function estado(over: Partial<ImportarProdutosLiActionState> = {}): ImportarProdutosLiActionState {
  return {
    opened: true,
    contas: [{ id: 'conta-falsa-1', nome: 'Conta A' }],
    busy: false,
    entries: [],
    reatados: new Set(),
    close: vi.fn(),
    start: vi.fn(async () => {}),
    iniciar: vi.fn(async () => []),
    dismiss: vi.fn(),
    dispensados: new Set(),
    dispensarJob: vi.fn(),
    ...over,
  };
}

function renderDialogo(state = estado()) {
  const utils = render(
    <MantineTestProvider>
      <DialogoImportacaoLi state={state} />
    </MantineTestProvider>,
  );
  return { state, ...utils };
}

const radio = (nome: string) => screen.getByRole('radio', { name: nome }) as HTMLInputElement;
const confirmar = () =>
  screen.getByRole('button', { name: /Iniciar (simulação|importação)/ }) as HTMLButtonElement;

/** The one body `start` was called with — and it must be one the backend accepts. */
function corpoEnviado(state: ImportarProdutosLiActionState): EntradaOpcoesImportacaoLi {
  const start = vi.mocked(state.start);
  expect(start).toHaveBeenCalledTimes(1);
  const corpo = start.mock.calls[0]![0];
  expect(opcoesImportacaoLiSchema.safeParse(corpo).success).toBe(true);
  return corpo;
}

describe('DialogoImportacaoLi', () => {
  it('names the contas the run will touch', () => {
    renderDialogo(
      estado({
        contas: [
          { id: 'conta-falsa-1', nome: 'Conta A' },
          { id: 'conta-falsa-2', nome: 'Conta B' },
        ],
      }),
    );
    expect(screen.getByText('2 contas selecionadas')).not.toBeNull();
    expect(screen.getByText('Conta A')).not.toBeNull();
    expect(screen.getByText('Conta B')).not.toBeNull();
  });

  it('⭐ opens on the options that change the least — and sends exactly them', () => {
    const { state } = renderDialogo();
    expect(radio('Simular').checked).toBe(true);
    expect(radio('Todos').checked).toBe(true);
    expect(radio('Só vincular').checked).toBe(true);

    fireEvent.click(confirmar());

    expect(corpoEnviado(state)).toEqual(OPCOES_IMPORTACAO_LI_PADRAO);
    expect(confirmar().textContent).toBe('Iniciar simulação');
  });

  it('says what the run never does, and what each option does', () => {
    renderDialogo();
    expect(screen.getByText(/A loja nunca sobrescreve o ERP: só campos vazios/)).not.toBeNull();
    expect(screen.getByText(/Preço e estoque nunca são importados\./)).not.toBeNull();
    expect(screen.getByText(/sem gravar nada no ERP\./)).not.toBeNull();
    expect(screen.getByText(/nenhum produto é criado nem alterado\./)).not.toBeNull();
    expect(screen.getByText(/preenche só os campos vazios dos que já existem\./)).not.toBeNull();
    expect(screen.getByText('Nenhuma foto é copiada da loja.')).not.toBeNull();
  });

  it('offers three targets — never the selection, which a Simular’s result starts', () => {
    renderDialogo();
    expect(radio('Todos')).not.toBeNull();
    expect(radio('Só os que ainda não estão no ERP')).not.toBeNull();
    expect(radio('Só os que já estão no ERP')).not.toBeNull();
    expect(screen.queryByRole('radio', { name: 'Selecionados' })).toBeNull();
  });

  it('⭐ under "Só vincular" categories and photos are DISABLED; under "Completar" they are not', () => {
    renderDialogo();
    const grupos = [
      'Criar e vincular as que faltam',
      'Usar só as já vinculadas',
      'Não importar',
      'Só em produtos sem foto',
    ];
    for (const nome of grupos) expect(radio(nome).disabled).toBe(true);
    expect(screen.getAllByText(/Só com "Completar"/)).toHaveLength(2);

    // NEAR MISS — the same groups, one choice over.
    fireEvent.click(radio('Completar'));
    for (const nome of grupos) expect(radio(nome).disabled).toBe(false);
    expect(screen.queryByText(/Só com "Completar"/)).toBeNull();
  });

  it('⭐ a choice made under "Completar" is NOT sent after switching back to "Só vincular"', () => {
    const { state } = renderDialogo();
    fireEvent.click(radio('Completar'));
    fireEvent.click(radio('Criar e vincular as que faltam'));
    fireEvent.click(radio('Só em produtos sem foto'));
    fireEvent.click(radio('Só vincular'));

    // The disabled groups show what is sent.
    expect(radio('Usar só as já vinculadas').checked).toBe(true);
    expect(radio('Não importar').checked).toBe(true);
    fireEvent.click(confirmar());

    expect(corpoEnviado(state)).toEqual({
      ...OPCOES_IMPORTACAO_LI_PADRAO,
      acao: ACAO_IMPORTACAO_LI.soVincular,
      categorias: CATEGORIAS_IMPORTACAO_LI.soVincular,
      fotos: FOTOS_IMPORTACAO_LI.naoImportar,
    });
  });

  it('NEAR MISS — under "Completar" the picks ARE sent, and the way back restores them', () => {
    const { state } = renderDialogo();
    fireEvent.click(radio('Completar'));
    fireEvent.click(radio('Criar e vincular as que faltam'));
    fireEvent.click(radio('Só em produtos sem foto'));
    fireEvent.click(radio('Só vincular'));
    fireEvent.click(radio('Completar'));

    expect(radio('Criar e vincular as que faltam').checked).toBe(true);
    fireEvent.click(confirmar());

    expect(corpoEnviado(state)).toEqual({
      modo: MODO_IMPORTACAO_LI.simular,
      alvo: ALVO_IMPORTACAO_LI.todos,
      acao: ACAO_IMPORTACAO_LI.completar,
      categorias: CATEGORIAS_IMPORTACAO_LI.criarEVincular,
      fotos: FOTOS_IMPORTACAO_LI.soSemFotos,
    });
  });

  it('"Importar" with a narrower target sends both, and the button says it imports', () => {
    const { state } = renderDialogo();
    fireEvent.click(radio('Importar'));
    fireEvent.click(radio('Só os que ainda não estão no ERP'));
    expect(confirmar().textContent).toBe('Iniciar importação');
    fireEvent.click(confirmar());

    expect(corpoEnviado(state)).toEqual({
      ...OPCOES_IMPORTACAO_LI_PADRAO,
      modo: MODO_IMPORTACAO_LI.aplicar,
      alvo: ALVO_IMPORTACAO_LI.naoNoErp,
    });
  });

  it('⭐ the confirm is disabled while a start is in flight', () => {
    const { state } = renderDialogo(estado({ busy: true }));
    expect(confirmar().disabled).toBe(true);
    fireEvent.click(confirmar());
    expect(state.start).not.toHaveBeenCalled();
  });

  it('⭐ every open starts from the defaults again — an "Importar" picked before is gone', () => {
    const state = estado();
    const { rerender } = renderDialogo(state);
    fireEvent.click(radio('Importar'));
    fireEvent.click(radio('Completar'));
    expect(radio('Importar').checked).toBe(true);

    const reabrir = (opened: boolean) =>
      rerender(
        <MantineTestProvider>
          <DialogoImportacaoLi state={{ ...state, opened }} />
        </MantineTestProvider>,
      );
    reabrir(false);
    expect(screen.queryByRole('radio', { name: 'Importar' })).toBeNull();
    reabrir(true);

    expect(radio('Simular').checked).toBe(true);
    expect(radio('Só vincular').checked).toBe(true);
  });
});
