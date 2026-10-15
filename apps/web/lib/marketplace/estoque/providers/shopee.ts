import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { classificarFalhaDoEnvioShopee } from '@/lib/shopee/falhaDoEnvio';

import { makeRowKeyer } from '../../push/types';
import type {
  StockPushChannelResult,
  StockPushInput,
  StockPushProvider,
  StockPushRow,
} from '../types';

/**
 * Shopee stock push — `POST /api/marketplace/shopee/enviar-estoque` on the
 * apps/shopee backend (#1529, step 21).
 *
 * A thin adapter, like the Mercado Livre provider: the backend answers one row
 * per LISTING with operator-facing pt-BR `mensagem` text, and the skip
 * vocabulary is the SENDER's — this file never re-derives wording from a code.
 * A requested variation child is resolved to its family anchor by the backend,
 * and its row names the ANCHOR.
 *
 * ⚠️ `reenviarComErro` is forwarded as is: on Shopee it re-sends to a listing
 * whose last stock push was refused (the backend's refusal fingerprint), which
 * is what the dialog's checkbox offers.
 *
 * ⚠️ Every key comes from {@link makeRowKeyer}: the backend's skip arms can
 * repeat a `(produto, anúncio)` pair, and the key is also the row's test id.
 *
 * ⚠️ Registered, but unreachable until Shopee's caps row flips `implementado`
 * (#1530): `vereditoCanal` answers `canal-nao-implementado` before it reads the
 * provider map — see `../../caps/registriesAlinhadas.test.ts`.
 */
export const shopeeStockProvider: StockPushProvider = {
  tipos: [INTEGRACAO_TIPO.shopee],

  async enviarEstoque(input: StockPushInput): Promise<StockPushChannelResult> {
    const { integracao, produtoIds, deps } = input;
    const client = deps.shopee;

    const chave = makeRowKeyer();
    const linha = (
      over: Partial<StockPushRow> & Pick<StockPushRow, 'produtoId'>,
    ): StockPushRow => ({
      key: chave(over.produtoId, integracao.id, over.anuncioId ?? null),
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

    /** A conta-level verdict, as one row per requested produto. */
    const contaInteira = (
      outcome: StockPushRow['outcome'],
      motivo: string,
      mensagem: string,
      pausadoAte: string | null,
    ): StockPushChannelResult => ({
      pausadoAte,
      rows: produtoIds.map((produtoId) => linha({ produtoId, outcome, motivo, mensagem })),
    });

    if (!client) {
      return contaInteira('falha', 'sem-cliente', 'Você não está logado.', null);
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
          // The backend names the FAMILY anchor, with the anchor's own name even
          // when only a variation child was selected. `nomePorProdutoId` is keyed
          // by the SELECTION, so this fallback only covers a selected anchor whose
          // stored name is blank — it can never name an anchor reached via a child.
          produtoNome: l.produtoNome ?? input.nomePorProdutoId.get(l.produtoId) ?? null,
          anuncioId: l.anuncioId,
          linkDocId: l.linkDocId,
          // ⚠️ `outcome`, never `motivo`: a send clamped to a promotion's
          // reserved floor is a SUCCESS that still carries a motivo.
          outcome: l.outcome,
          motivo: l.motivo,
          mensagem: l.mensagem,
          quantidade: l.quantidade,
        }),
      );
      // A produto that produced no listing at all still gets a row, under the id
      // the operator asked for.
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
      const falha = classificarFalhaDoEnvioShopee(err, input.signal);
      if (falha === null) throw err; // never a generic catch (repo rule 6)
      // No rows on a cancel: the run reports the cancellation itself.
      if (falha.tipo === 'cancelado') return { rows: [], pausadoAte: null };
      return contaInteira(falha.outcome, falha.motivo, falha.mensagem, falha.pausadoAte);
    }
  },
};
