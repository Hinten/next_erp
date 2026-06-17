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
