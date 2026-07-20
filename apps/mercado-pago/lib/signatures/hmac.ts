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
 * Parse Mercado Pago's `x-signature` header — a comma-separated key/value list
 * `ts=<unix-ts>,v1=<hex-hmac>` (order not guaranteed, stray spaces tolerated).
 * Returns the `ts` and `v1` parts (either may be `null` when absent).
 */
function parseXSignature(header: string): { ts: string | null; v1: string | null } {
  let ts: string | null = null;
  let v1: string | null = null;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'ts') ts = value || null;
    else if (key === 'v1') v1 = value || null;
  }
  return { ts, v1 };
}

/**
 * Verify a Mercado Pago webhook `x-signature` (secret + manifest HMAC).
 *
 * MP does NOT sign the request BODY; instead it signs a manifest built from the
 * `data.id` query param, the `x-request-id` header and the signature `ts`:
 *   `id:<data.id lowercased>;request-id:<x-request-id>;ts:<ts>;`
 * hashed HMAC-SHA256 with the app's webhook secret, hex-encoded, compared
 * against the header's `v1` part.
 *
 * Policy (mirrors the ML route's "obscure URL + refetch" stance, hardened one
 * notch): validate ONLY when `MERCADO_PAGO_WEBHOOK_SECRET` is configured. When
 * it is set and the signature is missing/invalid → reject (`false`). When it is
 * unset → skip the check (`true`): the receiver still re-fetches the payment
 * from the MP API before mutating anything (#531), which is the real security
 * anchor. `rawBody` is accepted for call-site symmetry but unused — MP's
 * manifest never includes the body.
 */
export function verifyMpSignature(req: Request, _rawBody?: string): boolean {
  const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  if (!secret) return true; // not configured → skip; the refetch is the anchor

  const header = req.headers.get('x-signature');
  if (!header) return false;
  const { ts, v1 } = parseXSignature(header);
  if (!ts || !v1) return false;

  const requestId = req.headers.get('x-request-id') ?? '';
  const url = new URL(req.url);
  // MP puts the resource id in the `data.id` query param (falls back to `id`);
  // an alphanumeric value must be lowercased before hashing.
  const dataId = (
    url.searchParams.get('data.id') ??
    url.searchParams.get('id') ??
    ''
  ).toLowerCase();
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;

  return verifyHmac({
    payload: manifest,
    signature: v1,
    secret,
    algorithm: 'sha256',
    encoding: 'hex',
  });
}
