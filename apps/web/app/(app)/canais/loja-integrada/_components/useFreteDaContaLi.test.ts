import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { PERM } from '@delfrance/auth';
import { escolherIntFreteMaisNovo } from '@delfrance/schemas';

/**
 * Which `int_frete` doc the Loja Integrada conta's freight tabs edit (step 20,
 * #1826). The listener is doubled at `useSnapshot`; the query it is handed is
 * recorded, so the test also pins WHAT is asked (raw bodies, the two
 * equalities of the step-20 index prefix).
 */

interface Linha {
  readonly id: string;
  readonly path: string;
  readonly data: Record<string, unknown>;
}

const h = vi.hoisted(() => ({
  permissoes: 0n,
  permissaoCarregando: false,
  snap: { data: undefined, loading: true, error: undefined, fromCache: undefined } as {
    data: Linha[] | undefined;
    loading: boolean;
    error: { message: string } | undefined;
    fromCache: boolean | undefined;
  },
  consultas: [] as unknown[],
  semConversor: 0,
}));

vi.mock('@/lib/auth', () => ({
  usePermission: (bit: bigint) => ({
    allowed: !h.permissaoCarregando && (h.permissoes & bit) === bit,
    loading: h.permissaoCarregando,
  }),
}));
vi.mock('@/lib/data/intFreteCollection', () => ({
  intFreteCollection: {
    ref: () => ({
      withConverter: (c: unknown) => {
        if (c === null) h.semConversor += 1;
        return { __col: 'int_frete', cru: c === null };
      },
    }),
  },
}));
vi.mock('@delfrance/data', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/data')>()),
  buildQuery: (base: object, cs: unknown[]) => ({ ...base, cs }),
  whereEqual: (campo: string, valor: unknown) => ({ campo, valor }),
}));
vi.mock('@delfrance/data/hooks', async (importActual) => ({
  ...(await importActual<typeof import('@delfrance/data/hooks')>()),
  useSnapshot: (q: unknown) => {
    h.consultas.push(q);
    return q === null ? { data: undefined, loading: false, error: undefined } : h.snap;
  },
}));

const { useFreteDaContaLi } = await import('./useFreteDaContaLi');

const db = {} as never;
const linha = (id: string, data: Record<string, unknown>): Linha => ({
  id,
  path: `int_frete/${id}`,
  data: { tipo: 'lojaIntegrada', ...data },
});
function servidor(linhas: Linha[]) {
  h.snap = { data: linhas, loading: false, error: undefined, fromCache: false };
}

beforeEach(() => {
  h.permissoes = PERM.frete.read;
  h.permissaoCarregando = false;
  h.snap = { data: undefined, loading: true, error: undefined, fromCache: undefined };
  h.consultas.length = 0;
  h.semConversor = 0;
});

describe('useFreteDaContaLi — the doc the freight tabs edit', () => {
  const ATIVO_ANTIGO = linha('a-antigo', { ativo: true, dataCadastro: 100 });
  const INATIVO_NOVO = linha('b-novo', { ativo: false, dataCadastro: 200 });

  it('(M30) an older ACTIVE doc beats a newer inactive one — the importer’s pick', () => {
    servidor([INATIVO_NOVO, ATIVO_ANTIGO]);
    const { result } = renderHook(() => useFreteDaContaLi(db, 'conta-1'));
    expect(result.current).toMatchObject({
      estado: 'encontrado',
      intFreteId: 'a-antigo',
      ativo: true,
      total: 2,
    });
  });

  it('NEAR-MISS (the fixture discriminates): the pick WITHOUT the ativo predicate is the inactive one', () => {
    expect(
      escolherIntFreteMaisNovo([
        { id: INATIVO_NOVO.id, data: INATIVO_NOVO.data },
        { id: ATIVO_ANTIGO.id, data: ATIVO_ANTIGO.data },
      ])?.id,
    ).toBe('b-novo');
  });

  it('reads the flag RAW: a doc with NO ativo is not active (a parsed body would default it to true)', () => {
    servidor([
      linha('sem-flag', { dataCadastro: 300 }),
      linha('ativo', { ativo: true, dataCadastro: 100 }),
    ]);
    const { result } = renderHook(() => useFreteDaContaLi(db, 'conta-1'));
    expect(result.current).toMatchObject({ estado: 'encontrado', intFreteId: 'ativo' });
  });

  it('an inactive-only conta falls back to its newest doc, shown as inactive', () => {
    servidor([
      linha('velho', { ativo: false, dataCadastro: 100 }),
      linha('novo', { ativo: false, dataCadastro: 200 }),
    ]);
    const { result } = renderHook(() => useFreteDaContaLi(db, 'conta-1'));
    expect(result.current).toMatchObject({
      estado: 'encontrado',
      intFreteId: 'novo',
      ativo: false,
      total: 2,
      naConsulta: true,
    });
  });

  it('a conta with no freight doc is ABSENT — once the server says so, never from the cache', () => {
    h.snap = { data: [], loading: false, error: undefined, fromCache: true };
    const { result, rerender } = renderHook(() => useFreteDaContaLi(db, 'conta-1'));
    expect(result.current).toEqual({ estado: 'carregando' });
    servidor([]);
    rerender();
    expect(result.current).toEqual({ estado: 'ausente' });
  });

  it('does not pick from a CACHE paint', () => {
    h.snap = { data: [ATIVO_ANTIGO], loading: false, error: undefined, fromCache: true };
    const { result } = renderHook(() => useFreteDaContaLi(db, 'conta-1'));
    expect(result.current).toEqual({ estado: 'carregando' });
  });

  it('freezes the choice: a later emission naming another doc never retargets the tabs', () => {
    servidor([ATIVO_ANTIGO]);
    const { result, rerender } = renderHook(() => useFreteDaContaLi(db, 'conta-1'));
    expect(result.current).toMatchObject({ intFreteId: 'a-antigo' });
    servidor([ATIVO_ANTIGO, linha('c-mais-novo', { ativo: true, dataCadastro: 900 })]);
    rerender();
    expect(result.current).toMatchObject({ intFreteId: 'a-antigo', total: 2 });
    // …and says so when the frozen doc leaves the conta's query.
    servidor([linha('c-mais-novo', { ativo: true, dataCadastro: 900 })]);
    rerender();
    expect(result.current).toMatchObject({ intFreteId: 'a-antigo', naConsulta: false });
  });

  it('another conta id chooses afresh', () => {
    servidor([ATIVO_ANTIGO]);
    const { result, rerender } = renderHook(({ id }) => useFreteDaContaLi(db, id), {
      initialProps: { id: 'conta-1' },
    });
    servidor([linha('outro', { ativo: true, dataCadastro: 1 })]);
    rerender({ id: 'conta-2' });
    expect(result.current).toMatchObject({ intFreteId: 'outro' });
  });

  it('asks for RAW bodies by tipo and the canonical back-ref — the step-20 index prefix', () => {
    servidor([]);
    renderHook(() => useFreteDaContaLi(db, 'conta-1'));
    expect(h.semConversor).toBeGreaterThan(0);
    expect(h.consultas.at(-1)).toEqual({
      __col: 'int_frete',
      cru: true,
      cs: [
        { campo: 'tipo', valor: 'lojaIntegrada' },
        { campo: 'contaLojaIntegradaEnviosOuterRef', valor: 'documents/integracao/conta-1' },
      ],
    });
  });

  it('without PERM.frete.read nothing is subscribed', () => {
    h.permissoes = 0n;
    servidor([ATIVO_ANTIGO]);
    const { result } = renderHook(() => useFreteDaContaLi(db, 'conta-1'));
    expect(result.current).toEqual({ estado: 'sem-permissao' });
    expect(h.consultas.every((q) => q === null)).toBe(true);
  });

  it('waits for the permission before saying anything', () => {
    h.permissaoCarregando = true;
    const { result } = renderHook(() => useFreteDaContaLi(db, 'conta-1'));
    expect(result.current).toEqual({ estado: 'carregando' });
  });

  it('reports a failed read', () => {
    h.snap = {
      data: undefined,
      loading: false,
      error: { message: 'negado' },
      fromCache: undefined,
    };
    const { result } = renderHook(() => useFreteDaContaLi(db, 'conta-1'));
    expect(result.current).toEqual({ estado: 'erro', mensagem: 'negado' });
  });
});
