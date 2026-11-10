import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCallback, useState } from 'react';
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
 * card, which job each card follows, the failed start BESIDE the job card, an
 * attached job's note, and dismissing — by JOB, kept across the panel's
 * remount, and undone by a start that names the job again. The card itself has
 * its own suite.
 *
 * Only the backend hook is replaced; the hooks and the copy are the REAL ones,
 * the dismissals the action hook's own (`useDispensasDeJobLi`). The harness
 * holds the ledger the way the fan-out does: one entry per conta, and its
 * `dismiss` drops the conta's entry. The ids are obviously fake.
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

const { ImportacoesLiPanel, contasDoPainelLi, jobDoPainelLi } =
  await import('./ImportacoesLiPanel');
const { useDispensasDeJobLi } = await import('./useImportarProdutosLiAction');
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

interface PropsDoPainel {
  entries?: ContaJobOutcome[];
  selecionadas?: ContaRef[];
  collapsed?: boolean;
  reatados?: ReadonlySet<string>;
  /** `false` unmounts the panel alone — the rail collapsed or expanded. */
  montado?: boolean;
}

/**
 * The page's side of the panel: a ledger whose `dismiss` drops the conta's
 * entry, and the action hook's dismissals ABOVE the panel. A new `entries`
 * from the test is a new ledger — a later start.
 */
function Pagina({
  entries: ledger,
  selecionadas,
  collapsed,
  reatados,
  montado,
  espiao,
}: Required<PropsDoPainel> & { espiao: (contaId: string) => void }) {
  const [entries, setEntries] = useState<readonly ContaJobOutcome[]>(ledger);
  // A new ledger from the test replaces the held one (React's "props changed"
  // pattern: during render, never in an effect).
  const [ledgerVisto, setLedgerVisto] = useState(ledger);
  if (ledger !== ledgerVisto) {
    setLedgerVisto(ledger);
    setEntries(ledger);
  }
  const dismiss = useCallback(
    (contaId: string) => {
      espiao(contaId);
      setEntries((cur) => cur.filter((e) => e.conta.id !== contaId));
    },
    [espiao],
  );
  const dispensas = useDispensasDeJobLi(entries, dismiss);
  if (!montado) return null;
  return (
    <ImportacoesLiPanel
      collapsed={collapsed}
      selecionadas={selecionadas}
      importacao={{ entries, reatados, dismiss, ...dispensas }}
      podeCancelar
    />
  );
}

function renderPainel(props: PropsDoPainel = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const dismiss = vi.fn<(contaId: string) => void>();
  const host = (p: PropsDoPainel) => (
    <MantineTestProvider>
      <QueryClientProvider client={qc}>
        <Pagina
          entries={p.entries ?? []}
          selecionadas={p.selecionadas ?? []}
          collapsed={p.collapsed ?? false}
          reatados={p.reatados ?? new Set()}
          montado={p.montado ?? true}
          espiao={dismiss}
        />
      </QueryClientProvider>
    </MantineTestProvider>
  );
  const utils = render(host(props));
  return { dismiss, ...utils, rerenderPainel: (p: PropsDoPainel) => utils.rerender(host(p)) };
}

const NOTA_DO_REATADO = /As opções escolhidas agora não foram aplicadas/;

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

describe('jobDoPainelLi', () => {
  const lista = [{ jobId: 'job-novo' }, { jobId: 'job-antigo' }];

  it('a start shadows the list, and shows its job even when that job was hidden', () => {
    const inicio: ContaJobOutcome = { kind: 'started', conta: A, jobId: 'job-antigo' };
    expect(jobDoPainelLi(inicio, lista, new Set(['job-antigo']))).toEqual({
      jobId: 'job-antigo',
      visivel: 'job-antigo',
    });
  });

  it('NEAR MISS — the list’s job, hidden, stays hidden; a failure falls through to the list', () => {
    expect(jobDoPainelLi(null, lista, new Set(['job-novo']))).toEqual({
      jobId: 'job-novo',
      visivel: null,
    });
    const falha: ContaJobOutcome = { kind: 'error', conta: A, color: 'red', message: 'x' };
    expect(jobDoPainelLi(falha, lista, new Set(['job-novo']))).toEqual({
      jobId: 'job-novo',
      visivel: null,
    });
    // Hidden by JOB, never by conta: another job of the same conta shows.
    expect(jobDoPainelLi(null, lista, new Set(['job-antigo', 'conta-a']))).toEqual({
      jobId: 'job-novo',
      visivel: 'job-novo',
    });
    expect(jobDoPainelLi(null, [], new Set())).toEqual({ jobId: null, visivel: null });
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
    // Selected, so the conta keeps its place once the ledger forgets it.
    const { dismiss } = renderPainel({
      entries: [{ kind: 'error', conta: A, color: 'red', message: 'Falhou.' }],
      selecionadas: [A],
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

  it('⭐ a start that names a job dismissed earlier shows it again — a busy start’s 409 attaching to it', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      importacoes: vi.fn(async () => ({ importacoes: [ANTIGO] })),
    });
    const { rerenderPainel } = renderPainel({
      entries: [{ kind: 'started', conta: A, jobId: 'job-antigo' }],
    });
    await screen.findByText('Importação concluída.');
    fireEvent.click(screen.getByRole('button', { name: /Dispensar Importação de produtos/ }));
    expect(screen.queryByText('Importação concluída.')).toBeNull();

    // A later "Importar produtos da loja" for the same conta met the 409 naming it.
    rerenderPainel({
      entries: [{ kind: 'started', conta: A, jobId: 'job-antigo' }],
      reatados: new Set(['job-antigo']),
    });

    expect(await screen.findByText('Importação concluída.')).not.toBeNull();
    expect(screen.getByText(NOTA_DO_REATADO)).not.toBeNull();
  });

  it('⭐ NEAR MISS — dismissed by JOB: a NEW job of the same conta shows, and the old one stays hidden', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      importacoes: vi.fn(async () => ({ importacoes: [ANTIGO] })),
      importacao: vi.fn(async () => NOVO),
    });
    const { rerenderPainel } = renderPainel({ selecionadas: [A] });
    await screen.findByText('Importação concluída.');
    fireEvent.click(screen.getByRole('button', { name: /Dispensar Importação de produtos/ }));
    expect(screen.queryByText('Importação concluída.')).toBeNull();

    rerenderPainel({
      selecionadas: [A],
      entries: [{ kind: 'started', conta: A, jobId: 'job-novo' }],
    });

    expect(await screen.findByText('Simulação concluída: nada foi gravado no ERP.')).not.toBeNull();
    expect(screen.queryByText('Importação concluída.')).toBeNull();
  });

  it('⭐ a dismissed card stays hidden across the panel’s remount (the rail collapsed and expanded)', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      importacoes: vi.fn(async () => ({ importacoes: [ANTIGO] })),
    });
    const { rerenderPainel } = renderPainel({ selecionadas: [A] });
    await screen.findByText('Importação concluída.');
    fireEvent.click(screen.getByRole('button', { name: /Dispensar Importação de produtos/ }));

    rerenderPainel({ selecionadas: [A], montado: false });
    rerenderPainel({ selecionadas: [A], montado: true });
    // The list answers again into a fresh panel: still nothing.
    await vi.waitFor(() => expect(screen.getByRole('region')).not.toBeNull());

    expect(screen.queryByText('Importação concluída.')).toBeNull();
  });

  it('⭐ an attached job’s card says the options were NOT applied', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      importacoes: vi.fn(async () => ({ importacoes: [ANTIGO] })),
    });
    renderPainel({
      entries: [{ kind: 'started', conta: A, jobId: 'job-antigo' }],
      reatados: new Set(['job-antigo']),
    });

    expect(await screen.findByText(NOTA_DO_REATADO)).not.toBeNull();
  });

  it.each([
    ['the conta’s id', new Set(['conta-a'])],
    ['another job’s id', new Set(['job-outro'])],
  ])(
    'NEAR MISS — an attach set holding %s: no note',
    async (_nome, reatados: ReadonlySet<string>) => {
      h.clientRef.current = lojaIntegradaClientFalso({
        importacoes: vi.fn(async () => ({ importacoes: [ANTIGO] })),
      });
      renderPainel({ entries: [{ kind: 'started', conta: A, jobId: 'job-antigo' }], reatados });

      await screen.findByText('Importação concluída.');
      expect(screen.queryByText(NOTA_DO_REATADO)).toBeNull();
    },
  );

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
