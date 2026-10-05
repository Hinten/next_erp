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
 * ⚠️ **It matters most for a capture nobody has run yet.** Today's corpus is a
 * Singapore SANDBOX order and Shopee's own documentation samples. The first real
 * BR order carries a buyer's name, CPF and street address, and the guard has to
 * exist before that body is promoted, not after it.
 *
 * ## Three properties the scanner depends on
 *
 * 1. **Type-preserving.** A number redacts to a number, a string to a string,
 *    `null` stays `null`. A fixture exists to pin a SHAPE; replacing a number
 *    with `'REDACTED'` rewrites the very thing it is committed to record.
 * 2. **Idempotent.** Every placeholder derives from the leaf key and the value's
 *    TYPE, never from the value, so `redactWireBody(redactWireBody(x))`
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
 *    ⚠️ **ONE exception to the masked exit, and it is narrow**: a leaf under a
 *    segment of {@link REDACTED_SUBTREES_SEM_EXCECAO} — the buyer blocks of a
 *    RETURN (step 17, #1525) — is replaced even when Shopee masked it. The empty
 *    exit still holds there. The order recipient keeps the masked exit untouched.
 */

export type WireValue =
  | string
  | number
  | boolean
  | null
  | WireValue[]
  | { [key: string]: WireValue };

/**
 * Path **suffixes** whose leaf is redacted, matched against the last N segments
 * of a value's path.
 *
 * ⚠️ Array indices collapse to `*`, and an entry whose PARENT is an array must
 * spell that `*` out — matching is segment-by-segment with no wildcard
 * semantics, so `['payment_info', 'transaction_id']` matches nothing at all when
 * `payment_info` is a `z.array(...)`. Every entry below whose parent is an
 * object (`recipient_address`, `invoice_data`, `image_info`) is correct without
 * one; `payment_info` is the array, and carries the index — and so do step 17's
 * `image`, `images`, the list form of `dispute_text_reason` and the list's
 * `return` rows.
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
  //   `category_name` (taxonomy labels — the same class as `item_name`, and the
  //   single most actionable field on the push), and `item_name` itself, which
  //   `name` does NOT suffix-match: a listing title is not a person.
  ['violation_reason'],
  ['suggestion'],
  // ⚠️ `get_item_violation_info`'s per-entry twin of the two above: partial
  // failure there is IN-BAND (`fail_error` + `fail_message` inside `item_list[]`),
  // not a separate `failure_list`.
  ['fail_message'],

  // — fiscal. A chave de acesso identifies the nota, its issuer and its recipient.
  ['invoice_data', 'access_key'],

  // — a product image URL carries the shop and the listing, and image hosts log
  //   fetches; nothing offline needs the real one.
  ['image_info', 'image_url'],

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

/**
 * The replacement for a leaf, derived from its key and its TYPE and nothing else
 * — which is what makes the whole module idempotent.
 *
 * The SHAPED strings (a CEP that is eight digits, a CPF that is eleven, a CNPJ
 * that is fourteen, a chave de acesso that is forty-four) exist so a fixture
 * still exercises any length or format check downstream; a blanket `'REDACTED'`
 * in a `zipcode` would turn a parsing test into a test of the redactor.
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
      return 'https://redacted.invalid/imagem';
    default:
      return 'REDACTED';
  }
}

/**
 * True when `path` ends with any entry of {@link REDACTED_PATH_SUFFIXES}, or runs
 * under a segment of {@link REDACTED_PATH_SEGMENTS} or
 * {@link REDACTED_SUBTREES_SEM_EXCECAO}.
 */
export function isRedactedPath(path: readonly string[]): boolean {
  if (path.some((segment) => REDACTED_PATH_SEGMENTS.includes(segment))) return true;
  if (ehSubarvoreSemExcecao(path)) return true;
  return REDACTED_PATH_SUFFIXES.some((suffix) => {
    if (suffix.length > path.length) return false;
    const offset = path.length - suffix.length;
    return suffix.every((segment, i) => path[offset + i] === segment);
  });
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
  // ⚠️ Both exits are in the module header, and both are load-bearing: a masked
  // value is the EVIDENCE, an empty one is the region-empty wire fact. The masked
  // one is CLOSED under a return's buyer subtree (`REDACTED_SUBTREES_SEM_EXCECAO`)
  // and nowhere else — `recipient_address.name: '****'` still survives.
  if (typeof value === 'string') {
    if (value.trim() === '') return value;
    if (ehValorMascarado(value) && !ehSubarvoreSemExcecao(path)) return value;
  }
  const key = path[path.length - 1] ?? '';
  return placeholderFor(key, value);
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
