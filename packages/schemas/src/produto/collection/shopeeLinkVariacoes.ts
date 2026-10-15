import { z } from 'zod';

/**
 * The `grupoDeVariacoes.linksVariacoesShopee[]` element — the Flutter
 * `LinkVariacoesShopee` shape, byte for byte
 * (`.old/packages/produtos/lib/src/models.dart:5190-5263`). Step 9 (#1517) is
 * its FIRST non-Flutter author: the array is not per-produto, it hangs on the
 * grupo, one entry per (integração, Shopee category).
 *
 * ⚠️ THREE traps, each a real field of the legacy model:
 *  1. `variation_group_list` is a SCALAR int despite the plural name (the group
 *     id). An array here is a bug, not a shape to tolerate.
 *  2. `integracaoShopeeId` is a BARE doc id — NOT a `documents/integracao/<id>`
 *     outer-ref, unlike every other conta reference in the Shopee models.
 *     Normalising it to a path without a migration orphans every
 *     operator-authored entry, so this schema deliberately neither normalises
 *     nor refuses a stored `documents/…` value: it stores the string it is
 *     given. Only blank is refused.
 *  3. `arakene_variation_id` is a LIST: one Shopee option may map to several
 *     ERP variantes, and the legacy export reader takes `.first` of the
 *     matching options.
 *
 * ⚠️ `0` is a VALUE, not an absence, at both id levels (`announcement 873`,
 * `faq 288` — outside Fashion every tier/option is custom and only the NAMES
 * identify them): the legacy types both ids as non-nullable ints, so `0` is the
 * only expressible "custom". Never refused here, never defaulted away.
 *
 * This schema is wired into `grupoDeVariacoesSchema`; stored mappings reject
 * unknown properties instead of carrying provider-unrelated metadata.
 */

/** One Shopee tier OPTION of a {@link linkVariacoesShopeeSchema} entry. */
export const linkVariacaoOpcaoShopeeSchema = z.strictObject({
  /** `0` = a CUSTOM option; the name is then the only identity it has. */
  shopee_option_id: z.number().int(),
  shopee_option_name: z.string(),
  /** ERP Variante ids — a LIST, bare ids, MANY per option (trap 3). */
  arakene_variation_id: z.array(z.string()),
});
export type LinkVariacaoOpcaoShopee = z.infer<typeof linkVariacaoOpcaoShopeeSchema>;

/** One `(integração, Shopee category)` mapping on a `grupoDeVariacoes` doc. */
export const linkVariacoesShopeeSchema = z.strictObject({
  /** The LEAF category's display name — what the operator picked in the Flutter form. */
  name: z.string(),
  category_id: z.number().int(),
  /** `0` = a CUSTOM variation (trap: `0` is a value, never an absence). */
  variation_id: z.number().int(),
  /** A SCALAR int despite the plural name — the group id (trap 1). */
  variation_group_list: z.number().int(),
  /** A BARE integração doc id, stored verbatim — never an outer-ref path (trap 2). */
  integracaoShopeeId: z.string().min(1),
  variationOptions: z.array(linkVariacaoOpcaoShopeeSchema).default([]),
});
export type LinkVariacoesShopee = z.infer<typeof linkVariacoesShopeeSchema>;
