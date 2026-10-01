import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';

import {
  ROTULO_DROPOFF,
  ROTULO_SEM_HORARIO,
  useEscolherEnvio,
  type PerguntaDeEnvio,
  type RespostaDeEnvio,
} from './EscolherEnvioDialog';

// Fixture ids only (address/slot ids are opaque strings on the wire).
const PRINCIPAL = {
  id: '200001',
  rotulo: 'Rua A, 10 — Cidade A',
  principal: true,
  horarios: [
    { id: 'slot-1', rotulo: 'Amanhã 08:00–12:00', recomendado: false },
    { id: 'slot-2', rotulo: 'Amanhã 13:00–18:00', recomendado: true },
  ],
};
const SECUNDARIO = {
  id: '200002',
  rotulo: 'Rua B, 20 — Cidade B',
  principal: false,
  horarios: [
    { id: 'slot-3', rotulo: 'Sexta 08:00–12:00', recomendado: false },
    { id: 'slot-4', rotulo: 'Sexta 13:00–18:00', recomendado: false },
  ],
};
const SEM_SLOT = { id: '200003', rotulo: 'Rua C, 30 — Cidade C', principal: false, horarios: [] };

function pergunta(over: Partial<PerguntaDeEnvio> = {}): PerguntaDeEnvio {
  return {
    pedidoRotulo: null,
    pacoteRotulo: null,
    mensagem: 'Escolha como enviar o pacote.',
    enderecos: [PRINCIPAL, SECUNDARIO],
    permiteDropoff: false,
    escolhaInvalida: false,
    ...over,
  };
}

/** Render the hook's element and open one question; returns the pending answer. */
function abrir(p: PerguntaDeEnvio) {
  let api: ReturnType<typeof useEscolherEnvio> | null = null;
  function Host() {
    api = useEscolherEnvio();
    return <>{api.element}</>;
  }
  const view = render(
    <MantineTestProvider>
      <Host />
    </MantineTestProvider>,
  );
  let resposta!: Promise<RespostaDeEnvio>;
  act(() => {
    resposta = api!.escolherEnvio(p);
  });
  return { resposta, view, api: () => api! };
}

function confirmar() {
  return screen.getByRole('button', { name: 'Confirmar' }) as HTMLButtonElement;
}

describe('EscolherEnvioDialog — a pergunta de envio da Shopee', () => {
  it('pré-seleciona o endereço principal e o horário recomendado', async () => {
    const { resposta } = abrir(pergunta());
    expect((screen.getByRole('radio', { name: /Rua A/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /13:00–18:00/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    // Near-miss: the other slot of the SAME address is not the pre-selected one.
    expect((screen.getByRole('radio', { name: /08:00–12:00/ }) as HTMLInputElement).checked).toBe(
      false,
    );
    fireEvent.click(confirmar());
    // The exact shape — no `pacote`, no extra key: the provider adds the package.
    await expect(resposta).resolves.toEqual({
      modo: 'pickup',
      enderecoId: '200001',
      horarioId: 'slot-2',
    });
  });

  it('sem principal nem opção única, nada é pré-selecionado e Confirmar fica desligado', () => {
    abrir(pergunta({ enderecos: [SECUNDARIO, { ...PRINCIPAL, principal: false }] }));
    expect(screen.queryByRole('radio', { checked: true })).toBeNull();
    expect(confirmar().disabled).toBe(true);
  });

  it('trocar de endereço re-deriva o horário (nunca herda o id do outro endereço)', async () => {
    const { resposta } = abrir(pergunta());
    fireEvent.click(screen.getByRole('radio', { name: /Rua B/ }));
    // SECUNDARIO has two slots and no `recomendado` — no guess, Confirmar is off.
    expect(screen.queryByRole('radio', { name: /Amanhã/ })).toBeNull();
    expect(confirmar().disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Sexta 13:00/ }));
    expect(confirmar().disabled).toBe(false);
    fireEvent.click(confirmar());
    await expect(resposta).resolves.toEqual({
      modo: 'pickup',
      enderecoId: '200002',
      horarioId: 'slot-4',
    });
  });

  it('trocar para um endereço com horário recomendado pré-seleciona O DELE', () => {
    const terceiro = {
      id: '200004',
      rotulo: 'Rua D, 40 — Cidade D',
      principal: false,
      horarios: [
        { id: 'slot-5', rotulo: 'Sábado 08:00–12:00', recomendado: false },
        { id: 'slot-6', rotulo: 'Sábado 13:00–18:00', recomendado: true },
      ],
    };
    abrir(pergunta({ enderecos: [PRINCIPAL, terceiro] }));
    fireEvent.click(screen.getByRole('radio', { name: /Rua D/ }));
    expect(
      (screen.getByRole('radio', { name: /Sábado 13:00–18:00/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(confirmar().disabled).toBe(false);
  });

  it('um endereço sem horário oferece "Sem horário — a Shopee agenda" e responde horarioId null', async () => {
    const { resposta } = abrir(pergunta({ enderecos: [PRINCIPAL, SEM_SLOT] }));
    // Near-miss: the principal address (with slots) shows no such option.
    expect(screen.queryByRole('radio', { name: ROTULO_SEM_HORARIO })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Rua C/ }));
    expect(
      (screen.getByRole('radio', { name: ROTULO_SEM_HORARIO }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(confirmar());
    await expect(resposta).resolves.toEqual({
      modo: 'pickup',
      enderecoId: '200003',
      horarioId: null,
    });
  });

  it('"Levar à agência (dropoff)" aparece só com permiteDropoff, e responde { modo: dropoff }', async () => {
    const semDropoff = abrir(pergunta());
    expect(screen.queryByRole('radio', { name: ROTULO_DROPOFF })).toBeNull();
    semDropoff.view.unmount();

    const { resposta } = abrir(pergunta({ permiteDropoff: true }));
    fireEvent.click(screen.getByRole('radio', { name: ROTULO_DROPOFF }));
    // No slot group for the drop-off.
    expect(screen.queryByRole('radio', { name: /13:00–18:00/ })).toBeNull();
    fireEvent.click(confirmar());
    await expect(resposta).resolves.toEqual({ modo: 'dropoff' });
  });

  it('sem endereço, o dropoff é a única opção e vem pré-selecionado', async () => {
    const { resposta } = abrir(pergunta({ enderecos: [], permiteDropoff: true }));
    expect((screen.getByRole('radio', { name: ROTULO_DROPOFF }) as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(confirmar());
    await expect(resposta).resolves.toEqual({ modo: 'dropoff' });
  });

  it('um único endereço não principal SEM dropoff é pré-selecionado; com dropoff, não', () => {
    const unico = abrir(pergunta({ enderecos: [SECUNDARIO] }));
    expect((screen.getByRole('radio', { name: /Rua B/ }) as HTMLInputElement).checked).toBe(true);
    unico.view.unmount();

    abrir(pergunta({ enderecos: [SECUNDARIO], permiteDropoff: true }));
    expect(screen.queryByRole('radio', { checked: true })).toBeNull();
  });

  it('escolhaInvalida mostra o aviso; sem ela, não', () => {
    const invalida = abrir(pergunta({ escolhaInvalida: true }));
    expect(screen.getByText('A escolha anterior não vale mais')).toBeTruthy();
    invalida.view.unmount();

    abrir(pergunta({ escolhaInvalida: false }));
    expect(screen.queryByText('A escolha anterior não vale mais')).toBeNull();
    expect(screen.getByText('Escolha como enviar o pacote.')).toBeTruthy();
  });

  it('pacoteRotulo vai no título', () => {
    const comRotulo = abrir(pergunta({ pacoteRotulo: 'Pacote 2 de 3' }));
    expect(screen.getByText('Como enviar — Pacote 2 de 3')).toBeTruthy();
    comRotulo.view.unmount();

    abrir(pergunta({ pacoteRotulo: null }));
    expect(screen.getByText('Como enviar o pacote')).toBeTruthy();
    expect(screen.queryByText(/Pacote 2 de 3/)).toBeNull();
  });

  it('Q2-F3: o título nomeia o PEDIDO (com e sem pacote); sem número, o título fica como era', () => {
    const soPedido = abrir(pergunta({ pedidoRotulo: '1234' }));
    expect(screen.getByText('Pedido 1234 — Como enviar o pacote')).toBeTruthy();
    soPedido.view.unmount();

    const comPacote = abrir(pergunta({ pedidoRotulo: '1234', pacoteRotulo: 'Pacote 2 de 3' }));
    expect(screen.getByText('Pedido 1234 — Como enviar — Pacote 2 de 3')).toBeTruthy();
    comPacote.view.unmount();

    // Near-miss: a blank número is no número — never "Pedido  — …".
    abrir(pergunta({ pedidoRotulo: '  ' }));
    expect(screen.getByText('Como enviar o pacote')).toBeTruthy();
    expect(screen.queryByText(/Pedido/)).toBeNull();
  });

  it('Cancelar responde null e fecha', async () => {
    const { resposta } = abrir(pergunta());
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await expect(resposta).resolves.toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
  });

  it('fecha SÓ pelos botões — Esc não fecha nem responde', async () => {
    const { resposta } = abrir(pergunta());
    let respondida = false;
    void resposta.then(() => {
      respondida = true;
    });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(respondida).toBe(false);
    expect(screen.getByRole('button', { name: 'Confirmar' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
  });

  it('fecha SÓ pelos botões — um clique FORA (no overlay) não fecha nem responde', async () => {
    const { resposta } = abrir(pergunta());
    let respondida = false;
    void resposta.then(() => {
      respondida = true;
    });
    // The backdrop Mantine closes on by default (`closeOnClickOutside`): a stray
    // click there would silently cancel the label the operator is waiting on.
    const overlay = document.querySelector('.mantine-Modal-overlay');
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay!);
    await act(async () => {
      await Promise.resolve();
    });
    expect(respondida).toBe(false);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirmar' })).toBeTruthy();
  });

  // The hook's OWN last resort, kept on purpose (#1523 review 2, Q2-F1): a view
  // whose flows can overlap must serialise its questions BEFORE this hook, and
  // `/pedidos` does (`EtiquetaAcaoHost`'s FIFO, pinned in its own test) — so
  // this path is no longer reachable there. The single-flow screens (checkout,
  // reprint) ask one question at a time, and a dangling one must never hang.
  it('uma segunda pergunta com a primeira pendente responde a primeira como null (último recurso)', async () => {
    const { resposta, api } = abrir(pergunta());
    let segunda!: Promise<RespostaDeEnvio>;
    act(() => {
      segunda = api().escolherEnvio(pergunta({ enderecos: [SEM_SLOT] }));
    });
    await expect(resposta).resolves.toBeNull();
    // The form re-initialised from the SECOND question (its only address).
    expect((screen.getByRole('radio', { name: /Rua C/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(confirmar());
    await expect(segunda).resolves.toEqual({
      modo: 'pickup',
      enderecoId: '200003',
      horarioId: null,
    });
  });

  it('o dono desmontar com a pergunta aberta responde null (nada fica pendurado)', async () => {
    const { resposta, view } = abrir(pergunta());
    view.unmount();
    await expect(resposta).resolves.toBeNull();
  });

  it('escolherEnvio é estável entre renders (as telas o põem em deps de useMemo)', () => {
    const { result, rerender } = renderHook(() => useEscolherEnvio(), {
      wrapper: MantineTestProvider,
    });
    const primeira = result.current.escolherEnvio;
    rerender();
    expect(result.current.escolherEnvio).toBe(primeira);
  });
});
