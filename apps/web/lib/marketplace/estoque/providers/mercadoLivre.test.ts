import { describe, expect, it, vi } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
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

  it('reports a conta-level HTTP refusal per produto', async () => {
    const enviarEstoque = vi
      .fn()
      .mockRejectedValue(new MercadoLivreClientHttpError('conta pausada', 409, 'ML_CONTA_PAUSADA'));
    const res = await mercadoLivreStockProvider.enviarEstoque(input(enviarEstoque));
    expect(res.rows[0]).toMatchObject({ outcome: 'falha', motivo: 'ML_CONTA_PAUSADA' });
  });

  it('uses the exact network copy the produto ML-tab e2e pins', async () => {
    const enviarEstoque = vi.fn().mockRejectedValue(new MercadoLivreClientNetworkError('offline'));
    const res = await mercadoLivreStockProvider.enviarEstoque(input(enviarEstoque));
    expect(res.rows[0]!.mensagem).toBe('Não foi possível contatar o serviço do Mercado Livre.');
  });

  it('rethrows an unknown error instead of swallowing it (repo rule 6)', async () => {
    const enviarEstoque = vi.fn().mockRejectedValue(new TypeError('boom'));
    await expect(mercadoLivreStockProvider.enviarEstoque(input(enviarEstoque))).rejects.toThrow(
      TypeError,
    );
  });

  it('degrades to an error row when logged out, with zero fetches', async () => {
    const res = await mercadoLivreStockProvider.enviarEstoque(input(null));
    expect(res.rows[0]).toMatchObject({ outcome: 'falha', motivo: 'sem-cliente' });
  });
});
