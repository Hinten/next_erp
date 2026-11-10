import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import { ZodError } from 'zod';
import {
  ACAO_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  CATEGORIAS_IMPORTACAO_LI,
  CODIGO_ERRO_LI,
  FASE_IMPORTACAO_LI,
  FOTOS_IMPORTACAO_LI,
  MODO_IMPORTACAO_LI,
  type RespostaImportacaoLi,
  type RespostaImportacoesLi,
  type RespostaItensImportacaoLi,
  type RespostaRevisaoFiscalLi,
  STATUS_IMPORTACAO_LI,
  type StatusImportacaoLi,
} from '@delfrance/schemas';

import { SEM_PROGRESSO_MS } from '@/lib/marketplace/contaJobs/cadencia';
import { QUERY_DEFAULT_OPTIONS } from '@/lib/query/QueryProvider';

/**
 * The import screen's reads and writes (master plan step 9): the hooks over the
 * backend client, the start's attach, the cache updates, and the copy for every
 * failure.
 *
 * Pinned, each with its near miss:
 *  - the cadence: 3 s while `pendente`/`executando`, none after; 45 minutes of
 *    silence on a job still running, strictly past;
 *  - a job's every answer lands in the cached list too; a whole read follows
 *    `proximo` and refuses a cursor that does not advance;
 *  - an ENDED job's report is read once and kept; a running job's is re-read
 *    when the job ends;
 *  - a busy start ATTACHES only on the exact code with a usable id;
 *  - the start describer narrows only this client's classes (`null` for
 *    anything else — the fan rethrows it); the cancel and read describers are
 *    total;
 *  - a 404 with no code is a backend without the import, never "not found".
 *
 * Only the backend hook is faked: the error classes are the REAL ones. The ids
 * are obviously fake.
 */

const h = vi.hoisted(() => ({
  semCliente: false,
  importacoes: vi.fn(),
  importacao: vi.fn(),
  iniciarImportacao: vi.fn(),
  cancelarImportacao: vi.fn(),
  itensImportacao: vi.fn(),
  revisaoImportacao: vi.fn(),
}));

vi.mock('@/lib/loja-integrada/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/loja-integrada/client')>();
  const { lojaIntegradaClientFalso } = await import('@/lib/testing/lojaIntegradaClientFalso');
  const client = lojaIntegradaClientFalso({
    importacoes: h.importacoes,
    importacao: h.importacao,
    iniciarImportacao: h.iniciarImportacao,
    cancelarImportacao: h.cancelarImportacao,
    itensImportacao: h.itensImportacao,
    revisaoImportacao: h.revisaoImportacao,
  });
  return {
    ...actual,
    useBackendLojaIntegrada: () =>
      h.semCliente ? { client: null, indisponivel: 'inseguro' } : { client, indisponivel: null },
  };
});

const {
  ERROS_DO_CLIENTE_LI,
  MAX_PAGINAS_IMPORTACAO_LI,
  MENSAGEM_BACKEND_SEM_IMPORTACAO_LI,
  MENSAGEM_BACKEND_SEM_REVISAO_FISCAL_LI,
  chaveImportacaoLi,
  chaveListaImportacoesLi,
  describeImportacaoLiStartError,
  descreverFalhaCancelamentoImportacaoLi,
  descreverFalhaLeituraImportacaoLi,
  descreverFalhaLeituraRevisaoFiscalLi,
  ehBackendSemImportacaoLi,
  intervaloImportacaoLi,
  jobIdDaImportacaoEmAndamentoLi,
  lerTodasAsPaginasLi,
  semProgressoImportacaoLi,
  substituirImportacaoNaLista,
  useAcoesImportacaoLi,
  useImportacaoLi,
  useImportacoesLi,
  useItensImportacaoLi,
  useRevisaoImportacaoLi,
} = await import('./importacao');
const {
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
  LojaIntegradaClientRespostaInvalidaError,
  LojaIntegradaClientTempoEsgotadoError,
} = await import('./client');

const T0 = 1_790_000_000_000;

function job(over: Partial<RespostaImportacaoLi> = {}): RespostaImportacaoLi {
  return {
    jobId: 'job-teste-1',
    integracaoId: 'conta-1',
    status: STATUS_IMPORTACAO_LI.executando,
    fase: FASE_IMPORTACAO_LI.familias,
    motivo: null,
    modo: MODO_IMPORTACAO_LI.simular,
    alvo: ALVO_IMPORTACAO_LI.todos,
    acao: ACAO_IMPORTACAO_LI.soVincular,
    categorias: CATEGORIAS_IMPORTACAO_LI.soVincular,
    fotos: FOTOS_IMPORTACAO_LI.naoImportar,
    selecionados: 0,
    simulacaoId: null,
    iniciadoEmMs: T0,
    atualizadoEmMs: T0,
    concluidoEmMs: null,
    contadores: {
      familias: 0,
      vinculados: 0,
      criados: 0,
      completados: 0,
      semMudanca: 0,
      pendenciasAcionaveis: 0,
      pendenciasInformativas: 0,
      fotos: 0,
      falhas: 0,
    },
    listagem: { paginas: 0, linhas: 0, totalLi: null, divergente: false },
    pausas429: 0,
    fotosIndisponiveis: false,
    ...over,
  };
}

function item(liId: number): RespostaItensImportacaoLi['itens'][number] {
  return {
    liId,
    tipo: 'normal',
    sku: `SKU-FALSO-${String(liId)}`,
    nome: null,
    filhos: 0,
    situacaoErp: 'ausente',
    erpId: null,
    acao: 'nenhuma',
    aplicada: false,
    camposPreenchidos: [],
    categoriasCriadas: [],
    pendencias: [],
    atualizadoEmMs: T0,
  };
}

const http = (status: number, code: string | null, detalhes: { jobId?: string | null } = {}) =>
  new LojaIntegradaClientHttpError(`mensagem do backend ${String(status)}`, status, code, detalhes);

function criarQc() {
  // The APP's defaults, so a default that would refetch behind the screen shows here.
  return new QueryClient({ defaultOptions: QUERY_DEFAULT_OPTIONS });
}

function wrapper(qc: QueryClient) {
  return function Host({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  h.semCliente = false;
  for (const f of [
    h.importacoes,
    h.importacao,
    h.iniciarImportacao,
    h.cancelarImportacao,
    h.itensImportacao,
    h.revisaoImportacao,
  ]) {
    f.mockReset();
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*                                 The cadence                                 */
/* -------------------------------------------------------------------------- */

describe('intervaloImportacaoLi', () => {
  it('polls every 3 s while the job is pendente or executando', () => {
    expect(intervaloImportacaoLi(job({ status: STATUS_IMPORTACAO_LI.pendente }))).toBe(3_000);
    expect(intervaloImportacaoLi(job({ status: STATUS_IMPORTACAO_LI.executando }))).toBe(3_000);
  });

  it.each([
    STATUS_IMPORTACAO_LI.concluido,
    STATUS_IMPORTACAO_LI.falhou,
    STATUS_IMPORTACAO_LI.cancelado,
  ])('stops once the job is %s, and before any status was read', (status: StatusImportacaoLi) => {
    expect(intervaloImportacaoLi(job({ status }))).toBe(false);
    expect(intervaloImportacaoLi(undefined)).toBe(false);
  });
});

describe('semProgressoImportacaoLi', () => {
  it('flags a running job one millisecond past 45 min since its last checkpoint', () => {
    const j = job({ atualizadoEmMs: T0 });
    expect(semProgressoImportacaoLi(j, T0 + SEM_PROGRESSO_MS + 1)).toBe(true);
    // NEAR MISS — exactly at the bound stays quiet.
    expect(semProgressoImportacaoLi(j, T0 + SEM_PROGRESSO_MS)).toBe(false);
  });

  it('counts from the creation before the first checkpoint, and a job stuck pendente counts', () => {
    const naFila = job({ status: STATUS_IMPORTACAO_LI.pendente, atualizadoEmMs: null });
    expect(semProgressoImportacaoLi(naFila, T0 + SEM_PROGRESSO_MS + 1)).toBe(true);
    expect(semProgressoImportacaoLi(naFila, T0 + SEM_PROGRESSO_MS)).toBe(false);
  });

  it('a later checkpoint resets the clock — it is read, not the creation', () => {
    const j = job({ atualizadoEmMs: T0 + 60_000 });
    expect(semProgressoImportacaoLi(j, T0 + SEM_PROGRESSO_MS + 1)).toBe(false);
  });

  it('never flags an ended job, or no data', () => {
    for (const status of [
      STATUS_IMPORTACAO_LI.concluido,
      STATUS_IMPORTACAO_LI.falhou,
      STATUS_IMPORTACAO_LI.cancelado,
    ]) {
      expect(semProgressoImportacaoLi(job({ status }), T0 + 24 * 3_600_000)).toBe(false);
    }
    expect(semProgressoImportacaoLi(undefined, T0)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                              The pure helpers                               */
/* -------------------------------------------------------------------------- */

describe('substituirImportacaoNaLista', () => {
  it('puts the fresh job in place of its namesake, keeping the order', () => {
    const lista: RespostaImportacoesLi = {
      importacoes: [job({ jobId: 'job-b' }), job({ jobId: 'job-a' })],
    };
    const fresco = job({ jobId: 'job-a', status: STATUS_IMPORTACAO_LI.concluido });

    expect(substituirImportacaoNaLista(lista, fresco).importacoes).toEqual([
      lista.importacoes[0],
      fresco,
    ]);
  });

  it('NEAR MISS — a job the list does not hold (even one id apart) leaves it untouched', () => {
    const lista: RespostaImportacoesLi = { importacoes: [job({ jobId: 'job-1' })] };

    expect(substituirImportacaoNaLista(lista, job({ jobId: 'job-10' }))).toBe(lista);
  });
});

describe('lerTodasAsPaginasLi', () => {
  it('follows `proximo` until it is null, in order', async () => {
    const paginas: Record<string, { itens: number[]; proximo: string | null }> = {
      '': { itens: [1, 2], proximo: 'c2' },
      c2: { itens: [3], proximo: 'c3' },
      c3: { itens: [4], proximo: null },
    };
    const ler = vi.fn(async (depois: string | null) => paginas[depois ?? '']!);

    await expect(lerTodasAsPaginasLi(ler, (p) => p.itens)).resolves.toEqual([1, 2, 3, 4]);
    expect(ler.mock.calls.map((c) => c[0])).toEqual([null, 'c2', 'c3']);
  });

  it('one page with `proximo: null` is the whole answer (today’s tax-review list)', async () => {
    const ler = vi.fn(async () => ({ itens: [1], proximo: null }));

    await expect(lerTodasAsPaginasLi(ler, (p) => p.itens)).resolves.toEqual([1]);
    expect(ler).toHaveBeenCalledOnce();
  });

  it.each([
    ['the same cursor again', ['c2', 'c2']],
    ['the first page’s empty cursor', ['']],
  ])('refuses %s as RESPOSTA_INVALIDA instead of looping', async (_nome, cursores) => {
    let i = 0;
    const ler = vi.fn(async () => ({ itens: [i], proximo: cursores[i++] ?? null }));

    const err = await lerTodasAsPaginasLi(ler, (p) => p.itens).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LojaIntegradaClientRespostaInvalidaError);
    expect((err as InstanceType<typeof LojaIntegradaClientHttpError>).campos).toEqual(['proximo']);
  });

  it(`stops at ${String(MAX_PAGINAS_IMPORTACAO_LI)} pages`, async () => {
    let n = 0;
    const ler = vi.fn(async () => ({ itens: [n], proximo: `c${String(++n)}` }));

    await expect(lerTodasAsPaginasLi(ler, (p) => p.itens)).rejects.toBeInstanceOf(
      LojaIntegradaClientRespostaInvalidaError,
    );
    expect(ler).toHaveBeenCalledTimes(MAX_PAGINAS_IMPORTACAO_LI);
  });
});

describe('jobIdDaImportacaoEmAndamentoLi — the attach', () => {
  it('reads the running job off a busy start', () => {
    expect(
      jobIdDaImportacaoEmAndamentoLi(
        http(409, CODIGO_ERRO_LI.importacaoEmAndamento, { jobId: 'job-em-curso-1' }),
      ),
    ).toBe('job-em-curso-1');
  });

  it.each([
    [
      'the cancel’s "still running" conflict, even with an id',
      http(503, CODIGO_ERRO_LI.importacaoEmConflito, { jobId: 'job-em-curso-1' }),
    ],
    ['an ended job', http(409, CODIGO_ERRO_LI.importacaoEncerrada, { jobId: 'job-em-curso-1' })],
    ['a busy start with no id (an older backend)', http(409, CODIGO_ERRO_LI.importacaoEmAndamento)],
    [
      'an id outside the job-id grammar',
      http(409, CODIGO_ERRO_LI.importacaoEmAndamento, { jobId: '../outro' }),
    ],
    ['a network failure', new LojaIntegradaClientNetworkError()],
    ['an error of no client', new Error('qualquer')],
  ])('NEAR MISS — %s never attaches', (_nome, err) => {
    expect(jobIdDaImportacaoEmAndamentoLi(err)).toBeNull();
  });
});

describe('ehBackendSemImportacaoLi — the feature probe', () => {
  it('a 404 with no code is a backend without the import', () => {
    expect(ehBackendSemImportacaoLi(http(404, null))).toBe(true);
  });

  it.each([
    ['a missing job', http(404, CODIGO_ERRO_LI.importacaoNaoEncontrada)],
    ['a missing conta', http(404, CODIGO_ERRO_LI.contaNaoEncontrada)],
    ['a 500 with no code', http(500, null)],
    ['a network failure', new LojaIntegradaClientNetworkError()],
  ])('NEAR MISS — %s is not', (_nome, err) => {
    expect(ehBackendSemImportacaoLi(err)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 The copy                                    */
/* -------------------------------------------------------------------------- */

describe('describeImportacaoLiStartError — the fan-out port', () => {
  it('⭐ returns null for anything that is not this client’s failure, so the fan RETHROWS it', () => {
    for (const err of [
      new Error('qualquer'),
      new TypeError('bug'),
      new FirebaseError('auth/network-request-failed', 'x'),
      new ZodError([]),
      'texto',
      undefined,
    ]) {
      expect(describeImportacaoLiStartError(err)).toBeNull();
    }
  });

  it('⭐ the switch off says the import runs only after the migration (yellow, a state)', () => {
    const d = describeImportacaoLiStartError(http(503, CODIGO_ERRO_LI.chamadasDesligadas));
    expect(d?.color).toBe('yellow');
    expect(d?.message).toContain('só funciona depois da migração');
    expect(d?.message).toContain('Nenhuma importação foi iniciada');
  });

  it('a busy start that could not attach says so; one that could reads as a state', () => {
    const semId = describeImportacaoLiStartError(http(409, CODIGO_ERRO_LI.importacaoEmAndamento));
    const comId = describeImportacaoLiStartError(
      http(409, CODIGO_ERRO_LI.importacaoEmAndamento, { jobId: 'job-em-curso-1' }),
    );

    expect(semId?.color).toBe('yellow');
    expect(semId?.message).toContain('Não foi possível identificá-la');
    expect(comId?.color).toBe('yellow');
    expect(comId?.message).not.toContain('Não foi possível identificá-la');
  });

  it('⭐ a 404 with no code is "not offered yet"; a coded 404 is its own copy', () => {
    expect(describeImportacaoLiStartError(http(404, null))).toEqual({
      color: 'yellow',
      message: MENSAGEM_BACKEND_SEM_IMPORTACAO_LI,
    });
    const conta = describeImportacaoLiStartError(http(404, CODIGO_ERRO_LI.contaNaoEncontrada));
    expect(conta?.message).not.toBe(MENSAGEM_BACKEND_SEM_IMPORTACAO_LI);
    expect(conta?.message).toContain('não encontrou esta conta');
  });

  it('a 400 names the refused fields, never values', () => {
    const err = new LojaIntegradaClientHttpError('x', 400, CODIGO_ERRO_LI.corpoInvalido, {
      campos: ['categorias', 'fotos'],
    });
    expect(describeImportacaoLiStartError(err)?.message).toContain('categorias, fotos');
  });

  it('401 and 403 each get their own sentence', () => {
    expect(describeImportacaoLiStartError(http(401, null))?.message).toContain('sessão');
    expect(describeImportacaoLiStartError(http(403, null))?.message).toContain(
      'permissão de escrita de Integrações',
    );
  });

  it('MOST-DERIVED FIRST — a deadline is yellow and says the job may have started; the network is red', () => {
    const prazo = describeImportacaoLiStartError(new LojaIntegradaClientTempoEsgotadoError());
    const rede = describeImportacaoLiStartError(new LojaIntegradaClientNetworkError());

    expect(prazo?.color).toBe('yellow');
    expect(prazo?.message).toContain('pode ter começado');
    expect(rede?.color).toBe('red');
    expect(rede?.message).toContain('falha de rede');
  });

  it('MOST-DERIVED FIRST — an unreadable 2xx says the job may have started', () => {
    const d = describeImportacaoLiStartError(
      new LojaIntegradaClientRespostaInvalidaError('formato x', 202, ['jobId']),
    );
    expect(d?.message).toBe(
      'formato x A importação pode ter sido iniciada: recarregue a página antes de tentar de novo.',
    );
  });

  it.each(Object.values(CODIGO_ERRO_LI))(
    '%s always gets copy (an HTTP error is never null)',
    (code) => {
      const d = describeImportacaoLiStartError(http(418, code));
      expect(d).not.toBeNull();
      expect(d?.message.length).toBeGreaterThan(0);
    },
  );
});

describe('descreverFalhaCancelamentoImportacaoLi — total', () => {
  it.each([
    [CODIGO_ERRO_LI.importacaoEncerrada, 409, 'já terminou'],
    [CODIGO_ERRO_LI.importacaoEmConflito, 503, 'tente cancelar de novo'],
    [CODIGO_ERRO_LI.importacaoNaoEncontrada, 404, 'não encontrada'],
  ])('%s', (code, status, trecho) => {
    expect(descreverFalhaCancelamentoImportacaoLi(http(status, code))).toContain(trecho);
  });

  it('a bare 404 is a backend without the import', () => {
    expect(descreverFalhaCancelamentoImportacaoLi(http(404, null))).toBe(
      MENSAGEM_BACKEND_SEM_IMPORTACAO_LI,
    );
  });

  it('a deadline may have landed; the network did not answer; anything else is generic copy', () => {
    expect(
      descreverFalhaCancelamentoImportacaoLi(new LojaIntegradaClientTempoEsgotadoError()),
    ).toContain('pode ter sido gravado');
    expect(descreverFalhaCancelamentoImportacaoLi(new LojaIntegradaClientNetworkError())).toContain(
      'Falha de rede',
    );
    expect(descreverFalhaCancelamentoImportacaoLi(new Error('qualquer'))).toBe(
      'Não foi possível cancelar a importação.',
    );
  });

  it('ERROS_DO_CLIENTE_LI names the client’s two base classes, so a subclass counts as described', () => {
    expect(ERROS_DO_CLIENTE_LI.tagLog).toBe('[loja-integrada]');
    const descrito = (err: unknown) => ERROS_DO_CLIENTE_LI.classes.some((C) => err instanceof C);
    expect(descrito(new LojaIntegradaClientTempoEsgotadoError())).toBe(true);
    expect(descrito(new LojaIntegradaClientRespostaInvalidaError('x', 200, []))).toBe(true);
    expect(descrito(new Error('qualquer'))).toBe(false);
  });
});

describe('descreverFalhaLeituraImportacaoLi — total', () => {
  it('⭐ the probe: no code ⇒ not offered; a coded 404 ⇒ the job is gone', () => {
    expect(descreverFalhaLeituraImportacaoLi(http(404, null))).toEqual({
      mensagem: MENSAGEM_BACKEND_SEM_IMPORTACAO_LI,
      repetivel: false,
    });
    expect(
      descreverFalhaLeituraImportacaoLi(http(404, CODIGO_ERRO_LI.importacaoNaoEncontrada)).mensagem,
    ).toContain('Importação não encontrada');
  });

  it('a 5xx and the network are worth repeating; a 4xx and an unknown error are not', () => {
    expect(descreverFalhaLeituraImportacaoLi(http(500, null)).repetivel).toBe(true);
    expect(descreverFalhaLeituraImportacaoLi(http(501, null)).repetivel).toBe(false);
    expect(descreverFalhaLeituraImportacaoLi(http(409, null)).repetivel).toBe(false);
    expect(descreverFalhaLeituraImportacaoLi(new LojaIntegradaClientNetworkError()).repetivel).toBe(
      true,
    );
    expect(descreverFalhaLeituraImportacaoLi(new FirebaseError('auth/x', 'x')).repetivel).toBe(
      true,
    );
    expect(descreverFalhaLeituraImportacaoLi(new Error('x'))).toEqual({
      mensagem: 'Não foi possível ler as importações de produtos.',
      repetivel: false,
    });
  });
});

describe('descreverFalhaLeituraRevisaoFiscalLi — the tax-review list’s own probe', () => {
  it('⭐ a 404 with no code says the LIST is missing, never the import', () => {
    expect(descreverFalhaLeituraRevisaoFiscalLi(http(404, null))).toEqual({
      mensagem: MENSAGEM_BACKEND_SEM_REVISAO_FISCAL_LI,
      repetivel: false,
    });
    expect(MENSAGEM_BACKEND_SEM_REVISAO_FISCAL_LI).not.toBe(MENSAGEM_BACKEND_SEM_IMPORTACAO_LI);
  });

  it('NEAR MISS — a coded 404 and an unreadable 404 keep the shared copy', () => {
    const naoEncontrada = http(404, CODIGO_ERRO_LI.importacaoNaoEncontrada);
    expect(descreverFalhaLeituraRevisaoFiscalLi(naoEncontrada)).toEqual(
      descreverFalhaLeituraImportacaoLi(naoEncontrada),
    );
    const ilegivel = new LojaIntegradaClientRespostaInvalidaError('ilegível', 404, []);
    expect(descreverFalhaLeituraRevisaoFiscalLi(ilegivel).mensagem).toBe('ilegível');
  });

  it('everything else is the shared read copy', () => {
    for (const err of [
      http(500, null),
      http(403, null),
      new LojaIntegradaClientNetworkError(),
      new Error('x'),
    ]) {
      expect(descreverFalhaLeituraRevisaoFiscalLi(err)).toEqual(
        descreverFalhaLeituraImportacaoLi(err),
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                                  The hooks                                  */
/* -------------------------------------------------------------------------- */

describe('useImportacoesLi', () => {
  it('reads nothing without a client, and nothing while disabled', async () => {
    h.semCliente = true;
    const qc = criarQc();
    const semCliente = renderHook(() => useImportacoesLi('conta-1'), { wrapper: wrapper(qc) });
    h.semCliente = false;
    renderHook(() => useImportacoesLi('conta-2', { habilitado: false }), { wrapper: wrapper(qc) });
    await tick();

    expect(h.importacoes).not.toHaveBeenCalled();
    expect(semCliente.result.current.indisponivel).toBe('inseguro');
  });

  it('reads the conta’s list once, with the query’s signal', async () => {
    h.importacoes.mockResolvedValue({ importacoes: [job()] });
    const { result } = renderHook(() => useImportacoesLi('conta-1'), {
      wrapper: wrapper(criarQc()),
    });

    await waitFor(() => expect(result.current.dados).toEqual({ importacoes: [job()] }));
    expect(h.importacoes).toHaveBeenCalledOnce();
    expect(h.importacoes).toHaveBeenCalledWith('conta-1', { sinal: expect.any(AbortSignal) });
  });
});

describe('useImportacaoLi — the polled card', () => {
  it('⭐ polls every 3 s while running and stops once the job ended', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.importacao
      .mockResolvedValueOnce(job())
      .mockResolvedValueOnce(job({ status: STATUS_IMPORTACAO_LI.concluido }));
    const { result } = renderHook(() => useImportacaoLi('conta-1', 'job-teste-1'), {
      wrapper: wrapper(criarQc()),
    });
    await waitFor(() => expect(result.current.dados?.status).toBe(STATUS_IMPORTACAO_LI.executando));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    await waitFor(() => expect(result.current.dados?.status).toBe(STATUS_IMPORTACAO_LI.concluido));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(h.importacao).toHaveBeenCalledTimes(2);
    expect(h.importacao).toHaveBeenCalledWith('conta-1', 'job-teste-1', {
      sinal: expect.any(AbortSignal),
    });
  });

  it('every answer is written into the cached list — no second request', async () => {
    const qc = criarQc();
    qc.setQueryData<RespostaImportacoesLi>(chaveListaImportacoesLi('conta-1'), {
      importacoes: [job({ jobId: 'job-teste-1' }), job({ jobId: 'job-teste-0' })],
    });
    h.importacao.mockResolvedValue(job({ status: STATUS_IMPORTACAO_LI.falhou }));

    renderHook(() => useImportacaoLi('conta-1', 'job-teste-1'), { wrapper: wrapper(qc) });

    await waitFor(() =>
      expect(
        qc
          .getQueryData<RespostaImportacoesLi>(chaveListaImportacoesLi('conta-1'))
          ?.importacoes.map((j) => j.status),
      ).toEqual([STATUS_IMPORTACAO_LI.falhou, STATUS_IMPORTACAO_LI.executando]),
    );
    expect(h.importacoes).not.toHaveBeenCalled();
  });

  it('a null jobId reads nothing', async () => {
    renderHook(() => useImportacaoLi('conta-1', null), { wrapper: wrapper(criarQc()) });
    await tick();

    expect(h.importacao).not.toHaveBeenCalled();
  });
});

describe('useItensImportacaoLi / useRevisaoImportacaoLi — the whole lists', () => {
  it('reads EVERY page of the report', async () => {
    h.itensImportacao.mockImplementation(async (_c: string, _j: string, depois: string | null) =>
      depois === null
        ? { itens: [item(1), item(2)], proximo: '2' }
        : { itens: [item(3)], proximo: null },
    );
    const { result } = renderHook(
      () =>
        useItensImportacaoLi('conta-1', {
          jobId: 'job-teste-1',
          status: STATUS_IMPORTACAO_LI.concluido,
        }),
      { wrapper: wrapper(criarQc()) },
    );

    await waitFor(() => expect(result.current.dados?.map((i) => i.liId)).toEqual([1, 2, 3]));
    expect(h.itensImportacao.mock.calls.map((c) => c[2])).toEqual([null, '2']);
  });

  it('⭐ an ENDED job’s report is read once and kept: a remount reads nothing', async () => {
    h.itensImportacao.mockResolvedValue({ itens: [item(1)], proximo: null });
    const qc = criarQc();
    const fim = { jobId: 'job-teste-1', status: STATUS_IMPORTACAO_LI.concluido };

    const primeiro = renderHook(() => useItensImportacaoLi('conta-1', fim), {
      wrapper: wrapper(qc),
    });
    await waitFor(() => expect(primeiro.result.current.dados).toHaveLength(1));
    primeiro.unmount();
    const segundo = renderHook(() => useItensImportacaoLi('conta-1', fim), {
      wrapper: wrapper(qc),
    });
    await tick();

    expect(segundo.result.current.dados).toHaveLength(1);
    expect(h.itensImportacao).toHaveBeenCalledOnce();
  });

  it('NEAR MISS — a running job’s report is a snapshot: the job ending reads the final one', async () => {
    h.itensImportacao
      .mockResolvedValueOnce({ itens: [item(1)], proximo: null })
      .mockResolvedValueOnce({ itens: [item(1), item(2)], proximo: null });
    const { result, rerender } = renderHook(
      ({ status }: { status: StatusImportacaoLi }) =>
        useItensImportacaoLi('conta-1', { jobId: 'job-teste-1', status }),
      {
        wrapper: wrapper(criarQc()),
        initialProps: { status: STATUS_IMPORTACAO_LI.executando as StatusImportacaoLi },
      },
    );
    await waitFor(() => expect(result.current.dados).toHaveLength(1));

    rerender({ status: STATUS_IMPORTACAO_LI.concluido });

    await waitFor(() => expect(result.current.dados).toHaveLength(2));
    expect(h.itensImportacao).toHaveBeenCalledTimes(2);
  });

  it('the tax-review list is read whole; no job reads nothing', async () => {
    const lista: RespostaRevisaoFiscalLi = {
      entradas: [
        {
          produtoId: 'produto-falso-1',
          motivos: ['produto-criado'],
          liId: null,
          desdeJobId: null,
          desdeMs: null,
        },
      ],
      proximo: null,
    };
    h.revisaoImportacao.mockResolvedValue(lista);
    const qc = criarQc();

    renderHook(() => useRevisaoImportacaoLi('conta-1', null), { wrapper: wrapper(qc) });
    await tick();
    expect(h.revisaoImportacao).not.toHaveBeenCalled();

    const { result } = renderHook(
      () =>
        useRevisaoImportacaoLi('conta-1', {
          jobId: 'job-teste-1',
          status: STATUS_IMPORTACAO_LI.concluido,
        }),
      { wrapper: wrapper(qc) },
    );
    await waitFor(() => expect(result.current.dados).toEqual(lista.entradas));
    expect(h.revisaoImportacao).toHaveBeenCalledWith('conta-1', 'job-teste-1', null, {
      sinal: expect.any(AbortSignal),
    });
  });
});

describe('useAcoesImportacaoLi — start and cancel', () => {
  const OPCOES = {
    modo: MODO_IMPORTACAO_LI.simular,
    alvo: ALVO_IMPORTACAO_LI.todos,
    acao: ACAO_IMPORTACAO_LI.soVincular,
  };

  it('is null without a client', () => {
    h.semCliente = true;
    const { result } = renderHook(() => useAcoesImportacaoLi(), { wrapper: wrapper(criarQc()) });
    expect(result.current).toBeNull();
  });

  it('a start resolves the new job and re-reads the conta’s list', async () => {
    const qc = criarQc();
    const invalidar = vi.spyOn(qc, 'invalidateQueries');
    h.iniciarImportacao.mockResolvedValue({ jobId: 'job-novo-1' });
    const { result } = renderHook(() => useAcoesImportacaoLi(), { wrapper: wrapper(qc) });

    await expect(result.current!.iniciar('conta-1', OPCOES)).resolves.toEqual({
      jobId: 'job-novo-1',
      reatado: false,
    });
    expect(h.iniciarImportacao).toHaveBeenCalledWith('conta-1', OPCOES);
    expect(invalidar).toHaveBeenCalledWith({ queryKey: chaveListaImportacoesLi('conta-1') });
  });

  it('⭐ a busy start ATTACHES to the running job instead of failing', async () => {
    h.iniciarImportacao.mockRejectedValue(
      http(409, CODIGO_ERRO_LI.importacaoEmAndamento, { jobId: 'job-em-curso-1' }),
    );
    const { result } = renderHook(() => useAcoesImportacaoLi(), { wrapper: wrapper(criarQc()) });

    await expect(result.current!.iniciar('conta-1', OPCOES)).resolves.toEqual({
      jobId: 'job-em-curso-1',
      reatado: true,
    });
  });

  it('NEAR MISS — every other failure rejects as itself, for the fan-out', async () => {
    const desligadas = http(503, CODIGO_ERRO_LI.chamadasDesligadas);
    const semId = http(409, CODIGO_ERRO_LI.importacaoEmAndamento);
    const bug = new TypeError('bug');
    const { result } = renderHook(() => useAcoesImportacaoLi(), { wrapper: wrapper(criarQc()) });

    for (const err of [desligadas, semId, bug]) {
      h.iniciarImportacao.mockRejectedValueOnce(err);
      await expect(result.current!.iniciar('conta-1', OPCOES)).rejects.toBe(err);
    }
  });

  it('a cancel writes the job as written into its query and the list', async () => {
    const qc = criarQc();
    qc.setQueryData<RespostaImportacoesLi>(chaveListaImportacoesLi('conta-1'), {
      importacoes: [job()],
    });
    const cancelado = job({ status: STATUS_IMPORTACAO_LI.cancelado });
    h.cancelarImportacao.mockResolvedValue(cancelado);
    const { result } = renderHook(() => useAcoesImportacaoLi(), { wrapper: wrapper(qc) });

    await expect(result.current!.cancelar('conta-1', 'job-teste-1')).resolves.toEqual(cancelado);

    expect(qc.getQueryData(chaveImportacaoLi('conta-1', 'job-teste-1'))).toEqual(cancelado);
    expect(
      qc.getQueryData<RespostaImportacoesLi>(chaveListaImportacoesLi('conta-1'))?.importacoes,
    ).toEqual([cancelado]);
  });

  it('a failed cancel re-reads the job and the list, and rejects as itself', async () => {
    const qc = criarQc();
    const invalidar = vi.spyOn(qc, 'invalidateQueries');
    const encerrada = http(409, CODIGO_ERRO_LI.importacaoEncerrada);
    h.cancelarImportacao.mockRejectedValue(encerrada);
    const { result } = renderHook(() => useAcoesImportacaoLi(), { wrapper: wrapper(qc) });

    await expect(result.current!.cancelar('conta-1', 'job-teste-1')).rejects.toBe(encerrada);

    expect(invalidar).toHaveBeenCalledWith({
      queryKey: chaveImportacaoLi('conta-1', 'job-teste-1'),
      exact: true,
    });
    expect(invalidar).toHaveBeenCalledWith({ queryKey: chaveListaImportacoesLi('conta-1') });
  });
});
