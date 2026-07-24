/**
 * Pure assembly for the product-IMPORT flow (ML→ERP): turns a normalized
 * `MappedMlItem` (from the plugin's `importItem` mapper) + the existing Firestore
 * docs into the write plan `import.ts` executes. No IO here — the decisions
 * (create vs fill-nulls update, which options gate stock/price, the link-doc
 * wire shape) live here so they're unit-testable.
 *
 * Ported semantics from the legacy `cadastrarOuAtualizarProdutoMercadoLivre`,
 * with Lucas's option overrides:
 *  - a re-import PRESERVES the ERP produto — parent fields are filled only where
 *    they're currently null (never overwritten); `nome`/kit flags are never
 *    touched on update (the legacy `oldProduto?.x ?? new`);
 *  - stock: create when absent (`importarEstoque`); overwrite ONLY when
 *    `sobrescreverEstoque` (default FALSE — never clobber ERP stock);
 *  - price: written on create (`importarPreco`) or overwrite (`sobrescreverPreco`);
 *  - the produto-field update is gated by `atualizarProdutoPai`
 *    (`completarDadosProdutoPai`).
 */
import type {
  MappedMlItem,
  MappedMlVariation,
  MlItemAttribute,
} from '@delfrance/integrations-mercado-livre';
import { CONDICAO_PRODUTO, makeEstoqueUid, toOuterRef } from '@delfrance/schemas';
import type { TaxonomiaResolution } from './taxonomiaCore';

/** Import blocked by unusable item data — maps to HTTP 422. */
export class MercadoLivreImportError extends Error {
  constructor(readonly issues: string[]) {
    super(`Importação bloqueada: ${issues.join('; ')}`);
    this.name = 'MercadoLivreImportError';
  }
}

/**
 * Import behavior flags — the ported `PreferenciasProdutoMercadoLivre`. NOT
 * persisted (the webhook never imports, so there's no stored-prefs need); passed
 * per-call and surfaced as modal toggles.
 */
export interface ImportOptions {
  importarEstoque: boolean;
  /** Default FALSE (Lucas) — a re-import never clobbers ERP stock. */
  sobrescreverEstoque: boolean;
  importarPreco: boolean;
  sobrescreverPreco: boolean;
  /** `completarDadosProdutoPai` — fill the produto's null fields on re-import. */
  atualizarProdutoPai: boolean;
  /** Import the listing's photos (additive, high-quality — #439). */
  importarFotos: boolean;
  /** Create/link the ERP Categoria chain from the ML category (#442). */
  importarCategorias: boolean;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  importarEstoque: true,
  sobrescreverEstoque: false,
  importarPreco: true,
  sobrescreverPreco: true,
  atualizarProdutoPai: true,
  importarFotos: true,
  importarCategorias: true,
};

export interface ImportAssembleArgs {
  mapped: MappedMlItem;
  options: ImportOptions;
  produtoId: string;
  isCreate: boolean;
  linkDocId: string;
  integracaoId: string;
  /** Price-list ids (last segment of the integração's tabela refs). */
  tabelaNormalId: string | null;
  tabelaPromoId: string | null;
  /** Where to write stock (integração's depósito); null → stock skipped. */
  depositoOuterRef: string | null;
  /** ML plain-text description (best-effort; truncated to the schema limit). */
  descricao: string | null;
  /** Leaf ERP Categoria outer-ref resolved from the ML category chain (#442); null = skip. */
  categoriaOuterRef: string | null;
  /**
   * True when the ML item has `variations[]` (#520). Parent stock lives on the
   * CHILDREN in that case, so the estoque plan below is always skipped for the
   * parent — see `assembleVariationChildPlan` for the per-child stock write.
   */
  hasVariations: boolean;
  /**
   * Parent-level taxonomy links derived from the resolved variation combos
   * (unique, IO-deduped) — null when the item has no variations. Legacy never
   * touches these on the PARENT doc (only children carry them); Lucas's D2
   * deviation backfills the parent too, fill-only (see the update path below).
   */
  parentGrupoUids: string[] | null;
  parentVariacoesUid: string[] | null;
  /** Existing raw docs (spread/fill-nulls). Null on create. */
  existingProduto: Record<string, unknown> | null;
  existingLinkRaw: Record<string, unknown> | null;
  existingExtra: Record<string, unknown> | null;
  /** Existing stock (quantidade/reservada) for the depósito (null when absent). */
  existingEstoqueQty: number | null;
  existingEstoqueReservada: number | null;
  now: number;
}

export interface ImportPlan {
  produtoId: string;
  /** Produto write: `full` set on create, merge patch on update; null = skip. */
  produto: { data: Record<string, unknown>; full: boolean } | null;
  /**
   * Price-list writes for the integração's tabelas, applied by IO via dotted-path
   * `update` on the UPDATE path — so the whole (possibly legacy-malformed) precos
   * map isn't re-validated, and a promo that ended on ML is actively cleared.
   * Null on create (folded into the full produto doc instead).
   */
  precosOps: { set: Record<string, { valor: number }>; delete: string[] } | null;
  /** extraData merge patch (condicao/descricao); null = skip. */
  extra: Record<string, unknown> | null;
  /** Stock write; null = skip (option off, no depósito, or overwrite disabled). */
  estoque: { docId: string; data: Record<string, unknown> } | null;
  /** The `produtoMercadoLivre` link doc (full set, spread-existing). */
  link: Record<string, unknown>;
  /** ML item id, for the dual-run `arrayUnion` denorm (applied by IO). */
  denormItemId: string;
}

/** extraData.descricao is capped at 3000 chars (`produtoExtraDataSchema`). */
const DESCRICAO_MAX = 3000;

/**
 * produto.nome is capped at 100 chars (`produtoSchema`). A composed variation
 * child nome (title + value names) can exceed it — ML titles alone go up to 60.
 */
const PRODUTO_NOME_MAX = 100;

function firstNonEmpty(...vals: Array<unknown>): number | null {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/**
 * Price-list writes for the integração's tabelas: set the normal price, set the
 * promo when active, and CLEAR (`delete`) a promo that ended on ML (`precoPromocional`
 * null) — otherwise a stale promo would linger despite `sobrescreverPreco`. Returns
 * null when the price write is disabled or there's no usable normal price.
 */
function buildPrecosOps(
  args: ImportAssembleArgs,
): { set: Record<string, { valor: number }>; delete: string[] } | null {
  const { mapped, options, isCreate, tabelaNormalId, tabelaPromoId } = args;
  const write = isCreate ? options.importarPreco : options.sobrescreverPreco;
  if (!write || !tabelaNormalId || mapped.precoNormal == null || mapped.precoNormal <= 0) {
    return null;
  }
  const set: Record<string, { valor: number }> = {
    [tabelaNormalId]: { valor: mapped.precoNormal },
  };
  const del: string[] = [];
  if (tabelaPromoId) {
    if (mapped.precoPromocional != null && mapped.precoPromocional > 0) {
      set[tabelaPromoId] = { valor: mapped.precoPromocional };
    } else {
      del.push(tabelaPromoId); // deal ended → clear the stale promo (never re-validated)
    }
  }
  return { set, delete: del };
}

export function assembleImportPlan(args: ImportAssembleArgs): ImportPlan {
  const { mapped, options, isCreate, existingProduto, existingExtra, now } = args;

  const issues: string[] = [];
  if (!mapped.nome) issues.push(`item ${mapped.mlItemId} sem título`);
  if (issues.length > 0) throw new MercadoLivreImportError(issues);

  const precosOps = buildPrecosOps(args);

  // ---- produto ----------------------------------------------------------
  let produto: { data: Record<string, unknown>; full: boolean } | null = null;
  if (isCreate) {
    produto = {
      full: true,
      data: {
        nome: mapped.nome,
        sku: mapped.sku,
        paiId: null,
        publicado: true,
        ehKit: mapped.ehKit,
        ehUsado: mapped.ehUsado,
        pesoLiquidoKg: mapped.pesoLiquidoKg,
        pesoBrutoKg: mapped.pesoBrutoKg,
        alturaCm: mapped.alturaCm,
        larguraCm: mapped.larguraCm,
        profundidadeCm: mapped.profundidadeCm,
        // On create there's nothing to clear — fold the price writes into the doc.
        precos: precosOps ? precosOps.set : null,
        categoriaProdutoOuterRef: args.categoriaOuterRef,
        // D2 (#520): parent taxonomy links — null unless the item has variations.
        grupoDeVariacoesUid: (args.parentGrupoUids?.length ?? 0) > 0 ? args.parentGrupoUids : null,
        variacoesUid: (args.parentVariacoesUid?.length ?? 0) > 0 ? args.parentVariacoesUid : null,
        timestamp: now,
      },
    };
  } else {
    // Update: fill-nulls only — never overwrite existing ERP data (dual-run).
    // Prices are NOT in this patch (see precosOps) so the legacy precos map is
    // never re-validated. Every field here fills only a currently-null value.
    const patch: Record<string, unknown> = {};
    if (options.atualizarProdutoPai) {
      const fillNull = (key: keyof MappedMlItem & string, value: unknown) => {
        if ((existingProduto?.[key] ?? null) == null && value != null) patch[key] = value;
      };
      fillNull('sku', mapped.sku);
      fillNull('pesoLiquidoKg', mapped.pesoLiquidoKg);
      fillNull('pesoBrutoKg', mapped.pesoBrutoKg);
      fillNull('alturaCm', mapped.alturaCm);
      fillNull('larguraCm', mapped.larguraCm);
      fillNull('profundidadeCm', mapped.profundidadeCm);
      // publicado is fill-null too — never re-expose a produto the user hid.
      if ((existingProduto?.publicado ?? null) == null) patch.publicado = true;
    }
    // Category fill-null: its own gate is importarCategorias upstream (import.ts only
    // resolves categoriaOuterRef when the option is on), NOT atualizarProdutoPai — so
    // this runs even when the produto-field update above is skipped. Never clobbers a
    // manually-set ERP category.
    const categoriaJaDefinida = (existingProduto?.categoriaProdutoOuterRef ?? null) != null;
    if (!categoriaJaDefinida && args.categoriaOuterRef != null) {
      patch.categoriaProdutoOuterRef = args.categoriaOuterRef;
    }
    // D2 (#520): same fill-only rationale as categoriaProdutoOuterRef above, but for
    // NULL-OR-EMPTY (a produto created before variation import has `[]`/null, not a
    // populated array) — never overwrites links the user or a prior import already set.
    const fillEmptyArray = (
      key: 'grupoDeVariacoesUid' | 'variacoesUid',
      value: string[] | null,
    ) => {
      const existing = existingProduto?.[key];
      const isEmpty = existing == null || (Array.isArray(existing) && existing.length === 0);
      if (isEmpty && value != null && value.length > 0) patch[key] = value;
    };
    fillEmptyArray('grupoDeVariacoesUid', args.parentGrupoUids);
    fillEmptyArray('variacoesUid', args.parentVariacoesUid);
    produto = Object.keys(patch).length > 0 ? { data: patch, full: false } : null;
  }

  // ---- extraData (condicao + best-effort descricao) ---------------------
  let extra: Record<string, unknown> | null = null;
  const extraPatch: Record<string, unknown> = {};
  const condicao = mapped.ehUsado ? CONDICAO_PRODUTO.usado : CONDICAO_PRODUTO.novo;
  if (isCreate) extraPatch.condicao = condicao;
  const descricao = args.descricao?.slice(0, DESCRICAO_MAX) ?? null;
  if (descricao && (existingExtra?.descricao ?? null) == null) extraPatch.descricao = descricao;
  if (Object.keys(extraPatch).length > 0) extra = extraPatch;

  // ---- stock ------------------------------------------------------------
  // #520: when the item has variations, stock lives on the CHILDREN (each variation
  // is its own estoque doc) — the parent never gets a stock write, regardless of the
  // import options. See `assembleVariationChildPlan` for the per-child equivalent.
  let estoque: { docId: string; data: Record<string, unknown> } | null = null;
  if (!args.hasVariations) {
    const depositoId = args.depositoOuterRef ? lastSegment(args.depositoOuterRef) : null;
    const exists = args.existingEstoqueQty != null;
    const writeStock =
      args.depositoOuterRef != null &&
      depositoId != null &&
      (exists ? options.sobrescreverEstoque : options.importarEstoque);
    if (writeStock) {
      // ML `available_quantity` is the BUYABLE count → ERP `disponivel`. Since
      // `disponivel = quantidade - reservada`, an overwrite of a stock that already
      // has reservations must add them back into `quantidade`, or the ERP would show
      // fewer available than ML. On create reservada is 0.
      const reservada = exists ? (args.existingEstoqueReservada ?? 0) : 0;
      estoque = {
        docId: makeEstoqueUid(args.produtoId, depositoId!),
        data: {
          parentId: args.produtoId,
          depositoOuterRef: toOuterRef(`depositos/${depositoId}`),
          quantidade: mapped.availableQuantity + reservada,
          ultimaModificacao: now,
          ...(exists ? {} : { dataCriacao: now }),
        },
      };
    }
  }

  // ---- produtoMercadoLivre link (spread existing → stamp) ----------------
  const existingLink = args.existingLinkRaw ?? {};
  const link: Record<string, unknown> = {
    ...existingLink,
    contaOuterRef:
      (existingLink.contaOuterRef as string | undefined) ??
      toOuterRef(`integracao/${args.integracaoId}`),
    id: mapped.mlItemId,
    sku: mapped.sku,
    title: mapped.nome,
    category_id: mapped.categoryId,
    condition: mapped.condition,
    listing_type_id: mapped.listingTypeId,
    estado: mapped.estado,
    status: mapped.status,
    sub_status: mapped.subStatus,
    freteGratis: mapped.freteGratis,
    precoPublicado: firstNonEmpty(mapped.precoPromocional, mapped.precoNormal),
    isUserProductModel: mapped.isUserProductModel,
    video_id: mapped.videoId,
    attributes: mapped.attributes,
    errors: [],
    ultimaModificacao: now,
    dataCadastro: (existingLink.dataCadastro as number | undefined) ?? now,
  };

  return {
    produtoId: args.produtoId,
    produto,
    precosOps: isCreate ? null : precosOps,
    extra,
    estoque,
    link,
    denormItemId: mapped.mlItemId,
  };
}

function lastSegment(ref: string): string {
  const parts = ref.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? ref;
}

/* -------------------------------------------------------------------------- */
/*                     Variation children (#520)                              */
/* -------------------------------------------------------------------------- */

/**
 * Pure assembly for one variation CHILD produto — the counterpart to
 * `assembleImportPlan` for `hasVariations` items. One call per
 * `MappedMlVariation`; the IO layer (`importVariations.ts`) resolves the
 * existing child (link → SKU) and loops this over every usable variation.
 *
 * Ported semantics (`.old/packages/canais_de_venda/mercado_livre/lib/src/utils/produtos.dart`
 * + `models.dart`, see the issue #520 design notes):
 *  - `nome`/`sku`/`ehKit`/`ehUsado` mirror the parent per legacy `produtos.dart:284-290`;
 *  - price is NEVER set per-variation on ML — a child always copies the parent's
 *    WHOLE `precos` map (`importarPreco` on create, `sobrescreverPreco` on
 *    update), never the tabela-scoped `precosOps` machinery;
 *  - dims/categoria are copied from the parent only under `atualizarProdutoPai`
 *    (the legacy `completarDadosProdutoPai` / `getData` gate), same as sku/
 *    publicado/taxonomy links are NOT gated by it (those always fill-null);
 *  - the `variacaoMercadoLivre` link doc's wire shape is the OLD Flutter
 *    `VariacoesML` shape verbatim — `variacaoMercadoLivreLinkCollection` parses it.
 *
 * User-Products mode (#521, `args.up`): a User-Products family member is its
 * OWN MLB item — there's no numeric ML "variation id" the way `variations[]`
 * has one. The `up` flag swaps only the `variacaoMercadoLivre` link's identity
 * fields (`itemId` set to the member's MLB id, numeric `id` never stamped) and
 * adds the dual-run `relevantData.isUserProductModel` marker to the denorm
 * entry — every other field (sku, nome, precos, dims/categoria, taxonomy) is
 * assembled identically to the #520 `variations[]` path.
 */
export interface VariationChildAssembleArgs {
  mappedVariation: MappedMlVariation;
  /** Every resolved taxonomy entry for the item; filtered here to this variation's combos. */
  taxonomia: readonly TaxonomiaResolution[];
  parent: {
    produtoId: string;
    precos: Record<string, unknown> | null;
    /** Canonical `documents/produtos/<id>/produtoMercadoLivre/<linkDocId>` outer-ref. */
    linkOuterRef: string;
    mlItemId: string;
    ehKit: boolean;
    ehUsado: boolean;
    categoriaOuterRef: string | null;
    dims: {
      pesoLiquidoKg: number | null;
      pesoBrutoKg: number | null;
      alturaCm: number | null;
      larguraCm: number | null;
      profundidadeCm: number | null;
    };
  };
  options: ImportOptions;
  /** The CHILD produto's own id (distinct from `parent.produtoId`). */
  produtoId: string;
  isCreate: boolean;
  linkDocId: string;
  integracaoId: string;
  depositoOuterRef: string | null;
  existingProduto: Record<string, unknown> | null;
  existingLinkRaw: Record<string, unknown> | null;
  existingEstoqueQty: number | null;
  existingEstoqueReservada: number | null;
  now: number;
  /**
   * User-Products import (#521): when set, this child's `variacaoMercadoLivre`
   * link is keyed by the member's own ML **itemId** (its own MLB id) instead of
   * a numeric ML variation id — User-Products members have none. `null` = the
   * #520 `variations[]` behavior (numeric `id` derived from `variationId`,
   * `itemId` preserved-or-null).
   */
  up: { itemId: string } | null;
}

export interface VariationChildPlan {
  /** Child produto write: `full` on create, merge patch on update; null = skip. */
  produto: { data: Record<string, unknown>; full: boolean } | null;
  /** Child stock write; null = skip (option off, no depósito, or overwrite disabled). */
  estoque: { docId: string; data: Record<string, unknown> } | null;
  /** The `variacaoMercadoLivre` link doc (full set, spread-existing). */
  link: Record<string, unknown>;
  /**
   * Dual-run `marketplace`/`marketplaceIds` denorm entry (applied by IO).
   * `relevantData` is set ONLY in User-Products mode (#521) — the parity
   * marker (`isUserProductModel: true`) that must byte-match Flutter's
   * `ProdMarketplace.relevantData` (`includeIfNull: false`, so it's simply
   * absent — not `undefined` — outside UP mode).
   */
  denorm: { externalId: string; externalParentId: string; relevantData?: Record<string, unknown> };
}

/**
 * Same `attrKey` formula as `taxonomiaCore.planTaxonomia` — `(id ?? name) + '|' +
 * (value_id ?? value_name)` — used here ONLY to filter the item-wide `taxonomia`
 * array down to this variation's own combos. Must stay identical to the
 * taxonomy resolver's formula or a resolved grupo/variante silently drops off
 * the child instead of linking.
 */
function comboAttrKey(combo: MlItemAttribute): string {
  return `${combo.id ?? combo.name ?? ''}|${combo.value_id ?? combo.value_name ?? ''}`;
}

/** `"123"` → `123`; anything not a plain (optionally signed) integer string → `null`. */
function numericVariationId(id: string): number | null {
  return /^-?\d+$/.test(id) ? Number(id) : null;
}

/**
 * One `attribute_combinations` entry → the link doc's embedded wire shape; null
 * when it has no id (the wire schema requires one). Null-valued keys are OMITTED,
 * not written as explicit nulls — legacy `AttributesMLNew` serializes with
 * `@JsonKey(includeIfNull: false)`, so Flutter-written entries lack them.
 */
function comboToWireAttribute(combo: MlItemAttribute): Record<string, unknown> | null {
  if (!combo.id) return null;
  const wire: Record<string, unknown> = { id: combo.id };
  if (combo.name != null) wire.name = combo.name;
  if (combo.value_id != null) wire.value_id = combo.value_id;
  if (combo.value_name != null) wire.value_name = combo.value_name;
  if (combo.attribute_group_id != null) wire.attribute_group_id = combo.attribute_group_id;
  if (combo.attribute_group_name != null) wire.attribute_group_name = combo.attribute_group_name;
  return wire;
}

export function assembleVariationChildPlan(args: VariationChildAssembleArgs): VariationChildPlan {
  const { mappedVariation, taxonomia, parent, options, isCreate, existingProduto, now } = args;

  // This variation's own resolved taxonomy — the item-wide `taxonomia` array covers
  // every variation's combos, so filter to the ones this variation actually has.
  const comboKeys = new Set(mappedVariation.combos.map(comboAttrKey));
  const matched = taxonomia.filter((t) => comboKeys.has(t.attrKey));
  const grupoUidsSet = [...new Set(matched.map((t) => t.grupoUid))];
  const varianteFakesSet = [...new Set(matched.map((t) => t.varianteFake))];
  const grupoUids = grupoUidsSet.length > 0 ? grupoUidsSet : null;
  const varianteFakes = varianteFakesSet.length > 0 ? varianteFakesSet : null;

  // ---- produto ------------------------------------------------------------
  let produto: { data: Record<string, unknown>; full: boolean } | null = null;
  if (isCreate) {
    produto = {
      full: true,
      data: {
        nome: mappedVariation.nome.slice(0, PRODUTO_NOME_MAX),
        sku: mappedVariation.sku,
        paiId: parent.produtoId,
        publicado: true,
        ehKit: parent.ehKit,
        ehUsado: parent.ehUsado,
        // ML forbids per-variation prices — the child always mirrors the parent's
        // WHOLE precos map (legacy `produtos.dart:284-290`), gated the same as the
        // parent's own create-time price write.
        precos: options.importarPreco ? parent.precos : null,
        grupoDeVariacoesUid: (grupoUids?.length ?? 0) > 0 ? grupoUids : null,
        variacoesUid: (varianteFakes?.length ?? 0) > 0 ? varianteFakes : null,
        // Legacy `completarDadosProdutoPai`/`getData` gate — dims/categoria only
        // copy onto the child when the option is on (sku/publicado/taxonomy above
        // are NOT gated by it, they always fill).
        ...(options.atualizarProdutoPai
          ? {
              pesoLiquidoKg: parent.dims.pesoLiquidoKg,
              pesoBrutoKg: parent.dims.pesoBrutoKg,
              alturaCm: parent.dims.alturaCm,
              larguraCm: parent.dims.larguraCm,
              profundidadeCm: parent.dims.profundidadeCm,
              categoriaProdutoOuterRef: parent.categoriaOuterRef,
            }
          : {}),
        timestamp: now,
      },
    };
  } else {
    const patch: Record<string, unknown> = {};
    const fillNull = (key: string, value: unknown) => {
      if ((existingProduto?.[key] ?? null) == null && value != null) patch[key] = value;
    };
    fillNull('sku', mappedVariation.sku);
    if ((existingProduto?.publicado ?? null) == null) patch.publicado = true;

    // Fill-null-OR-EMPTY (never overwrite a non-empty array) — same D2 rationale as
    // the parent's own fill in `assembleImportPlan`.
    const fillEmptyArray = (key: string, value: string[] | null) => {
      const existing = existingProduto?.[key];
      const isEmpty = existing == null || (Array.isArray(existing) && existing.length === 0);
      if (isEmpty && value != null && value.length > 0) patch[key] = value;
    };
    fillEmptyArray('grupoDeVariacoesUid', grupoUids);
    fillEmptyArray('variacoesUid', varianteFakes);

    if (options.atualizarProdutoPai) {
      fillNull('pesoLiquidoKg', parent.dims.pesoLiquidoKg);
      fillNull('pesoBrutoKg', parent.dims.pesoBrutoKg);
      fillNull('alturaCm', parent.dims.alturaCm);
      fillNull('larguraCm', parent.dims.larguraCm);
      fillNull('profundidadeCm', parent.dims.profundidadeCm);
      fillNull('categoriaProdutoOuterRef', parent.categoriaOuterRef);
    }

    // Precos bypass the dotted-path precosOps machinery entirely here: since ML never
    // carries per-variation prices, a re-import always mirrors the parent's WHOLE precos
    // map onto the child (legacy `Produto.copyWith`-whole-doc-save parity) instead of
    // patching individual tabela keys the way the parent's own precosOps does.
    if (options.sobrescreverPreco) patch.precos = parent.precos;

    produto = Object.keys(patch).length > 0 ? { data: patch, full: false } : null;
  }

  // ---- estoque --------------------------------------------------------------
  // Same rules as the parent's (non-variation) stock section — create when absent
  // + importarEstoque; overwrite only under sobrescreverEstoque, adding reservada
  // back so `disponivel` still matches ML — but keyed to the CHILD's own produtoId
  // and quantity.
  let estoque: { docId: string; data: Record<string, unknown> } | null = null;
  const depositoId = args.depositoOuterRef ? lastSegment(args.depositoOuterRef) : null;
  const exists = args.existingEstoqueQty != null;
  const writeStock =
    args.depositoOuterRef != null &&
    depositoId != null &&
    (exists ? options.sobrescreverEstoque : options.importarEstoque);
  if (writeStock) {
    const reservada = exists ? (args.existingEstoqueReservada ?? 0) : 0;
    estoque = {
      docId: makeEstoqueUid(args.produtoId, depositoId!),
      data: {
        parentId: args.produtoId,
        depositoOuterRef: toOuterRef(`depositos/${depositoId}`),
        quantidade: mappedVariation.availableQuantity + reservada,
        ultimaModificacao: now,
        ...(exists ? {} : { dataCriacao: now }),
      },
    };
  }

  // ---- variacaoMercadoLivre link (spread existing → stamp the EXACT legacy wire) --
  const existingLink = args.existingLinkRaw ?? {};
  const link: Record<string, unknown> = {
    ...existingLink,
    // #520 variations[]: numeric `id` derived from the ML variation id; `itemId`
    // is User-Products-only, so it's preserved-or-null (never stamped).
    // #521 User-Products: the member IS its own MLB item — `itemId` is stamped
    // from it; the numeric `id` field has nothing to derive from (a UP member's
    // "variationId" is its own MLB itemId, not a numeric ML variation id), so
    // it's preserved-or-null instead of ever being (re)computed here.
    id: args.up
      ? ((existingLink.id as number | null | undefined) ?? null)
      : numericVariationId(mappedVariation.variationId),
    itemId: args.up ? args.up.itemId : ((existingLink.itemId as string | null | undefined) ?? null),
    produtoVariacaoOuterRef: toOuterRef(`produtos/${args.produtoId}`),
    produtoMercadoLivreOuterRef: parent.linkOuterRef,
    // Deliberate deviation: legacy sourced this from attribute_combinations
    // (models.dart:1726), where SELLER_SKU never appears — so Flutter writes null.
    // The variation's real SELLER_SKU is strictly more useful, and link.sku is
    // not a dedup/query key (children resolve by the `id` field + produto sku).
    // D-C (#521): the SAME rule applies in User-Products mode — the child's sku
    // is always the member's own SELLER_SKU, never the parent's familyId.
    sku: mappedVariation.sku,
    attributes: mappedVariation.combos
      .map(comboToWireAttribute)
      .filter((a): a is Record<string, unknown> => a !== null),
  };

  return {
    produto,
    estoque,
    link,
    denorm: {
      externalId: mappedVariation.variationId,
      externalParentId: parent.mlItemId,
      ...(args.up ? { relevantData: { isUserProductModel: true } } : {}),
    },
  };
}
