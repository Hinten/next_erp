/**
 * Mask + shape checks for the Mercado Livre item id typed in the import modal.
 *
 * Operators copy the id the way ML renders it — `MLB-5146021467`, or a whole
 * permalink — and the raw string used to reach `api.getItem()` untouched. It is
 * also part of the `sha256(sellerUserId|itemId)` doc id, so a case/format variant
 * creates a DUPLICATE produto instead of re-syncing.
 *
 * ⚠️ The digit run is read from the RAW string, before separators are stripped,
 * and it STOPS at the first non-digit. Stripping first and then collecting digits
 * is wrong in the common case: a real permalink carries a slug and often a
 * `#position=…&tracking_id=…` fragment, so `MLB-5146021467-camiseta-42-_JM`
 * collapses to `MLB514602146742` — an id that still LOOKS valid, passes the submit
 * gate, 404s at ML, and hashes to a different doc id.
 *
 * ⚠️ MLB only, on purpose. This backend serves ONE site (`api.ts` hardcodes
 * `/sites/MLB/...`, publish pins `site_id: 'MLB'` + `currency_id: 'BRL'`, and the
 * link schema defaults `site_id` to `'MLB'` while import never writes it). An
 * `MLU`/`MLA`/`MLM` id would half-import and leave a link doc stamped `MLB` with a
 * wrong-site permalink — so a non-MLB prefix must FAIL here, visibly.
 */

/**
 * `MLB`, any separators, then the digit run — anchored at the FIRST occurrence,
 * so a slug or a `tracking_id` containing `MLB` later in the URL cannot win.
 */
const MLB_ID = /MLB[^A-Z0-9]*(\d+)/;

/** Normalises whatever was typed or pasted into a bare item id (`MLB5146021467`). */
export function maskMlbItemId(raw: string): string {
  const upper = raw.toUpperCase();
  const match = MLB_ID.exec(upper);
  if (match) return `MLB${match[1]}`;

  const cleaned = upper.replace(/[^A-Z0-9]/g, '');
  // Mid-typing: keep the partial prefix instead of eating the letters.
  if (cleaned === 'M' || cleaned === 'ML' || cleaned === 'MLB') return cleaned;
  // Anything else keeps only its digits — which is how a foreign-site id
  // (`MLU5146021467`) loses its prefix and fails `isValidMlbItemId` below. Bare
  // digits are NOT given an `MLB` prefix either: a pure-digit id is a FAMILY id
  // (`isFamilyId`), so inventing one would change what the operator asked for.
  return cleaned.replace(/\D/g, '');
}

export function isValidMlbItemId(value: string): boolean {
  return /^MLB\d{6,}$/.test(value);
}

/**
 * True while a masked value can still BECOME valid — the prefix being typed, or
 * `MLB` plus too few digits. The field stays quiet in that state; the disabled
 * submit button already says "not ready yet", and only a value that can never be
 * an MLB id (a foreign-site paste reduced to bare digits) earns an error.
 */
export function isPartialMlbItemId(value: string): boolean {
  return /^(M|ML|MLB\d*)$/.test(value);
}
