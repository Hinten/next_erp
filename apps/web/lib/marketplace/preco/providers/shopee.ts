import { INTEGRACAO_TIPO } from '@delfrance/schemas';
import { classificarFalhaDoEnvioShopee } from '@/lib/shopee/falhaDoEnvio';

import { makeRowKeyer } from '../../push/types';
import type {
  PricePushChannelResult,
  PricePushInput,
  PricePushProvider,
  PricePushRow,
} from '../types';

/**
 * Shopee price push — `POST /api/marketplace/shopee/enviar-precos` on the
 * apps/shopee backend (#1529, step 21).
 *
 * A thin adapter: the backend answers with operator-facing pt-BR `mensagem`
 * text and owns the skip vocabulary. What differs from Mercado Livre is the ROW
 * UNIT — one row per MODEL (one for a listing without models), because each
 * model carries its own price. Every model row of a listing names the same
 * family ANCHOR and the same `anuncioId`, so:
 *
 *  - the key is built on the model's CHILD (`variacaoProdutoId`), falling back
 *    to the anchor for a listing without models — readable, stable, and
 *    distinct per model without a `#n` suffix in the common case;
 *  - the row carries `variacao` (the child's SKU, else its name), which the
 *    dialog prints, so five models of one listing stop reading identically.
 *
 * ⚠️ `incluirNaoPublicados` is IGNORED, on purpose: Shopee's route has no such
 * rung and the client never sends it. Refusing to price a live listing because
 * the ERP hides the produto is the direction #1072 / #1087 removed; the dialog's
 * checkbox says it governs Mercado Livre only. `baixarPreco` is forwarded.
 *
 * ⚠️ Registered, but unreachable until Shopee's caps row flips `implementado`
 * (#1530) — see `../../caps/registriesAlinhadas.test.ts`.
 */
export const shopeePriceProvider: PricePushProvider = {
  tipos: [INTEGRACAO_TIPO.shopee],

  async enviarPreco(input: PricePushInput): Promise<PricePushChannelResult> {
    const { integracao, produtoIds, deps } = input;
    const client = deps.shopee;

    const chave = makeRowKeyer();
    /** `chaveDe` is the id the KEY is built on — the model's child, or the produto. */
    const linha = (
      chaveDe: string,
      over: Partial<PricePushRow> & Pick<PricePushRow, 'produtoId'>,
    ): PricePushRow => ({
      key: chave(chaveDe, integracao.id, over.anuncioId ?? null),
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

    /** A conta-level verdict, as one row per requested produto. */
    const contaInteira = (
      outcome: PricePushRow['outcome'],
      motivo: string,
      mensagem: string,
      pausadoAte: string | null,
    ): PricePushChannelResult => ({
      pausadoAte,
      rows: produtoIds.map((produtoId) =>
        linha(produtoId, { produtoId, outcome, motivo, mensagem }),
      ),
    });

    if (!client) {
      return contaInteira('falha', 'sem-cliente', 'Você não está logado.', null);
    }

    try {
      const res = await client.enviarPrecos({
        integracaoId: integracao.id,
        produtoIds: [...produtoIds],
        baixarPreco: input.baixarPreco,
        signal: input.signal,
      });

      const rows: PricePushRow[] = res.listings.map((l) =>
        linha(l.variacaoProdutoId ?? l.produtoId, {
          produtoId: l.produtoId,
          // The backend names the FAMILY anchor, with the anchor's own name even
          // when only a variation child was selected. `nomePorProdutoId` is keyed
          // by the SELECTION, so this fallback only covers a selected anchor whose
          // stored name is blank — it can never name an anchor reached via a child.
          produtoNome: l.produtoNome ?? input.nomePorProdutoId.get(l.produtoId) ?? null,
          anuncioId: l.anuncioId,
          linkDocId: l.linkDocId,
          outcome: l.outcome,
          motivo: l.motivo,
          mensagem: l.mensagem,
          preco: l.preco,
          precoAnterior: l.precoAnterior,
          // A blank SKU is common, not an edge case: the ERP's variation generator
          // writes `sku: ''` for every child of a parent with no SKU, so `??`
          // (which only falls through on null) would print no label at all.
          variacao: l.variacaoSku?.trim() || l.variacaoNome?.trim() || null,
        }),
      );
      // A produto that produced no listing at all still gets a row, under the id
      // the operator asked for.
      for (const p of res.produtosSemEnvio) {
        rows.push(
          linha(p.produtoId, {
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
