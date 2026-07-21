/**
 * Companion to `importItem.ts` / `importVariations.ts` for the ML User-Products
 * model — `family_name != null`: every variation is its OWN MLB item, there is
 * no `variations[]` array, and the variation identity (`attribute_combinations`)
 * lives on the item ROOT. Maps ONE fetched family member to the normalized shape
 * the IO layer assembles into the family parent + this member's child produto
 * (#521; the family fan-out itself — resolving sibling MLB ids — is IO, not
 * mapping, since it needs the API client).
 *
 * Legacy parity (`.old/packages/canais_de_venda/mercado_livre/lib/src/utils/`):
 *  - `produtos.dart:502-504` reads `family_name` / `id` / `family_id` off the
 *    SAME item root passed to `_importarUserProductItem` — one call per member;
 *  - `produtos.dart:729` passes `variacaoData: data` (the item itself) to
 *    `toProdutoArakene` with the comment "UP item tem attribute_combinations na
 *    raiz" — so `combos` reads `item.attribute_combinations` directly, not a
 *    nested variation;
 *  - SKU is `SELLER_SKU` from the item's own `attributes[]`
 *    (`skuFromAttributes`, same as the simple-item path) — NOT the legacy
 *    familyId fallback, which is parent-only (D-C in the #521 design).
 *
 * Pure (no IO) — round-trippable against real item fixtures, same shape as the
 * other two mapping modules.
 */
import { skuFromAttributes } from './importItem';
import type { MappedMlVariation } from './importVariations';
import type { MlItem } from '../types';

/**
 * One User-Products family member, normalized for the IO layer's parent
 * resolution cascade (link-by-itemId → link-by-familyId → SKU) and the shared
 * child-import loop (`importVariationChildren`, parametrized for UP).
 */
export interface MappedUpMember {
  /** `family_id`, stringified. Null only if ML omits it (real UP items always send it). */
  familyId: string | null;
  /** `familyId ?? item.id` — the family/parent dedup key (link `id` field + fresh parent produtoId input). */
  canonicalId: string;
  /** This member's own child-produto shape — reuses the variations-model shape (#520). */
  member: MappedMlVariation;
}

/** Map ONE fetched User-Products member item to the normalized import shape. */
export function mapUpMemberToImport(item: MlItem): MappedUpMember {
  const familyId = item.family_id != null ? String(item.family_id) : null;
  const canonicalId = familyId ?? item.id;

  const combos = item.attribute_combinations ?? [];
  const valueNames = combos
    .map((c) => c.value_name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  const baseName = (item.family_name ?? item.title ?? '').trim();

  return {
    familyId,
    canonicalId,
    member: {
      variationId: item.id,
      sku: skuFromAttributes(item.attributes),
      nome: [baseName, ...valueNames].join(' ').trim(),
      availableQuantity: item.available_quantity ?? 0,
      combos,
      sellerCustomField: item.seller_custom_field ?? null,
    },
  };
}
