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
 *    grupoDeVariacoes docs — see {@link combinationForVariante} for the id
 *    rules, and {@link mergeStoredCombinations} for the ones a Flutter user
 *    configured that no grupo can rebuild.
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
import { parseFakePath } from '@delfrance/schemas';

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
  variacoes: Array<{
    id: string;
    nome: string;
    /**
     * This variante's ML `value_id`, when ML is the one that minted it. The IO
     * layer resolves it from `externalVariacaoLinks` and passes null whenever
     * the link's `externalId` is a value *name* rather than an id — see
     * `resolveMlValueId` in `publish.ts`.
     */
    mlValueId?: string | null;
  }>;
}

export interface PublishVariationChild {
  produto: PublishProduto;
  /** The child's `variacoesUid` fake paths (define its combination). */
  variacoesUid: string[];
  availableQuantity: number | null;
  /** Existing ML variation id from the child's `variacaoMercadoLivre` link. */
  mlVariationId: number | string | null;
  pictureIds?: string[];
  /**
   * `attribute_combinations` already stored on the child's `variacaoMercadoLivre`
   * link doc (written by the importer). Merged UNDER the grupo-derived ones so a
   * VOLTAGE/FLAVOR/MODEL a Flutter user configured survives a republish.
   */
  storedCombinations?: MlAttribute[];
}

export interface AssemblePublishArgs {
  produto: PublishProduto;
  /** `extraData.condicao` (1 novo / 2 usado / 3 recondicionado) or null. */
  condicao: number | null;
  /** Price-list id resolved from the integração's `tabelaNormalOuterRef`. */
  priceListId: string | null;
  /** Parent stock (ignored when legacy variations exist; null = do not send). */
  availableQuantity: number | null;
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

export function resolveCondition(
  link: PublishLink | null,
  produto: PublishProduto,
  condicao: number | null,
): 'new' | 'used' {
  if (link?.condition) return link.condition;
  if (produto.ehUsado) return 'used';
  // extraData.condicao: 1 = novo; 2 (usado) and 3 (recondicionado) map to the
  // only other value the old CONDITION enum supported.
  if (condicao != null && condicao !== 1) return 'used';
  return 'new';
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

/**
 * Does this grupo's doc id double as a Mercado Livre attribute id?
 *
 * The taxonomy importer NAMES an ML-derived grupo after the ML attribute itself
 * (`FLAVOR`, `VOLTAGE`, `MAIN_COLOR` — `taxonomiaCore.ts:251`), falling back to
 * `n-<slug>` only when ML sent a name and no id. A grupo created in the ERP
 * carries a Firestore auto-id instead. ML attribute ids are UPPER_SNAKE, so
 * that shape is the test.
 *
 * ⚠️ A heuristic, deliberately biased: a 20-char Firestore auto-id that happens
 * to be all upper-case and digits would match (~1e-5), and the cost is one
 * publish rejected by ML naming the bad attribute. Guessing the other way is
 * what #797 E8 reports — an INVENTED id (`SABOR`) shipped to a live listing.
 */
const ML_ATTRIBUTE_ID = /^[A-Z][A-Z0-9_]*$/;

/**
 * The `attribute_combinations` entry for one variante of one grupo.
 *
 *  - tipo 1 (tamanho) → `SIZE`, tipo 2 (cor) → `COLOR` — the legacy conventions;
 *  - an ML-derived grupo → its own doc id, which IS the ML attribute id;
 *  - anything else → a **custom characteristic**: `name` + `value_name` and NO
 *    `id`, which is the only shape ML documents for an attribute outside its
 *    taxonomy. The `name` is what buyers see on the VIP. The old port sent
 *    `{ id: NOME_DO_GRUPO }` here (`'Sabor'` → `{id:'SABOR'}`), an id that
 *    exists nowhere in ML (#797 E8).
 *
 * `value_id` rides along only when ML minted the variante — see
 * `PublishGrupoVariacao.variacoes[].mlValueId`.
 */
export function combinationForVariante(
  grupo: PublishGrupoVariacao,
  variante: { id: string; nome: string; mlValueId?: string | null },
): MlAttribute {
  const id =
    grupo.tipo === 1
      ? 'SIZE'
      : grupo.tipo === 2
        ? 'COLOR'
        : ML_ATTRIBUTE_ID.test(grupo.grupoId)
          ? grupo.grupoId
          : null;
  if (id == null) return { name: grupo.nome, value_name: variante.nome };
  return {
    id,
    ...(variante.mlValueId != null ? { value_id: variante.mlValueId } : {}),
    value_name: variante.nome,
  };
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
    out.push(combinationForVariante(grupo, variante));
  }
  return out;
}

/** Identity of a combination entry: the ML attribute id, else its custom name. */
function combinationKey(attr: MlAttribute): string | null {
  return attr.id ?? attr.name ?? null;
}

/**
 * Fold the combinations stored on the child's `variacaoMercadoLivre` link doc in
 * UNDER the grupo-derived ones.
 *
 * The grupos only ever rebuild SIZE/COLOR plus whatever the taxonomy importer
 * mapped, so a variation attribute a Flutter user configured by hand (VOLTAGE,
 * FLAVOR, MODEL) had nothing to regenerate it and vanished on the first
 * republish (#797 E8). The stored entries are the record of it.
 *
 * The grupo wins every collision — it reflects what the ERP believes NOW, and a
 * duplicated combination id is an outright ML rejection. Stored entries with no
 * id cannot occur (the importer drops those, `importCore.ts:456`), but they are
 * keyed by `name` anyway so the dedupe holds if that ever changes.
 */
export function mergeStoredCombinations(
  derived: MlAttribute[],
  stored: MlAttribute[] | undefined,
): MlAttribute[] {
  if (!stored?.length) return derived;
  const seen = new Set(derived.map(combinationKey).filter((k): k is string => k != null));
  const out = [...derived];
  for (const attr of stored) {
    const key = combinationKey(attr);
    if (key == null || seen.has(key)) continue;
    if (attr.value_id == null && attr.value_name == null) continue; // valueless: nothing to send
    seen.add(key);
    out.push(attr);
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
    const combos = mergeStoredCombinations(
      combinationsFromVariacoes(child.variacoesUid, args.grupos, child.produto.nome, issues),
      child.storedCombinations,
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
    // ML allows a product to vary by at most ONE custom characteristic
    // ("Característica personalizada" — only one attribute outside its taxonomy
    // may drive the variations). Two would be rejected item-wide, so name them
    // here instead of letting ML answer with a generic 400.
    const customs = finalCombos.filter((c) => c.id == null);
    if (customs.length > 1) {
      const nomes = customs.map((c) => `"${c.name ?? '?'}"`).join(', ');
      issues.push(
        `variação "${child.produto.nome}": o Mercado Livre aceita apenas UMA característica ` +
          `personalizada por produto, e este varia por ${customs.length} (${nomes}). ` +
          `Vincule os grupos a atributos do ML ou reduza a um só.`,
      );
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
