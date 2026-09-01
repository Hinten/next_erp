import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
} from '@/lib/mercado-livre/client';

import type {
  AnuncioStatusChannelResult,
  AnuncioStatusInput,
  AnuncioStatusProvider,
  AnuncioStatusRow,
} from '../types';

/**
 * Mercado Livre pause/reactivate — `POST /api/marketplace/mercado-livre/anuncio-status`
 * on the apps/mercado-livre backend.
 *
 * The backend already returns per-listing outcomes with operator-facing pt-BR
 * `mensagem` text, so this provider is a thin adapter: it does NOT re-derive
 * wording from the machine codes. That is deliberate — the skip vocabulary
 * (`anuncio-cancelado`, `status-indefinido`, `ja-pausado`, …) is the BACKEND's,
 * and a second copy here would drift from the rungs that emit it. It is also the
 * only place that knows what ML actually confirmed.
 */
export const mercadoLivreAnuncioStatusProvider: AnuncioStatusProvider = {
  tipos: [INTEGRACAO_TIPO.mercadoLivre],

  async definirStatus(input: AnuncioStatusInput): Promise<AnuncioStatusChannelResult> {
    const { integracao, produtoIds, deps } = input;
    const client = deps.mercadoLivre;

    const linha = (
      over: Partial<AnuncioStatusRow> & Pick<AnuncioStatusRow, 'produtoId'>,
    ): AnuncioStatusRow => ({
      key: `${over.produtoId}:${integracao.id}:${over.anuncioId ?? '-'}`,
      produtoNome: input.nomePorProdutoId.get(over.produtoId) ?? null,
      integracaoId: integracao.id,
      integracaoNome: integracao.nome,
      anuncioId: null,
      linkDocId: null,
      outcome: 'falha',
      motivo: null,
      mensagem: '',
      statusFinal: null,
      membros: null,
      ...over,
    });

    const falhaGeral = (mensagem: string, motivo: string): AnuncioStatusChannelResult => ({
      pausadoAte: null,
      rows: produtoIds.map((produtoId) => linha({ produtoId, outcome: 'falha', motivo, mensagem })),
    });

    if (!client) {
      return falhaGeral('Você não está logado.', 'sem-cliente');
    }

    try {
      const res = await client.definirStatusAnuncios({
        integracaoId: integracao.id,
        produtoIds: [...produtoIds],
        acao: input.acao,
        signal: input.signal,
      });

      const rows: AnuncioStatusRow[] = res.listings.map((l) =>
        linha({
          produtoId: l.produtoId,
          // The backend names the FAMILY anchor; prefer its own label when the
          // selection was a variation child the operator will not recognise.
          produtoNome: l.produtoNome ?? input.nomePorProdutoId.get(l.produtoId) ?? null,
          anuncioId: l.anuncioId,
          linkDocId: l.linkDocId,
          outcome: l.outcome,
          motivo: l.motivo,
          mensagem: l.mensagem,
          statusFinal: l.statusFinal,
          membros: l.membros,
        }),
      );
      // A produto that produced no listing at all still gets a row — otherwise
      // it would simply vanish from a report that claims to cover the selection.
      for (const p of res.produtosSemAnuncio) {
        rows.push(
          linha({
            produtoId: p.produtoId,
            produtoNome: p.produtoNome ?? input.nomePorProdutoId.get(p.produtoId) ?? null,
            outcome: 'pulado',
            motivo: p.motivo,
            mensagem: p.mensagem,
          }),
        );
      }
      return { rows, pausadoAte: res.pausadoAte };
    } catch (err) {
      if (err instanceof MercadoLivreClientHttpError) {
        // The backend's own message is more specific than anything invented here.
        return falhaGeral(err.message, err.code ?? 'erro-http');
      }
      if (err instanceof MercadoLivreClientNetworkError) {
        return falhaGeral('Não foi possível contatar o serviço do Mercado Livre.', 'rede');
      }
      // The operator hit Cancelar: `fetch` rejects the aborted request with a
      // DOMException named 'AbortError'. That is a clean cancel, not a failure —
      // no rows, because the run reports the cancellation itself.
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { rows: [], pausadoAte: null };
      }
      throw err; // never a generic catch (repo rule 6)
    }
  },
};
