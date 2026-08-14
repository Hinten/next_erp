import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
} from '@/lib/mercado-livre/client';

import type {
  PricePushChannelResult,
  PricePushInput,
  PricePushProvider,
  PricePushRow,
} from '../types';

/**
 * Mercado Livre price push — `POST /api/marketplace/mercado-livre/enviar-precos`
 * on the apps/mercado-livre backend.
 *
 * The backend already returns per-listing outcomes with operator-facing pt-BR
 * `mensagem` text, so this provider is a thin adapter: it does NOT re-derive
 * wording from the machine codes. That is deliberate — the skip vocabulary
 * (`PRECO_ANTIGO_MAIOR`, `PRECO_NAO_MODIFICAVEL`, …) is the SENDER's, and a
 * second copy of it here would drift from the gates that emit it.
 */
export const mercadoLivrePriceProvider: PricePushProvider = {
  tipos: [INTEGRACAO_TIPO.mercadoLivre],

  async enviarPreco(input: PricePushInput): Promise<PricePushChannelResult> {
    const { integracao, produtoIds, deps } = input;
    const client = deps.mercadoLivre;

    const linha = (
      over: Partial<PricePushRow> & Pick<PricePushRow, 'produtoId'>,
    ): PricePushRow => ({
      key: `${over.produtoId}:${integracao.id}:${over.anuncioId ?? '-'}`,
      produtoNome: input.nomePorProdutoId.get(over.produtoId) ?? null,
      integracaoId: integracao.id,
      integracaoNome: integracao.nome,
      anuncioId: null,
      linkDocId: null,
      outcome: 'falha',
      motivo: null,
      mensagem: '',
      preco: null,
      precoAnterior: null,
      ...over,
    });

    const falhaGeral = (mensagem: string, motivo: string): PricePushChannelResult => ({
      pausadoAte: null,
      rows: produtoIds.map((produtoId) => linha({ produtoId, outcome: 'falha', motivo, mensagem })),
    });

    if (!client) {
      return falhaGeral('Você não está logado.', 'sem-cliente');
    }

    try {
      const res = await client.enviarPrecos({
        integracaoId: integracao.id,
        produtoIds: [...produtoIds],
        baixarPreco: input.baixarPreco,
        signal: input.signal,
      });

      const rows: PricePushRow[] = res.listings.map((l) =>
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
          preco: l.preco,
          precoAnterior: l.precoAnterior,
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
        // Covers the oversize selection and the missing tabela normal; the
        // backend's own message is more specific than anything we could invent.
        return falhaGeral(err.message, err.code ?? 'erro-http');
      }
      if (err instanceof MercadoLivreClientNetworkError) {
        return falhaGeral('Não foi possível contatar o serviço do Mercado Livre.', 'rede');
      }
      // The operator hit Cancelar: `fetch` rejects the aborted request with a
      // DOMException named 'AbortError'. That is a clean cancel, not a failure.
      // No rows: the run reports the cancellation itself.
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { rows: [], pausadoAte: null };
      }
      throw err; // never a generic catch (repo rule 6)
    }
  },
};
