/**
 * The order import's ONE Amazon read (master plan step 5, PR 5-d): `getOrder`
 * (Orders v2026-01-01, the fixed `includedData`), through the context's client
 * and the forced-refresh-once rule (`core/renovacaoUnica.ts`). This module is
 * the app's ONLY `getOrder` caller (`estrutura.test.ts`), so a W7 verification
 * script cannot spend the operation's budget.
 *
 * ## The checks, before any Firestore read
 *
 *  1. **Identity.** `order.orderId` byte-equal to the payload's
 *     `amazonOrderId`, inside the 3-7-7 grammar — else
 *     `PedidoAmazonIlegivelError` (`pedido-divergente`): the deterministic
 *     pedido id would key another order's document.
 *  2. **The watermark.** `lastUpdatedTime` through `lerInstanteAmazon` (offset
 *     REQUIRED, µs from Amazon's text) — else `instante-ilegivel`, never a
 *     guessed instant.
 *  3. **Line identity.** A duplicate `orderItemId` refuses the order
 *     (`linha-duplicada`; `linhasRecebidasAmazon`, the mappers' own reader).
 *  4. **A poll payload newer than the read** (plan §3 decision 3): the fetched
 *     µs strictly below the payload's `lastUpdatedUs` is a lagging read. On a
 *     QUEUE attempt (`registro.tentativa` non-null) it throws the retryable
 *     `AmazonLeituraDefasadaError` — the queue retries after 10 s and 20 s, and
 *     its last attempt persists `failed`. In a SWEEP re-drive (`tentativa`
 *     `null`, at least 30 min later) the read is imported as it is and the
 *     caller writes a WARNING count line: the poll's `vistos` already holds the
 *     newer stamp and will never re-enqueue the order, so a refusal that never
 *     ends would strand it for good, while the stored pedido's watermark still
 *     protects it from a regression. A push payload carries no order clock: it
 *     is never compared (the payload is never a data source, D5).
 *  5. **The BR marketplace.** A present `salesChannel.marketplaceId` other than
 *     BR's, or a present `channelName` other than `AMAZON` ⇒
 *     `marketplace-estrangeiro` (dropped by the disposition). Absent or blank
 *     is no evidence: the order was fetched through the BR conta.
 *
 * Every refusal is a closed code; nothing here logs (the importer does, with
 * ids and counts only).
 */
import {
  MARKETPLACE_ID_BR,
  buscarPedido,
  type PedidoWireAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import { ORIGEM_NOTIFICACAO_AMAZON, PEDIDO_AMAZON_REGEX } from '@delfrance/schemas';

import type { ContextoAmazon } from '../core/contexto';
import { executarComRenovacaoUnica } from '../core/renovacaoUnica';
import type { PayloadNotificacaoAmazon, RegistroLeituraAmazon } from '../notificacoes/notificacao';
import {
  AmazonLeituraDefasadaError,
  MOTIVO_PEDIDO_AMAZON_ILEGIVEL,
  PedidoAmazonIlegivelError,
} from './erros';
import { linhasRecebidasAmazon } from './itensAmazon';
import { lerInstanteAmazon } from './janelaPoll';

/** The one `salesChannel.channelName` this import accepts (exact). */
export const CANAL_DE_VENDA_AMAZON = 'AMAZON';

/** What the read answers. */
export type LeituraPedidoAmazon =
  | {
      readonly tipo: 'lido';
      readonly order: PedidoWireAmazon;
      /** `lastUpdatedTime`, µs, read straight from Amazon's text. */
      readonly watermarkUs: number;
      /** A sweep re-drive imported a read older than its poll payload (check 4). */
      readonly defasadaAceita: boolean;
    }
  | { readonly tipo: 'marketplace-estrangeiro' };

/** What the read needs of a context: its conta id, its client and the access getter. */
export type ContextoDeLeituraAmazon = Pick<
  ContextoAmazon,
  'integracaoId' | 'cliente' | 'obterAcesso'
>;

/** A wire text, or `null` when absent or blank. */
function presente(valor: string | null | undefined): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor : null;
}

/** Check 5: a PRESENT marketplace or channel that is not the BR one. */
function estrangeiro(order: PedidoWireAmazon): boolean {
  const marketplace = presente(order.salesChannel?.marketplaceId);
  const canal = presente(order.salesChannel?.channelName);
  return (
    (marketplace !== null && marketplace !== MARKETPLACE_ID_BR) ||
    (canal !== null && canal !== CANAL_DE_VENDA_AMAZON)
  );
}

/**
 * One `getOrder`, checked (module header).
 *
 * @throws {PedidoAmazonIlegivelError} on checks 1–3 (deterministic: park).
 * @throws {AmazonLeituraDefasadaError} on check 4, queue attempts only (retry).
 * @throws every package error of the read as-is (the step-3 classifier's).
 */
export async function lerPedidoAmazon(
  contexto: ContextoDeLeituraAmazon,
  payload: PayloadNotificacaoAmazon,
  registro: Pick<RegistroLeituraAmazon, 'tentativa'>,
): Promise<LeituraPedidoAmazon> {
  const resposta = await executarComRenovacaoUnica(contexto, () =>
    buscarPedido(contexto.cliente, payload.amazonOrderId),
  );
  const { order } = resposta.dados;

  // 1. Identity: byte-equal, inside the grammar.
  if (order.orderId !== payload.amazonOrderId || !PEDIDO_AMAZON_REGEX.test(order.orderId)) {
    throw new PedidoAmazonIlegivelError(
      payload.amazonOrderId,
      MOTIVO_PEDIDO_AMAZON_ILEGIVEL.pedidoDivergente,
    );
  }
  // 2. The watermark, offset required.
  const instante = lerInstanteAmazon(order.lastUpdatedTime);
  if (instante === null) {
    throw new PedidoAmazonIlegivelError(
      order.orderId,
      MOTIVO_PEDIDO_AMAZON_ILEGIVEL.instanteIlegivel,
    );
  }
  // 3. Line identity (throws on a duplicate `orderItemId`).
  linhasRecebidasAmazon(order);

  // 4. A lagging read of a poll task: refused on a queue attempt only.
  let defasadaAceita = false;
  if (payload.origem === ORIGEM_NOTIFICACAO_AMAZON.poll && instante.us < payload.lastUpdatedUs) {
    if (registro.tentativa !== null) {
      throw new AmazonLeituraDefasadaError(contexto.integracaoId, order.orderId);
    }
    defasadaAceita = true;
  }

  // 5. The BR marketplace.
  if (estrangeiro(order)) return { tipo: 'marketplace-estrangeiro' };
  return { tipo: 'lido', order, watermarkUs: instante.us, defasadaAceita };
}
