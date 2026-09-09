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
 * of a value's path. Array indices collapse to `*` and never appear here.
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
  ['payment_info', 'payment_processor_register'],
  ['payment_info', 'transaction_id'],

  // — free text a buyer or an operator typed: no denylist can anticipate what
  //   ends up in prose, so the whole field goes.
  ['message_to_seller'],
  ['note'],
  ['cancel_reason'],
  ['buyer_cancel_reason'],

  // — fiscal. A chave de acesso identifies the nota, its issuer and its recipient.
  ['invoice_data', 'access_key'],

  // — a product image URL carries the shop and the listing, and image hosts log
  //   fetches; nothing offline needs the real one.
  ['image_info', 'image_url'],
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

/** A value Shopee itself already masked — kept verbatim. See the module header. */
export function ehValorMascarado(value: string): boolean {
  return value.includes('*');
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

/** True when `path` ends with any entry of {@link REDACTED_PATH_SUFFIXES}. */
export function isRedactedPath(path: readonly string[]): boolean {
  if (path.some((segment) => REDACTED_PATH_SEGMENTS.includes(segment))) return true;
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
  // value is the EVIDENCE, an empty one is the region-empty wire fact.
  if (typeof value === 'string' && (value.trim() === '' || ehValorMascarado(value))) return value;
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
