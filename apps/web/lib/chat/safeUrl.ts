/**
 * URL scheme guard for externally-sourced hrefs/srcs in the chat thread —
 * referral-card links (advertiser-supplied `image_url`/`source_url`) and the
 * legacy `anexo_url` (a bare URL persisted on inbound messages). These strings
 * come from outside our control, so a `javascript:`/`data:`/`file:` scheme could
 * smuggle an XSS payload into an `<a href>` or `<img src>`. Only absolute
 * `http:`/`https:` URLs are allowed through; everything else is neutralized.
 */

/** True only for an absolute `http:`/`https:` URL; false for any other scheme,
 * a relative/garbage string, or a non-string. */
export function isHttpUrl(u: string | null | undefined): boolean {
  if (typeof u !== 'string' || u.trim() === '') return false;
  try {
    const { protocol } = new URL(u);
    return protocol === 'http:' || protocol === 'https:';
  } catch (err) {
    // An unparseable input (relative / malformed) makes `new URL` throw a
    // TypeError → treat as not-http(s); rethrow anything else (repo rule 6).
    if (err instanceof TypeError) return false;
    throw err;
  }
}
