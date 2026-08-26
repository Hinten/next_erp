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
 *
 * {@link resolveListingModel} and {@link publishModeIssues} sit apart from that
 * pipeline: they are the PRE-FLIGHT decisions `publish.ts` makes before it
 * uploads a single picture (#798).
 */
import {
  ML_PRODUTO_DERIVED_ATTRIBUTE_IDS,
  type BuildItemPayloadInput,
  type ItemVariationInput,
  type MlAttribute,
  type MlShippingMode,
  attrPackageDimensions,
  attrSizeGridId,
  attrSizeGridRowId,
  attrSku,
  attrWeightKg,
} from '@delfrance/integrations-mercado-livre';
import { dimensoesDoPacote, parseFakePath, resolveCondicaoAnuncio } from '@delfrance/schemas';

import { isFamilyId } from '../core/linkRefs';
import type { ResolvedSizeChart } from '../size-charts/sizeChart';

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
  /**
   * Parent only. `false` prices each User-Products member from its OWN `precos`
   * entry instead of the anchor's — the rule `precoPlan.buildPrecoDrafts`
   * already applies, and publish must agree with it or a first publish lands a
   * price the very next price sync overwrites. Undefined/true = anchor,
   * matching the schema default. Meaningless under the legacy model, where ML
   * requires one uniform price for the whole family.
   */
  propagatePriceToChildren?: boolean | null;
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
  /** `estadoPublicacaoMl` wire code — only `'am'` (mid-UPtin) is read here. */
  estado?: string | null;
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
  availableQuantity: number;
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
  /**
   * The price list's `nome`, when the IO layer could resolve one — null when
   * `priceListId` itself is null, or the lookup found nothing (deleted
   * table). This module stays pure/no-IO; only `publish.ts` may fetch it
   * (`listaDePrecosCache.ts`).
   */
  priceListNome: string | null;
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
  /**
   * The conta's `shipping.mode`, straight from the integração doc. Passed
   * through untouched and deliberately NOT validated here: whether a mode is
   * available to this seller is an account/category fact only ML holds, and it
   * already answers with a readable `shipping.me2_adoption_mandatory` cause that
   * `publishFalhas.ts` parses. A local guess would only be a second, staler
   * copy of that answer.
   */
  shippingMode?: MlShippingMode | null;
}

/* ------------------------- publishing model + guards ------------------------ */

/**
 * Which of ML's two coexisting publishing models a listing must use.
 *
 * `'legacy'` sends `title` + a `variations[]` array; `'user-products'` sends
 * `family_name`, no title, and one ML ITEM PER VARIATION.
 */
export type ListingModel = 'user-products' | 'legacy';

/**
 * Pick the model for this listing.
 *
 * Once a seller carries the `user_product_seller` tag, **new** items must go out
 * in the User-Products shape or ML answers 400 — but items already published
 * under the legacy model and not yet migrated stay editable with the legacy
 * payload for the whole migration. So the two inputs are not interchangeable and
 * their precedence is load-bearing (legacy parity —
 * `.old/lib/canaisDeVenda/mercadoLivre/exportarProdutos.dart:149-151` branches on
 * the persisted flag, never on the account tag):
 *
 *  - **already published** (`link.id != null`) → the link's persisted
 *    `isUserProductModel` wins. It is set by the importer (`family_name != null`)
 *    and flipped by the UPtin takeover; publish only ever echoes it back.
 *  - **never published** (`link.id == null`) → the ACCOUNT tag decides, because
 *    there is no listing yet whose shape could constrain us.
 *
 * ⚠️ Reading only the link — which is what publish did before #798 — means every
 * first publish on a tagged account resolves to `'legacy'`, since a draft link
 * doc is created with `isUserProductModel: false`.
 */
export function resolveListingModel(
  link: PublishLink | null,
  sellerIsUserProduct: boolean,
): ListingModel {
  if (link?.id != null) return link.isUserProductModel === true ? 'user-products' : 'legacy';
  return sellerIsUserProduct ? 'user-products' : 'legacy';
}

/**
 * Pre-flight blocks, raised BEFORE any ML call and before the picture uploads —
 * unlike {@link assemblePublishInput}'s issues, which are only reached after the
 * whole graph (and every picture) has been resolved.
 *
 * Returns the issues rather than throwing so the caller aggregates them the same
 * way the assembly does.
 */
export function publishModeIssues(args: {
  /** The link doc's `estado`, or null on a first publish. */
  estado: string | null;
  /** The resolved model — a family id is only possible under User Products. */
  model: ListingModel;
  /** The link doc's `id`, or null when the listing was never published. */
  linkId: string | null;
  /** How many variation children this produto owns. */
  childrenCount: number;
}): string[] {
  const issues: string[] = [];

  // Mid-UPtin: ML is mid-flight creating one item per variation and rejects any
  // change to the source item (404 while migrating). The stock planner and the
  // price planner carry the same rung; publish was the only writer without it.
  // ⚠️ The items status-sync does NOT read `'am'` — it WRITES it. It is the only
  // component that observes ML's migration tags on its own schedule (it holds the
  // fetched item), so it stamps the verdict and these three gate on it without a
  // fetch of their own. `'am'` has no other producer: it used to arrive only from
  // the Flutter app, which is switched off at the cutover (#1087). Legacy blocked
  // the whole export here, above the UP/legacy fork
  // (`exportarProdutos.dart:141-147`).
  if (args.estado === 'am') {
    issues.push(
      'anúncio em migração para o modelo User Products (UPtin) — aguarde a conclusão antes de publicar',
    );
  }

  // A User-Products family whose variations were ALL deleted — the one childless
  // UP state publish must REFUSE rather than repair. `link.id` holds a FAMILY id,
  // so there is no item to PUT and no member to derive one from: inventing a sole
  // member here would POST a NEW item into a family that already has live ones,
  // and `sweepRemovedMembers` would then confirm and CLOSE every sibling that was
  // selling. The other two childless states are repairable and handled by
  // {@link classificarMembroUnico}; this is the one that is not.
  //
  // ⚠️ Evaluated against the ORIGINAL `childrenCount`, before any sole-member
  // materialisation runs. Materialise first and `childrenCount` is 1, so this
  // guard silently stops firing — which is exactly the destructive case.
  if (classificarMembroUnico(args) === 'recusar') {
    issues.push(
      'este anúncio é uma família User Products (o vínculo aponta para a família, não para um ' +
        'anúncio) e o produto não tem mais variações — recadastre as variações ou encerre os ' +
        'anúncios da família no Mercado Livre',
    );
  }

  return issues;
}

/**
 * What a childless User-Products produto needs before it can publish (#1087).
 *
 * ML auto-generates a family for EVERY user product, so a "UP single" is really a
 * family of one — which is the shape the importer writes (parent + one child) and
 * the shape publish did NOT write, storing a root produto instead. The two sides
 * disagreed for exactly this case, so a produto could not survive
 * delete → re-import. Publish now converges on the importer's shape, and this
 * classifier is the whole dispatch.
 *
 * ⚠️ The three cases are told apart by the SHAPE of `link.id`, never by
 * `childrenCount` alone — all three have zero children:
 *
 *  - `'nenhum'`  – not a childless UP produto; nothing to do.
 *  - `'criar'`   – never published (`linkId == null`). Mint the sole member, POST it.
 *  - `'adotar'`  – published under the OLD convention, so `link.id` is a real item
 *                id (`MLB…`). Mint the sole member **carrying that item id** so the
 *                fan-out PUTs the existing listing. ⛔ Minting it WITHOUT the id
 *                makes the fan-out POST a second item, after which
 *                `sweepRemovedMembers` confirms the original as an orphan and
 *                pauses-then-closes it — a live listing, its sales history and its
 *                ranking, gone.
 *  - `'recusar'` – `link.id` is a FAMILY id (all digits), so the ERP's variations
 *                were deleted out from under a family that may still have live
 *                members. Not repairable from here.
 */
export function classificarMembroUnico(args: {
  model: ListingModel;
  linkId: string | null;
  childrenCount: number;
}): 'nenhum' | 'criar' | 'adotar' | 'recusar' {
  if (args.model !== 'user-products' || args.childrenCount > 0) return 'nenhum';
  if (args.linkId == null || args.linkId === '') return 'criar';
  return isFamilyId(args.linkId) ? 'recusar' : 'adotar';
}

/**
 * Resolve the selling price from the integração's tabela normal — or fail,
 * naming the price list by BOTH its `nome` (when resolved) and its raw
 * Firestore id, never one in place of the other: the id is what an operator
 * can look up directly in Firestore, the nome is what they recognise on
 * sight. `nome` is null when `id` itself is null, or when the IO layer's
 * cached lookup could not resolve one — in that case the message is
 * IDENTICAL to what it always was, id-only.
 */
export function resolvePrice(
  produto: PublishProduto,
  priceList: { id: string | null; nome: string | null },
  issues: string[],
): number | null {
  if (!priceList.id) {
    issues.push('integração sem tabela de preços (tabelaNormalOuterRef)');
    return null;
  }
  const valor = produto.precos?.[priceList.id]?.valor;
  if (valor == null || valor <= 0) {
    // `nome` is read through a soft-parse cache (listaDePrecosCache.ts) that
    // returns RAW data on schema mismatch (packages/data/src/zodParse.ts's
    // `parseSoftRead`) — so despite the declared type, a legacy/malformed doc
    // can hand back a blank, whitespace-only, or even non-string `nome`.
    // Treat anything but a genuinely usable label as unresolved, so the
    // message truly falls back to the id-only pre-fix form instead of
    // showing `tabela "" (id)`.
    const nome = typeof priceList.nome === 'string' ? priceList.nome.trim() : '';
    const tabela = nome !== '' ? `"${nome}" (${priceList.id})` : priceList.id;
    issues.push(`produto "${produto.nome}" sem preço na tabela ${tabela}`);
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
 *
 * The membership itself is {@link ML_PRODUTO_DERIVED_ATTRIBUTE_IDS}, shared with
 * the import stripper and the editor's projection: this list and the editor's
 * used to be independent literals in two workspaces, and they disagreed —
 * `PACKAGE_*` there against the `SELLER_PACKAGE_*` here, which are different ML
 * attributes. A `Set` rather than the array because the hot path is
 * `.has()` per stored attribute.
 */
export const ML_DERIVED_ATTRIBUTE_IDS: ReadonlySet<string> = new Set(
  ML_PRODUTO_DERIVED_ATTRIBUTE_IDS,
);

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
  // ⚠️ Derived ids are dropped from the STORED list before anything is appended,
  // or a link doc carrying a stale copy ships the attribute twice — once with
  // the operator's old value and once with the produto's. The write-back has
  // excluded them since #799 and the editor now withholds them entirely, but
  // neither reaches a doc written before that: `attributesForSave` can only
  // prune an id the CATEGORY lists, so a stored `WEIGHT` in a category whose
  // attribute list omits it survives every save. This is the boundary where the
  // rule is unconditional — publish owns these ids, whatever is on disk.
  const attrs: MlAttribute[] = (link?.attributes ?? []).filter(
    (a) =>
      !(a.id != null && ML_DERIVED_ATTRIBUTE_IDS.has(a.id)) &&
      // A freshly resolved chart REPLACES any stale SIZE_GRID_ID the link doc
      // carries (legacy toMercadoLivre: remove-then-add); with no resolution the
      // link's existing binding is left untouched.
      !(sizeChartId != null && a.id === 'SIZE_GRID_ID'),
  );
  if (sizeChartId != null) attrs.push(attrSizeGridId(sizeChartId));
  if (produto.sku && (options?.includeSku ?? true)) attrs.push(attrSku(produto.sku));
  if (produto.pesoLiquidoKg != null) attrs.push(attrWeightKg(produto.pesoLiquidoKg));
  // ⚠️ `dimensoesDoPacote` is the ONE implementation of "which fields, all four
  // or nothing, rounded how" — shared with the produto's Mercado Livre tab,
  // which shows the operator these exact numbers. Re-deriving them here is how a
  // screen ends up promising 10cm while the payload ships 11.
  const pacote = dimensoesDoPacote(produto);
  if (pacote) attrs.push(...attrPackageDimensions(pacote));
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

/** A stored entry is only worth sending if it actually carries a value. */
function storedIsValued(attr: MlAttribute): boolean {
  return attr.value_id != null || attr.value_name != null;
}

/**
 * Which stored combination keys may be merged WITHOUT breaking uniformity.
 *
 * ⚠️ ML requires every variation of an item to combine the SAME attributes
 * ("você deve carregar o mesmo para todas as variações" — the Variações guide),
 * and it rejects the whole item when they diverge. `storedCombinations` exists
 * only for a child that already has a `variacaoMercadoLivre` link, so a child
 * added in the ERP after the listing was published has none — merging per-child
 * would hand ML `[SIZE, VOLTAGE]` for one sibling and `[SIZE]` for the next.
 *
 * So an attribute survives the republish only when EVERY child can supply a
 * value for it. Dropping it otherwise restores the pre-#797 behaviour for that
 * one attribute — the listing loses it, as before — which is strictly better
 * than a rejection that takes the whole item down with it.
 */
export function mergeableStoredKeys(variations: PublishVariationChild[]): Set<string> {
  if (variations.length === 0) return new Set();
  const perChild = variations.map(
    (c) =>
      new Set(
        (c.storedCombinations ?? [])
          .filter(storedIsValued)
          .map(combinationKey)
          .filter((k): k is string => k != null),
      ),
  );
  const [first, ...rest] = perChild;
  return new Set([...first!].filter((key) => rest.every((s) => s.has(key))));
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
 *
 * `allowedKeys` comes from {@link mergeableStoredKeys} and is what keeps the
 * merge item-wide-uniform; pass `null` only when there is genuinely one child.
 */
export function mergeStoredCombinations(
  derived: MlAttribute[],
  stored: MlAttribute[] | undefined,
  allowedKeys: ReadonlySet<string> | null = null,
): MlAttribute[] {
  if (!stored?.length) return derived;
  const seen = new Set(derived.map(combinationKey).filter((k): k is string => k != null));
  const out = [...derived];
  for (const attr of stored) {
    const key = combinationKey(attr);
    if (key == null || seen.has(key)) continue;
    if (allowedKeys != null && !allowedKeys.has(key)) continue;
    if (!storedIsValued(attr)) continue; // valueless: nothing to send
    seen.add(key);
    out.push(attr);
  }
  return out;
}

/**
 * The two things ML judges about `attribute_combinations` ACROSS variations, and
 * which no per-child check can see (#797 E8 review):
 *
 *  1. every variation must expose the same set of combination keys — a divergent
 *     sibling rejects the whole item;
 *  2. at most ONE id-less custom characteristic may drive the product, counted
 *     over the union. Two children each varying by a different single custom
 *     ("Sabor" here, "Estampa" there) pass any per-child count while the item
 *     varies by two.
 *
 * Raises at most one issue per rule, naming the divergence — a per-child message
 * would repeat itself once per variation on a six-colour produto.
 */
export function validateCombinationsAcrossChildren(
  variations: ReadonlyArray<{ nome: string; combos: MlAttribute[] }>,
  issues: string[],
): void {
  if (variations.length === 0) return;

  const keySets = variations.map((v) => ({
    nome: v.nome,
    keys: [...new Set(v.combos.map(combinationKey).filter((k): k is string => k != null))].sort(),
  }));
  const reference = keySets[0]!;
  const divergent = keySets.filter((k) => k.keys.join('|') !== reference.keys.join('|'));
  if (divergent.length > 0) {
    const fmt = (k: (typeof keySets)[number]) => `"${k.nome}" [${k.keys.join(', ') || '—'}]`;
    issues.push(
      `as variações não combinam os MESMOS atributos, e o Mercado Livre rejeita o anúncio ` +
        `inteiro nesse caso: ${fmt(reference)} vs ${divergent.map(fmt).join(', ')}. ` +
        `Preencha o atributo que falta em todas as variações.`,
    );
  }

  const customNames = [
    ...new Set(
      variations.flatMap((v) => v.combos.filter((c) => c.id == null).map((c) => c.name ?? '?')),
    ),
  ];
  if (customNames.length > 1) {
    issues.push(
      `o Mercado Livre aceita apenas UMA característica personalizada por produto, e este ` +
        `varia por ${customNames.length} (${customNames.map((n) => `"${n}"`).join(', ')}). ` +
        `Vincule os grupos a atributos do ML ou reduza a um só.`,
    );
  }
}

/**
 * Assemble the full `buildItemPayload` input — or throw
 * `MercadoLivrePublishError` listing every blocking issue at once.
 */
export function assemblePublishInput(args: AssemblePublishArgs): BuildItemPayloadInput {
  const issues: string[] = [];

  if (!args.produto.nome?.trim()) issues.push('produto sem nome');
  const price = resolvePrice(
    args.produto,
    { id: args.priceListId, nome: args.priceListNome },
    issues,
  );
  const isUpdate = args.link?.id != null;
  // ⚠️ A User-Products FAMILY needs both unconditionally, however published the
  // listing already is: `isUpdate` there says the FAMILY exists, and a family
  // that gains a variation still POSTs that member as a brand-new item. Letting
  // the create-only rule stand would send that POST with no category and earn a
  // 400 the operator cannot read. (Both are written back on every publish, so
  // for an established family this costs nothing.)
  const memberCreatePossible = args.isUserProductSeller && args.variations.length > 0;
  if ((!isUpdate || memberCreatePossible) && !args.categoryId) {
    issues.push('categoria do Mercado Livre não definida (category_id)');
  }
  if ((!isUpdate || memberCreatePossible) && !args.listingTypeId) {
    issues.push('tipo de anúncio não definido (listing_type_id)');
  }
  if (args.pictures.length === 0) issues.push('produto sem fotos');

  // Only stored attributes EVERY child can supply may be merged, or the
  // republish hands ML variations with divergent combination sets.
  const mergeable = mergeableStoredKeys(args.variations);

  const variations: ItemVariationInput[] = args.variations.map((child) => {
    const combos = mergeStoredCombinations(
      combinationsFromVariacoes(child.variacoesUid, args.grupos, child.produto.nome, issues),
      child.storedCombinations,
      mergeable,
    );
    // ⚠️ A User-Products family of EXACTLY ONE member has nothing to vary, so it
    // legitimately carries no combination — ML identifies the sole member by its
    // own item id, not by an attribute. That is the shape the IMPORTER already
    // writes for a UP single (`mapUpMemberToImport` over an empty
    // `attribute_combinations` yields `combos: []`), and publish has to produce
    // the same one. With TWO OR MORE members it stays a blocking issue: ML cannot
    // tell siblings apart without a combination, so they would collapse together.
    if (combos.length === 0 && !(args.isUserProductSeller && args.variations.length === 1)) {
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
      // User-Products only (the legacy branch ignores it and copies the
      // anchor's price down — ML requires a uniform family price there). Same
      // rule `precoPlan.buildPrecoDrafts` applies, so publish and the price
      // sync cannot disagree about what a member should cost. Resolved only in
      // the branch that uses it: a child with no own `precos` entry is a
      // blocking issue there and irrelevant everywhere else.
      price:
        args.isUserProductSeller && args.produto.propagatePriceToChildren === false
          ? resolvePrice(child.produto, { id: args.priceListId, nome: args.priceListNome }, issues)
          : null,
      pictureIds: child.pictureIds,
      attributeCombinations: finalCombos,
      attributes: attrs,
    };
  });

  validateCombinationsAcrossChildren(
    variations.map((v, i) => ({
      nome: args.variations[i]!.produto.nome,
      combos: [...v.attributeCombinations],
    })),
    issues,
  );

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
    shippingMode: args.shippingMode ?? null,
  };
}
