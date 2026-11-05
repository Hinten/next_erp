import { marcaShopeeArmazenadaSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Typed handle for a Shopee conta's BRAND SHORTLIST, the
 * `integracao/{integracaoId}/brandshopee` subcollection (#1911, D10): the
 * brands an operator registered so a draft's brand picker never waits on
 * Shopee's slow brand API. The Marcas section of `/canais/shopee/[id]` reads
 * and writes it; the draft editor's picker reads it.
 *
 * ⚠️ A soft-read hands back the RAW document when the schema refuses it (a
 * legacy row with a quoted `brand_id`, a foreign writer's row), so every
 * reader goes through `marcasDaContaShopee` (`@delfrance/schemas`, the ONE
 * reader — #1369), never a field it assumes is typed. That reader also
 * collapses the legacy duplicates (several auto-id docs naming one brand).
 *
 * Writes are the Marcas section's alone, as guarded sibling writes of the
 * conta's save (`lib/shopee/marcasDaConta.ts`): a registration at the
 * deterministic id `docIdDaMarcaShopee(brandId)`, a removal of every doc of
 * the brand. Nothing on a server writes here, and the publisher never reads
 * it.
 *
 * Rules coverage comes from `brandShopeeMeta` (the loose rules domain in
 * `@delfrance/schemas`' `integracao.ts`), already in `ALL_DOMAINS`, so this
 * handle needs no ruleset regeneration. Reads take the WHOLE subcollection with
 * no filter and no order (`lib/shopee/marcas.ts`), so they need no index.
 */
export const marcaShopeeCollection = defineCollection({
  path: 'integracao/{integracaoId}/brandshopee',
  schema: marcaShopeeArmazenadaSchema,
});
