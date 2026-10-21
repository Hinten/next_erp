import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CODIGO_ERRO_LI, type RespostaConferenciaPagamentoLi } from '@delfrance/schemas';

import {
  FreightCompraEmAndamentoError,
  FreightEtiquetaDesvinculadaError,
  FreightServerError,
  FreightTimeoutError,
} from '@delfrance/integrations-freight-br/http-client';

import { LojaIntegradaClientHttpError } from '@/lib/loja-integrada/client';
import type { ConferenciaLiCarregada } from '@/lib/loja-integrada/conferenciaPagamento';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';

// This suite is about what a failed BUY does to the modal (#1094). The cart is
// resolved without a sender location, so no agency lookup runs, and the saldo
// query answers at once.
vi.mock('@/lib/firebase/client', () => ({ getFirebaseFirestore: () => ({}) }));
const { comprar, showErrorNotification, showCopyableNotification } = vi.hoisted(() => ({
  comprar: vi.fn(),
  showErrorNotification: vi.fn(),
  showCopyableNotification: vi.fn(),
}));
vi.mock('@/lib/freight/client', () => ({
  useFreightClient: () => ({
    comprar,
    conta: () => Promise.resolve({ balance: { balance: 500 } }),
    agencias: () => Promise.resolve({ agencies: [] }),
  }),
}));
vi.mock('./etiquetaActions', () => ({
  resolveEtiquetaCartInput: () =>
    Promise.resolve({
      ok: true,
      intFreteId: 'INT-1',
      payload: { service: 3 },
      remetente: { estado: null, cidade: null },
    }),
}));
vi.mock('@/lib/notifications/showErrorNotification', () => ({
  showErrorNotification,
  showCopyableNotification,
}));
// The Loja Integrada paid re-check (step 15) asks this client; `null` unless a
// test hands one. The error classes stay real: the gate narrows on them.
const li = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/loja-integrada/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/loja-integrada/client')>()),
  useLojaIntegradaClient: () => li.client,
}));

import { EtiquetaComprarModal } from './EtiquetaComprarModal';

function renderModal() {
  const onClose = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MantineTestProvider>
        <EtiquetaComprarModal
          opened
          onClose={onClose}
          pedido={{ numero: 42, freteInicial: null } as never}
          pedidoId="PED-1"
          intFreteId="INT-1"
          needsPostedConfirm={false}
        />
      </MantineTestProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

async function comprarEtiqueta() {
  const botao = await screen.findByRole('button', { name: 'Comprar etiqueta' });
  await waitFor(() => expect(botao).not.toHaveProperty('disabled', true));
  fireEvent.click(botao);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('EtiquetaComprarModal — a failed buy (#1094)', () => {
  it('a TIMEOUT closes the modal with a yellow check-first notice — no Comprar left to re-click', async () => {
    const timeout = new FreightTimeoutError(
      'O Melhor Envio não respondeu a tempo — a compra pode ainda estar em andamento.',
      { origem: 'prazo', timeoutMs: 360_000, operacao: 'comprar' },
    );
    comprar.mockRejectedValue(timeout);
    const { onClose } = renderModal();
    await comprarEtiqueta();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(showCopyableNotification).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'yellow', message: timeout.message }),
    );
    expect(showErrorNotification).not.toHaveBeenCalled();
    expect(comprar).toHaveBeenCalledTimes(1);
  });

  it('the platform giving up (origem gateway) is the same timeout', async () => {
    comprar.mockRejectedValue(
      new FreightTimeoutError('O servidor desistiu da requisição.', {
        origem: 'gateway',
        timeoutMs: null,
        operacao: 'comprar',
      }),
    );
    const { onClose } = renderModal();
    await comprarEtiqueta();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(showErrorNotification).not.toHaveBeenCalled();
  });

  it('the route saying MELHOR ENVIO stopped answering a paid step (origem provedor) is the same timeout', async () => {
    comprar.mockRejectedValue(
      new FreightTimeoutError('O Melhor Envio não respondeu em 60 s ao pagar a etiqueta…', {
        origem: 'provedor',
        timeoutMs: 60_000,
        operacao: 'comprar',
      }),
    );
    const { onClose } = renderModal();
    await comprarEtiqueta();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(showCopyableNotification).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'yellow', title: 'Tempo esgotado ao comprar etiqueta' }),
    );
    expect(showErrorNotification).not.toHaveBeenCalled();
  });

  it('another buy of this pedido in progress (423, #1677) closes with a yellow notice — no re-click', async () => {
    const emAndamento = new FreightCompraEmAndamentoError(
      'Outra compra de etiqueta para este pedido está em andamento… Aguarde cerca de 5 min.',
      1_780_000_360_000,
      null,
    );
    comprar.mockRejectedValue(emAndamento);
    const { onClose } = renderModal();
    await comprarEtiqueta();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(showCopyableNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'yellow',
        title: 'Compra de etiqueta em andamento',
        message: emAndamento.message,
      }),
    );
    expect(showErrorNotification).not.toHaveBeenCalled();
    expect(comprar).toHaveBeenCalledTimes(1);
  });

  it('a label PAID but not linked to the pedido (#1677) closes with a long red notice naming it', async () => {
    const desvinculada = new FreightEtiquetaDesvinculadaError(
      'A etiqueta L1 foi comprada e PAGA no Melhor Envio, mas…',
      { printLabelId: 'L1', printUrl: 'https://sandbox.melhorenvio.com.br/imprimir/L1' },
      null,
    );
    comprar.mockRejectedValue(desvinculada);
    const { onClose } = renderModal();
    await comprarEtiqueta();

    // The modal MUST close: the pedido carries no anchor any more, so one more
    // click on "Comprar" would start a fresh buy and pay a second label.
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(showCopyableNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'red',
        title: 'Etiqueta paga, mas não vinculada ao pedido',
        message: desvinculada.message,
        autoClose: false,
      }),
    );
    expect(showErrorNotification).not.toHaveBeenCalled();
    expect(comprar).toHaveBeenCalledTimes(1);
  });

  it('the frete changed before checkout (any other 412) closes too — this cart was built from the OLD frete', async () => {
    const freteMudou = new FreightServerError(
      'O frete do pedido mudou durante a compra… Nada foi pago nesta tentativa.',
      412,
      { code: 'ME_FRETE_ALTERADO' },
    );
    comprar.mockRejectedValue(freteMudou);
    const { onClose } = renderModal();
    await comprarEtiqueta();

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(showCopyableNotification).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'yellow', title: 'O frete do pedido mudou' }),
    );
    expect(showErrorNotification).not.toHaveBeenCalled();
    expect(comprar).toHaveBeenCalledTimes(1);
  });

  it('near-miss: any other failure stays a red "Falha" and the modal stays open to retry', async () => {
    comprar.mockRejectedValue(new FreightServerError('Erro no Melhor Envio', 500, null));
    const { onClose } = renderModal();
    await comprarEtiqueta();

    await waitFor(() =>
      expect(showErrorNotification).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Falha ao comprar etiqueta' }),
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(showCopyableNotification).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Comprar etiqueta' })).toBeTruthy();
  });
});

/**
 * The buy's hard gate of the Loja Integrada paid re-check (master plan step 15): right
 * before Melhor Envio money is spent, an imported Loja Integrada order's
 * CURRENT payment is asked of the backend — once per Comprar click — unless the
 * checkout chain carries a `pago` received under 120 s ago.
 */
describe('EtiquetaComprarModal — the Loja Integrada paid re-check before the buy', () => {
  const ID_LI = createHash('sha256').update('lojaIntegradaCONTA1-165').digest('hex');
  const PEDIDO_LI = {
    numero: '165',
    integracaoPedidoOuterRef: 'documents/integracao/CONTA1',
    freteInicial: null,
  };
  const PAGO: RespostaConferenciaPagamentoLi = {
    aplicavel: true,
    fonte: 'loja',
    veredito: 'pago',
    codigo: 'pedido_pago',
    motivoContestacao: null,
    conferidoEmMs: 1_790_000_000_000,
    correlationId: null,
  };
  const NAO_PAGO: RespostaConferenciaPagamentoLi = {
    ...PAGO,
    veredito: 'nao-pago',
    codigo: 'aguardando_pagamento',
  };
  const conferir = vi.fn();

  beforeEach(() => {
    conferir.mockReset();
    li.client = lojaIntegradaClientFalso({ conferirPagamento: conferir });
    comprar.mockResolvedValue({ printUrl: 'https://example.invalid/l.pdf', tracking: null });
  });
  afterEach(() => {
    li.client = null;
    vi.restoreAllMocks();
  });

  function renderLi(
    props: Partial<{
      pedido: unknown;
      pedidoId: string;
      conferenciaLi: ConferenciaLiCarregada;
      gateConferenciaLi: 'comprar' | 'cadeia';
    }> = {},
  ) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MantineTestProvider>
          <EtiquetaComprarModal
            opened
            onClose={vi.fn()}
            pedido={(props.pedido ?? PEDIDO_LI) as never}
            pedidoId={props.pedidoId ?? ID_LI}
            intFreteId="INT-1"
            needsPostedConfirm={false}
            {...(props.conferenciaLi === undefined ? {} : { conferenciaLi: props.conferenciaLi })}
            {...(props.gateConferenciaLi === undefined
              ? {}
              : { gateConferenciaLi: props.gateConferenciaLi })}
          />
        </MantineTestProvider>
      </QueryClientProvider>,
    );
  }

  it('a `pago` buys — ONE check, for this pedido, before `comprar`', async () => {
    conferir.mockResolvedValue(PAGO);
    renderLi();
    await comprarEtiqueta();

    await waitFor(() => expect(comprar).toHaveBeenCalledTimes(1));
    expect(conferir).toHaveBeenCalledTimes(1);
    expect(conferir.mock.calls[0]![0]).toBe(ID_LI);
    expect(conferir.mock.invocationCallOrder[0]!).toBeLessThan(
      comprar.mock.invocationCallOrder[0]!,
    );
  });

  it('`nao-pago` BLOCKS: nothing is bought, and the modal says the buy was blocked', async () => {
    conferir.mockResolvedValue(NAO_PAGO);
    renderLi();
    await comprarEtiqueta();

    expect(
      await screen.findByText(/não como pago\. A compra da etiqueta foi bloqueada\.$/),
    ).toBeTruthy();
    expect(comprar).not.toHaveBeenCalled();
  });

  it('inside the checkout chain the block also says the checkout and the NF-e are already saved', async () => {
    conferir.mockResolvedValue(NAO_PAGO);
    renderLi({ gateConferenciaLi: 'cadeia' });
    await comprarEtiqueta();

    expect(await screen.findByText(/o checkout e a NF-e já foram salvos\.$/)).toBeTruthy();
    expect(comprar).not.toHaveBeenCalled();
  });

  it('every Comprar click asks again — a block is never remembered as a verdict', async () => {
    conferir.mockResolvedValueOnce(NAO_PAGO).mockResolvedValueOnce(PAGO);
    renderLi();
    await comprarEtiqueta();
    await screen.findByText(/A compra da etiqueta foi bloqueada\.$/);
    await comprarEtiqueta();

    await waitFor(() => expect(comprar).toHaveBeenCalledTimes(1));
    expect(conferir).toHaveBeenCalledTimes(2);
  });

  it('the read switch OFF asks the SAME confirm as the checkout; only "Continuar mesmo assim" buys — with no second check', async () => {
    conferir.mockRejectedValue(
      new LojaIntegradaClientHttpError('desligada', 503, CODIGO_ERRO_LI.chamadasDesligadas),
    );
    renderLi();
    await comprarEtiqueta();

    expect(
      await screen.findByText(
        'A conferência de pagamento na Loja Integrada não está disponível (a chave de chamadas ' +
          'está desligada): é configuração da conta, não instabilidade. Deseja continuar mesmo ' +
          'assim?',
      ),
    ).toBeTruthy();
    expect(comprar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar mesmo assim' }));

    await waitFor(() => expect(comprar).toHaveBeenCalledTimes(1));
    expect(conferir).toHaveBeenCalledTimes(1);
  });

  it('⭐ a backend without the payment route (404, no envelope) asks instead of crashing or buying', async () => {
    conferir.mockRejectedValue(new LojaIntegradaClientHttpError('sem rota', 404, null));
    renderLi();
    await comprarEtiqueta();

    expect(
      await screen.findByText(/o backend da Loja Integrada ainda não oferece esta conferência/),
    ).toBeTruthy();
    expect(comprar).not.toHaveBeenCalled();
  });

  it('while the check runs, Comprar is disabled and says so', async () => {
    let responder: (r: RespostaConferenciaPagamentoLi) => void = () => undefined;
    conferir.mockReturnValue(
      new Promise<RespostaConferenciaPagamentoLi>((resolve) => {
        responder = resolve;
      }),
    );
    renderLi();
    await comprarEtiqueta();

    const botao = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Conferindo pagamento…',
    });
    expect(botao.disabled).toBe(true);
    // A second click while it runs asks nothing more.
    fireEvent.click(botao);
    responder(PAGO);
    await waitFor(() => expect(comprar).toHaveBeenCalledTimes(1));
    expect(conferir).toHaveBeenCalledTimes(1);
  });

  it('a carried `pago` received 119 s ago spares the check', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(1_000 + 119_000);
    renderLi({
      conferenciaLi: { tipo: 'resposta', pedidoId: ID_LI, resposta: PAGO, recebidoEm: 1_000 },
      gateConferenciaLi: 'cadeia',
    });
    await comprarEtiqueta();

    await waitFor(() => expect(comprar).toHaveBeenCalledTimes(1));
    expect(conferir).not.toHaveBeenCalled();
  });

  it('⚠️ NEAR-MISS: at 121 s the carried `pago` is stale — the buy asks again', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(1_000 + 121_000);
    conferir.mockResolvedValue(NAO_PAGO);
    renderLi({
      conferenciaLi: { tipo: 'resposta', pedidoId: ID_LI, resposta: PAGO, recebidoEm: 1_000 },
      gateConferenciaLi: 'cadeia',
    });
    await comprarEtiqueta();

    await screen.findByText(/A compra da etiqueta foi bloqueada/);
    expect(conferir).toHaveBeenCalledTimes(1);
    expect(comprar).not.toHaveBeenCalled();
  });

  it('⚠️ NEAR-MISS: a Mercado Livre order or a manual pedido buys with no check at all', async () => {
    conferir.mockResolvedValue(NAO_PAGO);
    renderLi({ pedidoId: createHash('sha256').update('mercadoLivreCONTA1-165').digest('hex') });
    await comprarEtiqueta();

    await waitFor(() => expect(comprar).toHaveBeenCalledTimes(1));
    expect(conferir).not.toHaveBeenCalled();
  });
});
