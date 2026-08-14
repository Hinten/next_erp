import type { PricePushChannelResult, PricePushInput, PricePushProvider } from '../types';

/**
 * The legacy `default:` arm — `EnviarPrecoDialog` fell through every channel
 * `if` and simply produced nothing for an unrecognised integração
 * (`.old/lib/produtos/pages/produtoTableView.dart:531-1000`). Saying so is more
 * useful to an operator than silence.
 *
 * Shopee / Magalu / Amazon / Loja Integrada have no price-push flow in this repo
 * yet — during the dual run their prices still go out through the legacy app.
 *
 * ⚠️ It claims **no tipos**: it is the unconditional fallback in
 * `resolvePricePushProvider`, so registering a real channel never means
 * remembering to delete a line from here.
 */
export const unsupportedChannelPriceProvider: PricePushProvider = {
  tipos: [],
  enviarPreco(input: PricePushInput): Promise<PricePushChannelResult> {
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
          `O canal ${integracao.nome} ainda não envia preços por aqui — use o aplicativo ` +
          'antigo para este canal.',
        preco: null,
        precoAnterior: null,
      })),
    });
  },
};
