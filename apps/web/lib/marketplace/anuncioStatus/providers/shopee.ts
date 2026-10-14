import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { classificarFalhaDoEnvioShopee } from '@/lib/shopee/falhaDoEnvio';

import { makeRowKeyer } from '../../push/types';
import type {
  AnuncioStatusChannelResult,
  AnuncioStatusInput,
  AnuncioStatusProvider,
  AnuncioStatusRow,
} from '../types';

/**
 * Shopee pause/reactivate — `POST /api/marketplace/shopee/anuncio-status` on the
 * apps/shopee backend (#1529, step 21).
 *
 * A thin adapter: the backend answers one row per LISTING with operator-facing
 * pt-BR `mensagem` text, and owns the skip vocabulary. A Shopee listing IS the
 * family (`unlist_item` is per item), so a requested variation child is resolved
 * to its anchor by the backend and moves the whole listing; its row names the
 * ANCHOR.
 *
 * ⚠️ `statusFinal` is passed through RAW — what the listing reads after the
 * write, never the direction that was requested. `membros` is always `null`:
 * there is no member tally on Shopee, whose models move with their item.
 *
 * ⚠️ The bulk path sends no `linkDocId` (the run covers every listing of the
 * selection on the conta). The produto's Shopee tab names one listing and calls
 * the client DIRECTLY, never through this registry, because this row is
 * unreachable until Shopee's caps row flips `implementado` (#1530) — see
 * `../../caps/registriesAlinhadas.test.ts`.
 */
export const shopeeAnuncioStatusProvider: AnuncioStatusProvider = {
  tipos: [INTEGRACAO_TIPO.shopee],

  async definirStatus(input: AnuncioStatusInput): Promise<AnuncioStatusChannelResult> {
    const { integracao, produtoIds, deps } = input;
    const client = deps.shopee;

    const chave = makeRowKeyer();
    const linha = (
      over: Partial<AnuncioStatusRow> & Pick<AnuncioStatusRow, 'produtoId'>,
    ): AnuncioStatusRow => ({
      key: chave(over.produtoId, integracao.id, over.anuncioId ?? null),
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

    /** A conta-level verdict, as one row per requested produto. */
    const contaInteira = (
      outcome: AnuncioStatusRow['outcome'],
      motivo: string,
      mensagem: string,
      pausadoAte: string | null,
    ): AnuncioStatusChannelResult => ({
      pausadoAte,
      rows: produtoIds.map((produtoId) => linha({ produtoId, outcome, motivo, mensagem })),
    });

    if (!client) {
      return contaInteira('falha', 'sem-cliente', 'Você não está logado.', null);
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
          membros: null,
        }),
      );
      // A produto with no listing on this conta still gets a row, under the id
      // the operator asked for — otherwise it would vanish from a report that
      // claims to cover the selection.
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
      const falha = classificarFalhaDoEnvioShopee(err, input.signal);
      if (falha === null) throw err; // never a generic catch (repo rule 6)
      // No rows on a cancel: the run reports the cancellation itself.
      if (falha.tipo === 'cancelado') return { rows: [], pausadoAte: null };
      return contaInteira(falha.outcome, falha.motivo, falha.mensagem, falha.pausadoAte);
    }
  },
};
