import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  FreightCompraEmAndamentoError,
  FreightEtiquetaDesvinculadaError,
  FreightServerError,
  FreightTimeoutError,
} from '@delfrance/integrations-freight-br/http-client';

import { MantineTestProvider } from '@/lib/testing/mantine';

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
