/**
 * Pull the filename out of a `Content-Disposition` header, if present.
 *
 * Shared by every browser client that downloads a server-named file — Mercado
 * Livre's label and Shopee's (#1523, step 15). It was a private function of
 * `lib/mercado-livre/client.ts` until the second caller arrived; a second copy
 * is the drift root `CLAUDE.md` names ("extract it"), so it moved here verbatim.
 *
 * ⚠️ `null` means "use your fallback", never "no file". A backend deployed
 * before its proxy exposed the header (`Access-Control-Expose-Headers`, ML
 * #1680) answers the bytes with the header HIDDEN from the browser, so every
 * caller keeps a client-side name for exactly that case.
 */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch (err) {
    // A stray '%' in the server-sent name must not fail a byte-successful
    // fetch — keep the undecoded filename.
    if (err instanceof URIError) return m[1];
    throw err;
  }
}
