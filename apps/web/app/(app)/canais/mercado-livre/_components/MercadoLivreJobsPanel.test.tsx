import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { MercadoLivreJobsEmAndamento } from '@/lib/mercado-livre/client';
import type { ContaJobOutcome, ContaRef } from './startJobsForContas';

const h = vi.hoisted(() => ({
  clientRef: { current: null as null | Record<string, unknown> },
}));

vi.mock('@/lib/mercado-livre/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/mercado-livre/client')>();
  return { ...actual, useMercadoLivreClient: () => h.clientRef.current };
});

const { MercadoLivreJobsPanel } = await import('./MercadoLivreJobsPanel');

const CONTA_A: ContaRef = { id: 'a', nome: 'Conta A' };
const CONTA_B: ContaRef = { id: 'b', nome: 'Conta B' };

const RUNNING_IMPORT = {
  jobId: 'job-a',
  integracaoId: 'a',
  status: 'running' as const,
  scanned: 40,
  imported: 12,
  created: 5,
  skipped: 20,
  failureCount: 0,
  failures: [],
  startedAt: 1,
  finishedAt: null,
  erro: null,
};

function setClient(jobs: Partial<MercadoLivreJobsEmAndamento> = {}) {
  h.clientRef.current = {
    jobsEmAndamento: vi.fn(async () => ({
      importacoes: jobs.importacoes ?? [],
      enviosPreco: jobs.enviosPreco ?? [],
    })),
    massImportStatus: vi.fn(async () => RUNNING_IMPORT),
    priceSyncStatus: vi.fn(),
  };
}

function renderPanel(props: {
  selecionadas?: readonly ContaRef[];
  massImportEntries?: readonly ContaJobOutcome[];
  priceSyncEntries?: readonly ContaJobOutcome[];
  collapsed?: boolean;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineProvider env="test">
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineProvider>
  );
  return render(
    <MercadoLivreJobsPanel
      collapsed={props.collapsed ?? false}
      selecionadas={props.selecionadas ?? []}
      massImport={{ entries: props.massImportEntries ?? [], dismiss: vi.fn() }}
      priceSync={{ entries: props.priceSyncEntries ?? [], dismiss: vi.fn() }}
    />,
    { wrapper },
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  setClient();
});

describe('MercadoLivreJobsPanel', () => {
  it('renders nothing for selected contas that have no job', async () => {
    renderPanel({ selecionadas: [CONTA_A, CONTA_B] });
    await waitFor(() => {
      expect(h.clientRef.current!.jobsEmAndamento).toHaveBeenCalledWith({
        integracaoIds: ['a', 'b'],
      });
    });
    expect(screen.queryByRole('region', { name: 'Jobs em andamento' })).toBeNull();
  });

  it('renders one entry per conta, mixing a started job with a failed start', async () => {
    renderPanel({
      selecionadas: [CONTA_A, CONTA_B],
      massImportEntries: [
        { kind: 'started', conta: CONTA_A, jobId: 'job-a' },
        { kind: 'error', conta: CONTA_B, color: 'yellow', message: 'Já existe uma importação.' },
      ],
    });

    const region = await screen.findByRole('region', { name: 'Jobs em andamento' });
    expect(await screen.findByText('Conta A')).toBeTruthy();
    expect(region.textContent).toContain('Conta B');
    expect(region.textContent).toContain('Já existe uma importação.');
  });

  it('re-attaches to a running job the lookup finds — the reload path', async () => {
    // Nothing was started in this session: the card exists only because the
    // lookup reported a job the previous page load had left running.
    setClient({ importacoes: [RUNNING_IMPORT] });
    renderPanel({ selecionadas: [CONTA_A] });

    expect(await screen.findByText('Conta A')).toBeTruthy();
    expect(await screen.findByText(/40 encontrados/)).toBeTruthy();
  });

  it('remembers the watched contas so the next mount re-queries them without a selection', async () => {
    setClient({ importacoes: [RUNNING_IMPORT] });
    const { unmount } = renderPanel({ selecionadas: [CONTA_A] });
    await screen.findByText('Conta A');
    unmount();

    // A fresh mount with an EMPTY selection still asks about conta A.
    setClient({ importacoes: [RUNNING_IMPORT] });
    renderPanel({ selecionadas: [] });
    await waitFor(() => {
      expect(h.clientRef.current!.jobsEmAndamento).toHaveBeenCalledWith({ integracaoIds: ['a'] });
    });
    expect(await screen.findByText('Conta A')).toBeTruthy();
  });

  it('collapses to a badge carrying the job count', async () => {
    renderPanel({
      collapsed: true,
      massImportEntries: [{ kind: 'started', conta: CONTA_A, jobId: 'job-a' }],
    });
    expect(await screen.findByLabelText('1 job(s) em andamento')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Jobs em andamento' })).toBeNull();
  });

  it('reports a failed lookup quietly, never as an alert', async () => {
    h.clientRef.current = {
      jobsEmAndamento: vi.fn(async () => {
        throw new (await import('@/lib/mercado-livre/client')).MercadoLivreClientNetworkError('x');
      }),
    };
    renderPanel({ selecionadas: [CONTA_A] });

    expect(
      await screen.findByText('Não foi possível consultar os jobs em andamento.'),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('MercadoLivreJobsPanel — o X de um job em andamento', () => {
  const CARD_X = 'Dispensar Importação em massa de Conta A';
  const AVISO = 'Este job está rodando no servidor e não para sozinho ao fechar o cartão.';

  /**
   * Renders one started mass-import card and waits for its FIRST poll to land.
   * The wait is load-bearing: until the status query answers, the card has no
   * data, `running` is false, and the X takes the plain dismiss branch — so
   * clicking too early tests the wrong path entirely.
   */
  async function renderCartaoEmAndamento(
    over: Record<string, unknown> = {},
  ): Promise<{ dismiss: ReturnType<typeof vi.fn> }> {
    const dismiss = vi.fn();
    h.clientRef.current = {
      jobsEmAndamento: vi.fn(async () => ({ importacoes: [], enviosPreco: [] })),
      massImportStatus: vi.fn(async () => RUNNING_IMPORT),
      priceSyncStatus: vi.fn(),
      cancelMassImport: vi.fn(async () => ({ status: 'cancelled' })),
      ...over,
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MercadoLivreJobsPanel
        collapsed={false}
        selecionadas={[]}
        massImport={{ entries: [{ kind: 'started', conta: CONTA_A, jobId: 'job-a' }], dismiss }}
        priceSync={{ entries: [], dismiss: vi.fn() }}
      />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <MantineProvider env="test">
            <QueryClientProvider client={qc}>{children}</QueryClientProvider>
          </MantineProvider>
        ),
      },
    );
    await screen.findByText(/40 encontrados/);
    return { dismiss };
  }

  it('pergunta em vez de dispensar em silêncio — a importação não para ao fechar o cartão', async () => {
    const { dismiss } = await renderCartaoEmAndamento();

    fireEvent.click(screen.getByLabelText(CARD_X));

    expect(await screen.findByText(AVISO)).toBeTruthy();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('"Apenas ocultar" esconde o cartão SEM tocar no job', async () => {
    const { dismiss } = await renderCartaoEmAndamento();

    fireEvent.click(screen.getByLabelText(CARD_X));
    fireEvent.click(await screen.findByRole('button', { name: 'Apenas ocultar' }));

    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('a'));
    expect(h.clientRef.current!.cancelMassImport).not.toHaveBeenCalled();
  });

  it('"Cancelar importação" chama a rota e o cartão passa a mostrar o estado final', async () => {
    const massImportStatus = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValue(RUNNING_IMPORT);
    await renderCartaoEmAndamento({ massImportStatus });

    fireEvent.click(screen.getByLabelText(CARD_X));
    await screen.findByText(AVISO);
    // The post-cancel refetch is what surfaces the new state on the card.
    massImportStatus.mockResolvedValue({ ...RUNNING_IMPORT, status: 'cancelled', finishedAt: 9 });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar importação' }));
    });

    await waitFor(() => {
      expect(h.clientRef.current!.cancelMassImport).toHaveBeenCalledWith({
        integracaoId: 'a',
        jobId: 'job-a',
      });
    });
    expect(await screen.findByText('Importação cancelada.')).toBeTruthy();
  });

  it('mostra a falha do cancelamento sem esconder o cartão', async () => {
    const { MercadoLivreClientHttpError } = await import('@/lib/mercado-livre/client');
    const { dismiss } = await renderCartaoEmAndamento({
      cancelMassImport: vi.fn(async () => {
        throw new MercadoLivreClientHttpError('x', 409, 'ML_MASS_IMPORT_NOT_RUNNING');
      }),
    });

    fireEvent.click(screen.getByLabelText(CARD_X));
    await screen.findByText(AVISO);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar importação' }));
    });

    expect(await screen.findByText('Esta importação já foi finalizada.')).toBeTruthy();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('um job já terminado dispensa direto, sem confirmação', async () => {
    const dismiss = vi.fn();
    h.clientRef.current = {
      jobsEmAndamento: vi.fn(async () => ({ importacoes: [], enviosPreco: [] })),
      massImportStatus: vi.fn(async () => ({
        ...RUNNING_IMPORT,
        status: 'completed',
        finishedAt: 9,
      })),
      priceSyncStatus: vi.fn(),
      cancelMassImport: vi.fn(),
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MercadoLivreJobsPanel
        collapsed={false}
        selecionadas={[]}
        massImport={{ entries: [{ kind: 'started', conta: CONTA_A, jobId: 'job-a' }], dismiss }}
        priceSync={{ entries: [], dismiss: vi.fn() }}
      />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <MantineProvider env="test">
            <QueryClientProvider client={qc}>{children}</QueryClientProvider>
          </MantineProvider>
        ),
      },
    );

    expect(await screen.findByText('Importação concluída.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(CARD_X));

    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('a'));
    expect(screen.queryByText(AVISO)).toBeNull();
  });
});
