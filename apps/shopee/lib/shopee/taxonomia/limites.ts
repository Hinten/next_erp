/**
 * The per-shop / per-category bands: `get_item_limit` and `get_kit_item_limit`.
 *
 * ⚠️ **Every number here is a fact about ONE shop and ONE category.** The pages
 * print sample numbers; guide 209 §6 says the real ones vary per shop and per
 * category. Nothing in this repo may hardcode one, and that is also why the
 * cache keys start with `integracaoId`.
 *
 * ⚠️ **The kit bands are never derived from the item bands.** The two pages
 * disagree field by field — the description key differs
 * (`description_limit` vs `extended_description_limit`, with two extra fields),
 * only the kit declares `support_pre_order` and
 * `component_count_limit_of_single_model`, and even the shared band names carry
 * different numbers. Reading kit limits off `get_item_limit` would publish a kit
 * against an item's ceiling, and Shopee would reject it with a message about a
 * field the operator never touched.
 *
 * ⚠️ **A failure here SURFACES.** No `limites: null` degrade anywhere in this
 * module: step 11 composes a publish payload from these numbers, and a caller
 * that receives `null` either stops (a 502 with extra steps) or falls back to
 * hardcoded numbers — which is the failure this whole module exists to prevent.
 */
import { z } from 'zod';
import type {
  ShopeeFaixa,
  ShopeeItemLimit,
  ShopeeKitItemLimit,
} from '@delfrance/integrations-shopee';

import { type ShopeeTaxonomiaCtx, lerLimitesItemCached, lerLimitesKitCached } from './cache';

/* -------------------------------------------------------------------------- */
/*                                   Shapes                                   */
/* -------------------------------------------------------------------------- */

export const faixaDtoSchema = z.object({
  min: z.number().nullable(),
  max: z.number().nullable(),
});
export type FaixaDto = z.infer<typeof faixaDtoSchema>;

export const gtinLimitDtoSchema = z.object({
  gtinValidationRule: z.string().nullable(),
});
export type GtinLimitDto = z.infer<typeof gtinLimitDtoSchema>;

export const limitesDescricaoEstendidaDtoSchema = z.object({
  descriptionTextLengthMin: z.number().nullable(),
  descriptionTextLengthMax: z.number().nullable(),
  descriptionImageNumMin: z.number().nullable(),
  descriptionImageNumMax: z.number().nullable(),
  descriptionImageWidthMin: z.number().nullable(),
  descriptionImageHeightMin: z.number().nullable(),
  descriptionImageAspectRatioMin: z.number().nullable(),
  descriptionImageAspectRatioMax: z.number().nullable(),
});

export const limitesDeItemDtoSchema = z.object({
  priceLimit: faixaDtoSchema.nullable(),
  wholesalePriceThresholdPercentage: faixaDtoSchema.nullable(),
  stockLimit: faixaDtoSchema.nullable(),
  itemNameLengthLimit: faixaDtoSchema.nullable(),
  itemImageCountLimit: faixaDtoSchema.nullable(),
  itemDescriptionLengthLimit: faixaDtoSchema.nullable(),
  tierVariationNameLengthLimit: faixaDtoSchema.nullable(),
  tierVariationOptionLengthLimit: faixaDtoSchema.nullable(),
  itemCountLimit: faixaDtoSchema.nullable(),
  extendedDescriptionLimit: limitesDescricaoEstendidaDtoSchema.nullable(),
  dtsLimit: z
    .object({
      /** ⚠️ `-1` is a documented VALUE here: "no pre-sale". Never clamped. */
      daysToShipLimit: faixaDtoSchema.nullable(),
      nonPreOrderDaysToShip: z.number().nullable(),
    })
    .nullable(),
  weightLimit: z.object({ weightMandatory: z.boolean().nullable() }).nullable(),
  dimensionLimit: z.object({ dimensionMandatory: z.boolean().nullable() }).nullable(),
  sizeChartLimit: z
    .object({
      sizeChartMandatory: z.boolean().nullable(),
      supportImageSizeChart: z.boolean().nullable(),
      supportTemplateSizeChart: z.boolean().nullable(),
    })
    .nullable(),
});
export type LimitesDeItemDto = z.infer<typeof limitesDeItemDtoSchema>;

export const limitesDeKitDtoSchema = z.object({
  priceLimit: faixaDtoSchema.nullable(),
  itemNameLengthLimit: faixaDtoSchema.nullable(),
  itemImageCountLimit: faixaDtoSchema.nullable(),
  /** ⚠️ `description_limit`, and it declares two fields the item page does not. */
  descriptionLimit: limitesDescricaoEstendidaDtoSchema
    .extend({
      descriptionLengthMin: z.number().nullable(),
      descriptionLengthMax: z.number().nullable(),
    })
    .nullable(),
  tierVariationNameLengthLimit: faixaDtoSchema.nullable(),
  tierVariationOptionLengthLimit: faixaDtoSchema.nullable(),
  weightLimit: z.object({ weightMandatory: z.boolean().nullable() }).nullable(),
  dimensionLimit: z.object({ dimensionMandatory: z.boolean().nullable() }).nullable(),
  dtsLimit: z
    .object({
      nonPreOrderDaysToShip: z.number().nullable(),
      /**
       * ⚠️ Shopee's OWN boolean, declared on the kit page only — not the
       * `supportsPreOrder` the item route derives from the `-1` sentinel. Two
       * different facts that happen to answer the same question, and folding
       * them would invent a value for whichever page does not send one.
       */
      supportPreOrder: z.boolean().nullable(),
      daysToShipLimit: faixaDtoSchema.nullable(),
    })
    .nullable(),
  componentCountLimitOfSingleModel: faixaDtoSchema.nullable(),
});
export type LimitesDeKitDto = z.infer<typeof limitesDeKitDtoSchema>;

/** What {@link lerLimitesDeItem} answers: the bands, the merged GTIN rule, the flag. */
export interface LimitesDeItemLidos {
  readonly limites: LimitesDeItemDto;
  readonly gtinLimit: GtinLimitDto | null;
  /**
   * DERIVED from the `-1` sentinel on `days_to_ship_limit` — see
   * {@link suportaPreVenda}. Computed from the RAW band, beside the payload it
   * comes from, so the route never has to rebuild a wire shape to ask.
   */
  readonly supportsPreOrder: boolean;
}

/* -------------------------------------------------------------------------- */
/*                                 Projections                                */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a band into `{min, max}`, whichever spelling Shopee used.
 *
 * The limit pages spell every band `{min_limit, max_limit}`; the guide and some
 * neighbouring APIs spell the same idea `{min, max}`. The package declares all
 * four keys, nullable, so a body in either spelling parses; picking one is this
 * function's job and nobody else's.
 *
 * ⚠️ `??`, never `||`. `min_limit: 0` is a real floor — `||` would fall through
 * to `min` and answer `null` for it, which reads as "no lower bound".
 *
 * ⚠️ Nothing is clamped. `-1` on `days_to_ship_limit` means "no pre-sale" and
 * travels to the caller intact; {@link suportaPreVenda} is what interprets it.
 */
export function faixa(banda: ShopeeFaixa | null | undefined): FaixaDto | null {
  if (banda == null) return null;
  return {
    min: banda.min_limit ?? banda.min,
    max: banda.max_limit ?? banda.max,
  };
}

/**
 * Whether this category accepts pre-sale (`days_to_ship` beyond the normal
 * window), read off the `-1` sentinel.
 *
 * ⚠️ The wrong-way default is `false`. An absent band, an absent `dts_limit` or
 * a band with no numbers at all answers `false`: claiming pre-sale support the
 * shop does not have gets a publish rejected at Shopee with a message about a
 * field nobody set, while the reverse only costs a listing that could have
 * offered a longer window.
 *
 * ⚠️ BOTH ends are checked. Guide 209 §4 documents `-1` on `days_to_ship_limit`;
 * it does not say which end carries it, and a negative bound is meaningless as a
 * number of days either way.
 */
export function suportaPreVenda(
  dts: { readonly days_to_ship_limit?: ShopeeFaixa | null } | null | undefined,
): boolean {
  const banda = faixa(dts?.days_to_ship_limit);
  if (banda === null) return false;
  if (banda.min !== null && banda.min < 0) return false;
  if (banda.max === null) return false;
  return banda.max > 0;
}

function projetarDescricaoEstendida(
  limite: ShopeeItemLimit['extended_description_limit'],
): z.infer<typeof limitesDescricaoEstendidaDtoSchema> | null {
  if (limite == null) return null;
  return {
    descriptionTextLengthMin: limite.description_text_length_min,
    descriptionTextLengthMax: limite.description_text_length_max,
    descriptionImageNumMin: limite.description_image_num_min,
    descriptionImageNumMax: limite.description_image_num_max,
    descriptionImageWidthMin: limite.description_image_width_min,
    descriptionImageHeightMin: limite.description_image_height_min,
    descriptionImageAspectRatioMin: limite.description_image_aspect_ratio_min,
    descriptionImageAspectRatioMax: limite.description_image_aspect_ratio_max,
  };
}

/** Project the ITEM bands. */
export function projetarLimitesDeItem(limite: ShopeeItemLimit): LimitesDeItemDto {
  return {
    priceLimit: faixa(limite.price_limit),
    wholesalePriceThresholdPercentage: faixa(limite.wholesale_price_threshold_percentage),
    stockLimit: faixa(limite.stock_limit),
    itemNameLengthLimit: faixa(limite.item_name_length_limit),
    itemImageCountLimit: faixa(limite.item_image_count_limit),
    itemDescriptionLengthLimit: faixa(limite.item_description_length_limit),
    tierVariationNameLengthLimit: faixa(limite.tier_variation_name_length_limit),
    tierVariationOptionLengthLimit: faixa(limite.tier_variation_option_length_limit),
    itemCountLimit: faixa(limite.item_count_limit),
    extendedDescriptionLimit: projetarDescricaoEstendida(limite.extended_description_limit),
    dtsLimit:
      limite.dts_limit == null
        ? null
        : {
            daysToShipLimit: faixa(limite.dts_limit.days_to_ship_limit),
            nonPreOrderDaysToShip: limite.dts_limit.non_pre_order_days_to_ship,
          },
    weightLimit:
      limite.weight_limit == null
        ? null
        : { weightMandatory: limite.weight_limit.weight_mandatory },
    dimensionLimit:
      limite.dimension_limit == null
        ? null
        : { dimensionMandatory: limite.dimension_limit.dimension_mandatory },
    sizeChartLimit:
      limite.size_chart_limit == null
        ? null
        : {
            sizeChartMandatory: limite.size_chart_limit.size_chart_mandatory,
            supportImageSizeChart: limite.size_chart_limit.support_image_size_chart,
            supportTemplateSizeChart: limite.size_chart_limit.support_template_size_chart,
          },
  };
}

/** Project the KIT bands — its own page, its own numbers. */
export function projetarLimitesDeKit(limite: ShopeeKitItemLimit): LimitesDeKitDto {
  const descricao = limite.description_limit;
  return {
    priceLimit: faixa(limite.price_limit),
    itemNameLengthLimit: faixa(limite.item_name_length_limit),
    itemImageCountLimit: faixa(limite.item_image_count_limit),
    descriptionLimit:
      descricao == null
        ? null
        : {
            descriptionLengthMin: descricao.description_length_min,
            descriptionLengthMax: descricao.description_length_max,
            descriptionTextLengthMin: descricao.description_text_length_min,
            descriptionTextLengthMax: descricao.description_text_length_max,
            descriptionImageNumMin: descricao.description_image_num_min,
            descriptionImageNumMax: descricao.description_image_num_max,
            descriptionImageWidthMin: descricao.description_image_width_min,
            descriptionImageHeightMin: descricao.description_image_height_min,
            descriptionImageAspectRatioMin: descricao.description_image_aspect_ratio_min,
            descriptionImageAspectRatioMax: descricao.description_image_aspect_ratio_max,
          },
    tierVariationNameLengthLimit: faixa(limite.tier_variation_name_length_limit),
    tierVariationOptionLengthLimit: faixa(limite.tier_variation_option_length_limit),
    weightLimit:
      limite.weight_limit == null
        ? null
        : { weightMandatory: limite.weight_limit.weight_mandatory },
    dimensionLimit:
      limite.dimension_limit == null
        ? null
        : { dimensionMandatory: limite.dimension_limit.dimension_mandatory },
    dtsLimit:
      limite.dts_limit == null
        ? null
        : {
            nonPreOrderDaysToShip: limite.dts_limit.non_pre_order_days_to_ship,
            supportPreOrder: limite.dts_limit.support_pre_order,
            daysToShipLimit: faixa(limite.dts_limit.days_to_ship_limit),
          },
    componentCountLimitOfSingleModel: faixa(limite.component_count_limit_of_single_model),
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Readers                                  */
/* -------------------------------------------------------------------------- */

/**
 * The ITEM bands for one category, or for the whole shop when `categoryId` is
 * `null` (a documented read, not a degraded one).
 *
 * ⚠️ **`gtin_limit` is merged from BOTH positions, inner first.** Shopee's page
 * renders the field as a SIBLING of `response` and ships no response sample, so
 * which position the live API fills is unsettled; the package declares both and
 * leaves the decision here, where it can be observed. The inner one wins because
 * it is the position every other band uses — if both ever arrive, the one inside
 * `response` is the one that came with the bands it belongs to.
 *
 * ⚠️ Both absent stays `null`, never `{}`. An empty object would read as "Shopee
 * answered about the GTIN rule and said nothing", which is a different claim from
 * "Shopee did not answer about it" — and step 11 has to be able to tell them
 * apart before it decides whether a GTIN is required.
 */
export async function lerLimitesDeItem(
  ctx: ShopeeTaxonomiaCtx,
  categoryId: number | null,
): Promise<LimitesDeItemLidos> {
  const lido = await lerLimitesItemCached(ctx, categoryId);
  const bruto = lido.response.gtin_limit ?? lido.gtin_limit;
  return {
    limites: projetarLimitesDeItem(lido.response),
    gtinLimit: bruto == null ? null : { gtinValidationRule: bruto.gtin_validation_rule },
    supportsPreOrder: suportaPreVenda(lido.response.dts_limit),
  };
}

/** The KIT bands. A different call, a different schema, different numbers. */
export async function lerLimitesDeKit(
  ctx: ShopeeTaxonomiaCtx,
  categoryId: number | null,
): Promise<LimitesDeKitDto> {
  return projetarLimitesDeKit(await lerLimitesKitCached(ctx, categoryId));
}
