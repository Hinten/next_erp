import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { SnapshotRow } from '@delfrance/data/hooks';
import type { Integracao } from '@delfrance/schemas';

const h = vi.hoisted(() => ({
  clientRef: { current: null as null | Record<string, unknown> },
  notify: vi.fn(),
}));

vi.mock('@/lib/mercado-livre/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/mercado-livre/client')>();
  return { ...actual, useMercadoLivreClient: () => h.clientRef.current };
});
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

const { usePriceSyncAction } = await import('./usePriceSyncAction');
const { MercadoLivreClientHttpError } = await import('@/lib/mercado-livre/client');

function row(id: string, nome: string): SnapshotRow<Integracao> {
  return { id, path: `integracao/${id}`, data: { nome } as unknown as Integracao };
}

describe('usePriceSyncAction', () => {
  it('caps the button at a single conta', () => {
    h.clientRef.current = { startPriceSync: vi.fn() };
    const { result } = renderHook(() => usePriceSyncAction());

    expect(result.current.action.maxSelection).toBe(1);
  });

  // Same as the mass import: the cap gates the click, not the ledger, which
  // stays total so every conta gets its own outcome.
  it('sends baixarPreco with every conta and records one entry each', async () => {
    const startPriceSync = vi.fn(async ({ integracaoId }: { integracaoId: string }) => ({
      jobId: `job-${integracaoId}`,
    }));
    h.clientRef.current = { startPriceSync };
    const { result } = renderHook(() => usePriceSyncAction());

    act(() => {
      void result.current.action.run([row('a', 'Conta A'), row('b', 'Conta B')]);
    });
    act(() => {
      result.current.state.setBaixarPreco(true);
    });
    await act(async () => {
      await result.current.state.start();
    });

    expect(startPriceSync).toHaveBeenCalledWith({ integracaoId: 'a', baixarPreco: true });
    expect(startPriceSync).toHaveBeenCalledWith({ integracaoId: 'b', baixarPreco: true });
    expect(result.current.state.entries.map((e) => e.kind)).toEqual(['started', 'started']);
  });

  it('re-arms baixarPreco to false on every open', () => {
    // A stale "permitir baixar preços" must never leak into a new opt-in. The
    // guard is structural — `run` replaces the dialog state object — so this
    // test pins the behaviour the old inline comment only asserted in prose.
    h.clientRef.current = { startPriceSync: vi.fn() };
    const { result } = renderHook(() => usePriceSyncAction());

    act(() => {
      void result.current.action.run([row('a', 'Conta A')]);
    });
    act(() => {
      result.current.state.setBaixarPreco(true);
    });
    expect(result.current.state.baixarPreco).toBe(true);

    act(() => {
      result.current.state.close();
    });
    act(() => {
      void result.current.action.run([row('a', 'Conta A')]);
    });

    expect(result.current.state.opened).toBe(true);
    expect(result.current.state.baixarPreco).toBe(false);
  });

  it('gives SEM_TABELA_NORMAL its own entry while the other conta still starts', async () => {
    h.clientRef.current = {
      startPriceSync: async ({ integracaoId }: { integracaoId: string }) => {
        if (integracaoId === 'a') {
          throw new MercadoLivreClientHttpError('sem tabela', 400, 'SEM_TABELA_NORMAL');
        }
        return { jobId: `job-${integracaoId}` };
      },
    };
    const { result } = renderHook(() => usePriceSyncAction());

    act(() => {
      void result.current.action.run([row('a', 'Conta A'), row('b', 'Conta B')]);
    });
    await act(async () => {
      await result.current.state.start();
    });

    expect(result.current.state.entries).toEqual([
      {
        kind: 'error',
        conta: { id: 'a', nome: 'Conta A' },
        color: 'red',
        message: 'Configure a tabela de preços normal da conta antes de enviar.',
      },
      { kind: 'started', conta: { id: 'b', nome: 'Conta B' }, jobId: 'job-b' },
    ]);
  });

  it('does not open the dialog while logged out', () => {
    h.clientRef.current = null;
    const { result } = renderHook(() => usePriceSyncAction());

    act(() => {
      void result.current.action.run([row('a', 'Conta A')]);
    });

    expect(result.current.state.opened).toBe(false);
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ color: 'red' }));
  });
});
