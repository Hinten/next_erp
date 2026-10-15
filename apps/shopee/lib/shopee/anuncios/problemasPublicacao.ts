/**
 * One Shopee refusal → one {@link ProblemaPublicacao} on a REQUEST field
 * (#1519, step 11).
 *
 * The publisher sends up to seven calls per produto, and any of them can be
 * refused for a reason that is a property of ONE field of the body — a stale
 * attribute, a category that stopped accepting pre-order, a title one character
 * too long. Without this module such a refusal would surface as a transport
 * error (502 `SHOPEE_HTTP_ERROR`) and the operator would be told Shopee is
 * broken when in fact one field of one produto was rejected. That is the whole
 * reason the classifier exists, and it is the issue body's own requirement.
 *
 * ## How a code is matched
 *
 * Shopee spells the same error two ways: `product.error_param` in a page's
 * Error-example block and the bare `error_param` in its error LIST. The prefix is
 * stripped with the PACKAGE's `shopeeCodeSemPrefixoDeModulo` — the one stripper
 * there is — and never with a local copy: `classifyShopeeError` keys its own
 * lookup on the same fold, and two regexes for one normalisation is how the two
 * drift apart while both look right.
 *
 * Each family row carries three keys, tried in this order for that row:
 *
 *  - `codigos` — the STRIPPED code, exactly. Only SPECIFIC codes appear here.
 *  - `prefixos` — a code-family prefix (`error_category…`), because Shopee's
 *    published error lists are not exhaustive and a sibling code should land in
 *    the same family rather than in `desconhecido`.
 *  - `frases` — an EXACT substring of Shopee's `message`. That is how the
 *    generic codes are classified: `error_param` alone says nothing, and its
 *    detail sentence is what names the field.
 *
 * ⚠️ **The table is ORDERED and the first match wins.** The order carries real
 * decisions: `error_item_in_promotion` is a category refusal when its message
 * says so and a promotion lock otherwise, so the category row sits above the
 * promotion row; and the shop's stock BAND (`Stock should be within 2-1000000`)
 * sits above the generic reserved-stock family, or a produto refused for being
 * below the shop minimum would be classified as `desconhecido` and the operator
 * would never learn the band.
 *
 * ⚠️ **The phrase match is EXACT — no trim, no case fold.** `avisoDeShopee`'s
 * rule, for its reason: a sentence Shopee chose to send in a different case is a
 * string we have not measured, and folding it would be an equivalence fold in the
 * #1372 sense. A message wrongly classified as `desconhecido` still carries
 * Shopee's own prose to the operator; a message wrongly classified onto a field
 * points them at the wrong one.
 *
 * ⚠️ **ONE row is not a phrase row: the size-chart TEMPLATE refusal** (step 18).
 * "Is this the stale-template refusal?" is already decided by the size-chart
 * routes — `classificarRecusaTabelaMedidas`, which requires the code
 * `error_param` and reads Shopee's RAW sentence (`providerMessage`) through the
 * app's shared fold. A second, exact-substring spelling of the same question here
 * disagreed with it both ways (a lowercase or `Wrong parameters, detail:`-prefixed
 * sentence was stale for the routes and `desconhecido` here; the sentence under
 * `error_data` was the reverse) — the #1369 drift. So the row CALLS that
 * classifier ({@link FamiliaProblema.recusa}), holds no needle of its own, and
 * is the table's FIRST row, so no earlier phrase can claim the same error: what
 * the routes call a stale template is, by construction, what publish calls one,
 * in both directions. It needs the ERROR (code AND provider sentence), which is
 * why only {@link problemasDeErroShopee} can reach it.
 *
 * ## Whose prose `mensagem` carries
 *
 * `mensagem` is the provider's, verbatim, through
 * {@link limitarMensagemProblema}. Everywhere else in this folder a `mensagem` is
 * a MECHANISM sentence we wrote; here it is Shopee's sentence about the seller's
 * OWN listing, and it is the only human-readable text an operator gets about a
 * refusal we could not attribute. It is published TWICE — in a 422 body and in
 * the link document's `falhaPublicacao.problemas[]` — so it is capped, and
 * nothing else about the request is ever added to it.
 *
 * ⚠️ TWO rows override it with OUR sentence, both step 18's, because Shopee's
 * prose points the operator at the wrong fix. The size-chart IMAGE validator
 * answers "Upload failed, please upload a more standard size chart image." —
 * which reads as a failed upload of the listing's pictures, when the fix is to
 * change the TABELA's first photo or to pick a template. The stale TEMPLATE
 * answers in English with no action at all, when the fix is a re-pick in
 * `/medidas` (Lucas's Q4 wording, {@link MENSAGEM_TABELA_MEDIDAS_RECUSADA}). Both
 * sentences are exported; the photo one so the publisher reports a photo Shopee
 * refused to UPLOAD with the same words.
 *
 * ## What never reaches this module
 *
 * A rate limit, a reauth, a network failure, a non-2xx and a schema refusal are
 * not properties of this listing: they propagate untouched and `core/respond.ts`
 * maps them. {@link problemasDeErroShopee} answers `[]` for every one of them,
 * which is what makes the caller's `problemas` empty rather than misleading.
 *
 * ⚠️ There is deliberately NO "incomplete tax block" motivo, here or in any of the
 * three vocabularies (C14) — and this docblock does not spell the slug it refuses,
 * because the test that pins its absence reads this file as raw text. Lucas chose
 * the OMIT arm for `tax_info`: a block we cannot complete is left out of the body,
 * so nothing refuses a publish for it. The two codes that mean "Shopee did not
 * accept the block we SENT" classify as `imposto-recusado`.
 *
 * Pure: no Firestore, no Shopee call, no clock.
 */
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  shopeeCodeSemPrefixoDeModulo,
} from '@delfrance/integrations-shopee';

import {
  MOTIVO_RECUSA_TABELA_MEDIDAS,
  classificarRecusaTabelaMedidas,
} from '../tabelaMedidas/recusaTabelaMedidas';
import { FRASE_TAX_INFO_INCOMPLETO } from './constantesAnuncio';
import {
  MOTIVO_PROBLEMA_PUBLICACAO,
  type MotivoProblemaPublicacao,
  type ProblemaPublicacao,
  limitarMensagemProblema,
} from './errosPublicacao';

/**
 * The size-chart IMAGE validator's refusal (announcement 1337, on the
 * `add_item` AND `update_item` error lists: `product.error_busi: Upload failed,
 * please upload a more standard size chart image.`) — the exact, case-sensitive
 * substring this table matches. The sentence's tail on purpose: "Upload failed"
 * alone would also match an unrelated upload refusal. Whether it is per photo
 * or per call is register 268.
 */
export const FRASE_TABELA_MEDIDAS_FOTO_RECUSADA = 'please upload a more standard size chart image';

/**
 * OUR sentence for a size-chart photo SHOPEE refused — its image validator, or
 * its `upload_image` — what to DO, in pt-BR (module docblock).
 */
export const MENSAGEM_TABELA_MEDIDAS_FOTO_RECUSADA =
  'foto da tabela de medidas recusada pela Shopee — troque a primeira foto da tabela ou escolha um modelo em /medidas';

/**
 * OUR sentence for a size-chart photo that never reached Shopee's judgement — a
 * download that failed (a network blip included), a file the publisher skips
 * (type, size, host), a missing arquivo, an upload answered without an id. Not
 * "recusada pela Shopee": Shopee never saw it, and the first thing worth doing is
 * trying again; only a repeat says the photo itself is the problem.
 */
export const MENSAGEM_TABELA_MEDIDAS_FOTO_NAO_ENVIADA =
  'não foi possível enviar a foto da tabela de medidas — tente de novo; se repetir, troque a primeira foto ou escolha um modelo em /medidas';

/**
 * OUR sentence for a stale TEMPLATE — the id we sent is one the shop no longer
 * has (deleted in Seller Centre). Lucas's Q4 wording: the pick is the
 * operator's, so the fix is a re-pick, never a retry without it.
 */
export const MENSAGEM_TABELA_MEDIDAS_RECUSADA =
  'tabela de medidas recusada pela Shopee — escolha outra em /medidas';

/**
 * The template row's match: the size-chart routes' OWN classifier (module
 * docblock), never a second spelling of its needle.
 */
function ehTabelaDeMedidasInexistente(err: ShopeeApiError): boolean {
  return classificarRecusaTabelaMedidas(err) === MOTIVO_RECUSA_TABELA_MEDIDAS.tabelaInexistente;
}

/** One row of the classification table. */
interface FamiliaProblema {
  /** For the test that walks the table — never rendered anywhere. */
  readonly rotulo: string;
  /** Stripped codes, matched exactly. */
  readonly codigos?: readonly string[];
  /** Stripped-code prefixes, for the families whose published list is open. */
  readonly prefixos?: readonly string[];
  /** Exact substrings of Shopee's `message`. */
  readonly frases?: readonly string[];
  /**
   * A predicate over the ERROR itself, for the one row whose rule already
   * exists elsewhere (the size-chart template, module docblock). Never reached
   * by the string form {@link problemaDeErroShopee}, which has no error.
   */
  readonly recusa?: (err: ShopeeApiError) => boolean;
  readonly campo: string | null;
  readonly motivo: MotivoProblemaPublicacao;
  /** Overrides {@link FamiliaProblema.campo} when the field is in the code or the message. */
  readonly campoDerivado?: (codigo: string, mensagem: string) => string | null;
  /**
   * OUR sentence in place of Shopee's — for the two size-chart rows, whose
   * provider prose points the operator at the wrong fix or at none (module
   * docblock). Absent everywhere else: Shopee's prose is the default.
   */
  readonly mensagem?: string;
}

/**
 * Which request field a promotion lock names, read off the code's own noun.
 *
 * ⚠️ Shopee spells the SAME lock three ways — `error_cannt_edit_name_in_promotion`,
 * `error_in_item_promotion_name_item_lock` and
 * `error_model_update_name_model_in_promotion` — so the noun, not the whole code,
 * is what identifies the field. Matching only one spelling would report two of
 * the three as "unknown field" on a listing that is simply inside a promotion.
 *
 * ORDER matters: `tier_variation` is tested before the shorter nouns so a tier
 * lock is not read as something else, and `estimated_days` before `pre_order`
 * because both land on the same field and the longer noun is the specific one.
 */
const CAMPO_POR_SUBSTANTIVO: readonly (readonly [string, string])[] = [
  ['tier_variation', 'standardise_tier_variation'],
  ['estimated_days', 'pre_order'],
  ['pre_order', 'pre_order'],
  ['description', 'description'],
  ['image', 'image'],
  ['stock', 'seller_stock'],
  ['name', 'item_name'],
];

function campoDoBloqueioDePromocao(codigo: string): string | null {
  for (const [substantivo, campo] of CAMPO_POR_SUBSTANTIVO) {
    if (codigo.includes(substantivo)) return campo;
  }
  return null;
}

/**
 * `attribute_list`, refined to the ONE attribute Shopee bracketed in its message.
 *
 * The brackets are what make this deterministic — Shopee's own templates bracket
 * the name (`… [COLOR] …`), and a bare SCREAMING_SNAKE scan would pick words out
 * of a sentence. The ML `attributeIdsInMessage` technique, narrowed to the first
 * token because a `campo` is one path.
 */
function campoDeAtributo(mensagem: string): string {
  const achado = /\[([A-Z][A-Z0-9_]{2,})\]/.exec(mensagem);
  const token = achado?.[1];
  return token == null ? 'attribute_list' : `attribute_list[${token}]`;
}

/**
 * The classification table — ORDERED, first match wins.
 *
 * Every code and every phrase below is verbatim from Shopee's own `add_item` /
 * `update_item` / `init_tier_variation` / `update_tier_variation` / `unlist_item`
 * error lists, or from a refusal measured against the sandbox.
 */
const FAMILIAS: readonly FamiliaProblema[] = [
  {
    // Step 18: the TEMPLATE id we sent was refused. ⚠️ Decided by the
    // size-chart routes' OWN classifier — `error_param` plus the detail page's
    // stale-id sentence on `providerMessage`, folded — never by a phrase of this
    // table (module docblock): ONE rule for the routes and for publish. That
    // add_item / update_item answer a stale id that way is unverified (register
    // 264); an unmatched refusal still reaches the operator as `desconhecido`
    // with Shopee's prose. Not a retry: the pick is the operator's, and the fix
    // is a re-pick — which is what OUR sentence says.
    //
    // ⚠️ FIRST, ahead of every phrase row: a later slot would let an earlier
    // row's phrase (`Image not exist.`, `Invalid logistic info`, …) claim an
    // error the routes call a stale template, so the two verdicts would agree
    // only where no sentence carried both. First, publish says "stale template"
    // EXACTLY when the classifier does — no other row is consulted before it,
    // and it matches nothing the classifier does not.
    rotulo: 'tabela-de-medidas',
    recusa: ehTabelaDeMedidasInexistente,
    campo: 'size_chart_info',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasRecusada,
    mensagem: MENSAGEM_TABELA_MEDIDAS_RECUSADA,
  },
  {
    rotulo: 'categoria',
    codigos: [
      'error_invalid_category',
      // ⚠️ Shopee's own typo, on its own page. Kept because the wire sends it.
      'error_incalid_category',
      'error_category_is_block',
      'error_forbidden_category',
      'error_category_level',
      'error_category_path_count_limit',
      'error_category_dts',
      'error_param_category_not_support_pre_order',
    ],
    prefixos: ['error_category'],
    // `error_item_in_promotion` when the detail is about the category — which is
    // why this row sits ABOVE the promotion row.
    frases: ['can not set category'],
    campo: 'category_id',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.categoriaInvalida,
  },
  {
    rotulo: 'atributos',
    codigos: [
      'error_invalid_attribute',
      'error_less_required_attribute',
      'error_invalid_category_attribute',
      'error_invalid_attribute_value',
      'error_wrong_attrsnapshot',
      'error_value_name_required',
      'error_value_id_must_equal_zero',
      'error_busi_attribute_error',
      'error_attribute_fda_error',
    ],
    prefixos: ['error_attribute'],
    campo: 'attribute_list',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.atributoObrigatorio,
    campoDerivado: (_codigo, mensagem) => campoDeAtributo(mensagem),
  },
  {
    rotulo: 'marca',
    codigos: [
      'error_invalid_brand',
      'error_incalid_brand',
      'error_less_required_brand',
      'error_brand_forbidden',
      'error_duplicated_brand',
    ],
    prefixos: ['error_brand'],
    campo: 'brand',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.marcaSemNome,
  },
  {
    rotulo: 'logistica',
    codigos: ['error_invalid_logistic_info', 'error_invalid_price_for_logistic'],
    frases: ['logistic must be free', 'Invalid logistic info'],
    campo: 'logistic_info',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.logisticaSemCanal,
  },
  {
    rotulo: 'imagens',
    codigos: [
      'error_image_num_min',
      'error_image_unavailable',
      'error_desc_image_no_pass',
      'error_tier_img_partial',
      'error_tier_img_old_app',
    ],
    frases: ['Image not exist.'],
    campo: 'image',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.semFotos,
  },
  {
    // Step 18: the tabela's first photo, sent as an IMAGE chart, failed
    // Shopee's validator. On `size_chart_info`, never on `image` — the
    // listing's pictures are fine — and with OUR sentence (the docblock).
    rotulo: 'tabela-de-medidas-foto',
    frases: [FRASE_TABELA_MEDIDAS_FOTO_RECUSADA],
    campo: 'size_chart_info',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.tabelaDeMedidasFotoRecusada,
    mensagem: MENSAGEM_TABELA_MEDIDAS_FOTO_RECUSADA,
  },
  {
    rotulo: 'preco',
    codigos: [
      'error_invalid_price',
      'error_price_exceed_min_limitt',
      'error_price_exceed_max_limitt',
      'error_slash_price_not_lowest',
    ],
    campo: 'original_price',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.precoForaDaFaixa,
  },
  {
    // ⚠️ MEASURED (2026-09-17): the sandbox refused a create with `stock: 1` on a
    // shop whose `stock_limit.min_limit` was 2. The band is in the message and
    // nowhere else, so the phrase is the family — any code carrying it means the
    // same thing. ABOVE the generic stock row deliberately: below it, a produto
    // refused for being under the shop minimum would read as `desconhecido`.
    rotulo: 'estoque-abaixo-do-minimo',
    frases: ['Stock should be within'],
    campo: 'seller_stock',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.estoqueAbaixoDoMinimo,
  },
  {
    // No operator field in the ERP produces any of these — a reserved-stock
    // conflict, a multi-warehouse shop, a stock-structure change. Recorded as
    // `desconhecido` ON the field rather than guessed onto a motivo.
    rotulo: 'estoque-reservado',
    frases: [
      'Total stock must be more than reserved stock',
      'Stock should be larger than reserved stock',
      'stock less than reserve',
      'Can not update item with different stock structure',
      'Invalid stock location ID',
      'has multi warehouse',
    ],
    campo: 'seller_stock',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.desconhecido,
  },
  {
    rotulo: 'nome',
    codigos: [
      'error_item_name_empty',
      'error_nil_name_new_item',
      'error_item_name_is_too_short',
      'error_title_exceeds_max_length',
      'error_name_length_limit',
      'error_title_character_forbidden',
    ],
    campo: 'item_name',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.nomeForaDaFaixa,
  },
  {
    rotulo: 'descricao',
    codigos: ['error_desc_length_min_limit', 'error_desc_hash_tag_over_limit'],
    campo: 'description',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.descricaoForaDaFaixa,
  },
  {
    // ⚠️ `imposto-recusado`, never an "incomplete" motivo (C14): reaching this row
    // means we DID send a block and Shopee did not accept it.
    //
    // The all-or-nothing phrase is listed although `publicarAnuncio`'s one-shot
    // retry normally consumes it — if the same refusal comes back a second time
    // the honest classification is still `tax_info`, not `desconhecido`. It is
    // imported, not copied: one spelling of Shopee's sentence in the whole app.
    rotulo: 'imposto',
    frases: [
      FRASE_TAX_INFO_INCOMPLETO,
      'invalid additional information',
      'Please input the tax information',
    ],
    campo: 'tax_info',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.impostoRecusado,
  },
  {
    rotulo: 'dimensoes',
    frases: ['dimension is required'],
    campo: 'dimension',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.semDimensoes,
  },
  {
    rotulo: 'peso',
    frases: ['Invalid Weight.'],
    campo: 'weight',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.semPeso,
  },
  {
    rotulo: 'gtin',
    frases: ['The GTIN code is mandatory', 'This is not a valid GTIN'],
    campo: 'gtin_code',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.semGtin,
  },
  {
    rotulo: 'pre-order',
    codigos: [
      'error_invalid_days_to_ship',
      'error_param_dts_exceeds_max_limit',
      'error_estimated_days_limit',
    ],
    frases: ['can not use model level dts'],
    campo: 'pre_order',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.desconhecido,
  },
  {
    rotulo: 'modelos',
    codigos: [
      'error_tier_index',
      'error_duplicate_modelid',
      'error_wrong_modelid',
      'error_tier_var_level_not_same',
      'error_busi_cannot_delete_all_model',
      'error_model_invalid_model_id',
    ],
    prefixos: ['error_tier_var_is_'],
    frases: ['The level of tier-variation', 'Canot change the level', 'Model tier_index error.'],
    campo: 'model_list',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.variacaoSemVinculo,
  },
  {
    rotulo: 'opcoes',
    codigos: [
      'error_tier_opt_too_many',
      'error_tier_var_too_many',
      'error_tier_opt_val_too_long',
      'error_tier_var_name_too_long',
    ],
    frases: ['Count of tier_variation options should be under'],
    campo: 'standardise_tier_variation',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.opcoesDemais,
  },
  {
    rotulo: 'bloqueio-por-promocao',
    codigos: [
      'error_cannt_edit_name_in_promotion',
      'error_cannt_edit_description_in_promotion',
      'error_cannt_edit_image_in_promotion',
      'error_cannt_edit_pre_order_in_promotion',
      'error_cannt_edit_estimated_days_in_promotion',
      'error_in_item_promotion_image_item_lock',
      'error_in_item_promotion_name_item_lock',
      'error_in_item_promotion_description_lock',
      'error_cannt_edit_stock_in_promotion',
      'error_cannt_delete_option_in_promotion',
      'error_cannt_change_tier_variation_in_promotion',
      'error_cannt_be_no_variation_in_promotion',
      'error_model_update_name_model_in_promotion',
      'error_flash_sale_days_to_ship_lock',
      'error_item_in_promotion',
    ],
    campo: null,
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.bloqueadoPorPromocao,
    campoDerivado: (codigo) => campoDoBloqueioDePromocao(codigo),
  },
  {
    // The shop, not the item: a holiday mode, a penalty, an item-count ceiling.
    // Nothing about this produto's fields, so `desconhecido` on `shop`.
    rotulo: 'loja',
    codigos: [
      'error_reach_shop_item_limit',
      'error_holiday_on_add_item',
      'error_seller_under_penalty',
      'error_busi_invalid_shop_status',
      'error_busi_invalid_account_status',
      'error_auth_shop_not_found',
      'error_get_shop_fail',
      'error_busi_cannot_edit_vsku',
      'error_perm_non_admin',
    ],
    frases: ['Please wait for the holiday mode', 'cnsc shop not upgraded'],
    campo: 'shop',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.desconhecido,
  },
  {
    rotulo: 'listagem-removida',
    codigos: [
      'error_item_not_found',
      'error_item_or_variation_not_found',
      'error_item_uneditable',
      'error_busi_item_status_invalid',
    ],
    campo: 'item_id',
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.listagemRemovida,
  },
];

function casaFamilia(
  familia: FamiliaProblema,
  codigo: string,
  mensagem: string,
  erro: ShopeeApiError | null,
): boolean {
  if (familia.codigos?.includes(codigo) === true) return true;
  if (familia.prefixos?.some((p) => codigo.startsWith(p)) === true) return true;
  if (familia.frases?.some((f) => mensagem.includes(f)) === true) return true;
  return erro !== null && familia.recusa?.(erro) === true;
}

/** The ONE table walk, for both entry points below. */
function classificar(
  code: string,
  message: string,
  erro: ShopeeApiError | null,
): ProblemaPublicacao {
  const codigo = shopeeCodeSemPrefixoDeModulo(code) ?? code;
  for (const familia of FAMILIAS) {
    if (!casaFamilia(familia, codigo, message, erro)) continue;
    const campo = familia.campoDerivado?.(codigo, message) ?? familia.campo;
    return {
      campo,
      motivo: familia.motivo,
      mensagem: limitarMensagemProblema(familia.mensagem ?? message),
    };
  }
  return {
    campo: null,
    motivo: MOTIVO_PROBLEMA_PUBLICACAO.desconhecido,
    mensagem: limitarMensagemProblema(message),
  };
}

/**
 * Classify ONE Shopee refusal onto a request field, from its code and sentence.
 *
 * ⚠️ `code` is the RAW `error` string — module prefix and all. The strip happens
 * INSIDE, with the package's stripper, so no caller has to remember to do it and
 * no second spelling of the fold exists.
 *
 * An unmatched refusal answers `{campo: null, motivo: 'desconhecido'}` carrying
 * Shopee's prose. That is the safe direction: the operator sees what Shopee said
 * about their listing instead of being pointed at a field we guessed.
 *
 * ⚠️ This STRING form never yields `tabela-de-medidas-recusada`: that row is
 * decided over the ERROR (module docblock), and a code plus a sentence is not
 * one. Its only source caller is the re-list door, whose calls carry no size
 * chart; a thrown error goes through {@link problemasDeErroShopee}.
 */
export function problemaDeErroShopee(code: string, message: string): ProblemaPublicacao {
  return classificar(code, message, null);
}

/**
 * The `problemas[]` of one thrown Shopee error — `[]` for anything that is not a
 * per-listing API refusal.
 *
 * ⚠️ The gate is TWO conditions and both matter. `ShopeeNetworkError` /
 * `ShopeeHttpError` / `ShopeeSchemaError` are not `ShopeeApiError` at all; a rate
 * limit and a dead authorization ARE (they extend it) and are excluded by
 * `kind !== 'other'`. None of the five is a property of this listing, and
 * classifying one onto a request field would tell the operator to fix a produto
 * when the truth is that our call could not be made.
 *
 * ⚠️ The haystack AND the `mensagem` are `err.message`, the package's composed
 * sentence — `Shopee <path> respondeu <code> (HTTP <n>) — <Shopee's own
 * message>` — and not `err.providerMessage`, the raw sentence the package has
 * carried since step 14. For MATCHING the two agree: the composed string holds
 * Shopee's sentence verbatim (no trim, no fold, no cap), and every phrase spans
 * words while the prefix's only words are ours, so no family can match the path
 * or the code. The test drives the real `addItem` / `updateItem` to pin that,
 * with a near-miss whose empty provider message classifies nowhere. Switching
 * the `mensagem` would be a separate decision: it changes what every 422 body
 * and `falhaPublicacao` row already says. The ONE exception is the size-chart
 * template row, whose rule is the routes' classifier and reads
 * `providerMessage` (module docblock) — and whose `mensagem` is ours anyway.
 */
export function problemasDeErroShopee(err: unknown): readonly ProblemaPublicacao[] {
  if (!(err instanceof ShopeeApiError)) return [];
  if (err.kind !== SHOPEE_ERROR_KIND.other) return [];
  return [classificar(err.code, err.message, err)];
}
