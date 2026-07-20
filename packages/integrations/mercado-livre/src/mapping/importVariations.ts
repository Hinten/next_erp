/**
 * Companion to `importItem.ts` for the ML variations model (legacy
 * `variations[]`, distinct from the `family_name` / User-Products model that
 * module rejects — see #521). Turns a fetched item's `variations[]` into one
 * normalized `MappedMlVariation` per usable variation; the app assembles each
 * into a child produto + taxonomy (grupoDeVariacoes/Variante) + estoque +
 * `variacaoMercadoLivre` link (#520).
 *
 * Legacy parity (`.old/packages/canais_de_venda/mercado_livre/lib/src/`):
 *  - name = `title + ' ' + attribute_combinations value_names joined ' '`
 *    (`utils/models.dart:1097-1103`);
 *  - SKU comes from the variation's own `attributes[]` (`SELLER_SKU`), NOT
 *    `attribute_combinations` — mirrors `skuFromAttributes` in `importItem.ts`;
 *  - per-variation prices are rejected by ML itself (`models.dart:1624`), so
 *    there is no `preco` field here — the app copies the parent's whole
 *    `precos` map onto every child (`utils/produtos.dart:284-290`).
 *
 * Pure (no IO) — round-trippable against real item fixtures, same shape as
 * `importItem.ts`.
 */
import { skuFromAttributes } from './importItem';
import type { MlItem, MlItemAttribute } from '../types';

/** The normalized shape one ML variation maps to (child produto + taxonomy input). */
export interface MappedMlVariation {
  /** ML variation id, stringified (the link doc's `id` + the cross-app dedup key). */
  variationId: string;
  /** `SELLER_SKU` from the variation's own `attributes[]` (not `attribute_combinations`). */
  sku: string | null;
  /** `title + ' ' + attribute_combinations value_names joined ' '`, trimmed. */
  nome: string;
  availableQuantity: number;
  /** Raw `attribute_combinations[]` — the taxonomy resolver's input (#520). */
  combos: MlItemAttribute[];
  sellerCustomField: string | null;
}

/**
 * Map an item's `variations[]` to the normalized import shape, one entry per
 * variation with a usable (non-null, non-empty) `id`. Variations without an id
 * are skipped — there is nothing stable to key the child produto / link doc on.
 */
export function mapMlVariationsToImport(item: MlItem): MappedMlVariation[] {
  const title = item.title ?? '';
  const mapped: MappedMlVariation[] = [];

  for (const v of item.variations ?? []) {
    if (v.id == null) continue;
    const variationId = String(v.id);
    if (variationId.length === 0) continue;

    const combos = v.attribute_combinations ?? [];
    const valueNames = combos
      .map((c) => c.value_name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);

    mapped.push({
      variationId,
      sku: skuFromAttributes(v.attributes),
      nome: [title, ...valueNames].join(' ').trim(),
      availableQuantity: v.available_quantity ?? 0,
      combos,
      sellerCustomField: v.seller_custom_field ?? null,
    });
  }

  return mapped;
}
