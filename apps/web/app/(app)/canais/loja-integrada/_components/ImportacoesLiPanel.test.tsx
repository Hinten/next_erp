import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MODO_IMPORTACAO_LI, STATUS_IMPORTACAO_LI } from '@delfrance/schemas';

import type { LojaIntegradaClient } from '@/lib/loja-integrada/client';
import type { ContaJobOutcome, ContaRef } from '@/lib/marketplace/contaJobs/types';
import { respostaImportacaoLiFalsa as job } from '@/lib/testing/importacaoLiFalsa';
import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';
import { MantineTestProvider } from '@/lib/testing/mantine';

/**
 * The rail's product-import panel (master plan step 9): which contas get a
 * card, which job each card follows, the failed start BESIDE the job card, and
 * dismissing. The card itself has its own suite.
 *
 * Only the backend hook is replaced; the hooks and the copy are the REAL ones.
 * The ids are obviously fake.
 */

const h = vi.hoisted(() => ({
  clientRef: { current: null as LojaIntegradaClient | null },
}));

vi.mock('@/lib/loja-integrada/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/loja-integrada/client')>();
  return {
    ...actual,
    useBackendLojaIntegrada: () => ({ client: h.clientRef.current, indisponivel: null }),
  };
});

const { ImportacoesLiPanel, contasDoPainelLi } = await import('./ImportacoesLiPanel');
const { LojaIntegradaClientHttpError } = await import('@/lib/loja-integrada/client');
const { MENSAGEM_BACKEND_SEM_IMPORTACAO_LI } = await import('@/lib/loja-integrada/importacao');

const A: ContaRef = { id: 'conta-a', nome: 'Conta A' };
const B: ContaRef = { id: 'conta-b', nome: 'Conta B' };

/** Ended jobs, so the cards render the list's copy and poll nothing. */
const ANTIGO = job({
  jobId: 'job-antigo',
  integracaoId: 'conta-a',
  status: STATUS_IMPORTACAO_LI.concluido,
});
const NOVO = job({
  jobId: 'job-novo',
  integracaoId: 'conta-a',
  status: STATUS_IMPORTACAO_LI.concluido,
  modo: MODO_IMPORTACAO_LI.simular,
});

function renderPainel({
  entries = [],
  selecionadas = [],
  collapsed = false,
  dismiss = vi.fn(),
}: {
  entries?: ContaJobOutcome[];
  selecionadas?: ContaRef[];
  collapsed?: boolean;
  dismiss?: (contaId: string) => void;
} = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <MantineTestProvider>
      <QueryClientProvider client={qc}>
        <ImportacoesLiPanel
          collapsed={collapsed}
          selecionadas={selecionadas}
          importacao={{ entries, reatados: new Set(), dismiss }}
          podeCancelar
        />
      </QueryClientProvider>
    </MantineTestProvider>,
  );
  return { dismiss, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('contasDoPainelLi', () => {
  it('the contas started this session first, then the selected ones, each once', () => {
    const entries: ContaJobOutcome[] = [{ kind: 'started', conta: B, jobId: 'job-b' }];
    expect(contasDoPainelLi(entries, [A, B])).toEqual([B, A]);
    expect(contasDoPainelLi([], [])).toEqual([]);
  });
});

describe('ImportacoesLiPanel', () => {
  it('⭐ a selected conta shows its NEWEST import, read from the backend’s list', async () => {
    const importacoes = vi.fn(async () => ({ importacoes: [NOVO, ANTIGO] }));
    h.clientRef.current = lojaIntegradaClientFalso({ importacoes });
    renderPainel({ selecionadas: [A] });

    expect(await screen.findByText('Simulação concluída: nada foi gravado no ERP.')).not.toBeNull();
    expect(screen.getAllByText('Conta A')).toHaveLength(1);
    expect(importacoes).toHaveBeenCalledWith('conta-a', expect.anything());
  });

  it('a selected conta with no import shows nothing', async () => {
    const importacoes = vi.fn(async () => ({ importacoes: [] }));
    h.clientRef.current = lojaIntegradaClientFalso({ importacoes });
    renderPainel({ selecionadas: [A] });

    await vi.waitFor(() => expect(importacoes).toHaveBeenCalled());
    expect(screen.queryByText('Conta A')).toBeNull();
  });

  it('nothing selected and nothing started: no panel at all', () => {
    h.clientRef.current = lojaIntegradaClientFalso();
    const { container } = renderPainel();
    expect(container.querySelector('[role="region"]')).toBeNull();
  });

  it('⭐ a start this session WINS over the list’s newest job', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      importacoes: vi.fn(async () => ({ importacoes: [NOVO, ANTIGO] })),
    });
    renderPainel({ entries: [{ kind: 'started', conta: A, jobId: 'job-antigo' }] });

    expect(await screen.findByText('Importação concluída.')).not.toBeNull();
    // NEAR MISS — the newer Simular the list leads with is not shown instead.
    expect(screen.queryByText('Simulação concluída: nada foi gravado no ERP.')).toBeNull();
  });

  it('⭐ a failed start shows BESIDE the list’s newest job, never instead of it', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      importacoes: vi.fn(async () => ({ importacoes: [ANTIGO] })),
    });
    renderPainel({
      entries: [{ kind: 'error', conta: A, color: 'yellow', message: 'Chamadas desligadas.' }],
    });

    expect(screen.getByText('Chamadas desligadas.')).not.toBeNull();
    expect(await screen.findByText('Importação concluída.')).not.toBeNull();
  });

  it('dismissing a failed start forgets only the failure', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      importacoes: vi.fn(async () => ({ importacoes: [ANTIGO] })),
    });
    const { dismiss } = renderPainel({
      entries: [{ kind: 'error', conta: A, color: 'red', message: 'Falhou.' }],
    });
    await screen.findByText('Importação concluída.');

    // The failure's card is the first X; the ended job's card the second.
    fireEvent.click(
      screen.getAllByRole('button', { name: /Dispensar Importação de produtos/ })[0]!,
    );

    expect(dismiss).toHaveBeenCalledWith('conta-a');
    expect(screen.getByText('Importação concluída.')).not.toBeNull();
  });

  it('⭐ dismissing a job card hides THAT job, and forgets the start that named it', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      importacoes: vi.fn(async () => ({ importacoes: [ANTIGO] })),
    });
    const { dismiss } = renderPainel({
      entries: [{ kind: 'started', conta: A, jobId: 'job-antigo' }],
      selecionadas: [A],
    });
    await screen.findByText('Importação concluída.');

    fireEvent.click(screen.getByRole('button', { name: /Dispensar Importação de produtos/ }));

    expect(dismiss).toHaveBeenCalledWith('conta-a');
    // Still selected, and still the list's newest: hidden all the same.
    expect(screen.queryByText('Importação concluída.')).toBeNull();
  });

  it('NEAR MISS — dismissing the list’s job leaves a ledger entry for ANOTHER job alone', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      importacoes: vi.fn(async () => ({ importacoes: [ANTIGO] })),
    });
    const { dismiss } = renderPainel({
      entries: [{ kind: 'error', conta: A, color: 'red', message: 'Falhou.' }],
    });
    await screen.findByText('Importação concluída.');

    fireEvent.click(
      screen.getAllByRole('button', { name: /Dispensar Importação de produtos/ })[1]!,
    );

    expect(dismiss).not.toHaveBeenCalled();
    expect(screen.getByText('Falhou.')).not.toBeNull();
    expect(screen.queryByText('Importação concluída.')).toBeNull();
  });

  it('a backend without the import routes says so on the selected conta', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      importacoes: vi.fn(async () => {
        throw new LojaIntegradaClientHttpError('Não encontrado.', 404, null);
      }),
    });
    renderPainel({ selecionadas: [A] });

    expect(await screen.findByText(MENSAGEM_BACKEND_SEM_IMPORTACAO_LI)).not.toBeNull();
    expect(screen.getByText('Conta A')).not.toBeNull();
  });

  it('collapsed: only the session’s count, and nothing when there is none', () => {
    h.clientRef.current = lojaIntegradaClientFalso();
    const { unmount } = renderPainel({
      collapsed: true,
      entries: [{ kind: 'started', conta: A, jobId: 'job-a' }],
    });
    expect(screen.getByLabelText('1 importação(ões) de produtos no painel').textContent).toBe('1');
    unmount();

    // A selection alone is not counted: its cards are per-conta reads.
    renderPainel({ collapsed: true, selecionadas: [B] });
    expect(screen.queryByLabelText(/importação\(ões\) de produtos no painel/)).toBeNull();
    expect(screen.queryByText('Conta B')).toBeNull();
  });
});
