import { INTEGRACAO_TIPO_LABELS, type IntegracaoTipo } from '@delfrance/schemas';

import { buildProviderMap } from '../push/types';
import { mercadoLivreAnuncioStatusProvider } from './providers/mercadoLivre';
import { unsupportedChannelAnuncioStatusProvider } from './providers/unsupportedChannel';
import type {
  AnuncioStatusChannelResult,
  AnuncioStatusInput,
  AnuncioStatusProvider,
} from './types';

/**
 * The pause/reactivate registry — channel-agnostic dispatch, modelled on
 * `../estoque/registry.ts`. Adding a channel is one provider file, one backend
 * route and one row here; the orchestrator, the dialog and the other providers
 * stay untouched.
 */
export const PROVIDERS: Readonly<Partial<Record<IntegracaoTipo, AnuncioStatusProvider>>> =
  buildProviderMap([mercadoLivreAnuncioStatusProvider], 'Anúncio status');

/**
 * An exact tipo match wins; ANY other tipo falls back to the
 * unsupported-channel placeholder.
 */
export function resolveAnuncioStatusProvider(tipo: IntegracaoTipo): AnuncioStatusProvider {
  return PROVIDERS[tipo] ?? unsupportedChannelAnuncioStatusProvider;
}

/**
 * The shared entry point: run the channel-agnostic gates, then dispatch.
 *
 * The only gate is `ativo === false`, the same one both sibling operations
 * apply — a disconnected account cannot be asked to do anything, and saying so
 * per produto beats a bare failure.
 */
export function definirStatusParaIntegracao(
  input: AnuncioStatusInput,
): Promise<AnuncioStatusChannelResult> {
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
        statusFinal: null,
        membros: null,
      })),
    });
  }
  return resolveAnuncioStatusProvider(integracao.tipo).definirStatus(input);
}
