/**
 * **The shop's logistics channels for ONE produto, each with the publisher's
 * own verdict** (#1911 P15) — the IO half of the `canais` route
 * (`app/api/marketplace/shopee/canais/route.ts`), which the draft editor's
 * Logística section (P16) reads.
 *
 * ## The sequence — one read by id, then one Shopee call
 *
 * 1. The produto, by id (`produtoCollection`), FIRST: an absent produto answers
 *    `produto-inexistente` before any Shopee call, so the route's 404 costs the
 *    shop nothing.
 * 2. Its parcel through the publisher's OWN readers — `produtoParaPublicar`,
 *    then `pesoParaPublicar` / `dimensaoParaPublicar` — the projection a publish
 *    reads, so the editor and the publish can never read a weight or a box two
 *    ways (#1369). The fit is therefore the STORED produto's: an unsaved weight
 *    edit is not reflected, exactly as a publish would not see it.
 * 3. ONE `get_channel_list`, UNCACHED (`lerCanaisDaLoja`): a stale list would
 *    offer a channel the shop closed minutes ago, and publish reads it uncached
 *    for the same reason.
 * 4. `avaliarCanaisDaLojaShopee` (`logisticaPublicacao.ts`) — the full pass's
 *    own per-channel decision — mapped onto the `@delfrance/schemas` envelope
 *    `respostaCanaisShopeeSchema`, in `get_channel_list` order.
 *
 * Writes nothing, keeps no module-level state, reads no clock and catches
 * nothing: a Shopee failure propagates to the route's `shopeeErrorResponse`,
 * anything else rethrows (root CLAUDE.md rule 6).
 *
 * ## ⚠️ It COMPOSES the publisher and re-derives no channel rule
 *
 * `selecionavel`, `obrigatorio`, the fit, the fee-type verdicts and the masked
 * `isFree` all come from `logisticaPublicacao.ts`. This module reads exactly
 * three things off a channel itself: its id, its name (through
 * `textoUtilizavelShopee`, the reader P14b's channel sentence uses — trimmed,
 * blank ⇒ `null`) and the DTO's own flag `block_seller_cover_shipping_fee`. A
 * raw-text pin in this module's suite forbids every other provider-rule read
 * here, so a second copy of a rule cannot drift in beside the one copy.
 *
 * ⚠️ A verdict, never a decision: publish re-reads the channels and recomputes
 * every verdict, so a stale answer can mislead a screen but never a send.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { ShopeeClient } from '@delfrance/integrations-shopee';
import {
  MOTIVO_INDISPONIVEL_CANAL_SHOPEE,
  textoUtilizavelShopee,
  type MotivoIndisponivelCanalShopee,
  type RespostaCanaisShopee,
} from '@delfrance/schemas';
import { produtoCollection } from '@delfrance/data/admin/collections';

import { avaliarCanaisDaLojaShopee, type MotivoCanalPulado } from './logisticaPublicacao';
import { dimensaoParaPublicar, pesoParaPublicar } from './montagemAnuncio';
import { lerCanaisDaLoja, produtoParaPublicar } from './publicarAnuncio';

/** What one read answers: the produto is gone, or the envelope the route returns as its 200. */
export type LeituraCanaisDoRascunhoShopee =
  | { readonly tipo: 'produto-inexistente' }
  | { readonly tipo: 'ok'; readonly resposta: RespostaCanaisShopee };

/**
 * The publisher's DIAGNOSTIC motivo → the DTO's coarse `indisponivel`.
 *
 * Keyed on the WHOLE union (`satisfies Record<MotivoCanalPulado, …>`), so a
 * tenth member is a compile error here until someone decides what the editor
 * says about it.
 * - A channel the publish could never send (not enabled at shop level, a
 *   fulfillment channel) answers `null`: `selecionavel: false` already says it.
 * - `desligado-no-vinculo` is unreachable: there is no stored list here.
 */
const INDISPONIVEL = {
  'nao-habilitado-na-loja': null,
  'canal-de-fulfillment': null,
  // Unreachable: no stored list here, so nothing is switched off in a vínculo.
  'desligado-no-vinculo': null,
  'peso-fora-do-limite': MOTIVO_INDISPONIVEL_CANAL_SHOPEE.naoCabe,
  'dimensao-fora-do-limite': MOTIVO_INDISPONIVEL_CANAL_SHOPEE.naoCabe,
  'soma-de-dimensoes-excedida': MOTIVO_INDISPONIVEL_CANAL_SHOPEE.naoCabe,
  'unidade-desconhecida': MOTIVO_INDISPONIVEL_CANAL_SHOPEE.limiteIlegivel,
  'size-selection-sem-size-id': MOTIVO_INDISPONIVEL_CANAL_SHOPEE.exigeValorDoSellerCentre,
  'custom-price-sem-tarifa': MOTIVO_INDISPONIVEL_CANAL_SHOPEE.exigeValorDoSellerCentre,
} as const satisfies Record<MotivoCanalPulado, MotivoIndisponivelCanalShopee | null>;

/**
 * Read ONE produto and the shop's channels, and answer each channel with the
 * verdict a publish of that produto would give it — or `produto-inexistente`,
 * with zero Shopee calls.
 *
 * `medidasCompletas` is `true` exactly when the parcel has a weight AND all
 * three dimensions, by the same readers the publish refuses `sem-peso` /
 * `sem-dimensoes` with.
 */
export async function lerCanaisDoRascunhoShopee(
  deps: { readonly db: Firestore; readonly client: ShopeeClient },
  entrada: { readonly produtoId: string },
): Promise<LeituraCanaisDoRascunhoShopee> {
  const snap = await produtoCollection.docRef(deps.db, {}, entrada.produtoId).get();
  if (!snap.exists) return { tipo: 'produto-inexistente' };
  const produto = produtoParaPublicar(
    entrada.produtoId,
    (snap.data() ?? {}) as Record<string, unknown>,
  );
  const pesoKg = pesoParaPublicar(produto);
  const dimensaoCm = dimensaoParaPublicar(produto);

  const canais = await lerCanaisDaLoja(deps.client);
  const avaliados = avaliarCanaisDaLojaShopee({
    canais,
    pesoKg,
    dimensaoCm,
    ofereceFreteGratis: produto.ofereceFreteGratis,
  });

  return {
    tipo: 'ok',
    resposta: {
      medidasCompletas: pesoKg !== null && dimensaoCm !== null,
      canais: avaliados.map((a) => ({
        logisticsChannelId: a.canal.logistics_channel_id,
        // The reader P14b's channel sentence uses (#1369): trimmed, blank ⇒ null.
        nome: textoUtilizavelShopee(a.canal.logistics_channel_name),
        selecionavel: a.selecionavel,
        obrigatorio: a.obrigatorio,
        bloqueiaFreteGratisDoVendedor: a.canal.block_seller_cover_shipping_fee === true,
        indisponivel: a.motivo === null ? null : INDISPONIVEL[a.motivo],
        // The full pass's own entry, `is_free` already masked by the block flag.
        automatica: a.entrada === null ? null : { isFree: a.entrada.is_free },
      })),
    },
  };
}
