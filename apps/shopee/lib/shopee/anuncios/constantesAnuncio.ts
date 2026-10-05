/**
 * The constants the PUBLISH direction needs and the wire does not state.
 *
 * ⚠️ **The dividing line, and it is the whole point of this module.** Every bound
 * Shopee's own documentation states — how many tier levels, how many options per
 * tier, how many models per item, how many images, how many ids per
 * `unlist_item` batch, the upload's byte cap / content types / signing mode /
 * field name, the writable `item_status` set, the `condition` set — lives in
 * `@delfrance/integrations-shopee` and is imported from there. This module holds
 * only what the PACKAGE cannot know: a wait the docs never quantify, an
 * ordering choice between two documented paths, a fiscal placeholder, a paging
 * budget, a message cap, and one phrase we match on.
 *
 * A second copy of a documented bound is how two numbers drift: the sandbox
 * probe measured the max options per tier at 50 (the pages carry both 20 and 50)
 * and flipped ONE literal in the package. A local copy here would have kept the
 * old 20 alive with a comment claiming the two agree.
 *
 * So the rule is mechanised rather than remembered: **no constant declared in
 * this module may carry the package's `SHOPEE_`-prefixed naming** — that prefix
 * means "a bound the wire states" — and `errosPublicacao.test.ts` reads this
 * file's raw text and fails if one appears. (A `*_SHOPEE` SUFFIX is a different
 * thing and is fine: it says "our value, for Shopee".)
 */

/**
 * How long to wait after `add_item` before the FIRST `init_tier_variation` on
 * the item it just created.
 *
 * Shopee's own guidance is qualitative ("wait a few seconds"); there is no
 * documented bound and no read that reports readiness, so this is a CHOICE and
 * not a doc fact. It is spent exactly once per create-with-children, while the
 * item is still `UNLIST` and therefore invisible to buyers.
 *
 * ⚠️ It is a parameter to `deps.esperar`, never a timer built here: nothing
 * under `anuncios/` may read a clock (the app guide's rule, and a raw-text grep
 * enforces it), so the wait is the composition root's to perform.
 */
export const ESPERA_APOS_ADD_ITEM_MS = 5_000;

/**
 * Which of the two documented re-list paths to try FIRST.
 *
 * ⚠️ The annotation is load-bearing: widening the type to the union is what lets
 * the fallback branch compile instead of being narrowed away as dead code. ONE
 * literal orders both consumers (`publicarAnuncio.ts`'s re-list step and
 * `pausarAnuncio.ts`'s `reativar` fallback), so flipping it flips the whole
 * channel in one line.
 *
 * - `'unlist'` ⇒ `unlist_item {item_list: [{item_id, unlist: false}]}` first,
 *   falling through to `update_item {item_id, item_status: 'NORMAL'}` — and
 *   NOTHING else in that body (a status bundled with other fields is silently
 *   ignored on some listings).
 * - `'update_item'` ⇒ the same two calls, swapped. The code path is identical.
 *
 * **If both refuse, the entry is a failure carrying the real code — never a
 * third attempt.** There is no other re-list API for a shop item.
 *
 * ⚠️ **Measured, not guessed, and only half of it.** On 2026-09-17 the SG
 * sandbox re-listed a SELLER-created `UNLIST` item through
 * `unlist_item {unlist: false}` (`success_list: 1`, no failures), which is why
 * `'unlist'` is the first arm. The OTHER case — Shopee's own pre-launch
 * `UNLIST`, the one that answers `error_set_normal_unlisted_item` ("need to
 * publish delisted item first") — could not be produced on that shop and stays
 * UNMEASURED; the `update_item {item_status: 'NORMAL'}` fallback is what covers
 * it, and it has never been exercised against a real refusal.
 */
export const RELIST_PRIMEIRO: 'unlist' | 'update_item' = 'unlist';

/**
 * The only `measure_unit` this ERP sends in `tax_info`.
 *
 * Shopee's BR tax block requires the field; the ERP models no per-produto unit
 * for it, and every produto it publishes is sold by the piece.
 */
export const MEASURE_UNIT_SHOPEE = 'UN';

/**
 * What goes in `tax_info.ncm` when the resolved imposto carries no NCM.
 *
 * ⚠️ A placeholder, not a default the ERP believes. It is only ever reached when
 * the rest of the ten-member block IS complete — an incomplete block is OMITTED
 * whole (Lucas's Q2), never patched field by field — so it never stands in for a
 * produto whose fiscal data is simply missing.
 */
export const SEM_NCM_SHOPEE = '00';

/** The same placeholder for `tax_info.cest`. Same rule: never a partial block. */
export const SEM_CEST_SHOPEE = '00';

/**
 * The one logistics channel that refuses `pre_order`.
 *
 * A produto whose ERP crossdocking says "pre-order" still publishes on this
 * channel — with `pre_order` omitted, not with the channel dropped.
 */
export const CANAL_SEM_PRE_ORDER = 90021;

/**
 * How many `get_brand_list` pages the brand cascade may walk before giving up.
 *
 * The cascade's third rung resolves a `brand_id` to its name by paging Shopee's
 * per-category brand list, which is unbounded — a popular category runs to
 * thousands of brands, and paging all of it on every publish would make one
 * produto cost dozens of calls. Five pages is a budget, not a bound: past it the
 * cascade falls to its fourth rung (refuse on create, omit `brand` on update).
 *
 * ⚠️ NOT named `SHOPEE_*` on purpose — the wire states no such limit, and this
 * module's docblock explains why that prefix is reserved for the package. (The
 * design brief spelled it `SHOPEE_BRAND_MAX_PAGES`; renamed here so the
 * prefix rule can be mechanised instead of remembered.)
 */
export const MAX_PAGINAS_MARCAS = 5;

/**
 * The cap on one `ProblemaPublicacao.mensagem`, in characters.
 *
 * It lives HERE and `errosPublicacao.ts` imports it, for the reason
 * `respond.ts`'s `MAX_LOGGED_BODY` exists: a Shopee detail string is unbounded
 * and a `problemas[]` entry is persisted in `falhaPublicacao.problemas[]` AND
 * returned in a 422 body, so anything oversized is published twice. The two
 * error classes normalise every `mensagem` through
 * `limitarMensagemProblema`, so the bound holds by CONSTRUCTION rather than by
 * every producer remembering it.
 */
export const MAX_MENSAGEM_PROBLEMA = 500;

/**
 * Which `tax_info` policy this build implements.
 *
 * Lucas's Q2: when the ten-member BR block cannot be completed, the block is
 * OMITTED whole. The alternative arm — sending what we have and letting Shopee
 * refuse — was considered and not built, which is the only reason this constant
 * exists rather than being implied by the code: it names the decision so a
 * reader does not have to infer it from an absence.
 */
export const POLITICA_TAX_INFO: 'omitir' = 'omitir';

/**
 * The ONE Shopee refusal the publisher retries, matched as a substring.
 *
 * Shopee validates the BR tax block all-or-nothing and says so in
 * `error_param`'s detail. The retry re-sends the IDENTICAL body minus the
 * `tax_info` key, at most once, and records `taxInfoOmitido:
 * 'recusado-incompleto'`. It is bounded by construction (one call site, one
 * unwrapped retry), not by a counter.
 *
 * ⚠️ Shopee's own spelling, verbatim — including nothing of ours. A paraphrase
 * here silently turns the retry off: the match would never fire, the publish
 * would fail with a code nobody classified, and no test that asserts the retry
 * happens on THIS phrase would notice it was the phrase that changed.
 */
export const FRASE_TAX_INFO_INCOMPLETO =
  'all BR tax field should be empty or be filled at same time';
