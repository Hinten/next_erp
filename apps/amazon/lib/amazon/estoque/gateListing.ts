/**
 * The listing gate of the Amazon stock sync (step 12, PR 12-d), pure: whether
 * Amazon's LIVE listing of a SKU may receive a merchant-fulfilled quantity, and
 * what quantity it shows now. The patch task (`processarEstoque.ts`, PR 12-e1)
 * makes the live read, through `listings/listingsAmazon.ts`.
 *
 * ## The closed refusal list, in the order it is checked
 *
 * 1. `nao-listado` — no listing for the SKU, or no `summaries` entry for the
 *    BR store (`MARKETPLACE_ID_BR`);
 * 2. `pai` — a relationship block for the BR store holds a `VARIATION`
 *    relationship with a non-empty `childSkus`: a variation parent sells
 *    nothing of its own. A `PACKAGE_HIERARCHY` container is a sellable
 *    listing and stays enviável (counted `pacote`); so do another store's
 *    blocks and a `VARIATION` with no children;
 * 3. `afn` — ANY `fulfillmentAvailability` entry whose channel code is not
 *    exactly `DEFAULT` (`CANAL_MFN`): Amazon fulfils that listing, and a
 *    merchant quantity must never reach it. An unknown or missing code is
 *    refused too (fail closed);
 * 4. `asin-divergente` — the link and the BR summary both carry an ASIN, and
 *    they differ: the link may describe another listing.
 *
 * ## Accepted, and counted
 *
 * - no relationship block for the BR store at all (`semRelacoes`): whether
 *   Amazon omits an empty block is unknown, and failing closed would refuse
 *   every simple listing;
 * - a BR summary without an ASIN (`semAsinNaAmazon`);
 * - a `PACKAGE_HIERARCHY` container (`pacote`).
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
  type ListingAmazon,
  MARKETPLACE_ID_BR,
} from '@delfrance/integrations-amazon-sp-api';

import {
  CONTADOR_ESTOQUE_AMAZON,
  type ContadorEstoqueAmazon,
  MOTIVO_ESTOQUE_AMAZON,
  type RecusaListingEstoqueAmazon,
} from './motivosEstoque';

/** The `ItemRelationship` types the gate reads, as the model spells them. */
export const TIPO_RELACAO_LISTING_AMAZON = {
  variacao: 'VARIATION',
  pacote: 'PACKAGE_HIERARCHY',
} as const;

/** What the live read answered for the SKU: its listing, or that Amazon has none. */
export type LeituraListingEstoqueAmazon = ListingAmazon | typeof MOTIVO_ESTOQUE_AMAZON.naoListado;

/** The link's side of the comparison: the ASINs its docs carry. */
export interface VinculoDoGateEstoqueAmazon {
  readonly asinsDoVinculo: readonly string[];
}

export type VeredictoListingEstoqueAmazon =
  | {
      readonly enviavel: true;
      /** Amazon's current merchant quantity, or `null` when it shows none (module header). */
      readonly quantidadeAmazon: number | null;
      readonly contagens: readonly ContadorEstoqueAmazon[];
    }
  | { readonly enviavel: false; readonly motivo: RecusaListingEstoqueAmazon };

function recusa(motivo: RecusaListingEstoqueAmazon): VeredictoListingEstoqueAmazon {
  return { enviavel: false, motivo };
}

/** A non-empty string, or `null`. */
function textoNaoVazio(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/** A quantity the gate accepts: a non-negative safe integer. */
function quantidadeValida(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isSafeInteger(valor) && valor >= 0 ? valor : null;
}

/** The listing gate (module header). */
export function avaliarListingEstoqueAmazon(
  listing: LeituraListingEstoqueAmazon,
  vinculo: VinculoDoGateEstoqueAmazon,
): VeredictoListingEstoqueAmazon {
  // 1. Listed in the BR store at all.
  if (listing === MOTIVO_ESTOQUE_AMAZON.naoListado) return recusa(MOTIVO_ESTOQUE_AMAZON.naoListado);
  const resumosBr = (listing.summaries ?? []).filter((r) => r.marketplaceId === MARKETPLACE_ID_BR);
  if (resumosBr.length === 0) return recusa(MOTIVO_ESTOQUE_AMAZON.naoListado);

  const contagens: ContadorEstoqueAmazon[] = [];

  // 2. A BR variation parent sells nothing of its own.
  const blocosBr = (listing.relationships ?? []).filter(
    (b) => b.marketplaceId === MARKETPLACE_ID_BR,
  );
  if (blocosBr.length === 0) contagens.push(CONTADOR_ESTOQUE_AMAZON.semRelacoes);
  let pacote = false;
  for (const bloco of blocosBr) {
    for (const relacao of bloco.relationships ?? []) {
      const comFilhos = (relacao.childSkus ?? []).length > 0;
      if (!comFilhos) continue;
      if (relacao.type === TIPO_RELACAO_LISTING_AMAZON.variacao) {
        return recusa(MOTIVO_ESTOQUE_AMAZON.pai);
      }
      if (relacao.type === TIPO_RELACAO_LISTING_AMAZON.pacote) pacote = true;
    }
  }
  if (pacote) contagens.push(CONTADOR_ESTOQUE_AMAZON.pacote);

  // 3. Merchant-fulfilled only, on every entry.
  const disponibilidades = listing.fulfillmentAvailability ?? [];
  if (disponibilidades.some((d) => d.fulfillmentChannelCode !== CANAL_MFN)) {
    return recusa(MOTIVO_ESTOQUE_AMAZON.afn);
  }

  // 4. The two ASINs, when both exist.
  const asinsAmazon = [
    ...new Set(resumosBr.map((r) => textoNaoVazio(r.asin)).filter((a): a is string => a !== null)),
  ];
  if (asinsAmazon.length === 0) {
    contagens.push(CONTADOR_ESTOQUE_AMAZON.semAsinNaAmazon);
  } else if (vinculo.asinsDoVinculo.some((a) => asinsAmazon.some((b) => b !== a))) {
    return recusa(MOTIVO_ESTOQUE_AMAZON.asinDivergente);
  }

  // The quantity: one agreed non-negative integer, else unknown.
  const quantidades = disponibilidades.map((d) => quantidadeValida(d.quantity));
  const [primeira] = quantidades;
  const quantidadeAmazon =
    primeira !== undefined && primeira !== null && quantidades.every((q) => q === primeira)
      ? primeira
      : null;

  return { enviavel: true, quantidadeAmazon, contagens };
}
