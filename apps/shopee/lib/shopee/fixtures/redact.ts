/**
 * Redaction for Shopee wire fixtures that are about to be **committed**.
 *
 * The Shopee-shaped sibling of `apps/mercado-livre/lib/marketplace/fixtures/redact.ts`
 * — a sibling, never an import: apps cannot import apps, and the denylist is the
 * half that is entirely per-provider anyway.
 *
 * ⚠️ **The exposure is not the capture; it is the COMMIT.** `__wire__/` is public
 * (this repository is Apache-2.0), so the redaction runs on the one path that
 * crosses that line, and `piiScan.ts` re-checks the committed corpus
 * independently.
 *
 * ⚠️ **It matters most for a capture nobody has run yet.** Today's corpus is
 * Singapore SANDBOX calls (reads, and step 19's kit-probe writes), Shopee's own
 * documentation samples and — since #1911 — BR PRODUCTION reads of the shop's
 * own LISTINGS and taxonomy. No BR ORDER has been promoted yet: the first one
 * carries a buyer's name, CPF and street address, and the guard has to exist
 * before that body is promoted, not after it. ⚠️ Its line titles
 * (`response.order_list.*.item_list.*.item_name`) are the shop's listing titles
 * too, and the four-segment title entry does not reach them by design — whether
 * they go is a decision to make BEFORE that body is promoted.
 *
 * ## Three properties the scanner depends on
 *
 * 1. **Type-preserving.** A number redacts to a number, a string to a string,
 *    `null` stays `null`. A fixture exists to pin a SHAPE; replacing a number
 *    with `'REDACTED'` rewrites the very thing it is committed to record.
 * 2. **Idempotent.** Every placeholder derives from the leaf's KEY — the last
 *    NON-index segment of its path, so a `string[]` leaf under `image_url_list`
 *    keys on `image_url_list`, never on the walker's `*` — and the value's TYPE,
 *    never from the value, so `redactWireBody(redactWireBody(x))`
 *    deep-equals `redactWireBody(x)`. That fixpoint is what lets `piiScan` ask
 *    "is this committed file already redacted?" instead of guessing at value
 *    regexes — it catches a denylisted path regardless of what it held.
 * 3. **Masked and empty values are kept VERBATIM**, and both are deliberate:
 *
 *    - A masked value (`'****'`, `'P******n'`, `'******64'`) carries nothing and
 *      IS the evidence — it is the shape `valorUtilizavel` in `packages/schemas`
 *      has to refuse, in both of the spellings observed so far. Replacing it with
 *      a plausible placeholder would delete the only wire proof that masking has
 *      two shapes.
 *    - An empty string is the OTHER thing that looks like absence and is not:
 *      Shopee legitimately leaves `town`/`district`/`city`/`state` empty by
 *      region (the SG sandbox order sends four of them beside a clear
 *      `full_address`). It carries no personal data by construction.
 *
 *    Both also keep the fixpoint trivially: they map to themselves.
 *
 *    ⚠️ **TWO exceptions to the masked exit, both narrow** — a leaf is replaced
 *    even when it contains a `*`:
 *
 *    - under a segment of {@link REDACTED_SUBTREES_SEM_EXCECAO} — the buyer
 *      blocks of a RETURN (step 17, #1525);
 *    - at one of {@link CAMINHOS_SEM_SAIDA_MASCARADA} — the item-read pages'
 *      title, description and SKUs (#1911). Shopee never masks the seller's
 *      OWN listing data, so a `*` there is evidence of nothing: it is text the
 *      shop typed (`*Promoção* …`), and the masked exit would have kept it
 *      verbatim — and as a redaction fixpoint, which `piiScan` reports only as
 *      an informational `masked` finding, never a failure.
 *
 *    The empty exit still holds at both. The order recipient keeps the masked
 *    exit untouched.
 *
 *    ⚠️ **A THIRD exit, scoped to two paths (#1911)**: a listing's or a
 *    model's SKU (`CAMINHOS_DE_SKU`) is kept when it is ALREADY a value that
 *    carries nothing — the BR capture script's keyed pseudonym
 *    (`SKU-` + eight lowercase hex) or step 19's probe marker (`SONDA-KIT…`).
 *    Anything else at those paths is replaced, a value with a `*` included
 *    (above). Like the other two exits it maps to itself, and a replaced value
 *    (`'REDACTED'`) never matches it, so the fixpoint holds. See
 *    {@link ehSkuSemConteudo}.
 */

export type WireValue =
  | string
  | number
  | boolean
  | null
  | WireValue[]
  | { [key: string]: WireValue };

/**
 * The two SKU suffixes of the item-read pages (#1911) — the listing's
 * `response.item_list.*.item_sku` (`get_item_base_info`) and the model's
 * `response.model.*.model_sku` (`get_model_list`). Both are also in
 * {@link REDACTED_PATH_SUFFIXES}; listing them HERE is what scopes the SKU exit
 * ({@link ehSkuSemConteudo}) to them and to nothing else.
 *
 * ⚠️ **Never bare.** A bare `['item_sku']` would also take the RETURN item's
 * `response.item.*.item_sku` (and the escrow's
 * `response.order_income.items.*.item_sku`), and a bare `['model_sku']` the
 * order line's `response.order_list.*.item_list.*.model_sku` — the SKUs the
 * SKU-cascade suites read off the committed order bodies. Those paths do not end
 * with either suffix, so they are not matched.
 */
export const CAMINHOS_DE_SKU: readonly (readonly string[])[] = [
  ['response', 'item_list', '*', 'item_sku'],
  ['response', 'model', '*', 'model_sku'],
];

/**
 * The SKU values that carry nothing, so the SKU exit keeps them — anchored, and
 * case-exact on purpose:
 *
 * - `SKU-` + EIGHT LOWERCASE hex — the BR capture script's keyed pseudonym
 *   (#1911). Upper-case hex, seven or nine digits: replaced.
 * - `SONDA-KIT` + `[0-9A-Z-]*` — step 19's probe markers (`SONDA-KIT`,
 *   `SONDA-KIT-M1`, `SONDA-KIT2`), invented for the probe and committed since.
 */
export const SKUS_SEM_CONTEUDO: readonly RegExp[] = [/^SKU-[0-9a-f]{8}$/, /^SONDA-KIT[0-9A-Z-]*$/];

/**
 * The listing's own TEXT on the item-read pages (#1911, Lucas 2026-11-04) — the
 * title and the description of a `get_item_base_info` row, the description in
 * BOTH of Shopee's forms: the plain `description` and an `extended`
 * description's text blocks (`description_info.extended_description.field_list.*.text`,
 * where the plain leaf arrives empty). Every entry starts at
 * `response.item_list.*`: the KEPT paragraph of {@link REDACTED_PATH_SUFFIXES}
 * says why three segments would be wrong. Spread into that list, and closed to
 * the masked exit with the SKU paths ({@link CAMINHOS_SEM_SAIDA_MASCARADA}) —
 * ONE list feeds both, so the two cannot drift apart.
 */
export const FOLHAS_DE_TEXTO_DO_ANUNCIO: readonly (readonly string[])[] = [
  ['response', 'item_list', '*', 'item_name'],
  ['response', 'item_list', '*', 'description'],
  [
    'response',
    'item_list',
    '*',
    'description_info',
    'extended_description',
    'field_list',
    '*',
    'text',
  ],
];

/**
 * The paths where the MASKED exit is closed besides a return's buyer subtrees
 * (the module header's property 3): the item-read text and the two SKU paths.
 * Shopee never masks the seller's own listing data, so a `*` there carries the
 * shop's text rather than proving a masking shape. The empty exit still holds.
 */
export const CAMINHOS_SEM_SAIDA_MASCARADA: readonly (readonly string[])[] = [
  ...FOLHAS_DE_TEXTO_DO_ANUNCIO,
  ...CAMINHOS_DE_SKU,
];

/**
 * Path **suffixes** whose leaf is redacted, matched against the last N segments
 * of a value's path.
 *
 * ⚠️ Array indices collapse to `*`, and an entry whose PARENT is an array must
 * spell that `*` out — matching is segment-by-segment with no wildcard
 * semantics, so `['payment_info', 'transaction_id']` matches nothing at all when
 * `payment_info` is a `z.array(...)`. Every entry below whose parent is an
 * object (`recipient_address`, `invoice_data`) is correct without one;
 * `payment_info` is the array, and carries the index — and so do step 17's
 * `image`, `images`, the list form of `dispute_text_reason` and the list's
 * `return` rows, and #1911's `item_list`, `model`, `video_info` and
 * `image_url_list`.
 *
 * ⚠️ **Suffixes, not bare key names, and that distinction is the whole design.**
 * `name` is `recipient_address.name` (a person) and it is also the neighbour of
 * `item_name`, `model_name`, `shipping_carrier` and every taxonomy label — which
 * is what most of the offline suite asserts on. A bare-key denylist would destroy
 * the second group to catch the first.
 *
 * ⚠️ Deliberately **KEPT**: `recipient_address.state`, `recipient_address.region`
 * and the order-level `region` (coarse, and the fiscal/estrangeiro logic keys on
 * them); `order_sn`, `package_number`, `shop_id`, `item_id`, `model_id`,
 * `order_item_id`, `line_item_id` (Shopee resource ids — every contract assertion
 * keys on them, and an order_sn identifies an order, not a person).
 *
 * ⚠️ `item_name` and `description` are kept everywhere EXCEPT the item-read
 * pages — `response.item_list.*.item_name` and `.description` (#1911, Lucas
 * 2026-11-04). A listing's own text can find the shop; an order line's title
 * (`response.order_list.*.item_list.*.item_name`) is ORDER data — the pedido
 * import maps it into `nomeDeVenda` (`pedidos/itens.ts`), and
 * `wireCorpus.test.ts` reds if a committed one reads `REDACTED` — and the kit
 * page's `response.product_info.*` and a push's
 * `data.item_name` are not item-read pages either. Hence FOUR segments, never
 * three: `['item_list', '*', 'item_name']` also matches the order line.
 *
 * ⚠️ `buyer_user_id` IS redacted, unlike Mercado Livre's `buyer.id`, and the
 * asymmetry is a decision: nothing in this corpus keys on it (Shopee's buyer
 * identity for the ERP is the CPF — there is no Shopee-buyer-id identity key in
 * `clienteIdentity`), so keeping a pseudonymous account handle would buy nothing.
 */
export const REDACTED_PATH_SUFFIXES: readonly (readonly string[])[] = [
  // — the natural person, on the address block
  ['recipient_address', 'name'],
  ['recipient_address', 'phone'],
  ['recipient_address', 'full_address'],
  ['recipient_address', 'town'],
  ['recipient_address', 'district'],
  ['recipient_address', 'city'],
  ['recipient_address', 'zipcode'],

  // — the buyer, wherever the two pages spell it
  ['buyer_cpf_id'],
  ['buyer_username'],
  // ⚠️ `get_escrow_detail`'s OTHER spelling of the same idea. Both, always.
  ['buyer_user_name'],
  ['buyer_user_id'],

  // — payment identifiers. `payment_processor_register` is a CNPJ.
  // ⚠️ **`payment_info` is an ARRAY on the wire** (`z.array(shopeePaymentInfoSchema)`),
  // so `walk` puts an index `*` between the parent and the leaf and the
  // two-segment spelling `['payment_info', <leaf>]` can NEVER match a real path.
  // These entries are spelled with the index for that reason, and the anchor
  // test builds an array-parented path so a two-segment respelling reds instead
  // of silently matching nothing. BR-only fields: today's corpus carries
  // `payment_info: null` (a Singapore order), so the first real BR body is the
  // first time either of these runs.
  ['payment_info', '*', 'payment_processor_register'],
  ['payment_info', '*', 'transaction_id'],

  // — free text a buyer or an operator typed: no denylist can anticipate what
  //   ends up in prose, so the whole field goes.
  ['message_to_seller'],
  ['note'],
  ['cancel_reason'],
  ['buyer_cancel_reason'],

  // — provider PROSE about a seller's listing (`push 16` /
  //   `get_item_violation_info`). Same class as the four free-text entries above
  //   and the same treatment: no denylist can anticipate what ends up in prose,
  //   and a real `violation_reason` reads as a full pt-BR sentence naming the
  //   product.
  //
  //   ⚠️ ONE segment each, and that is correct HERE: `item_status_details` and
  //   `deboost_details` are ARRAYS, so `walk` renders the path as
  //   `item_status_details.*.violation_reason` — and a SUFFIX match on a single
  //   segment matches it, in BOTH containers and under either spelling of the
  //   deboost key (`deboost_details` in the parameter table, `deboosted_details`
  //   in the page's own sample). The `payment_info` entries above need the index
  //   because they are spelled WITH their array parent; these are not.
  //
  //   Deliberately KEPT, because they carry no prose and every contract
  //   assertion keys on them: `violation_type` (a closed seven-value Shopee
  //   vocabulary, and what the aviso's `params.violacao` renders), `fail_error`
  //   (a CODE, not prose), `suggested_category[].category_id` /
  //   `category_name` (taxonomy labels, and the single most actionable field on
  //   the push), and the push's own `data.item_name`, which `name` does NOT
  //   suffix-match. ⚠️ `item_name` is kept everywhere EXCEPT the item-read
  //   pages (`response.item_list.*.item_name` and `.description`, #1911, Lucas
  //   2026-11-04): a listing's own text can find the shop, while an order line's
  //   title is order data the pedido import maps into `nomeDeVenda`.
  //   `get_item_violation_info`'s row
  //   IS such a page (`response.item_list.*`), so its title goes with the
  //   item-read entries below; the push's does not.
  ['violation_reason'],
  ['suggestion'],
  // ⚠️ `get_item_violation_info`'s per-entry twin of the two above: partial
  // failure there is IN-BAND (`fail_error` + `fail_message` inside `item_list[]`),
  // not a separate `failure_list`.
  ['fail_message'],

  // — fiscal. A chave de acesso identifies the nota, its issuer and its recipient.
  ['invoice_data', 'access_key'],

  // — a product image URL carries the shop and the listing, and image hosts log
  //   fetches; nothing offline needs the real one. ⚠️ ONE segment since #1911
  //   (it was `['image_info', 'image_url']`): the same leaf also sits on a tier
  //   option (`tier_variation.*.option_list.*.image.image_url`) and on a
  //   standardised variation option
  //   (`standardise_tier_variation.*.variation_option_list.*.image_url`), which
  //   no entry covered. The order line's `image_info.image_url` still matches.
  ['image_url'],

  // — a RETURN (step 17, #1525): the buyer's evidence, the buyer's prose and the
  //   reverse parcel, on `get_return_detail` and `get_return_list`. The buyer's
  //   identity and pickup address are whole SUBTREES, below. ⚠️ `image` and
  //   `images` are `string[]` on the wire, so each carries the `*` the walker
  //   pushes for an array level — the `payment_info` lesson above.
  ['image', '*'],
  // `item[].images` — the `image_info.image_url` class, one level deeper.
  ['images', '*'],
  // The buyer's free text — the same class as the four free-text entries above.
  ['text_reason'],
  // ⚠️ A STRING in the detail page's sample and a `string[]` in its table and in
  // the list page's sample — BOTH spellings, because a single-segment suffix
  // cannot match the array form (its last segment is the index).
  ['dispute_text_reason'],
  ['dispute_text_reason', '*'],
  // The detail sample prints `"username"`: a person or a party, unknown — and
  // `negotiation_status` already says whose turn it is, so nothing needs it.
  ['latest_offer_creator'],
  // TW non-integrated phone proxies — no BR body should carry them; redacted
  // anyway, because the guard has to exist before the first capture.
  ['virtual_contact_number'],
  ['package_query_number'],
  // The REVERSE leg's parcel id. ⚠️ Spelled with its parent on purpose: a bare
  // `['tracking_number']` would also take a forward-leg tracking number the
  // shipment fixtures may one day pin. `['response', 'tracking_number']` also
  // matches a future `get_tracking_number` capture — accepted: conservative, and
  // no forward body carries the key today.
  ['response', 'tracking_number'],
  ['return', '*', 'tracking_number'],

  // — the ITEM-READ pages (#1911): BR production reads of the shop's own
  //   listings. A listing's own text and media can find the shop in a public
  //   repository; nothing offline reads them by value.
  //
  //   The title and the description, FOUR segments each
  //   ({@link FOLHAS_DE_TEXTO_DO_ANUNCIO}; the KEPT paragraph above says why
  //   three would be wrong), with the masked exit closed. The BR capture script
  //   had already replaced every description with `REDIGIDO (n caracteres)`;
  //   this entry turns that into `REDACTED` (the README rows keep each `n`), so
  //   the next capture's description cannot reach a commit through a script
  //   that forgot — in either form: an `extended` description's text blocks
  //   (`description_info.extended_description.field_list.*.text`, where
  //   `description` arrives empty) go too, while the blocks' `image_info` stays
  //   (an image id, kept like every other). No committed body carries one yet.
  ...FOLHAS_DE_TEXTO_DO_ANUNCIO,
  //   Every listing image URL (`image`, `promotion_image`, a kit's `image`).
  //   ⚠️ A `string[]`, so the index is spelled — and the placeholder keys on
  //   `image_url_list`, the last NON-index segment (`walk`), which makes it the
  //   URL placeholder like `image_url`'s.
  ['image_url_list', '*'],
  //   The listing's size-chart IMAGE URL. An empty one keeps the empty exit
  //   (the kit bodies carry `""`).
  ['size_chart'],
  //   The listing's video. ⚠️ No placeholder case for either key: the return's
  //   `buyer_videos.*.{video_url,thumbnail_url}` already redact to `REDACTED`,
  //   and a case would rewrite that committed body.
  ['video_info', '*', 'video_url'],
  ['video_info', '*', 'thumbnail_url'],
  //   The listing's and each model's SKU — the scoped pair, with its value exit
  //   ({@link CAMINHOS_DE_SKU}, {@link ehSkuSemConteudo}).
  ...CAMINHOS_DE_SKU,
  //   ⚠️ Deliberately NOT here: the BR capture script's OWN placeholders, which
  //   are already values that carry nothing and stay verbatim —
  //   `imagem-redigida` (every `image_id_list` entry) and `LOCAL-REDIGIDO`
  //   (`location_id`). Its third, `REDIGIDO (n caracteres)` on `description`,
  //   is the one this list replaces (above).
];

/**
 * Path SEGMENTS whose whole subtree is redacted, whatever the leaf is called.
 *
 * ⚠️ `geolocation` is the one that needs this rather than a suffix pair: the page
 * documents `latitude`/`longitude`, an undocumented third key would be a
 * street-level coordinate under a name this list cannot predict, and there is no
 * legitimate reason to keep any leaf under it.
 */
export const REDACTED_PATH_SEGMENTS: readonly string[] = ['geolocation'];

/**
 * Path SEGMENTS whose whole subtree is redacted with **no masked exit** — the
 * buyer-identity blocks of a return (step 17, #1525).
 *
 * ⚠️ The masked exit (the module header's property 3) exists because
 * `valorUtilizavel` must be tested against Shopee's masking SHAPES on the ORDER
 * recipient. No ERP code reads these blocks at all — the package's returns
 * schemas STRIP them — so a masked value here is evidence of nothing, and a
 * masked e-mail still carries a domain and two letters, which `piiScan`'s e-mail
 * pattern reads as a leak: both doc samples print one (`get_return_detail` and
 * `get_return_list`), so a suffix entry alone would keep the masked value and
 * fail the corpus.
 *
 * - `user` — `{username, email, portrait}`, the buyer, on detail AND list rows.
 * - `return_pickup_address` — the buyer's address; coarse `state`/`region`
 *   included, unlike `recipient_address`: no ERP code reads either here.
 * - `buyer_videos` — `{thumbnail_url, video_url}`, buyer-shot evidence.
 *
 * An empty string is still kept (the region-empty fact), and the fixpoint holds:
 * every placeholder maps to itself. ⚠️ The deferred returns ops (`query_proof`'s
 * evidence, `get_reverse_tracking_info`'s door photos — R-5, out of v1) add their
 * own paths in the PR that ships them, beside the fixture that needs them.
 */
export const REDACTED_SUBTREES_SEM_EXCECAO: readonly string[] = [
  'user',
  'return_pickup_address',
  'buyer_videos',
];

/** A value Shopee itself already masked — kept verbatim. See the module header. */
export function ehValorMascarado(value: string): boolean {
  return value.includes('*');
}

/** True when `path` runs under a {@link REDACTED_SUBTREES_SEM_EXCECAO} segment. */
export function ehSubarvoreSemExcecao(path: readonly string[]): boolean {
  return path.some((segment) => REDACTED_SUBTREES_SEM_EXCECAO.includes(segment));
}

/** True when `path` ends with one of {@link CAMINHOS_SEM_SAIDA_MASCARADA} (#1911). */
export function ehCaminhoSemSaidaMascarada(path: readonly string[]): boolean {
  return CAMINHOS_SEM_SAIDA_MASCARADA.some((suffix) => terminaCom(path, suffix));
}

/**
 * The replacement for a leaf, derived from its key and its TYPE and nothing else
 * — which is what makes the whole module idempotent.
 *
 * The SHAPED strings (a CEP that is eight digits, a CPF that is eleven, a CNPJ
 * that is fourteen, a chave de acesso that is forty-four, a URL that is a URL)
 * exist so a fixture still exercises any length or format check downstream; a
 * blanket `'REDACTED'` in a `zipcode` would turn a parsing test into a test of
 * the redactor.
 *
 * ⚠️ `key` is the leaf's last NON-index segment (`walk`), so the three image-URL
 * keys share ONE placeholder whether the leaf is a scalar (`image_url`,
 * `size_chart`) or an element of a `string[]` (`image_url_list`). It is also
 * the BR capture script's own placeholder, so its bodies are fixpoints there.
 */
export function placeholderFor(
  key: string,
  value: string | number | boolean,
): string | number | boolean {
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return false;
  switch (key) {
    case 'zipcode':
      return '00000000';
    case 'phone':
      return '00000000000';
    case 'buyer_cpf_id':
      return '00000000000';
    case 'payment_processor_register':
      return '00000000000000';
    case 'transaction_id':
      return '000000';
    case 'access_key':
      return '0'.repeat(44);
    case 'full_address':
      return 'Rua Redacted, 0';
    case 'image_url':
    case 'image_url_list':
    case 'size_chart':
      return 'https://redacted.invalid/imagem';
    default:
      return 'REDACTED';
  }
}

/** True when the last `suffix.length` segments of `path` are `suffix`, segment by segment. */
function terminaCom(path: readonly string[], suffix: readonly string[]): boolean {
  if (suffix.length > path.length) return false;
  const offset = path.length - suffix.length;
  return suffix.every((segment, i) => path[offset + i] === segment);
}

/**
 * True when `path` ends with any entry of {@link REDACTED_PATH_SUFFIXES}, or runs
 * under a segment of {@link REDACTED_PATH_SEGMENTS} or
 * {@link REDACTED_SUBTREES_SEM_EXCECAO}.
 */
export function isRedactedPath(path: readonly string[]): boolean {
  if (path.some((segment) => REDACTED_PATH_SEGMENTS.includes(segment))) return true;
  if (ehSubarvoreSemExcecao(path)) return true;
  return REDACTED_PATH_SUFFIXES.some((suffix) => terminaCom(path, suffix));
}

/**
 * The SKU exit (#1911): `value` sits at one of {@link CAMINHOS_DE_SKU} AND is one
 * of {@link SKUS_SEM_CONTEUDO}. Both halves, always — a pseudonym-shaped string
 * at any OTHER denylisted path is replaced like any value, and any other SKU at
 * these two paths is replaced too.
 */
export function ehSkuSemConteudo(path: readonly string[], value: string): boolean {
  return (
    CAMINHOS_DE_SKU.some((suffix) => terminaCom(path, suffix)) &&
    SKUS_SEM_CONTEUDO.some((re) => re.test(value))
  );
}

/**
 * The key a leaf's placeholder derives from: the last segment that is not the
 * walker's array index `*`. `''` for a path made only of indices (a bare array
 * leaf at the root), which no denylist entry can match anyway.
 */
export function chaveDaFolha(path: readonly string[]): string {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    if (path[i] !== '*') return path[i] ?? '';
  }
  return '';
}

function walk(value: WireValue, path: readonly string[]): WireValue {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((entry) => walk(entry, [...path, '*']));
  if (typeof value === 'object') {
    const out: { [key: string]: WireValue } = {};
    for (const [key, entry] of Object.entries(value)) out[key] = walk(entry, [...path, key]);
    return out;
  }
  if (!isRedactedPath(path)) return value;
  // ⚠️ The exits are in the module header, and each is load-bearing: a masked
  // value is the EVIDENCE, an empty one is the region-empty wire fact. The masked
  // one is CLOSED under a return's buyer subtree (`REDACTED_SUBTREES_SEM_EXCECAO`)
  // and at the item-read text and SKU paths (`CAMINHOS_SEM_SAIDA_MASCARADA`,
  // #1911), and nowhere else — `recipient_address.name: '****'` still survives.
  // The SKU one (#1911) opens only at the two SKU paths, and only for a value
  // that already carries nothing.
  if (typeof value === 'string') {
    if (value.trim() === '') return value;
    if (
      ehValorMascarado(value) &&
      !ehSubarvoreSemExcecao(path) &&
      !ehCaminhoSemSaidaMascarada(path)
    ) {
      return value;
    }
    if (ehSkuSemConteudo(path, value)) return value;
  }
  // ⚠️ The last NON-index segment, never `path[path.length - 1]`: for a
  // `string[]` leaf that is the walker's `*`, which no placeholder case can
  // name — `image_url_list` would redact a URL into `'REDACTED'`.
  return placeholderFor(chaveDaFolha(path), value);
}

/**
 * Deep-copy `value` with every denylisted leaf replaced.
 *
 * ⚠️ `null` comes back untouched rather than materialised into a placeholder. A
 * key Shopee sent as `null` carries no personal data, and `null` vs absent vs
 * zero-filled is exactly the distinction a raw wire fixture exists to record —
 * `invoice_data: null` (non-BR) and `payment_info: null` are both on the SG
 * sandbox order.
 */
export function redactWireBody(value: WireValue): WireValue {
  return walk(value, []);
}
