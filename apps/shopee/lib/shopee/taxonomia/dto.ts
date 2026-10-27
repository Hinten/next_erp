/**
 * The PROJECTIONS behind the Shopee taxonomy routes: each builds a route's
 * answer from the integration package's already-parsed provider payloads.
 *
 * ⚠️ **The answer SHAPES are no longer declared here** (#1911, P2). They live in
 * `@delfrance/schemas` (`taxonomiaShopeeDto.ts`), the one package both this app
 * and `apps/web` reach, beside one ENVELOPE per route: each route builds its 200
 * `satisfies z.input<…>` of its envelope and its test parses that 200 with the
 * SAME schema object, so a browser reader has one declaration to import instead
 * of a copy to keep. `apps/web/lib/shopee/wire.ts` still mirrors the categorias
 * and limites answers by hand, with a comment saying the names match this file
 * — the #1369 shape, two copies the compiler cannot compare — until #1911's web
 * PR points it at these. The naming rule (camelCase mirrors of Shopee's
 * own names, pt-BR only for an envelope noun) and the "plain `z.number()`,
 * never `wireInt()`" rule moved WITH the shapes and are written down there —
 * a step-11 publish still composes its payload from these numbers, so a
 * translated key would leave the repo two vocabularies for one field.
 *
 * What stays here is what reads the package's provider types (`ShopeeAttribute`,
 * `ShopeeMarca`, …), which `@delfrance/schemas` cannot import: the projections
 * and the attribute walk's depth cap. The moved names are RE-EXPORTED below, so
 * every in-app `./dto` import is exactly what it was — the step-18 move
 * (`tabelaMedidas/dto.ts`) did the same.
 */
import type {
  ShopeeAttribute,
  ShopeeAttributeValue,
  ShopeeCategoria,
  ShopeeMarca,
  ShopeeVariation,
} from '@delfrance/integrations-shopee';
import type {
  AtributoDto,
  AtributoInfoDto,
  AtributoValorDto,
  CategoriaNoDto,
  CategoriaResumoDto,
  MarcaDto,
  VariacaoDto,
} from '@delfrance/schemas';

import { type ShopeeCategoriaIndice, caminhoDaCategoria, ehFolha, filhosDe } from './categorias';

/* -------------------------------------------------------------------------- */
/*              The shapes, declared once in @delfrance/schemas               */
/* -------------------------------------------------------------------------- */

export {
  atributoDtoSchema,
  atributoInfoDtoSchema,
  atributoValorDtoSchema,
  categoriaNoDtoSchema,
  categoriaResumoDtoSchema,
  marcaDtoSchema,
  variacaoDtoSchema,
  variacaoGrupoDtoSchema,
  variacaoOpcaoDtoSchema,
  type AtributoDto,
  type AtributoInfoDto,
  type AtributoValorDto,
  type CategoriaNoDto,
  type CategoriaResumoDto,
  type MarcaDto,
  type VariacaoDto,
  type VariacaoGrupoDto,
  type VariacaoOpcaoDto,
} from '@delfrance/schemas';

/* -------------------------------------------------------------------------- */
/*                                 Categories                                 */
/* -------------------------------------------------------------------------- */

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
