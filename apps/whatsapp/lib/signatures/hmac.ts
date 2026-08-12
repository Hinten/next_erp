/**
 * Meta webhook signature verification for the WhatsApp Cloud API inbound
 * receiver (#527). Mirrors `apps/mercado-pago/lib/signatures/hmac.ts`, but the
 * signing contract is Meta's, not MP's:
 *
 *  - Meta signs the RAW request BODY (unlike MP, which signs a manifest of query
 *    params + headers). The `X-Hub-Signature-256` header is `sha256=<hex>` where
 *    `<hex>` is `HMAC-SHA256(rawBody, WHATSAPP_APP_SECRET)`.
 *    https://developers.facebook.com/docs/graph-api/webhooks/getting-started#event-notifications
 *  - The HMAC MUST be computed over the exact bytes read off the wire — never a
 *    re-serialized `JSON.stringify(JSON.parse(body))`, whose key order / spacing
 *    would differ and fail the compare. The route reads `req.text()` ONCE and
 *    passes that string here.
 *
 * Policy (HARDER than MP's skip-when-unset): the secret is MANDATORY. When
 * `WHATSAPP_APP_SECRET` is unset, {@link verifyMetaSignature} throws
 * {@link WhatsappAppSecretMissingError} and the route returns 503 — it NEVER
 * skips the check. WhatsApp has no per-request refetch anchor (the message
 * content lives only in the webhook body), so an unsigned body can't be trusted
 * the way an MP event pointer can.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface HmacVerifyInput {
  payload: string;
  signature: string;
  secret: string;
  algorithm?: 'sha256' | 'sha1' | 'sha512';
  encoding?: 'hex' | 'base64';
}

export function verifyHmac({
  payload,
  signature,
  secret,
  algorithm = 'sha256',
  encoding = 'hex',
}: HmacVerifyInput): boolean {
  const expected = createHmac(algorithm, secret).update(payload).digest(encoding);
  // Decode both with `encoding` so the constant-time comparison runs over the
  // raw digest bytes (not their textual form) and the option is actually
  // honored — a hex `expected` vs a base64 `signature` would never match.
  const a = Buffer.from(expected, encoding);
  const b = Buffer.from(signature, encoding);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Thrown when `WHATSAPP_APP_SECRET` is unset. The route maps this to HTTP 503 —
 * the mandatory-secret policy: an unconfigured verifier must fail closed, never
 * silently accept unsigned webhooks.
 */
export class WhatsappAppSecretMissingError extends Error {
  constructor() {
    super('WHATSAPP_APP_SECRET não configurado — verificação de assinatura obrigatória.');
    this.name = 'WhatsappAppSecretMissingError';
  }
}

/**
 * Verify Meta's `X-Hub-Signature-256` over the RAW request body.
 *
 * @param rawBody the exact body string read via `req.text()` (byte-for-byte —
 *                never a re-serialized JSON).
 * @param header  the `x-hub-signature-256` header value (`sha256=<hex>`), or null.
 * @returns true when the HMAC matches; false when the header is absent/malformed
 *          or the digest disagrees.
 * @throws  {@link WhatsappAppSecretMissingError} when the app secret is unset
 *          (the route returns 503 — the check is never skipped).
 */
export function verifyMetaSignature(rawBody: string, header: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) throw new WhatsappAppSecretMissingError();

  if (!header) return false;
  // Strip the `sha256=` scheme prefix; tolerate a bare hex value too.
  const signature = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
  if (!signature) return false;

  return verifyHmac({ payload: rawBody, signature, secret, algorithm: 'sha256', encoding: 'hex' });
}
