import { INTEGRACAO_TIPO_LABELS, type IntegracaoTipo } from '@delfrance/schemas';

import { type VereditoCanal, vereditoCanal } from '@/lib/marketplace/caps/suporteCanal';

import { buildProviderMap } from '../push/types';
import { mercadoLivreStockProvider } from './providers/mercadoLivre';
import { criarUnsupportedChannelStockProvider } from './providers/unsupportedChannel';
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
 * What `MARKETPLACE_TIPO_CAPS` says about sending stock to this channel, and --
 * when it says no — which reason applies. The run and the pre-run warning both
 * read this, so they cannot disagree with the row the operator ends up seeing.
 */
export function suporteEstoqueDoCanal(tipo: IntegracaoTipo): VereditoCanal {
  return vereditoCanal('estoque', tipo, PROVIDERS);
}

/**
 * The caps row decides; an exact tipo match then serves it. Anything else falls
 * back to the placeholder CARRYING the reason (#1430).
 *
 * ⚠️ this used to be `PROVIDERS[tipo] ?? unsupported…` — "a provider
 * file exists" standing in for "the channel supports it", which is the same
 * substitution the `/canais` badge already removed (#815, ADR 0015). It also
 * gave four different situations one sentence.
 */
export function resolveStockPushProvider(tipo: IntegracaoTipo): StockPushProvider {
  const veredito = suporteEstoqueDoCanal(tipo);
  if (!veredito.suportado) return criarUnsupportedChannelStockProvider(veredito.motivo);
  // `vereditoCanal` answers `canal-sem-provider` when the map has no row, so a
  // supported verdict guarantees one. The fallback keeps the type honest.
  return PROVIDERS[tipo] ?? criarUnsupportedChannelStockProvider('canal-sem-provider');
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
