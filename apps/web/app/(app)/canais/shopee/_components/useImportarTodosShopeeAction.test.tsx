import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { SnapshotRow } from '@delfrance/data/hooks';
import { SHOPEE_IMPORT_STATUS, type Integracao } from '@delfrance/schemas';

import type { ShopeeClient } from '@/lib/shopee/client';
import { shopeeClientFalso } from '@/lib/testing/shopeeClientFalso';

// Only `useShopeeClient` is replaced: the error classes stay REAL, because the
// attach and the describer narrow on them with `instanceof`.
const h = vi.hoisted(() => ({
  clientRef: { current: null as ShopeeClient | null },
  notify: vi.fn(),
}));

vi.mock('@/lib/shopee/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shopee/client')>();
  return { ...actual, useShopeeClient: () => h.clientRef.current };
});
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

const { useImportarTodosShopeeAction } = await import('./useImportarTodosShopeeAction');
const { ShopeeClientHttpError, ShopeeClientNetworkError } = await import('@/lib/shopee/client');
const { DETALHES_ERRO_SHOPEE_VAZIOS } = await import('@/lib/shopee/wire');

const OPCOES = {
  statuses: [SHOPEE_IMPORT_STATUS.normal, SHOPEE_IMPORT_STATUS.unlist],
  importarFotos: false,
};

function row(id: string, nome: string): SnapshotRow<Integracao> {
  return { id, path: `integracao/${id}`, data: { nome } as unknown as Integracao };
}

/** The busy start as the client builds it — `jobId` read into `detalhes`. */
function emAndamento(jobId: string | null): InstanceType<typeof ShopeeClientHttpError> {
  return new ShopeeClientHttpError(
    'Já existe uma importação em massa em andamento para esta conta.',
    409,
    'SHOPEE_MASS_IMPORT_RUNNING',
    null,
    null,
    { ...DETALHES_ERRO_SHOPEE_VAZIOS, jobId },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.clientRef.current = shopeeClientFalso({
    startMassImport: vi.fn(async ({ integracaoId }) => ({ jobId: `job-${integracaoId}` })),
  });
});

async function abrirEIniciar(
  result: { current: ReturnType<typeof useImportarTodosShopeeAction> },
  rows: SnapshotRow<Integracao>[],
): Promise<void> {
  act(() => {
    void result.current.action.run(rows);
  });
  await act(async () => {
    await result.current.state.start(OPCOES);
  });
}

describe('useImportarTodosShopeeAction', () => {
  it('is the shopee-importar-todos action, capped at ONE conta', () => {
    const { result } = renderHook(() => useImportarTodosShopeeAction());
    expect(result.current.action.id).toBe('shopee-importar-todos');
    expect(result.current.action.label).toBe('Importar todos os anúncios');
    expect(result.current.action.maxSelection).toBe(1);
    expect(result.current.action.requiresSelection).toBe(true);
  });

  it('captures the selected conta into the dialog', () => {
    const { result } = renderHook(() => useImportarTodosShopeeAction());
    act(() => {
      void result.current.action.run([row('a', 'Conta A')]);
    });
    expect(result.current.state.opened).toBe(true);
    expect(result.current.state.contas).toEqual([{ id: 'a', nome: 'Conta A' }]);
  });

  it('sends exactly the options the dialog built, and records the started job', async () => {
    const startMassImport = vi.fn(async () => ({ jobId: 'job-novo' }));
    h.clientRef.current = shopeeClientFalso({ startMassImport });
    const { result } = renderHook(() => useImportarTodosShopeeAction());

    await abrirEIniciar(result, [row('a', 'Conta A')]);

    expect(startMassImport).toHaveBeenCalledWith({ integracaoId: 'a', options: OPCOES });
    expect(result.current.state.entries).toEqual([
      { kind: 'started', conta: { id: 'a', nome: 'Conta A' }, jobId: 'job-novo' },
    ]);
    expect(result.current.state.reatados.size).toBe(0);
    // The dialog closes once the fan-out settles; the rail carries the result.
    expect(result.current.state.opened).toBe(false);
  });

  it('⭐ a busy start ATTACHES to the running job the 409 names — a card, not an error', async () => {
    h.clientRef.current = shopeeClientFalso({
      startMassImport: vi.fn(async () => {
        throw emAndamento('job-vivo');
      }),
    });
    const { result } = renderHook(() => useImportarTodosShopeeAction());

    await abrirEIniciar(result, [row('a', 'Conta A')]);

    expect(result.current.state.entries).toEqual([
      { kind: 'started', conta: { id: 'a', nome: 'Conta A' }, jobId: 'job-vivo' },
    ]);
    expect(result.current.state.reatados.has('job-vivo')).toBe(true);
  });

  it('a busy start from an older backend (no jobId) is a yellow entry, never a fake card', async () => {
    h.clientRef.current = shopeeClientFalso({
      startMassImport: vi.fn(async () => {
        throw emAndamento(null);
      }),
    });
    const { result } = renderHook(() => useImportarTodosShopeeAction());

    await abrirEIniciar(result, [row('a', 'Conta A')]);

    expect(result.current.state.entries).toEqual([
      {
        kind: 'error',
        conta: { id: 'a', nome: 'Conta A' },
        color: 'yellow',
        message:
          'Já existe uma importação em massa em andamento para esta conta. Não foi possível identificar o job para acompanhá-lo daqui.',
      },
    ]);
    expect(result.current.state.reatados.size).toBe(0);
  });

  it('a closed queue (503) is a red entry carrying the backend’s sentence', async () => {
    const frase =
      'Não foi possível enfileirar o primeiro despacho da importação (MissingRegionError).';
    h.clientRef.current = shopeeClientFalso({
      startMassImport: vi.fn(async () => {
        throw new ShopeeClientHttpError(frase, 503, 'SHOPEE_MASS_IMPORT_ENQUEUE_FAILED');
      }),
    });
    const { result } = renderHook(() => useImportarTodosShopeeAction());

    await abrirEIniciar(result, [row('a', 'Conta A')]);

    expect(result.current.state.entries).toEqual([
      { kind: 'error', conta: { id: 'a', nome: 'Conta A' }, color: 'red', message: frase },
    ]);
  });

  it('a network failure is a red entry, never an attach', async () => {
    h.clientRef.current = shopeeClientFalso({
      startMassImport: vi.fn(async () => {
        throw new ShopeeClientNetworkError('offline');
      }),
    });
    const { result } = renderHook(() => useImportarTodosShopeeAction());

    await abrirEIniciar(result, [row('a', 'Conta A')]);

    expect(result.current.state.entries).toEqual([
      {
        kind: 'error',
        conta: { id: 'a', nome: 'Conta A' },
        color: 'red',
        message: 'Falha de rede ao iniciar a importação.',
      },
    ]);
  });

  it('an error that is not ours is rethrown — AFTER the other contas’ outcomes are committed', async () => {
    h.clientRef.current = shopeeClientFalso({
      startMassImport: vi.fn(async ({ integracaoId }) => {
        if (integracaoId === 'b') throw new TypeError('bug');
        return { jobId: `job-${integracaoId}` };
      }),
    });
    const { result } = renderHook(() => useImportarTodosShopeeAction());
    act(() => {
      void result.current.action.run([row('a', 'Conta A'), row('b', 'Conta B')]);
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
      { kind: 'started', conta: { id: 'a', nome: 'Conta A' }, jobId: 'job-a' },
    ]);
  });

  it('does not open the dialog while logged out', () => {
    h.clientRef.current = null;
    const { result } = renderHook(() => useImportarTodosShopeeAction());
    act(() => {
      void result.current.action.run([row('a', 'Conta A')]);
    });
    expect(result.current.state.opened).toBe(false);
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ color: 'red' }));
  });
});
