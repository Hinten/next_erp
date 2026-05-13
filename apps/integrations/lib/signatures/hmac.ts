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
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
