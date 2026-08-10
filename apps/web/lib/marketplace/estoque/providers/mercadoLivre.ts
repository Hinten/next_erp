import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
} from '@/lib/mercado-livre/client';

import type {
  StockPushChannelResult,
  StockPushInput,
  StockPushProvider,
  StockPushRow,
} from '../types';

/**
 * Mercado Livre stock push — `POST /api/marketplace/mercado-livre/enviar-estoque`
 * on the apps/mercado-livre backend.
 *
 * The backend already returns per-listing outcomes with operator-facing pt-BR
 * `mensagem` text, so this provider is a thin adapter: it does NOT re-derive
 * wording from the machine codes. That is deliberate — the skip vocabulary
 * (`anuncio-em-erro`, `status-nao-enviavel`, …) is the SENDER's, and a second
 * copy of it here would drift from the rungs that emit it.
 */
export const mercadoLivreStockProvider: StockPushProvider = {
  tipos: [INTEGRACAO_TIPO.mercadoLivre],

  async enviarEstoque(input: StockPushInput): Promise<StockPushChannelResult> {
    const { integracao, produtoIds, deps } = input;
    const client = deps.mercadoLivre;

    const linha = (
      over: Partial<StockPushRow> & Pick<StockPushRow, 'produtoId'>,
    ): StockPushRow => ({
      key: `${over.produtoId}:${integracao.id}:${over.anuncioId ?? '-'}`,
      produtoNome: input.nomePorProdutoId.get(over.produtoId) ?? null,
      integracaoId: integracao.id,
      integracaoNome: integracao.nome,
      anuncioId: null,
      linkDocId: null,
      outcome: 'falha',
      motivo: null,
      mensagem: '',
      quantidade: null,
      ...over,
    });

    const falhaGeral = (mensagem: string, motivo: string): StockPushChannelResult => ({
      pausadoAte: null,
      rows: produtoIds.map((produtoId) => linha({ produtoId, outcome: 'falha', motivo, mensagem })),
    });

    if (!client) {
      return falhaGeral('Você não está logado.', 'sem-cliente');
    }

    try {
      const res = await client.enviarEstoque({
        integracaoId: integracao.id,
        produtoIds: [...produtoIds],
        reenviarComErro: input.reenviarComErro,
        signal: input.signal,
      });

      const rows: StockPushRow[] = res.listings.map((l) =>
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
          quantidade: l.quantidade,
        }),
      );
      // A produto that produced no listing at all still gets a row — the legacy
      // dialog's "Produto não tem integrações" arm, generalised.
      for (const p of res.produtosSemEnvio) {
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
        // 409 covers both "conta desconectada" and the rate-limit pause; the
        // backend's own message is more specific than anything we could invent.
        return falhaGeral(err.message, err.code ?? 'erro-http');
      }
      if (err instanceof MercadoLivreClientNetworkError) {
        // Pinned verbatim by the produto ML-tab e2e — do not reword casually.
        return falhaGeral('Não foi possível contatar o serviço do Mercado Livre.', 'rede');
      }
      throw err; // never a generic catch (repo rule 6)
    }
  },
};
