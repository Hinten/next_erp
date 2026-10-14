import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ReactNode, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ENVIO_PRECO_SHOPEE_STATUS, IMPORTACAO_SHOPEE_STATUS } from '@delfrance/schemas';

import type { ContaJobOutcome, ContaRef } from '@/lib/marketplace/contaJobs/types';
import type { ShopeeClient } from '@/lib/shopee/client';
import type {
  MassImportStatusShopee,
  PriceSyncHistoricoShopee,
  PriceSyncStatusShopee,
} from '@/lib/shopee/wire';
import { MantineTestProvider } from '@/lib/testing/mantine';
import { shopeeClientFalso } from '@/lib/testing/shopeeClientFalso';

const h = vi.hoisted(() => ({
  clientRef: { current: null as ShopeeClient | null },
}));

vi.mock('@/lib/shopee/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shopee/client')>();
  return { ...actual, useShopeeClient: () => h.clientRef.current };
});

const { CHAVE_JOBS_RASTREADOS_SHOPEE, ShopeeJobsPanel } = await import('./ShopeeJobsPanel');

const CONTA_A: ContaRef = { id: 'int-1', nome: 'Loja A' };
const CONTA_B: ContaRef = { id: 'int-2', nome: 'Loja B' };

const IMPORTACAO: MassImportStatusShopee = {
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
  startedAt: Date.now(),
  updatedAt: Date.now(),
  finishedAt: null,
  erro: null,
};

const ENVIO: PriceSyncStatusShopee = {
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
  startedAt: Date.now(),
  updatedAt: Date.now(),
  finishedAt: null,
  erro: null,
  skips: [],
  failures: [],
};

function fluxo(entries: readonly ContaJobOutcome[] = [], reatados: readonly string[] = []) {
  return { entries, reatados: new Set(reatados), dismiss: vi.fn() };
}

interface Cliente {
  massImportStatus: ReturnType<typeof vi.fn<ShopeeClient['massImportStatus']>>;
  priceSyncStatus: ReturnType<typeof vi.fn<ShopeeClient['priceSyncStatus']>>;
  priceSyncHistorico: ReturnType<typeof vi.fn<ShopeeClient['priceSyncHistorico']>>;
}

function setClient(historico: PriceSyncHistoricoShopee = { envios: [] }): Cliente {
  const c: Cliente = {
    massImportStatus: vi.fn<ShopeeClient['massImportStatus']>(async () => IMPORTACAO),
    priceSyncStatus: vi.fn<ShopeeClient['priceSyncStatus']>(async () => ENVIO),
    priceSyncHistorico: vi.fn<ShopeeClient['priceSyncHistorico']>(async () => historico),
  };
  h.clientRef.current = shopeeClientFalso(c);
  return c;
}

function renderPainel(props: {
  selecionadas?: readonly ContaRef[];
  importacao?: ReturnType<typeof fluxo>;
  precos?: ReturnType<typeof fluxo>;
  collapsed?: boolean;
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MantineTestProvider>
  );
  const importacao = props.importacao ?? fluxo();
  const precos = props.precos ?? fluxo();
  const utils = render(
    <ShopeeJobsPanel
      collapsed={props.collapsed ?? false}
      selecionadas={props.selecionadas ?? []}
      importacao={importacao}
      precos={precos}
    />,
    { wrapper },
  );
  return { ...utils, importacao, precos };
}

function guardados(): unknown {
  const bruto = window.sessionStorage.getItem(CHAVE_JOBS_RASTREADOS_SHOPEE);
  return bruto === null ? null : (JSON.parse(bruto) as unknown);
}

function guardar(valor: unknown): void {
  window.sessionStorage.setItem(CHAVE_JOBS_RASTREADOS_SHOPEE, JSON.stringify(valor));
}

beforeEach(() => {
  window.sessionStorage.clear();
  setClient();
});

describe('ShopeeJobsPanel', () => {
  it('uses the delfrance:shopee: storage key', () => {
    expect(CHAVE_JOBS_RASTREADOS_SHOPEE).toBe('delfrance:shopee:jobs:rastreados');
  });

  it('renders nothing with no selection and no job', () => {
    renderPainel({});
    expect(screen.queryByRole('region', { name: 'Jobs em andamento' })).toBeNull();
  });

  it('a started job gets a card polling its id, and is remembered for a reload', async () => {
    const c = setClient();
    renderPainel({
      importacao: fluxo([{ kind: 'started', conta: CONTA_A, jobId: 'job-i' }]),
    });

    expect(await screen.findByText(/40 encontrados/)).not.toBeNull();
    expect(c.massImportStatus).toHaveBeenCalledWith({ integracaoId: 'int-1', jobId: 'job-i' });
    await waitFor(() => {
      expect(guardados()).toEqual([{ flow: 'importacao', conta: CONTA_A, jobId: 'job-i' }]);
    });
  });

  it('⭐ a reload restores the card from sessionStorage and polls the STORED id — no click', async () => {
    guardar([
      { flow: 'importacao', conta: CONTA_A, jobId: 'job-guardado' },
      { flow: 'precos', conta: CONTA_B, jobId: 'job-p-guardado' },
    ]);
    const c = setClient();
    renderPainel({});

    expect(await screen.findByText(/40 encontrados/)).not.toBeNull();
    expect(await screen.findByText(/7 \/ 30 enviados/)).not.toBeNull();
    expect(c.massImportStatus).toHaveBeenCalledWith({
      integracaoId: 'int-1',
      jobId: 'job-guardado',
    });
    expect(c.priceSyncStatus).toHaveBeenCalledWith({
      integracaoId: 'int-2',
      jobId: 'job-p-guardado',
    });
  });

  it('a corrupt stored value is no list — and one bad entry never costs its siblings', async () => {
    window.sessionStorage.setItem(CHAVE_JOBS_RASTREADOS_SHOPEE, '{not json');
    const { unmount } = renderPainel({});
    expect(screen.queryByRole('region', { name: 'Jobs em andamento' })).toBeNull();
    unmount();

    guardar([
      { flow: 'outro', conta: CONTA_A, jobId: 'x' },
      { flow: 'importacao', conta: { id: '' }, jobId: 'y' },
      { flow: 'importacao', conta: CONTA_A, jobId: 'job-ok' },
    ]);
    const c = setClient();
    renderPainel({});

    expect(await screen.findByText(/40 encontrados/)).not.toBeNull();
    expect(c.massImportStatus).toHaveBeenCalledTimes(1);
    expect(c.massImportStatus).toHaveBeenCalledWith({ integracaoId: 'int-1', jobId: 'job-ok' });
  });

  it('a TERMINAL restored card stays until dismissed — the import has no Histórico to fall back on', async () => {
    guardar([{ flow: 'importacao', conta: CONTA_A, jobId: 'job-feito' }]);
    setClient().massImportStatus.mockResolvedValue({
      ...IMPORTACAO,
      status: IMPORTACAO_SHOPEE_STATUS.completed,
    });
    renderPainel({});

    expect(await screen.findByText('Importação concluída.')).not.toBeNull();
  });

  it('dismissing a card forgets it, in the tab AND in sessionStorage', async () => {
    guardar([{ flow: 'importacao', conta: CONTA_A, jobId: 'job-feito' }]);
    setClient().massImportStatus.mockResolvedValue({
      ...IMPORTACAO,
      status: IMPORTACAO_SHOPEE_STATUS.completed,
    });
    const { importacao } = renderPainel({});
    await screen.findByText('Importação concluída.');

    // Terminal ⇒ the X dismisses directly (nothing to cancel).
    fireEvent.click(screen.getByLabelText('Dispensar Importação em massa de Loja A'));

    await waitFor(() => {
      expect(screen.queryByText('Importação concluída.')).toBeNull();
    });
    expect(importacao.dismiss).toHaveBeenCalledWith('int-1');
    expect(guardados()).toBeNull();
  });

  it('a start this session WINS over a remembered job for the same conta', async () => {
    guardar([{ flow: 'importacao', conta: CONTA_A, jobId: 'job-velho' }]);
    const c = setClient();
    renderPainel({
      importacao: fluxo([{ kind: 'started', conta: CONTA_A, jobId: 'job-novo' }]),
    });

    await screen.findByText(/40 encontrados/);
    expect(c.massImportStatus).toHaveBeenCalledWith({ integracaoId: 'int-1', jobId: 'job-novo' });
    expect(c.massImportStatus).not.toHaveBeenCalledWith({
      integracaoId: 'int-1',
      jobId: 'job-velho',
    });
    // One card per (flow, conta).
    expect(screen.getAllByText(/40 encontrados/)).toHaveLength(1);
    await waitFor(() => {
      expect(guardados()).toEqual([{ flow: 'importacao', conta: CONTA_A, jobId: 'job-novo' }]);
    });
  });

  it('an attached job’s card carries the note; a failed start is a card that is NOT remembered', async () => {
    renderPainel({
      importacao: fluxo([{ kind: 'started', conta: CONTA_A, jobId: 'job-vivo' }], ['job-vivo']),
      precos: fluxo([
        {
          kind: 'error',
          conta: CONTA_B,
          color: 'red',
          message: 'Fila fechada (MissingRegionError).',
        },
      ]),
    });

    expect(
      await screen.findByText(
        /o painel passou a acompanhá-la. As opções escolhidas agora não foram aplicadas./,
      ),
    ).not.toBeNull();
    expect(screen.getByText('Fila fechada (MissingRegionError).')).not.toBeNull();
    await waitFor(() => {
      expect(guardados()).toEqual([{ flow: 'importacao', conta: CONTA_A, jobId: 'job-vivo' }]);
    });
  });

  it('one Histórico link per SELECTED conta, named after it, fetching nothing until opened', async () => {
    const c = setClient();
    renderPainel({ selecionadas: [CONTA_A, CONTA_B] });

    expect(
      screen.getByRole('button', { name: 'Histórico de atualizações de preços — Loja A' }),
    ).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Histórico de atualizações de preços — Loja B' }),
    ).not.toBeNull();
    expect(c.priceSyncHistorico).not.toHaveBeenCalled();
  });

  it('⭐ "Acompanhar" on a running Histórico row puts THAT run’s card on the rail, replacing this session’s', async () => {
    const c = setClient({
      envios: [{ ...ENVIO, jobId: 'job-de-outro', integracaoId: 'int-1' }],
    });
    // A STATEFUL ledger, as the action hook keeps it: "Acompanhar" must clear
    // this session's entry, or it would shadow the run just asked for.
    function Harness() {
      const [entries, setEntries] = useState<readonly ContaJobOutcome[]>([
        { kind: 'started', conta: CONTA_A, jobId: 'job-antigo' },
      ]);
      return (
        <ShopeeJobsPanel
          collapsed={false}
          selecionadas={[CONTA_A]}
          importacao={fluxo()}
          precos={{
            entries,
            reatados: new Set<string>(),
            dismiss: (contaId) => setEntries((cur) => cur.filter((e) => e.conta.id !== contaId)),
          }}
        />
      );
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MantineTestProvider>
        <QueryClientProvider client={qc}>
          <Harness />
        </QueryClientProvider>
      </MantineTestProvider>,
    );
    await waitFor(() => {
      expect(c.priceSyncStatus).toHaveBeenCalledWith({
        integracaoId: 'int-1',
        jobId: 'job-antigo',
      });
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Histórico de atualizações de preços — Loja A' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Acompanhar' }));

    await waitFor(() => {
      expect(c.priceSyncStatus).toHaveBeenCalledWith({
        integracaoId: 'int-1',
        jobId: 'job-de-outro',
      });
    });
    await waitFor(() => {
      expect(guardados()).toEqual([{ flow: 'precos', conta: CONTA_A, jobId: 'job-de-outro' }]);
    });
    expect(screen.getAllByText(/7 \/ 30 enviados/)).toHaveLength(1);
  });

  it('collapses to a badge carrying the card count', async () => {
    renderPainel({
      collapsed: true,
      importacao: fluxo([{ kind: 'started', conta: CONTA_A, jobId: 'job-i' }]),
      precos: fluxo([{ kind: 'error', conta: CONTA_A, color: 'red', message: 'x' }]),
    });
    expect(await screen.findByLabelText('2 job(s) em andamento')).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Jobs em andamento' })).toBeNull();
  });
});
