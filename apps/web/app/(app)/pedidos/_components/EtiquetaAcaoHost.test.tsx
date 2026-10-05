import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MantineTestProvider } from '@/lib/testing/mantine';

import type { PerguntaDeEnvio, RespostaDeEnvio } from '@/components/etiqueta/EscolherEnvioDialog';

import type { UseConfirmDialogResult } from './ConfirmDialog';

/**
 * A switch for the queue's failure branch: when set, the NEXT confirm the host
 * opens (its `perguntar`) REJECTS with it instead of opening. Neither real
 * dialog ever rejects today, so "one failed question cannot wedge every later
 * one" needs a question that does. Transparent while `null` — every other test
 * runs the real `useConfirmDialog`.
 */
const falha = vi.hoisted(() => ({ proximoConfirm: null as TypeError | null }));
vi.mock('./ConfirmDialog', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ConfirmDialog')>();
  // Keyed on the real (stable) `confirm`, so the wrapper is stable too.
  const embrulhados = new WeakMap<object, UseConfirmDialogResult['confirm']>();
  return {
    ...real,
    useConfirmDialog: (): UseConfirmDialogResult => {
      const r = real.useConfirmDialog();
      let confirm = embrulhados.get(r.confirm);
      if (confirm === undefined) {
        const abrir = r.confirm;
        confirm = (opts) => {
          const erro = falha.proximoConfirm;
          if (erro === null) return abrir(opts);
          falha.proximoConfirm = null;
          return Promise.reject(erro);
        };
        embrulhados.set(r.confirm, confirm);
      }
      return { ...r, confirm };
    },
  };
});

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
  const view = render(
    <MantineTestProvider>
      <Pagina onValor={(v) => (valor = v)} />
    </MantineTestProvider>,
  );
  return Object.assign(() => valor!, { view });
}

/** A pickup question for `pedidoRotulo`, one address + one slot (fixture ids). */
function perguntaPickup(pedidoRotulo: string | null): PerguntaDeEnvio {
  return {
    pedidoRotulo,
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
    permiteDropoff: true,
    escolhaInvalida: false,
  };
}

/** Records when (and with what) a promise settles, without awaiting it. */
function observar<T>(p: Promise<T>) {
  const estado: { respondida: boolean; valor: T | undefined } = {
    respondida: false,
    valor: undefined,
  };
  void p.then((v) => {
    estado.respondida = true;
    estado.valor = v;
  });
  return estado;
}

/** Let every pending microtask (the queue's `.then` hops) run. */
async function drenar() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
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

    // Another pedido still RUNS (batch printing) — only its QUESTIONS wait
    // behind p1's, in the FIFO pinned below (#1523 review 2, Q2-F1).
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
      resposta = host().escolherEnvio(perguntaPickup(null));
    });
    // The question opens one queue hop later (the FIFO below).
    expect(await screen.findByRole('button', { name: 'Confirmar' })).toBeTruthy();
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
    expect(await screen.findByRole('button', { name: 'Continuar' })).toBeTruthy();
    fireEvent.click(screen.getByText('desmontar'));
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await expect(resposta).resolves.toBe(true);
  });
});

/**
 * #1523 review 2, Q2-F1 (MAJOR): the in-flight guard is per pedido, so two
 * pedidos' flows run at once — but the page has ONE dialog of each kind, and a
 * new question used to answer the open one as cancelled. Pedido A then ended
 * `skipped` in silence while the operator answered B's question thinking it
 * was A's. The host now queues every question FIFO.
 */
describe('EtiquetaAcaoHost — as perguntas de dois pedidos entram numa FILA', () => {
  it('dois pedidos perguntam: nenhuma resposta é null, e a ordem é FIFO', async () => {
    const host = montar();
    let a!: ReturnType<typeof observar<RespostaDeEnvio>>;
    let b!: ReturnType<typeof observar<RespostaDeEnvio>>;
    act(() => {
      a = observar(host().escolherEnvio(perguntaPickup('1001')));
    });
    await drenar();
    act(() => {
      b = observar(host().escolherEnvio(perguntaPickup('1002')));
    });
    await drenar();

    // B's question did NOT cancel A's: A is still open, B waits (never shown).
    expect(a.respondida).toBe(false);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText('Pedido 1001 — Como enviar o pacote')).toBeTruthy();
    expect(screen.queryByText(/Pedido 1002/)).toBeNull();

    // A's answer goes to A — the drop-off, so it is distinguishable from B's.
    fireEvent.click(screen.getByRole('radio', { name: /dropoff/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    await drenar();
    expect(a.valor).toEqual({ modo: 'dropoff' });
    expect(b.respondida).toBe(false);

    // Then B's question opens, titled with B, and B's answer goes to B.
    expect(await screen.findByText('Pedido 1002 — Como enviar o pacote')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    await drenar();
    expect(b.valor).toEqual({ modo: 'pickup', enderecoId: '200001', horarioId: 'slot-1' });
    expect(a.valor).toEqual({ modo: 'dropoff' });
  });

  it('o confirm e a pergunta de envio partilham a MESMA fila (um diálogo por vez)', async () => {
    const host = montar();
    let confirmA!: ReturnType<typeof observar<boolean>>;
    let envioB!: ReturnType<typeof observar<RespostaDeEnvio>>;
    act(() => {
      confirmA = observar(
        host().confirm({
          title: 'Atenção',
          message: 'Frete já postado.',
          confirmLabel: 'Continuar',
          cancelLabel: 'Cancelar',
        }),
      );
    });
    await drenar();
    act(() => {
      envioB = observar(host().escolherEnvio(perguntaPickup('1002')));
    });
    await drenar();
    expect(screen.getByText('Frete já postado.')).toBeTruthy();
    expect(screen.queryByText(/Pedido 1002/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    await drenar();
    expect(confirmA.valor).toBe(true);
    expect(await screen.findByText('Pedido 1002 — Como enviar o pacote')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    await drenar();
    expect(envioB.valor).toEqual({ modo: 'pickup', enderecoId: '200001', horarioId: 'slot-1' });
  });

  it('a página sair com perguntas na fila responde TODAS como canceladas (nada fica pendurado)', async () => {
    const host = montar();
    let confirmA!: ReturnType<typeof observar<boolean>>;
    let envioB!: ReturnType<typeof observar<RespostaDeEnvio>>;
    act(() => {
      confirmA = observar(host().confirm({ title: 'Atenção', message: 'Frete já postado.' }));
      envioB = observar(host().escolherEnvio(perguntaPickup('1002')));
    });
    await drenar();
    // The confirm dialog itself never settles on unmount — the host must.
    host.view.unmount();
    await drenar();
    expect(confirmA).toEqual({ respondida: true, valor: false });
    expect(envioB).toEqual({ respondida: true, valor: null });
  });
});

/**
 * The queue's two defensive edges (#1523 review 2 mutation pass, H3/H5): a
 * flow still running when the page leaves keeps asking (its provider loop asks
 * its NEXT question), and a question that fails must not take the queue down.
 */
describe('EtiquetaAcaoHost — as bordas da fila', () => {
  beforeEach(() => {
    falha.proximoConfirm = null;
  });

  it('H3: uma pergunta feita DEPOIS de a página sair responde cancelada na hora (nada fica pendurado)', async () => {
    const host = montar();
    const valor = host();
    host.view.unmount();
    // The flow outlived the page and asks again — onto dialogs that are gone.
    const confirmTarde = observar(
      valor.confirm({ title: 'Atenção', message: 'Frete já postado.' }),
    );
    const envioTarde = observar(valor.escolherEnvio(perguntaPickup('1003')));
    await drenar();
    expect(confirmTarde).toEqual({ respondida: true, valor: false });
    expect(envioTarde).toEqual({ respondida: true, valor: null });
  });

  it('H5: uma pergunta que FALHA não trava a fila — quem perguntou vê a falha, e a próxima ainda abre', async () => {
    const host = montar();
    const erro = new TypeError('o diálogo falhou');
    falha.proximoConfirm = erro;
    let confirmA!: Promise<boolean>;
    let envioB!: ReturnType<typeof observar<RespostaDeEnvio>>;
    act(() => {
      confirmA = host().confirm({ title: 'Atenção', message: 'Frete já postado.' });
      envioB = observar(host().escolherEnvio(perguntaPickup('1002')));
    });
    // The caller of the failed question still sees ITS rejection, verbatim…
    await expect(confirmA).rejects.toBe(erro);
    // …and the question queued behind it opens, and answers, as if nothing failed.
    expect(await screen.findByText('Pedido 1002 — Como enviar o pacote')).toBeTruthy();
    expect(envioB.respondida).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    await drenar();
    expect(envioB.valor).toEqual({ modo: 'pickup', enderecoId: '200001', horarioId: 'slot-1' });
  });
});
