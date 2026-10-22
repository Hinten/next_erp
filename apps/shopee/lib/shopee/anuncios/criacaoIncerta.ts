/**
 * **The UNCERTAIN first create of an ordinary listing** (#1911, D5 + rev. 2
 * K1-1/K1-7/K1-11) — the two halves of "a create whose outcome nobody knows is
 * never re-sent blind":
 *
 *  1. {@link desfechoDeCriacaoDeItem} — whether a FAILED first `add_item` may
 *     have created the listing anyway: the item arm's twin of the kit's
 *     `desfechoDeCriacaoDeKit` (`kits/recusaKit.ts`), with the SAME posture.
 *     `incerto` ⇒ the draft keeps its lock for the wait and records the attempt
 *     (`criacaoIncertaDesde`, `reservaRascunho.ts`), and the publish answers
 *     **202** ({@link CriacaoDeAnuncioIncertaError} → `publicarShopee.ts`).
 *  2. {@link localizarAnuncioIncerto} — **ENSURE**: before ANY new `add_item`
 *     for a draft in `incerta`, look for the listing the earlier attempt may
 *     have created, by SKU, inside that attempt's window — and FAIL CLOSED
 *     (section "ENSURE" below).
 *
 * ## The posture: a closed list of refusals; everything else is uncertain
 *
 * `add_item` is NOT idempotent — a second call creates a second listing — so
 * before a failed create is ever told "falhou" one question must be answered:
 * could Shopee have created the item? Only three kinds of answer prove it did
 * not:
 *
 * - our own guard (`ShopeeConfigError`, raised before the fetch), a rate limit
 *   or a dead grant — refused before any handler ran (the kit's three classes);
 * - the app's own TOKEN STEP — the four credential classes the shop client's
 *   access-token function raises (`core/tokenStore.ts`'s
 *   `ShopeeRefreshEmAndamentoError`, `ShopeeSemCredencialError`,
 *   `ShopeeContaSemShopIdError`, and `core/credentialStore.ts`'s
 *   `ShopeeCredencialInvalidaError`). `client.addItem` asks for the token
 *   BEFORE it builds the request, so these never reach Shopee: they are plain
 *   `Error`s, not Shopee answers, and the publish hands the lock back WITHOUT a
 *   failure stamp (nothing was refused — nothing was sent);
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
 * today's stamp: re-sending an update is safe. `nao-criado` releases the
 * publish lock (with the `falhaPublicacao` stamp for a Shopee answer);
 * `incerto` KEEPS the lock for {@link AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS} and
 * records the attempt, so the next publish runs ENSURE first.
 *
 * It compares through the app's two shared folds (`core/recusaShopee.ts`),
 * never a third copy, and reads `providerMessage` — NEVER `err.message`, which
 * is OUR sentence with the path and the code already in it.
 *
 * ## ENSURE ({@link localizarAnuncioIncerto}) — fail CLOSED (K1-7)
 *
 * Runs inside the draft's reservation (`reservaRascunho.ts`), lock held,
 * BEFORE `preparar`, only for a draft whose reading is `incerta`:
 *
 *  1. **The SKU, folded** — the produto's `sku` through the import's own fold
 *     (`skuDoItemShopee({item_sku: produto.sku})`, `produtos/resolveProduto.ts`
 *     — shared, never copied: the scan must ask exactly what the import asks,
 *     or "importe-o" lands the listing on another produto). A BLANK fold
 *     (`''`, `'   '`, absent) is refused `criacao-incerta-sem-sku` and NEVER
 *     scanned — a blank fold would "hit" every SKU-less listing (K2-21) —
 *     unless the operator attested (`confirmarCriacaoIncerta`), which then
 *     proceeds WITHOUT a scan (there is nothing to compare).
 *  2. **`get_item_list` narrowed to the attempt's window** —
 *     `update_time_from = inicioDaJanelaDaCriacaoShopeeS(desde)` (THE one
 *     computation, `@delfrance/schemas`) and NO `update_time_to` — `update_time`
 *     is a listing's LAST change, so an upper bound read off our clock would
 *     drop the very listing the attempt created the moment a stock push (or a
 *     clock ahead of ours) touched it: the fail-OPEN direction; the lower
 *     bound alone is what narrows the walk. Statuses
 *     NORMAL/UNLIST/REVIEWING/BANNED (a deleted listing is never a
 *     duplicate), at most {@link MAX_PAGINAS_BUSCA_ANUNCIO} pages, the kit
 *     walk's cursor rules verbatim. Incomplete ⇒ `busca-de-anuncio-incompleta`.
 *  3. **One base-info batch** over every row that is not a KIT (`add_item`
 *     never creates one; an unknown `tag` stays a candidate), then each row is
 *     placed by its SKU and by {@link criadoNaJanelaShopee} (`create_time`):
 *     - **DEFINITE** — unlinked, SKU equal, `dentro`;
 *     - **UNDECIDABLE** — unlinked, (SKU equal or Shopee reported NO
 *       `item_sku` — `null`, or no base row at all), (`dentro` or
 *       `desconhecido`), and not definite;
 *     - **ALREADY LINKED to THIS produto** — SKU equal, `dentro` or
 *       `desconhecido`: it may be the attempt's own listing, linked by
 *       another path (the import's `add`);
 *     - ignored: `fora` (created before the window), another SKU, a
 *       REPORTED empty `item_sku` (the attempt sent a non-blank one), and a
 *       row linked to ANOTHER produto of the conta (`resolverLinkPorItemId`).
 *  4. **Verdict** — any undecidable, or 2+ definite ⇒ `criacao-incerta-ambigua`
 *     (`importar{itemIds, vinculados}`); else linked rows and no attestation ⇒
 *     `criacao-incerta-ja-vinculada` (`importar{itemIds, vinculados}`); else
 *     exactly one definite ⇒ ADOPT it; else (a complete scan, nothing) ⇒
 *     proceed, after the caller clears the record.
 *
 * ⚠️ `confirmarCriacaoIncerta` is honoured for EXACTLY two verdicts —
 * `-sem-sku` and `-ja-vinculada` (K1-11) — and never skips a scan of a
 * produto that HAS a SKU: an ambiguous or incomplete scan refuses whatever the
 * flag says.
 *
 * ⚠️ The four motivos are spelled HERE and only here, through
 * `MOTIVO_PUBLICACAO_BLOQUEADA` — never quoted
 * (`anuncios/errosPublicacao.test.ts` O7 reads this folder as raw text and
 * counts a quoted slug as a producer). A classifier row's label is its code, or
 * `<code>/<what>` — an underscore or a slash, which no slug carries.
 *
 * The classifier half is pure and total. ENSURE reads Shopee and the conta's
 * links and WRITES NOTHING: the record and the adoption are the reservation's
 * token-guarded writes. No clock at all: the window opens at the STORED
 * attempt start, and nothing here asks what time it is.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  SHOPEE_MAX_PAGE_SIZE,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  type ShopeeClient,
  type ShopeeItemBaseInfoRow,
  type ShopeeItemListRow,
} from '@delfrance/integrations-shopee';
import {
  AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  criadoNaJanelaShopee,
  inicioDaJanelaDaCriacaoShopeeS,
  type AcaoSugeridaPublicacaoShopee,
  type JanelaDaCriacaoIncertaShopee,
} from '@delfrance/schemas';

import { ShopeeCredencialInvalidaError } from '../core/credentialStore';
import { codigoCanonicoShopee, fraseCanonicaShopee } from '../core/recusaShopee';
import {
  ShopeeContaSemShopIdError,
  ShopeeRefreshEmAndamentoError,
  ShopeeSemCredencialError,
} from '../core/tokenStore';
import { lerBaseInfoDosItens } from '../kits/componentesKit';
import { STATUS_BUSCA_KIT } from '../kits/constantesKit';
import { MOTIVO_RECUSA_KIT_TRANSITORIO, classificarRecusaKit } from '../kits/recusaKit';
import { ehKitDe } from '../produtos/itemLido';
import { skuDoItemShopee } from '../produtos/resolveProduto';
import { MOTIVO_PUBLICACAO_BLOQUEADA, type ProblemaDeBloqueio } from './errosPublicacao';
import { resolverLinkPorItemId, type VinculoLidoDaConta } from './linkAnuncio';
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
 * Is this one of the app's TOKEN-STEP classes — raised by the shop client's
 * access-token function, which `client.addItem` calls BEFORE it builds the
 * request? Then the create never left this process (module docblock).
 *
 * ⚠️ Each class by name — never their `Error` base, which every bug shares.
 */
export function ehFalhaDoPassoDoToken(err: unknown): boolean {
  return (
    err instanceof ShopeeRefreshEmAndamentoError ||
    err instanceof ShopeeSemCredencialError ||
    err instanceof ShopeeContaSemShopIdError ||
    err instanceof ShopeeCredencialInvalidaError
  );
}

/**
 * Whether the FAILED `add_item` of a create may have created the listing.
 *
 * - `nao-criado`: our guard (`ShopeeConfigError`), a rate limit or a dead grant,
 *   the app's token step ({@link ehFalhaDoPassoDoToken} — never a request), or
 *   a documented refusal of the request ({@link RECUSAS_DETERMINISTICAS_ADD_ITEM})
 *   that no uncertain sentence overrides.
 * - `incerto`: every other Shopee error — an uncertain sentence, an unknown
 *   code, the network, an edge answer, an unparseable 2xx, the gateway's 404.
 *
 * ⚠️ Any OTHER non-Shopee error is RETHROWN, never classified: it is our bug,
 * not an answer about the listing, and "maybe created" would hide it behind a
 * wait.
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
  if (ehFalhaDoPassoDoToken(err)) return 'nao-criado';
  if (err instanceof ShopeeApiError) {
    if (ehInstabilidadeDoKit(err)) return 'incerto';
    if (incertezaDocumentadaDeAddItem(err) !== null) return 'incerto';
    return recusaDeterministicaDeAddItem(err) === null ? 'incerto' : 'nao-criado';
  }
  if (err instanceof ShopeeError) return 'incerto';
  throw err;
}

/* -------------------------------------------------------------------------- */
/*                       the 202 — an UNCERTAIN create                         */
/* -------------------------------------------------------------------------- */

/** Shopee's own words about an uncertain create, when it answered at all. */
export interface RecusaDoAnuncioIncerto {
  /** Shopee's `error` code, VERBATIM (module prefix and all). */
  readonly codigo: string;
  /** Shopee's sentence (`providerMessage`), or `null` when it sent none. */
  readonly fraseShopee: string | null;
}

/**
 * Shopee's code and sentence when it ANSWERED with an error envelope; `null`
 * when no answer arrived at all (the network, an edge page, an unparseable
 * 2xx) — `respostaItemIncertoShopeeSchema`'s `recusa`.
 */
export function recusaDoAnuncioIncerto(err: ShopeeError): RecusaDoAnuncioIncerto | null {
  if (!(err instanceof ShopeeApiError)) return null;
  return { codigo: err.code, fraseShopee: err.providerMessage ?? null };
}

/**
 * The produto's SKU exactly as {@link localizarAnuncioIncerto} compares it —
 * the import's PARENT-SKU fold (`skuDoItemShopee`, trim only), applied to the
 * ERP side. `''` ⇔ nothing to look the listing up by.
 *
 * - **EQUAL:** `' SKU-1 '` ≡ `'SKU-1'`; `null`, absent, `''` and `'   '` all
 *   fold to `''`.
 * - **DISTINCT:** case (`'sku-1'` ≠ `'SKU-1'`) and inner whitespace
 *   (`'SKU 1'` ≠ `'SKU1'`) — the import's rung is case-sensitive.
 */
export function skuDaBuscaShopee(sku: string | null | undefined): string {
  return skuDoItemShopee({ item_sku: sku ?? null });
}

/** One uncertain create, as the route's 202 and the CLI report it. */
export interface ResultadoItemIncerto {
  readonly produtoId: string;
  /** The DRAFT that records the attempt — never `null` (a no-link create mints one, K1-5). */
  readonly linkDocId: string;
  /** MILLISECONDS until the draft's lock stops reading `em-andamento`. Always > 0. */
  readonly aguardarMs: number;
  /** Whether the re-send can look the listing up: the produto's SKU folds non-blank. */
  readonly reenvioVerificaSku: boolean;
  readonly recusa: RecusaDoAnuncioIncerto | null;
  /** The CLI's sentence (and the 202's undeclared `mensagem`). */
  readonly mensagem: string;
}

/**
 * The sentence of an uncertain create — what to do next, in the order the
 * operator does it. Two wordings, by whether the re-send can look the listing
 * up by SKU at all.
 */
export function mensagemDoAnuncioIncerto(reenvioVerificaSku: boolean): string {
  const minutos = String(AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS / 60_000);
  return reenvioVerificaSku
    ? `a Shopee pode ter criado o anúncio — aguarde ${minutos} minutos e publique de novo o MESMO ` +
        'rascunho: antes de qualquer novo add_item o ERP procura o anúncio pelo SKU, e o vincula a ' +
        'este rascunho se ele existir; senão, o cria'
    : 'a Shopee pode ter criado o anúncio, e o produto não tem SKU para o ERP procurá-lo — ' +
        `aguarde ${minutos} minutos e confira no Seller Centre: se o anúncio existir, importe-o ` +
        '(importar:anuncio); se não existir, publique de novo o mesmo rascunho confirmando a ' +
        'criação incerta (--confirmar-criacao-incerta)';
}

/**
 * A draft's first `add_item` ended with an outcome nobody can know (the
 * classifier's `incerto`): the lock was kept for the wait and the attempt
 * recorded. Thrown by `publicarAnuncio.ts` AFTER that write, and turned into a
 * RESULT by `publicarShopee.ts` (`tipo: 'item-incerto'`, the route's 202) — so
 * `publicarAnuncioShopee`'s own return type stays step 11's.
 *
 * ⚠️ An APP class, deliberately NOT a `ShopeeError`: it is not a Shopee
 * refusal (nothing may stamp "falhou" for it), and the one place that may read
 * it narrows it by class. `cause` is the Shopee failure behind it.
 */
export class CriacaoDeAnuncioIncertaError extends Error {
  readonly resultado: ResultadoItemIncerto;

  constructor(resultado: ResultadoItemIncerto, causa: ShopeeError) {
    super(
      `add_item do rascunho ${resultado.linkDocId} (produto ${resultado.produtoId}) com desfecho ` +
        'INCERTO: a trava foi mantida e a tentativa registrada.',
      { cause: causa },
    );
    this.name = 'CriacaoDeAnuncioIncertaError';
    this.resultado = resultado;
  }
}

/* -------------------------------------------------------------------------- */
/*                 ENSURE — look before any second `add_item`                  */
/* -------------------------------------------------------------------------- */

/**
 * At most this many `get_item_list` pages (100 rows each) per look-up. The
 * window narrows the walk to what the attempt could have touched, so a page or
 * two is the norm; the kit's un-narrowed walk needs 100 (`MAX_PAGINAS_BUSCA_KIT`)
 * and that cost does not transfer. Past it the scan is INCOMPLETE — a refusal.
 */
export const MAX_PAGINAS_BUSCA_ANUNCIO = 20;

/**
 * The `item_status` filter: every status a listing that still EXISTS can carry
 * — the kit scan's list, ONE copy (a deleted listing is never a duplicate).
 */
export const STATUS_BUSCA_ANUNCIO = STATUS_BUSCA_KIT;

/** What {@link localizarAnuncioIncerto} needs. */
export interface EntradaDaBuscaIncerta {
  readonly integracaoId: string;
  readonly produtoId: string;
  /** The produto's STORED `sku`, raw — folded here ({@link skuDaBuscaShopee}). */
  readonly sku: string | null;
  /** The attempt window, read BEFORE the reservation replaced the lock. */
  readonly janela: JanelaDaCriacaoIncertaShopee;
  /** The produto's links on this conta (`lerVinculosDaConta`) — "its OWN listings". */
  readonly vinculosDoProduto: readonly VinculoLidoDaConta[];
  /** The operator's attestation — honoured for `-sem-sku` and `-ja-vinculada` ONLY (K1-11). */
  readonly confirmarCriacaoIncerta: boolean;
}

/** What one look-up spent and saw — for the log line, never for a decision. */
export interface ResumoDaBuscaIncerta {
  /** `false` ⇔ no scan ran (a blank SKU). */
  readonly varreu: boolean;
  readonly paginas: number;
  /** Shopee calls: the pages plus the base-info batch. */
  readonly chamadas: number;
  /** Rows of the window that were not kits. */
  readonly candidatos: number;
}

/** ENSURE's verdict. */
export type VeredictoDaBuscaIncerta =
  /** Exactly one DEFINITE listing and nothing undecidable: the earlier attempt's. */
  | { readonly tipo: 'adotar'; readonly itemId: number; readonly resumo: ResumoDaBuscaIncerta }
  /**
   * Nothing the attempt could have created — or, with `resumo.varreu` false,
   * the operator's attestation on a SKU-less produto. Only a COMPLETE scan
   * (`varreu`) proves the record may be cleared.
   */
  | { readonly tipo: 'prosseguir'; readonly resumo: ResumoDaBuscaIncerta }
  /** A blocked refusal of the four — nothing may be sent. */
  | {
      readonly tipo: 'recusar';
      readonly problema: ProblemaDeBloqueio;
      readonly resumo: ResumoDaBuscaIncerta;
    };

/** A positive safe-integer `item_id` off a stored link, or `null`. */
function itemIdDoVinculo(raw: Record<string, unknown>): number | null {
  const bruto = raw.item_id;
  return typeof bruto === 'number' && Number.isSafeInteger(bruto) && bruto > 0 ? bruto : null;
}

/** At most this many ids in a sentence — the `acao` carries every one. */
const IDS_NA_FRASE = 10;

function listaDeIds(ids: readonly number[]): string {
  const mostrados = ids.slice(0, IDS_NA_FRASE).map(String).join(', ');
  return ids.length > IDS_NA_FRASE
    ? `${mostrados} e mais ${String(ids.length - IDS_NA_FRASE)}`
    : mostrados;
}

function bloqueio(
  motivo: ProblemaDeBloqueio['motivo'],
  mensagem: string,
  acao?: AcaoSugeridaPublicacaoShopee,
): ProblemaDeBloqueio {
  return { campo: 'item_sku', motivo, mensagem, ...(acao === undefined ? {} : { acao }) };
}

function problemaSemSku(): ProblemaDeBloqueio {
  return bloqueio(
    MOTIVO_PUBLICACAO_BLOQUEADA.criacaoIncertaSemSku,
    'a última tentativa de publicar este rascunho pode ter criado o anúncio na Shopee, e o ' +
      'produto não tem SKU para o ERP procurá-lo — confira no Seller Centre: se o anúncio existir, ' +
      'importe-o (importar:anuncio); se não existir, publique de novo confirmando a criação ' +
      'incerta (--confirmar-criacao-incerta)',
  );
}

function problemaBuscaIncompleta(paginas: number): ProblemaDeBloqueio {
  return bloqueio(
    MOTIVO_PUBLICACAO_BLOQUEADA.buscaDeAnuncioIncompleta,
    `a busca pelo anúncio que a última tentativa pode ter criado não terminou (${String(paginas)} ` +
      'página(s) lida(s), ou um cursor da Shopee que não avança) — nada foi criado; tente de ' +
      'novo, ou confira no Seller Centre e importe o anúncio se ele existir',
  );
}

/** `importar{itemIds, vinculados}` — every id, the linked ones with THIS produto. */
function acaoImportar(
  itemIds: readonly number[],
  vinculadas: readonly number[],
  produtoId: string,
): AcaoSugeridaPublicacaoShopee {
  return {
    tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar,
    itemIds: [...itemIds],
    vinculados: vinculadas.map((itemId) => ({ itemId, produtoId })),
  };
}

function problemaAmbigua(
  itemIds: readonly number[],
  vinculadas: readonly number[],
  produtoId: string,
): ProblemaDeBloqueio {
  return bloqueio(
    MOTIVO_PUBLICACAO_BLOQUEADA.criacaoIncertaAmbigua,
    'a última tentativa pode ter criado o anúncio, e a busca não conseguiu apontar UM só ' +
      `(item ${listaDeIds(itemIds)}: com o SKU deste produto e criados na janela da tentativa, ` +
      'ou sem SKU ou data de criação informados pela Shopee) — confira no Seller Centre e ' +
      'importe o anúncio certo (importar:anuncio) em vez de criar outro',
    acaoImportar(itemIds, vinculadas, produtoId),
  );
}

function problemaJaVinculada(
  itemIds: readonly number[],
  vinculadas: readonly number[],
  produtoId: string,
): ProblemaDeBloqueio {
  return bloqueio(
    MOTIVO_PUBLICACAO_BLOQUEADA.criacaoIncertaJaVinculada,
    `o anúncio ${listaDeIds(vinculadas)}, já vinculado a este produto e com o mesmo SKU, foi ` +
      'criado na janela da última tentativa (ou sem data de criação informada) — pode ser o ' +
      'anúncio que ela criou, vinculado por outro caminho. Confira no Seller Centre; se é um ' +
      'segundo anúncio feito de propósito, publique de novo confirmando a criação incerta ' +
      '(--confirmar-criacao-incerta)',
    acaoImportar(itemIds, vinculadas, produtoId),
  );
}

/**
 * The SKU Shopee REPORTED for a row through the shared fold, or `null` when it
 * reported none — `item_sku: null`, or no base row at all. ⚠️ Not the fold's
 * `''`: a REPORTED blank SKU is data (the attempt sent a non-blank one), an
 * unreported one is a doubt.
 */
function skuReportado(base: ShopeeItemBaseInfoRow | null): string | null {
  // `typeof`, not `=== null`: an absent key is "not reported" too (fail closed).
  if (base === null || typeof base.item_sku !== 'string') return null;
  return skuDoItemShopee(base);
}

/**
 * ENSURE — see the module docblock: look for the listing a draft's uncertain
 * create may have made, and decide whether a new `add_item` is safe.
 *
 * Reads only: `get_item_list` (narrowed by `update_time_from` alone — an upper
 * bound would drop the very listing a stock push touched a second ago, so none
 * is sent), one base-info batch, and one `resolverLinkPorItemId` per row that
 * could still matter. Every Shopee and Firestore failure propagates (rule 6):
 * the reservation hands its lock back, nothing having been sent.
 */
export async function localizarAnuncioIncerto(
  client: ShopeeClient,
  db: Firestore,
  e: EntradaDaBuscaIncerta,
): Promise<VeredictoDaBuscaIncerta> {
  const sku = skuDaBuscaShopee(e.sku);
  if (sku === '') {
    const resumo: ResumoDaBuscaIncerta = { varreu: false, paginas: 0, chamadas: 0, candidatos: 0 };
    // ⚠️ Never scanned: a blank fold would "hit" every SKU-less listing.
    return e.confirmarCriacaoIncerta
      ? { tipo: 'prosseguir', resumo }
      : { tipo: 'recusar', problema: problemaSemSku(), resumo };
  }

  // ⚠️ THE window opening (`@delfrance/schemas`), floored at 1 s: a corrupt
  // early record widens the walk — which then refuses as incomplete or
  // ambiguous — and never fails it open.
  const updateTimeFromS = Math.max(inicioDaJanelaDaCriacaoShopeeS(e.janela.desdeMs), 1);

  /** Candidates, FIRST sighting wins — an offset walk can show a row twice. */
  const candidatos = new Map<number, ShopeeItemListRow>();
  let paginas = 0;
  let completo = false;
  let offset = 0;
  while (paginas < MAX_PAGINAS_BUSCA_ANUNCIO) {
    const pagina = await client.getItemList({
      offset,
      pageSize: SHOPEE_MAX_PAGE_SIZE,
      statuses: STATUS_BUSCA_ANUNCIO,
      updateTimeFromS,
    });
    paginas += 1;
    for (const linha of pagina.item) {
      // `add_item` never creates a kit. ⚠️ Only an explicit `true` drops the
      // row here: a row with no `tag` is decided by its base info below.
      if (linha.tag?.kit === true) continue;
      if (!candidatos.has(linha.item_id)) candidatos.set(linha.item_id, linha);
    }
    if (!pagina.has_next_page) {
      completo = true;
      break;
    }
    const proximo = pagina.next_offset;
    if (proximo === null || proximo <= offset) {
      console.warn(
        '[shopee/anuncios] get_item_list sem um next_offset que avance; busca incompleta',
        {
          integracaoId: e.integracaoId,
          produtoId: e.produtoId,
          offset,
          nextOffset: proximo,
          paginas,
        },
      );
      break;
    }
    offset = proximo;
  }

  if (!completo) {
    const resumo = { varreu: true, paginas, chamadas: paginas, candidatos: candidatos.size };
    return { tipo: 'recusar', problema: problemaBuscaIncompleta(paginas), resumo };
  }

  const leitura = await lerBaseInfoDosItens(client, [...candidatos.keys()]);
  const proprios = new Set<number>();
  for (const v of e.vinculosDoProduto) {
    const itemId = itemIdDoVinculo(v.raw);
    if (itemId !== null) proprios.add(itemId);
  }

  const definitivos: number[] = [];
  const indecidiveis: number[] = [];
  const vinculadas: number[] = [];
  const ordenados = [...candidatos].sort(([a], [b]) => a - b);
  for (const [itemId, linhaDaLista] of ordenados) {
    const base = leitura.linhas.get(itemId) ?? null;
    if (base !== null && ehKitDe(base, linhaDaLista)) continue;
    const reportado = skuReportado(base);
    const skuIgual = reportado === sku;
    // Another SKU — or a REPORTED blank one — is never the attempt's listing.
    if (!skuIgual && reportado !== null) continue;
    const posicao = criadoNaJanelaShopee(base?.create_time ?? null, e.janela.desdeMs);
    // Created BEFORE the window: an older listing, never the attempt's.
    if (posicao === 'fora') continue;

    if (proprios.has(itemId)) {
      if (skuIgual) vinculadas.push(itemId);
      continue;
    }
    const link = await resolverLinkPorItemId(db, e.integracaoId, itemId);
    if (link !== null) {
      // Already some produto's listing in this conta: this produto's own (the
      // import's `add`) is a doubt; another produto's is not this attempt's.
      if (link.produtoId === e.produtoId && skuIgual) vinculadas.push(itemId);
      continue;
    }
    if (skuIgual && posicao === 'dentro') definitivos.push(itemId);
    else indecidiveis.push(itemId);
  }

  const resumo: ResumoDaBuscaIncerta = {
    varreu: true,
    paginas,
    chamadas: paginas + leitura.chamadas,
    candidatos: candidatos.size,
  };
  const veredicto = decidir(e, resumo, { definitivos, indecidiveis, vinculadas });
  // eslint-disable-next-line no-console -- one line per look-up: ids, counts and the verdict token
  console.info('[shopee/anuncios] busca da criação incerta', {
    integracaoId: e.integracaoId,
    produtoId: e.produtoId,
    veredicto: veredicto.tipo === 'recusar' ? veredicto.problema.motivo : veredicto.tipo,
    definitivos,
    indecidiveis,
    vinculadas,
    paginas,
    candidatos: candidatos.size,
  });
  return veredicto;
}

/** The verdict over a COMPLETE scan's three classes — see the module docblock. */
function decidir(
  e: Pick<EntradaDaBuscaIncerta, 'produtoId' | 'confirmarCriacaoIncerta'>,
  resumo: ResumoDaBuscaIncerta,
  c: {
    readonly definitivos: readonly number[];
    readonly indecidiveis: readonly number[];
    readonly vinculadas: readonly number[];
  },
): VeredictoDaBuscaIncerta {
  const todos = [...c.definitivos, ...c.indecidiveis, ...c.vinculadas].sort((a, b) => a - b);
  // ⚠️ Not overridable: no attestation makes an ambiguous scan safe.
  if (c.indecidiveis.length > 0 || c.definitivos.length > 1) {
    return { tipo: 'recusar', problema: problemaAmbigua(todos, c.vinculadas, e.produtoId), resumo };
  }
  if (c.vinculadas.length > 0 && !e.confirmarCriacaoIncerta) {
    return {
      tipo: 'recusar',
      problema: problemaJaVinculada(todos, c.vinculadas, e.produtoId),
      resumo,
    };
  }
  const [unico] = c.definitivos;
  if (unico !== undefined) return { tipo: 'adotar', itemId: unico, resumo };
  return { tipo: 'prosseguir', resumo };
}
