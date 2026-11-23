/**
 * The listing gate of the Amazon listings flows (step 13, PR 13-b), pure: the
 * checks on Amazon's LIVE listing of a SKU that hold for EVERY flow, before
 * any flow sends it a value. A flow binds it and adds what is its own (the
 * stock flow, `estoque/gateListing.ts`: the fulfilment channel and the
 * quantity Amazon shows).
 *
 * ## The closed refusal list, in the order it is checked
 *
 * 1. `nao-listado` — no listing for the SKU, or no `summaries` entry for the
 *    BR store (`MARKETPLACE_ID_BR`);
 * 2. `pai` — a relationship block for the BR store holds a `VARIATION`
 *    relationship with a non-empty `childSkus`: a variation parent sells
 *    nothing of its own. A `PACKAGE_HIERARCHY` container is a sellable
 *    listing (counted `pacote`); so are another store's blocks and a
 *    `VARIATION` with no children;
 *    — then the binding's OWN refusal, when it has one
 *    ({@link avaliarGateListingAmazon}'s `recusaDoFluxo`), at exactly this
 *    point of the order;
 * 3. `asin-divergente` — the link and the BR summary both carry an ASIN, and
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
 * ## What it never reads
 *
 * The summary's `status` (a listing Amazon shows as not buyable is not refused
 * here), the fulfilment channel and the quantity: those are a flow's own
 * questions. No ERP catalogue flag either (`publicado` is not an input).
 *
 * Every code, type, marketplace id and ASIN is compared as an EXACT string.
 *
 * PURE: no Firestore, no clock, no network.
 */
import { type ListingAmazon, MARKETPLACE_ID_BR } from '@delfrance/integrations-amazon-sp-api';

/** A refusal of the shared gate (module header), in the order it is checked. */
export type RecusaGateListingAmazon = 'nao-listado' | 'pai' | 'asin-divergente';

/** The closed refusal set, so code names a member instead of spelling a slug. */
export const MOTIVO_GATE_LISTING_AMAZON = {
  naoListado: 'nao-listado',
  pai: 'pai',
  asinDivergente: 'asin-divergente',
} as const satisfies Record<string, RecusaGateListingAmazon>;

/** What the shared gate counts, never refuses. */
export type ContadorGateListingAmazon = 'semRelacoes' | 'pacote' | 'semAsinNaAmazon';

/** The closed counter set; each key is its own token. */
export const CONTADOR_GATE_LISTING_AMAZON = {
  semRelacoes: 'semRelacoes',
  pacote: 'pacote',
  semAsinNaAmazon: 'semAsinNaAmazon',
} as const satisfies Record<string, ContadorGateListingAmazon>;

/** The `ItemRelationship` types the gate reads, as the model spells them. */
export const TIPO_RELACAO_LISTING_AMAZON = {
  variacao: 'VARIATION',
  pacote: 'PACKAGE_HIERARCHY',
} as const;

/** What the live read answered for the SKU: its listing, or that Amazon has none. */
export type LeituraListingAmazon = ListingAmazon | typeof MOTIVO_GATE_LISTING_AMAZON.naoListado;

/** The link's side of the comparison: the ASINs its docs carry. */
export interface VinculoDoGateListingAmazon {
  readonly asinsDoVinculo: readonly string[];
}

/** The gate's verdict; `M` is the binding's own refusal, when it has one. */
export type VeredictoGateListingAmazon<M extends string = never> =
  | {
      readonly enviavel: true;
      /** The listing the gate passed (never `nao-listado`). */
      readonly listing: ListingAmazon;
      readonly contagens: readonly ContadorGateListingAmazon[];
    }
  | { readonly enviavel: false; readonly motivo: RecusaGateListingAmazon | M };

/** A non-empty string, or `null`. */
function textoNaoVazio(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/**
 * The shared gate (module header). `recusaDoFluxo`, when given, is the
 * binding's own check, run after refusal 2 and before refusal 3: its motivo
 * refuses the listing, `null` lets it through.
 */
export function avaliarGateListingAmazon<M extends string = never>(
  listing: LeituraListingAmazon,
  vinculo: VinculoDoGateListingAmazon,
  recusaDoFluxo?: (listing: ListingAmazon) => M | null,
): VeredictoGateListingAmazon<M> {
  // 1. Listed in the BR store at all.
  if (listing === MOTIVO_GATE_LISTING_AMAZON.naoListado) {
    return { enviavel: false, motivo: MOTIVO_GATE_LISTING_AMAZON.naoListado };
  }
  const resumosBr = (listing.summaries ?? []).filter((r) => r.marketplaceId === MARKETPLACE_ID_BR);
  if (resumosBr.length === 0) {
    return { enviavel: false, motivo: MOTIVO_GATE_LISTING_AMAZON.naoListado };
  }

  const contagens: ContadorGateListingAmazon[] = [];

  // 2. A BR variation parent sells nothing of its own.
  const blocosBr = (listing.relationships ?? []).filter(
    (b) => b.marketplaceId === MARKETPLACE_ID_BR,
  );
  if (blocosBr.length === 0) contagens.push(CONTADOR_GATE_LISTING_AMAZON.semRelacoes);
  let pacote = false;
  for (const bloco of blocosBr) {
    for (const relacao of bloco.relationships ?? []) {
      const comFilhos = (relacao.childSkus ?? []).length > 0;
      if (!comFilhos) continue;
      if (relacao.type === TIPO_RELACAO_LISTING_AMAZON.variacao) {
        return { enviavel: false, motivo: MOTIVO_GATE_LISTING_AMAZON.pai };
      }
      if (relacao.type === TIPO_RELACAO_LISTING_AMAZON.pacote) pacote = true;
    }
  }
  if (pacote) contagens.push(CONTADOR_GATE_LISTING_AMAZON.pacote);

  // The binding's own refusal, at this point of the order.
  const propria = recusaDoFluxo?.(listing) ?? null;
  if (propria !== null) return { enviavel: false, motivo: propria };

  // 3. The two ASINs, when both exist.
  const asinsAmazon = [
    ...new Set(resumosBr.map((r) => textoNaoVazio(r.asin)).filter((a): a is string => a !== null)),
  ];
  if (asinsAmazon.length === 0) {
    contagens.push(CONTADOR_GATE_LISTING_AMAZON.semAsinNaAmazon);
  } else if (vinculo.asinsDoVinculo.some((a) => asinsAmazon.some((b) => b !== a))) {
    return { enviavel: false, motivo: MOTIVO_GATE_LISTING_AMAZON.asinDivergente };
  }

  return { enviavel: true, listing, contagens };
}
