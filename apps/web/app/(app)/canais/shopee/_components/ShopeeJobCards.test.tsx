import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ENVIO_PRECO_SHOPEE_STATUS, IMPORTACAO_SHOPEE_STATUS } from '@delfrance/schemas';

import type { ContaRef } from '@/lib/marketplace/contaJobs/types';
import type { ShopeeClient } from '@/lib/shopee/client';
import type { MassImportStatusShopee, PriceSyncStatusShopee } from '@/lib/shopee/wire';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { shopeeClientFalso } from '@/lib/testing/shopeeClientFalso';

const h = vi.hoisted(() => ({
  clientRef: { current: null as ShopeeClient | null },
}));

vi.mock('@/lib/shopee/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shopee/client')>();
  return { ...actual, useShopeeClient: () => h.clientRef.current };
});

const { EnvioPrecoShopeeJobCard, ImportacaoShopeeJobCard } = await import('./ShopeeJobCards');
const { SEM_PROGRESSO_MS } = await import('./cadenciaJobsShopee');

const CONTA: ContaRef = { id: 'int-1', nome: 'Loja Shopee' };

function importacao(over: Partial<MassImportStatusShopee> = {}): MassImportStatusShopee {
  return {
    status: IMPORTACAO_SHOPEE_STATUS.running,
    scanned: 40,
    imported: 12,
    created: 5,
    skipped: 20,
    kits: 0,
    failureCount: 0,
    failures: [],
    restante: 8,
    varreduraExaurida: false,
    startedAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    finishedAt: null,
    erro: null,
    ...over,
  };
}

function envioPreco(over: Partial<PriceSyncStatusShopee> = {}): PriceSyncStatusShopee {
  return {
    jobId: 'job-p',
    status: ENVIO_PRECO_SHOPEE_STATUS.running,
    baixarPreco: false,
    planejados: 30,
    enviados: 7,
    pulados: 2,
    falhas: 0,
    pausas: 0,
    parques: 0,
    filaRestante: 21,
    relatorioShards: 1,
    retomarEm: null,
    relatorioCompleto: false,
    startedAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    finishedAt: null,
    erro: null,
    skips: [],
    failures: [],
    ...over,
  };
}

function renderCartao(cartao: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{cartao}</QueryClientProvider>
    </MantineTestProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ImportacaoShopeeJobCard', () => {
  it('polls ITS jobId and renders the counters, with the queue while running', async () => {
    const massImportStatus = vi.fn(async () => importacao({ kits: 3, varreduraExaurida: true }));
    h.clientRef.current = shopeeClientFalso({ massImportStatus });
    renderCartao(
      <ImportacaoShopeeJobCard conta={CONTA} jobId="job-i" reatado={false} onDismiss={vi.fn()} />,
    );

    expect(
      await screen.findByText(/40 encontrados · 12 importados \(5 novos\) · 3 kits/),
    ).not.toBeNull();
    expect(screen.getByText('20 pulados · 0 falhas')).not.toBeNull();
    expect(screen.getByText('8 na fila · varredura concluída')).not.toBeNull();
    expect(massImportStatus).toHaveBeenCalledWith({ integracaoId: 'int-1', jobId: 'job-i' });
  });

  it('⭐ lists a failure row WITH its stored sentence behind "Ver falhas"', async () => {
    h.clientRef.current = shopeeClientFalso({
      massImportStatus: vi.fn(async () =>
        importacao({
          status: IMPORTACAO_SHOPEE_STATUS.completed,
          failureCount: 3,
          failures: [
            {
              itemId: 1000001,
              motivo: 'kit-componente-nao-vinculado',
              mensagem: 'O kit usa um componente que ainda não foi importado.',
            },
          ],
        }),
      ),
    });
    renderCartao(
      <ImportacaoShopeeJobCard conta={CONTA} jobId="job-i" reatado={false} onDismiss={vi.fn()} />,
    );

    expect(await screen.findByText('Importação concluída.')).not.toBeNull();
    expect(screen.queryByText(/kit-componente-nao-vinculado/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver falhas' }));

    expect(await screen.findByText(/1000001 · kit-componente-nao-vinculado/)).not.toBeNull();
    expect(screen.getByText('O kit usa um componente que ainda não foi importado.')).not.toBeNull();
    // The sample is capped; the counter is exact — "+N mais" counts against it.
    expect(screen.getByText('+2 mais')).not.toBeNull();
  });

  it('says so when it was attached to a run already going', async () => {
    h.clientRef.current = shopeeClientFalso({ massImportStatus: vi.fn(async () => importacao()) });
    renderCartao(
      <ImportacaoShopeeJobCard conta={CONTA} jobId="job-i" reatado onDismiss={vi.fn()} />,
    );

    expect(
      await screen.findByText(
        /o painel passou a acompanhá-la. As opções escolhidas agora não foram aplicadas./,
      ),
    ).not.toBeNull();
  });

  it('renders a failed run with the backend’s reason', async () => {
    h.clientRef.current = shopeeClientFalso({
      massImportStatus: vi.fn(async () =>
        importacao({ status: IMPORTACAO_SHOPEE_STATUS.failed, erro: 'fila fechada' }),
      ),
    });
    renderCartao(
      <ImportacaoShopeeJobCard conta={CONTA} jobId="job-i" reatado={false} onDismiss={vi.fn()} />,
    );

    expect(await screen.findByText('Falha na importação: fila fechada')).not.toBeNull();
    expect(screen.queryByText(/na fila/)).toBeNull();
  });

  it('cancel calls the route for THIS job and the card shows the terminal state', async () => {
    const massImportStatus = vi
      .fn<ShopeeClient['massImportStatus']>()
      .mockResolvedValue(importacao());
    const cancelMassImport = vi.fn<ShopeeClient['cancelMassImport']>(async () => ({
      status: 'cancelled' as const,
    }));
    h.clientRef.current = shopeeClientFalso({ massImportStatus, cancelMassImport });
    renderCartao(
      <ImportacaoShopeeJobCard conta={CONTA} jobId="job-i" reatado={false} onDismiss={vi.fn()} />,
    );
    await screen.findByText(/40 encontrados/);

    fireEvent.click(screen.getByLabelText('Dispensar Importação em massa de Loja Shopee'));
    massImportStatus.mockResolvedValue(importacao({ status: IMPORTACAO_SHOPEE_STATUS.cancelled }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Cancelar importação' }));
    });

    expect(cancelMassImport).toHaveBeenCalledWith({ integracaoId: 'int-1', jobId: 'job-i' });
    expect(await screen.findByText('Importação cancelada.')).not.toBeNull();
  });

  it('a cancel that lost the race reads as finished, with no console noise for a client error', async () => {
    const { ShopeeClientHttpError } = await import('@/lib/shopee/client');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.clientRef.current = shopeeClientFalso({
      massImportStatus: vi.fn(async () => importacao()),
      cancelMassImport: vi.fn(async () => {
        throw new ShopeeClientHttpError('x', 409, 'SHOPEE_MASS_IMPORT_NOT_RUNNING');
      }),
    });
    renderCartao(
      <ImportacaoShopeeJobCard conta={CONTA} jobId="job-i" reatado={false} onDismiss={vi.fn()} />,
    );
    await screen.findByText(/40 encontrados/);

    fireEvent.click(screen.getByLabelText('Dispensar Importação em massa de Loja Shopee'));
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Cancelar importação' }));
    });

    expect(await screen.findByText('Esta importação já foi finalizada.')).not.toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('⭐ the "sem progresso" hint is driven by the poll clock — it appears on a wedged job whose body never changes', async () => {
    // A wedged job answers the SAME body on every poll, so TanStack keeps the
    // same `data` reference. A hint computed from `Date.now()` in render would
    // never re-render into view; `dataUpdatedAt` moves on every poll.
    vi.useFakeTimers();
    const t0 = Date.UTC(2026, 9, 14, 15, 0);
    vi.setSystemTime(t0);
    const parado = importacao({
      startedAt: t0 - 3_600_000,
      updatedAt: t0 - SEM_PROGRESSO_MS + 60_000,
    });
    h.clientRef.current = shopeeClientFalso({
      massImportStatus: vi.fn(async () => ({ ...parado })),
    });
    renderCartao(
      <ImportacaoShopeeJobCard conta={CONTA} jobId="job-i" reatado={false} onDismiss={vi.fn()} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(/40 encontrados/)).not.toBeNull();
    // 44 min of silence: still quiet.
    expect(screen.queryByText(/Sem progresso desde/)).toBeNull();

    // Two more minutes of identical polls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(
      screen.getByText(
        'Sem progresso desde 14/10 11:16 — se continuar assim, cancele e inicie de novo.',
      ),
    ).not.toBeNull();
  });
});

describe('EnvioPrecoShopeeJobCard', () => {
  it('renders the counters with pauses and quota waits only when non-zero', async () => {
    h.clientRef.current = shopeeClientFalso({
      priceSyncStatus: vi.fn(async () => envioPreco({ pausas: 2, parques: 1 })),
    });
    renderCartao(
      <EnvioPrecoShopeeJobCard conta={CONTA} jobId="job-p" reatado={false} onDismiss={vi.fn()} />,
    );

    expect(
      await screen.findByText(
        '7 / 30 enviados · 2 pulados · 0 falhas · 2 pausas · 1 espera pela cota diária',
      ),
    ).not.toBeNull();
  });

  it('⭐ a PARKED run says when it resumes, in São Paulo time — never a bare spinner', async () => {
    h.clientRef.current = shopeeClientFalso({
      priceSyncStatus: vi.fn(async () =>
        envioPreco({ parques: 3, retomarEm: Date.UTC(2099, 0, 2, 3, 0) }),
      ),
    });
    renderCartao(
      <EnvioPrecoShopeeJobCard conta={CONTA} jobId="job-p" reatado={false} onDismiss={vi.fn()} />,
    );

    expect(
      await screen.findByText(
        'Aguardando a cota diária da Shopee — retoma por volta de 02/01 00:00.',
      ),
    ).not.toBeNull();
    // A long park is a promise of activity, not a wedge.
    expect(screen.queryByText(/Sem progresso desde/)).toBeNull();
  });

  it('offers the CSV only once the run is over', async () => {
    const priceSyncStatus = vi
      .fn<ShopeeClient['priceSyncStatus']>()
      .mockResolvedValue(envioPreco());
    h.clientRef.current = shopeeClientFalso({ priceSyncStatus });
    const { unmount } = renderCartao(
      <EnvioPrecoShopeeJobCard conta={CONTA} jobId="job-p" reatado={false} onDismiss={vi.fn()} />,
    );
    await screen.findByText(/7 \/ 30 enviados/);
    expect(screen.queryByRole('button', { name: 'Baixar CSV' })).toBeNull();
    unmount();

    priceSyncStatus.mockResolvedValue(
      envioPreco({ status: ENVIO_PRECO_SHOPEE_STATUS.completed, finishedAt: Date.now() }),
    );
    renderCartao(
      <EnvioPrecoShopeeJobCard conta={CONTA} jobId="job-p" reatado={false} onDismiss={vi.fn()} />,
    );
    expect(await screen.findByText('Atualização de preços concluída.')).not.toBeNull();
    // A run with no skip and no failure still has a report — the best case.
    expect(screen.getByRole('button', { name: 'Baixar CSV' })).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Ver detalhes' })).toBeNull();
  });

  it('shows the skip and failure samples with each one’s sentence behind "Ver detalhes"', async () => {
    h.clientRef.current = shopeeClientFalso({
      priceSyncStatus: vi.fn(async () =>
        envioPreco({
          status: ENVIO_PRECO_SHOPEE_STATUS.completed,
          pulados: 1,
          falhas: 1,
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
          failures: [
            {
              itemId: null,
              produtoId: 'p2',
              code: 'erro-shopee',
              linkDocId: null,
              precoAnterior: null,
              mensagem: 'A Shopee recusou o preço.',
              error: 'error_update_price_fail',
            },
          ],
        }),
      ),
    });
    renderCartao(
      <EnvioPrecoShopeeJobCard conta={CONTA} jobId="job-p" reatado={false} onDismiss={vi.fn()} />,
    );
    await screen.findByText('Atualização de preços concluída.');

    fireEvent.click(screen.getByRole('button', { name: 'Ver detalhes' }));

    expect(await screen.findByText('1000001 · preco-igual')).not.toBeNull();
    expect(screen.getByText('O preço já é o da tabela.')).not.toBeNull();
    // A plan-time failure has no listing: it names the produto instead.
    expect(screen.getByText('p2 · erro-shopee · error_update_price_fail')).not.toBeNull();
    expect(screen.getByText('A Shopee recusou o preço.')).not.toBeNull();
  });

  it('cancel uses the PRICE copy and route', async () => {
    const { ShopeeClientHttpError } = await import('@/lib/shopee/client');
    const cancelPriceSync = vi.fn(async () => {
      throw new ShopeeClientHttpError('x', 409, 'SHOPEE_PRICE_SYNC_NOT_RUNNING');
    });
    h.clientRef.current = shopeeClientFalso({
      priceSyncStatus: vi.fn(async () => envioPreco()),
      cancelPriceSync,
    });
    renderCartao(
      <EnvioPrecoShopeeJobCard conta={CONTA} jobId="job-p" reatado={false} onDismiss={vi.fn()} />,
    );
    await screen.findByText(/7 \/ 30 enviados/);

    fireEvent.click(screen.getByLabelText('Dispensar Atualização de preços de Loja Shopee'));
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Cancelar atualização' }));
    });

    await waitFor(() => {
      expect(cancelPriceSync).toHaveBeenCalledWith({ integracaoId: 'int-1', jobId: 'job-p' });
    });
    expect(await screen.findByText('Esta atualização de preços já foi finalizada.')).not.toBeNull();
  });

  it('says so when it was attached to a run already going', async () => {
    h.clientRef.current = shopeeClientFalso({ priceSyncStatus: vi.fn(async () => envioPreco()) });
    renderCartao(
      <EnvioPrecoShopeeJobCard conta={CONTA} jobId="job-p" reatado onDismiss={vi.fn()} />,
    );

    expect(await screen.findByText(/A opção escolhida agora não foi aplicada./)).not.toBeNull();
  });

  it('a failed first poll offers a retry when one could help, instead of a dead card', async () => {
    const { ShopeeClientNetworkError } = await import('@/lib/shopee/client');
    h.clientRef.current = shopeeClientFalso({
      priceSyncStatus: vi.fn(async () => {
        throw new ShopeeClientNetworkError('offline');
      }),
    });
    renderCartao(
      <EnvioPrecoShopeeJobCard conta={CONTA} jobId="job-p" reatado={false} onDismiss={vi.fn()} />,
    );

    expect(
      await screen.findByText('Não foi possível contatar a integração com a Shopee.'),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: /Tentar/ })).not.toBeNull();
  });
});
