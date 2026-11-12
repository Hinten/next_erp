/**
 * The pre-signed URL guard both document modules share: the Easy Ship label
 * download (`documentosEasyShip.ts`) and the feed document upload and report
 * download (`documentosFeed.ts`). A pre-signed URL is its own credential, so
 * where it may point is decided ONCE, here, and each module raises its own
 * error class when this answers `null`.
 *
 * The URL must parse, be `https:`, carry no userinfo and no port, and name a
 * host ending in `.amazonaws.com` (Amazon's object storage; compared in lower
 * case, so an upper-case host is read as the same host). Anything else is
 * refused before anything is sent: a foreign host, the suffix as a subdomain of
 * another host, a look-alike suffix, a trailing dot, a relative path, a
 * CloudFront or `www.amazon.com` link.
 *
 * ⚠️ INTERNAL. The barrel (`index.ts`) does not re-export this module.
 */

/** The host suffix of Amazon's object storage, where the pre-signed documents live. */
const SUFIXO_HOST_DOCUMENTO = '.amazonaws.com';

/**
 * The URL to request (its parsed `href`), or `null` when it is not an `https:`
 * URL on an object-storage host with no port and no userinfo (module header).
 * Only the parser's own `TypeError` reads as "not a URL"; anything else it
 * throws is rethrown as itself.
 */
export function urlPreAssinadaAmazon(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  let alvo: URL;
  try {
    alvo = new URL(url);
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
  const valida =
    alvo.protocol === 'https:' &&
    alvo.username === '' &&
    alvo.password === '' &&
    alvo.port === '' &&
    alvo.hostname.toLowerCase().endsWith(SUFIXO_HOST_DOCUMENTO);
  return valida ? alvo.href : null;
}
