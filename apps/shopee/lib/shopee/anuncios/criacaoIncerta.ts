/**
 * Whether a FAILED first `add_item` may have created the listing anyway
 * (#1911, D5 + rev. 2 K1-1) — the item arm's twin of the kit's
 * `desfechoDeCriacaoDeKit` (`kits/recusaKit.ts`), with the SAME posture.
 *
 * ## The posture: a closed list of refusals; everything else is uncertain
 *
 * `add_item` is NOT idempotent — a second call creates a second listing — so
 * before a failed create is ever told "falhou" one question must be answered:
 * could Shopee have created the item? Only two kinds of answer prove it did not:
 *
 * - our own guard (`ShopeeConfigError`, raised before the fetch), a rate limit
 *   or a dead grant — refused before any handler ran (the kit's three classes);
 * - a refusal of the REQUEST that {@link RECUSAS_DETERMINISTICAS_ADD_ITEM}
 *   holds. Every row is a documented VALIDATION refusal of the `add_item` page
 *   (`node .master_plans/shopee/shopee-doc.mjs api v2.product.add_item`, both
 *   error lists), matched under its own canonical code and — where that code
 *   also carries uncertain sentences — by its own sentence.
 *
 * EVERYTHING else is `incerto`: the network, a non-envelope HTTP answer, a 2xx
 * that did not parse, the gateway's 404, Shopee's own "taking some time to
 * respond" / "System error" / "please try later" answers, and every code the
 * table does not hold — including one Shopee adds tomorrow.
 *
 * ⚠️ The reverse rule ("an unknown refusal is a refusal") was the first draft
 * and is wrong for this page: it documents `error_inner: Our system is taking
 * some time to respond`, `error_busi_add_item_failed: Add item failed. please
 * try later` and `error_unknown`, any of which may sit on a created item.
 * Reading one as `nao-criado` stamps "falhou", the next Publicar sends a second
 * `add_item`, and the seller has two listings — the defect D5 exists to close.
 * The cost of the safe direction is bounded: every retry of the item arm is an
 * operator's, and the uncertain answer carries Shopee's code and sentence, so a
 * deterministic refusal this table misses is VISIBLE, never looped.
 *
 * ## Why the table is CLOSED (no code prefixes)
 *
 * `problemasPublicacao.ts` matches code-family PREFIXES so an undocumented
 * sibling lands on the right FIELD — the right trade there, where a miss is a
 * vaguer sentence. Here a wrong `nao-criado` is a duplicate listing, so a code
 * the page does not name stays `incerto` until the page (or a measured refusal)
 * names it. The test walks EVERY documented `(code, sentence)` of the page into
 * its class, and every row must be reached by a documented line: the page is
 * the fixture, and no row is invented.
 *
 * Three documented codes NAME a validation condition but answer Shopee's
 * internal-error sentence — "Interal error, please contact openapi team", the
 * one `error_marshal` and `error_server` answer too: `error_category_level`,
 * `error_category_path_count_limit`, `error_whole_sale_min_count_incorrect`.
 * And `error_item_not_found` ("Product not found") is no refusal of a create's
 * request at all. None is a row: when the code and the sentence disagree, the
 * uncertain reading wins.
 *
 * ## The uncertain sentences WIN (the kit's ordering rule)
 *
 * Three codes carry BOTH kinds of sentence on the page: `error_auth` ("System
 * error" beside fifteen validation sentences), `error_inner` (three "try later"
 * answers beside "Invalid stock location ID") and `error_busi` (the kit's
 * measured "Too many connections" beside the GTIN / TS Mark / medicine /
 * size-chart image / tax / logistics / warehouse refusals). The kit's table
 * puts its transient row FIRST so a sentence carrying both needles reads
 * transient — the safe direction for a create. This module does the same with
 * {@link INCERTEZAS_DOCUMENTADAS_ADD_ITEM}, consulted BEFORE the refusals; the
 * `error_busi` instability is the kit's OWN row, reached through
 * `classificarRecusaKit` — imported, never re-spelled.
 *
 * ## Where it runs
 *
 * ONLY on the error of a CREATE's `add_item` (`itemId === null`, etapa
 * `addItem`) — either leg of the fiscal retry. An `update_item` failure keeps
 * today's stamp: re-sending an update is safe. In P3, `nao-criado` releases the
 * publish lock and stamps `falhaPublicacao`; `incerto` KEEPS the lock, which
 * expires into its grace and then reads `incerta` — refused at the next publish
 * until the scan that re-finds the listing joins this module (P5).
 *
 * It compares through the app's two shared folds (`core/recusaShopee.ts`),
 * never a third copy, and reads `providerMessage` — NEVER `err.message`, which
 * is OUR sentence with the path and the code already in it.
 *
 * ⚠️ No motivo is spelled here, quoted or as a constant:
 * `anuncios/errosPublicacao.test.ts` (O7) reads this folder as raw text and
 * counts a quoted slug as its producer. A row's label is its code, or
 * `<code>/<what>` — an underscore or a slash, which no slug carries.
 *
 * Pure and total: no clock, no I/O, no environment.
 */
import {
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
} from '@delfrance/integrations-shopee';

import { codigoCanonicoShopee, fraseCanonicaShopee } from '../core/recusaShopee';
import { MOTIVO_RECUSA_KIT_TRANSITORIO, classificarRecusaKit } from '../kits/recusaKit';
import { FRASE_TABELA_MEDIDAS_FOTO_RECUSADA } from './problemasPublicacao';

/** What a failed create's `add_item` left behind on Shopee. */
export type DesfechoDeCriacaoDeItem = 'nao-criado' | 'incerto';

/**
 * One row of {@link RECUSAS_DETERMINISTICAS_ADD_ITEM} or
 * {@link INCERTEZAS_DOCUMENTADAS_ADD_ITEM} — the kit's `{codigo, agulha}` shape.
 */
export interface LinhaCriacaoDeItem {
  /**
   * For the tests that walk the tables — never rendered. The code itself, or
   * `<code>/<what>`; ⚠️ never a motivo's spelling (module docblock).
   */
  readonly rotulo: string;
  /** The code AFTER {@link codigoCanonicoShopee}, compared exactly. */
  readonly codigo: string;
  /**
   * The needle AFTER {@link fraseCanonicaShopee}, matched as a substring of the
   * folded `providerMessage`; `null` ⇒ the row matches by its code alone.
   */
  readonly agulha: string | null;
}

/** A row matched by its code alone, written in Shopee's own spelling. */
function porCodigo(codigoDaPagina: string): LinhaCriacaoDeItem {
  const codigo = codigoCanonicoShopee(codigoDaPagina);
  return { rotulo: codigo, codigo, agulha: null };
}

/**
 * A sentence-scoped row: code and needle written in Shopee's own spelling and
 * folded ONCE through the same folds as the haystack, so a row can never be
 * compared in a form the error is not.
 */
function porFrase(oQue: string, codigoDaPagina: string, fraseDaPagina: string): LinhaCriacaoDeItem {
  const codigo = codigoCanonicoShopee(codigoDaPagina);
  return { rotulo: `${codigo}/${oQue}`, codigo, agulha: fraseCanonicaShopee(fraseDaPagina) };
}

/**
 * The documented refusals of a create's REQUEST — each one proves `add_item`
 * created nothing. CLOSED (module docblock): a code absent here is `incerto`.
 *
 * Code-alone rows are the only row of their code; inside one code no needle
 * contains another — so every row is reachable on its own (the tests pin both).
 * The order decides nothing: every row answers the same `nao-criado`.
 */
export const RECUSAS_DETERMINISTICAS_ADD_ITEM: readonly LinhaCriacaoDeItem[] = [
  // --- the request's parameters (`error_param*`) ------------------------------
  porCodigo('error_param'),
  porCodigo('error_param_shop_id_not_found'),
  porCodigo('error_param_validate'),
  porCodigo('error_param_dts_exceeds_max_limit'),
  porCodigo('error_param_category_not_support_pre_order'),
  // ⚠️ Shopee prints this one as `error.param` — its own dot — which the shared
  // fold reads as the module `error` plus the code `param`. Scoped to its one
  // documented sentence, so no other `*.param` answer is read through it.
  porFrase(
    'estoque-reservado',
    'error.param',
    'Can not update item with stock less than reserved stock',
  ),
  porCodigo('error_data'),
  porCodigo('error_shop'),
  porCodigo('error_sign'),
  // --- one field refused (`error_invalid_*` and Shopee's `error_incalid_*`) ---
  porCodigo('error_invalid_days_to_ship'),
  porCodigo('error_invalid_category_attribute'),
  porCodigo('error_invalid_brand'),
  porCodigo('error_incalid_brand'),
  porCodigo('error_invalid_attribute'),
  porCodigo('error_invalid_attribute_value'),
  porCodigo('error_invalid_category'),
  porCodigo('error_incalid_category'),
  porCodigo('error_invalid_price'),
  porCodigo('error_invalid_logistic_info'),
  porCodigo('error_invalid_price_for_logistic'),
  porCodigo('error_value_name_required'),
  porCodigo('error_value_id_must_equal_zero'),
  porCodigo('error_less_required_attribute'),
  porCodigo('error_less_required_brand'),
  // --- attributes, category, brand, media -------------------------------------
  porCodigo('error_busi_attribute_error'),
  porCodigo('error_attribute_fda_error'),
  porCodigo('error_wrong_attrsnapshot'),
  porCodigo('error_category_is_block'),
  porCodigo('error_forbidden_category'),
  porCodigo('error_category_dts'),
  porCodigo('error_brand_forbidden'),
  porCodigo('error_duplicated_brand'),
  porCodigo('error_desc_image_no_pass'),
  porCodigo('error_image_unavailable'),
  porCodigo('error_image_num_min'),
  porCodigo('error_video_info_not_found'),
  porCodigo('error_check_luc_fail'),
  // D15: Shopee refused a second, similar listing — so it created none.
  porCodigo('error_repeated_mtsku'),
  // --- title and description --------------------------------------------------
  porCodigo('error_title_exceeds_max_length'),
  porCodigo('error_title_character_forbidden'),
  porCodigo('error_name_length_limit'),
  porCodigo('error_item_name_empty'),
  porCodigo('error_item_name_is_too_short'),
  porCodigo('error_nil_name_new_item'),
  porCodigo('error_nil_shopid_or_itemid'),
  porCodigo('error_desc_length_min_limit'),
  porCodigo('error_desc_hash_tag_over_limit'),
  // --- price and wholesale limits ---------------------------------------------
  porCodigo('error_price_exceed_min_limitt'),
  porCodigo('error_price_exceed_max_limitt'),
  porCodigo('error_wholesale_price_less_than_ratio_limit'),
  porCodigo('error_whole_sale_price_setting_incorrect'),
  // --- the status asked for, and the shop's own state --------------------------
  porCodigo('error_unlist_item_fail'),
  porCodigo('error_reach_shop_item_limit'),
  porCodigo('error_holiday_on_add_item'),
  porCodigo('error_busi_invalid_shop_status'),
  porCodigo('error_busi_invalid_account_status'),
  porCodigo('error_busi_cannot_edit_vsku'),
  porCodigo('error_auth_shop_not_found'),
  porCodigo('error_kyc_auth'),
  // --- the gateway and the grant (the page's COMMON list) ----------------------
  // `shop_no_linked` / `shop_banned` / `error_limit` / `error_rate_limit` are NOT
  // rows: the package builds them as the dead-grant and rate-limit CLASSES, which
  // the classifier decides before any table is read.
  porCodigo('invalid_partner_id'),
  porCodigo('invalid_acceess_token'),
  porCodigo('partner_shop_no_link'),
  porCodigo('error_partner_key_expired'),
  porCodigo('error_api_call_restricted'),
  porCodigo('error_api_permission'),
  porCodigo('error_ashop_api_permission'),
  porCodigo('api_suspended'),
  porCodigo('source_ip_undeclared'),
  // --- `error_auth`, sentence by sentence (a business call: never a reauth) ----
  // Every documented sentence EXCEPT "System error" — which is uncertain.
  porFrase('cnsc', 'error_auth', 'cnsc shop not upgraded, can not edit item'),
  porFrase(
    'fbs-b2c',
    'error_auth',
    'The current item belong to the full FBS or B2C shop, so normal stock must be equal to 0',
  ),
  porFrase(
    'location-divergente',
    'error_auth',
    "The location_id input is not matched the shop's location_id",
  ),
  porFrase('location-ausente', 'error_auth', 'Lack of location_id'),
  porFrase('location-do-vendedor', 'error_auth', 'You do not have right to use seller location_id'),
  porFrase('ferias', 'error_auth', 'Please wait for the holiday mode set then to edit item'),
  porFrase('estoque-total', 'error_auth', 'Total stock must be more than reserved stock'),
  porFrase('estoque-reservado', 'error_auth', 'Stock should be larger than reserved stock'),
  porFrase('dts-por-modelo', 'error_auth', 'Your shop can not use model level dts'),
  porFrase('partner-id', 'error_auth', 'partner_id is invalid'),
  porFrase('partner-ou-loja', 'error_auth', 'Invalid partner_id or shopid'),
  porFrase('access-token', 'error_auth', 'Invalid access_token'),
  porFrase('app-excluido', 'error_auth', 'The App is deleted'),
  porFrase('app-restrito', 'error_auth', 'permissions for authorizations have been restricted'),
  porFrase('sem-permissao-na-api', 'error_auth', 'No permission to current api'),
  // --- `error_busi`, sentence by sentence (the kit's instability is uncertain) -
  porFrase('gtin', 'product.error_busi', 'The GTIN code is mandatory'),
  porFrase('ts-mark', 'product.error_busi', 'Please input the correct TS Mark'),
  porFrase('medicamento-obrigatorio', 'product.error_busi', 'Medicine ID is mandatory'),
  porFrase('medicamento-incorreto', 'product.error_busi', 'Please input the correct medicine ID'),
  porFrase(
    'otc',
    'product.error_busi',
    'For OTC medicine, maximum purchase limit per order is mandatory',
  ),
  // Shopee's sentence, spelled ONCE in this app (the size-chart row of step 11's
  // classifier owns it).
  porFrase('foto-da-tabela', 'product.error_busi', FRASE_TABELA_MEDIDAS_FOTO_RECUSADA),
  porFrase('imposto', 'product.error_busi', 'Please input the tax information'),
  porFrase('frete-gratis', 'error_busi', 'logistic must be free'),
  porFrase('multi-armazem', 'error_busi', 'has multi warehouse, please input location id'),
  // --- `error_inner`: ONE deterministic sentence among three uncertain ones ----
  porFrase('local-de-estoque', 'error_inner', 'Invalid stock location ID'),
];

/**
 * The page's UNCERTAIN sentences of the codes that also carry refusals —
 * consulted FIRST, so a sentence holding both reads `incerto` (module
 * docblock). Only those codes are here: for every other code the default
 * already answers `incerto`, and a row there would be decoration. The
 * `error_busi` instability is the kit's row, not one of these.
 */
export const INCERTEZAS_DOCUMENTADAS_ADD_ITEM: readonly LinhaCriacaoDeItem[] = [
  porFrase('erro-de-sistema', 'error_auth', 'System error'),
  porFrase('demora', 'error_inner', 'Our system is taking some time to respond'),
  porFrase('erro-de-sistema', 'error_inner', 'System error'),
  porFrase('falha-ao-atualizar', 'error_inner', 'Update item failed'),
];

function primeiraLinhaQueCasa(
  tabela: readonly LinhaCriacaoDeItem[],
  err: ShopeeApiError,
): LinhaCriacaoDeItem | null {
  const codigo = codigoCanonicoShopee(err.code);
  const frase = fraseCanonicaShopee(err.providerMessage);
  for (const linha of tabela) {
    if (linha.codigo !== codigo) continue;
    if (linha.agulha === null || frase.includes(linha.agulha)) return linha;
  }
  return null;
}

/** The documented refusal `err` is, or `null` — "not one that proves nothing was created". */
export function recusaDeterministicaDeAddItem(err: ShopeeApiError): LinhaCriacaoDeItem | null {
  return primeiraLinhaQueCasa(RECUSAS_DETERMINISTICAS_ADD_ITEM, err);
}

/** The documented uncertain answer `err` is (outside the kit's own row), or `null`. */
export function incertezaDocumentadaDeAddItem(err: ShopeeApiError): LinhaCriacaoDeItem | null {
  return primeiraLinhaQueCasa(INCERTEZAS_DOCUMENTADAS_ADD_ITEM, err);
}

/**
 * The kit's measured instability (`error_busi` "Too many connections") — the
 * kit's own transient row, read through the kit's classifier.
 */
function ehInstabilidadeDoKit(err: ShopeeApiError): boolean {
  const motivo = classificarRecusaKit(err);
  return motivo !== null && MOTIVO_RECUSA_KIT_TRANSITORIO.has(motivo);
}

/**
 * Whether the FAILED `add_item` of a create may have created the listing.
 *
 * - `nao-criado`: our guard (`ShopeeConfigError`), a rate limit or a dead grant,
 *   or a documented refusal of the request
 *   ({@link RECUSAS_DETERMINISTICAS_ADD_ITEM}) that no uncertain sentence
 *   overrides.
 * - `incerto`: every other Shopee error — an uncertain sentence, an unknown
 *   code, the network, an edge answer, an unparseable 2xx, the gateway's 404.
 *
 * ⚠️ A NON-Shopee error is RETHROWN, never classified: it is our bug, not an
 * answer about the listing, and "maybe created" would hide it behind a wait.
 *
 * ⚠️ The two subclasses are tested BEFORE the base class they extend: read
 * first as a `ShopeeApiError`, a rate limit's code is on no row and would come
 * back `incerto`.
 */
export function desfechoDeCriacaoDeItem(err: unknown): DesfechoDeCriacaoDeItem {
  if (err instanceof ShopeeConfigError) return 'nao-criado';
  if (err instanceof ShopeeRateLimitError || err instanceof ShopeeReauthRequiredError) {
    return 'nao-criado';
  }
  if (err instanceof ShopeeApiError) {
    if (ehInstabilidadeDoKit(err)) return 'incerto';
    if (incertezaDocumentadaDeAddItem(err) !== null) return 'incerto';
    return recusaDeterministicaDeAddItem(err) === null ? 'incerto' : 'nao-criado';
  }
  if (err instanceof ShopeeError) return 'incerto';
  throw err;
}
