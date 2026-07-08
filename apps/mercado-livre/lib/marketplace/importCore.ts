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
import type { MappedMlItem } from '@delfrance/integrations-mercado-livre';
import { CONDICAO_PRODUTO, makeEstoqueUid, toOuterRef } from '@delfrance/schemas';

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
  /** Ported but inert until the photo-import slice (#439). */
  importarFotos: boolean;
  /** Ported but inert until the category-creation slice (#442). */
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
        // categoriaProdutoOuterRef deferred to #442 (ML category → ERP Categoria).
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
  let estoque: { docId: string; data: Record<string, unknown> } | null = null;
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
