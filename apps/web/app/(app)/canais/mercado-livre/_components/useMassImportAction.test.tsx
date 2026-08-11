import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { SnapshotRow } from '@delfrance/data/hooks';
import type { Integracao } from '@delfrance/schemas';

// Mock only `useMercadoLivreClient`; the real error classes stay so the
// start-error map narrows correctly. Same hoisted-mock shape as
// canais/whatsapp/_components/ContaWhatsappHealth.test.tsx.
const h = vi.hoisted(() => ({
  clientRef: { current: null as null | Record<string, unknown> },
  notify: vi.fn(),
}));

vi.mock('@/lib/mercado-livre/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/mercado-livre/client')>();
  return { ...actual, useMercadoLivreClient: () => h.clientRef.current };
});
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

const { useMassImportAction } = await import('./useMassImportAction');
const { MercadoLivreClientHttpError } = await import('@/lib/mercado-livre/client');

const OPTIONS = {
  importarEstoque: true,
  sobrescreverEstoque: false,
  importarPreco: true,
  sobrescreverPreco: true,
  importarFotos: true,
  importarCategorias: true,
  atualizarProdutoPai: true,
  atualizarCadastrados: false,
};

function row(id: string, nome?: string): SnapshotRow<Integracao> {
  return { id, path: `integracao/${id}`, data: { nome } as unknown as Integracao };
}

function setClient(
  startMassImport: (input: { integracaoId: string }) => Promise<{ jobId: string }>,
) {
  h.clientRef.current = { startMassImport };
}

describe('useMassImportAction', () => {
  it('captures the selected contas into the dialog', () => {
    setClient(async ({ integracaoId }) => ({ jobId: `job-${integracaoId}` }));
    const { result } = renderHook(() => useMassImportAction());

    expect(result.current.state.opened).toBe(false);
    act(() => {
      void result.current.action.run([row('a', 'Conta A'), row('b', 'Conta B')]);
    });

    expect(result.current.state.opened).toBe(true);
    expect(result.current.state.contas).toEqual([
      { id: 'a', nome: 'Conta A' },
      { id: 'b', nome: 'Conta B' },
    ]);
  });

  it('falls back to the row id when the projection dropped `nome`', () => {
    // TableView projects only the visible columns, so hiding Nome strips the
    // field at runtime despite its non-optional type.
    setClient(async ({ integracaoId }) => ({ jobId: `job-${integracaoId}` }));
    const { result } = renderHook(() => useMassImportAction());

    act(() => {
      void result.current.action.run([row('sem-nome')]);
    });
    expect(result.current.state.contas).toEqual([{ id: 'sem-nome', nome: 'sem-nome' }]);
  });

  it('caps the button at a single conta', () => {
    setClient(async ({ integracaoId }) => ({ jobId: `job-${integracaoId}` }));
    const { result } = renderHook(() => useMassImportAction());

    expect(result.current.action.maxSelection).toBe(1);
  });

  // The cap above is a UI policy on one click; the ledger below stays total so
  // the rail can hold several jobs started one after another — and so a
  // partial failure is still reported per conta rather than as one toast.
  it('records one entry per conta — a 409 on one does not cost the other its job', async () => {
    setClient(async ({ integracaoId }) => {
      if (integracaoId === 'b') {
        throw new MercadoLivreClientHttpError('…', 409, 'ML_MASS_IMPORT_RUNNING');
      }
      return { jobId: `job-${integracaoId}` };
    });
    const { result } = renderHook(() => useMassImportAction());

    act(() => {
      void result.current.action.run([row('a', 'Conta A'), row('b', 'Conta B')]);
    });
    await act(async () => {
      await result.current.state.start(OPTIONS);
    });

    expect(result.current.state.entries).toEqual([
      { kind: 'started', conta: { id: 'a', nome: 'Conta A' }, jobId: 'job-a' },
      {
        kind: 'error',
        conta: { id: 'b', nome: 'Conta B' },
        color: 'yellow',
        message: 'Já existe uma importação em andamento.',
      },
    ]);
    // The dialog closes once the fan-out settles; results live in the rail.
    expect(result.current.state.opened).toBe(false);
  });

  it('re-running for a conta replaces its entry instead of stacking a second', async () => {
    let fail = true;
    setClient(async ({ integracaoId }) => {
      if (fail) throw new MercadoLivreClientHttpError('…', 409, 'ML_MASS_IMPORT_RUNNING');
      return { jobId: `job-${integracaoId}` };
    });
    const { result } = renderHook(() => useMassImportAction());

    act(() => {
      void result.current.action.run([row('a', 'Conta A')]);
    });
    await act(async () => {
      await result.current.state.start(OPTIONS);
    });
    expect(result.current.state.entries).toHaveLength(1);
    expect(result.current.state.entries[0]!.kind).toBe('error');

    fail = false;
    act(() => {
      void result.current.action.run([row('a', 'Conta A')]);
    });
    await act(async () => {
      await result.current.state.start(OPTIONS);
    });

    expect(result.current.state.entries).toEqual([
      { kind: 'started', conta: { id: 'a', nome: 'Conta A' }, jobId: 'job-a' },
    ]);
  });

  it('dismiss drops just that conta’s entry', async () => {
    setClient(async ({ integracaoId }) => ({ jobId: `job-${integracaoId}` }));
    const { result } = renderHook(() => useMassImportAction());

    act(() => {
      void result.current.action.run([row('a', 'Conta A'), row('b', 'Conta B')]);
    });
    await act(async () => {
      await result.current.state.start(OPTIONS);
    });
    act(() => {
      result.current.state.dismiss('a');
    });

    await waitFor(() => {
      expect(result.current.state.entries.map((e) => e.conta.id)).toEqual(['b']);
    });
  });

  it('does not open the dialog while logged out', () => {
    h.clientRef.current = null;
    const { result } = renderHook(() => useMassImportAction());

    act(() => {
      void result.current.action.run([row('a', 'Conta A')]);
    });

    expect(result.current.state.opened).toBe(false);
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ color: 'red' }));
  });
});
