/**
 * THE code table of the Shopee price sync (#1521, step 13): Shopee's answer to
 * an `update_price` (or to one of the reads before it) → what the sender does
 * about it.
 *
 * ONE table, TWO consumers — the envelope's top-level `error` and each
 * `failure_list` row's `failed_reason` — so the per-model half can never drift
 * into a second copy that reads plausibly and disagrees (root `CLAUDE.md`). The
 * shape is step 12's `classificarCodigoDeEstoque` (`estoque/enviarEstoque.ts`);
 * the rows are the price page's own codes, walked T1 … T14 in the DECLARED
 * order, with row T12b (the sandbox probe's finding) between T12 and T13.
 *
 * ## The discriminant is the ACTION
 *
 * - `pular` — the listing is healthy and something time-bound holds it (a
 *   promotion lock, a slash sale); nothing is stamped, the next run tries again.
 * - `falhar` — a deterministic refusal of THIS listing; `carimbar` says whether
 *   the link's `precoRecusa*` fields record it. It is DERIVED from
 *   `MOTIVOS_QUE_CARIMBAM` (`errosPreco.ts`) and never restated here, so the
 *   table and the write-back cannot disagree about which refusals stamp.
 * - `fatal` — a property of the SHOP (a penalty, a missing permission): the run
 *   ends for the conta, and no listing is stamped for it.
 * - `transitorio` — Shopee's own hiccup: the caller RETHROWS and the queue (or
 *   the operator's next click) owns the retry.
 *
 * ## ⚠️ Lookups use the STRIPPED code; storage keeps the VERBATIM one
 *
 * Shopee prints the same code with and without its module prefix
 * (`product.error_param` / `error_param`), so every key below is matched
 * against `shopeeCodeSemPrefixoDeModulo(codigo) ?? codigo` from the package.
 * The table never returns the code: the caller stores what it received,
 * verbatim, beside the motivo — the evidence an operator reads on the link.
 *
 * ## ⚠️ Every lookup is a `Map` or a `Set`, never an object literal
 *
 * The keys arrive VERBATIM from a provider (an envelope `error`, or a free-text
 * `failed_reason` handed in as the code). On an object literal the lookup for
 * `constructor` or `__proto__` answers an `Object.prototype` member — truthy,
 * `!== undefined` — and a string nobody taught us would take a real row. The
 * package states the same rule over the same class of input.
 *
 * ## ⚠️ The free-text needles read the code AND the message
 *
 * A `failed_reason` is free text that arrives AS the code; the envelope's
 * sentence arrives as the message. The two code-blind needles (T1's promotion,
 * T4's unknown model) are therefore matched on BOTH, lower-cased, so the
 * per-model half classifies the same whether the caller hands the reason in as
 * the code alone or as both arguments. The needles scoped to ONE code (T4's
 * `error_param` pair, T13's `error_inner` trio) read the message only — a code
 * never carries a sentence.
 *
 * ## ⚠️ The order is load-bearing
 *
 * - **T1 first** — a promotion lock can arrive under `error_param: Wrong
 *   parameters, detail: …`, and read as T4 or T14 it would stamp a healthy
 *   listing for the length of a promotion.
 * - **T12 before T12b and T13** — a conta-wide refusal read as transient would
 *   retry a whole run against a shop that cannot accept it.
 * - **T12b before T13** — `error_update_price_fail` says "please try later",
 *   and the SG sandbox probe measured that as FALSE: it is Shopee's single
 *   answer for a ratio violation (against unsent siblings too), a deleted
 *   listing, a has-model listing addressed without a model and an all-invalid
 *   model list. Read as transient it would retry, forever, a write that can
 *   never land; so the bare "please try later" needle is gone from T13.
 * - **T13's `error_inner` needles before T14** — `error_inner` carries both a
 *   retry sentence and a permanent one ("Update item failed …").
 *
 * ## Not in the table
 *
 * The rate limit and a dead authorization are CLASSES the sender narrows
 * before it ever consults this table (`ShopeeRateLimitError`,
 * `ShopeeReauthRequiredError`, and a partial error's copied `kind`). A `kind`
 * of `burst`, `daily` or `reauth` reaching here is therefore an unknown
 * refusal, T14 — the table does not second-guess the ladder above it.
 *
 * Pure: no clock, no I/O, no environment.
 */
import {
  SHOPEE_ERROR_KIND,
  shopeeCodeSemPrefixoDeModulo,
  type ShopeeErrorKind,
} from '@delfrance/integrations-shopee';

import { MOTIVOS_QUE_CARIMBAM, MOTIVO_PRECO_SHOPEE, type MotivoPrecoShopee } from './errosPreco';

/* ------------------------------ the verdict -------------------------------- */

/** The two conta-wide refusals of row T12 — the only `fatal` motivos. */
type MotivoFatalPreco = 'loja-com-penalidade' | 'sem-permissao';

/**
 * What the sender does with one refusal. The discriminant is the ACTION (see
 * the module docblock); the motivo is what the operator reads.
 */
export type ClassePreco =
  | { readonly classe: 'pular'; readonly motivo: MotivoPrecoShopee }
  | { readonly classe: 'falhar'; readonly motivo: MotivoPrecoShopee; readonly carimbar: boolean }
  | { readonly classe: 'fatal'; readonly motivo: MotivoFatalPreco }
  | { readonly classe: 'transitorio' };

/* ------------------------------- the rows ---------------------------------- */

/** T1 — the four promotion locks, Shopee's spellings verbatim ([sic] `cannt`). */
const CODIGOS_DE_PROMOCAO: ReadonlySet<string> = new Set([
  'error_cannt_edit_price_in_promotion',
  'error_in_item_promotion_item_price_lock',
  'error_cannot_update_price_in_promotion',
  'error_related_product_in_promotion',
]);

/** T1 — the code-blind needle: a lock named in a free-text reason or a detail. */
const AGULHA_DE_PROMOCAO = 'promotion';

/**
 * T2 — a running SLASH sale (the struck-through price). Not a flash sale: that
 * one is a different promotion with its own codes.
 */
const CODIGOS_DE_PRECO_RISCADO: ReadonlySet<string> = new Set([
  'error_slash_price_not_lowest',
  'error_slash_price_models_diff',
]);

/**
 * T3 — the listing has models and the body addressed it without one. Never
 * observed on the sandbox (a has-model item sent `model_id: 0` answered T12b's
 * catch-all instead); kept because the page documents it, and it means the
 * same drift the sender's pre-wire structure gate catches first.
 */
const CODIGO_DE_FORMA_DE_MODELO = 'error_edit_item_price_for_item_has_model';

/** T4 — `error_param`'s two model-id details, matched on the message. */
const DETALHES_DE_MODELO_INVALIDO: readonly string[] = ['repeat model_id', 'wrong model_id'];

/**
 * T4 — the code-blind needle, and the only per-model reason text the stock
 * sibling's probe MEASURED: `failed_reason: "model ID not exist in sku"` (P9).
 */
const AGULHA_DE_MODELO_INEXISTENTE = 'model id not exist';

/**
 * T5 … T11 — a deterministic refusal of the listing, one motivo per code.
 *
 * One `Map` stands for seven rows because every key is an EXACT code, the sets
 * are disjoint and no row among them has a needle — so their relative order
 * cannot change an answer. Each entry names its row.
 */
const RECUSA_DO_ANUNCIO_POR_CODIGO: ReadonlyMap<string, MotivoPrecoShopee> = new Map(
  Object.entries({
    // T5 — who the listing belongs to, or whether it exists at all.
    error_item_not_belong_shop: MOTIVO_PRECO_SHOPEE.anuncioDeOutraLoja,
    error_item_not_found: MOTIVO_PRECO_SHOPEE.anuncioInexistente,
    error_nil_shopid_or_itemid: MOTIVO_PRECO_SHOPEE.anuncioInexistente,
    // T6 — the category's price band ([sic] `limitt`, twice).
    error_price_exceed_min_limitt: MOTIVO_PRECO_SHOPEE.precoForaDaFaixa,
    error_price_exceed_max_limitt: MOTIVO_PRECO_SHOPEE.precoForaDaFaixa,
    error_price_out_of_range: MOTIVO_PRECO_SHOPEE.precoForaDaFaixa,
    // T7 — the price's own format.
    error_invalid_price: MOTIVO_PRECO_SHOPEE.precoInvalido,
    // T8 — a logistics channel's own ceiling.
    error_invalid_price_for_logistic: MOTIVO_PRECO_SHOPEE.precoAcimaDoLimiteDoFrete,
    // T9 — the listing's bulk-price tiers ([sic] `then`).
    error_busi_price_lower_then_wholesale_price: MOTIVO_PRECO_SHOPEE.conflitoComAtacado,
    error_wholesale_price_less_than_ratio_limit: MOTIVO_PRECO_SHOPEE.conflitoComAtacado,
    error_price_should_be_same_for_wholesales: MOTIVO_PRECO_SHOPEE.conflitoComAtacado,
    // T10 — a virtual-SKU listing.
    error_busi_cannot_edit_vsku: MOTIVO_PRECO_SHOPEE.lojaVsku,
    // T11 — the listing is locked against edits.
    error_item_uneditable: MOTIVO_PRECO_SHOPEE.anuncioNaoEditavel,
  } satisfies Record<string, MotivoPrecoShopee>),
);

/**
 * T12 — a property of the SHOP. Never stamped on a listing: nothing about the
 * listing is wrong, and every listing of the conta would meet the same answer.
 */
const FATAL_POR_CODIGO: ReadonlyMap<string, MotivoFatalPreco> = new Map(
  Object.entries({
    error_seller_under_penalty: MOTIVO_PRECO_SHOPEE.lojaComPenalidade,
    error_perm_non_admin: MOTIVO_PRECO_SHOPEE.semPermissao,
  } satisfies Record<string, MotivoFatalPreco>),
);

/** T12b — Shopee's catch-all price refusal; deterministic (see the docblock). */
const CODIGO_DE_PRECO_RECUSADO = 'error_update_price_fail';

/** T13 — Shopee's hiccup under its own busy code. */
const CODIGO_DE_SISTEMA_OCUPADO = 'error_system_busy';

/** T13 — `error_inner` is transient ONLY when its sentence says so. */
const CODIGO_INTERNO = 'error_inner';

/** T13 — the retry sentences `error_inner` carries (the permanent one has none). */
const FRASES_DE_NOVA_TENTATIVA: readonly string[] = ['try again', 'try later', 'taking some time'];

/* ------------------------------- the walk ---------------------------------- */

/** A listing-level refusal; whether it stamps is the write-back set's answer. */
function falhar(motivo: MotivoPrecoShopee): ClassePreco {
  return { classe: 'falhar', motivo, carimbar: MOTIVOS_QUE_CARIMBAM.has(motivo) };
}

/**
 * Classify one refusal: `codigo` is Shopee's code VERBATIM (module prefix and
 * all) or a model's free-text `failed_reason`; `mensagem` is the envelope's
 * sentence (a per-model caller may pass the reason again, or `''`); `kind` is
 * the transport's reading of the code (`other` for a per-model reason — one
 * refused model is never a reason to retry the whole call).
 *
 * Walks T1 … T14 in the declared order; the first row that matches answers.
 */
export function classificarCodigoDePreco(
  codigo: string,
  mensagem: string,
  kind: ShopeeErrorKind,
): ClassePreco {
  const nu = shopeeCodeSemPrefixoDeModulo(codigo) ?? codigo;
  const msg = mensagem.toLowerCase();
  const texto = `${codigo.toLowerCase()}\n${msg}`;

  // ---- T1: a promotion holds the price. FIRST — its needle beats T4/T14. ----
  if (CODIGOS_DE_PROMOCAO.has(nu) || texto.includes(AGULHA_DE_PROMOCAO)) {
    return { classe: 'pular', motivo: MOTIVO_PRECO_SHOPEE.bloqueadoPorPromocao };
  }

  // ---- T2: a running slash sale. A lock, not a defect. ----
  if (CODIGOS_DE_PRECO_RISCADO.has(nu)) {
    return { classe: 'pular', motivo: MOTIVO_PRECO_SHOPEE.precoRiscado };
  }

  // ---- T3: a has-model listing addressed without a model. ----
  if (nu === CODIGO_DE_FORMA_DE_MODELO) {
    return falhar(MOTIVO_PRECO_SHOPEE.formaDeModeloDivergente);
  }

  // ---- T4: a model id Shopee does not recognise. ----
  if (nu === 'error_param' && DETALHES_DE_MODELO_INVALIDO.some((d) => msg.includes(d))) {
    return falhar(MOTIVO_PRECO_SHOPEE.modeloInvalido);
  }
  if (texto.includes(AGULHA_DE_MODELO_INEXISTENTE)) {
    return falhar(MOTIVO_PRECO_SHOPEE.modeloInvalido);
  }

  // ---- T5 … T11: the listing refuses this price, deterministically. ----
  const recusa = RECUSA_DO_ANUNCIO_POR_CODIGO.get(nu);
  if (recusa !== undefined) return falhar(recusa);

  // ---- T12: the SHOP refuses. Above T12b and T13. ----
  const fatal = FATAL_POR_CODIGO.get(nu);
  if (fatal !== undefined) return { classe: 'fatal', motivo: fatal };

  // ---- T12b: the catch-all, deterministic despite its "try later". ----
  if (nu === CODIGO_DE_PRECO_RECUSADO) return falhar(MOTIVO_PRECO_SHOPEE.precoRecusado);

  // ---- T13: Shopee's own hiccup — the caller rethrows. ----
  if (kind === SHOPEE_ERROR_KIND.transient) return { classe: 'transitorio' };
  if (nu === CODIGO_DE_SISTEMA_OCUPADO) return { classe: 'transitorio' };
  if (nu === CODIGO_INTERNO && FRASES_DE_NOVA_TENTATIVA.some((f) => msg.includes(f))) {
    return { classe: 'transitorio' };
  }

  // ---- T14: a refusal nobody taught us. Stamped, with the raw code kept. ----
  return falhar(MOTIVO_PRECO_SHOPEE.recusaDesconhecida);
}
