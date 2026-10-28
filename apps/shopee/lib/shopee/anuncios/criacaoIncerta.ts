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
 * And, since #1911 P5b (Lucas, 2026-10-26), the FIRST create's own look-up
 * ({@link verificarAnuncioExistenteShopee}): before a `livre` draft's first
 * `add_item`, a listing the conta ALREADY holds with the SKU the body sends —
 * unlinked, or linked to another produto — refuses the create ("importe-o", or
 * "one SKU per produto"), the kit arm's same-SKU scan mirrored
 * (`kits/localizarKitPorSku.ts`, one walk for all three look-ups).
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
 * Two more codes are NOT rows, because their sentences name no field of the
 * request and so prove nothing about the create (#1911 batch-A review):
 *
 * - `error_nil_shopid_or_itemid` ("Query information failed.") — the product
 *   service's shared LOOKUP block, the same `(code, sentence)` beside
 *   `error_item_not_found` on update_item, update_stock, update_price,
 *   add_model, init_tier_variation, update_model and update_tier_variation.
 *   The stock and price classifiers read it as "anúncio inexistente" because
 *   THOSE requests carry an `item_id`; `add_item` carries none, so here it is
 *   an internal lookup that failed — before the insert or after it. Its
 *   sibling `error_nil_name_new_item` ("Item_name cannot be empty.") names a
 *   field and stays a row: `error_nil_*` is not a prefix.
 * - `error_data` ("parse data failed", "data not exist") — the GATEWAY's
 *   shared list, printed on every page between `error_network` ("Inner http
 *   call failed") and `error_server` ("Something wrong. Please try later."),
 *   and on the returns pages the same code carries "Inner error, please try
 *   later". "parse data failed" may be the gateway failing to parse the inner
 *   service's ANSWER to a create that happened; neither sentence is provably a
 *   validation of our request.
 *
 * Both cost the safe direction's price — one wait plus one ENSURE scan — and
 * no captured answer says either code ever arrives on a create.
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
 *  1. **The SKU the attempt SENT** (batch-A review) — `janela.sku`, stamped on
 *     the lock by the pre-send re-read and carried into `criacaoIncertaSku`
 *     (`janelaDaCriacaoIncertaShopee`), never the produto's SKU at re-publish
 *     time: a SKU set, cleared or renamed in between would look for the wrong
 *     listing — and skip the attempt's, then create a second. Both sides go
 *     through the import's own fold (`skuDoItemShopee`,
 *     `produtos/resolveProduto.ts` — shared, never copied: trim only).
 *     - recorded, and ≠ the produto's CURRENT fold ⇒ `criacao-incerta-ambigua`,
 *       never scanned and NOT attestable: the operator restores the SKU the
 *       attempt sent, or gives the listing and the produto one SKU and imports;
 *     - recorded `null` (UNKNOWN — a lock that never stamped it, or two
 *       attempts that sent two SKUs) ⇒ the current fold is looked up, and a
 *       REPORTED blank `item_sku` turns into a doubt (step 3) — that attempt
 *       may have sent none;
 *     - the SKU looked up folds BLANK (`''`, `'   '`, absent) ⇒
 *       `criacao-incerta-sem-sku`, NEVER scanned — a blank fold would "hit"
 *       every SKU-less listing (K2-21) — unless the operator attested
 *       (`confirmarCriacaoIncerta`), which then proceeds WITHOUT a scan (there
 *       is nothing to compare).
 *  2. **`get_item_list` narrowed to the attempt's window** —
 *     `update_time_from = inicioDaJanelaDaCriacaoShopeeS(desde)` (THE one
 *     computation, `@delfrance/schemas`) and NO `update_time_to`. The bound
 *     a scan could send is our clock's reading at scan time, and every write
 *     already made sits below it; it could drop only a listing whose
 *     `update_time` Shopee stamps AFTER that reading — a Shopee clock ahead of
 *     ours, or a write landing while the call is in flight: the fail-OPEN
 *     direction. Omitting it also keeps ENSURE clock-free. (A stock or a price
 *     write does NOT move `update_time` — register 94, probe P5, 2026-09-21 —
 *     so neither argues either way.) The lower bound alone narrows the walk,
 *     at an accepted price: the window is fixed at the attempt, so it only
 *     WIDENS while the record stands, and an unfrozen offset walk over more
 *     than one page can skip a row a write moves mid-walk (a frozen `[from,
 *     to]` would not help: its set SHRINKS as rows leave, and it would bring
 *     back the drop above). "A page or two" holds for a re-publish soon after
 *     the 202 — a late one on a busy shop can hit the ceiling on every try
 *     (`anuncios/README.md`, accepted residual; settle-live row 310 asks
 *     whether Shopee honours a lone `update_time_from` at all). Statuses
 *     NORMAL/UNLIST/REVIEWING/BANNED (a deleted listing is never a
 *     duplicate), at most {@link MAX_PAGINAS_BUSCA_ANUNCIO} pages, the kit
 *     walk's cursor rules verbatim. Incomplete ⇒ `busca-de-anuncio-incompleta`.
 *  3. **One base-info batch** over every row that is not a KIT (`add_item`
 *     never creates one; an unknown `tag` stays a candidate). A row created
 *     `fora` (before the window, {@link criadoNaJanelaShopee}) or reporting
 *     ANOTHER SKU (a reported blank one included, when the sent SKU is known)
 *     is ignored. Every other row — SKU equal, or a DOUBT (Shopee reported NO
 *     `item_sku`: `null`, or no base row at all; or a blank one while the sent
 *     SKU is unknown) — created `dentro` or `desconhecido`, is placed:
 *     - **DEFINITE** — unlinked, SKU equal, `dentro`;
 *     - **ALREADY LINKED** — SKU equal and linked in the conta, to THIS
 *       produto or to ANOTHER (`resolverLinkPorItemId`): it may be the
 *       attempt's own listing, linked by another path — the import's `add`,
 *       or (another produto) a SKU rung that declined a padded or shared SKU
 *       and MINTED a produto for it (batch-A review: the import matches more
 *       narrowly than this fold, so "another produto's" is no proof);
 *     - **UNDECIDABLE** — everything else: a doubt, linked or not (an
 *       own-linked listing whose SKU Shopee did not report is never ignored),
 *       or SKU equal, unlinked, `desconhecido`.
 *  4. **Verdict** — any undecidable, or 2+ definite ⇒ `criacao-incerta-ambigua`
 *     (`importar{itemIds, vinculados}`); else linked rows and no attestation ⇒
 *     `criacao-incerta-ja-vinculada` (`importar{itemIds, vinculados}`, each
 *     linked id with ITS produto); else exactly one definite ⇒ ADOPT it; else
 *     (a complete scan, nothing) ⇒ proceed, after the caller clears the record.
 *
 * ⚠️ `confirmarCriacaoIncerta` is honoured for EXACTLY two verdicts —
 * `-sem-sku` and `-ja-vinculada` (K1-11) — and never skips a scan of a
 * produto that HAS a SKU: an ambiguous (a moved SKU included) or incomplete
 * scan refuses whatever the flag says.
 *
 * ⚠️ The seven motivos — ENSURE's four and, since P5b, the first create's three
 * (`anuncio-existente-sem-vinculo`, `anuncio-existente-de-outro-produto`,
 * `busca-de-anuncio-existente-incompleta`) — are spelled HERE and only here,
 * through `MOTIVO_PUBLICACAO_BLOQUEADA` — never quoted
 * (`anuncios/errosPublicacao.test.ts` O7 reads this folder as raw text and
 * counts a quoted slug as a producer). A classifier row's label is its code, or
 * `<code>/<what>` — an underscore or a slash, which no slug carries.
 *
 * The classifier half is pure and total. ENSURE and the first create's
 * look-up read Shopee and the conta's links and WRITE NOTHING: the record and
 * the adoption are the reservation's token-guarded writes. No clock at all:
 * the window opens at the STORED attempt start, and nothing here asks what
 * time it is.
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
} from '@delfrance/integrations-shopee';
import {
  AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS,
  TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE,
  criadoNaJanelaShopee,
  inicioDaJanelaDaCriacaoShopeeS,
  itemIdEnderecavelShopee,
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
import { MAX_PAGINAS_BUSCA_KIT, STATUS_BUSCA_KIT } from '../kits/constantesKit';
import {
  clienteDaBuscaNoPrazo,
  fraseDaBaseInfoNaoDevolvida,
  localizarItensPorSku,
  varrerListaDeItensShopee,
  type BuscaPorSku,
} from '../kits/localizarKitPorSku';
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
  // NOT `error_data` — the gateway's "parse data failed" / "data not exist"
  // prove nothing about the create (module docblock).
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
  // NOT `error_nil_shopid_or_itemid` — "Query information failed." is a lookup
  // inside the service, not a field of our request (module docblock).
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
  /** Whether the re-send can look the listing up: the SKU the attempt SENT folds non-blank. */
  readonly reenvioVerificaSku: boolean;
  readonly recusa: RecusaDoAnuncioIncerto | null;
  /** The CLI's sentence (and the 202's undeclared `mensagem`). */
  readonly mensagem: string;
}

/**
 * The remedy of a listing that may exist but that the ERP cannot look up — the
 * attempt sent no SKU (batch-A review). ⚠️ Never "importe-o" ALONE: the import
 * binds a listing to an existing produto only on its SKU rung, so a SKU-less
 * listing is imported onto a NEW produto, this draft is never adopted, and
 * every exit left is a duplicate listing or a false attestation. The listing
 * first gets, in Seller Centre, the SKU the produto gets in the ERP; then the
 * import's SKU rung binds it to THIS produto and adopts this draft.
 */
const SE_EXISTIR_SEM_SKU =
  'se o anúncio existir, dê a ele no Seller Centre o MESMO SKU que você cadastrar neste ' +
  'produto e só então importe-o (importar:anuncio), que o vincula a este produto e adota este ' +
  'rascunho — sem SKU a importação cria OUTRO produto';

/**
 * The sentence of an uncertain create — what to do next, in the order the
 * operator does it. Two wordings, by whether the re-send can look the listing
 * up by SKU at all.
 */
export function mensagemDoAnuncioIncerto(reenvioVerificaSku: boolean): string {
  const minutos = String(AGUARDAR_ANUNCIO_INCERTO_SHOPEE_MS / 60_000);
  return reenvioVerificaSku
    ? `a Shopee pode ter criado o anúncio — aguarde ${minutos} minutos e publique de novo o MESMO ` +
        'rascunho: antes de qualquer novo add_item o ERP procura o anúncio pelo SKU enviado, e o ' +
        'vincula a este rascunho se ele existir; senão, o cria. Não mude o SKU do produto antes ' +
        'disso'
    : 'a Shopee pode ter criado o anúncio, e ele foi enviado sem SKU: o ERP não consegue ' +
        `procurá-lo. Aguarde ${minutos} minutos e confira no Seller Centre: ${SE_EXISTIR_SEM_SKU}; ` +
        'se não existir, publique de novo o mesmo rascunho confirmando a criação incerta ' +
        '(--confirmar-criacao-incerta)';
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
 * — the kit scan's list, ONE copy (a deleted listing is never a duplicate),
 * which THE walk (`varrerListaDeItensShopee`) sends for every caller.
 */
export const STATUS_BUSCA_ANUNCIO = STATUS_BUSCA_KIT;

/** What {@link localizarAnuncioIncerto} needs. */
export interface EntradaDaBuscaIncerta {
  readonly integracaoId: string;
  readonly produtoId: string;
  /**
   * The produto's STORED `sku` NOW, raw — folded here ({@link skuDaBuscaShopee})
   * and compared with the SKU the attempt SENT (`janela.sku`): it is looked up
   * only when that one is unknown (batch-A review).
   */
  readonly sku: string | null;
  /**
   * The attempt window, read BEFORE the reservation replaced the lock — its
   * start AND the SKU the attempt sent (`null` = unknown).
   */
  readonly janela: JanelaDaCriacaoIncertaShopee;
  /** The produto's links on this conta (`lerVinculosDaConta`) — "its OWN listings". */
  readonly vinculosDoProduto: readonly VinculoLidoDaConta[];
  /** The operator's attestation — honoured for `-sem-sku` and `-ja-vinculada` ONLY (K1-11). */
  readonly confirmarCriacaoIncerta: boolean;
  /**
   * The deadline checkpoint (#1911 batch-A review) — asked before EACH
   * `get_item_list` page and EACH base-info chunk; `false` ⇒ the look-up stops
   * with NO verdict and throws `BuscaForaDoPrazoShopeeError`
   * (`kits/localizarKitPorSku.ts`). A closure over the route's clock, built by
   * the reservation — this module reads none. Absent ⇒ no checkpoint.
   */
  readonly podeContinuar?: () => boolean;
}

/**
 * What one look-up spent and saw. The reservation reads TWO of its fields:
 * `varreu` (only a complete scan clears the record) and `skuBuscado` (the
 * first create's look-up is skipped only for THAT fold — #1911 batch-A
 * review); the rest is for the log line.
 */
export interface ResumoDaBuscaIncerta {
  /** `false` ⇔ no scan ran (a blank SKU, or a moved one). */
  readonly varreu: boolean;
  /**
   * The SKU fold this look-up searched the window for — `null` ⇔ `varreu` is
   * false. A body that sends any OTHER fold was never looked up here.
   */
  readonly skuBuscado: string | null;
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
    'a última tentativa de publicar este rascunho pode ter criado o anúncio na Shopee, e não há ' +
      `SKU para o ERP procurá-lo — confira no Seller Centre: ${SE_EXISTIR_SEM_SKU}; se não ` +
      'existir, publique de novo confirmando a criação incerta (--confirmar-criacao-incerta)',
  );
}

/** A SKU as a sentence names it: quoted, or "sem SKU". */
function skuNaFrase(sku: string): string {
  return sku === '' ? 'sem SKU' : `«${sku}»`;
}

/**
 * The produto's SKU moved between the uncertain attempt and this re-publish
 * (batch-A review): set, cleared or renamed. The listing is looked up by the
 * SKU the attempt SENT, so the produto's current one decides nothing — and
 * neither does a scan by the sent one, whose hit would then be ADOPTED under a
 * SKU the produto no longer has. NOT attestable (K1-11): the operator puts one
 * SKU on both sides.
 */
function problemaSkuMudou(enviado: string, atual: string): ProblemaDeBloqueio {
  return bloqueio(
    MOTIVO_PUBLICACAO_BLOQUEADA.criacaoIncertaAmbigua,
    `a última tentativa foi enviada ${enviado === '' ? 'sem SKU' : `com o SKU ${skuNaFrase(enviado)}`} ` +
      `e o produto agora está ${atual === '' ? 'sem SKU' : `com ${skuNaFrase(atual)}`} — o ERP só ` +
      'procura o anúncio pelo SKU que a tentativa enviou, e não decide. Confira no Seller Centre: ' +
      'se o anúncio existir, deixe o MESMO SKU nele e no produto e importe-o (importar:anuncio), ' +
      'que o vincula e adota este rascunho; se não existir, volte o SKU do produto ao enviado e ' +
      'publique de novo, ou descarte este rascunho confirmando a criação incerta',
  );
}

function problemaBuscaIncompleta(paginas: number): ProblemaDeBloqueio {
  return bloqueio(
    MOTIVO_PUBLICACAO_BLOQUEADA.buscaDeAnuncioIncompleta,
    `a busca pelo anúncio que a última tentativa pode ter criado não terminou (${String(paginas)} ` +
      'página(s) lida(s), ou um cursor da Shopee que não avança) — nada foi criado. Repetir só ' +
      'ajuda se foi o cursor: a janela da busca não encolhe com o tempo. Confira no Seller ' +
      'Centre: se o anúncio existir, importe-o (importar:anuncio); se não existir, descarte este ' +
      'rascunho confirmando a criação incerta e crie outro',
  );
}

/** A candidate a link of the conta already holds, with ITS produto. */
interface Vinculado {
  readonly itemId: number;
  readonly produtoId: string;
}

/** `importar{itemIds, vinculados}` — every id; the linked ones each with its OWN produto. */
function acaoImportar(
  itemIds: readonly number[],
  vinculados: readonly Vinculado[],
): AcaoSugeridaPublicacaoShopee {
  return {
    tipo: TIPO_ACAO_SUGERIDA_PUBLICACAO_SHOPEE.importar,
    itemIds: [...itemIds],
    vinculados: vinculados.map((v) => ({ itemId: v.itemId, produtoId: v.produtoId })),
  };
}

function problemaAmbigua(
  itemIds: readonly number[],
  vinculados: readonly Vinculado[],
): ProblemaDeBloqueio {
  return bloqueio(
    MOTIVO_PUBLICACAO_BLOQUEADA.criacaoIncertaAmbigua,
    'a última tentativa pode ter criado o anúncio, e a busca não conseguiu apontar UM só ' +
      `(item ${listaDeIds(itemIds)}: com o SKU que ela enviou e criados na janela da tentativa, ` +
      'ou sem SKU ou data de criação informados pela Shopee) — confira no Seller Centre e ' +
      'importe o anúncio certo (importar:anuncio) em vez de criar outro',
    acaoImportar(itemIds, vinculados),
  );
}

/**
 * Linked candidates (batch-A review): the sentence offers BOTH exits — the
 * listing IS the attempt's (it exists and is linked: this draft is the
 * redundant half, discarded with the attestation, never published again), or
 * it is a deliberate second listing (publish again, attesting). The ids go
 * LAST, so the 500-character cap trims ids — never the remedy; the `acao`
 * carries every one, each with its produto.
 */
function problemaJaVinculada(
  itemIds: readonly number[],
  vinculados: readonly Vinculado[],
  produtoId: string,
): ProblemaDeBloqueio {
  const nomeados = vinculados
    .slice(0, IDS_NA_FRASE)
    .map((v) =>
      v.produtoId === produtoId
        ? `${String(v.itemId)} (deste produto)`
        : `${String(v.itemId)} (do produto ${v.produtoId})`,
    );
  const mais =
    vinculados.length > IDS_NA_FRASE ? ` e mais ${String(vinculados.length - IDS_NA_FRASE)}` : '';
  return bloqueio(
    MOTIVO_PUBLICACAO_BLOQUEADA.criacaoIncertaJaVinculada,
    'pode ser o anúncio da última tentativa, já vinculado no ERP por outro caminho (tem o SKU ' +
      'enviado e foi criado na janela dela, ou sem data informada). No Seller Centre: se for ele, ' +
      'ele já existe — descarte ESTE rascunho confirmando a criação incerta, sem publicá-lo de ' +
      'novo; se é um segundo anúncio feito de propósito, publique de novo confirmando ' +
      `(--confirmar-criacao-incerta). Anúncio(s): ${nomeados.join(', ')}${mais}`,
    acaoImportar(itemIds, vinculados),
  );
}

/**
 * The SKU Shopee REPORTED for a row through the shared fold, or `null` when it
 * reported none — `item_sku: null`, or no base row at all. ⚠️ Not the fold's
 * `''`: a REPORTED blank SKU is data when the attempt is KNOWN to have sent a
 * non-blank one (and a doubt when what it sent is unknown — the caller's
 * call); an unreported one is always a doubt.
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
 * bound read off our clock could only drop a listing Shopee stamps AFTER that
 * reading, a skewed clock or a write racing the call: the fail-open direction,
 * so none is sent), one base-info batch, and one `resolverLinkPorItemId` per
 * row that could still matter. Every Shopee and Firestore failure propagates
 * (rule 6): the reservation hands its lock back, nothing having been sent.
 *
 * ⚠️ `e.podeContinuar` is asked before every page and every base-info chunk;
 * a `false` throws `BuscaForaDoPrazoShopeeError` with NO verdict — not even
 * on a definite hit already read (a cut mid-batch never decides) — and the
 * reservation answers 409 `PUBLICACAO_EXPIRADA`, the record KEPT.
 */
export async function localizarAnuncioIncerto(
  client: ShopeeClient,
  db: Firestore,
  e: EntradaDaBuscaIncerta,
): Promise<VeredictoDaBuscaIncerta> {
  const atual = skuDaBuscaShopee(e.sku);
  const enviado = e.janela.sku === null ? null : skuDaBuscaShopee(e.janela.sku);
  const semVarrer: ResumoDaBuscaIncerta = {
    varreu: false,
    skuBuscado: null,
    paginas: 0,
    chamadas: 0,
    candidatos: 0,
  };
  // ⚠️ The SKU moved since the attempt (batch-A review): never scanned, never
  // attestable — the sent one may find a listing the produto no longer names,
  // the current one cannot find the attempt's.
  if (enviado !== null && enviado !== atual) {
    return { tipo: 'recusar', problema: problemaSkuMudou(enviado, atual), resumo: semVarrer };
  }
  const sku = enviado ?? atual;
  if (sku === '') {
    // ⚠️ Never scanned: a blank fold would "hit" every SKU-less listing.
    return e.confirmarCriacaoIncerta
      ? { tipo: 'prosseguir', resumo: semVarrer }
      : { tipo: 'recusar', problema: problemaSemSku(), resumo: semVarrer };
  }
  /** A REPORTED blank SKU is a doubt only while what the attempt sent is unknown. */
  const brancoEhDuvida = enviado === null;

  // ⚠️ THE window opening (`@delfrance/schemas`), floored at 1 s: a corrupt
  // early record widens the walk — which then refuses as incomplete or
  // ambiguous — and never fails it open.
  const updateTimeFromS = Math.max(inicioDaJanelaDaCriacaoShopeeS(e.janela.desdeMs), 1);

  // THE walk (`kits/localizarKitPorSku.ts` — one copy, the two same-SKU scans
  // ride it too), narrowed to the window and capped at this look-up's ceiling.
  const { candidatos, paginas, completo } = await varrerListaDeItensShopee(client, {
    maxPaginas: MAX_PAGINAS_BUSCA_ANUNCIO,
    updateTimeFromS,
    // `add_item` never creates a kit. ⚠️ Only an explicit `true` drops the
    // row here: a row with no `tag` is decided by its base info below.
    candidato: (linha) => linha.tag?.kit !== true,
    registro: {
      origem: '[shopee/anuncios]',
      ids: { integracaoId: e.integracaoId, produtoId: e.produtoId },
    },
    ...(e.podeContinuar === undefined ? {} : { podeContinuar: e.podeContinuar }),
  });

  if (!completo) {
    const resumo = {
      varreu: true,
      skuBuscado: sku,
      paginas,
      chamadas: paginas,
      candidatos: candidatos.size,
    };
    return { tipo: 'recusar', problema: problemaBuscaIncompleta(paginas), resumo };
  }

  // Every chunk asks the checkpoint first: a cut between two chunks decides
  // nothing, a definite hit in the first one included.
  const leitura = await lerBaseInfoDosItens(clienteDaBuscaNoPrazo(client, e.podeContinuar), [
    ...candidatos.keys(),
  ]);
  const proprios = new Set<number>();
  for (const v of e.vinculosDoProduto) {
    const itemId = itemIdEnderecavelShopee(v.raw.item_id);
    if (itemId !== null) proprios.add(itemId);
  }

  const definitivos: number[] = [];
  const indecidiveis: number[] = [];
  /** The ALREADY-LINKED class: SKU equal, linked to this produto or another. */
  const vinculadas: number[] = [];
  /** Every candidate kept here that a link holds, with that link's produto. */
  const vinculados: Vinculado[] = [];
  const ordenados = [...candidatos].sort(([a], [b]) => a - b);
  for (const [itemId, linhaDaLista] of ordenados) {
    const base = leitura.linhas.get(itemId) ?? null;
    if (base !== null && ehKitDe(base, linhaDaLista)) continue;
    const reportado = skuReportado(base);
    const skuIgual = reportado === sku;
    const duvida = reportado === null || (reportado === '' && brancoEhDuvida);
    // Another REPORTED SKU is never the attempt's listing — a blank one
    // included, once the attempt is known to have sent a non-blank one. What
    // goes on is SKU-equal or a doubt.
    if (!skuIgual && !duvida) continue;
    const posicao = criadoNaJanelaShopee(base?.create_time ?? null, e.janela.desdeMs);
    // Created BEFORE the window: an older listing, never the attempt's.
    if (posicao === 'fora') continue;

    // Linked already — this produto's (the read, or the group query for a
    // link written after it) or ANOTHER produto's: the import matches more
    // narrowly than this fold (a padded or shared SKU declines its SKU rung
    // and MINTS a produto), so neither link proves the listing is not the
    // attempt's (batch-A review).
    const donoDoVinculo = proprios.has(itemId)
      ? e.produtoId
      : ((await resolverLinkPorItemId(db, e.integracaoId, itemId))?.produtoId ?? null);
    if (donoDoVinculo !== null) {
      vinculados.push({ itemId, produtoId: donoDoVinculo });
      // ⚠️ A doubt is never "already linked" (overridable): an own-linked
      // listing whose SKU Shopee did not report is UNDECIDABLE, never ignored.
      if (skuIgual) vinculadas.push(itemId);
      else indecidiveis.push(itemId);
      continue;
    }
    if (skuIgual && posicao === 'dentro') definitivos.push(itemId);
    else indecidiveis.push(itemId);
  }

  const resumo: ResumoDaBuscaIncerta = {
    varreu: true,
    skuBuscado: sku,
    paginas,
    chamadas: paginas + leitura.chamadas,
    candidatos: candidatos.size,
  };
  const veredicto = decidir(e, resumo, { definitivos, indecidiveis, vinculadas, vinculados });
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
    readonly vinculados: readonly Vinculado[];
  },
): VeredictoDaBuscaIncerta {
  const todos = [...c.definitivos, ...c.indecidiveis, ...c.vinculadas].sort((a, b) => a - b);
  // ⚠️ Not overridable: no attestation makes an ambiguous scan safe.
  if (c.indecidiveis.length > 0 || c.definitivos.length > 1) {
    return { tipo: 'recusar', problema: problemaAmbigua(todos, c.vinculados), resumo };
  }
  if (c.vinculadas.length > 0 && !e.confirmarCriacaoIncerta) {
    return {
      tipo: 'recusar',
      problema: problemaJaVinculada(todos, c.vinculados, e.produtoId),
      resumo,
    };
  }
  const [unico] = c.definitivos;
  if (unico !== undefined) return { tipo: 'adotar', itemId: unico, resumo };
  return { tipo: 'prosseguir', resumo };
}

/* -------------------------------------------------------------------------- */
/*    the FIRST create — a listing the conta already holds is never re-made    */
/* -------------------------------------------------------------------------- */

/**
 * What {@link verificarAnuncioExistenteShopee} answers — the look-up a DRAFT's
 * FIRST `add_item` runs (#1911 P5b).
 */
export interface VerificacaoDoAnuncioExistente {
  /** `false` ⇔ no scan ran: the create sends no SKU, so there is nothing to compare. */
  readonly varreu: boolean;
  /** `get_item_list` pages read. */
  readonly paginas: number;
  /** Shopee calls: the pages plus the base-info batch. */
  readonly chamadas: number;
  /** Empty ⇔ `add_item` may be sent; otherwise every refusal at once. */
  readonly problemas: readonly ProblemaDeBloqueio[];
}

/** The listings a full scan can hold: 100 per page, at the kit's ceiling. */
const ANUNCIOS_NA_BUSCA = MAX_PAGINAS_BUSCA_KIT * SHOPEE_MAX_PAGE_SIZE;

function problemaAnuncioExistenteSemVinculo(itemIds: readonly number[]): ProblemaDeBloqueio {
  return bloqueio(
    MOTIVO_PUBLICACAO_BLOQUEADA.anuncioExistenteSemVinculo,
    'já existe nesta conta da Shopee um anúncio com o SKU deste produto, sem vínculo com ' +
      'nenhum produto do ERP — importe-o (importar:anuncio) em vez de criar outro, e descarte ' +
      'este rascunho. A importação o liga a ESTE produto só quando o SKU gravado aqui é ' +
      'exatamente o do anúncio (sem espaços nas pontas) e nenhum outro produto do ERP o usa; ' +
      `senão ela cria um produto novo. Nada foi enviado. Anúncio(s): ${listaDeIds(itemIds)}`,
    acaoImportar(itemIds, []),
  );
}

function problemaAnuncioExistenteDeOutroProduto(
  vinculados: readonly Vinculado[],
): ProblemaDeBloqueio {
  const nomeados = vinculados
    .slice(0, IDS_NA_FRASE)
    .map((v) => `${String(v.itemId)} (do produto ${v.produtoId})`);
  const mais =
    vinculados.length > IDS_NA_FRASE ? ` e mais ${String(vinculados.length - IDS_NA_FRASE)}` : '';
  return bloqueio(
    MOTIVO_PUBLICACAO_BLOQUEADA.anuncioExistenteDeOutroProduto,
    'o SKU deste produto já está num anúncio desta conta da Shopee vinculado a OUTRO produto ' +
      'do ERP: dois produtos com um SKU só — a importação não saberia a qual deles ligar um ' +
      'anúncio novo, e a Shopee pode tratá-lo como duplicata. Dê a este produto (ou ao outro) ' +
      `um SKU próprio antes de publicar. Nada foi enviado. Anúncio(s): ${nomeados.join(', ')}${mais}`,
    acaoImportar(
      vinculados.map((v) => v.itemId),
      vinculados,
    ),
  );
}

/**
 * The incomplete scan, worded for ITS cause (#1911 batch-A review): the walk
 * stopped short (the ceiling or the cursor — the sentence predates the second
 * cause), or Shopee returned no base row for listed candidates (the shared
 * clause, `fraseDaBaseInfoNaoDevolvida`, which the kit refusal words alike).
 */
function problemaBuscaDoAnuncioExistenteIncompleta(
  busca: Pick<BuscaPorSku, 'incompleta' | 'paginas'>,
): ProblemaDeBloqueio {
  const inicio = 'a busca por um anúncio desta conta com o SKU deste produto não terminou';
  return bloqueio(
    MOTIVO_PUBLICACAO_BLOQUEADA.buscaDeAnuncioExistenteIncompleta,
    busca.incompleta?.causa === 'base-info'
      ? `${inicio}: ${fraseDaBaseInfoNaoDevolvida(busca.incompleta.itemIds)}`
      : `${inicio} (${String(busca.paginas)} página(s) lida(s): mais de ` +
          `${String(ANUNCIOS_NA_BUSCA)} anúncios, ou um cursor da Shopee que não avança) — nada ` +
          'foi criado. Repetir ajuda só se foi o cursor: acima desse tamanho a busca não cabe, ' +
          'como a do kit nativo',
  );
}

/**
 * The verdict of the first create's look-up over a same-SKU scan of ORDINARY
 * listings (`localizarItensPorSku`, `kit: false`) — pure. Empty ⇔ `add_item`
 * may be sent. Every kind found is reported at once (the kit's V2R1-06), each
 * kind ONE problema:
 *
 *  - the scan did not complete ⇒ `busca-de-anuncio-existente-incompleta` and
 *    nothing else (the kit's `busca-de-kit-incompleta` answer: a listing it
 *    never saw may exist) — the walk stopped short, OR a listed candidate came
 *    back with no base row (`incompleta.causa: 'base-info'`; the sentence names
 *    those ids);
 *  - a hit NO link of the conta holds ⇒ `anuncio-existente-sem-vinculo`,
 *    `acao` `importar{itemIds}` — "importe-o", never a second listing;
 *  - a hit linked to ANOTHER produto ⇒ `anuncio-existente-de-outro-produto`,
 *    `acao` `importar{itemIds, vinculados}` (every id with its produto: the
 *    mass import skips a linked listing, so the next step is that produto) —
 *    two produtos share the SKU, and the import cannot pick between them;
 *  - a hit linked to THIS produto is EXCLUDED: that is D15's second listing,
 *    which the reservation already refused or the operator confirmed
 *    (`confirmarSegundoAnuncio`).
 *
 * ⚠️ Not attestable: no flag of the publish overrides any of the three — the
 * remedy is the import, or a SKU of its own.
 */
export function problemasDoAnuncioExistente(
  busca: Pick<BuscaPorSku, 'completo' | 'achados' | 'incompleta' | 'paginas'>,
  produtoId: string,
): readonly ProblemaDeBloqueio[] {
  if (!busca.completo) return [problemaBuscaDoAnuncioExistenteIncompleta(busca)];
  const semVinculo: number[] = [];
  const deOutroProduto: Vinculado[] = [];
  for (const achado of busca.achados) {
    if (achado.vinculo === null) semVinculo.push(achado.itemId);
    else if (achado.vinculo.produtoId !== produtoId) {
      deOutroProduto.push({ itemId: achado.itemId, produtoId: achado.vinculo.produtoId });
    }
  }
  const problemas: ProblemaDeBloqueio[] = [];
  if (semVinculo.length > 0) problemas.push(problemaAnuncioExistenteSemVinculo(semVinculo));
  if (deOutroProduto.length > 0) {
    problemas.push(problemaAnuncioExistenteDeOutroProduto(deOutroProduto));
  }
  return problemas;
}

/**
 * **The FIRST create's same-SKU look-up** (#1911 P5b — Lucas, 2026-10-26: a
 * conta that already holds a listing with the produto's SKU is told to IMPORT
 * it, never handed a second one). Reads only.
 *
 * Runs immediately before a DRAFT's first `add_item`, under its lock, after
 * D15 — `publicarAnuncio.ts`'s `aplicarPublicacao`, for a reservation that
 * found the draft `livre` (an `incerta` one ran ENSURE instead, which already
 * scans) — on `itemSku`, the `item_sku` the planned body SENDS, folded here
 * through the import's own fold ({@link skuDaBuscaShopee}): the look-up asks
 * exactly what the body carries and what step 9's SKU rung will compare.
 *
 * - A body with NO SKU (the fold is blank) ⇒ no scan, nothing refused — there
 *   is nothing to compare, and a blank fold would "hit" every SKU-less
 *   listing. ZERO Shopee calls.
 * - Otherwise THE kit arm's scan, mirrored: `localizarItensPorSku` with
 *   `kit: false` (`kits/localizarKitPorSku.ts` — the same walk, the same
 *   100-page ceiling, un-narrowed, the same statuses, the same fold, one
 *   base-info batch, one link read per hit), then
 *   {@link problemasDoAnuncioExistente}.
 * - ⚠️ Nothing is created on a scan that cannot prove absence: a walk that
 *   stopped short AND a listed candidate Shopee returned no base row for
 *   (#1911 batch-A review — before it, such a row was silently "not a hit"
 *   and `add_item` went out) both answer
 *   `busca-de-anuncio-existente-incompleta`, the second naming the ids.
 *
 * Runs ONLY when this run's ENSURE did not already look up the very SKU the
 * body sends (`publicarAnuncio.ts`, `PublicacaoDeRascunho.skuJaBuscado`): a
 * `livre` draft, an attested SKU-less one, or a SKU renamed between the
 * reservation and the plan.
 *
 * ⚠️ Every Shopee and Firestore failure propagates untouched (rule 6) — the kit
 * arm's answer to a failed scan: nothing was sent, and the publish hands the
 * lock back unstamped.
 *
 * ⚠️ `e.podeContinuar` (#1911 batch-A review): the walk of a large shop can
 * outlive the request — and a run cut there dies with its lock UNSTAMPED. The
 * checkpoint is asked before every page and every base-info chunk; a `false`
 * throws `BuscaForaDoPrazoShopeeError` with NO verdict, which the publish
 * answers as its send gate's 409 `PUBLICACAO_EXPIRADA` (lock released, no
 * record written).
 */
export async function verificarAnuncioExistenteShopee(
  client: ShopeeClient,
  db: Firestore,
  e: {
    readonly integracaoId: string;
    readonly produtoId: string;
    /** The planned create body's `item_sku` (absent ⇔ the body sends none). */
    readonly itemSku: string | null | undefined;
    /** The deadline checkpoint (see above); absent ⇒ none. */
    readonly podeContinuar?: () => boolean;
  },
): Promise<VerificacaoDoAnuncioExistente> {
  const sku = skuDaBuscaShopee(e.itemSku);
  if (sku === '') return { varreu: false, paginas: 0, chamadas: 0, problemas: [] };

  const busca = await localizarItensPorSku(client, db, {
    integracaoId: e.integracaoId,
    sku,
    excluirItemIds: new Set<number>(),
    kit: false,
    ...(e.podeContinuar === undefined ? {} : { podeContinuar: e.podeContinuar }),
  });
  const problemas = problemasDoAnuncioExistente(busca, e.produtoId);
  // eslint-disable-next-line no-console -- one line per look-up: ids, counts and the verdict
  console.info('[shopee/anuncios] busca de anúncio com o mesmo SKU antes da primeira criação', {
    integracaoId: e.integracaoId,
    produtoId: e.produtoId,
    completo: busca.completo,
    incompleta: busca.incompleta?.causa ?? null,
    achados: busca.achados.map((a) => a.itemId),
    veredicto: problemas.length === 0 ? 'prosseguir' : problemas.map((p) => p.motivo),
    paginas: busca.paginas,
  });
  return { varreu: true, paginas: busca.paginas, chamadas: busca.chamadas, problemas };
}
