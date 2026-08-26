import { z } from 'zod';
import type { CollectionMetadata } from '../../types';

// ProdutoExtraData is produto-scoped: it reuses the produto permission bits
// (bits 8–10 — see `produto.ts`), so reading/writing a produto's extra data
// requires the same claims as the produto itself.
const PERM_PRODUTO_READ = 1n << 8n;
const PERM_PRODUTO_WRITE = 1n << 9n;
const PERM_PRODUTO_DELETE = 1n << 10n;

/**
 * Product condition (`condicaoProduto` in Flutter). Serialized as an **int**
 * (`condicaoProdutoToJson` → `value`), not a string. Default is `novo` (1).
 */
export const CONDICAO_PRODUTO = { novo: 1, usado: 2, recondicionado: 3 } as const;
export const condicaoProdutoSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type CondicaoProduto = z.infer<typeof condicaoProdutoSchema>;
export const CONDICAO_PRODUTO_LABELS: Record<CondicaoProduto, string> = {
  1: 'Novo',
  2: 'Usado',
  3: 'Recondicionado',
};

/** Which input decided a listing's condition — so a screen can name it. */
export type FonteCondicaoAnuncio = 'produto' | 'extraData' | 'anuncio';

/**
 * The condition a marketplace listing publishes with, and WHICH field decided it.
 *
 * ⚠️ Shared on purpose. This lives here rather than beside the publish payload
 * because two very different callers need the same answer and any drift between
 * them is invisible: `apps/mercado-livre` builds the wire value, and the produto
 * editor shows the operator what that value will be. A screen that mirrored only
 * `ehUsado` displayed "Novo" for a produto marked **Recondicionado** in the
 * ExtraData tab while the first publish sent `used` — two copies that could only
 * disagree, with one side a screen and the other a payload.
 *
 * The precedence is the produto's, not the listing's: `ehUsado` wins, then
 * `extraData.condicao`, and the stored `link.condition` is only a last resort.
 * ⚠️ Note it is also a CREATE-only field at Mercado Livre — changing any of these
 * after publication does not reach an existing listing.
 */
export function resolveCondicaoAnuncio(input: {
  /** The produto's own "Produto usado" switch. */
  ehUsado: boolean;
  /** `extraData.condicao`; null when the singleton has not loaded or is absent. */
  condicao: number | null;
  /** What the link doc currently stores, if anything. */
  condicaoAnuncio?: 'new' | 'used' | null;
}): { condition: 'new' | 'used'; fonte: FonteCondicaoAnuncio } {
  if (input.ehUsado) return { condition: 'used', fonte: 'produto' };
  // 2 (usado) and 3 (recondicionado) both map to the only other value the old
  // CONDITION enum supported; 1 (novo) leaves the decision to the next tier.
  if (input.condicao != null && input.condicao !== CONDICAO_PRODUTO.novo) {
    return { condition: 'used', fonte: 'extraData' };
  }
  return { condition: input.condicaoAnuncio ?? 'new', fonte: 'anuncio' };
}

/** Which input decided a listing's brand — so a screen can name it. */
export type FonteMarcaAnuncio = 'extraData' | 'anuncio';

/**
 * The brand a marketplace listing publishes with, and WHICH field decided it.
 *
 * ⚠️ Shared for the same reason {@link resolveCondicaoAnuncio} is, and modelled
 * on it: `apps/mercado-livre` builds the `BRAND` attribute of an item payload,
 * and the produto's Mercado Livre tab shows the operator what that attribute
 * will say. Two copies of one answer — one a screen, one a wire value — is
 * exactly the pair that disagrees unnoticed.
 *
 * The precedence is the produto's, then the listing's: a non-blank
 * `extraData.marca` wins, and the `BRAND` already stored on the link doc is the
 * fallback.
 *
 * ⚠️ That fallback tier is NOT symmetric with the package dimensions, which have
 * none, and the asymmetry is deliberate. `BRAND` is `required` in most Mercado
 * Livre categories and was operator-typed for this app's whole history, so for a
 * produto with an empty Marca the stored value is the ONLY copy that exists.
 * Discarding it the way `ML_PRODUTO_DERIVED_ATTRIBUTE_IDS` discards a stale
 * `WEIGHT` would make the existing catalogue unpublishable.
 */
export function resolveMarcaAnuncio(input: {
  /** `extraData.marca`; null when the singleton has not loaded or is absent. */
  marca: string | null;
  /** The `BRAND` value_name the link doc currently stores, if anything. */
  marcaAnuncio?: string | null;
  /**
   * The stored `BRAND` is Mercado Livre's N/A sentinel — an explicit "this
   * product has no brand", which is an ANSWER and not a blank. Read it off the
   * link with {@link marcaArmazenadaDe}, never by testing `value_name`.
   */
  anuncioNaoSeAplica?: boolean;
}): { marca: string | null; fonte: FonteMarcaAnuncio | null; naoSeAplica: boolean } {
  // Blank-as-absent on BOTH tiers: a whitespace-only marca must fall through to
  // the listing rather than blank out a real stored brand, and a whitespace-only
  // stored value must not read as "the listing has a brand".
  const doProduto = input.marca?.trim();
  if (doProduto) return { marca: doProduto, fonte: 'extraData', naoSeAplica: false };
  // ⚠️ Ranked BELOW the produto deliberately: a Marca typed on the produto is a
  // newer, more specific answer than an N/A the operator left on one listing.
  // Ranked ABOVE the stored value_name because the sentinel carries `'N/A'`
  // there, and returning that string would print a brand literally named "N/A".
  if (input.anuncioNaoSeAplica) return { marca: null, fonte: 'anuncio', naoSeAplica: true };
  const doAnuncio = input.marcaAnuncio?.trim();
  if (doAnuncio) return { marca: doAnuncio, fonte: 'anuncio', naoSeAplica: false };
  return { marca: null, fonte: null, naoSeAplica: false };
}

/** The Mercado Livre attribute id the produto's Marca fills. */
export const MARCA_ATTRIBUTE_ID = 'BRAND';

/**
 * ML's "does not apply" marker (`AttributesMLNew.na`, `value_id: '-1'`), whose
 * `value_name` is the literal string `'N/A'`.
 */
const VALUE_ID_NAO_SE_APLICA = '-1';

/**
 * Read the `BRAND` a link doc already stores.
 *
 * ⚠️ Shared for the same reason {@link resolveMarcaAnuncio} is, and it is the
 * half that was duplicated first: `apps/mercado-livre` needs the stored brand to
 * decide what the payload sends, and the produto's Mercado Livre tab needs the
 * same value to show the operator what that payload will say. Written out twice,
 * the two answers drift the moment either side learns something new about the
 * shape — which id, which field, what counts as present — and the drift is
 * invisible because one side is a screen and the other a wire value. That is
 * exactly how `ML_PRODUTO_DERIVED_ATTRIBUTE_IDS` came to disagree with itself
 * across three workspaces before #1271 consolidated it.
 *
 * The parameter is structural rather than `MlAttribute` because this package
 * must not depend on `@delfrance/integrations-mercado-livre` (its root carries
 * the OAuth client secret and `apps/web` reaches this module).
 */
export function marcaArmazenadaDe(
  attributes:
    | ReadonlyArray<{
        id?: string | null;
        value_id?: string | null;
        value_name?: string | null;
      }>
    | null
    | undefined,
): { marca: string | null; naoSeAplica: boolean } {
  const entry = (attributes ?? []).find((a) => a.id === MARCA_ATTRIBUTE_ID);
  if (!entry) return { marca: null, naoSeAplica: false };
  if (entry.value_id === VALUE_ID_NAO_SE_APLICA) return { marca: null, naoSeAplica: true };
  return { marca: entry.value_name ?? null, naoSeAplica: false };
}

/** Google Shopping `age_group` (string enum). */
export const googleAgeGroupSchema = z.enum(['newborn', 'infant', 'toddler', 'kids', 'adult']);
export type GoogleAgeGroup = z.infer<typeof googleAgeGroupSchema>;

/** Named members of {@link googleAgeGroupSchema} — the Google Merchant values. */
export const GOOGLE_AGE_GROUP = {
  newborn: 'newborn',
  infant: 'infant',
  toddler: 'toddler',
  kids: 'kids',
  adult: 'adult',
} as const satisfies Record<string, GoogleAgeGroup>;
export const GOOGLE_AGE_GROUP_LABELS: Record<GoogleAgeGroup, string> = {
  newborn: 'Recém-nascido (0 a 3 meses)',
  infant: 'Bebê (3 a 12 meses)',
  toddler: 'Criança (1 a 5 anos)',
  kids: 'Infantil/Juvenil (5 a 13 anos)',
  adult: 'Juvenil/Adulto (13 anos ou mais)',
};

/** Google Shopping `gender` (string enum). */
export const googleGenderSchema = z.enum(['male', 'female', 'unisex']);
export type GoogleGender = z.infer<typeof googleGenderSchema>;

/** Named members of {@link googleGenderSchema} — the Google Merchant values. */
export const GOOGLE_GENDER = {
  male: 'male',
  female: 'female',
  unisex: 'unisex',
} as const satisfies Record<string, GoogleGender>;
export const GOOGLE_GENDER_LABELS: Record<GoogleGender, string> = {
  male: 'Masculino',
  female: 'Feminino',
  unisex: 'Unissex',
};

/**
 * Google Merchant Center feed metadata, nested under
 * `ProdutoExtraData.googleMerchantData`. Mirrors the Flutter
 * `GoogleMerchantData` model (`models.dart:2753`) — note the snake_case wire
 * keys (`google_product_category`, `product_type`, `age_group`) kept verbatim
 * for legacy parity. `.passthrough()` keeps any extra feed fields.
 */
export const googleMerchantDataSchema = z
  .object({
    id: z.string().nullable().default(null),
    title: z.string().nullable().default(null),
    google_product_category: z.string().nullable().default(null),
    product_type: z.string().nullable().default(null),
    age_group: googleAgeGroupSchema.nullable().default(null),
    gender: googleGenderSchema.nullable().default(null),
    material: z.string().nullable().default(null),
    pattern: z.string().nullable().default(null),
  })
  .passthrough();

export type GoogleMerchantData = z.infer<typeof googleMerchantDataSchema>;

/**
 * ProdutoExtraData — the `produtos/{id}/extraData/singleton` doc holding the
 * marketing/SEO copy and the Google Merchant feed block. Mirrors the Flutter
 * `ProdutoExtraData` model (`models.dart:2521`); the doc id is always the
 * literal `singleton` (`ProdutoExtraData.save()` hardcodes `docIdString`).
 *
 * Wire facts: `coteudoAdulto` keeps the Flutter typo verbatim (it is the stored
 * key); `condicao` is an int (see `condicaoProdutoSchema`) defaulting to `novo`.
 * `.passthrough()` preserves fields this app does not surface yet. Optional
 * fields use `.nullable()` (Firebase SDK v12 rejects `undefined`).
 */
export const PRODUTO_EXTRA_DATA_DOC_ID = 'singleton';

export const produtoExtraDataSchema = z
  .object({
    descricao: z.string().max(3000).nullable().default(null),
    marca: z.string().max(255).nullable().default(null),
    metaDescricao: z.string().max(255).nullable().default(null),
    keyWords: z.array(z.string()).nullable().default(null),
    youtube: z.string().max(255).nullable().default(null),
    condicao: condicaoProdutoSchema.default(CONDICAO_PRODUTO.novo),
    coteudoAdulto: z.boolean().default(false),
    itensNoKit: z.number().int().nullable().default(null),
    googleMerchantData: googleMerchantDataSchema.nullable().default(null),
  })
  .passthrough();

export type ProdutoExtraData = z.infer<typeof produtoExtraDataSchema>;

export const produtoExtraDataMeta: CollectionMetadata = {
  collectionPath: 'produtos/{produtoId}/extraData',
  permissions: {
    read: PERM_PRODUTO_READ,
    write: PERM_PRODUTO_WRITE,
    delete: PERM_PRODUTO_DELETE,
  },
};

export const produtoExtraData = {
  schema: produtoExtraDataSchema,
  meta: produtoExtraDataMeta,
};
