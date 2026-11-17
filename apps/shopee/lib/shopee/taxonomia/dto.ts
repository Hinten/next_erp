/**
 * The PROJECTIONS behind the Shopee taxonomy routes: each builds a route's
 * answer from the integration package's already-parsed provider payloads.
 *
 * ⚠️ **The answer SHAPES are no longer declared here** (#1911, P2). They live in
 * `@delfrance/schemas` (`taxonomiaShopeeDto.ts`), the one package both this app
 * and `apps/web` reach, beside one ENVELOPE per route: each route builds its 200
 * `satisfies z.input<…>` of its envelope and its test parses that 200 with the
 * SAME schema object, so a browser reader imports that one declaration instead
 * of keeping a hand copy beside a comment saying the names match — the #1369
 * shape, two copies the compiler cannot compare. The naming rule (camelCase
 * mirrors of Shopee's own names, pt-BR only for an envelope noun) and the
 * "plain `z.number()`, never `wireInt()`" rule moved WITH the shapes and are
 * written down there —
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
import {
  type AtributoDto,
  type AtributoInfoDto,
  type AtributoValorDto,
  type CategoriaNoDto,
  type CategoriaResumoDto,
  type MarcaDto,
  type VariacaoDto,
  textoUtilizavelShopee,
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
 * The `multi_lang` spelling the Portuguese arrives under — the only one Shopee
 * sent across the eight BR trees of 2026-11-04 (848 entries, all of them).
 * Matched EXACTLY: `pt-br`, `PT-BR` or `pt` is a language nobody has seen there,
 * and taking it would be a guess.
 */
const IDIOMA_DOS_NOMES = 'pt-BR';

/**
 * The name an attribute or a value is shown under: the FIRST `multi_lang` entry
 * whose `language` is exactly {@link IDIOMA_DOS_NOMES} and whose `value` is a
 * non-blank string, VERBATIM (a projection never trims); else Shopee's own
 * `name`, verbatim, `null` included.
 *
 * ⚠️ A SELECTION, not a fold: it picks one string and decides no equality, so
 * it has no `equivalence-fold-inventory` row. Its scope is pinned anyway
 * (`dto.test.ts`, the near-misses).
 */
function nomeExibido(row: ShopeeAttribute | ShopeeAttributeValue): string | null {
  for (const entrada of row.multi_lang) {
    const texto = entrada.value;
    if (
      entrada.language === IDIOMA_DOS_NOMES &&
      typeof texto === 'string' &&
      textoUtilizavelShopee(texto) !== null
    ) {
      return texto;
    }
  }
  return row.name;
}

/** One projected sibling, with what its label is disambiguated by. */
interface Irmao<D> {
  readonly dto: D;
  /** Shopee's own `name` (English on BR), the preferred suffix. */
  readonly nomeShopee: string | null;
  /** The attribute or value id — the node's identity, and the fallback suffix. */
  readonly id: number;
}

/**
 * Siblings whose labels would read ALIKE are told apart (#1911 P13a, Lucas
 * 2026-11-04 Q2 = A).
 *
 * ONE sibling list at a time — an attribute's values, the root attributes, or
 * the children one value unlocks — never across lists. Two or more DISTINCT
 * ids whose label is the same string (`===`: no case or accent fold, so «Lã»,
 * «La» and «lã» are three labels) each become `"<label> (<Shopee name>)"` when
 * that Shopee `name` is a non-blank string, appended verbatim, that no other
 * colliding id shares (exactly: «Wool» and «wool» differ), else
 * `"<label> (#<id>)"`. An entry that collides with nothing is untouched, and so
 * is a `null` label (the validator already names it `#<id>`). The same id
 * twice in one list is ONE node, never a collision with itself — the
 * validator's walk (`atributosVisiveisShopee`) already reads a repeated id
 * once. BR: «Porcelana (Porcelain)» / «Porcelana (Fine China)», «Lã (Fleece)» /
 * «Lã (Wool)».
 *
 * ⚠️ ONE pass: a suffixed label is not compared again with the untouched
 * siblings, so «Lã» + «Lã» + a literal «Lã (Wool)» yields «Lã (Wool)» twice
 * (`dto.test.ts` pins it; no BR tree holds such a sibling). ⚠️ Labels that
 * differ only in whitespace («Lã» / «Lã »), which a picker renders alike, do
 * NOT collide under `===`; that reading is deliberately left unpinned until the
 * owner decides — no BR tree holds such a pair, and `dto.capturasBr.test.ts`
 * goes red on one.
 */
function rotulosDistintos<D extends { readonly name: string | null }>(
  irmaos: readonly Irmao<D>[],
): D[] {
  const idsPorRotulo = new Map<string, Set<number>>();
  for (const { dto, id } of irmaos) {
    if (dto.name === null) continue;
    const ids = idsPorRotulo.get(dto.name) ?? new Set<number>();
    ids.add(id);
    idsPorRotulo.set(dto.name, ids);
  }
  return irmaos.map(({ dto, nomeShopee, id }) => {
    const rotulo = dto.name;
    if (rotulo === null || (idsPorRotulo.get(rotulo)?.size ?? 0) < 2) return dto;
    const mesmoNomeShopee = new Set(
      irmaos
        .filter((outro) => outro.dto.name === rotulo && outro.nomeShopee === nomeShopee)
        .map((outro) => outro.id),
    ).size;
    const sufixo =
      nomeShopee !== null && textoUtilizavelShopee(nomeShopee) !== null && mesmoNomeShopee === 1
        ? nomeShopee
        : `#${String(id)}`;
    return { ...dto, name: `${rotulo} (${sufixo})` };
  });
}

/**
 * Project a category's attribute tree, depth-capped.
 *
 * ⚠️ `truncated` is set only when a level was ACTUALLY dropped. A tree that is
 * exactly {@link SHOPEE_ATTRIBUTE_MAX_DEPTH} deep is complete and must say so —
 * a flag that fired on the boundary would make every deep-but-whole answer look
 * lossy, and an operator who learns to ignore it learns to ignore the real one.
 *
 * Names are Shopee's own `pt-BR` text (#1911 P13a). BR's `get_attribute_tree`
 * ignores the `language` it is sent — `pt-br`, `pt-BR` and none answered the
 * same bytes on 2026-11-04 — and names everything in English; the pt-BR text
 * is the `multi_lang` entry whose `language` is EXACTLY `"pt-BR"`, the only
 * spelling Shopee sends there. Its text (a non-blank string, verbatim) is the
 * `name` of an attribute or a value at every depth; with none, Shopee's own
 * `name` stands (one BR value has no `multi_lang` at all). It is Portuguese on
 * most rows, but Shopee leaves some untranslated (a-caneca 101534 «Coffee Pot
 * Type», d-shampoo 101317 «Hair Type»): those stay English, because the
 * projection never translates. Siblings that would read alike («Porcelana»
 * twice) are told apart by Shopee's own name ({@link rotulosDistintos}) in ONE
 * pass: a suffixed label is not re-checked against the rest of its list (no BR
 * tree has such a sibling, and `dto.capturasBr.test.ts`'s «nenhuma lista de
 * irmãos projetada oferece dois rótulos iguais» goes red if a capture brings
 * one). The validator's operator names and the publisher's
 * `atributo-obrigatorio` sentence are built from these names, so both carry
 * that text; no verdict changes (the validator decides on ids). The item read's
 * `original_attribute_name` / `original_value_name` stay English: nothing
 * shows them. `multi_lang` itself is not a key of the answer.
 */
export function projetarAtributos(tree: readonly ShopeeAttribute[]): AtributosProjetados {
  let truncated = false;

  function valor(row: ShopeeAttributeValue, depth: number): AtributoValorDto {
    const filhos = row.child_attribute_list;
    let childAttributeList: AtributoDto[] = [];
    if (filhos.length > 0) {
      if (depth >= SHOPEE_ATTRIBUTE_MAX_DEPTH) truncated = true;
      else childAttributeList = irmaosDistintos(filhos, depth + 1);
    }
    return {
      valueId: row.value_id,
      name: nomeExibido(row),
      valueUnit: row.value_unit,
      childAttributeList,
    };
  }

  function atributo(row: ShopeeAttribute, depth: number): AtributoDto {
    return {
      attributeId: row.attribute_id,
      mandatory: row.mandatory,
      name: nomeExibido(row),
      attributeInfo: projetarInfo(row),
      attributeValueList: rotulosDistintos(
        row.attribute_value_list.map((v) => ({
          dto: valor(v, depth),
          nomeShopee: v.name,
          id: v.value_id,
        })),
      ),
    };
  }

  /** One list of sibling attributes (the roots, or one value's children). */
  function irmaosDistintos(lista: readonly ShopeeAttribute[], depth: number): AtributoDto[] {
    return rotulosDistintos(
      lista.map((row) => ({
        dto: atributo(row, depth),
        nomeShopee: row.name,
        id: row.attribute_id,
      })),
    );
  }

  const atributos = irmaosDistintos(tree, 1);
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
