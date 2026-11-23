/**
 * The listing gate of the Amazon stock sync (step 12, PR 12-d), pure: whether
 * Amazon's LIVE listing of a SKU may receive a merchant-fulfilled quantity, and
 * what quantity it shows now. The patch task (`processarEstoque.ts`, PR 12-e1)
 * makes the live read, through `listings/listingsAmazon.ts`.
 *
 * ## The closed refusal list, in the order it is checked
 *
 * Refusals 1 (`nao-listado`), 2 (`pai`) and 4 (`asin-divergente`), and the
 * shapes counted (`semRelacoes`, `semAsinNaAmazon`, `pacote`), are the shared
 * gate's (`listings/gateListing.ts`, step 13, PR 13-b, ONE for every listings
 * flow; its header holds each rule). This module binds it to the stock flow
 * with stock's own refusal, asked at exactly its point of the order, and the
 * quantity, and keeps the stock names:
 *
 * 3. `afn` — ANY `fulfillmentAvailability` entry whose channel code is not
 *    exactly `DEFAULT` (`CANAL_MFN`): Amazon fulfils that listing, and a
 *    merchant quantity must never reach it. An unknown or missing code is
 *    refused too (fail closed).
 *
 * ## The quantity
 *
 * Every entry is `DEFAULT` by then. The quantity is theirs when every entry
 * carries the SAME non-negative integer; an empty list, an entry without a
 * quantity, or two that disagree read `null` (unknown, which a plan treats as
 * different from the ERP's).
 *
 * ## What it never reads
 *
 * The summary's `status`: a listing Amazon shows as not buyable at quantity 0
 * is exactly the one a restock must reach, so it stays enviável. No ERP
 * catalogue flag either (`publicado` is not an input).
 *
 * Every code, type, marketplace id and ASIN is compared as an EXACT string.
 *
 * PURE: no Firestore, no clock, no network.
 */
import {
  CANAL_MFN,
  DADOS_LISTING_AMAZON,
  type ListingAmazon,
} from '@delfrance/integrations-amazon-sp-api';

import {
  type LeituraListingAmazon,
  TIPO_RELACAO_LISTING_AMAZON as TIPO_RELACAO_DO_GATE,
  type VinculoDoGateListingAmazon,
  avaliarGateListingAmazon,
} from '../listings/gateListing';
import {
  type ContadorEstoqueAmazon,
  MOTIVO_ESTOQUE_AMAZON,
  type RecusaListingEstoqueAmazon,
} from './motivosEstoque';

/**
 * The datasets every live read of the stock sync asks for — the patch task's
 * one listing read and a batch's searches and single reads alike: exactly what
 * this gate reads (the BR summaries, the availability, the relationships).
 */
export const DADOS_LEITURA_ESTOQUE_AMAZON = [
  DADOS_LISTING_AMAZON.resumos,
  DADOS_LISTING_AMAZON.disponibilidade,
  DADOS_LISTING_AMAZON.relacoes,
] as const;

/** The `ItemRelationship` types the gate reads, as the model spells them. */
export const TIPO_RELACAO_LISTING_AMAZON = TIPO_RELACAO_DO_GATE;

/** What the live read answered for the SKU: its listing, or that Amazon has none. */
export type LeituraListingEstoqueAmazon = LeituraListingAmazon;

/** The link's side of the comparison: the ASINs its docs carry. */
export type VinculoDoGateEstoqueAmazon = VinculoDoGateListingAmazon;

export type VeredictoListingEstoqueAmazon =
  | {
      readonly enviavel: true;
      /** Amazon's current merchant quantity, or `null` when it shows none (module header). */
      readonly quantidadeAmazon: number | null;
      readonly contagens: readonly ContadorEstoqueAmazon[];
    }
  | { readonly enviavel: false; readonly motivo: RecusaListingEstoqueAmazon };

/** A quantity the gate accepts: a non-negative safe integer. */
function quantidadeValida(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isSafeInteger(valor) && valor >= 0 ? valor : null;
}

/** Refusal 3, the stock flow's own: merchant-fulfilled only, on every entry. */
function recusaAfn(listing: ListingAmazon): typeof MOTIVO_ESTOQUE_AMAZON.afn | null {
  const disponibilidades = listing.fulfillmentAvailability ?? [];
  return disponibilidades.some((d) => d.fulfillmentChannelCode !== CANAL_MFN)
    ? MOTIVO_ESTOQUE_AMAZON.afn
    : null;
}

/** The listing gate (module header). */
export function avaliarListingEstoqueAmazon(
  listing: LeituraListingEstoqueAmazon,
  vinculo: VinculoDoGateEstoqueAmazon,
): VeredictoListingEstoqueAmazon {
  // 1–4: the shared gate, with refusal 3 after the variation parent.
  const gate = avaliarGateListingAmazon(listing, vinculo, recusaAfn);
  if (!gate.enviavel) return gate;

  // The quantity: one agreed non-negative integer, else unknown.
  const quantidades = (gate.listing.fulfillmentAvailability ?? []).map((d) =>
    quantidadeValida(d.quantity),
  );
  const [primeira] = quantidades;
  const quantidadeAmazon =
    primeira !== undefined && primeira !== null && quantidades.every((q) => q === primeira)
      ? primeira
      : null;

  return { enviavel: true, quantidadeAmazon, contagens: [...gate.contagens] };
}
