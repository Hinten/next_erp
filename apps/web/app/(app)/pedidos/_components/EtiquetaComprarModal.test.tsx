import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
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
