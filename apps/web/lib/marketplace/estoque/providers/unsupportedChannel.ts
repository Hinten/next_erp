import { type MotivoNaoSuportado, mensagemNaoSuportado } from '@/lib/marketplace/caps/suporteCanal';
import type { StockPushChannelResult, StockPushInput, StockPushProvider } from '../types';

/**
 * The legacy `default:` arm (`.old/lib/produtos/pages/enviarEstoqueDialog.dart:329-335`,
 * *"Tipo de integração não suportado"*) as a provider.
 *
 * ⚠️ A FACTORY, not a const, since #1430: the resolver decides WHICH of the
 * reasons applies from `MARKETPLACE_TIPO_CAPS`, and the row has to carry it.
 * The single sentence this replaced said *"use o aplicativo antigo para este
 * canal"* for all of them — wrong about three of the four, and expiring at the
 * cutover, since there is no dual run (root `CLAUDE.md` rule 8).
 *
 * ⚠️ It claims **no tipos**: it is only ever reached through
 * `resolveStockPushProvider`, so registering a real channel never means
 * remembering to delete a line from here.
 */
export function criarUnsupportedChannelStockProvider(
  motivo: MotivoNaoSuportado,
): StockPushProvider {
  return {
    tipos: [],
    enviarEstoque(input: StockPushInput): Promise<StockPushChannelResult> {
      const { integracao, produtoIds } = input;
      const mensagem = mensagemNaoSuportado(motivo, 'estoque', integracao.nome, integracao.tipo);
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
          quantidade: null,
        })),
      });
    },
  };
}
