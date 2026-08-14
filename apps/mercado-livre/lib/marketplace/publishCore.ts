/**
 * Pure assembly for the product-publish flow: turns the loaded Firestore graph
 * (produto + extraData + estoque + link docs + variation children) into the
 * `buildItemPayload` input from `@delfrance/integrations-mercado-livre`.
 * No IO here — `publish.ts` loads the graph and calls the ML API; this module
 * holds the decisions (ported from the old Flutter `toMercadoLivre` call sites):
 *
 *  - price comes from `produto.precos[<tabelaNormal list id>]` — NO fallback:
 *    a missing price is a validation error naming the produto (repo rule:
 *    no magic defaults on user data);
 *  - condition: the link doc's persisted `condition` wins (edits keep it),
 *    else `ehUsado` / `extraData.condicao != 1` → 'used';
 *  - parent attributes = the link doc's custom attributes + SELLER_SKU +
 *    WEIGHT + SELLER_PACKAGE_* dimensions (combination ids pruned later by the
 *    mapper);
 *  - variation combinations map the child's `variacoesUid` through the
 *    grupoDeVariacoes docs: tipo 1 (tamanho) → SIZE, tipo 2 (cor) → COLOR,
 *    other tipos → the group name uppercased (ML validates per category).
 */
import {
  type BuildItemPayloadInput,
  type ItemVariationInput,
  type MlAttribute,
  attrPackageDimensions,
  attrSizeGridId,
  attrSizeGridRowId,
  attrSku,
  attrWeightKg,
} from '@delfrance/integrations-mercado-livre';
import { parseFakePath, resolveCondicaoAnuncio } from '@delfrance/schemas';

import type { ResolvedSizeChart } from './sizeChart';

/** Publish blocked by missing/invalid produto data — maps to HTTP 422. */
export class MercadoLivrePublishError extends Error {
  constructor(readonly issues: string[]) {
    super(`Publicação bloqueada: ${issues.join('; ')}`);
    this.name = 'MercadoLivrePublishError';
  }
}

/** The produto fields the assembly consumes (parent or variation child). */
export interface PublishProduto {
  id: string;
  nome: string;
  sku: string | null;
  ehUsado: boolean;
  pesoLiquidoKg: number | null;
  pesoBrutoKg: number | null;
  alturaCm: number | null;
  larguraCm: number | null;
  profundidadeCm: number | null;
  precos: Record<string, { valor: number }> | null;
  ordem?: number | null;
}

/** The subset of the `produtoMercadoLivre` link doc the assembly reads. */
export interface PublishLink {
  docId: string;
  id: string | null;
  /** Operator-authored listing title. Blank/absent falls back to `produto.nome`. */
  title?: string | null;
  condition?: 'new' | 'used' | null;
  listing_type_id?: string | null;
  category_id?: string | null;
  isUserProductModel?: boolean | null;
  attributes?: MlAttribute[] | null;
  video_id?: string | null;
}

/** A grupoDeVariacoes doc slice for combination mapping. */
export interface PublishGrupoVariacao {
  grupoId: string;
  nome: string;
  /** 0/null = outros, 1 = tamanho, 2 = cor. */
  tipo: number | null;
  variacoes: Array<{ id: string; nome: string }>;
}

export interface PublishVariationChild {
  produto: PublishProduto;
  /** The child's `variacoesUid` fake paths (define its combination). */
  variacoesUid: string[];
  availableQuantity: number;
  /** Existing ML variation id from the child's `variacaoMercadoLivre` link. */
  mlVariationId: number | string | null;
  pictureIds?: string[];
}

export interface AssemblePublishArgs {
  produto: PublishProduto;
  /** `extraData.condicao` (1 novo / 2 usado / 3 recondicionado) or null. */
  condicao: number | null;
  /** Price-list id resolved from the integração's `tabelaNormalOuterRef`. */
  priceListId: string | null;
  /** Parent stock (ignored when legacy variations exist). */
  availableQuantity: number;
  /** ML picture ids, already uploaded/cached by the IO layer. */
  pictures: Array<{ id: string }>;
  variations: PublishVariationChild[];
  grupos: PublishGrupoVariacao[];
  /** Existing link doc for this integração (null on first publish). */
  link: PublishLink | null;
  /** The link doc id chosen for `seller_custom_field` (new or existing). */
  linkDocId: string;
  categoryId: string | null;
  listingTypeId: string | null;
  isUserProductSeller: boolean;
  /**
   * Resolved size-chart binding (null = no chart; SIZE_GRID_* omitted, legacy
   * parity — ML itself rejects chart-required domains).
   */
  sizeChart?: ResolvedSizeChart | null;
}

/** Resolve the selling price from the integração's tabela normal — or fail. */
export function resolvePrice(
  produto: PublishProduto,
  priceListId: string | null,
  issues: string[],
): number | null {
  if (!priceListId) {
    issues.push('integração sem tabela de preços (tabelaNormalOuterRef)');
    return null;
  }
  const valor = produto.precos?.[priceListId]?.valor;
  if (valor == null || valor <= 0) {
    issues.push(`produto "${produto.nome}" sem preço na tabela ${priceListId}`);
    return null;
  }
  return valor;
}

/**
 * The listing's `condition`, decided by the **produto**.
 *
 * ⚠️ The precedence used to start at `link.condition`, and that made every other
 * branch dead code: `produtoMercadoLivreLinkSchema` declares
 * `condition: z.enum(['new','used']).default('new')`, so a link doc ALWAYS has a
 * truthy `condition` and the first test always won. A produto marked "usado"
 * still published as `new` unless someone had also set the listing's own copy.
 *
 * The produto now wins, which is what the field means: whether a product is used
 * is a fact about the product, not about one of its listings. `link.condition`
 * survives as the last resort — an imported listing writes it
 * (`importItem.ts`), so it is the best available answer for a produto whose own
 * flags were never set.
 *
 * `condicao != 1` stays as the secondary branch: `extraData.condicao` is a
 * three-value field (1 novo, 2 usado, 3 recondicionado) and dropping it would
 * silently start publishing recondicionado stock as new.
 *
 * ⚠️ The precedence itself lives in `@delfrance/schemas` because the produto
 * editor has to SHOW the operator what this will send. A second copy over there
 * mirrored only `ehUsado`, so a produto marked recondicionado displayed "Novo"
 * and published `used` — a disagreement nothing could catch, because one side is
 * a screen and the other a payload.
 */
export function resolveCondition(
  link: PublishLink | null,
  produto: PublishProduto,
  condicao: number | null,
): 'new' | 'used' {
  return resolveCondicaoAnuncio({
    ehUsado: produto.ehUsado === true,
    condicao,
    condicaoAnuncio: link?.condition ?? null,
  }).condition;
}

/**
 * Attribute ids `buildParentAttributes` DERIVES from the produto on every run.
 *
 * Publish persists the assembled parent attributes back onto the link doc
 * (#799 bug 7) so a produto published from scratch stops carrying
 * `attributes: null` forever. These ids must be excluded from that write: they
 * are appended unconditionally below, so storing them would duplicate them on
 * the next publish. `SIZE_GRID_ID` is deliberately NOT here — the link doc is
 * where the chart binding lives between publishes, and a fresh resolution
 * replaces it rather than adding a second one.
 */
export const ML_DERIVED_ATTRIBUTE_IDS: ReadonlySet<string> = new Set([
  'SELLER_SKU',
  'WEIGHT',
  'SELLER_PACKAGE_HEIGHT',
  'SELLER_PACKAGE_LENGTH',
  'SELLER_PACKAGE_WIDTH',
  'SELLER_PACKAGE_WEIGHT',
]);

/**
 * Parent-level attributes (mapper prunes any combination ids from these).
 *
 * `includeSku: false` only when the payload will actually EMIT variations, each
 * of which carries its own `SELLER_SKU` that ML must not see duplicated at the
 * parent. The mapper strips it defensively too, but suppressing it here keeps
 * the assembled input honest — publish persists these attributes onto the link
 * doc (#799 bug 7).
 *
 * ⚠️ "has children" is NOT the same condition. `buildItemPayload` drops the
 * variations array entirely for a User-Products seller, so a UP produto with
 * children emits no per-variation SKUs at all — suppressing the parent's too
 * would ship a payload with NO SKU anywhere. The caller must mirror the
 * mapper's own test, not the child count.
 */
export function buildParentAttributes(
  produto: PublishProduto,
  link: PublishLink | null,
  sizeChartId?: string | null,
  options?: { includeSku?: boolean },
): MlAttribute[] {
  // A freshly resolved chart REPLACES any stale SIZE_GRID_ID the link doc
  // carries (legacy toMercadoLivre: remove-then-add); with no resolution the
  // link's existing binding is left untouched.
  const attrs: MlAttribute[] =
    sizeChartId != null
      ? (link?.attributes ?? []).filter((a) => a.id !== 'SIZE_GRID_ID')
      : [...(link?.attributes ?? [])];
  if (sizeChartId != null) attrs.push(attrSizeGridId(sizeChartId));
  if (produto.sku && (options?.includeSku ?? true)) attrs.push(attrSku(produto.sku));
  if (produto.pesoLiquidoKg != null) attrs.push(attrWeightKg(produto.pesoLiquidoKg));
  const pesoKg = produto.pesoBrutoKg ?? produto.pesoLiquidoKg;
  if (
    produto.alturaCm != null &&
    produto.larguraCm != null &&
    produto.profundidadeCm != null &&
    pesoKg != null
  ) {
    attrs.push(
      ...attrPackageDimensions({
        alturaCm: produto.alturaCm,
        larguraCm: produto.larguraCm,
        profundidadeCm: produto.profundidadeCm,
        pesoKg,
      }),
    );
  }
  return attrs;
}

/** The ML attribute id for a variation group (old SIZE/COLOR conventions). */
export function combinationIdForGrupo(grupo: PublishGrupoVariacao): string {
  if (grupo.tipo === 1) return 'SIZE';
  if (grupo.tipo === 2) return 'COLOR';
  return grupo.nome.trim().toUpperCase().replace(/\s+/g, '_');
}

/**
 * Map a child's `variacoesUid` fake paths to combination attributes via the
 * grupo docs. Unknown paths/variants are validation issues (never silently
 * dropped — a missing combination would publish a wrong listing).
 */
export function combinationsFromVariacoes(
  variacoesUid: string[],
  grupos: PublishGrupoVariacao[],
  childNome: string,
  issues: string[],
): MlAttribute[] {
  const out: MlAttribute[] = [];
  for (const uid of variacoesUid) {
    const parsed = parseFakePath(uid);
    if (!parsed) {
      issues.push(`variação "${childNome}": caminho de variação inválido (${uid})`);
      continue;
    }
    const grupo = grupos.find((g) => g.grupoId === parsed.grupoId);
    const variante = grupo?.variacoes.find((v) => v.id === parsed.varianteId);
    if (!grupo || !variante) {
      issues.push(`variação "${childNome}": grupo/variante não encontrado (${uid})`);
      continue;
    }
    out.push({ id: combinationIdForGrupo(grupo), value_name: variante.nome });
  }
  return out;
}

/**
 * Assemble the full `buildItemPayload` input — or throw
 * `MercadoLivrePublishError` listing every blocking issue at once.
 */
export function assemblePublishInput(args: AssemblePublishArgs): BuildItemPayloadInput {
  const issues: string[] = [];

  if (!args.produto.nome?.trim()) issues.push('produto sem nome');
  const price = resolvePrice(args.produto, args.priceListId, issues);
  const isUpdate = args.link?.id != null;
  if (!isUpdate && !args.categoryId) {
    issues.push('categoria do Mercado Livre não definida (category_id)');
  }
  if (!isUpdate && !args.listingTypeId) {
    issues.push('tipo de anúncio não definido (listing_type_id)');
  }
  if (args.pictures.length === 0) issues.push('produto sem fotos');

  const variations: ItemVariationInput[] = args.variations.map((child) => {
    const combos = combinationsFromVariacoes(
      child.variacoesUid,
      args.grupos,
      child.produto.nome,
      issues,
    );
    if (combos.length === 0) {
      issues.push(`variação "${child.produto.nome}" sem atributos de combinação`);
    }
    const attrs: MlAttribute[] = [];
    if (child.produto.sku) attrs.push(attrSku(child.produto.sku));
    // Size-chart row binding: SIZE_GRID_ROW_ID rides the variation ATTRIBUTES
    // (never the combinations), and the chart row's SIZE label REPLACES the
    // variante's nome in the combinations — ML flags a SIZE/row mismatch
    // (cause 2615). Legacy `get_attribute_combinations` did a removeWhere on
    // EVERY SIZE entry before adding the chart's, so a child spanning two
    // tamanho groups still sends exactly ONE SIZE (a duplicated combination
    // id is an ML rejection).
    let finalCombos = combos;
    const rowBinding = args.sizeChart?.rowByChildId[child.produto.id] ?? null;
    if (rowBinding) {
      attrs.push(attrSizeGridRowId(rowBinding.rowId));
      const rowSize = rowBinding.size;
      if (rowSize && (rowSize.value_id != null || rowSize.value_name != null)) {
        finalCombos = combos.filter((c) => c.id !== 'SIZE');
        finalCombos.push({
          id: 'SIZE',
          ...(rowSize.value_id != null ? { value_id: rowSize.value_id } : {}),
          ...(rowSize.value_name != null ? { value_name: rowSize.value_name } : {}),
        });
      }
    }
    return {
      mlVariationId: child.mlVariationId,
      produtoId: child.produto.id,
      order: child.produto.ordem ?? null,
      availableQuantity: child.availableQuantity,
      pictureIds: child.pictureIds,
      attributeCombinations: finalCombos,
      attributes: attrs,
    };
  });

  if (issues.length > 0) throw new MercadoLivrePublishError(issues);

  // #799 bug 4a: the link doc's own `title` wins. It used to be ignored here
  // entirely — and then clobbered with `produto.nome` on the way back — so an
  // operator could never give the listing an ML-optimised name of its own.
  // Blank means absent, the same rule `descricao` already follows.
  const linkTitle = args.link?.title?.trim() ?? '';

  return {
    isUpdate,
    isUserProductSeller: args.isUserProductSeller,
    title: linkTitle.length > 0 ? linkTitle : args.produto.nome,
    condition: resolveCondition(args.link, args.produto, args.condicao),
    sellerCustomField: args.linkDocId,
    categoryId: args.categoryId,
    listingTypeId: args.listingTypeId,
    price,
    availableQuantity: args.availableQuantity,
    pictures: args.pictures,
    videoId: args.link?.video_id ?? null,
    attributes: buildParentAttributes(args.produto, args.link, args.sizeChart?.chartId ?? null, {
      // Mirrors buildItemPayload's own `hasVariations`, which is
      // `!isUserProductSeller && variations.length > 0` — a UP seller emits no
      // variations array, so its parent SKU is the only one there is.
      includeSku: args.isUserProductSeller || variations.length === 0,
    }),
    variations,
  };
}
