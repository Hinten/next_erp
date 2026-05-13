import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyHmac } from './hmac';

const SECRET = 'test-secret-do-not-use';
const PAYLOAD = JSON.stringify({ event: 'order.created', id: 'abc' });

function sign(payload: string, secret: string, algorithm: 'sha256' | 'sha1' = 'sha256') {
  return createHmac(algorithm, secret).update(payload).digest('hex');
}

describe('verifyHmac', () => {
  it('accepts a correctly-signed payload', () => {
    const signature = sign(PAYLOAD, SECRET);
    expect(verifyHmac({ payload: PAYLOAD, signature, secret: SECRET })).toBe(true);
  });

  it('rejects when signature does not match payload', () => {
    const signature = sign(PAYLOAD, SECRET);
    expect(
      verifyHmac({ payload: PAYLOAD + 'tampered', signature, secret: SECRET }),
    ).toBe(false);
  });

  it('rejects when signature was generated with a different secret', () => {
    const signature = sign(PAYLOAD, 'wrong-secret');
    expect(verifyHmac({ payload: PAYLOAD, signature, secret: SECRET })).toBe(false);
  });

  it('rejects when signature length differs (different algo)', () => {
    const signature = sign(PAYLOAD, SECRET, 'sha1');
    expect(verifyHmac({ payload: PAYLOAD, signature, secret: SECRET })).toBe(false);
  });

  it('supports sha1 when both sides agree', () => {
    const signature = sign(PAYLOAD, SECRET, 'sha1');
    expect(
      verifyHmac({ payload: PAYLOAD, signature, secret: SECRET, algorithm: 'sha1' }),
    ).toBe(true);
  });
});
