import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MantineTestProvider } from '@/lib/testing/mantine';

import type { RespostaDeEnvio } from '@/components/etiqueta/EscolherEnvioDialog';

import {
  EtiquetaAcaoHost,
  useEtiquetaAcao,
  type EtiquetaAcaoContextValue,
} from './EtiquetaAcaoHost';

/** A deferred promise, so a test decides when an in-flight action settles. */
function adiado() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Captures the host value and renders `emAndamento` for two pedidos. */
function Consumidor({ onValor }: { onValor: (v: EtiquetaAcaoContextValue | null) => void }) {
  const v = useEtiquetaAcao();
  onValor(v);
  return (
    <>
      <span data-testid="p1">{v?.emAndamento('p1') ?? 'livre'}</span>
      <span data-testid="p2">{v?.emAndamento('p2') ?? 'livre'}</span>
    </>
  );
}

/** A host with a child that can be unmounted — the HoverCard's dropdown. */
function Pagina({ onValor }: { onValor: (v: EtiquetaAcaoContextValue | null) => void }) {
  const [montado, setMontado] = useState(true);
  return (
    <EtiquetaAcaoHost>
      <button onClick={() => setMontado(false)}>desmontar</button>
      {montado && <Consumidor onValor={onValor} />}
    </EtiquetaAcaoHost>
  );
}

function montar() {
  let valor: EtiquetaAcaoContextValue | null = null;
  render(
    <MantineTestProvider>
      <Pagina onValor={(v) => (valor = v)} />
    </MantineTestProvider>,
  );
  return () => valor!;
}

describe('EtiquetaAcaoHost — o dono das ações de etiqueta da página', () => {
  it('fora de um host, useEtiquetaAcao é null', () => {
    let valor: EtiquetaAcaoContextValue | null | undefined;
    render(<Consumidor onValor={(v) => (valor = v)} />);
    expect(valor).toBeNull();
  });

  it('executar marca o pedido em andamento com a chave, e limpa quando termina', async () => {
    const host = montar();
    const d = adiado();
    let corrida!: Promise<void>;
    act(() => {
      corrida = host().executar('p1', 'fetch-zpl2', () => d.promise);
    });
    expect(screen.getByTestId('p1').textContent).toBe('fetch-zpl2');
    // Near-miss: another pedido is not in flight.
    expect(screen.getByTestId('p2').textContent).toBe('livre');
    await act(async () => {
      d.resolve();
      await corrida;
    });
    expect(screen.getByTestId('p1').textContent).toBe('livre');
  });

  it('recusa uma segunda execução do MESMO pedido em andamento; outro pedido corre', async () => {
    const host = montar();
    const d = adiado();
    let chamadas = 0;
    act(() => {
      void host().executar('p1', 'fetch-zpl2', () => d.promise);
    });
    // Same tick, same pedido: refused before `fn` runs (the ref guard).
    await act(async () => {
      await host().executar('p1', 'fetch-pdf', async () => {
        chamadas += 1;
      });
    });
    expect(chamadas).toBe(0);
    expect(screen.getByTestId('p1').textContent).toBe('fetch-zpl2');

    await act(async () => {
      await host().executar('p2', 'fetch-pdf', async () => {
        chamadas += 1;
      });
    });
    expect(chamadas).toBe(1);
    await act(async () => {
      d.resolve();
      await d.promise;
    });
  });

  it('duas execuções no mesmo tick (antes de um render) — só a primeira roda', async () => {
    const host = montar();
    let chamadas = 0;
    const fn = async () => {
      chamadas += 1;
    };
    await act(async () => {
      const v = host();
      await Promise.all([v.executar('p1', 'fetch-zpl2', fn), v.executar('p1', 'fetch-zpl2', fn)]);
    });
    expect(chamadas).toBe(1);
  });

  it('uma falha propaga e ainda assim limpa o pedido (e ele pode rodar de novo)', async () => {
    const host = montar();
    const d = adiado();
    let corrida!: Promise<void>;
    act(() => {
      corrida = host().executar('p1', 'generico-pdf', () => d.promise);
    });
    const erro = new TypeError('bug');
    await act(async () => {
      d.reject(erro);
      await expect(corrida).rejects.toBe(erro);
    });
    expect(screen.getByTestId('p1').textContent).toBe('livre');
    let rodou = false;
    await act(async () => {
      await host().executar('p1', 'generico-pdf', async () => {
        rodou = true;
      });
    });
    expect(rodou).toBe(true);
  });

  it('o estado em andamento sobrevive ao desmontar do consumidor (o HoverCard fechando)', async () => {
    const host = montar();
    const d = adiado();
    act(() => {
      void host().executar('p1', 'fetch-zpl2', () => d.promise);
    });
    fireEvent.click(screen.getByText('desmontar'));
    expect(screen.queryByTestId('p1')).toBeNull();
    // The host still knows — a re-hovered row would read it back.
    expect(host().emAndamento('p1')).toBe('fetch-zpl2');
    await act(async () => {
      d.resolve();
      await d.promise;
    });
  });

  it('a pergunta de envio sobrevive ao desmontar de quem perguntou, e é respondida pelo mouse', async () => {
    const host = montar();
    let resposta!: Promise<RespostaDeEnvio>;
    act(() => {
      resposta = host().escolherEnvio({
        pacoteRotulo: null,
        mensagem: 'Escolha como enviar o pacote.',
        enderecos: [
          {
            id: '200001',
            rotulo: 'Rua A, 10',
            principal: true,
            horarios: [{ id: 'slot-1', rotulo: 'Amanhã 08:00–12:00', recomendado: true }],
          },
        ],
        permiteDropoff: false,
        escolhaInvalida: false,
      });
    });
    // The asker (the row inside the HoverCard) goes away…
    fireEvent.click(screen.getByText('desmontar'));
    // …and the dialog is still there, because the HOST renders it.
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    await expect(resposta).resolves.toEqual({
      modo: 'pickup',
      enderecoId: '200001',
      horarioId: 'slot-1',
    });
  });

  it('o confirm também é do host — sobrevive ao desmontar e responde', async () => {
    const host = montar();
    let resposta!: Promise<boolean>;
    act(() => {
      resposta = host().confirm({
        title: 'Atenção',
        message: 'Frete já postado.',
        confirmLabel: 'Continuar',
        cancelLabel: 'Cancelar',
      });
    });
    fireEvent.click(screen.getByText('desmontar'));
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await expect(resposta).resolves.toBe(true);
  });
});
