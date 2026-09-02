import { type MotivoNaoSuportado, mensagemNaoSuportado } from '@/lib/marketplace/caps/suporteCanal';
import type {
  AnuncioStatusChannelResult,
  AnuncioStatusInput,
  AnuncioStatusProvider,
} from '../types';

/**
 * The fallback for a channel with no pause/reactivate flow in this repo yet.
 *
 * ⚠️ A FACTORY, not a const, since #1430 — see the stock twin for why the
 * reason has to travel with the row. The sentence it replaced pointed the
 * operator at the channel's own site for every case alike, including the case
 * where the channel has no pause endpoint at all.
 *
 * ⚠️ It claims **no tipos**: it is only ever reached through
 * `resolveAnuncioStatusProvider`, so registering a real channel never means
 * remembering to delete a line from here.
 */
export function criarUnsupportedChannelAnuncioStatusProvider(
  motivo: MotivoNaoSuportado,
): AnuncioStatusProvider {
  return {
    tipos: [],
    definirStatus(input: AnuncioStatusInput): Promise<AnuncioStatusChannelResult> {
      const { integracao, produtoIds } = input;
      const mensagem = mensagemNaoSuportado(
        motivo,
        'anuncioStatus',
        integracao.nome,
        integracao.tipo,
      );
      return Promise.resolve({
        pausadoAte: null,
        rows: produtoIds.map((produtoId) => ({
          key: `${produtoId}:${integracao.id}:-`,
          produtoId,
          produtoNome: input.nomePorProdutoId.get(produtoId) ?? null,
          integracaoId: integracao.id,
          integracaoNome: integracao.nome,
          anuncioId: null,
          linkDocId: null,
          outcome: 'pulado' as const,
          motivo,
          mensagem,
          statusFinal: null,
          membros: null,
        })),
      });
    },
  };
}
