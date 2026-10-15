import type { Firestore } from 'firebase/firestore';
import { describe, expect, it, vi } from 'vitest';
import { ACAO_STATUS_ANUNCIO, INTEGRACAO_TIPO } from '@delfrance/schemas';

import { type PausarAnuncioAlvo, definirStatusParaMarketplaces } from './pausarAnunciosRun';
import { mercadoLivreAnuncioStatusProvider } from './providers/mercadoLivre';
import { shopeeAnuncioStatusProvider } from './providers/shopee';
import { suporteAnuncioStatusDoCanal } from './registry';

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
   * The rows-first argument in `../caps/registriesAlinhadas.test.ts` relies on
   * this closure (#1529): Shopee's provider is registered while its verdict is
   * still `canal-nao-implementado`, so a closure that asked "is a provider
   * registered?" (what it used to be, `../caps/suporteCanal.ts`) would hand the
   * Shopee conta the WHOLE selection and the placeholder would add a row for a
   * produto that never named it. Written to survive the step-22 flip (#1530).
   */
  it('hands the Shopee conta the whole selection only when the verdict says supported', async () => {
    const lerIntegracoes = vi.fn().mockResolvedValue(
      new Map([
        ['ml-1', { nome: 'Loja ML', tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: true }],
        ['shopee-1', { nome: 'Shopee BR', tipo: INTEGRACAO_TIPO.shopee, ativo: true }],
      ]),
    );
    const ml = vi
      .spyOn(mercadoLivreAnuncioStatusProvider, 'definirStatus')
      .mockResolvedValue({ rows: [], pausadoAte: null });
    // Reached only after the flip; one row per produto it was handed.
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
          alvo({ produtoId: 'p2', integracoesComProduto: ['ml-1', 'shopee-1'] }),
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
      expect(shopeeRows.map((r) => r.produtoId)).toEqual(
        suporteAnuncioStatusDoCanal(INTEGRACAO_TIPO.shopee).suportado ? ['p1', 'p2'] : ['p2'],
      );
      // The ML conta, supported, is handed the whole selection either way.
      expect(ml.mock.calls[0]![0].produtoIds).toEqual(['p1', 'p2']);
    } finally {
      ml.mockRestore();
      shopee.mockRestore();
    }
  });
});
