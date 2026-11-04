/**
 * Shared server-only STATIC-secret verification: a caller presents a value
 * (a header) that must equal a configured secret byte for byte. The Amazon
 * relay's `API_KEY` Connection is the first caller (step-3 plan §3 decision
 * 14): it signs nothing, it sends the secret itself.
 *
 * Both values are hashed with SHA-256 and the two 32-byte digests are compared
 * with `timingSafeEqual`. Comparing digests instead of the raw strings removes
 * the length leak an early `a.length !== b.length` return has, and spares the
 * caller from padding: the comparison always runs over 32 bytes, whatever was
 * sent.
 *
 * Policy stays with the caller (#1431): which header, how many secrets are
 * accepted (a rotation), and what an unconfigured secret answers. This module
 * only refuses to compare against a BLANK expected secret, because a caller
 * that reached here without one has skipped its own configuration check, and
 * `'' === ''` would otherwise admit an empty header.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export interface StaticSecretVerifyInput {
  /** What the caller presented (a header value). `null`, `undefined` and `''` never match. */
  received: string | null | undefined;
  /** The configured secret. Blank (empty or whitespace only) throws. */
  expected: string;
}

function digest(valor: string): Buffer {
  return createHash('sha256').update(valor, 'utf8').digest();
}

/**
 * Does `received` equal `expected`, byte for byte, in UTF-8? Never trims and
 * never folds: a trailing newline or a different case is a different secret.
 *
 * @throws {TypeError} when `expected` is blank — the caller must answer its
 *   "not configured" status (a 503) before it ever compares.
 */
export function verifyStaticSecret({ received, expected }: StaticSecretVerifyInput): boolean {
  if (typeof expected !== 'string' || expected.trim() === '') {
    throw new TypeError('verifyStaticSecret: expected secret is blank');
  }
  if (typeof received !== 'string' || received === '') return false;
  return timingSafeEqual(digest(received), digest(expected));
}
