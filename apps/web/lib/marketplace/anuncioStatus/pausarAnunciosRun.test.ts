import type { Firestore } from 'firebase/firestore';
import { describe, expect, it, vi } from 'vitest';
import { ACAO_STATUS_ANUNCIO, INTEGRACAO_TIPO } from '@delfrance/schemas';

import { type PausarAnuncioAlvo, definirStatusParaMarketplaces } from './pausarAnunciosRun';
import { mercadoLivreAnuncioStatusProvider } from './providers/mercadoLivre';
import { shopeeAnuncioStatusProvider } from './providers/shopee';

/**
 * The orchestration itself lives in `../push/run.ts` and is pinned by
 * `../estoque/enviarEstoqueRun.test.ts` against the same code path. What is worth
 * pinning HERE is only what this binding decides — its own `suportado` closure.
 */

const db = {} as Firestore;

function alvo(over: Partial<PausarAnuncioAlvo> = {}): PausarAnuncioAlvo {
  return { produtoId: 'p1', produtoNome: 'Camiseta', integracoesComProduto: ['ml-1'], ...over };
}

describe('definirStatusParaMarketplaces', () => {
  /**
   * This binding's OWN `suportado` closure (`pausarAnunciosRun.ts`), both arms:
   * Shopee — built, with a provider — is handed the whole selection, including a
   * produto that never named its conta; an unbuilt channel only the produtos that
   * name its conta, each answered `canal-nao-implementado`.
   */
  it('Shopee gets the WHOLE selection; an unbuilt channel only the produtos naming it', async () => {
    const lerIntegracoes = vi.fn().mockResolvedValue(
      new Map([
        ['ml-1', { nome: 'Loja ML', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true }],
        ['shopee-1', { nome: 'Shopee BR', tipo: INTEGRACAO_TIPO.shopee, ativo: true }],
        ['li', { nome: 'Loja Integrada', tipo: INTEGRACAO_TIPO.lojaIntegrada, ativo: true }],
      ]),
    );
    const ml = vi
      .spyOn(mercadoLivreAnuncioStatusProvider, 'definirStatus')
      .mockResolvedValue({ rows: [], pausadoAte: null });
    // One row per produto it was handed.
    const shopee = vi
      .spyOn(shopeeAnuncioStatusProvider, 'definirStatus')
      .mockImplementation(({ integracao, produtoIds }) =>
        Promise.resolve({
          pausadoAte: null,
          rows: produtoIds.map((produtoId) => ({
            key: `${produtoId}:${integracao.id}:-`,
            produtoId,
            produtoNome: null,
            integracaoId: integracao.id,
            integracaoNome: integracao.nome,
            anuncioId: null,
            linkDocId: null,
            outcome: 'pulado' as const,
            motivo: 'sem-link',
            mensagem: 'Sem anúncio.',
            statusFinal: null,
            membros: null,
          })),
        }),
      );

    try {
      const res = await definirStatusParaMarketplaces(
        [
          alvo({ produtoId: 'p1' }),
          alvo({ produtoId: 'p2', integracoesComProduto: ['ml-1', 'shopee-1', 'li'] }),
        ],
        ACAO_STATUS_ANUNCIO.pausar,
        {
          db,
          deps: { mercadoLivre: null, shopee: null },
          lerIntegracoes: lerIntegracoes as never,
        },
        vi.fn(),
      );

      const shopeeRows = res.rows.filter((r) => r.integracaoId === 'shopee-1');
      expect(shopeeRows.map((r) => r.produtoId)).toEqual(['p1', 'p2']);
      // The ML conta, supported, is handed the whole selection too.
      expect(ml.mock.calls[0]![0].produtoIds).toEqual(['p1', 'p2']);

      // Loja Integrada flips `implementado` at ITS step 22
      // (`.master_plans/loja-integrada/loja-integrada-marketplace-integration.md:68`);
      // whichever channel flips second re-points this example. The arm itself is
      // pinned table-free in `../caps/suporteCanal.test.ts:16-25`.
      const li = res.rows.filter((r) => r.integracaoId === 'li');
      expect(li.map((r) => r.produtoId)).toEqual(['p2']);
      expect(li[0]!.motivo).toBe('canal-nao-implementado');
    } finally {
      ml.mockRestore();
      shopee.mockRestore();
    }
  });
});
