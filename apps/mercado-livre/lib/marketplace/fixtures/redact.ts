/**
 * Redaction for wire fixtures that are about to be **committed**.
 *
 * ## Why this is not in `fixtureCapture.ts`
 * That module's stated product is byte-faithfulness — "no mapping, no
 * normalisation, no key materialisation" — because a fixture that cannot tell
 * "ML sent null" from "ML omitted it" is worthless. Redacting there would break
 * the invariant it exists to hold, and it would also blind the raw
 * `out/fixtures/` drop that is used to diagnose live incidents.
 *
 * The exposure is not the capture; it is the COMMIT. `out/fixtures/` is
 * gitignored, so raw bodies there are exactly as exposed as they were before
 * this module existed. `__wire__/` is public. So the redaction runs in
 * `scripts/promote-fixtures.ts`, on the one path that crosses that line, and
 * `piiScan.ts` re-checks the committed corpus independently.
 *
 * ⚠️ **This matters most for a capture nobody has run yet.** Today's corpus is
 * ML test-user placeholders (`APRO`, CPF `12345678909`, `Avenida Paulista 1000`).
 * After the migration the same script points at REAL orders, and at that moment
 * an unredacted promote publishes a customer's street address to an Apache-2.0
 * repository. The guard has to exist before that run, not after it.
 *
 * ## Two properties the digest depends on
 * 1. **Type-preserving.** A number redacts to a number, a string to a string.
 *    `wireDigest` records `path: type`, so replacing `latitude: -23.56` with
 *    `"REDACTED"` would silently rewrite the very shape the fixture is committed
 *    to pin.
 * 2. **Idempotent.** Placeholders derive only from the leaf key and the value's
 *    type, never from the value, so `redact(redact(x))` deep-equals `redact(x)`.
 *    That is what lets `piiScan` use "is this file a redaction fixpoint?" as its
 *    strongest check — far stronger than guessing at value regexes, because it
 *    catches any denylisted path that slipped through regardless of what it held.
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
 * `name` is the single most overloaded key in ML's wire: `attributes[].name`,
 * `sale_terms[].name`, `variation_attributes[].name` and `shipping_method.name`
 * are product and carrier data, while `billing_info.name` and `cardholder.name`
 * are a person. A bare-key denylist would destroy the first group — which is what
 * most of the offline suite will assert on — to catch the second.
 *
 * ⚠️ Deliberately ABSENT: numeric ML account ids (`buyer.id`, `payer.id`,
 * `seller_id`, `players[].user_id`). They are pseudonymous account handles, they
 * are structurally load-bearing in almost every fixture, and the tier-2 contract
 * assertions key on them. `cust_id` IS redacted — the same class of identifier,
 * but it appears only under `billing_info`, where nothing depends on it. That
 * asymmetry is a decision, not an oversight; revisit it if a real-order capture
 * ever ships.
 */
export const REDACTED_PATH_SUFFIXES: readonly (readonly string[])[] = [
  // — the natural person
  ['buyer', 'first_name'],
  ['buyer', 'last_name'],
  ['buyer', 'nickname'],
  ['buyer', 'cust_id'],
  ['seller', 'cust_id'],
  ['billing_info', 'name'],
  ['billing_info', 'last_name'],
  ['cardholder', 'name'],
  ['identification', 'number'],
  ['email'],

  // — contact
  ['phone', 'number'],
  ['phone', 'area_code'],
  ['phone', 'extension'],
  ['receiver_name'],
  ['receiver_phone'],

  // — street-level location. `state` and `country` stay: they are coarse, and
  //   fiscal logic (ICMS, NF-e) keys on them.
  ['address', 'street_name'],
  ['address', 'street_number'],
  ['address', 'zip_code'],
  ['address', 'neighborhood'],
  ['address', 'city_name'],
  ['shipping_address', 'address_line'],
  ['shipping_address', 'street_name'],
  ['shipping_address', 'street_number'],
  ['shipping_address', 'zip_code'],
  ['shipping_address', 'comment'],
  ['shipping_address', 'latitude'],
  ['shipping_address', 'longitude'],
  ['seller_address', 'address_line'],
  ['seller_address', 'street_name'],
  ['seller_address', 'street_number'],
  ['seller_address', 'zip_code'],
  ['seller_address', 'comment'],
  ['seller_address', 'latitude'],
  ['seller_address', 'longitude'],
  ['neighborhood', 'name'],
  ['city', 'name'],
  ['geolocation', 'latitude'],
  ['geolocation', 'longitude'],
];

/**
 * The replacement for a leaf, derived from its key and its TYPE and nothing
 * else — which is what makes the whole module idempotent.
 *
 * The shaped strings (a CEP that is eight digits, a CPF that is eleven) exist so
 * a fixture still exercises any length or format check downstream; a blanket
 * `'REDACTED'` in a `zip_code` would turn a parsing test into a test of the
 * redactor.
 */
export function placeholderFor(
  key: string,
  value: string | number | boolean,
): string | number | boolean {
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return false;
  switch (key) {
    case 'zip_code':
      return '00000000';
    case 'number':
      return '00000000000';
    case 'area_code':
      return '00';
    case 'extension':
      return '';
    case 'email':
      return 'redacted@example.invalid';
    case 'street_number':
      return '0';
    case 'street_name':
      return 'Rua Redacted';
    case 'address_line':
      return 'Rua Redacted, 0';
    default:
      return 'REDACTED';
  }
}

/** True when `path` ends with any entry of {@link REDACTED_PATH_SUFFIXES}. */
export function isRedactedPath(path: readonly string[]): boolean {
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
  const key = path[path.length - 1] ?? '';
  return isRedactedPath(path) ? placeholderFor(key, value) : value;
}

/**
 * Deep-copy `value` with every {@link REDACTED_PATH_SUFFIXES} leaf replaced.
 *
 * ⚠️ `null` is returned untouched rather than replaced. A key ML sent as `null`
 * carries no personal data, and materialising it into a placeholder would
 * destroy the omitted-vs-null distinction that is the reason wire fixtures are
 * captured raw in the first place.
 */
export function redactWireBody(value: WireValue): WireValue {
  return walk(value, []);
}
