import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { MercadoLivreJobsEmAndamento } from '@/lib/mercado-livre/client';
import type { ContaJobOutcome, ContaRef } from '@/lib/marketplace/contaJobs/types';

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
    priceSyncHistorico: vi.fn(async () => ({ envios: [] })),
  };
}

function renderPanel(props: {
  selecionadas?: readonly ContaRef[];
  massImportEntries?: readonly ContaJobOutcome[];
  priceSyncEntries?: readonly ContaJobOutcome[];
  collapsed?: boolean;
}) {
  // ⚠️ `retryDelay`, not just `retry`. The lookup sets its own `retry`
  // predicate, which a client default cannot override — so a RETRYABLE
  // rejection (a network failure) would otherwise sit through the real
  // 1s/2s backoff before the error path renders.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
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
  it('renders no job card for selected contas that have no job, but keeps the Histórico entry point', async () => {
    renderPanel({ selecionadas: [CONTA_A, CONTA_B] });
    await waitFor(() => {
      expect(h.clientRef.current!.jobsEmAndamento).toHaveBeenCalledWith({
        integracaoIds: ['a', 'b'],
      });
    });

    // No CARD — that half is unchanged: the lookup found no running job.
    expect(screen.queryByText('Envio de preços')).toBeNull();
    expect(screen.queryByText('Importação em massa')).toBeNull();

    // ⚠️ But the panel must NOT disappear. "No card" is exactly the state an
    // operator is in after a run finished while they were on another page —
    // the lookup is running-only — so this is when the history is most needed
    // and it used to be the branch that returned null.
    expect(screen.getByRole('region', { name: 'Jobs em andamento' })).not.toBeNull();
    // ⚠️ Named per conta, and asserted that way. Two links with the same
    // accessible name would be indistinguishable to a screen reader AND in the
    // rail; `getAllByRole` with a shared name would have passed either way.
    expect(
      screen.getByRole('button', { name: 'Histórico de envios de preços — Conta A' }),
    ).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Histórico de envios de preços — Conta B' }),
    ).not.toBeNull();
  });

  it('renders nothing at all with no selection, no card and no error', async () => {
    // The control for the case above: the panel is not simply always-on. With
    // nothing selected there is no conta to show a history for, so the rail
    // stays empty rather than growing a dangling link.
    renderPanel({ selecionadas: [] });
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Jobs em andamento' })).toBeNull();
    });
    expect(h.clientRef.current!.jobsEmAndamento).not.toHaveBeenCalled();
  });

  it('does not fetch the histórico until the link is opened', async () => {
    // The link is rendered per selected conta, so an unopened one must cost
    // nothing — otherwise selecting a row would fire a query per conta.
    renderPanel({ selecionadas: [CONTA_A] });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Histórico de envios de preços — Conta A' }),
      ).not.toBeNull();
    });
    expect(h.clientRef.current!.priceSyncHistorico).not.toHaveBeenCalled();
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
  const AVISO = 'Fechar o cartão não interrompe o job — ele segue no servidor.';

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
          <MantineTestProvider>
            <QueryClientProvider client={qc}>{children}</QueryClientProvider>
          </MantineTestProvider>
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

  it('um erro NÃO reconhecido ainda diz alguma coisa, em vez de morrer calado', async () => {
    // `throw err` here used to be an unhandled promise rejection (async click
    // handler), leaving the spinner stopped and the modal silent. The reachable
    // case is the client being null — `onCancel` throws a plain Error, which no
    // narrowing recognises.
    const { dismiss } = await renderCartaoEmAndamento({
      cancelMassImport: vi.fn(async () => {
        throw new Error('not ready');
      }),
    });

    fireEvent.click(screen.getByLabelText(CARD_X));
    await screen.findByText(AVISO);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar importação' }));
    });

    expect(await screen.findByText('Não foi possível cancelar a importação.')).toBeTruthy();
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
          <MantineTestProvider>
            <QueryClientProvider client={qc}>{children}</QueryClientProvider>
          </MantineTestProvider>
        ),
      },
    );

    expect(await screen.findByText('Importação concluída.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(CARD_X));

    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('a'));
    expect(screen.queryByText(AVISO)).toBeNull();
  });
});

describe('MercadoLivreJobsPanel — o X de um envio de preços em andamento', () => {
  // #1144. Mirrors the mass-import block above, and the mirroring is the point:
  // both cards share `JobCardShell`, so the shell's copy and its error mapper
  // have to come out per-flow. Before this the shell hard-coded the mass-import
  // mapper, and a price-sync 404 would have said "Importação não encontrada."
  const CARD_X = 'Dispensar Envio de preços de Conta A';
  const AVISO = 'Fechar o cartão não interrompe o job — ele segue no servidor.';

  const RUNNING_PRECO = {
    jobId: 'job-p',
    integracaoId: 'a',
    status: 'running' as const,
    baixarPreco: false,
    planejados: 30,
    enviados: 7,
    pulados: 2,
    naoEnumerados: 0,
    falhas: 0,
    pausas: 0,
    skips: [],
    failures: [],
    startedAt: 1,
    updatedAt: 2,
    finishedAt: null,
    erro: null,
  };

  /**
   * Renders one started price-sync card and waits for its FIRST poll to land.
   * The wait is load-bearing for the same reason as the mass-import helper's:
   * before the status query answers, `encerrado` is false because `data` is
   * undefined, and the X takes a different branch than the one under test.
   */
  async function renderCartaoEmAndamento(
    over: Record<string, unknown> = {},
  ): Promise<{ dismiss: ReturnType<typeof vi.fn> }> {
    const dismiss = vi.fn();
    h.clientRef.current = {
      jobsEmAndamento: vi.fn(async () => ({ importacoes: [], enviosPreco: [] })),
      massImportStatus: vi.fn(),
      priceSyncStatus: vi.fn(async () => RUNNING_PRECO),
      priceSyncHistorico: vi.fn(async () => ({ envios: [] })),
      cancelPriceSync: vi.fn(async () => ({ status: 'cancelled' })),
      ...over,
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MercadoLivreJobsPanel
        collapsed={false}
        selecionadas={[]}
        massImport={{ entries: [], dismiss: vi.fn() }}
        priceSync={{ entries: [{ kind: 'started', conta: CONTA_A, jobId: 'job-p' }], dismiss }}
      />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <MantineTestProvider>
            <QueryClientProvider client={qc}>{children}</QueryClientProvider>
          </MantineTestProvider>
        ),
      },
    );
    await screen.findByText(/7 \/ 30 enviados/);
    return { dismiss };
  }

  it('pergunta em vez de dispensar em silêncio — o envio não para ao fechar o cartão', async () => {
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
    expect(h.clientRef.current!.cancelPriceSync).not.toHaveBeenCalled();
  });

  it('"Cancelar envio" chama a rota e o cartão passa a mostrar o estado final', async () => {
    const priceSyncStatus = vi
      .fn<() => Promise<Record<string, unknown>>>()
      .mockResolvedValue(RUNNING_PRECO);
    await renderCartaoEmAndamento({ priceSyncStatus });

    fireEvent.click(screen.getByLabelText(CARD_X));
    await screen.findByText(AVISO);
    // The post-cancel refetch is what surfaces the new state on the card.
    priceSyncStatus.mockResolvedValue({ ...RUNNING_PRECO, status: 'cancelled', finishedAt: 9 });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar envio' }));
    });

    await waitFor(() => {
      expect(h.clientRef.current!.cancelPriceSync).toHaveBeenCalledWith({
        integracaoId: 'a',
        jobId: 'job-p',
      });
    });
    expect(await screen.findByText('Envio de preços cancelado.')).toBeTruthy();
  });

  it('⭐ mostra a falha do cancelamento com a cópia DESTE fluxo, não a da importação', async () => {
    // The regression this pins: with the shell's mapper hard-coded, a 409 here
    // rendered "Esta importação já foi finalizada." on a price-sync card.
    const { MercadoLivreClientHttpError } = await import('@/lib/mercado-livre/client');
    const { dismiss } = await renderCartaoEmAndamento({
      cancelPriceSync: vi.fn(async () => {
        throw new MercadoLivreClientHttpError('x', 409, 'ML_PRICE_SYNC_NOT_RUNNING');
      }),
    });

    fireEvent.click(screen.getByLabelText(CARD_X));
    await screen.findByText(AVISO);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar envio' }));
    });

    expect(await screen.findByText('Este envio de preços já foi finalizado.')).toBeTruthy();
    expect(screen.queryByText('Esta importação já foi finalizada.')).toBeNull();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('um erro NÃO reconhecido ainda diz alguma coisa, em vez de morrer calado', async () => {
    const { dismiss } = await renderCartaoEmAndamento({
      cancelPriceSync: vi.fn(async () => {
        throw new Error('not ready');
      }),
    });

    fireEvent.click(screen.getByLabelText(CARD_X));
    await screen.findByText(AVISO);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar envio' }));
    });

    expect(await screen.findByText('Não foi possível cancelar o envio de preços.')).toBeTruthy();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('um envio já terminado dispensa direto, sem confirmação', async () => {
    const dismiss = vi.fn();
    h.clientRef.current = {
      jobsEmAndamento: vi.fn(async () => ({ importacoes: [], enviosPreco: [] })),
      massImportStatus: vi.fn(),
      priceSyncStatus: vi.fn(async () => ({
        ...RUNNING_PRECO,
        status: 'completed',
        finishedAt: 9,
      })),
      priceSyncHistorico: vi.fn(async () => ({ envios: [] })),
      cancelPriceSync: vi.fn(),
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MercadoLivreJobsPanel
        collapsed={false}
        selecionadas={[]}
        massImport={{ entries: [], dismiss: vi.fn() }}
        priceSync={{ entries: [{ kind: 'started', conta: CONTA_A, jobId: 'job-p' }], dismiss }}
      />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <MantineTestProvider>
            <QueryClientProvider client={qc}>{children}</QueryClientProvider>
          </MantineTestProvider>
        ),
      },
    );
    await screen.findByText('Envio de preços concluído.');

    fireEvent.click(screen.getByLabelText(CARD_X));

    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('a'));
    expect(screen.queryByText(AVISO)).toBeNull();
    expect(h.clientRef.current!.cancelPriceSync).not.toHaveBeenCalled();
  });
});

describe('MercadoLivreJobsPanel — o X antes de saber o estado do job', () => {
  const CARD_X = 'Dispensar Importação em massa de Conta A';
  const AVISO = 'Fechar o cartão não interrompe o job — ele segue no servidor.';

  /**
   * Renders a started card and waits only for the FIRST poll attempt to settle,
   * without requiring it to succeed.
   *
   * These are the states the confirm used to skip. `running` is
   * `data?.status === 'running'`, so it is false whenever the status query has
   * no data — and the X then took the plain dismiss branch, blacklisting the
   * jobId for the session. Which is the exact failure the confirm exists to
   * remove, reachable in precisely the moments an operator reaches for the X.
   */
  function renderCartaoSemEstado(over: Record<string, unknown>): ReturnType<typeof vi.fn> {
    const dismiss = vi.fn();
    h.clientRef.current = {
      jobsEmAndamento: vi.fn(async () => ({ importacoes: [], enviosPreco: [] })),
      priceSyncStatus: vi.fn(),
      cancelMassImport: vi.fn(async () => ({ status: 'cancelled' })),
      ...over,
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    render(
      <MercadoLivreJobsPanel
        collapsed={false}
        selecionadas={[]}
        massImport={{ entries: [{ kind: 'started', conta: CONTA_A, jobId: 'job-a' }], dismiss }}
        priceSync={{ entries: [], dismiss: vi.fn() }}
      />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <MantineTestProvider>
            <QueryClientProvider client={qc}>{children}</QueryClientProvider>
          </MantineTestProvider>
        ),
      },
    );
    return dismiss;
  }

  it('a primeira consulta FALHOU — ainda pergunta, em vez de dispensar em silêncio', async () => {
    // The worst case of the three: a flaky backend is exactly when an operator
    // gives up and reaches for the X.
    const dismiss = renderCartaoSemEstado({
      massImportStatus: vi.fn(async () => {
        throw new (await import('@/lib/mercado-livre/client')).MercadoLivreClientNetworkError('x');
      }),
    });

    fireEvent.click(await screen.findByLabelText(CARD_X));

    expect(await screen.findByText(AVISO)).toBeTruthy();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('a consulta ainda não respondeu — ainda pergunta', async () => {
    // A card started this session carries no initialStatus, so `data` is
    // undefined until the first poll lands.
    const dismiss = renderCartaoSemEstado({
      massImportStatus: vi.fn(() => new Promise(() => {})),
    });

    fireEvent.click(await screen.findByLabelText(CARD_X));

    expect(await screen.findByText(AVISO)).toBeTruthy();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('a falha de um cancelamento não sobrevive ao fechar o modal', async () => {
    const { MercadoLivreClientHttpError } = await import('@/lib/mercado-livre/client');
    renderCartaoSemEstado({
      massImportStatus: vi.fn(async () => RUNNING_IMPORT),
      cancelMassImport: vi.fn(async () => {
        throw new MercadoLivreClientHttpError('x', 409, 'ML_MASS_IMPORT_NOT_RUNNING');
      }),
    });

    fireEvent.click(await screen.findByLabelText(CARD_X));
    await screen.findByText(AVISO);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar importação' }));
    });
    expect(await screen.findByText('Esta importação já foi finalizada.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    fireEvent.click(screen.getByLabelText(CARD_X));

    await screen.findByText(AVISO);
    expect(screen.queryByText('Esta importação já foi finalizada.')).toBeNull();
  });
});
