/**
 * Mercado Livre picture helpers (ML→ERP import). ML re-serves LOW-RES renditions
 * of a listing's photos in the item payload's `pictures[].secure_url`; the CDN
 * exposes larger renditions by a one-letter size code in the URL suffix
 * (`..._112021-O.jpg`), where `F` is the max variant (≤1920×1920). This rewrites
 * the suffix to `-F` so the import stores the high-quality original instead of the
 * thumbnail ML happened to send. Pure (no IO) so it's unit-testable.
 *
 * (The item `pictures[]` schema carries `id/url/secure_url/size/max_size` — not the
 * full `variations[]` — so we transform the URL rather than call `GET /pictures/{id}`;
 * the latter is a future refinement if the transform ever misses a format.)
 */

/** The subset of an ML picture this helper reads (`itemPictureSchema` shape). */
export interface MlPictureUrls {
  url?: string | null;
  secure_url?: string | null;
}

/**
 * The trailing size-code suffix of an mlstatic CDN URL: `-<code>.<ext>` right
 * before the end, where `<code>` is a SINGLE letter (`F`/`O`/`C`/`I`/…). Anchored
 * at `$` and limited to one letter so neither the id's internal hyphen
 * (`D_NQ_NP_123-MLA456_…`) nor a multi-char id tail is ever rewritten.
 */
const SIZE_SUFFIX = /-[A-Za-z](\.(?:jpe?g|png|webp|gif))$/i;

function firstUrl(...vals: Array<string | null | undefined>): string | null {
  for (const v of vals) if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

/**
 * The best download URL for an ML picture: `secure_url` (or `url`), with its
 * size-code suffix rewritten to the `-F` max variant. Returns the URL unchanged
 * when it carries no size-code suffix, and `null` when the picture has no URL.
 */
export function highResPictureUrl(picture: MlPictureUrls): string | null {
  const base = firstUrl(picture.secure_url, picture.url);
  if (!base) return null;
  return SIZE_SUFFIX.test(base) ? base.replace(SIZE_SUFFIX, '-F$1') : base;
}
