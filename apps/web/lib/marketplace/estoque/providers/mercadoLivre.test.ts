import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  createMercadoLivreClient,
  type MercadoLivreClient,
} from '@/lib/mercado-livre/client';

import { mercadoLivreStockProvider } from './mercadoLivre';
import type { StockPushInput } from '../types';

function input(
  enviarEstoque: MercadoLivreClient['enviarEstoque'] | null,
  over: Partial<StockPushInput> = {},
): StockPushInput {
  return {
    integracao: { id: 'c1', nome: 'Loja', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true },
    produtoIds: ['p1'],
    nomePorProdutoId: new Map([['p1', 'Camiseta']]),
    reenviarComErro: false,
    deps: {
      mercadoLivre:
        enviarEstoque == null ? null : ({ enviarEstoque } as unknown as MercadoLivreClient),
    },
    ...over,
  };
}

const envelope = (over: Record<string, unknown> = {}) => ({
  canal: 'mercado-livre' as const,
  integracaoId: 'c1',
  contaNome: 'Loja',
  solicitados: 1,
  familias: 1,
  resumo: { enviados: 1, pulados: 0, falhas: 0, naoTentados: 0 },
  listings: [],
  produtosSemEnvio: [],
  pausadoAte: null,
  ...over,
});

describe('mercadoLivreStockProvider', () => {
  it('cancels the real client while fetch is pending without inventing failure rows', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetchImpl = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
          started();
        }),
    );
    const client = createMercadoLivreClient({
      baseUrl: 'http://localhost:3006',
      getAuthToken: async () => 'token',
      fetch: fetchImpl,
    });
    const pending = mercadoLivreStockProvider.enviarEstoque(
      input(client.enviarEstoque, { signal: controller.signal }),
    );

    await fetchStarted;
    expect(fetchImpl.mock.calls[0]![1]?.signal).toBe(controller.signal);
    controller.abort();

    await expect(pending).resolves.toEqual({ rows: [], pausadoAte: null });
  });

  it('maps every listing through, one row each', async () => {
    // A produto can carry SEVERAL anúncios on one conta (#781) — the row unit is
    // the listing, so two listings must never collapse into one row.
    const enviarEstoque = vi.fn().mockResolvedValue(
      envelope({
        listings: [
          {
            produtoId: 'p1',
            produtoNome: 'Camiseta',
            variacaoProdutoId: null,
            anuncioId: 'MLB1',
            linkDocId: 'l1',
            outcome: 'enviado',
            motivo: null,
            mensagem: 'Estoque 7 enviado.',
            quantidade: 7,
            variacoes: null,
            rearme: null,
          },
          {
            produtoId: 'p1',
            produtoNome: 'Camiseta',
            variacaoProdutoId: null,
            anuncioId: 'MLB2',
            linkDocId: 'l2',
            outcome: 'pulado',
            motivo: 'anuncio-em-erro',
            mensagem: 'Pulado: o anúncio está marcado com erro.',
            quantidade: null,
            variacoes: null,
            rearme: null,
          },
        ],
      }),
    );
    const res = await mercadoLivreStockProvider.enviarEstoque(input(enviarEstoque));
    expect(res.rows).toHaveLength(2);
    expect(res.rows.map((r) => r.key)).toEqual(['p1:c1:MLB1', 'p1:c1:MLB2']);
    // The BACKEND owns the wording — the provider must pass it through, not
    // re-derive it from the machine code.
    expect(res.rows[1]!.mensagem).toBe('Pulado: o anúncio está marcado com erro.');
  });

  it('turns a produto with no listing into a row rather than dropping it', async () => {
    const enviarEstoque = vi.fn().mockResolvedValue(
      envelope({
        produtosSemEnvio: [
          {
            produtoId: 'p1',
            produtoNome: 'Camiseta',
            motivo: 'familia-nao-encontrada',
            mensagem: 'Produto não encontrado.',
          },
        ],
      }),
    );
    const res = await mercadoLivreStockProvider.enviarEstoque(input(enviarEstoque));
    expect(res.rows).toEqual([
      expect.objectContaining({ outcome: 'pulado', motivo: 'familia-nao-encontrada' }),
    ]);
  });

  it('forwards the opt-in and the abort signal', async () => {
    const enviarEstoque = vi.fn().mockResolvedValue(envelope());
    const controller = new AbortController();
    await mercadoLivreStockProvider.enviarEstoque(
      input(enviarEstoque, { reenviarComErro: true, signal: controller.signal }),
    );
    expect(enviarEstoque).toHaveBeenCalledWith({
      integracaoId: 'c1',
      produtoIds: ['p1'],
      reenviarComErro: true,
      signal: controller.signal,
    });
  });

  it.each([false, true])('preserves HTTP refusals even when aborted=%s', async (aborted) => {
    const controller = new AbortController();
    if (aborted) controller.abort();
    const enviarEstoque = vi
      .fn()
      .mockRejectedValue(new MercadoLivreClientHttpError('conta pausada', 409, 'ML_CONTA_PAUSADA'));
    const res = await mercadoLivreStockProvider.enviarEstoque(
      input(enviarEstoque, { signal: controller.signal }),
    );
    expect(res.rows[0]).toMatchObject({
      outcome: 'falha',
      motivo: 'ML_CONTA_PAUSADA',
      mensagem: 'conta pausada',
    });
  });

  it('keeps a genuine network failure as a row while the signal is active', async () => {
    const enviarEstoque = vi.fn().mockRejectedValue(new MercadoLivreClientNetworkError('offline'));
    const signal = new AbortController().signal;
    const res = await mercadoLivreStockProvider.enviarEstoque(input(enviarEstoque, { signal }));
    expect(res.rows[0]).toMatchObject({
      outcome: 'falha',
      motivo: 'rede',
      mensagem: 'Não foi possível contatar o serviço do Mercado Livre.',
    });
  });

  it('treats a raw AbortError as a clean cancel', async () => {
    const enviarEstoque = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const res = await mercadoLivreStockProvider.enviarEstoque(input(enviarEstoque));
    expect(res).toEqual({ rows: [], pausadoAte: null });
  });

  it.each([false, true])('rethrows unknown errors even when aborted=%s', async (aborted) => {
    const controller = new AbortController();
    if (aborted) controller.abort();
    const error = new TypeError('boom');
    const enviarEstoque = vi.fn().mockRejectedValue(error);
    await expect(
      mercadoLivreStockProvider.enviarEstoque(input(enviarEstoque, { signal: controller.signal })),
    ).rejects.toBe(error);
  });

  it('degrades to an error row when logged out, with zero fetches', async () => {
    const res = await mercadoLivreStockProvider.enviarEstoque(input(null));
    expect(res.rows[0]).toMatchObject({ outcome: 'falha', motivo: 'sem-cliente' });
  });
});
