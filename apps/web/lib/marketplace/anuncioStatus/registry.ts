import { INTEGRACAO_TIPO_LABELS, type IntegracaoTipo } from '@delfrance/schemas';

import { type VereditoCanal, vereditoCanal } from '@/lib/marketplace/caps/suporteCanal';

import { buildProviderMap } from '../push/types';
import { mercadoLivreAnuncioStatusProvider } from './providers/mercadoLivre';
import { criarUnsupportedChannelAnuncioStatusProvider } from './providers/unsupportedChannel';
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
 * What `MARKETPLACE_TIPO_CAPS.pausarAnuncio` says about this channel, and — when
 * it says no — which reason applies.
 *
 * ⚠️ `pausarAnuncio` is its OWN capability, not an inference off
 * `publicarAnuncio`: several marketplaces expose only a terminal close, and
 * deriving one from the other is the unverified claim #815 undid.
 */
export function suporteAnuncioStatusDoCanal(tipo: IntegracaoTipo): VereditoCanal {
  return vereditoCanal('anuncioStatus', tipo, PROVIDERS);
}

/**
 * The caps row decides; an exact tipo match then serves it. Anything else falls
 * back to the placeholder CARRYING the reason (#1430).
 */
export function resolveAnuncioStatusProvider(tipo: IntegracaoTipo): AnuncioStatusProvider {
  const veredito = suporteAnuncioStatusDoCanal(tipo);
  if (!veredito.suportado) return criarUnsupportedChannelAnuncioStatusProvider(veredito.motivo);
  return PROVIDERS[tipo] ?? criarUnsupportedChannelAnuncioStatusProvider('canal-sem-provider');
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
