import type {
  AnuncioStatusChannelResult,
  AnuncioStatusInput,
  AnuncioStatusProvider,
} from '../types';

/**
 * The fallback for a channel with no pause/reactivate flow in this repo yet.
 *
 * Shopee / Magalu / Amazon / Loja Integrada listings still have to be paused on
 * the channel's own site until each gets its provider + route. Saying so is more
 * useful to an operator than a silently missing row.
 *
 * ⚠️ It claims **no tipos**: it is the unconditional fallback in
 * `resolveAnuncioStatusProvider`, so registering a real channel never means
 * remembering to delete a line from here.
 */
export const unsupportedChannelAnuncioStatusProvider: AnuncioStatusProvider = {
  tipos: [],
  definirStatus(input: AnuncioStatusInput): Promise<AnuncioStatusChannelResult> {
    const { integracao, produtoIds } = input;
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
        motivo: 'canal-nao-suportado',
        mensagem:
          `O canal ${integracao.nome} ainda não pausa anúncios por aqui — use o site do ` +
          'canal para este anúncio.',
        statusFinal: null,
        membros: null,
      })),
    });
  },
};
