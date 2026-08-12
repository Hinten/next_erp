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
 * for coexistence. `.passthrough()` keeps any extra feed fields.
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
