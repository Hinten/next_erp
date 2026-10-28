import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import { CODIGO_ERRO_LI, type RespostaGradeLi, type RespostaGradesLi } from '@delfrance/schemas';

import { QUERY_DEFAULT_OPTIONS } from '@/lib/query/QueryProvider';

/**
 * The variation linker's catalogue reads (master plan step 10): the two React
 * Query hooks over the backend client, and the linker's OWN copy for every way
 * such a read fails.
 *
 * Pinned, each with its near miss:
 *  - no read while the tab is not active, and none without a client;
 *  - "Atualizar" asks the backend for a fresh read once — the next automatic
 *    read does not;
 *  - freshness is counted from when the STORE was read (`lidaEmMs`), so the
 *    browser's cache never stacks on the backend's;
 *  - the copy: the switch off, a backend older than the routes (a 404 with no
 *    code), each catalogue code, and the transport failures.
 *
 * Only the backend hook is faked: the error classes are the REAL ones.
 */

const h = vi.hoisted(() => ({
  semCliente: false,
  grades: vi.fn(),
  grade: vi.fn(),
}));

vi.mock('@/lib/loja-integrada/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/loja-integrada/client')>();
  const { lojaIntegradaClientFalso } = await import('@/lib/testing/lojaIntegradaClientFalso');
  const client = lojaIntegradaClientFalso({ grades: h.grades, grade: h.grade });
  return {
    ...actual,
    useBackendLojaIntegrada: () =>
      h.semCliente ? { client: null, indisponivel: 'inseguro' } : { client, indisponivel: null },
  };
});

const {
  VALIDADE_CATALOGO_LI_MS,
  descreverFalhaCatalogoLi,
  staleTimeDoCatalogoLi,
  useGradeLi,
  useGradesLi,
} = await import('./catalogo');
const {
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
  LojaIntegradaClientRespostaInvalidaError,
  LojaIntegradaClientTempoEsgotadoError,
} = await import('./client');

const GRADES: RespostaGradesLi = {
  grades: [{ id: 8946, nome: 'Tamanho', nomeVisivel: null }],
  lidaEmMs: 1_790_000_000_000,
};
const GRADE: RespostaGradeLi = {
  grade: { id: 8946, nome: 'Tamanho', nomeVisivel: null },
  opcoes: [{ id: 37097, nome: 'P' }],
  lidaEmMs: 1_790_000_000_000,
};

function wrapper() {
  // The APP's defaults, so a default that would refetch behind the linker shows here.
  const qc = new QueryClient({ defaultOptions: QUERY_DEFAULT_OPTIONS });
  return function Host({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

beforeEach(() => {
  h.semCliente = false;
  h.grades.mockReset().mockResolvedValue(GRADES);
  h.grade.mockReset().mockResolvedValue(GRADE);
});

describe('useGradesLi — when the list is read', () => {
  it('reads nothing while the tab is not active; the first activation reads once, never fresh', async () => {
    const { result, rerender } = renderHook(
      ({ ativo }: { ativo: boolean }) => useGradesLi('conta-1', { habilitado: ativo }),
      { wrapper: wrapper(), initialProps: { ativo: false } },
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.grades).not.toHaveBeenCalled();

    rerender({ ativo: true });
    await waitFor(() => expect(result.current.dados).toEqual(GRADES));

    expect(h.grades).toHaveBeenCalledOnce();
    expect(h.grades).toHaveBeenCalledWith('conta-1', {
      atualizar: false,
      sinal: expect.any(AbortSignal),
    });
  });

  it('"Atualizar" asks for ONE fresh read; the next automatic read is a plain one again', async () => {
    const { result } = renderHook(() => useGradesLi('conta-1', { habilitado: true }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.dados).toEqual(GRADES));

    await act(async () => {
      result.current.atualizar();
    });
    await waitFor(() => expect(h.grades).toHaveBeenCalledTimes(2));
    expect(h.grades.mock.calls[1]?.[1]).toMatchObject({ atualizar: true });

    await act(async () => {
      await result.current.consulta.refetch();
    });
    expect(h.grades.mock.calls[2]?.[1]).toMatchObject({ atualizar: false });
  });

  it('without a client (logged out, or a backend this page may not call) nothing is read', async () => {
    h.semCliente = true;
    const { result } = renderHook(() => useGradesLi('conta-1', { habilitado: true }), {
      wrapper: wrapper(),
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(h.grades).not.toHaveBeenCalled();
    expect(result.current.indisponivel).toBe('inseguro');
  });

  it('a failed read is NOT repeated behind the operator', async () => {
    h.grades.mockRejectedValue(
      new LojaIntegradaClientHttpError('off', 503, CODIGO_ERRO_LI.chamadasDesligadas),
    );
    const { result } = renderHook(() => useGradesLi('conta-1', { habilitado: true }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.erro).not.toBeNull());

    expect(h.grades).toHaveBeenCalledOnce();
  });
});

describe('useGradeLi — one grade, on demand', () => {
  it('reads the grade asked for, only while active', async () => {
    const { result, rerender } = renderHook(
      ({ ativo }: { ativo: boolean }) => useGradeLi('conta-1', 8946, { habilitado: ativo }),
      { wrapper: wrapper(), initialProps: { ativo: false } },
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.grade).not.toHaveBeenCalled();

    rerender({ ativo: true });
    await waitFor(() => expect(result.current.dados).toEqual(GRADE));
    expect(h.grade).toHaveBeenCalledWith('conta-1', 8946, {
      atualizar: false,
      sinal: expect.any(AbortSignal),
    });
  });
});

describe('staleTimeDoCatalogoLi — fresh for 15 min after the STORE was read', () => {
  const lida = 1_790_000_000_000;

  it('a copy read from the store 14 min ago stays fresh for one more minute', () => {
    expect(VALIDADE_CATALOGO_LI_MS).toBe(15 * 60_000);
    expect(staleTimeDoCatalogoLi(lida, lida + 14 * 60_000)).toBe(60_000);
  });

  it('⚠️ NEAR-MISS: a copy the backend served from ITS cache 16 min after the store read is already stale', () => {
    // Counting from when the browser received it would stack both caches to 30 min.
    expect(staleTimeDoCatalogoLi(lida, lida + 16 * 60_000)).toBe(0);
  });

  it('no data yet ⇒ stale', () => {
    expect(staleTimeDoCatalogoLi(undefined, lida)).toBe(0);
  });
});

describe('descreverFalhaCatalogoLi — the linker’s own copy', () => {
  const http = (status: number, code: string | null) =>
    new LojaIntegradaClientHttpError('backend sentence', status, code);

  it('the switch off says the stored links can still be edited and saved', () => {
    const f = descreverFalhaCatalogoLi(http(503, CODIGO_ERRO_LI.chamadasDesligadas));
    expect(f.mensagem).toBe(
      'As listas da Loja Integrada só podem ser lidas depois da migração. Os vínculos já ' +
        'guardados aparecem abaixo e podem ser editados e salvos.',
    );
    expect(f.repetivel).toBe(false);
  });

  it('⭐ a 404 with NO code is a backend older than the routes', () => {
    const f = descreverFalhaCatalogoLi(http(404, null));
    expect(f.mensagem).toContain('este backend ainda não oferece a leitura');
    expect(f.repetivel).toBe(false);
  });

  it('⚠️ NEAR-MISS: a 404 WITH a code is that code, not an old backend', () => {
    const f = descreverFalhaCatalogoLi(http(404, CODIGO_ERRO_LI.contaNaoEncontrada));
    expect(f.mensagem).not.toContain('ainda não oferece');
    expect(f.mensagem).toContain('não encontrou esta conta');
  });

  it.each([
    [CODIGO_ERRO_LI.gradeAusenteNaLoja, 409, 'não existe mais na Loja Integrada', false],
    [CODIGO_ERRO_LI.catalogoExcedeLimite, 502, 'nada foi cortado', false],
    [CODIGO_ERRO_LI.recursoNaoPermitido, 502, 'não permitiu ler', false],
    [CODIGO_ERRO_LI.reconexaoPendente, 409, 'recusou o token', false],
    [CODIGO_ERRO_LI.credencialAusente, 409, 'não tem um token salvo', false],
    [CODIGO_ERRO_LI.limiteDeChamadas, 503, 'limitou as chamadas', true],
    [CODIGO_ERRO_LI.tempoEsgotadoLoja, 504, 'demorou demais', true],
    [CODIGO_ERRO_LI.lojaIndisponivel, 502, 'não respondeu como esperado', true],
  ] as const)('%s ⇒ its own copy', (code, status, trecho, repetivel) => {
    const f = descreverFalhaCatalogoLi(http(status, code));
    expect(f.mensagem).toContain(trecho);
    expect(f.mensagem).not.toContain('backend sentence');
    expect(f.repetivel).toBe(repetivel);
  });

  it('⭐ a 403 with no code is the operator’s permission (integrations read), not the store’s', () => {
    expect(descreverFalhaCatalogoLi(http(403, null)).mensagem).toContain('sem permissão');
  });

  it('a 2xx this build cannot read keeps its own message (MOST-DERIVED first)', () => {
    const err = new LojaIntegradaClientRespostaInvalidaError('formato desconhecido', 200, []);
    expect(descreverFalhaCatalogoLi(err).mensagem).toBe('formato desconhecido');
  });

  it('a deadline is not a network failure in the copy (MOST-DERIVED first)', () => {
    const tempo = descreverFalhaCatalogoLi(new LojaIntegradaClientTempoEsgotadoError());
    const rede = descreverFalhaCatalogoLi(new LojaIntegradaClientNetworkError());
    expect(tempo.mensagem).toContain('não respondeu a tempo');
    expect(rede.mensagem).toContain('falha de rede');
    expect(tempo.repetivel && rede.repetivel).toBe(true);
  });

  it('a session failure, and anything unknown, still get copy (total)', () => {
    expect(descreverFalhaCatalogoLi(new FirebaseError('auth/x', 'x')).mensagem).toContain('sessão');
    expect(descreverFalhaCatalogoLi(new RangeError('?')).mensagem).toContain(
      'Não foi possível ler',
    );
  });
});
