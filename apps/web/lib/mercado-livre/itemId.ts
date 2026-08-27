/**
 * Mask + shape check for the Mercado Livre item id typed in the import modal.
 *
 * Operators copy the id the way ML renders it in a permalink — `MLB-5146021467` —
 * and the raw string used to reach `api.getItem()` untouched. It is also part of
 * the `sha256(sellerUserId|itemId)` doc id, so a case/format variant creates a
 * DUPLICATE produto instead of re-syncing; normalising at the input removes that.
 *
 * ⚠️ MLB only, on purpose. This backend serves ONE site (`api.ts` hardcodes
 * `/sites/MLB/...`, publish pins `site_id: 'MLB'` + `currency_id: 'BRL'`, and the
 * link schema defaults `site_id` to `'MLB'` while import never writes it). An
 * `MLU`/`MLA`/`MLM` id would half-import and leave a link doc stamped `MLB` with a
 * wrong-site permalink — so a non-MLB prefix must FAIL here, visibly.
 */

/** Normalises whatever was typed or pasted into a bare item id (`MLB5146021467`). */
export function maskMlbItemId(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  // A pasted permalink collapses to `HTTPSPRODUTOMERCADOLIVRECOMBRMLB5146021467`,
  // where the LAST `MLB` is the id's own prefix.
  const idx = cleaned.lastIndexOf('MLB');
  if (idx >= 0) return `MLB${cleaned.slice(idx + 3).replace(/\D/g, '')}`;
  // Mid-typing: keep the partial prefix instead of eating the letters.
  if (cleaned === 'M' || cleaned === 'ML') return cleaned;
  // Bare digits stay bare — a pure-digit id is a FAMILY id (`isFamilyId`), so
  // inventing an `MLB` prefix would change what the operator asked to import.
  return cleaned.replace(/\D/g, '');
}

export function isValidMlbItemId(value: string): boolean {
  return /^MLB\d{6,}$/.test(value);
}
