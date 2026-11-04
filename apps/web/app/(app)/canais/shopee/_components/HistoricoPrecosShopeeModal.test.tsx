import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ENVIO_PRECO_SHOPEE_STATUS } from '@delfrance/schemas';

import type { ContaRef } from '@/lib/marketplace/contaJobs/types';
import type { ShopeeClient } from '@/lib/shopee/client';
import type { PriceSyncHistoricoShopee, PriceSyncStatusShopee } from '@/lib/shopee/wire';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { shopeeClientFalso } from '@/lib/testing/shopeeClientFalso';

const h = vi.hoisted(() => ({
  clientRef: { current: null as ShopeeClient | null },
}));

vi.mock('@/lib/shopee/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shopee/client')>();
  return { ...actual, useShopeeClient: () => h.clientRef.current };
});

const { HistoricoPrecosShopeeModal, HISTORICO_PRECOS_SHOPEE_LIMITE } =
  await import('./HistoricoPrecosShopeeModal');

const CONTA: ContaRef = { id: 'int-1', nome: 'Loja A' };

type Envio = PriceSyncHistoricoShopee['envios'][number];

/** A FINISHED run — no samples: the history route drops them. */
const CONCLUIDO: Envio = {
  jobId: 'env-1',
  integracaoId: 'int-1',
  status: ENVIO_PRECO_SHOPEE_STATUS.completed,
  baixarPreco: false,
  planejados: 40,
  enviados: 12,
  pulados: 20,
  falhas: 1,
  pausas: 0,
  parques: 0,
  filaRestante: 0,
  relatorioShards: 1,
  retomarEm: null,
  relatorioCompleto: true,
  // 2026-08-20 15:30 in São Paulo.
  startedAt: Date.UTC(2026, 7, 20, 18, 30),
  updatedAt: Date.UTC(2026, 7, 20, 18, 45),
  finishedAt: Date.UTC(2026, 7, 20, 18, 45),
  erro: null,
};

const RODANDO: Envio = {
  ...CONCLUIDO,
  jobId: 'env-2',
  status: ENVIO_PRECO_SHOPEE_STATUS.running,
  parques: 4,
  // 2099-01-02 00:00 in São Paulo.
  retomarEm: Date.UTC(2099, 0, 2, 3, 0),
  finishedAt: null,
};

const STATUS_DO_CONCLUIDO: PriceSyncStatusShopee = {
  ...CONCLUIDO,
  skips: [
    {
      itemId: '1000001',
      produtoId: 'p1',
      code: 'preco-igual',
      linkDocId: 'l1',
      precoAnterior: 10,
      mensagem: 'O preço já é o da tabela.',
    },
  ],
  failures: [],
};

interface Cliente {
  priceSyncHistorico: ReturnType<typeof vi.fn<ShopeeClient['priceSyncHistorico']>>;
  priceSyncStatus: ReturnType<typeof vi.fn<ShopeeClient['priceSyncStatus']>>;
}

function setClient(envios: Envio[] = [CONCLUIDO]): Cliente {
  const c: Cliente = {
    priceSyncHistorico: vi.fn<ShopeeClient['priceSyncHistorico']>(async () => ({ envios })),
    priceSyncStatus: vi.fn<ShopeeClient['priceSyncStatus']>(async () => STATUS_DO_CONCLUIDO),
  };
  h.clientRef.current = shopeeClientFalso(c);
  return c;
}

function renderModal(opened = true) {
  const onAcompanhar = vi.fn();
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
  );
  render(
    <HistoricoPrecosShopeeModal
      conta={CONTA}
      opened={opened}
      onClose={onClose}
      onAcompanhar={onAcompanhar}
    />,
    { wrapper },
  );
  return { onAcompanhar, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HistoricoPrecosShopeeModal', () => {
  it('does not fetch while closed', async () => {
    const c = setClient();
    renderModal(false);
    await waitFor(() => {
      expect(screen.queryByText('Concluída')).toBeNull();
    });
    expect(c.priceSyncHistorico).not.toHaveBeenCalled();
  });

  it('asks for the conta it was given, with the page size', async () => {
    const c = setClient();
    renderModal();
    await waitFor(() => {
      expect(c.priceSyncHistorico).toHaveBeenCalledWith({
        integracaoId: 'int-1',
        limite: HISTORICO_PRECOS_SHOPEE_LIMITE,
      });
    });
    expect(HISTORICO_PRECOS_SHOPEE_LIMITE).toBe(20);
  });

  it('lists a FINISHED run with its counters and São Paulo start time, and offers its CSV', async () => {
    setClient();
    renderModal();

    expect(await screen.findByText('Concluída')).not.toBeNull();
    expect(screen.getByText('20/08/2026 15:30')).not.toBeNull();
    expect(screen.getByText(/12 \/ 40 enviados · 20 pulados · 1 falhas/)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Baixar CSV' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Acompanhar' })).toBeNull();
  });

  it('⭐ a RUNNING row offers "Acompanhar" (no CSV) and hands its jobId to the rail', async () => {
    setClient([RODANDO]);
    const { onAcompanhar, onClose } = renderModal();

    expect(await screen.findByText('Em andamento')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Baixar CSV' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Acompanhar' }));

    expect(onAcompanhar).toHaveBeenCalledWith('env-2');
    expect(onClose).toHaveBeenCalled();
  });

  it('a parked row says when it resumes', async () => {
    setClient([RODANDO]);
    renderModal();

    expect(
      await screen.findByText(
        'Aguardando a cota diária da Shopee — retoma por volta de 02/01 00:00.',
      ),
    ).not.toBeNull();
    expect(screen.getByText(/4 esperas pela cota diária/)).not.toBeNull();
  });

  it('⭐ reads a run’s samples only when its details are OPENED', async () => {
    const c = setClient();
    renderModal();
    await screen.findByText('Concluída');
    expect(c.priceSyncStatus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalhes' }));

    expect(await screen.findByText('1000001 · preco-igual')).not.toBeNull();
    expect(screen.getByText('O preço já é o da tabela.')).not.toBeNull();
    expect(c.priceSyncStatus).toHaveBeenCalledWith({ integracaoId: 'int-1', jobId: 'env-1' });
  });

  it('offers no details for a run with no skip and no failure', async () => {
    setClient([{ ...CONCLUIDO, pulados: 0, falhas: 0 }]);
    renderModal();
    await screen.findByText('Concluída');
    expect(screen.queryByRole('button', { name: 'Ver detalhes' })).toBeNull();
  });

  it('reports a FAILED run with its reason', async () => {
    setClient([
      { ...CONCLUIDO, status: ENVIO_PRECO_SHOPEE_STATUS.failed, erro: 'fila desabilitada' },
    ]);
    renderModal();
    expect(await screen.findByText('Falhou')).not.toBeNull();
    expect(screen.getByText('Erro: fila desabilitada')).not.toBeNull();
  });

  it('says so when the conta never ran one, instead of an empty box', async () => {
    setClient([]);
    renderModal();
    expect(
      await screen.findByText('Nenhuma atualização de preços foi executada nesta conta.'),
    ).not.toBeNull();
  });

  it('reports a failed read rather than an empty history', async () => {
    const { ShopeeClientHttpError } = await import('@/lib/shopee/client');
    h.clientRef.current = shopeeClientFalso({
      priceSyncHistorico: vi.fn(async () => {
        throw new ShopeeClientHttpError('Sem permissão para esta operação na Shopee.', 403, null);
      }),
    });
    renderModal();
    expect(await screen.findByText('Sem permissão para esta operação na Shopee.')).not.toBeNull();
    expect(screen.queryByText(/Nenhuma atualização de preços/)).toBeNull();
  });
});
