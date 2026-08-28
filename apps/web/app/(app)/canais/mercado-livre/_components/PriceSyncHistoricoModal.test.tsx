import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { ContaRef } from './startJobsForContas';

const h = vi.hoisted(() => ({
  clientRef: { current: null as null | Record<string, unknown> },
}));

vi.mock('@/lib/mercado-livre/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/mercado-livre/client')>();
  return { ...actual, useMercadoLivreClient: () => h.clientRef.current };
});

const { PriceSyncHistoricoModal } = await import('./PriceSyncHistoricoModal');

const CONTA: ContaRef = { id: 'a', nome: 'Conta A' };

/** A COMPLETED run — the population `jobs-em-andamento` can never return. */
const CONCLUIDO = {
  jobId: 'env-1',
  integracaoId: 'a',
  status: 'completed' as const,
  baixarPreco: false,
  planejados: 40,
  enviados: 12,
  pulados: 20,
  naoEnumerados: 0,
  falhas: 1,
  pausas: 0,
  skips: [{ itemId: 'MLB9', produtoId: 'p1', code: 'PRECO_ANTIGO_IGUAL' }],
  failures: [{ itemId: 'MLB8', produtoId: 'p2', code: 'UPDATE_PRECO_ERROR', error: 'boom' }],
  startedAt: Date.UTC(2026, 7, 20, 15, 30),
  updatedAt: Date.UTC(2026, 7, 20, 15, 45),
  finishedAt: Date.UTC(2026, 7, 20, 15, 45),
  erro: null,
};

function setClient(envios: unknown[] = [CONCLUIDO]) {
  const priceSyncHistorico = vi.fn(async () => ({ envios }));
  h.clientRef.current = { priceSyncHistorico };
  return priceSyncHistorico;
}

function renderModal(opened = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
  );
  return render(<PriceSyncHistoricoModal conta={CONTA} opened={opened} onClose={vi.fn()} />, {
    wrapper,
  });
}

beforeEach(() => {
  setClient();
});

describe('PriceSyncHistoricoModal', () => {
  it('lists a FINISHED run — the one the running-only lookup can never surface', async () => {
    renderModal();

    expect(await screen.findByText('Concluído')).not.toBeNull();
    expect(screen.getByText(/12 \/ 40 enviados/)).not.toBeNull();
    expect(screen.getByText(/20 pulados/)).not.toBeNull();
  });

  it('does not fetch while closed', async () => {
    const fetcher = setClient();
    renderModal(false);

    await waitFor(() => {
      expect(screen.queryByText('Concluído')).toBeNull();
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('asks for the conta it was given', async () => {
    const fetcher = setClient();
    renderModal();

    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith({ integracaoId: 'a', limite: 20 });
    });
  });

  it('says so when the conta never ran one, instead of rendering an empty box', async () => {
    // "No history" and "the request silently returned nothing" look identical
    // in an empty list, and the operator would read the second as the first.
    setClient([]);
    renderModal();

    expect(await screen.findByText(/Nenhum envio de preços foi executado/)).not.toBeNull();
  });

  it('keeps the skip/failure samples behind Ver detalhes', async () => {
    renderModal();
    await screen.findByText('Concluído');

    expect(screen.queryByText(/PRECO_ANTIGO_IGUAL/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalhes' }));

    expect(screen.getByText(/PRECO_ANTIGO_IGUAL/)).not.toBeNull();
    expect(screen.getByText(/UPDATE_PRECO_ERROR/)).not.toBeNull();
  });

  it('reports a FAILED run with its reason', async () => {
    setClient([{ ...CONCLUIDO, status: 'failed', erro: 'rate limit persistente' }]);
    renderModal();

    expect(await screen.findByText('Falhou')).not.toBeNull();
    expect(screen.getByText(/rate limit persistente/)).not.toBeNull();
  });

  it('surfaces naoEnumerados, which is exact where the skip sample is capped', async () => {
    setClient([{ ...CONCLUIDO, naoEnumerados: 3 }]);
    renderModal();

    expect(await screen.findByText(/3 anúncios não enumerados/)).not.toBeNull();
  });

  it('stays silent about naoEnumerados when it is zero', async () => {
    // The control for the case above: the healthy run must not carry a warning.
    renderModal();
    await screen.findByText('Concluído');

    expect(screen.queryByText(/não enumerado/)).toBeNull();
  });

  it('reports a failed lookup rather than showing an empty history', async () => {
    // Same class as the empty-state case: a dead backend must not read as
    // "this conta has never run one".
    h.clientRef.current = {
      priceSyncHistorico: vi.fn(async () => {
        throw new Error('offline');
      }),
    };
    renderModal();

    expect(await screen.findByText(/Não foi possível consultar o histórico/)).not.toBeNull();
    expect(screen.queryByText(/Nenhum envio de preços foi executado/)).toBeNull();
  });
});
