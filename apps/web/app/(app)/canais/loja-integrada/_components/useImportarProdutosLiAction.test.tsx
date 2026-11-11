import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SnapshotRow } from '@delfrance/data/hooks';
import {
  ACAO_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  CODIGO_ERRO_LI,
  type Integracao,
  MODO_IMPORTACAO_LI,
} from '@delfrance/schemas';

import type { LojaIntegradaClient, MotivoBackendLiIndisponivel } from '@/lib/loja-integrada/client';
import { lojaIntegradaClientFalso } from '@/lib/testing/lojaIntegradaClientFalso';

/**
 * "Importar produtos da loja" (master plan step 9): the action over the
 * selected contas, one start per conta through the shared fan-out, the attach
 * of a busy start, and the rethrow of what is not this client's failure.
 *
 * Only the backend hook is replaced: the error classes and the describer are
 * the REAL ones, because the attach and the describer narrow with `instanceof`.
 * The ids are obviously fake.
 */

const h = vi.hoisted(() => ({
  clientRef: { current: null as LojaIntegradaClient | null },
  indisponivel: null as MotivoBackendLiIndisponivel | null,
  notify: vi.fn(),
}));

vi.mock('@/lib/loja-integrada/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/loja-integrada/client')>();
  return {
    ...actual,
    useBackendLojaIntegrada: () => ({
      client: h.clientRef.current,
      indisponivel: h.indisponivel,
    }),
  };
});
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

const { useImportarProdutosLiAction } = await import('./useImportarProdutosLiAction');
const { LojaIntegradaClientHttpError, LojaIntegradaClientNetworkError } =
  await import('@/lib/loja-integrada/client');
const { mensagemBackendIndisponivel } = await import('@/lib/loja-integrada/erros');

const OPCOES = {
  modo: MODO_IMPORTACAO_LI.simular,
  alvo: ALVO_IMPORTACAO_LI.todos,
  acao: ACAO_IMPORTACAO_LI.soVincular,
};

function row(id: string, nome: string): SnapshotRow<Integracao> {
  return { id, path: `integracao/${id}`, data: { nome } as unknown as Integracao };
}

/** A busy start as the client builds it — the running job's id read off the envelope. */
function emAndamento(jobId: string | null) {
  return new LojaIntegradaClientHttpError(
    'Esta conta já tem uma importação em andamento.',
    409,
    CODIGO_ERRO_LI.importacaoEmAndamento,
    { jobId },
  );
}

function renderAcao() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useImportarProdutosLiAction(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children),
  });
}

async function abrirEIniciar(
  result: { current: ReturnType<typeof useImportarProdutosLiAction> },
  rows: SnapshotRow<Integracao>[],
): Promise<void> {
  act(() => {
    void result.current.action.run(rows);
  });
  await act(async () => {
    await result.current.state.start(OPCOES);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.indisponivel = null;
  h.clientRef.current = lojaIntegradaClientFalso({
    iniciarImportacao: vi.fn(async (contaId: string) => ({ jobId: `job-${contaId}` })),
    importacoes: vi.fn(async () => ({ importacoes: [] })),
  });
});

describe('useImportarProdutosLiAction', () => {
  it('is "Importar produtos da loja", for one or MANY selected contas', () => {
    const { result } = renderAcao();
    expect(result.current.action.id).toBe('loja-integrada-importar-produtos');
    expect(result.current.action.label).toBe('Importar produtos da loja');
    expect(result.current.action.requiresSelection).toBe(true);
    // Each conta reads its own store: no cap on the selection.
    expect(result.current.action.maxSelection).toBeUndefined();
  });

  it('captures the selected contas into the dialog', () => {
    const { result } = renderAcao();
    act(() => {
      void result.current.action.run([row('conta-a', 'Conta A'), row('conta-b', 'Conta B')]);
    });
    expect(result.current.state.opened).toBe(true);
    expect(result.current.state.contas).toEqual([
      { id: 'conta-a', nome: 'Conta A' },
      { id: 'conta-b', nome: 'Conta B' },
    ]);
  });

  it('starts ONE job per conta with the dialog’s options, and closes the dialog', async () => {
    const iniciarImportacao = vi.fn(async (contaId: string) => ({ jobId: `job-${contaId}` }));
    h.clientRef.current = lojaIntegradaClientFalso({
      iniciarImportacao,
      importacoes: vi.fn(async () => ({ importacoes: [] })),
    });
    const { result } = renderAcao();

    await abrirEIniciar(result, [row('conta-a', 'Conta A'), row('conta-b', 'Conta B')]);

    expect(iniciarImportacao.mock.calls).toEqual([
      ['conta-a', OPCOES],
      ['conta-b', OPCOES],
    ]);
    expect(result.current.state.entries).toEqual([
      { kind: 'started', conta: { id: 'conta-a', nome: 'Conta A' }, jobId: 'job-conta-a' },
      { kind: 'started', conta: { id: 'conta-b', nome: 'Conta B' }, jobId: 'job-conta-b' },
    ]);
    expect(result.current.state.reatados.size).toBe(0);
    expect(result.current.state.opened).toBe(false);
  });

  it('⭐ a busy start ATTACHES to the running job its 409 names — a card, not an error', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      iniciarImportacao: vi.fn(async () => {
        throw emAndamento('job-vivo');
      }),
      importacoes: vi.fn(async () => ({ importacoes: [] })),
    });
    const { result } = renderAcao();

    await abrirEIniciar(result, [row('conta-a', 'Conta A')]);

    expect(result.current.state.entries).toEqual([
      { kind: 'started', conta: { id: 'conta-a', nome: 'Conta A' }, jobId: 'job-vivo' },
    ]);
    expect([...result.current.state.reatados]).toEqual(['job-vivo']);
  });

  it('NEAR MISS — a 409 with ANOTHER code and a job id is a failure, never an attach', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      iniciarImportacao: vi.fn(async () => {
        throw new LojaIntegradaClientHttpError(
          'Conflito.',
          409,
          CODIGO_ERRO_LI.importacaoEmConflito,
          {
            jobId: 'job-vivo',
          },
        );
      }),
      importacoes: vi.fn(async () => ({ importacoes: [] })),
    });
    const { result } = renderAcao();

    await abrirEIniciar(result, [row('conta-a', 'Conta A')]);

    expect(result.current.state.entries).toEqual([
      {
        kind: 'error',
        conta: { id: 'conta-a', nome: 'Conta A' },
        color: 'red',
        message: 'Conflito.',
      },
    ]);
    expect(result.current.state.reatados.size).toBe(0);
  });

  it('NEAR MISS — the busy code with no usable id is a yellow entry, never a fake card', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      iniciarImportacao: vi.fn(async () => {
        throw emAndamento(null);
      }),
      importacoes: vi.fn(async () => ({ importacoes: [] })),
    });
    const { result } = renderAcao();

    await abrirEIniciar(result, [row('conta-a', 'Conta A')]);

    expect(result.current.state.entries).toEqual([
      {
        kind: 'error',
        conta: { id: 'conta-a', nome: 'Conta A' },
        color: 'yellow',
        message:
          'Esta conta já tem uma importação de produtos em andamento. Não foi possível identificá-la para acompanhá-la daqui: recarregue a página.',
      },
    ]);
    expect(result.current.state.reatados.size).toBe(0);
  });

  it('⭐ the read switch off (503) says the import works only after the migration — no card', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      iniciarImportacao: vi.fn(async () => {
        throw new LojaIntegradaClientHttpError(
          'Chamadas desligadas.',
          503,
          CODIGO_ERRO_LI.chamadasDesligadas,
        );
      }),
      importacoes: vi.fn(async () => ({ importacoes: [] })),
    });
    const { result } = renderAcao();

    await abrirEIniciar(result, [row('conta-a', 'Conta A')]);

    const [entrada] = result.current.state.entries;
    expect(entrada?.kind).toBe('error');
    if (entrada?.kind !== 'error') return;
    expect(entrada.color).toBe('yellow');
    expect(entrada.message).toMatch(/só funciona depois da migração para este sistema/);
    expect(entrada.message).toMatch(/Nenhuma importação foi iniciada\./);
  });

  it('a conta whose start fails costs the others nothing', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      iniciarImportacao: vi.fn(async (contaId: string) => {
        if (contaId === 'conta-a') throw new LojaIntegradaClientNetworkError();
        return { jobId: `job-${contaId}` };
      }),
      importacoes: vi.fn(async () => ({ importacoes: [] })),
    });
    const { result } = renderAcao();

    await abrirEIniciar(result, [row('conta-a', 'Conta A'), row('conta-b', 'Conta B')]);

    expect(result.current.state.entries.map((e) => e.kind)).toEqual(['error', 'started']);
  });

  it('an error that is not this client’s is rethrown — AFTER the other contas are committed', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      iniciarImportacao: vi.fn(async (contaId: string) => {
        if (contaId === 'conta-b') throw new TypeError('bug');
        return { jobId: `job-${contaId}` };
      }),
      importacoes: vi.fn(async () => ({ importacoes: [] })),
    });
    const { result } = renderAcao();
    act(() => {
      void result.current.action.run([row('conta-a', 'Conta A'), row('conta-b', 'Conta B')]);
    });

    let lancado: unknown = null;
    await act(async () => {
      await result.current.state.start(OPCOES).catch((err: unknown) => {
        lancado = err;
      });
    });

    expect(lancado).toBeInstanceOf(TypeError);
    // Conta A's job really started: losing its id would strand it.
    expect(result.current.state.entries).toEqual([
      { kind: 'started', conta: { id: 'conta-a', nome: 'Conta A' }, jobId: 'job-conta-a' },
    ]);
  });

  it('`iniciar` starts for the contas it is given, through the same ledger, without the dialog', async () => {
    const iniciarImportacao = vi.fn(async () => ({ jobId: 'job-selecao' }));
    h.clientRef.current = lojaIntegradaClientFalso({
      iniciarImportacao,
      importacoes: vi.fn(async () => ({ importacoes: [] })),
    });
    const { result } = renderAcao();
    const selecao = {
      modo: MODO_IMPORTACAO_LI.aplicar,
      alvo: ALVO_IMPORTACAO_LI.selecionados,
      acao: ACAO_IMPORTACAO_LI.soVincular,
      selecionados: [182904918],
    };

    await act(async () => {
      await result.current.state.iniciar([{ id: 'conta-a', nome: 'Conta A' }], selecao);
    });

    expect(iniciarImportacao).toHaveBeenCalledWith('conta-a', selecao);
    expect(result.current.state.entries).toEqual([
      { kind: 'started', conta: { id: 'conta-a', nome: 'Conta A' }, jobId: 'job-selecao' },
    ]);
    expect(result.current.state.opened).toBe(false);
  });

  it('⭐ `iniciar` resolves EACH conta’s outcome: a fresh start, an attach, a failure', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      iniciarImportacao: vi.fn(async (contaId: string) => {
        if (contaId === 'conta-b') throw emAndamento('job-vivo');
        if (contaId === 'conta-c') throw new LojaIntegradaClientNetworkError();
        return { jobId: `job-${contaId}` };
      }),
      importacoes: vi.fn(async () => ({ importacoes: [] })),
    });
    const { result } = renderAcao();
    const contas = [
      { id: 'conta-a', nome: 'Conta A' },
      { id: 'conta-b', nome: 'Conta B' },
      { id: 'conta-c', nome: 'Conta C' },
    ];

    let desfechos: unknown = null;
    await act(async () => {
      desfechos = await result.current.state.iniciar(contas, OPCOES);
    });

    expect(desfechos).toEqual([
      { kind: 'started', conta: contas[0], jobId: 'job-conta-a', reatado: false },
      // NEAR MISS — the same `started` kind, but an attach: the options were NOT applied.
      { kind: 'started', conta: contas[1], jobId: 'job-vivo', reatado: true },
      {
        kind: 'error',
        conta: contas[2],
        color: 'red',
        message: expect.stringMatching(/falha de rede/),
      },
    ]);
  });

  it('`iniciar` with no client starts nothing, says so, and resolves no outcome', async () => {
    h.clientRef.current = null;
    const { result } = renderAcao();

    let desfechos: unknown = null;
    await act(async () => {
      desfechos = await result.current.state.iniciar([{ id: 'conta-a', nome: 'Conta A' }], OPCOES);
    });

    expect(desfechos).toEqual([]);
    expect(h.notify).toHaveBeenCalledWith({
      color: 'red',
      message: 'Faça login novamente para usar as ações da Loja Integrada.',
    });
  });

  it('⭐ dismissing a job card hides that JOB and forgets the start that named it — never a failure', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      iniciarImportacao: vi.fn(async (contaId: string) => {
        if (contaId === 'conta-b') throw new LojaIntegradaClientNetworkError();
        return { jobId: `job-${contaId}` };
      }),
      importacoes: vi.fn(async () => ({ importacoes: [] })),
    });
    const { result } = renderAcao();
    await abrirEIniciar(result, [row('conta-a', 'Conta A'), row('conta-b', 'Conta B')]);

    act(() => {
      result.current.state.dispensarJob('conta-a', 'job-conta-a');
      // Conta B's ledger entry is a failure: hiding a job of B leaves it alone.
      result.current.state.dispensarJob('conta-b', 'job-qualquer');
    });

    expect([...result.current.state.dispensados]).toEqual(['job-conta-a', 'job-qualquer']);
    expect(result.current.state.entries.map((e) => [e.conta.id, e.kind])).toEqual([
      ['conta-b', 'error'],
    ]);
  });

  it('NEAR MISS — hiding ANOTHER job of a conta keeps the start that names a different one', async () => {
    h.clientRef.current = lojaIntegradaClientFalso({
      iniciarImportacao: vi.fn(async (contaId: string) => ({ jobId: `job-${contaId}` })),
      importacoes: vi.fn(async () => ({ importacoes: [] })),
    });
    const { result } = renderAcao();
    await abrirEIniciar(result, [row('conta-a', 'Conta A')]);

    act(() => {
      // An older job of the same conta: its card hides, the session's start stays.
      result.current.state.dispensarJob('conta-a', 'job-anterior');
    });

    expect([...result.current.state.dispensados]).toEqual(['job-anterior']);
    expect(result.current.state.entries.map((e) => [e.conta.id, e.kind])).toEqual([
      ['conta-a', 'started'],
    ]);
  });

  it('does not open the dialog while logged out', () => {
    h.clientRef.current = null;
    const { result } = renderAcao();
    act(() => {
      void result.current.action.run([row('conta-a', 'Conta A')]);
    });
    expect(result.current.state.opened).toBe(false);
    expect(h.notify).toHaveBeenCalledWith({
      color: 'red',
      message: 'Faça login novamente para usar as ações da Loja Integrada.',
    });
  });

  it('NEAR MISS — logged in but with an unusable backend URL, it says THAT instead', () => {
    h.clientRef.current = null;
    h.indisponivel = 'inseguro';
    const { result } = renderAcao();
    act(() => {
      void result.current.action.run([row('conta-a', 'Conta A')]);
    });
    expect(result.current.state.opened).toBe(false);
    expect(h.notify).toHaveBeenCalledWith({
      color: 'red',
      message: mensagemBackendIndisponivel('inseguro'),
    });
  });
});
