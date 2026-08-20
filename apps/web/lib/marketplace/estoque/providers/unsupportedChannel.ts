import type { StockPushChannelResult, StockPushInput, StockPushProvider } from '../types';

/**
 * The legacy `default:` arm (`.old/lib/produtos/pages/enviarEstoqueDialog.dart:329-335`,
 * *"Tipo de integração não suportado"*) as a provider.
 *
 * Shopee / Magalu / Amazon / Loja Integrada have no stock-push flow in this repo
 * yet — until the cutover their stock goes out through the legacy app, and
 * saying so is more useful to an operator than silence.
 *
 * ⚠️ It claims **no tipos**: it is the unconditional fallback in
 * `resolveStockPushProvider`, so registering a real channel never means
 * remembering to delete a line from here.
 */
export const unsupportedChannelStockProvider: StockPushProvider = {
  tipos: [],
  enviarEstoque(input: StockPushInput): Promise<StockPushChannelResult> {
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
          `O canal ${integracao.nome} ainda não envia estoque por aqui — use o aplicativo ` +
          'antigo para este canal.',
        quantidade: null,
      })),
    });
  },
};
