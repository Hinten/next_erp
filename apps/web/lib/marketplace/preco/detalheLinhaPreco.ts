import type { PricePushRow } from './types';

/**
 * The trailing detail of one price-push row's subtitle in the progress dialog
 * (`EnviarPrecoDialog`'s `detalheLinha`), appended after
 * `produto - integração · anúncio`.
 *
 * - ` · <variação>` — which MODEL the row is about, when the channel names one.
 *   Shopee prices one row per model, all under the same anchor and anúncio, so
 *   without it five models of one listing read identically (#1529, step 21).
 *   Mercado Livre never sets `variacao`, so its rows render exactly as before.
 * - ` · anúncio a <preço>` — the listing's price, for the rows where it did NOT
 *   change: the old→new price is the one thing an operator checks after a price
 *   push, and the backend's `mensagem` already carries it on a success.
 *
 * `null` when there is nothing to add.
 */
export function detalheLinhaPreco(row: PricePushRow): string | null {
  const variacao =
    typeof row.variacao === 'string' && row.variacao !== '' ? ` · ${row.variacao}` : '';
  const anterior =
    row.outcome !== 'enviado' && row.precoAnterior != null
      ? ` · anúncio a ${String(row.precoAnterior)}`
      : '';
  const detalhe = variacao + anterior;
  return detalhe === '' ? null : detalhe;
}
