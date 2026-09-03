import { type MotivoNaoSuportado, mensagemNaoSuportado } from '@/lib/marketplace/caps/suporteCanal';
import type { PricePushChannelResult, PricePushInput, PricePushProvider } from '../types';

/**
 * The legacy `default:` arm — `EnviarPrecoDialog` fell through every channel
 * `if` and simply produced nothing for an unrecognised integração
 * (`.old/lib/produtos/pages/produtoTableView.dart:531-1000`). Saying so is more
 * useful to an operator than silence.
 *
 * ⚠️ A FACTORY, not a const, since #1430 — see the stock twin for why the
 * reason has to travel with the row.
 *
 * ⚠️ It claims **no tipos**: it is only ever reached through
 * `resolvePricePushProvider`, so registering a real channel never means
 * remembering to delete a line from here.
 */
export function criarUnsupportedChannelPriceProvider(
  motivo: MotivoNaoSuportado,
): PricePushProvider {
  return {
    tipos: [],
    enviarPreco(input: PricePushInput): Promise<PricePushChannelResult> {
      const { integracao, produtoIds } = input;
      const mensagem = mensagemNaoSuportado(motivo, 'preco', integracao.nome, integracao.tipo);
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
          preco: null,
          precoAnterior: null,
        })),
      });
    },
  };
}
