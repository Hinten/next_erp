import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { SnapshotRow } from '@delfrance/data/hooks';
import type { Integracao } from '@delfrance/schemas';

import type { ShopeeClient } from '@/lib/shopee/client';
import { shopeeClientFalso } from '@/lib/testing/shopeeClientFalso';

// Only `useShopeeClient` is replaced; the error classes stay real (`instanceof`).
const h = vi.hoisted(() => ({
  clientRef: { current: null as ShopeeClient | null },
  notify: vi.fn(),
}));

vi.mock('@/lib/shopee/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shopee/client')>();
  return { ...actual, useShopeeClient: () => h.clientRef.current };
});
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

const { useAtualizarPrecosShopeeAction } = await import('./useAtualizarPrecosShopeeAction');
const { ShopeeClientHttpError } = await import('@/lib/shopee/client');
const { DETALHES_ERRO_SHOPEE_VAZIOS } = await import('@/lib/shopee/wire');

function row(id: string, nome: string): SnapshotRow<Integracao> {
  return { id, path: `integracao/${id}`, data: { nome } as unknown as Integracao };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.clientRef.current = shopeeClientFalso({
    startPriceSync: vi.fn(async ({ integracaoId }) => ({ jobId: `job-${integracaoId}` })),
  });
});

describe('useAtualizarPrecosShopeeAction', () => {
  it('is the shopee-atualizar-precos action, capped at ONE conta', () => {
    const { result } = renderHook(() => useAtualizarPrecosShopeeAction());
    expect(result.current.action.id).toBe('shopee-atualizar-precos');
    expect(result.current.action.maxSelection).toBe(1);
  });

  it('sends the operator’s baixarPreco and records the started run', async () => {
    const startPriceSync = vi.fn(async () => ({ jobId: 'job-p' }));
    h.clientRef.current = shopeeClientFalso({ startPriceSync });
    const { result } = renderHook(() => useAtualizarPrecosShopeeAction());

    act(() => {
      void result.current.action.run([row('a', 'Conta A')]);
    });
    act(() => {
      result.current.state.setBaixarPreco(true);
    });
    await act(async () => {
      await result.current.state.start();
    });

    expect(startPriceSync).toHaveBeenCalledWith({ integracaoId: 'a', baixarPreco: true });
    expect(result.current.state.entries).toEqual([
      { kind: 'started', conta: { id: 'a', nome: 'Conta A' }, jobId: 'job-p' },
    ]);
  });

  it('re-arms baixarPreco to false on every open', () => {
    const { result } = renderHook(() => useAtualizarPrecosShopeeAction());

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

  it('⭐ a busy start ATTACHES to the live run the 409 names', async () => {
    h.clientRef.current = shopeeClientFalso({
      startPriceSync: vi.fn(async () => {
        throw new ShopeeClientHttpError(
          'Já existe uma atualização de preços em andamento para esta conta.',
          409,
          'SHOPEE_PRICE_SYNC_RUNNING',
          null,
          null,
          { ...DETALHES_ERRO_SHOPEE_VAZIOS, jobId: 'job-vivo' },
        );
      }),
    });
    const { result } = renderHook(() => useAtualizarPrecosShopeeAction());

    act(() => {
      void result.current.action.run([row('a', 'Conta A')]);
    });
    await act(async () => {
      await result.current.state.start();
    });

    expect(result.current.state.entries).toEqual([
      { kind: 'started', conta: { id: 'a', nome: 'Conta A' }, jobId: 'job-vivo' },
    ]);
    expect(result.current.state.reatados.has('job-vivo')).toBe(true);
  });

  it('NEAR MISS — a second attach ADDS to the attached set; the first card keeps its note', async () => {
    // One conta per start (`maxSelection: 1`), so accumulation only shows across
    // two consecutive starts — each one a busy start on its own conta.
    h.clientRef.current = shopeeClientFalso({
      startPriceSync: vi.fn(async ({ integracaoId }) => {
        throw new ShopeeClientHttpError(
          'Já existe uma atualização de preços em andamento para esta conta.',
          409,
          'SHOPEE_PRICE_SYNC_RUNNING',
          null,
          null,
          { ...DETALHES_ERRO_SHOPEE_VAZIOS, jobId: `job-${integracaoId}` },
        );
      }),
    });
    const { result } = renderHook(() => useAtualizarPrecosShopeeAction());

    for (const r of [row('a', 'Conta A'), row('b', 'Conta B')]) {
      act(() => {
        void result.current.action.run([r]);
      });
      await act(async () => {
        await result.current.state.start();
      });
    }

    expect(result.current.state.entries).toEqual([
      { kind: 'started', conta: { id: 'a', nome: 'Conta A' }, jobId: 'job-a' },
      { kind: 'started', conta: { id: 'b', nome: 'Conta B' }, jobId: 'job-b' },
    ]);
    expect([...result.current.state.reatados].sort()).toEqual(['job-a', 'job-b']);
  });

  it('NEAR MISS — a quota pause carrying a jobId is NOT a run to attach to', async () => {
    h.clientRef.current = shopeeClientFalso({
      startPriceSync: vi.fn(async () => {
        throw new ShopeeClientHttpError('Conta pausada.', 409, 'SHOPEE_CONTA_PAUSADA', null, null, {
          ...DETALHES_ERRO_SHOPEE_VAZIOS,
          jobId: 'job-x',
          pausadoAte: '2026-10-15T03:00:00.000Z',
        });
      }),
    });
    const { result } = renderHook(() => useAtualizarPrecosShopeeAction());

    act(() => {
      void result.current.action.run([row('a', 'Conta A')]);
    });
    await act(async () => {
      await result.current.state.start();
    });

    expect(result.current.state.entries).toEqual([
      {
        kind: 'error',
        conta: { id: 'a', nome: 'Conta A' },
        color: 'yellow',
        message: 'A cota de chamadas da Shopee está esgotada até 15/10 00:00 — tente depois disso.',
      },
    ]);
    expect(result.current.state.reatados.size).toBe(0);
  });

  it('a conta with no tabela normal gets its own entry', async () => {
    h.clientRef.current = shopeeClientFalso({
      startPriceSync: vi.fn(async () => {
        throw new ShopeeClientHttpError('sem tabela', 400, 'SHOPEE_CONTA_SEM_TABELA_NORMAL');
      }),
    });
    const { result } = renderHook(() => useAtualizarPrecosShopeeAction());

    act(() => {
      void result.current.action.run([row('a', 'Conta A')]);
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
    ]);
  });

  it('does not open the dialog while logged out', () => {
    h.clientRef.current = null;
    const { result } = renderHook(() => useAtualizarPrecosShopeeAction());
    act(() => {
      void result.current.action.run([row('a', 'Conta A')]);
    });
    expect(result.current.state.opened).toBe(false);
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ color: 'red' }));
  });
});
