import { INTEGRACAO_TIPO_LABELS, type IntegracaoTipo } from '@delfrance/schemas';

import { buildProviderMap } from '../push/types';
import { mercadoLivrePriceProvider } from './providers/mercadoLivre';
import { unsupportedChannelPriceProvider } from './providers/unsupportedChannel';
import type { PricePushChannelResult, PricePushInput, PricePushProvider } from './types';

/**
 * The marketplace price-push registry — the channel-agnostic dispatch that
 * replaces the legacy chain of `if (integracao.tipo == …)` arms in
 * `EnviarPrecoDialog` (`.old/lib/produtos/pages/produtoTableView.dart:531-1000`).
 * Adding a channel is one provider file, one backend route and one `PROVIDERS`
 * row (see `README.md`); the orchestrator, the dialog and the other providers
 * stay untouched.
 *
 * The twin of `lib/marketplace/estoque/registry.ts`, down to the gate.
 */
export const PROVIDERS: Readonly<Partial<Record<IntegracaoTipo, PricePushProvider>>> =
  buildProviderMap([mercadoLivrePriceProvider], 'Price push');

/**
 * An exact tipo match wins; ANY other tipo falls back to the
 * unsupported-channel placeholder, which IS the legacy fall-through.
 */
export function resolvePricePushProvider(tipo: IntegracaoTipo): PricePushProvider {
  return PROVIDERS[tipo] ?? unsupportedChannelPriceProvider;
}

/**
 * The shared entry point: run the channel-agnostic gates, then dispatch.
 *
 * The only gate is the deactivated-integração arm the stock push also carries
 * (`enviarEstoqueDialog.dart:249-259`). "Produto não encontrado" and "Integração
 * não encontrada" belong to the orchestrator, which holds the documents.
 */
export function enviarPrecoParaIntegracao(input: PricePushInput): Promise<PricePushChannelResult> {
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
        preco: null,
        precoAnterior: null,
      })),
    });
  }
  return resolvePricePushProvider(integracao.tipo).enviarPreco(input);
}
