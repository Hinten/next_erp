import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

/**
 * The hook's own specs. The CSV builder next door had 16 and this had none, which
 * is precisely why its state machine went unexercised — the concurrency bug below
 * was invisible to a suite that only tested the pure `rows -> string` function.
 */

const h = vi.hoisted(() => ({
  clientRef: { current: null as null | Record<string, unknown> },
  saveBlob: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('@/lib/mercado-livre/client', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/mercado-livre/client')>();
  return { ...actual, useMercadoLivreClient: () => h.clientRef.current };
});
vi.mock('@/lib/nfe/saveBlob', () => ({ saveBlob: h.saveBlob }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

const { useBaixarRelatorioPreco } = await import('./useBaixarRelatorioPreco');

const ALVO_A = { jobId: 'A', contaId: 'c1', contaNome: 'Conta A' };
const ALVO_B = { jobId: 'B', contaId: 'c1', contaNome: 'Conta A' };

function pagina(over: Record<string, unknown> = {}) {
  return {
    linhas: [],
    proximoDepois: null,
    status: 'completed',
    relatorioLinhas: 1,
    relatorioShards: 1,
    relatorioCompleto: true,
    filaRestante: 0,
    planejados: 1,
    enviados: 1,
    pulados: 0,
    falhas: 0,
    startedAt: 1000,
    finishedAt: 2000,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.clientRef.current = { priceSyncRelatorio: vi.fn(async () => pagina()) };
});

describe('useBaixarRelatorioPreco', () => {
  it('downloads one report and hands the CSV to saveBlob', async () => {
    const { result } = renderHook(() => useBaixarRelatorioPreco());

    await act(async () => {
      await result.current.baixar(ALVO_A);
    });

    expect(h.saveBlob).toHaveBeenCalledTimes(1);
    expect(result.current.baixando).toBeNull();
  });

  it('⭐ REFUSES a second download while one is in flight', async () => {
    // The modal shares ONE hook across every row and Mantine disables only the
    // loading button, so a second row's click reached this callback. Two loops
    // then raced and the first to finish cleared the shared spinner while the
    // other was still fetching — against a backend with ~6 MiB of heap per
    // in-flight request.
    let liberar!: () => void;
    const bloqueada = new Promise<void>((r) => (liberar = r));
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async () => {
        await bloqueada;
        return pagina();
      })
      .mockImplementation(async () => pagina());
    h.clientRef.current = { priceSyncRelatorio: fetcher };

    const { result } = renderHook(() => useBaixarRelatorioPreco());

    let primeira!: Promise<void>;
    act(() => {
      primeira = result.current.baixar(ALVO_A);
    });
    await waitFor(() => {
      expect(result.current.baixando).toBe('A');
    });

    // The second click, while A is still fetching.
    await act(async () => {
      await result.current.baixar(ALVO_B);
    });

    expect(fetcher).toHaveBeenCalledTimes(1); // B never started a loop
    expect(result.current.baixando).toBe('A'); // A still owns the spinner

    liberar();
    await act(async () => {
      await primeira;
    });
    expect(result.current.baixando).toBeNull();
  });

  it('⚠️ but allows a NEW download once the first finished', async () => {
    // The control: the guard latches for the duration of a run, not forever.
    const { result } = renderHook(() => useBaixarRelatorioPreco());

    await act(async () => {
      await result.current.baixar(ALVO_A);
    });
    await act(async () => {
      await result.current.baixar(ALVO_B);
    });

    expect(h.saveBlob).toHaveBeenCalledTimes(2);
  });

  it('releases the guard when the download FAILS', async () => {
    // A guard that leaks on the error path would wedge the button for the rest
    // of the session, which is worse than the bug it fixes.
    // One fetcher that fails then succeeds — swapping `clientRef` would not
    // reach the memoized callback, which closes over the client it was built with.
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('offline');
      })
      .mockImplementation(async () => pagina());
    h.clientRef.current = { priceSyncRelatorio: fetcher };
    const { result } = renderHook(() => useBaixarRelatorioPreco());

    await act(async () => {
      await result.current.baixar(ALVO_A);
    });
    expect(h.notify).toHaveBeenCalled();
    expect(h.saveBlob).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.baixar(ALVO_A);
    });

    expect(h.saveBlob).toHaveBeenCalledTimes(1);
  });

  it('pages until proximoDepois is null, reporting progress', async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async () => pagina({ proximoDepois: '0003' }))
      .mockImplementationOnce(async () => pagina({ proximoDepois: null }));
    h.clientRef.current = { priceSyncRelatorio: fetcher };
    const { result } = renderHook(() => useBaixarRelatorioPreco());

    await act(async () => {
      await result.current.baixar(ALVO_A);
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0]).toMatchObject({ depois: '0003' });
  });

  it('⚠️ refuses to hand over an empty CSV for a run that predates the report', async () => {
    // `relatorioShards: 0` with `relatorioCompleto: false` means NO report
    // exists, not "nothing was planned". An empty file would read as "nothing to
    // change in the whole catalogue".
    h.clientRef.current = {
      priceSyncRelatorio: vi.fn(async () =>
        pagina({ relatorioShards: 0, relatorioCompleto: false }),
      ),
    };
    const { result } = renderHook(() => useBaixarRelatorioPreco());

    await act(async () => {
      await result.current.baixar(ALVO_A);
    });

    expect(h.saveBlob).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sem relatório' }));
  });
});
