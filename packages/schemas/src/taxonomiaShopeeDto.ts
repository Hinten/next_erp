import { z } from 'zod';

/**
 * The ENVELOPES of the Shopee taxonomy routes (#1911, P2) —
 * `GET /api/marketplace/shopee/taxonomia/{categorias,atributos,limites,marcas,variacoes,recomendacao-categoria}`
 * in `apps/shopee` — and the row DTOs inside them, declared where both the
 * routes and the `apps/web` Shopee screens that read those answers can import
 * them.
 *
 * ## Why here, and declared ONCE
 *
 * `apps/web` cannot import `apps/shopee`, so a browser reader of these answers
 * either shares the shape through this package or writes it twice — the
 * route's `lib/shopee/taxonomia/{dto,limites}.ts` beside the browser's
 * `lib/shopee/wire.ts`, each with a comment saying the names match the other.
 * That is the #1369 shape: two copies the compiler cannot compare, which drift
 * toward plausible and read correct while disagreeing. Both apps reach this
 * package, so each route builds its 200 `satisfies z.input<…>` of the envelope
 * below, its test parses that 200 with the SAME schema object, and a browser
 * reader imports that object instead of mirroring it — a renamed key is then a
 * compile error on both sides instead of a `ShopeeClientRespostaInvalidaError`
 * in production.
 * Same move, same rules, as step 18's size-chart envelopes
 * (`tabelaDeMedidasShopeeDto.ts`). A new or newly-consumed taxonomy envelope is
 * declared HERE and never mirrored.
 *
 * The PROJECTIONS (`projetarCategoria`, `projetarAtributos`, `faixa`, …) stay
 * in `apps/shopee`: they read the integration package's provider types, and
 * this package depends only on `@delfrance/core` and `zod`. `apps/shopee`
 * re-exports the names that moved, so its own imports did not change.
 *
 * ## Names
 *
 * Every FIELD carrying a provider value is Shopee's own name in camelCase —
 * `categoryId`, `hasNextPage`, `daysToShipLimit` — never a translation; the
 * invented keys inside a row are English too (`isLeaf`, `pathFromRoot`,
 * `children`, `truncated`, `position`, `applied`, `unresolved`, `scope`). Two
 * are deliberately SHORTENED: `name` / `originalName` on a category carry
 * `display_category_name` / `original_category_name`, because the type already
 * says which entity it is and neither string is ever published. A brand name IS
 * published, which is why {@link marcaDtoSchema} keeps `displayBrandName` /
 * `originalBrandName` verbatim. pt-BR survives in exactly one position: the
 * envelope noun a route invents for its own collection (`raizes`, `no`,
 * `atributos`, `marcas`, `limites`, `recomendacoes`).
 *
 * ## Strict numbers, tolerant objects (deploy skew)
 *
 * `apps/web` and `apps/shopee` deploy separately, so the browser is routinely
 * one deploy OLDER or NEWER than the route answering it:
 * - every object is a plain `z.object` — an unknown key is STRIPPED, never a
 *   failure, so a newer route's extra field cannot cost an older browser;
 * - every key is REQUIRED — each route answers all of them on every 200;
 * - every number is plain `z.number()` (`.int()` for ids, counts and cursors),
 *   never `wireInt()`: these describe OUR answers, whose provider numbers
 *   already went through `@delfrance/integrations-shopee`'s tolerant wire
 *   readers, so a quoted number here is our own serialisation bug and must be
 *   loud.
 *
 * ## The limits answer has TWO readers, so it has two schemas — one derived
 *
 * {@link respostaLimitesDoItemShopeeSchema} is the WHOLE answer of
 * `taxonomia/limites` (every band). The `/medidas` size-chart tab reads only
 * `size_chart_limit`, and its contract is that a change to any OTHER band can
 * never cost that screen — even a malformed one. So its schema,
 * {@link respostaLimitesTabelaMedidasShopeeSchema}, is DERIVED from the whole one
 * with `.pick` / `.extend` (never a hand copy): a rename of `scope`,
 * `categoryId` or `sizeChartLimit` reaches both through the one declaration,
 * while every other band is dropped by the default strip before it is read.
 */

/* -------------------------------------------------------------------------- */
/*                                 Categories                                 */
/* -------------------------------------------------------------------------- */

/** One category as a picker row: enough to render it and to decide if it is selectable. */
export const categoriaResumoDtoSchema = z.object({
  categoryId: z.number().int(),
  /** Shopee's `display_category_name` — what the operator reads. */
  name: z.string().nullable(),
  /** Shopee's `original_category_name` — the untranslated one, kept for support. */
  originalName: z.string().nullable(),
  /** The backend's three-valued leaf gate, folded: only `folha` is `true`. */
  isLeaf: z.boolean(),
});
export type CategoriaResumoDto = z.infer<typeof categoriaResumoDtoSchema>;

/** One focused node: the row, its parent, its ancestors and its direct children. */
export const categoriaNoDtoSchema = categoriaResumoDtoSchema.extend({
  /** `0` marks a root. A real, meaningful zero — never read it as absent. */
  parentId: z.number().int(),
  /** Root FIRST, the requested node LAST. */
  pathFromRoot: z.array(categoriaResumoDtoSchema),
  children: z.array(categoriaResumoDtoSchema),
});
export type CategoriaNoDto = z.infer<typeof categoriaNoDtoSchema>;

/**
 * `GET …/taxonomia/categorias?integracaoId=[&categoryId=]` — 200: the ROOTS
 * when no id was asked (`no: null`), ONE node when one was (`raizes: null`). An
 * id the tree does not hold is a 404 (`SHOPEE_CATEGORIA_DESCONHECIDA`), never a
 * 200.
 *
 * ⚠️ A body with NEITHER half answers no question at all — a reader would
 * render an empty picker that looks like a tree with no categories. It is
 * refused, so the operator reads a contract breach instead of a blank list.
 */
export const respostaCategoriasShopeeSchema = z
  .object({
    raizes: z.array(categoriaResumoDtoSchema).nullable(),
    no: categoriaNoDtoSchema.nullable(),
  })
  .refine((r) => r.raizes !== null || r.no !== null, {
    message: 'a resposta de categorias não trouxe nem as raízes nem o nó pedido',
    path: ['no'],
  });
export type RespostaCategoriasShopee = z.infer<typeof respostaCategoriasShopeeSchema>;

/* -------------------------------------------------------------------------- */
/*                                 Attributes                                 */
/* -------------------------------------------------------------------------- */

/** `attribute_info` — the per-attribute editor metadata, mirrored key for key. */
export const atributoInfoDtoSchema = z.object({
  /** ⚠️ INTEGER enums, exactly as the attribute-tree page declares them. */
  inputType: z.number().int().nullable(),
  inputValidationType: z.number().int().nullable(),
  formatType: z.number().int().nullable(),
  dateFormatType: z.number().int().nullable(),
  attributeUnitList: z.array(z.string()).nullable(),
  maxValueCount: z.number().int().nullable(),
  introduction: z.string().nullable(),
  isOem: z.boolean().nullable(),
  supportSearchValue: z.boolean().nullable(),
});
export type AtributoInfoDto = z.infer<typeof atributoInfoDtoSchema>;

/** One selectable value, with the attributes it unlocks. */
export interface AtributoValorDto {
  valueId: number;
  name: string | null;
  valueUnit: string | null;
  childAttributeList: AtributoDto[];
}

/** One attribute of a category. */
export interface AtributoDto {
  attributeId: number;
  /** ⚠️ `mandatory` on an attribute, `isMandatory` on the brand payload. Both are real. */
  mandatory: boolean;
  name: string | null;
  attributeInfo: AtributoInfoDto | null;
  attributeValueList: AtributoValorDto[];
}

/**
 * ⚠️ `z.lazy` + an explicit annotation on BOTH halves, the same shape the
 * integration package uses for the wire schemas: without the annotation
 * TypeScript refuses a schema that references itself through a sibling, and
 * without `z.lazy` one of the two `const`s reads the other as `undefined` at
 * module evaluation time.
 *
 * The annotation names the INPUT type too (`z.ZodType<T, T>`): with zod 4's
 * default (`unknown`) a route's `satisfies z.input<…>` would check nothing
 * below `atributos`, and a renamed key deep in the tree would compile.
 */
export const atributoValorDtoSchema: z.ZodType<AtributoValorDto, AtributoValorDto> = z.lazy(() =>
  z.object({
    /** `0` is a legal value id in Shopee's data — never read it as "absent". */
    valueId: z.number().int(),
    name: z.string().nullable(),
    valueUnit: z.string().nullable(),
    childAttributeList: z.array(atributoDtoSchema),
  }),
);

export const atributoDtoSchema: z.ZodType<AtributoDto, AtributoDto> = z.lazy(() =>
  z.object({
    attributeId: z.number().int(),
    mandatory: z.boolean(),
    name: z.string().nullable(),
    attributeInfo: atributoInfoDtoSchema.nullable(),
    attributeValueList: z.array(atributoValorDtoSchema),
  }),
);

/**
 * `GET …/taxonomia/atributos?integracaoId=&categoryId=` — 200. Leaf-gated: a
 * non-leaf id answers `leaf: false` with `atributos: []`, `warning: null` and
 * `truncated: false`, at zero Shopee calls.
 */
export const respostaAtributosShopeeSchema = z.object({
  leaf: z.boolean(),
  /** The category the attributes belong to. */
  categoryId: z.number().int(),
  /** Shopee's PER-CATEGORY warning, already filtered of its noise; `null` on a healthy read. */
  warning: z.string().nullable(),
  /**
   * `true` ⇒ the projection's depth cap dropped a level: the tree is NOT
   * complete. Set only when a level was actually dropped.
   */
  truncated: z.boolean(),
  atributos: z.array(atributoDtoSchema),
});
export type RespostaAtributosShopee = z.infer<typeof respostaAtributosShopeeSchema>;

/* -------------------------------------------------------------------------- */
/*                                   Limits                                   */
/* -------------------------------------------------------------------------- */

/**
 * One band, whichever spelling Shopee used (`{min_limit, max_limit}` or
 * `{min, max}`) — resolved by the route's projection. A `null` end is NO BOUND.
 * ⚠️ Not `.int()`: a band is a price, a percentage or a count, and `-1` on
 * `daysToShipLimit` is a documented VALUE ("no pre-sale"), never clamped.
 */
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
export type LimitesDescricaoEstendidaDto = z.infer<typeof limitesDescricaoEstendidaDtoSchema>;

/** `get_item_limit`, projected — every number a fact about ONE shop and ONE category. */
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
  /**
   * The size-chart flags (announcements 1010/1404). ⚠️ ADVICE, never a gate:
   * each is three-valued — `null` is "Shopee did not say", which is NOT
   * `false` — and the whole block is `null` when Shopee sent none.
   */
  sizeChartLimit: z
    .object({
      sizeChartMandatory: z.boolean().nullable(),
      supportImageSizeChart: z.boolean().nullable(),
      supportTemplateSizeChart: z.boolean().nullable(),
    })
    .nullable(),
});
export type LimitesDeItemDto = z.infer<typeof limitesDeItemDtoSchema>;

/**
 * `get_kit_item_limit`, projected. ⚠️ Its own page and its own numbers — never
 * derived from the item bands. The kit-limits route is not read by the browser,
 * so only this DTO lives here (it shares {@link faixaDtoSchema}); its envelope
 * does not.
 */
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

/**
 * `GET …/taxonomia/limites?integracaoId=[&categoryId=]` — 200, WHOLE: every
 * band. No leaf gate: an absent `categoryId` is a real read (the shop-wide
 * bands), and `scope` says which answer this is.
 */
export const respostaLimitesDoItemShopeeSchema = z.object({
  /** `'shop'` or `'category'` — a free string: a reader only shows it. */
  scope: z.string(),
  /** The REQUESTED category; `null` on the shop-wide answer. */
  categoryId: z.number().int().nullable(),
  limites: limitesDeItemDtoSchema,
  /** The merged GTIN rule; `null` — never `{}` — when Shopee sent none in either position. */
  gtinLimit: gtinLimitDtoSchema.nullable(),
  /**
   * DERIVED by the route from the `-1` sentinel on `daysToShipLimit` — NOT
   * Shopee's `support_pre_order`, which only the KIT page declares.
   */
  supportsPreOrder: z.boolean(),
});
export type RespostaLimitesDoItemShopee = z.infer<typeof respostaLimitesDoItemShopeeSchema>;

/**
 * The SAME answer cut to the slice the `/medidas` size-chart tab reads:
 * `scope`, `categoryId` and `limites.sizeChartLimit`. Every other band — and
 * `gtinLimit` / `supportsPreOrder` — is STRIPPED before it is read, so a change
 * to one of them (even a malformed one) can never cost that screen.
 *
 * ⚠️ DERIVED with `.pick` / `.extend`, never re-declared: the picked members are
 * the very schema objects of {@link respostaLimitesDoItemShopeeSchema} and
 * {@link limitesDeItemDtoSchema}, so the two readers of one answer cannot
 * disagree about a key they share.
 */
export const respostaLimitesTabelaMedidasShopeeSchema = respostaLimitesDoItemShopeeSchema
  .pick({ scope: true, categoryId: true })
  .extend({ limites: limitesDeItemDtoSchema.pick({ sizeChartLimit: true }) });
export type RespostaLimitesTabelaMedidasShopee = z.infer<
  typeof respostaLimitesTabelaMedidasShopeeSchema
>;

/* -------------------------------------------------------------------------- */
/*                                   Brands                                   */
/* -------------------------------------------------------------------------- */

export const marcaDtoSchema = z.object({
  /** ⚠️ `0` is Shopee's "No Brand" — a choice the operator makes, not an absence. */
  brandId: z.number().int(),
  originalBrandName: z.string(),
  displayBrandName: z.string().nullable(),
});
export type MarcaDto = z.infer<typeof marcaDtoSchema>;

/**
 * `GET …/taxonomia/marcas?integracaoId=&categoryId=[&offset=&pageSize=&status=]`
 * — 200: ONE page of a leaf category's brands, plus `leaf`. A non-leaf answers
 * the same shape, empty (`marcas: []`, `hasNextPage: false`, `nextOffset`,
 * `isMandatory` and `inputType` all `null`).
 */
export const respostaMarcasShopeeSchema = z.object({
  leaf: z.boolean(),
  categoryId: z.number().int(),
  status: z.number().int(),
  offset: z.number().int(),
  pageSize: z.number().int(),
  marcas: z.array(marcaDtoSchema),
  hasNextPage: z.boolean(),
  /**
   * Shopee's cursor, echoed VERBATIM — never `offset + pageSize`. ⚠️ Page on
   * `hasNextPage`, never on this being non-null.
   */
  nextOffset: z.number().int().nullable(),
  /** ⚠️ `isMandatory` here, `mandatory` on an attribute. Both spellings are real. */
  isMandatory: z.boolean().nullable(),
  inputType: z.string().nullable(),
});
export type RespostaMarcasShopee = z.infer<typeof respostaMarcasShopeeSchema>;

/* -------------------------------------------------------------------------- */
/*                                 Variations                                 */
/* -------------------------------------------------------------------------- */

export const variacaoOpcaoDtoSchema = z.object({
  /** ⚠️ `0` is the undocumented CUSTOM option. A value, not an absence. */
  variationOptionId: z.number().int(),
  variationOptionName: z.string().nullable(),
});
export type VariacaoOpcaoDto = z.infer<typeof variacaoOpcaoDtoSchema>;

export const variacaoGrupoDtoSchema = z.object({
  variationGroupId: z.number().int(),
  variationGroupName: z.string().nullable(),
  variationOptionList: z.array(variacaoOpcaoDtoSchema),
});
export type VariacaoGrupoDto = z.infer<typeof variacaoGrupoDtoSchema>;

export const variacaoDtoSchema = z.object({
  variationId: z.number().int(),
  variationName: z.string().nullable(),
  variationGroupList: z.array(variacaoGrupoDtoSchema),
});
export type VariacaoDto = z.infer<typeof variacaoDtoSchema>;

/**
 * `GET …/taxonomia/variacoes?integracaoId=&categoryId=` — 200: Shopee's
 * STANDARDISED variation tree for a leaf category. Leaf-gated like the
 * attributes (`leaf: false` ⇒ an empty list).
 */
export const respostaVariacoesShopeeSchema = z.object({
  leaf: z.boolean(),
  categoryId: z.number().int(),
  standardiseVariationList: z.array(variacaoDtoSchema),
  /** The `get_variations` operation path this answer came from — on the body on purpose. */
  pathUsed: z.string(),
});
export type RespostaVariacoesShopee = z.infer<typeof respostaVariacoesShopeeSchema>;

/* -------------------------------------------------------------------------- */
/*                               Recommendation                               */
/* -------------------------------------------------------------------------- */

/** One suggested category, resolved against the shop's cached tree where possible. */
export const recomendacaoDtoSchema = z.object({
  /** 1-based, the order Shopee sent — and nothing more: the order's MEANING is not documented. */
  position: z.number().int(),
  categoryId: z.number().int(),
  /** `null` when the id is not in this shop's tree. */
  name: z.string().nullable(),
  /** `null` — not `false` — when the id could not be resolved: "unknown" is not "has children". */
  isLeaf: z.boolean().nullable(),
  /** Root FIRST; empty when the id could not be resolved. */
  pathFromRoot: z.array(categoriaResumoDtoSchema),
});
export type RecomendacaoDto = z.infer<typeof recomendacaoDtoSchema>;

/**
 * `GET …/taxonomia/recomendacao-categoria` — 200: the categories Shopee
 * suggests for a product name, OFFERED, never applied.
 *
 * ⚠️ `applied` is the LITERAL `false`: a contract, not decoration (#799 — a
 * suggestion applied with no human in the loop surfaced only once the listing
 * existed, in the wrong category). A body claiming `applied: true` is refused.
 */
export const respostaRecomendacaoCategoriaShopeeSchema = z.object({
  recomendacoes: z.array(recomendacaoDtoSchema),
  /** How many suggested ids were absent from this shop's category tree. */
  unresolved: z.number().int(),
  applied: z.literal(false),
});
export type RespostaRecomendacaoCategoriaShopee = z.infer<
  typeof respostaRecomendacaoCategoriaShopeeSchema
>;
