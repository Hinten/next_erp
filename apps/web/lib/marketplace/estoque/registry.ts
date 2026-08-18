import { INTEGRACAO_TIPO_LABELS, type IntegracaoTipo } from '@delfrance/schemas';

import { buildProviderMap } from '../push/types';
import { mercadoLivreStockProvider } from './providers/mercadoLivre';
import { unsupportedChannelStockProvider } from './providers/unsupportedChannel';
import type { StockPushChannelResult, StockPushInput, StockPushProvider } from './types';

/**
 * The marketplace stock-push registry — the channel-agnostic dispatch that
 * replaces the legacy `switch (integracaoTarget.tipo)` in
 * `.old/lib/produtos/pages/enviarEstoqueDialog.dart:261-336`. Adding a channel
 * is one provider file, one backend route and one `PROVIDERS` row (see
 * `README.md`); the orchestrator, the dialog and the other providers stay
 * untouched.
 *
 * Modelled on `lib/checkout/etiqueta/registry.ts`.
 */
export const PROVIDERS: Readonly<Partial<Record<IntegracaoTipo, StockPushProvider>>> =
  buildProviderMap([mercadoLivreStockProvider], 'Stock push');

/**
 * An exact tipo match wins; ANY other tipo falls back to the
 * unsupported-channel placeholder, which IS the legacy `default:` arm.
 *
 * Deliberately simpler than `resolveEtiquetaProvider`, which needs a
 * `caps.marketplaceOwned` branch to keep non-marketplace carriers on the generic
 * label. Here every tipo is a sales channel or nothing.
 */
export function resolveStockPushProvider(tipo: IntegracaoTipo): StockPushProvider {
  return PROVIDERS[tipo] ?? unsupportedChannelStockProvider;
}

/**
 * The shared entry point: run the channel-agnostic gates, then dispatch.
 *
 * The only gate is the legacy `ativo == false` arm
 * (`enviarEstoqueDialog.dart:249-259`). "Produto não encontrado" and "Integração
 * não encontrada" belong to the orchestrator, which holds the documents —
 * exactly as the etiqueta registry resolves `intFrete` before its gates.
 */
export function enviarEstoqueParaIntegracao(
  input: StockPushInput,
): Promise<StockPushChannelResult> {
  const { integracao, produtoIds } = input;
  if (!integracao.ativo) {
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
        motivo: 'integracao-desativada',
        mensagem: `Integração desativada (${INTEGRACAO_TIPO_LABELS[integracao.tipo]}).`,
        quantidade: null,
      })),
    });
  }
  return resolveStockPushProvider(integracao.tipo).enviarEstoque(input);
}
