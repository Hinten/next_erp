/**
 * The listings FLOWS the shared `listings/` modules are parameterised by (step
 * 13, PR 13-b): stock and price, the two flows that write a listing's offer.
 * Each shared rule takes the flow and binds what differs per flow (the
 * outcome field on a link doc, the refusals only one flow has, the masks)
 * from it; the rule itself is written once.
 *
 * The values are the write valves' own batch flows (`FLUXOS_COM_LOTE`,
 * `core/valvulas.ts`), so one flow name reaches the valve, the feed lease id
 * and these modules unchanged (`fluxoListing.test.ts`).
 *
 * ⚠️ LIGHT on purpose: it imports nothing, so a module on any closure (the
 * avisos seam included) may name a flow without loading a shared rule.
 */

/** A listings flow. */
export type FluxoListingAmazon = 'estoque' | 'preco';

/** The closed set, so code names a member instead of spelling a flow. */
export const FLUXO_LISTING_AMAZON = {
  estoque: 'estoque',
  preco: 'preco',
} as const satisfies Record<string, FluxoListingAmazon>;
