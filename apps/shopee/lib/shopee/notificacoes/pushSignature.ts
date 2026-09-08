/**
 * Shopee's PUSH signature — the `Authorization` header on every inbound push.
 *
 * `guide 18`, "Push Authorization", verbatim:
 *
 * > 1. "Use **URL, |, response.content** as the signature base string."
 * > 2. "Retrieve your **partner key** from your App details"
 * > 3. "Use the signature base string and partner key to generate the signature
 * >    with the **HMAC-SHA256** hashing algorithm. The output … is a binary
 * >    string. This requires **hex encoding**."
 *
 * So `sign = lowercase_hex(HMAC_SHA256(partner_key, callback_url + '|' + raw_body))`,
 * compared against the RAW header value.
 *
 * ## Four things that are easy to get wrong
 *
 * - ⚠️ **The header value IS the bare hex digest.** No `Bearer`, no `sha256=`
 *   scheme token — Shopee's own reference implementation compares
 *   `authorization == cal_auth` with nothing stripped. So this module does NOT
 *   strip a prefix: a header carrying one is a header we did not compute, and
 *   accepting it would mean accepting a value under a rule Shopee never applies.
 * - ⚠️ **The base string separator is `|`, and the REQUEST signature has none.**
 *   `signBaseString` in `@delfrance/integrations-shopee` concatenates the
 *   request parts with no separator at all; the package deliberately holds no
 *   push helper for exactly this reason. Only the HMAC primitive is shared.
 * - ⚠️ **The body must be the exact bytes as received.** `guide 18` says
 *   "json.loads(response.content) … is not recommended", which is the doc
 *   telling you a re-serialized JSON changes key order and whitespace and fails
 *   the compare. The route reads `req.text()` ONCE and passes that string here.
 * - ⚠️ **WHICH url string Shopee signs is genuinely undocumented** — configured
 *   vs received, scheme, port, trailing slash. We sign the CONFIGURED
 *   `SHOPEE_PUSH_CALLBACK_URL` byte-for-byte (`env.ts` must not normalize it,
 *   and a trailing slash changes the digest — a test pins that), and the route
 *   logs configured-vs-received on the first deliveries so the real answer is
 *   visible rather than guessed.
 *
 * ⚠️ **This module contains no `console.*` and must not grow one.** The base
 * string embeds the whole push body and the digest is computed from the partner
 * key; neither belongs in a log line.
 */
import { timingSafeEqual } from 'node:crypto';
import { signBaseString } from '@delfrance/integrations-shopee';

/**
 * The verifier is unconfigured. The receiver maps this to **503** — the
 * fail-closed policy: an unconfigured verifier must never silently accept an
 * unsigned push.
 *
 * ⚠️ It names the VARIABLE and never its value. `SHOPEE_PARTNER_KEY` is the
 * HMAC secret, and `SHOPEE_PUSH_CALLBACK_URL` is inside the base string.
 */
export class ShopeePushConfigError extends Error {
  readonly variavel: 'SHOPEE_PARTNER_KEY' | 'SHOPEE_PUSH_CALLBACK_URL';

  constructor(variavel: 'SHOPEE_PARTNER_KEY' | 'SHOPEE_PUSH_CALLBACK_URL') {
    super(`${variavel} não configurado — verificação de assinatura do push obrigatória.`);
    this.name = 'ShopeePushConfigError';
    this.variavel = variavel;
  }
}

export interface PushSignatureConfig {
  /** `SHOPEE_PARTNER_KEY`, or null when unset/blank. */
  readonly partnerKey: string | null;
  /** `SHOPEE_PUSH_CALLBACK_URL`, byte-for-byte as configured, or null. */
  readonly callbackUrl: string | null;
}

/** `callback_url + '|' + raw_body` — the whole base string, and nothing else. */
export function pushBaseString(callbackUrl: string, rawBody: string): string {
  return `${callbackUrl}|${rawBody}`;
}

/**
 * The digest we expect on a push carrying `rawBody`.
 *
 * Exported so the receiver can log its first 8 characters beside the received
 * one while the configured-vs-received URL question is still open. Never log
 * more than a prefix: the full value is a valid credential for that one body.
 */
export function expectedPushSignature(rawBody: string, config: PushSignatureConfig): string {
  const partnerKey = config.partnerKey;
  if (partnerKey == null) throw new ShopeePushConfigError('SHOPEE_PARTNER_KEY');
  const callbackUrl = config.callbackUrl;
  if (callbackUrl == null) throw new ShopeePushConfigError('SHOPEE_PUSH_CALLBACK_URL');
  return signBaseString(pushBaseString(callbackUrl, rawBody), partnerKey);
}

/**
 * Verify Shopee's `Authorization` header over the RAW push body.
 *
 * @param rawBody the exact body string read via `req.text()`.
 * @param header  the `authorization` header value (the bare lowercase hex
 *                digest), or null.
 * @returns true when the digests match; false when the header is absent, the
 *          wrong length, or simply disagrees.
 * @throws  {@link ShopeePushConfigError} when the partner key or the callback
 *          URL is unset — the route answers 503, never a silent accept.
 */
export function verifyShopeePushSignature(
  rawBody: string,
  header: string | null,
  config: PushSignatureConfig,
): boolean {
  // The config errors come FIRST, before the header check: an unconfigured
  // backend must answer 503 whether or not the push carried a header, or the
  // misconfiguration would read as "Shopee sent a bad signature".
  const esperado = expectedPushSignature(rawBody, config);

  if (header == null) return false;
  // Shopee documents the digest as hex and compares it case-insensitively on
  // its own side; lowercasing ours is the whole normalization. NOTHING is
  // stripped — see the module header.
  const recebido = header.trim().toLowerCase();

  // ⚠️ Compare the hex TEXT, not decoded bytes. `Buffer.from('zz', 'hex')`
  // silently yields an EMPTY buffer rather than throwing, so a garbage header
  // decoded as hex would meet an empty expected buffer under any length rule
  // written after the decode. Comparing the text also makes the length check
  // exact: a real digest is 64 characters.
  const a = Buffer.from(esperado, 'utf8');
  const b = Buffer.from(recebido, 'utf8');
  // `timingSafeEqual` THROWS on differing lengths, so this guard is not an
  // optimization — it is what keeps a 63- or 65-character header a `false`
  // instead of a 500.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
