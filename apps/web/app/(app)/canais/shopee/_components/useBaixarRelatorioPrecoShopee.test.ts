import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  ENVIO_PRECO_FASE,
  ENVIO_PRECO_RESULTADO,
  ENVIO_PRECO_SHOPEE_STATUS,
} from '@delfrance/schemas';

import { MAX_PAGINAS_RELATORIO_PRECO } from '@/lib/marketplace/contaJobs/envioPrecoCsv';
import type { ShopeeClient } from '@/lib/shopee/client';
import type {
  PriceSyncRelatorioLinhaShopee,
  PriceSyncRelatorioPaginaShopee,
  PriceSyncStatusShopee,
} from '@/lib/shopee/wire';
import { shopeeClientFalso } from '@/lib/testing/shopeeClientFalso';

const h = vi.hoisted(() => ({
  clientRef: { current: null as ShopeeClient | null },
  saveBlob: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('@/lib/shopee/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shopee/client')>();
  return { ...actual, useShopeeClient: () => h.clientRef.current };
});
vi.mock('@/lib/nfe/saveBlob', () => ({ saveBlob: h.saveBlob }));
vi.mock('@mantine/notifications', () => ({ notifications: { show: h.notify } }));

const { useBaixarRelatorioPrecoShopee } = await import('./useBaixarRelatorioPrecoShopee');
const { ShopeeClientNetworkError } = await import('@/lib/shopee/client');

const ALVO_A = { jobId: 'A', contaId: 'int-1', contaNome: 'Loja A' };
const ALVO_B = { jobId: 'B', contaId: 'int-1', contaNome: 'Loja A' };

/** A Shopee report row — the 13 keys the route sends, no `variacoes`. */
function linha(over: Partial<PriceSyncRelatorioLinhaShopee> = {}): PriceSyncRelatorioLinhaShopee {
  return {
    produtoId: 'p1',
    variacaoProdutoId: null,
    anuncioId: '1000001',
    linkDocId: 'l1',
    resultado: ENVIO_PRECO_RESULTADO.enviado,
    fase: ENVIO_PRECO_FASE.envio,
    motivo: null,
    mensagem: 'Enviado.',
    erro: null,
    preco: 12.5,
    precoAnterior: 10,
    produtoNome: 'Camiseta',
    sku: 'CAM-1',
    ...over,
  };
}

function pagina(
  over: Partial<PriceSyncRelatorioPaginaShopee> = {},
): PriceSyncRelatorioPaginaShopee {
  return {
    linhas: [linha()],
    proximoDepois: null,
    status: ENVIO_PRECO_SHOPEE_STATUS.completed,
    relatorioCompleto: true,
    filaRestante: 0,
    ...over,
  };
}

function status(over: Partial<PriceSyncStatusShopee> = {}): PriceSyncStatusShopee {
  return {
    jobId: 'A',
    status: ENVIO_PRECO_SHOPEE_STATUS.completed,
    baixarPreco: false,
    planejados: 7,
    enviados: 5,
    pulados: 1,
    falhas: 1,
    pausas: 0,
    parques: 0,
    filaRestante: 0,
    relatorioShards: 1,
    retomarEm: null,
    relatorioCompleto: true,
    startedAt: new Date(2026, 9, 14, 15, 30).getTime(),
    updatedAt: 0,
    finishedAt: 0,
    erro: null,
    skips: [],
    failures: [],
    ...over,
  };
}

interface Cliente {
  priceSyncRelatorio: ReturnType<typeof vi.fn<ShopeeClient['priceSyncRelatorio']>>;
  priceSyncStatus: ReturnType<typeof vi.fn<ShopeeClient['priceSyncStatus']>>;
}

function setClient(over: Partial<Cliente> = {}): Cliente {
  const c: Cliente = {
    priceSyncRelatorio: vi.fn<ShopeeClient['priceSyncRelatorio']>(async () => pagina()),
    priceSyncStatus: vi.fn<ShopeeClient['priceSyncStatus']>(async () => status()),
    ...over,
  };
  h.clientRef.current = shopeeClientFalso(c);
  return c;
}

/** The text of the ONE CSV handed to the browser. */
async function csvBaixado(): Promise<{ texto: string; nome: string }> {
  expect(h.saveBlob).toHaveBeenCalledTimes(1);
  const [blob, nome] = h.saveBlob.mock.calls[0] as [Blob, string];
  return { texto: await blob.text(), nome };
}

beforeEach(() => {
  vi.clearAllMocks();
  setClient();
});

describe('useBaixarRelatorioPrecoShopee', () => {
  it('pages until proximoDepois is null, then reads the status ONCE — after the last page', async () => {
    const ordem: string[] = [];
    const c = setClient({
      priceSyncRelatorio: vi
        .fn<ShopeeClient['priceSyncRelatorio']>()
        .mockImplementationOnce(async () => {
          ordem.push('pagina-1');
          return pagina({ proximoDepois: '0003' });
        })
        .mockImplementationOnce(async () => {
          ordem.push('pagina-2');
          return pagina({ linhas: [linha({ sku: 'CAM-2' })] });
        }),
      priceSyncStatus: vi.fn<ShopeeClient['priceSyncStatus']>(async () => {
        ordem.push('status');
        return status();
      }),
    });
    const { result } = renderHook(() => useBaixarRelatorioPrecoShopee());

    await act(async () => {
      await result.current.baixar(ALVO_A);
    });

    expect(ordem).toEqual(['pagina-1', 'pagina-2', 'status']);
    expect(c.priceSyncRelatorio.mock.calls[0]![0]).toEqual({
      integracaoId: 'int-1',
      jobId: 'A',
      depois: null,
    });
    expect(c.priceSyncRelatorio.mock.calls[1]![0]).toMatchObject({ depois: '0003' });
    expect(c.priceSyncStatus).toHaveBeenCalledTimes(1);
    expect(c.priceSyncStatus).toHaveBeenCalledWith({ integracaoId: 'int-1', jobId: 'A' });

    const { texto, nome } = await csvBaixado();
    expect(texto).toContain('CAM-1');
    expect(texto).toContain('CAM-2');
    expect(nome).toBe('Envio de precos - Loja A - 2026-10-14 15-30.csv');
  });

  it('⭐ the trailer counters come from the STATUS, never re-counted from the rows', async () => {
    setClient({ priceSyncStatus: vi.fn(async () => status({ planejados: 900, enviados: 850 })) });
    const { result } = renderHook(() => useBaixarRelatorioPrecoShopee());

    await act(async () => {
      await result.current.baixar(ALVO_A);
    });

    const { texto } = await csvBaixado();
    expect(texto).toContain('Planejados: 900');
    expect(texto).toContain('Enviados: 850');
    expect(texto).toContain('Total de linhas no arquivo: 1');
  });

  it('an incomplete run says so in the trailer, with the status’s queue', async () => {
    setClient({
      priceSyncStatus: vi.fn(async () =>
        status({
          status: ENVIO_PRECO_SHOPEE_STATUS.cancelled,
          relatorioCompleto: false,
          filaRestante: 4,
        }),
      ),
    });
    const { result } = renderHook(() => useBaixarRelatorioPrecoShopee());

    await act(async () => {
      await result.current.baixar(ALVO_A);
    });

    const { texto } = await csvBaixado();
    // CSV-quoted: the cell's own quotes are doubled.
    expect(texto).toContain(
      'RELATORIO INCOMPLETO — o envio terminou em ""cancelled""; 4 itens não foram tentados.',
    );
  });

  it('a run whose report has ZERO rows still downloads — there is no "Sem relatório" branch', async () => {
    setClient({ priceSyncRelatorio: vi.fn(async () => pagina({ linhas: [] })) });
    const { result } = renderHook(() => useBaixarRelatorioPrecoShopee());

    await act(async () => {
      await result.current.baixar(ALVO_A);
    });

    const { texto } = await csvBaixado();
    expect(texto).toContain('Total de linhas no arquivo: 0');
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('⭐ stops at the page cap and SAYS the download was truncated', async () => {
    const c = setClient({
      priceSyncRelatorio: vi.fn(async () => pagina({ proximoDepois: 'mais' })),
    });
    const { result } = renderHook(() => useBaixarRelatorioPrecoShopee());

    await act(async () => {
      await result.current.baixar(ALVO_A);
    });

    expect(c.priceSyncRelatorio).toHaveBeenCalledTimes(MAX_PAGINAS_RELATORIO_PRECO);
    const { texto } = await csvBaixado();
    expect(texto).toContain('DOWNLOAD TRUNCADO');
  });

  it('a report that ended on its own is NOT marked truncated', async () => {
    const { result } = renderHook(() => useBaixarRelatorioPrecoShopee());
    await act(async () => {
      await result.current.baixar(ALVO_A);
    });
    const { texto } = await csvBaixado();
    expect(texto).not.toContain('DOWNLOAD TRUNCADO');
  });

  it('⭐ REFUSES a second download while one is in flight', async () => {
    let liberar!: () => void;
    const bloqueada = new Promise<void>((r) => (liberar = r));
    const c = setClient({
      priceSyncRelatorio: vi
        .fn<ShopeeClient['priceSyncRelatorio']>()
        .mockImplementationOnce(async () => {
          await bloqueada;
          return pagina();
        })
        .mockImplementation(async () => pagina()),
    });
    const { result } = renderHook(() => useBaixarRelatorioPrecoShopee());

    let primeira!: Promise<void>;
    act(() => {
      primeira = result.current.baixar(ALVO_A);
    });
    await waitFor(() => {
      expect(result.current.baixando).toBe('A');
    });

    await act(async () => {
      await result.current.baixar(ALVO_B);
    });
    expect(c.priceSyncRelatorio).toHaveBeenCalledTimes(1);
    expect(result.current.baixando).toBe('A');

    liberar();
    await act(async () => {
      await primeira;
    });
    expect(result.current.baixando).toBeNull();

    // The guard latches for one run, not forever.
    await act(async () => {
      await result.current.baixar(ALVO_B);
    });
    expect(h.saveBlob).toHaveBeenCalledTimes(2);
  });

  it('a failure is a notification — never a rethrow — and releases the guard', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    setClient({
      priceSyncRelatorio: vi
        .fn<ShopeeClient['priceSyncRelatorio']>()
        .mockImplementationOnce(async () => {
          throw new ShopeeClientNetworkError('offline');
        })
        .mockImplementation(async () => pagina()),
    });
    const { result } = renderHook(() => useBaixarRelatorioPrecoShopee());

    await act(async () => {
      await result.current.baixar(ALVO_A);
    });
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'red',
        message: 'Não foi possível contatar a integração com a Shopee.',
      }),
    );
    expect(h.saveBlob).not.toHaveBeenCalled();
    // A client failure is already described — no console line for it.
    expect(consoleError).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.baixar(ALVO_A);
    });
    expect(h.saveBlob).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it('a failure that is not a client error is logged under [shopee] and still only notified', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    setClient({
      priceSyncStatus: vi.fn(async () => {
        throw new TypeError('bug');
      }),
    });
    const { result } = renderHook(() => useBaixarRelatorioPrecoShopee());

    await act(async () => {
      await result.current.baixar(ALVO_A);
    });

    expect(consoleError).toHaveBeenCalledWith(
      '[shopee] download do relatório de preços falhou',
      expect.any(TypeError),
    );
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Não foi possível baixar o relatório.' }),
    );
    expect(h.saveBlob).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
