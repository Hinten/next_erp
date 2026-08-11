import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
