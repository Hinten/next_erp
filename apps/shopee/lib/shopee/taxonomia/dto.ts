/**
 * The shapes the Shopee taxonomy routes ANSWER with, and the projections that
 * build them from the package's already-parsed provider payloads.
 *
 * ## camelCase mirrors of Shopee's own names — never a translation
 *
 * `categoryId`, `hasNextPage`, `daysToShipLimit`: every FIELD is Shopee's own
 * name in camelCase, and the invented keys (`isLeaf`, `pathFromRoot`,
 * `children`, `truncated`, `position`, `applied`, `unresolved`, `scope`) are
 * English too. Two are deliberately SHORTENED rather than mirrored: `name` and
 * `originalName` on `CategoriaResumoDto` carry `display_category_name` and
 * `original_category_name`, because the type already says which entity it is
 * and neither string is ever published. A brand name IS published, which is why
 * `MarcaDto` keeps `displayBrandName` / `originalBrandName` verbatim.
 *
 * pt-BR survives in exactly ONE position: the envelope noun each route invents
 * for its own collection (`raizes`, `no`, `atributos`, `marcas`, `limites`,
 * `recomendacoes`). Never inside a row — no field carrying a provider value is
 * translated. Messages and log lines are pt-BR everywhere.
 *
 * That is not a style preference. Step 11 composes Shopee PUBLISH payloads from
 * these numbers and step 21 mirrors this shape in `apps/web`, so a translated
 * key would leave the repo holding two vocabularies for one field — the #1369
 * drift, where a panel that called itself a "line-for-line mirror" of a resolver
 * had already drifted in two places while every test stayed green.
 *
 * ## Why these schemas are plain `z.number()` and not `wireInt()`
 *
 * They describe OUR OWN answers, not Shopee's. Every provider number reaching
 * them has already been through `@delfrance/integrations-shopee`'s wire schemas,
 * which are the tolerant ones (`wireInt()` / `wireNumber()`, so a quoted id
 * cannot cost the whole resource — #1087). A string arriving HERE would be our
 * own serialisation bug, and tolerating it would hide exactly what should be
 * loud. Same reasoning, and the same spelling, as `conta/status.ts` — and the
 * case `integration-response-numbers-tolerant.test.js` names in its rule 7.
 *
 * ⚠️ The schemas exist so each route's test can PARSE the body it just built:
 * a wrong key or a missing field fails there instead of at step 11.
 */
import { z } from 'zod';
import type {
  ShopeeAttribute,
  ShopeeAttributeValue,
  ShopeeCategoria,
  ShopeeMarca,
  ShopeeVariation,
} from '@delfrance/integrations-shopee';

import { type ShopeeCategoriaIndice, caminhoDaCategoria, ehFolha, filhosDe } from './categorias';

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
 * Project one category row.
 *
 * ⚠️ `isLeaf` is read through {@link ehFolha} rather than re-testing
 * `has_children === false` here. The leaf rule is the gate every write step
 * hangs off, and a second copy of it in the projection layer is precisely the
 * shape that drifts toward plausible while both copies stay green.
 */
export function projetarCategoria(
  indice: ShopeeCategoriaIndice,
  row: ShopeeCategoria,
): CategoriaResumoDto {
  return {
    categoryId: row.category_id,
    name: row.display_category_name,
    originalName: row.original_category_name,
    isLeaf: ehFolha(indice, row.category_id) === 'folha',
  };
}

/** Project a focused node, with its ancestors and its direct children. */
export function projetarNoDeCategoria(
  indice: ShopeeCategoriaIndice,
  row: ShopeeCategoria,
): CategoriaNoDto {
  return {
    ...projetarCategoria(indice, row),
    parentId: row.parent_category_id,
    pathFromRoot: caminhoDaCategoria(indice, row.category_id).map((no) =>
      projetarCategoria(indice, no),
    ),
    children: filhosDe(indice, row.category_id).map((no) => projetarCategoria(indice, no)),
  };
}

/* -------------------------------------------------------------------------- */
/*                                 Attributes                                 */
/* -------------------------------------------------------------------------- */

/**
 * How deep the attribute tree is projected before the walk stops.
 *
 * Shopee's own trees are two or three levels of `child_attribute_list`; this is
 * not a limit a real category reaches. It exists because the structure is
 * MUTUALLY recursive and arrives from outside: a provider bug (or a cycle
 * expressed through repeated ids) would otherwise be an unbounded recursion in
 * a route handler. When it fires, the answer carries `truncated: true` — the
 * body says it lost something rather than looking complete.
 */
export const SHOPEE_ATTRIBUTE_MAX_DEPTH = 8;

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
 * package uses for the wire schemas: without the annotation TypeScript refuses a
 * schema that references itself through a sibling, and without `z.lazy` one of
 * the two `const`s reads the other as `undefined` at module evaluation time.
 */
export const atributoValorDtoSchema: z.ZodType<AtributoValorDto> = z.lazy(() =>
  z.object({
    /** `0` is a legal value id in Shopee's data — never read it as "absent". */
    valueId: z.number().int(),
    name: z.string().nullable(),
    valueUnit: z.string().nullable(),
    childAttributeList: z.array(atributoDtoSchema),
  }),
);

export const atributoDtoSchema: z.ZodType<AtributoDto> = z.lazy(() =>
  z.object({
    attributeId: z.number().int(),
    mandatory: z.boolean(),
    name: z.string().nullable(),
    attributeInfo: atributoInfoDtoSchema.nullable(),
    attributeValueList: z.array(atributoValorDtoSchema),
  }),
);

/** What {@link projetarAtributos} answers: the tree, and whether it was cut. */
export interface AtributosProjetados {
  readonly atributos: AtributoDto[];
  readonly truncated: boolean;
}

function projetarInfo(row: ShopeeAttribute): AtributoInfoDto | null {
  const info = row.attribute_info;
  if (info == null) return null;
  return {
    inputType: info.input_type,
    inputValidationType: info.input_validation_type,
    formatType: info.format_type,
    dateFormatType: info.date_format_type,
    attributeUnitList: info.attribute_unit_list,
    maxValueCount: info.max_value_count,
    introduction: info.introduction,
    isOem: info.is_oem,
    supportSearchValue: info.support_search_value,
  };
}

/**
 * Project a category's attribute tree, depth-capped.
 *
 * ⚠️ `truncated` is set only when a level was ACTUALLY dropped. A tree that is
 * exactly {@link SHOPEE_ATTRIBUTE_MAX_DEPTH} deep is complete and must say so —
 * a flag that fired on the boundary would make every deep-but-whole answer look
 * lossy, and an operator who learns to ignore it learns to ignore the real one.
 *
 * `multi_lang` is deliberately NOT projected: the reads ask for one language
 * (`SHOPEE_TAXONOMY_LANGUAGE`), so the translations are dead weight on every
 * response — and a translation the editor never renders is a second name for a
 * field that already has one.
 */
export function projetarAtributos(tree: readonly ShopeeAttribute[]): AtributosProjetados {
  let truncated = false;

  function valor(row: ShopeeAttributeValue, depth: number): AtributoValorDto {
    const filhos = row.child_attribute_list;
    let childAttributeList: AtributoDto[] = [];
    if (filhos.length > 0) {
      if (depth >= SHOPEE_ATTRIBUTE_MAX_DEPTH) truncated = true;
      else childAttributeList = filhos.map((filho) => atributo(filho, depth + 1));
    }
    return {
      valueId: row.value_id,
      name: row.name,
      valueUnit: row.value_unit,
      childAttributeList,
    };
  }

  function atributo(row: ShopeeAttribute, depth: number): AtributoDto {
    return {
      attributeId: row.attribute_id,
      mandatory: row.mandatory,
      name: row.name,
      attributeInfo: projetarInfo(row),
      attributeValueList: row.attribute_value_list.map((v) => valor(v, depth)),
    };
  }

  const atributos = tree.map((row) => atributo(row, 1));
  return { atributos, truncated };
}

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

export function projetarMarcas(list: readonly ShopeeMarca[]): MarcaDto[] {
  return list.map((m) => ({
    brandId: m.brand_id,
    originalBrandName: m.original_brand_name,
    displayBrandName: m.display_brand_name,
  }));
}

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

export function projetarVariacoes(list: readonly ShopeeVariation[]): VariacaoDto[] {
  return list.map((v) => ({
    variationId: v.variation_id,
    variationName: v.variation_name,
    variationGroupList: v.variation_group_list.map((g) => ({
      variationGroupId: g.variation_group_id,
      variationGroupName: g.variation_group_name,
      variationOptionList: g.variation_option_list.map((o) => ({
        variationOptionId: o.variation_option_id,
        variationOptionName: o.variation_option_name,
      })),
    })),
  }));
}
