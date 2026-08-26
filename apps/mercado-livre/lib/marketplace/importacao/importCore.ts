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
 *    touched on update (the legacy `oldProduto?.x ?? new`). ⚠️ Since #1087 the
 *    operator can opt OUT of that preservation for a narrow set of fields with
 *    `sobrescreverDadosProduto` — see its doc for exactly which, and which are
 *    deliberately left out;
 *  - `extraData.marca` is filled from the listing's `BRAND` (the import half of
 *    #1293), blank-only unless that same flag is set;
 *  - stock: create when absent (`importarEstoque`); overwrite ONLY when
 *    `sobrescreverEstoque` (default FALSE — never clobber ERP stock);
 *  - price: written on create (`importarPreco`) or overwrite (`sobrescreverPreco`);
 *  - the produto-field update is gated by `atualizarProdutoPai`
 *    (`completarDadosProdutoPai`).
 *
 * ⚠️ `moderacoes` (#1087) is SUPPLIED by the IO layer, never derived here. The
 * gate (`precisaConsultarModeracao` — in `@delfrance/schemas` since #1239, not in
 * this app), the 404-is-data narrow and the transient degrade all live outside
 * this file: the schema, `moderacoes.ts` and `import.ts` respectively. So this
 * module stays pure, and the importer, the `items` sync and `reverificarAnuncio`
 * cannot drift on any of them. All this file decides is WHERE the value lands in
 * the two link docs.
 */
import type {
  MappedMlItem,
  MappedMlVariation,
  MlItemAttribute,
} from '@delfrance/integrations-mercado-livre';
import {
  CONDICAO_PRODUTO,
  type MedidasDoPacote,
  type MlModeracao,
  makeEstoqueUid,
  marcaArmazenadaDe,
  reservaEfetiva,
  toOuterRef,
} from '@delfrance/schemas';
import type { TaxonomiaResolution } from './taxonomiaCore';
import { clearFalha } from '../core/publishFalhas';

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
  /**
   * Let a re-import REPLACE produto data the ERP already holds, instead of only
   * filling blanks. Default FALSE — a re-import must never silently overwrite
   * typed work, the same stance `sobrescreverEstoque` takes.
   *
   * ⚠️ Deliberately narrow. It covers exactly `sku`, the five dimension/weight
   * fields and `extraData.marca` — the fields an operator asked to be able to
   * refresh from the listing. It does NOT cover:
   *  - `descricao`, the most destructive thing to clobber here and not asked for;
   *  - `publicado`, which keeps its own carve-out (never re-expose a hidden produto);
   *  - `categoriaProdutoOuterRef`, gated by `importarCategorias` and documented as
   *    never clobbering a manually-set ERP category;
   *  - `nome`/`ehKit`/`ehUsado`, which stay create-only.
   * Widening it is a decision about someone's typed data, not a refactor.
   *
   * ⚠️ It also does NOT reach the child→parent dimension rollup
   * ({@link rollupDimensoesDosFilhos}), which is fill-blank-only by its own rule.
   */
  sobrescreverDadosProduto: boolean;
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
  sobrescreverDadosProduto: false,
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
  /**
   * The conta's tabela NORMAL id (last segment of `tabelaNormalOuterRef`).
   * There is deliberately no promo counterpart — see `buildPrecosOps` (#803).
   */
  tabelaNormalId: string | null;
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
  /**
   * Existing stock (quantidade/reservada) for the depósito (null when absent).
   *
   * ⚠️ `existingEstoqueReservada` comes from a raw `.data()` read and **may be
   * negative at rest** — nothing guarantees otherwise (#931). It is floored with
   * `reservaEfetiva` before it reaches the quantity; do not use it raw.
   */
  existingEstoqueQty: number | null;
  existingEstoqueReservada: number | null;
  /**
   * ML's ACTIVE moderations for this listing (#1087), read by the IO layer
   * BEFORE any write — `[]` means "asked, ML reported none", which is what a
   * listing whose own `status`/`sub_status` warrant no moderation gets for free,
   * with no ML call at all.
   *
   * ⚠️ `null` is a THIRD value and means **"never asked"** — a deliberate skip
   * (the mass import) or a `/moderations` call that failed. It makes the link
   * write OMIT the key entirely, so the create falls to the schema default and
   * an update keeps whatever was stored. Never collapse it to `[]`: on disk that
   * would be byte-identical to a healthy listing, i.e. recording "not moderated"
   * about a listing nobody asked about. The same three-valued contract
   * `applyMemberStatusAndFold` relies on.
   *
   * Required and deliberately NOT defaulted, exactly like `falhaPatch`'s
   * arguments next door: a default would be silently wrong at whichever call
   * site forgot it, and there is only one production caller to update.
   */
  moderacoes: MlModeracao[] | null;
  now: number;
}

export interface ImportPlan {
  produtoId: string;
  /** Produto write: `full` set on create, merge patch on update; null = skip. */
  produto: { data: Record<string, unknown>; full: boolean } | null;
  /**
   * Price-list write for the integração's tabela NORMAL, applied by IO via a
   * dotted-path `update` on the UPDATE path — so the whole (possibly
   * legacy-malformed) precos map isn't re-validated and sibling tabela keys are
   * provably untouched. Null on create (folded into the full produto doc
   * instead). Set-only: nothing here ever deletes a price key (#803).
   */
  precosOps: { set: Record<string, { valor: number }> } | null;
  /** extraData merge patch (condicao/descricao); null = skip. */
  extra: Record<string, unknown> | null;
  /** Stock write; null = skip (option off, no depósito, or overwrite disabled). */
  estoque: { docId: string; data: Record<string, unknown> } | null;
  /** The `produtoMercadoLivre` link doc (full set, spread-existing). */
  link: Record<string, unknown>;
  /** ML item id, for the legacy `arrayUnion` denorm (applied by IO). */
  denormItemId: string;
}

/** extraData.descricao is capped at 3000 chars (`produtoExtraDataSchema`). */
const DESCRICAO_MAX = 3000;

/**
 * extraData.marca is capped at 255 chars (`produtoExtraDataSchema`).
 *
 * ⚠️ Matched to the SCHEMA, not to a nearby constant. A cap borrowed from an
 * unrelated bound is how #1068 made valid saved records 400 on every click.
 */
const MARCA_MAX = 255;

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
 * Price-list write for the integração's tabela NORMAL — the conta's
 * `tabelaNormalOuterRef` entry, and nothing else. Returns null when the price
 * write is disabled (`importarPreco` on create / `sobrescreverPreco` on update)
 * or there's no usable normal price.
 *
 * ⚠️ The **promotional** tabela is deliberately NOT written here (#803, owner
 * decision 2026-08-06). `tabelaPromocionalOuterRef` belongs to promotions the
 * user authors in the ERP — `RecalcularPrecosCanalAction` already offers it as
 * a formula-recalculation target — so an ML deal must not land in it, and the
 * `FieldValue.delete()` that used to clear it when a deal ended is gone with
 * the write that motivated it. `precoPublicado` on the ML LINK doc still
 * carries the promo (that is a denorm of "the price live on ML", not a price
 * table). Do not reintroduce a promo branch: the ERP owns both tabelas.
 */
function buildPrecosOps(
  args: ImportAssembleArgs,
): { set: Record<string, { valor: number }> } | null {
  const { mapped, options, isCreate, tabelaNormalId } = args;
  const write = isCreate ? options.importarPreco : options.sobrescreverPreco;
  if (!write || !tabelaNormalId || mapped.precoNormal == null || mapped.precoNormal <= 0) {
    return null;
  }
  return { set: { [tabelaNormalId]: { valor: mapped.precoNormal } } };
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
        ultimaModificacao: now,
      },
    };
  } else {
    // Update: fill-nulls only — never overwrite existing ERP data (legacy parity).
    // Prices are NOT in this patch (see precosOps) so the legacy precos map is
    // never re-validated. Every field here fills only a currently-null value.
    const patch: Record<string, unknown> = { ultimaModificacao: now };
    if (options.atualizarProdutoPai) {
      // Fill a blank field always; replace a filled one only under
      // `sobrescreverDadosProduto` (see its doc for what it deliberately omits).
      // A null `value` never lands either way — ML not reporting a field is not
      // an instruction to erase the ERP's copy of it.
      const fill = (key: keyof MappedMlItem & string, value: unknown) => {
        const vazio = (existingProduto?.[key] ?? null) == null;
        if ((vazio || options.sobrescreverDadosProduto) && value != null) patch[key] = value;
      };
      fill('sku', mapped.sku);
      fill('pesoLiquidoKg', mapped.pesoLiquidoKg);
      fill('pesoBrutoKg', mapped.pesoBrutoKg);
      fill('alturaCm', mapped.alturaCm);
      fill('larguraCm', mapped.larguraCm);
      fill('profundidadeCm', mapped.profundidadeCm);
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

  // ---- extraData (condicao + best-effort descricao + marca) -------------
  let extra: Record<string, unknown> | null = null;
  const extraPatch: Record<string, unknown> = {};
  const condicao = mapped.ehUsado ? CONDICAO_PRODUTO.usado : CONDICAO_PRODUTO.novo;
  if (isCreate) extraPatch.condicao = condicao;
  const descricao = args.descricao?.slice(0, DESCRICAO_MAX) ?? null;
  if (descricao && (existingExtra?.descricao ?? null) == null) extraPatch.descricao = descricao;

  // The listing's `BRAND` → the produto's Marca — the IMPORT half of #1293,
  // which built only the ERP→ML direction. The value is already on hand: the
  // import keeps `BRAND` on `link.attributes` verbatim (it is `herdado`, not
  // `derivado`, so `attributesFromItem` never strips it), and that stored entry
  // is exactly what `resolveMarcaAnuncio` falls back to. All that was missing was
  // the copy onto the produto.
  //
  // ⚠️ Read through `marcaArmazenadaDe`, the SAME helper publish uses, never by
  // hand. It is what turns ML's N/A sentinel (`value_id: '-1'`, whose
  // `value_name` is the literal string `'N/A'`) into "no brand" instead of a
  // brand literally named "N/A" — and #1293 extracted it precisely because two
  // hand-written copies of that rule drift.
  //
  // ⚠️ An absent BRAND writes NOTHING. Persisting the absence would let an
  // import that simply lost the attribute erase a Marca the operator typed —
  // and that Marca is the value the whole publish path now derives from.
  const { marca } = marcaArmazenadaDe(mapped.attributes);
  const marcaNova = marca?.trim().slice(0, MARCA_MAX) || null;
  const marcaExistente = typeof existingExtra?.marca === 'string' ? existingExtra.marca.trim() : '';
  if (marcaNova && (!marcaExistente || options.sobrescreverDadosProduto)) {
    extraPatch.marca = marcaNova;
  }
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
      //
      // ⚠️ `reservaEfetiva` is load-bearing, not defensive (#931). This is the
      // MIRROR IMAGE of ADR 0014 §7: there a negative reservation INVENTS stock by
      // being subtracted, here it DESTROYS stock by being added — a stored `-2`
      // would write `quantidade = availableQuantity - 2`, shrinking the ERP count
      // below ML's on every single re-import. The value arrives from `readEstoque`,
      // a bare Admin-SDK `.data()` read with no Zod and no floor, so a negative at
      // rest reaches this line verbatim.
      const reservada = exists ? reservaEfetiva(args.existingEstoqueReservada) : 0;
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
    // #706 multiorigem: the UP that backs THIS stock unit. Stamped ONLY when the
    // listing has no children, and that gate is the whole point — `args.mapped`
    // is one ML item, so under User Products it is one MEMBER of the family,
    // and its `user_product_id` on the FAMILY's parent link would be exactly the
    // "one member speaks for the family" mistake #1142 found in four places. The
    // members' ids live on their own `variacaoMercadoLivre` links. A legacy
    // `variations[]` listing is excluded for the same reason from the other
    // side: its stock units are the variations, so an item-level UP id here
    // would let one quantity be written for the whole family.
    userProductId: args.hasVariations ? null : mapped.userProductId,
    video_id: mapped.videoId,
    attributes: mapped.attributes,
    ...clearFalha(),
    // ML's policy verdict (#1087), in the SAME patch as the `status` it explains
    // — the invariant on `produtoMercadoLivreLinkSchema.moderacoes`.
    //
    // ⚠️ AFTER `...existingLink` is LOAD-BEARING: that spread is what carries a
    // stored moderation forward, so a value read on THIS run has to override it.
    // Without that, a re-import of a listing whose moderation ML has since
    // LIFTED keeps showing the old reason on a now-`active` anúncio — worse than
    // no reason at all, because a stale one is indistinguishable from a real one.
    //
    // ⚠️ AFTER `...clearFalha()` is structural insurance rather than a live
    // collision: `clearFalha()` carries no `moderacoes` today (a moderação is
    // ML's verdict, not our failed write), and this ordering — the same one
    // `itemsStatusSync` and `reverificarAnuncio` use — means it never can.
    //
    // ⚠️ A CONDITIONAL spread, not a plain key. `null` = "never asked" and must
    // leave the field alone; see the `moderacoes` docblock on the args above.
    ...(args.moderacoes != null ? { moderacoes: args.moderacoes } : {}),
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
 * adds the legacy `relevantData.isUserProductModel` marker to the denorm
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
  /** Same contract as the parent's: `existingEstoqueReservada` may be negative. */
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
  up: {
    itemId: string;
    status: string | null;
    subStatus: string[] | null;
    /**
     * This member's own ML `user_product_id` — the stock identity on a
     * multiorigin conta (#706). Only the UP path has one: an ML `variations[]`
     * entry carries no `user_product_id`, exactly like `itemId` above.
     */
    userProductId: string | null;
    /**
     * ML's active moderations on THIS member's own item (#1087), read by the IO
     * layer beside the `status`/`sub_status` they explain — moderation is per ML
     * item, and under User Products a member IS its own item.
     *
     * `null` = "never asked" and omits the write, exactly as on the parent's
     * {@link ImportAssembleArgs.moderacoes}.
     */
    moderacoes: MlModeracao[] | null;
  } | null;
}

export interface VariationChildPlan {
  /** Child produto write: `full` on create, merge patch on update; null = skip. */
  produto: { data: Record<string, unknown>; full: boolean } | null;
  /** Child stock write; null = skip (option off, no depósito, or overwrite disabled). */
  estoque: { docId: string; data: Record<string, unknown> } | null;
  /** The `variacaoMercadoLivre` link doc (full set, spread-existing). */
  link: Record<string, unknown>;
  /**
   * Legacy `marketplace`/`marketplaceIds` denorm entry (applied by IO).
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

/** One variation's own resolved taxonomy, in the produto wire shapes. */
export interface VariationCombo {
  /** `produto.grupoDeVariacoesUid` — bare grupo ids; null when nothing resolved. */
  grupoUids: string[] | null;
  /** `produto.variacoesUid` — variant fake paths; null when nothing resolved. */
  varianteFakes: string[] | null;
}

/**
 * Filter the item-wide `taxonomia` array (which covers EVERY variation's combos)
 * down to the ones this variation actually has, and project them onto the two
 * produto array fields.
 *
 * Exported because `resolveExistingChild` (`importVariations.ts`) needs this
 * variation's combination BEFORE the child produto is assembled, to look for an
 * ERP child already carrying it (#801). Both callers must derive it the same way
 * or the dedup would probe with a combination the write then contradicts — hence
 * one definition, not two.
 */
export function resolveVariationCombo(
  combos: readonly MlItemAttribute[],
  taxonomia: readonly TaxonomiaResolution[],
): VariationCombo {
  const comboKeys = new Set(combos.map(comboAttrKey));
  const matched = taxonomia.filter((t) => comboKeys.has(t.attrKey));
  const grupoUidsSet = [...new Set(matched.map((t) => t.grupoUid))];
  const varianteFakesSet = [...new Set(matched.map((t) => t.varianteFake))];
  return {
    grupoUids: grupoUidsSet.length > 0 ? grupoUidsSet : null,
    varianteFakes: varianteFakesSet.length > 0 ? varianteFakesSet : null,
  };
}

export function assembleVariationChildPlan(args: VariationChildAssembleArgs): VariationChildPlan {
  const { mappedVariation, taxonomia, parent, options, isCreate, existingProduto, now } = args;

  const { grupoUids, varianteFakes } = resolveVariationCombo(mappedVariation.combos, taxonomia);

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
        grupoDeVariacoesUid: grupoUids,
        variacoesUid: varianteFakes,
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
        ultimaModificacao: now,
      },
    };
  } else {
    const patch: Record<string, unknown> = { ultimaModificacao: now };
    const fillNull = (key: string, value: unknown) => {
      if ((existingProduto?.[key] ?? null) == null && value != null) patch[key] = value;
    };
    // The toggle-covered half — blanks always, filled values only under
    // `sobrescreverDadosProduto`. Kept beside `fillNull` rather than replacing it
    // because `categoriaProdutoOuterRef` below must stay fill-blank-only.
    const fill = (key: string, value: unknown) => {
      const vazio = (existingProduto?.[key] ?? null) == null;
      if ((vazio || options.sobrescreverDadosProduto) && value != null) patch[key] = value;
    };
    fill('sku', mappedVariation.sku);
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
      fill('pesoLiquidoKg', parent.dims.pesoLiquidoKg);
      fill('pesoBrutoKg', parent.dims.pesoBrutoKg);
      fill('alturaCm', parent.dims.alturaCm);
      fill('larguraCm', parent.dims.larguraCm);
      fill('profundidadeCm', parent.dims.profundidadeCm);
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
  // and quantity. The `reservaEfetiva` floor is required here for the same reason
  // it is required there (#931); this arm is not a lesser copy of it.
  let estoque: { docId: string; data: Record<string, unknown> } | null = null;
  const depositoId = args.depositoOuterRef ? lastSegment(args.depositoOuterRef) : null;
  const exists = args.existingEstoqueQty != null;
  const writeStock =
    args.depositoOuterRef != null &&
    depositoId != null &&
    (exists ? options.sobrescreverEstoque : options.importarEstoque);
  if (writeStock) {
    const reservada = exists ? reservaEfetiva(args.existingEstoqueReservada) : 0;
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
    // #706 multiorigem: same rule as `itemId` right above — a UP member has its
    // own `user_product_id`, a legacy `variations[]` entry has none to derive
    // from, so that half is preserved-or-null rather than ever computed here.
    userProductId: args.up
      ? args.up.userProductId
      : ((existingLink.userProductId as string | null | undefined) ?? null),
    produtoVariacaoOuterRef: toOuterRef(`produtos/${args.produtoId}`),
    produtoMercadoLivreOuterRef: parent.linkOuterRef,
    // #920: the conta, denormalized onto the child link the same way the parent
    // link has always carried it. Written unconditionally (it sits AFTER the
    // spread) so a re-import self-heals a row that predates the field. Without
    // it `onVariacaoMercadoLivreLinkChanged` would have to dereference
    // `produtoMercadoLivreOuterRef` on every event — a second read that yields
    // NOTHING once the parent link is gone, which is exactly when a variation
    // link is deleted (`pruneMigratedSource` drops both in one batch).
    contaOuterRef: toOuterRef(`integracao/${args.integracaoId}`),
    // Deliberate deviation: legacy sourced this from attribute_combinations
    // (models.dart:1726), where SELLER_SKU never appears — so Flutter writes null.
    // The variation's real SELLER_SKU is strictly more useful, and link.sku is
    // not a dedup/query key (children resolve by the `id` field + produto sku).
    // D-C (#521): the SAME rule applies in User-Products mode — the child's sku
    // is always the member's own SELLER_SKU, never the parent's familyId.
    sku: mappedVariation.sku,
    // #1142 User-Products: the member's OWN raw ML status, so a family's `estado`
    // can be a fold of its members rather than whichever one was imported. Legacy
    // `variations[]` members are not separate listings and have no status of their
    // own, so they keep whatever the spread carried (null).
    status: args.up ? args.up.status : ((existingLink.status as string | null | undefined) ?? null),
    sub_status: args.up
      ? args.up.subStatus
      : ((existingLink.sub_status as string[] | null | undefined) ?? null),
    // #1087 — physically adjacent to the two lines above because the invariant
    // is that ML's reason and the state it explains move in ONE patch.
    //
    // ⚠️ A legacy `variations[]` member is NOT a listing of its own, has no
    // status to explain (see `status` right above) and therefore never gets a
    // moderation written: whatever the spread carried stands. That symmetry is
    // what keeps #707's phantom prune — which writes only legacy member links —
    // free of stale reasons it never read.
    moderacoes:
      args.up && args.up.moderacoes != null
        ? args.up.moderacoes
        : ((existingLink.moderacoes as MlModeracao[] | null | undefined) ?? null),
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

/* -------------------------------------------------------------------------- */

/** The five produto fields the rollup below moves, in produto field names. */
export const CAMPOS_MEDIDAS = [
  'pesoLiquidoKg',
  'pesoBrutoKg',
  'alturaCm',
  'larguraCm',
  'profundidadeCm',
] as const satisfies readonly (keyof MedidasDoPacote)[];

/** A child produto considered by the rollup, in the order it should be consulted. */
export interface FilhoMedidas extends MedidasDoPacote {
  /** The child produto's id — the tie-break that makes the choice deterministic. */
  produtoId: string;
}

/**
 * A produto's dimensions AFTER a plan is applied: the raw stored doc with the
 * plan's own write laid over it.
 *
 * Both callers already hold both halves, so this replaces a read-back — which
 * would additionally risk observing a CONCURRENT writer and attributing its
 * value to this import.
 *
 * ⚠️ Reads the patch with `in`, not `?? existing`. A plan may legitimately write
 * an explicit `null` (the parent create path writes five of them when ML
 * reported no package), and `??` would silently fall back to the stale stored
 * value, reporting a measurement this import did not write.
 */
export function medidasEfetivas(
  existente: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown> | null | undefined,
): MedidasDoPacote {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const out = {} as MedidasDoPacote;
  for (const campo of CAMPOS_MEDIDAS) {
    out[campo] = num(patch && campo in patch ? patch[campo] : existente?.[campo]);
  }
  return out;
}

/**
 * The dimensions a family PARENT should adopt from its children (#1087).
 *
 * A simple listing re-imports as a parent produto plus one variation, so the
 * measurements can end up on the child while the "produto base" the operator
 * opens shows none. `dimensoesDoPacote` has NO parent fallback by design — a
 * produto declares its own package or declares none — so a blank parent
 * publishes no package at all rather than borrowing one. This repairs the blank
 * instead of teaching the reader to look elsewhere.
 *
 * ⚠️ Fill-BLANK-only, and deliberately NOT gated by `sobrescreverDadosProduto`.
 * The rule is "the variations have them and the parent does not"; a measurement
 * the operator typed on the parent is never replaced by a child's, whatever the
 * import flags say. That also keeps the repair safe to run on every import.
 *
 * ⚠️ Every field comes from ONE child — the first that resolves a complete
 * geometric set — never per-field across children. Mixing axes from different
 * variations would invent a box no variation actually has, and ML rejects a
 * partial set outright (`item.attribute.missing.seller.package.dimensions`),
 * which is why `dimensoesDoPacote` is all-or-nothing in the first place.
 *
 * ⚠️ `filhos` must arrive in a STABLE order (the imported member first, then by
 * produto id). Two variations with different boxes are both "right", so an
 * unstable order would make the parent's box flip between re-imports. This is
 * the same first-member-wins arbitrariness `upFamilyStatus.ts` calls out for
 * `status`/`moderacoes`; pinning the order is what stops it drifting.
 *
 * Returns only the keys to write, or `null` when there is nothing to do.
 */
export function rollupDimensoesDosFilhos(
  pai: MedidasDoPacote,
  filhos: readonly FilhoMedidas[],
): Partial<MedidasDoPacote> | null {
  const faltando = CAMPOS_MEDIDAS.filter((campo) => pai[campo] == null);
  if (faltando.length === 0) return null;

  // A usable donor is one with a full set of positive axes. The weights are NOT
  // part of the test: `pesoBrutoKg` is legitimately absent whenever a produto
  // carries only a net weight (`dimensoesDoPacote` falls back to it), so
  // requiring it would reject the very children this exists to read.
  const doador = filhos.find(
    (f) =>
      f.alturaCm != null &&
      f.alturaCm > 0 &&
      f.larguraCm != null &&
      f.larguraCm > 0 &&
      f.profundidadeCm != null &&
      f.profundidadeCm > 0,
  );
  if (!doador) return null;

  const patch: Partial<MedidasDoPacote> = {};
  for (const campo of faltando) {
    const valor = doador[campo];
    if (valor != null) patch[campo] = valor;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
